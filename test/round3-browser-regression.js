/*
 * Independent operator-state probes. Run under the shared heavy lock.
 * The parent may inject this file's text through T3
 * preview evaluate, then call window.runRound3BrowserProbe(probe). No import or
 * browser-server changes are required. Use the shared flock and designated TMPDIR.
 *
 * Run ONE named probe per freshly reloaded, settled browser-fixture page at
 * http://127.0.0.1:<owned-port>/ or its T3 localhost tunnel. Do not run alongside the existing 40 assertions.
 * Keep that suite unchanged and execute it separately. Reload after success or
 * failure: restoring fixture data does not reset React state or toast timers.
 *
 * Names: inventory-order, inventory-error-order, inventory-denial-order,
 * logs-selection, logs-dismissal, logs-denial-retry, create-network-retry,
 * mutation-denial.
 *
 * Source hypotheses: App.refresh commits every completion without ordering;
 * RunnersView.showLogs commits every result without selection/dismissal tracking.
 * The other probes challenge recovery and are not alleged defects. A 403 means
 * request refusal, NOT session revocation. Actual session expiry/revocation is a
 * 401 and api.ts navigates via location.href. That needs a separately contained
 * navigation probe; this fetch-only draft intentionally cannot exercise it.
 * Native keyboard Tab/Escape and assistive-technology behavior remain unverified.
 */
