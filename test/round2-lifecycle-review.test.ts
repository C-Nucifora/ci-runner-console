import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { AuditLog, type AuditEntry } from '../src/audit.js';
import { SessionStore } from '../src/auth/session.js';
import type { Config } from '../src/config.js';
import type { GitHubRunner, RunnerRegistry } from '../src/github/registry.js';
import { registerApiRoutes } from '../src/routes/api.js';
import { SESSION_COOKIE } from '../src/routes/auth.js';
import type { LocalInstance, RunnerVmControl } from '../src/vm/ctl.js';

async function fixture(t: TestContext) {
  const entries: AuditEntry[] = [];
  const audit = new AuditLog('/unused-round2-lifecycle-review');
  t.mock.method(audit, 'checkWritable', async () => {});
  t.mock.method(audit, 'record', async (entry: AuditEntry) => { entries.push(structuredClone(entry)); });
  const locals: LocalInstance[] = [];
  const runner: GitHubRunner = { id: 1, name: 'runner', os: 'linux', status: 'offline', busy: false, labels: [] };
  const state = { reads: 0, effects: [] as string[],
    confirm: async (): Promise<GitHubRunner[]> => [runner] };
  const registry: RunnerRegistry = {
    async listRunners() {
      if (!locals.length) return [];
      state.reads++;
      return state.confirm();
    },
    async createRegistrationToken() { return { token: 'synthetic', expiresAt: '' }; },
    async createRemoveToken() { throw new Error('unexpected removal'); },
    async deleteRunner() { throw new Error('unexpected deletion'); },
    registrationUrl: () => 'https://example.invalid/synthetic', describe: () => 'synthetic review',
  };
  const control = {
    async list() { return structuredClone(locals); },
    async headroom() { return { cap: 3, instances: locals.length, remaining: 3 - locals.length }; },
    async create() {
      state.effects.push('create');
      locals.push({ name: 'runner', dir: '/synthetic/runner', unit: 'actions.runner.synthetic.service',
        registered: true, serviceInstalled: true, active: 'active', enabled: 'enabled',
        subState: 'running', activeSince: null, legacy: false });
      return {};
    },
    async stop() { state.effects.push('stop'); return {}; },
  } as unknown as RunnerVmControl;
  const sessions = new SessionStore('synthetic-review-session-secret-32-characters', 3600);
  const identity = { sub: 'synthetic', username: 'tester', email: null, name: null, groups: [] };
  let session = sessions.create(identity);
  const config = { publicBaseUrl: 'http://127.0.0.1', github: { scope: 'repo' },
    runners: { cap: 3, defaultLabels: [], protectedNames: [] } } as unknown as Config;
  const app = Fastify();
  let creatingRequest: FastifyRequest;
  app.addHook('onRequest', async (req) => {
    if (req.url === '/api/runners') creatingRequest = req;
  });
  await app.register(cookie);
  registerApiRoutes(app, { config, sessions, registry, control, audit,
    credential: { getToken: async () => 'synthetic', describe: () => 'synthetic' } });
  t.after(async () => { await app.close(); });
  return { state, runner, locals, entries,
    cancel(reason: 'revoked' | 'disconnected') {
      if (reason === 'revoked') sessions.destroy(session);
      else Object.defineProperty(creatingRequest.raw, 'aborted', { configurable: true, value: true });
    },
    signIn() { session = sessions.create(identity); },
    request: (url: string, payload?: object) => app.inject({ method: 'POST', url, payload,
      headers: { cookie: `${SESSION_COOKIE}=${session}`, origin: config.publicBaseUrl } }),
  };
}

for (const finalStatus of ['offline', 'absent', 'online'] as const) {
  test(`confirmation spends only the remaining budget after a slow read and reports ${finalStatus}`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    let elapsed = 0;
    // An arbitrary nonzero origin catches accidental mixing of elapsed and absolute time.
    t.mock.method(performance, 'now', () => 123_456.25 + elapsed);
    const sleeps: number[] = [];
    const realTimeout = setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay !== undefined && delay > 0 && delay <= 3000) {
        sleeps.push(delay);
        assert.ok(sleeps.length <= 2, 'bounded polling probe');
        elapsed += delay;
        return realTimeout(callback, 1, ...args);
      }
      return realTimeout(callback, delay, ...args);
    });
    f.state.confirm = async () => {
      assert.ok(f.state.reads <= 2, 'bounded confirmation reads');
      if (f.state.reads === 1) { elapsed += 58_750; return [f.runner]; }
      if (finalStatus === 'absent') return [];
      f.runner.status = finalStatus;
      return [f.runner];
    };
    const response = await f.request('/api/runners', { name: 'runner' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().operationState, 'completed');
    assert.equal(response.json().confirmedInGitHub, finalStatus === 'online');
    assert.equal(response.json().githubStatus, finalStatus === 'absent' ? 'unknown' : finalStatus);
    assert.deepEqual(sleeps, [1250]);
    assert.equal(elapsed, 60_000);
    assert.equal(f.state.reads, 2);
    f.state.confirm = async () => [f.runner];
    assert.equal((await f.request('/api/runners/runner/stop')).statusCode, 200);
    assert.deepEqual(f.state.effects, ['create', 'stop']);
  });
}

for (const reason of ['revoked', 'disconnected'] as const) {
  for (const phase of ['read', 'sleep'] as const) {
    test(`${reason} during confirmation ${phase} preserves creation and releases the slot`, { timeout: 5000 }, async (t) => {
      const f = await fixture(t);
      f.state.confirm = async () => {
        assert.equal(f.state.reads, 1, 'cancelled confirmation must not poll again');
        if (phase === 'read') {
          await Promise.resolve();
          f.cancel(reason);
          f.runner.status = 'online';
        }
        return [f.runner];
      };
      const realTimeout = setTimeout;
      t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        if (phase === 'sleep' && delay === 3000) {
          return realTimeout(() => { f.cancel(reason); callback(...args); }, 1);
        }
        return realTimeout(callback, delay, ...args);
      });
      const response = await f.request('/api/runners', { name: 'runner' });
      assert.equal(response.statusCode, 502, response.body);
      assert.equal(response.json().operationState, 'completed');
      assert.match(response.json().error, /was created on the VM/);
      assert.equal(f.locals.length, 1);
      assert.equal(f.state.reads, 1);
      assert.equal(f.entries.filter((entry) => entry.action === 'runner.create' && entry.outcome === 'failure').length, 1);
      f.signIn();
      f.state.confirm = async () => [f.runner];
      assert.equal((await f.request('/api/runners/runner/stop')).statusCode, 200);
      assert.deepEqual(f.state.effects, ['create', 'stop']);
    });
  }
}
