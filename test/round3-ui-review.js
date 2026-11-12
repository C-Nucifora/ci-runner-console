/* Independent fix challenge. Inject into a fresh, settled synthetic fixture page.
 * Run one window.runRound3UiReview(name) per reload under the parent's shared lock.
 * Names: mutation-newer-success, mutation-newer-failure, logs-stale-error,
 * logs-cancel, logs-unmount-success, logs-unmount-error, session-navigation.
 * No real API, identity provider or runner request is permitted. The navigation
 * probe uses an owned iframe and the fixture's refusal-only /auth middleware.
 * The cancel probe dispatches the dialog event; native Escape needs parent input.
 */
window.runRound3UiReview = async function runRound3UiReview(probe) {
  const names = ['mutation-newer-success', 'mutation-newer-failure', 'logs-stale-error',
    'logs-cancel', 'logs-unmount-success', 'logs-unmount-error', 'session-navigation'];
  const f = window.fixture;
  const originalFetch = window.fetch;
  if (!names.includes(probe) || location.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(location.hostname) || location.pathname !== '/' ||
      !f || typeof f.poll !== 'function' || !Array.isArray(f.requests) ||
      !Function.prototype.toString.call(originalFetch).includes('Blocked unexpected application request:')) {
    throw new Error('Requires a named probe on the original loopback synthetic fixture');
  }
  const passed = [], failed = [], unexpected = [], gates = [];
  const savedInventory = f.inventory;
  const requestStart = f.requests.length;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (fn, message) => {
    for (let n = 0; n < 100; n++) {
      if (fn()) return;
      await sleep(20);
    }
    throw new Error(`Timed out: ${message}`);
  };
  const check = (condition, message) => (condition ? passed : failed).push(message);
  const button = (name, root = document) => [...root.querySelectorAll('button')]
    .find(node => node.textContent.trim() === name);
  const card = name => [...document.querySelectorAll('article.runner')]
    .find(node => node.querySelector('.name')?.textContent.trim() === name);
  const dialog = () => document.querySelector('dialog[open]');
  const click = (name, root = document) => {
    const node = button(name, root);
    if (!node || node.disabled) throw new Error(`Expected enabled button: ${name}`);
    node.click();
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const gate = (path, method = 'GET') => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const result = { path, method, used: false, promise, resolve };
    gates.push(result);
    return result;
  };
  const release = async (g, body, status = 200) => {
    if (!g.used) throw new Error(`Unrequested gate: ${g.path}`);
    g.resolve(json(body, status));
    await sleep(100);
  };
  const logPath = name => `/api/runners/${name}/logs`;
  const allowed = (path, method) => method === 'GET'
    ? ['/api/me', '/api/inventory', '/api/settings', '/api/health', '/api/audit?limit=300',
      logPath('idle-instance'), logPath('busy-instance')].includes(path)
    : method === 'POST' && path === '/api/runners/idle-instance/restart';
  let frame;
  try {
    await wait(() => card('idle-instance') && button('Add runner'), 'settled initial inventory');
    await sleep(100);
    if (dialog() || f.pending || f.release || f.inventoryFailure || f.malformed ||
        f.requests.some(request => request.method !== 'GET')) throw new Error('Reload before each probe');
    if (probe === 'session-navigation') {
      frame = document.createElement('iframe');
      frame.title = 'Isolated synthetic session navigation';
      frame.src = '/settings';
      document.body.append(frame);
      await wait(() => frame.contentWindow.fixture?.poll &&
        frame.contentDocument.body.textContent.includes('Synthetic configuration'), 'iframe fixture settled');
      const child = frame.contentWindow;
      const childFetch = child.fetch;
      if (!Function.prototype.toString.call(childFetch).includes('Blocked unexpected application request:')) {
        throw new Error('Iframe did not load the synthetic fetch boundary');
      }
      child.fetch = async (path, init = {}) => {
        if (path === '/api/inventory' && (!init.method || init.method === 'GET')) {
          return new child.Response('{}', { status: 401 });
        }
        if (typeof path !== 'string' || !allowed(path, init.method || 'GET')) {
          unexpected.push(String(path));
          throw new Error('Blocked unexpected iframe request');
        }
        return childFetch(path, init);
      };
      child.fixture.poll();
      await wait(() => frame.contentWindow.location.pathname === '/auth/login' &&
        frame.contentDocument.body.textContent.includes('Fixture must intercept'), 'contained login navigation');
      check(frame.contentWindow.location.origin === location.origin,
        'session expiry navigates only within the owned loopback origin');
      check(new URL(frame.contentWindow.location.href).searchParams.get('returnTo') === '/settings',
        'session expiry preserves the current route in returnTo');
      check(location.pathname === '/' && Boolean(card('idle-instance')),
        'isolated expiry does not navigate the parent page');
    } else {
      window.fetch = async (path, init = {}) => {
        const method = init.method || 'GET';
        if (typeof path !== 'string' || !allowed(path, method)) {
          unexpected.push({ path: String(path), method });
          throw new Error('Blocked unexpected application request');
        }
        const g = gates.find(item => !item.used && item.path === path && item.method === method);
        if (!g) return originalFetch(path, init);
        g.used = true;
        f.requests.push({ path, method, body: init.body });
        return g.promise;
      };
      if (probe.startsWith('mutation-')) {
        const mutation = gate('/api/runners/idle-instance/restart', 'POST');
        const reconciliation = gate('/api/inventory');
        click('Restart', card('idle-instance'));
        await wait(() => mutation.used, 'mutation dispatched');
        await release(mutation, {});
        await wait(() => reconciliation.used, 'mutation reconciliation dispatched');
        const newer = gate('/api/inventory');
        const newest = gate('/api/inventory');
        f.poll(); f.poll();
        await wait(() => newer.used && newest.used, 'superseding polls dispatched');
        await release(reconciliation, savedInventory);
        check(button('Sign out').disabled && button('Add runner').disabled,
          'stale mutation reconciliation cannot clear busy while polls remain pending');
        await release(newer, savedInventory);
        check(button('Sign out').disabled && button('Restart', card('idle-instance')).disabled,
          'an intermediate poll cannot clear busy before the newest poll');
        if (probe.endsWith('failure')) {
          await release(newest, { error: 'REVIEW latest inventory unavailable' }, 503);
          await wait(() => !button('Sign out').disabled, 'mutation settles after newest failure');
          check(document.body.textContent.includes('REVIEW latest inventory unavailable') &&
            button('Add runner').disabled && [...document.querySelectorAll('article.runner button')].every(b => b.disabled),
          'newest refresh failure keeps all runner controls unavailable after busy clears');
          f.poll();
          await wait(() => !button('Add runner').disabled, 'subsequent refresh recovers');
          check(!document.body.textContent.includes('REVIEW latest inventory unavailable'),
            'a later successful refresh restores actionable state');
        } else {
          await release(newest, savedInventory);
          await wait(() => !button('Sign out').disabled, 'newest success clears busy');
          check(!button('Add runner').disabled && !button('Restart', card('idle-instance')).disabled,
            'latest successful reconciliation releases mutation controls');
        }
        check(f.requests.slice(requestStart).filter(request => request.method === 'POST').length === 1,
          'overlapping reconciliation never repeats the mutation');
      } else if (probe.startsWith('logs-unmount')) {
        const pending = gate(logPath('idle-instance'));
        click('Logs', card('idle-instance'));
        await wait(() => pending.used, 'log request dispatched');
        click('Settings');
        await wait(() => !card('idle-instance'), 'runner view unmounted');
        await release(pending, probe.endsWith('error')
          ? { error: 'REVIEW unmounted log failure' } : { lines: ['REVIEW unmounted logs'] },
        probe.endsWith('error') ? 503 : 200);
        click('Runners');
        await wait(() => card('idle-instance'), 'runner view remounted');
        check(!dialog() && !document.body.textContent.includes('REVIEW unmounted'),
          'unmounted log completion cannot alter the remounted runner view');
        click('Logs', card('busy-instance'));
        await wait(dialog, 'fresh selection opens');
        check(document.getElementById('runner-log-title').textContent === 'busy-instance',
          'new log selections still work after runner view remount');
      } else {
        const older = gate(logPath('idle-instance'));
        const newer = gate(logPath('busy-instance'));
        click('Logs', card('idle-instance'));
        click('Logs', card('busy-instance'));
        await wait(() => older.used && newer.used, 'overlapping log requests');
        await release(newer, { lines: ['REVIEW current logs'] });
        await wait(dialog, 'current log dialog');
        if (probe === 'logs-cancel') {
          dialog().dispatchEvent(new Event('cancel', { cancelable: true }));
          await wait(() => !dialog(), 'cancel event dismisses dialog');
        }
        await release(older, { error: 'REVIEW stale log error' }, 503);
        check(!document.body.textContent.includes('REVIEW stale log error'),
          'stale log failure cannot add an error for a superseded selection');
        check(probe === 'logs-cancel' ? !dialog() :
          dialog()?.querySelector('pre')?.textContent === 'REVIEW current logs',
        'stale failure preserves the current dialog or its dismissal');
      }
    }
    check(gates.every(item => item.used), 'every scripted response was requested');
    check(unexpected.length === 0, 'no unexpected application fetch was attempted');
    return { probe, passed, failed, unexpected, requests: f.requests.slice(requestStart),
      viewport: { width: innerWidth, height: innerHeight } };
  } catch (error) {
    return { probe, passed, failed, unexpected, harnessError: String(error),
      requests: f.requests.slice(requestStart) };
  } finally {
    frame?.remove();
    for (const g of gates) g.resolve(json({ error: 'Review fixture cleanup' }, 503));
    window.fetch = originalFetch;
    f.inventory = savedInventory;
  }
};
