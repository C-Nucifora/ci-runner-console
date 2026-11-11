import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerApiRoutes } from '../src/routes/api.js';
import { buildInventory } from '../src/reconcile.js';
import { SessionStore } from '../src/auth/session.js';
import { SESSION_COOKIE } from '../src/routes/auth.js';
import { AuditLog } from '../src/audit.js';
import type { Config } from '../src/config.js';
import type { GitHubRunner, RunnerRegistry } from '../src/github/registry.js';
import type { LocalInstance, RunnerVmControl } from '../src/vm/ctl.js';

function local(name = 'runner'): LocalInstance {
  return { name, dir: `/synthetic/${name}`, unit: `${name}.service`, registered: true,
    serviceInstalled: true, active: 'active', enabled: 'enabled', subState: 'running',
    activeSince: null, legacy: false };
}
function github(name = 'runner', id = 1): GitHubRunner {
  return { id, name, os: 'linux', status: 'online', busy: false, labels: [] };
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'runner-lifecycle-'));
  const state = { locals: [] as LocalInstance[], runners: [] as GitHubRunner[],
    cap: 3, offline: false, headroomOffline: false, localOffline: false,
    removeFails: false, createFails: false, deleteFails: false,
    offlineAfterRemove: false, offlineAfterDelete: false, calls: [] as string[] };
  const registry: RunnerRegistry = {
    async listRunners() {
      if (state.offline) throw new Error('synthetic GitHub outage');
      return state.runners.map((r) => ({ ...r }));
    },
    async createRegistrationToken() { state.calls.push('registration'); return { token: 'synthetic', expiresAt: '' }; },
    async createRemoveToken() { state.calls.push('removal'); return { token: 'synthetic', expiresAt: '' }; },
    async deleteRunner(id) {
      state.calls.push(`delete:${id}`);
      if (state.deleteFails) throw new Error('synthetic delete failure');
      state.runners = state.runners.filter((r) => r.id !== id);
      if (state.offlineAfterDelete) state.offline = true;
    },
    describe: () => 'synthetic registry', registrationUrl: () => 'https://example.invalid/synthetic',
  };
  const control = {
    async list() {
      if (state.localOffline) throw new Error('synthetic VM outage');
      return state.locals.map((l) => ({ ...l }));
    },
    async headroom() {
      if (state.headroomOffline) throw new Error('synthetic headroom outage');
      return { cap: state.cap, instances: state.locals.length, remaining: state.cap - state.locals.length,
        cpus: 4, load: { one: 0, five: 0, fifteen: 0 }, memory: { totalBytes: 1, availableBytes: 1 },
        disk: { totalBytes: 1, freeBytes: 1 } };
    },
    async create({ name }: { name: string }) {
      state.calls.push(`create:${name}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      state.locals.push(local(name));
      state.runners.push(github(name, state.runners.length + 1));
      if (state.createFails) throw new Error('synthetic partial create');
      return {};
    },
    async remove(name: string) {
      state.calls.push(`remove:${name}`);
      if (state.removeFails) throw new Error('synthetic remove failure');
      state.locals = state.locals.filter((l) => l.name !== name);
      if (state.offlineAfterRemove) state.offline = true;
      return { deregisteredLocally: false };
    },
    async start(name: string) { state.calls.push(`start:${name}`); return {}; },
    async stop(name: string) { state.calls.push(`stop:${name}`); return {}; },
    async restart(name: string) { state.calls.push(`restart:${name}`); return {}; },
  } as unknown as RunnerVmControl;
  const sessions = new SessionStore('synthetic-session-secret-with-32-characters', 3600);
  const session = sessions.create({ sub: 'synthetic', username: 'tester', email: null, name: null, groups: [] });
  const config = { publicBaseUrl: 'http://127.0.0.1', runners: { cap: 3, defaultLabels: [], protectedNames: ['protected'] },
    github: { scope: 'repo' } } as unknown as Config;
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  const app = Fastify();
  await app.register(cookie);
  registerApiRoutes(app, { config, registry, control, sessions, audit,
    credential: { getToken: async () => 'synthetic', describe: () => 'synthetic' } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const request = (method: 'POST' | 'DELETE', path: string, payload?: object) => app.inject({
    method, url: path, headers: { cookie: `${SESSION_COOKIE}=${session}`, origin: config.publicBaseUrl }, payload,
  });
  return { state, registry, control, config, audit, app, session, sessions, request,
    inventory: () => buildInventory(registry, control, config.runners) };
}

test('concurrent creates cannot exceed either cap or duplicate a name', async (t) => {
  for (const names of [['one', 'two'], ['same', 'same']]) {
    const f = await fixture(t);
    f.state.cap = names[0] === 'one' ? 1 : 3;
    const responses = await Promise.all(names.map((name) => f.request('POST', '/api/runners', { name })));
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(f.state.locals.length, 1);
    assert.equal(f.state.calls.filter((c) => c.startsWith('create:')).length, 1);
  }
});

test('busy registrations block all mutations even with stopped or missing local service', async (t) => {
  for (const locals of [[local()], [{ ...local(), active: 'inactive' }], []]) {
    const f = await fixture(t);
    f.state.locals = locals;
    f.state.runners = [{ ...github(), busy: true }];
    for (const action of ['start', 'stop', 'restart']) {
      assert.equal((await f.request('POST', `/api/runners/runner/${action}`)).statusCode, 409);
    }
    assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 409);
    assert.deepEqual(f.state.calls, []);
  }
});

test('GitHub outage disables actions and creates without claiming an active service is stopped', async (t) => {
  const f = await fixture(t);
  f.state.locals = [local()]; f.state.offline = true;
  const inv = await f.inventory();
  assert.equal(inv.githubAvailable, false);
  assert.equal(inv.cap.canCreate, false);
  assert.equal(inv.runners[0]?.state, 'disconnected');
  assert.ok(Object.values(inv.runners[0]!.actions).every((a) => !a));
  for (const action of ['start', 'stop', 'restart']) {
    assert.equal((await f.request('POST', `/api/runners/runner/${action}`)).statusCode, 503);
  }
  assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 503);
  assert.equal((await f.request('POST', '/api/runners', { name: 'new' })).statusCode, 503);
  assert.deepEqual(f.state.calls, []);
});

test('headroom outage and lower VM cap prevent creation', async (t) => {
  const f = await fixture(t);
  f.state.headroomOffline = true;
  assert.equal((await f.request('POST', '/api/runners', { name: 'new' })).statusCode, 409);
  f.state.headroomOffline = false; f.state.cap = 1; f.state.locals = [local()];
  assert.equal((await f.inventory()).cap.limit, 1);
  assert.equal((await f.request('POST', '/api/runners', { name: 'new' })).statusCode, 409);
  assert.deepEqual(f.state.calls, []);
});

test('same-name unregistered directory and duplicate registrations get one deletable row', async (t) => {
  const f = await fixture(t);
  f.state.locals = [{ ...local(), registered: false }];
  f.state.runners = [github(), github('runner', 2)];
  assert.equal((await f.inventory()).runners.length, 1);
  assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 200);
  assert.deepEqual(f.state.calls, ['removal', 'remove:runner', 'delete:1', 'delete:2']);
  assert.equal((await f.inventory()).runners.length, 0);
});

test('busy duplicate and ambiguous local names cannot be deleted', async (t) => {
  const f = await fixture(t);
  f.state.runners = [github(), { ...github('runner', 2), busy: true }];
  assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 409);
  f.state.runners = []; f.state.locals = [local(), local()];
  assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 409);
  assert.deepEqual(f.state.calls, []);
});

test('orphans on either side remain recoverable', async (t) => {
  for (const side of ['local', 'github']) {
    const f = await fixture(t);
    if (side === 'local') f.state.locals = [local()];
    else f.state.runners = [github()];
    assert.equal((await f.inventory()).runners[0]?.state, `orphan-${side}`);
    assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 200);
    assert.equal((await f.inventory()).runners.length, 0);
  }
});

test('failed local removal preserves GitHub registration and releases mutation lock', async (t) => {
  const f = await fixture(t);
  f.state.locals = [local()]; f.state.runners = [github()]; f.state.removeFails = true;
  assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 502);
  assert.equal(f.state.runners.length, 1);
  assert.ok(!f.state.calls.some((c) => c.startsWith('delete:')));
  f.state.removeFails = false;
  assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 200);
  assert.deepEqual((await f.audit.tail()).map((e) => e.outcome), ['success', 'failure']);
});

test('partial delete failures never report success and can be retried', async (t) => {
  for (const failure of ['offlineAfterRemove', 'offlineAfterDelete', 'deleteFails'] as const) {
    const f = await fixture(t);
    f.state.locals = [local()]; f.state.runners = [github()]; f.state[failure] = true;
    assert.ok((await f.request('DELETE', '/api/runners/runner')).statusCode >= 500);
    assert.equal((await f.audit.tail())[0]?.outcome, 'failure');
    f.state[failure] = false; f.state.offline = false;
    if (f.state.runners.length) assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 200);
    assert.equal((await f.inventory()).runners.length, 0);
  }
});

test('partial create is visible and blocks a duplicate retry until cleaned up', async (t) => {
  const f = await fixture(t); f.state.createFails = true;
  assert.equal((await f.request('POST', '/api/runners', { name: 'runner' })).statusCode, 502);
  f.state.createFails = false;
  assert.equal((await f.request('POST', '/api/runners', { name: 'runner' })).statusCode, 409);
  assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 200);
  assert.equal((await f.request('POST', '/api/runners', { name: 'runner' })).statusCode, 200);
});

test('missing and forged sessions and cross-origin requests never reach integrations', async (t) => {
  const f = await fixture(t);
  for (const headers of [{ 'x-authentik-username': 'admin' }, { cookie: `${SESSION_COOKIE}=forged` }]) {
    for (const [method, url] of [['POST', '/api/runners'], ['POST', '/api/runners/runner/stop'], ['DELETE', '/api/runners/runner']] as const) {
      assert.equal((await f.app.inject({ method, url, headers, payload: method === 'POST' ? { name: 'new' } : undefined })).statusCode, 401);
    }
  }
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/runners',
    headers: { cookie: `${SESSION_COOKIE}=${f.session}`, origin: 'https://evil.invalid' }, payload: { name: 'new' } })).statusCode, 403);
  assert.deepEqual(f.state.calls, []);
});

test('protected names and legacy instances reject lifecycle operations', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('POST', '/api/runners', { name: 'protected' })).statusCode, 403);
  f.state.locals = [{ ...local(), legacy: true }]; f.state.runners = [github()];
  for (const action of ['start', 'stop', 'restart']) {
    assert.equal((await f.request('POST', `/api/runners/runner/${action}`)).statusCode, 403);
  }
  assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 403);
  assert.deepEqual(f.state.calls, []);
});

test('missing null malformed and forwarded origins are refused and audited', async (t) => {
  const f = await fixture(t);
  for (const origin of [undefined, 'null', 'not an origin', 'https://evil.invalid']) {
    const headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${f.session}`,
      'x-forwarded-host': '127.0.0.1', 'x-forwarded-proto': 'http', 'x-forwarded-origin': 'http://127.0.0.1' };
    if (origin !== undefined) headers.origin = origin;
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/runners', headers, payload: { name: 'new' } })).statusCode, 403);
  }
  assert.equal((await f.audit.tail()).length, 4);
  assert.ok((await f.audit.tail()).every((e) => e.outcome === 'failure'));
  assert.deepEqual(f.state.calls, []);
});