window.runRound3BrowserProbe = async function runRound3BrowserProbe(probe) {
  const names = ['inventory-order', 'inventory-error-order', 'inventory-denial-order',
    'logs-selection', 'logs-dismissal', 'logs-denial-retry', 'create-network-retry', 'mutation-denial'];
  const f = window.fixture;
  const fixtureFetch = window.fetch;
  if (!names.includes(probe)) throw new Error(`Choose one probe: ${names.join(', ')}`);
  if (location.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(location.hostname) || location.pathname !== '/' ||
      !f || typeof f.poll !== 'function' || !Array.isArray(f.requests) ||
      !Function.prototype.toString.call(fixtureFetch).includes('Blocked unexpected application request:')) {
    throw new Error('Requires the original loopback synthetic browser fixture at /');
  }
  if (f.pending || f.release || f.inventoryFailure || f.malformed || f.createFailure !== true ||
      f.requests.some(r => r.method !== 'GET') || document.querySelector('dialog[open]')) {
    throw new Error('Reload the fixture before each probe');
  }

  const savedInventory = f.inventory;
  const requestStart = f.requests.length;
  const passed = [];
  const failed = [];
  const gates = [];
  const unexpected = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (fn, description) => {
    for (let i = 0; i < 100; i++) {
      if (fn()) return;
      await sleep(20);
    }
    throw new Error(`Timed out: ${description}`);
  };
  const check = (condition, message) => (condition ? passed : failed).push(message);
  const button = (text, root = document) => [...root.querySelectorAll('button')]
    .find(b => b.textContent.trim() === text);
  const card = name => [...document.querySelectorAll('article.runner')]
    .find(c => c.querySelector('.name')?.textContent.trim() === name);
  const dialog = () => document.querySelector('dialog[open]');
  const fill = (id, value) => {
    const input = document.getElementById(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const defer = (path, method = 'GET') => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    const gate = { path, method, promise, used: false, release };
    gates.push(gate);
    return gate;
  };
  const release = async (gate, response) => {
    if (!gate.used) throw new Error(`Cannot release an unrequested gate: ${gate.path}`);
    gate.release(response);
    // Bounded React settling interval; this is not a network timeout experiment.
    await sleep(100);
  };
  const click = (text, root = document) => {
    const control = button(text, root);
    if (!control || control.disabled) throw new Error(`Expected enabled button: ${text}`);
    control.click();
  };
  const logsPath = name => `/api/runners/${name}/logs`;
  const allowed = (path, method) => method === 'GET'
    ? ['/api/me', '/api/inventory', '/api/settings', '/api/health', '/api/audit?limit=300',
        logsPath('idle-instance'), logsPath('busy-instance')].includes(path)
    : method === 'POST' && ['/api/runners', '/api/runners/idle-instance/restart'].includes(path);

  await wait(() => button('Add runner') && card('idle-instance'), 'initial inventory');
  await sleep(100); // Let StrictMode's initial reads finish before arming any gate.
  window.fetch = async (path, init = {}) => {
    const method = init.method || 'GET';
    if (typeof path !== 'string' || !allowed(path, method)) {
      unexpected.push({ path: String(path), method });
      throw new Error(`Blocked unexpected application request: ${method} ${String(path)}`);
    }
    const gate = gates.find(g => !g.used && g.path === path && g.method === method);
    if (!gate) return fixtureFetch(path, init); // Only the verified synthetic implementation.
    gate.used = true;
    f.requests.push({ path, method, body: init.body });
    const response = await gate.promise;
    if (response instanceof Error) throw response;
    return response;
  };

  try {
    if (probe.startsWith('inventory-')) {
      const oldSnapshot = structuredClone(savedInventory);
      const current = structuredClone(savedInventory);
      current.fetchedAt = new Date(Date.parse(oldSnapshot.fetchedAt) + 1000).toISOString();
      const idle = current.runners.find(r => r.name === 'idle-instance');
      idle.detail = 'ROUND3 newer inventory';
      idle.state = 'busy'; idle.github.busy = true;
      idle.actions = { start: false, stop: false, restart: false, delete: false };
      current.cap.canCreate = false;
      current.cap.remaining = 0;
      current.cap.used = current.cap.limit;
      f.inventory = current;
      const older = defer('/api/inventory');
      const newer = defer('/api/inventory');
      f.poll(); f.poll();
      await wait(() => older.used && newer.used, 'two overlapping inventory requests');
      const denial = probe === 'inventory-denial-order';
      await release(newer, denial
        ? json({ error: 'Synthetic inventory access refused' }, 403) : json(current));
      await wait(() => denial ? document.body.textContent.includes('Synthetic inventory access refused')
        : card('idle-instance')?.querySelector('.detail')?.textContent === idle.detail, 'newer response rendered');
      await release(older, probe === 'inventory-error-order'
        ? json({ error: 'Synthetic older inventory failure' }, 503) : json(oldSnapshot));
      if (f.requests.slice(requestStart).filter(r => r.path === '/api/inventory').length !== 2) {
        throw new Error('Inventory probe contaminated by an automatic poll; reload and retry');
      }
      if (denial) {
        check(document.body.textContent.includes('Synthetic inventory access refused'),
          'older success cannot erase a newer inventory refusal');
        check(button('Add runner').disabled && [...document.querySelectorAll('article.runner button')].every(b => b.disabled),
          'older success cannot unlock controls after a newer inventory refusal');
      } else {
        check(card('idle-instance')?.querySelector('.detail')?.textContent === idle.detail,
          'latest successful inventory remains visible after an older response');
        check(!button('Restart', card('idle-instance')) && button('Add runner').disabled,
          'older response cannot restore busy-runner or full-capacity permissions');
        check(!document.body.textContent.includes('Cannot load runner state'),
          'older inventory failure cannot invalidate a newer successful refresh');
      }
    } else if (probe === 'logs-selection' || probe === 'logs-dismissal') {
      const older = defer(logsPath('idle-instance'));
      const newer = defer(logsPath('busy-instance'));
      click('Logs', card('idle-instance'));
      click('Logs', card('busy-instance'));
      await wait(() => older.used && newer.used, 'two selected log requests');
      await release(newer, json({ lines: ['ROUND3 BUSY LOG'] }));
      await wait(() => dialog()?.textContent.includes('ROUND3 BUSY LOG'), 'newer log selection');
      if (probe === 'logs-dismissal') {
        click('Close', dialog());
        await wait(() => !dialog(), 'newer log dialog dismissed');
      }
      await release(older, json({ lines: ['ROUND3 IDLE LOG'] }));
      if (probe === 'logs-dismissal') {
        check(!dialog(), 'late log response cannot reopen a dismissed newer selection');
      } else {
        check(document.getElementById('runner-log-title')?.textContent === 'busy-instance' &&
          dialog()?.querySelector('pre')?.textContent === 'ROUND3 BUSY LOG',
        'late log response cannot replace the selected runner name or lines');
        check(Boolean(dialog()?.contains(document.activeElement)), 'focus remains inside the active log dialog');
      }
    } else if (probe === 'logs-denial-retry') {
      const denied = defer(logsPath('idle-instance'));
      click('Logs', card('idle-instance'));
      await wait(() => denied.used, 'log request');
      await release(denied, json({ error: 'Synthetic log access refused' }, 403));
      await wait(() => document.body.textContent.includes('Synthetic log access refused'), 'log refusal');
      check(!dialog() && [...document.querySelectorAll('[role="alert"]')]
        .some(node => node.textContent.includes('Synthetic log access refused')), 'log refusal is accessible without opening a stale dialog');
      click('Logs', card('busy-instance'));
      await wait(() => dialog()?.textContent.includes('Synthetic log line'), 'different runner log retry');
      check(document.getElementById('runner-log-title')?.textContent === 'busy-instance' &&
        !document.body.textContent.includes('Synthetic log access refused'), 'successful selection clears the prior log refusal');
    } else if (probe === 'create-network-retry') {
      click('Add runner');
      await wait(dialog, 'create dialog');
      fill('rname', 'round3-network'); fill('rlabels', 'gpu');
      await wait(() => button('Add runner', dialog())?.disabled === false, 'valid create input');
      const lost = defer('/api/runners', 'POST');
      const reconciliation = defer('/api/inventory');
      click('Add runner', dialog());
      await wait(() => lost.used, 'create attempt');
      await release(lost, new TypeError('Synthetic network disconnected'));
      await wait(() => reconciliation.used, 'inventory reconciliation after network failure');
      check(button('Creating…', dialog())?.disabled && button('Sign out').disabled,
        'network failure keeps mutation controls locked until reconciliation finishes');
      await release(reconciliation, json(savedInventory));
      await wait(() => dialog()?.textContent.includes('Synthetic network disconnected'), 'network error inside modal');
      check(document.getElementById('rname').value === 'round3-network' &&
        document.getElementById('rlabels').value === 'gpu', 'network failure retains inputs for deliberate retry');
      check(dialog().querySelector('[role="alert"]')?.textContent.includes('Synthetic network disconnected'),
        'network failure is announced within the modal');
      const retry = defer('/api/runners', 'POST');
      click('Add runner', dialog());
      await wait(() => retry.used, 'deliberate retry');
      await release(retry, json({ confirmedInGitHub: true, githubStatus: 'online' }));
      await wait(() => !dialog(), 'successful retry closes modal');
      check(document.body.textContent.includes('round3-network is registered and online in GitHub.'),
        'retry reports confirmed success');
      check(f.requests.slice(requestStart).filter(r => r.method === 'POST').length === 2,
        'network failure causes no automatic duplicate mutation');
      // The response is lost before any synthetic server commit; ambiguous success
      // and duplicate-name reconciliation are separate backend coverage.
    } else if (probe === 'mutation-denial') {
      const denied = defer('/api/runners/idle-instance/restart', 'POST');
      click('Restart', card('idle-instance'));
      await wait(() => denied.used, 'restart attempt');
      f.inventory = structuredClone(savedInventory);
      f.inventory.runners.find(r => r.name === 'idle-instance').protectedRunner = true;
      await release(denied, json({ error: 'Synthetic runner became protected', hint: 'Refresh before acting.' }, 403));
      await wait(() => !button('Sign out').disabled, 'mutation refusal and refresh settled');
      const protectedCard = [...document.querySelectorAll('article.runner')]
        .find(c => c.querySelector('.name')?.textContent.startsWith('idle-instance'));
      check(document.body.textContent.includes('Synthetic runner became protected') &&
        !document.body.textContent.includes('idle-instance restarted.'), 'mutation refusal never reports success');
      check(Boolean(protectedCard) && !protectedCard.querySelector('button'),
        'post-refusal inventory removes controls for newly protected runner');
    }
    check(gates.every(g => g.used), 'every scripted response was requested');
    check(unexpected.length === 0, 'no unexpected application fetch was attempted');
    return { probe, passed, failed, requests: f.requests.slice(requestStart), unexpected,
      viewport: { width: innerWidth, height: innerHeight }, resetRequired: 'reload fixture before next probe' };
  } catch (error) {
    // Setup/timeouts are harness failures, not reproduced application findings.
    return { probe, passed, failed, harnessError: String(error), unexpected,
      requests: f.requests.slice(requestStart), resetRequired: 'reload fixture before next probe' };
  } finally {
    for (const gate of gates) gate.release(new TypeError('Synthetic probe cleanup'));
    window.fetch = fixtureFetch;
    f.inventory = savedInventory;
  }
};
