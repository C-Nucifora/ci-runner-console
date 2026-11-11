// Loaded before React. Every application request is synthetic, including mutations.
const runner = (name, state, extra = {}) => ({
  name, state, detail: 'Synthetic runner instance on one VM', protectedRunner: false,
  github: { id: 1, name, os: 'linux', status: 'online', busy: state === 'busy', labels: ['self-hosted'] },
  local: { unit: `actions.runner.synthetic.${name}.service`, active: 'active', enabled: 'enabled' },
  actions: { start: false, stop: state !== 'busy', restart: state !== 'busy', delete: state !== 'busy' },
  ...extra,
});
const inventory = {
  runners: [runner('idle-instance', 'online'), runner('busy-instance', 'busy'), runner('protected-instance', 'online', { protectedRunner: true })],
  headroom: { cpus: 4, load: { one: 0.5 }, memory: { totalBytes: 8e9, availableBytes: 6e9 }, disk: { totalBytes: 80e9, freeBytes: 60e9 }, instances: 2, cap: 5 },
  cap: { limit: 5, used: 2, remaining: 3, canCreate: true }, target: 'synthetic/example', warnings: [], fetchedAt: new Date().toISOString(),
};
window.fixture = { inventory, inventoryFailure: false, createFailure: true, malformed: false, pending: false, requests: [], release: null };
const nativeInterval = window.setInterval;
window.setInterval = (fn, ms, ...args) => {
  if (ms === 15000) window.fixture.poll = fn;
  return nativeInterval(fn, ms, ...args);
};
window.fetch = async (path, init = {}) => {
  const f = window.fixture;
  f.requests.push({ path, method: init.method || 'GET', body: init.body });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === '/api/me') return json({ user: { name: 'Synthetic User', username: 'fixture', groups: ['test'] }, defaultLabels: [] });
  if (path === '/api/inventory') return f.inventoryFailure ? json({ error: 'Synthetic inventory unavailable' }, 503) : json(f.inventory);
  if (path === '/api/runners' && init.method === 'POST') {
    if (f.pending) await new Promise(resolve => { f.release = resolve; });
    if (f.malformed) return new Response('<html>proxy error</html>', { status: 502 });
    return f.createFailure ? json({ error: 'Synthetic create rejected', hint: 'Refresh inventory and choose a unique name.' }, 409) : json({ confirmedInGitHub: true, githubStatus: 'online' });
  }
  if (path === '/auth/logout') {
    if (f.pending) await new Promise(resolve => { f.release = resolve; });
    if (f.logoutSuccess) return json({ endSessionUrl: '/__signed-out' });
    return json({ error: 'Synthetic logout unavailable' }, 503);
  }
  if (path.endsWith('/logs')) return json({ lines: ['Synthetic log line'] });
  if (/\/api\/runners\/.*\/(start|stop|restart)$/.test(path)) {
    if (f.pending) await new Promise(resolve => { f.release = resolve; });
    return json({});
  }
  if (path === '/api/settings') return json({ groups: [{ title: 'Synthetic configuration', rows: [{ label: 'VM', value: 'one synthetic VM only' }] }] });
  if (path.startsWith('/api/audit')) return json({ entries: [] });
  if (path === '/api/health') return json({ checks: [] }, f.healthFailure ? 503 : 200);
  throw new Error(`Blocked unexpected application request: ${path}`);
};