test('invalid protected busy and cap refusals are audited', async (t) => {
  const f = await fixture(t);
  await f.request('POST', '/api/runners', { name: '../bad' });
  await f.request('POST', '/api/runners', { name: 'protected' });
  f.state.runners = [{ ...github(), busy: true }];
  await f.request('DELETE', '/api/runners/runner');
  f.state.cap = 0;
  await f.request('POST', '/api/runners', { name: 'new' });
  assert.equal((await f.audit.tail()).length, 4);
  assert.ok((await f.audit.tail()).every((e) => e.outcome === 'failure'));
  assert.deepEqual(f.state.calls, []);
});

test('overlapping requests are rejected without a backlog and revoked sessions cannot mutate', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.registry.listRunners = async () => { entered(); await gate; return []; };
  const first = f.request('POST', '/api/runners', { name: 'one' });
  // inject starts lazily when awaited.
  const running = Promise.resolve(first);
  await enteredPromise;
  const others = await Promise.all(Array.from({ length: 10 }, () => f.request('POST', '/api/runners', { name: 'two' })));
  assert.ok(others.every((r) => r.statusCode === 409));
  f.sessions.destroy(f.session);
  release();
  assert.equal((await running).statusCode, 401);
  assert.deepEqual(f.state.calls, []);
});

test('sessions expiring and clients disconnecting during inventory cannot perform side effects', async (t) => {
  for (const reason of ['expired', 'disconnected']) {
    const f = await fixture(t);
    let request: import('fastify').FastifyRequest;
    f.app.addHook('onRequest', async (req) => { request = req; });
    f.registry.listRunners = async () => {
      if (reason === 'expired') {
        // A newly created, immediately expired session has the same rejection path.
        t.mock.method(f.sessions, 'get', () => null);
      } else {
        Object.defineProperty(request.raw, 'aborted', { value: true, configurable: true });
      }
      return [];
    };
    assert.equal((await f.request('POST', '/api/runners', { name: 'new' })).statusCode,
      reason === 'expired' ? 401 : 409);
    assert.deepEqual(f.state.calls, []);
    assert.equal((await f.audit.tail())[0]?.outcome, 'failure');
  }
});


test('audit failures disclose whether the runner action started completed or failed', async (t) => {
  for (const stage of ['not-started', 'completed', 'failed'] as const) {
    const f = await fixture(t);
    if (stage === 'failed') f.state.createFails = true;
    const record = f.audit.record.bind(f.audit);
    const failure = t.mock.method(f.audit, stage === 'not-started' ? 'checkWritable' : 'record', async (entry?: Parameters<AuditLog['record']>[0]) => {
      if (entry?.outcome === 'pending') return record(entry);
      throw new Error('synthetic private audit storage error');
    });
    const response = await f.request('POST', '/api/runners', { name: 'runner' });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().operationState, stage);
    assert.ok(response.json().hint.includes(stage === 'not-started' ? 'No runner action' : 'refresh inventory'));
    assert.ok(!response.body.includes('private audit storage'));
    assert.equal(f.state.locals.length, stage === 'not-started' ? 0 : 1);
    if (stage === 'not-started') assert.deepEqual(f.state.calls, []);
    failure.mock.restore();
    f.state.createFails = false;
    // Audit failure must not retain the mutation lock.
    assert.equal((await f.request('POST', '/api/runners', { name: 'another' })).statusCode, 200);
  }
});

test('busy changes while inventory or removal tokens are pending prevent VM actions', async (t) => {
  for (const action of ['start', 'stop', 'restart', 'delete'] as const) {
    const f = await fixture(t);
    f.state.locals = [{ ...local(), active: action === 'start' ? 'inactive' : 'active' }];
    f.state.runners = [github()];
    const headroom = f.control.headroom.bind(f.control);
    f.control.headroom = async () => {
      f.state.runners[0]!.busy = true;
      return headroom();
    };
    const response = await f.request(action === 'delete' ? 'DELETE' : 'POST',
      action === 'delete' ? '/api/runners/runner' : `/api/runners/runner/${action}`);
    assert.equal(response.statusCode, 409);
    assert.deepEqual(f.state.calls, []);
  }
  const f = await fixture(t);
  f.state.locals = [local()]; f.state.runners = [github()];
  const token = f.registry.createRemoveToken.bind(f.registry);
  f.registry.createRemoveToken = async () => {
    const result = await token();
    f.state.runners[0]!.busy = true;
    return result;
  };
  const response = await f.request('DELETE', '/api/runners/runner');
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().operationState, 'not-started');
  assert.deepEqual(f.state.calls, ['removal']);
});

test('GitHub outage or revoked sessions after token issuance prevent VM removal', async (t) => {
  for (const reason of ['offline', 'revoked']) {
    const f = await fixture(t);
    f.state.locals = [local()]; f.state.runners = [github()];
    const token = f.registry.createRemoveToken.bind(f.registry);
    f.registry.createRemoveToken = async () => {
      const result = await token();
      if (reason === 'offline') f.state.offline = true;
      else f.sessions.destroy(f.session);
      return result;
    };
    const response = await f.request('DELETE', '/api/runners/runner');
    assert.equal(response.statusCode, reason === 'offline' ? 502 : 401);
    assert.equal(response.json().operationState, 'not-started');
    assert.deepEqual(f.state.calls, ['removal']);
    assert.equal(f.state.locals.length, 1);
    assert.equal(f.state.runners.length, 1);
  }
});

test('creation rechecks name capacity and session after registration token issuance', async (t) => {
  for (const change of ['name', 'capacity', 'session', 'offline']) {
    const f = await fixture(t);
    const token = f.registry.createRegistrationToken.bind(f.registry);
    f.registry.createRegistrationToken = async () => {
      const result = await token();
      if (change === 'name') f.state.runners = [github()];
      if (change === 'capacity') f.state.cap = 0;
      if (change === 'session') f.sessions.destroy(f.session);
      if (change === 'offline') f.state.offline = true;
      return result;
    };
    assert.equal((await f.request('POST', '/api/runners', { name: 'runner' })).statusCode,
      change === 'session' ? 401 : change === 'offline' ? 503 : 409);
    assert.deepEqual(f.state.calls, ['registration']);
    assert.equal(f.state.locals.length, 0);
  }
});

test('duplicate cleanup rechecks all registrations between deletions and preserves busy survivors', async (t) => {
  const f = await fixture(t);
  f.state.runners = [github(), github('runner', 2)];
  const remove = f.registry.deleteRunner.bind(f.registry);
  f.registry.deleteRunner = async (id) => {
    await remove(id);
    f.state.runners[0]!.busy = true;
  };
  const response = await f.request('DELETE', '/api/runners/runner');
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().operationState, 'failed');
  assert.ok(response.json().hint.includes('registration 1 deleted'));
  assert.deepEqual(f.state.calls, ['delete:1']);
  assert.deepEqual(f.state.runners.map((r) => r.id), [2]);
});

test('confirmation failure or cancellation preserves a completed create and reports it honestly', async (t) => {
  for (const reason of ['offline', 'revoked', 'disconnected', 'duplicates']) {
    const f = await fixture(t);
    let request: import('fastify').FastifyRequest;
    f.app.addHook('onRequest', async (req) => { request = req; });
    const create = f.control.create.bind(f.control);
    f.control.create = async (args) => {
      const result = await create(args);
      if (reason === 'offline') f.state.offline = true;
      if (reason === 'revoked') f.sessions.destroy(f.session);
      if (reason === 'disconnected') Object.defineProperty(request.raw, 'aborted', { value: true, configurable: true });
      if (reason === 'duplicates') f.state.runners.push(github('runner', 2));
      return result;
    };
    const response = await f.request('POST', '/api/runners', { name: 'runner' });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().operationState, 'completed');
    assert.ok(response.json().error.includes('was created on the VM'));
    assert.equal(f.state.locals.length, 1);
    assert.ok(f.state.runners.length >= 1);
    assert.deepEqual(f.state.calls, ['registration', 'create:runner']);
  }
});

test('offline registration at confirmation deadline never reports online', async (t) => {
  const f = await fixture(t);
  const list = f.registry.listRunners.bind(f.registry);
  const now = Date.now();
  f.registry.listRunners = async () => {
    if (f.state.locals.length) {
      f.state.runners[0]!.status = 'offline';
      t.mock.method(Date, 'now', () => now + 120_000);
    }
    return list();
  };
  const response = await f.request('POST', '/api/runners', { name: 'runner' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().confirmedInGitHub, false);
  assert.equal(response.json().githubStatus, 'offline');
});

test('combined label limit and VM-compatible runner names fail before token issuance', async (t) => {
  const f = await fixture(t);
  f.config.runners.defaultLabels = Array.from({ length: 20 }, (_, i) => `label${i}`);
  assert.equal((await f.request('POST', '/api/runners', { name: 'runner', labels: ['extra'] })).statusCode, 400);
  assert.equal((await f.request('POST', '/api/runners', { name: 'a..b' })).statusCode, 400);
  assert.deepEqual(f.state.calls, []);
});


test('slow audit preflight and final append cannot queue overlapping mutations for later execution', async (t) => {
  for (const phase of ['checkWritable', 'record'] as const) {
    const f = await fixture(t);
    const original = f.audit[phase].bind(f.audit);
    let entered!: () => void;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    t.mock.method(f.audit, phase, async (...args: unknown[]) => {
      if (first && (phase === 'checkWritable' || (args[0] as Parameters<AuditLog['record']>[0]).outcome !== 'pending')) {
        first = false; entered(); await gate;
      }
      // Both methods are exercised through the real audit wrapper.
      if (phase === 'checkWritable') return (original as () => Promise<void>)();
      return (original as AuditLog['record'])(args[0] as Parameters<AuditLog['record']>[0]);
    });
    const running = Promise.resolve(f.request('POST', '/api/runners', { name: 'one' }));
    await pending;
    const rejected = await f.request('POST', '/api/runners', { name: 'two' });
    assert.equal(rejected.statusCode, 409);
    release();
    assert.equal((await running).statusCode, 200);
    assert.deepEqual(f.state.locals.map((runner) => runner.name), ['one']);
  }
});
