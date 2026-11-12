import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { AuditLog, type AuditEntry } from '../src/audit.js';
import { SessionStore } from '../src/auth/session.js';
import type { Config } from '../src/config.js';
import { GitHubApiError, type GitHubRunner, type RunnerRegistry } from '../src/github/registry.js';
import type { Inventory } from '../src/reconcile.js';
import { registerApiRoutes } from '../src/routes/api.js';
import { SESSION_COOKIE } from '../src/routes/auth.js';
import { RunnerVmControl, type LocalInstance } from '../src/vm/ctl.js';
import { RunnerVm, VmError } from '../src/vm/ssh.js';

function local(name = 'runner'): LocalInstance {
  return { name, dir: `/synthetic/${name}`, unit: `actions.runner.synthetic.${name}.service`,
    registered: true, serviceInstalled: true, active: 'active', enabled: 'enabled',
    subState: 'running', activeSince: null, legacy: false };
}

function github(id = 1, name = 'runner'): GitHubRunner {
  return { id, name, os: 'linux', status: 'online', busy: false, labels: [] };
}

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, async wait() { enter(); await released; } };
}

class MemoryAudit extends AuditLog {
  readonly entries: AuditEntry[] = [];
  beforeRecord: (entry: AuditEntry) => Promise<void> = async () => {};
  constructor() { super('/unused-synthetic-audit'); }
  override async checkWritable() {}
  override async record(entry: AuditEntry) {
    await this.beforeRecord(entry);
    this.entries.push(structuredClone(entry));
  }
}

async function fixture(t: TestContext) {
  const state = {
    locals: [] as LocalInstance[], runners: [] as GitHubRunner[], vmCap: 3,
    countedInstances: null as number | null, githubUnavailable: false, listUnavailable: false,
    headroomUnavailable: false, effects: [] as string[], listCalls: 0,
    step: async (_phase: string): Promise<void> => {},
  };
  const audit = new MemoryAudit();
  function effect(value: string) {
    assert.ok(audit.entries.some((entry) => entry.outcome === 'pending'), 'intent precedes side effects');
    state.effects.push(value);
  }
  const registry: RunnerRegistry = {
    async listRunners() {
      state.listCalls++;
      await state.step('github.list');
      if (state.githubUnavailable) throw new GitHubApiError('synthetic GitHub outage', 502);
      return structuredClone(state.runners);
    },
    async createRegistrationToken() {
      effect('registration-token');
      await state.step('registration-token');
      return { token: 'synthetic-registration', expiresAt: '2099-01-01T00:00:00Z' };
    },
    async createRemoveToken() {
      effect('remove-token');
      await state.step('remove-token');
      return { token: 'synthetic-removal', expiresAt: '2099-01-01T00:00:00Z' };
    },
    async deleteRunner(id) {
      effect(`delete:${id}`);
      state.runners = state.runners.filter((runner) => runner.id !== id);
      await state.step(`deleted:${id}`);
    },
    describe: () => 'synthetic/round2', registrationUrl: () => 'https://github.com/synthetic/round2',
  };
  // Real JSON and schema validation; only transport and external state are synthetic.
  const vm = Object.create(RunnerVm.prototype) as RunnerVm;
  vm.run = async (argv) => {
    const [operation, name] = argv;
    await state.step(`vm.${operation}.before`);
    let body: object;
    if (operation === 'list') {
      if (state.listUnavailable) throw new VmError('synthetic inspection failure');
      body = { instances: structuredClone(state.locals) };
    } else if (operation === 'headroom') {
      if (state.headroomUnavailable) throw new VmError('synthetic headroom failure');
      const instances = state.countedInstances ?? state.locals.length;
      body = { cap: state.vmCap, instances, remaining: Math.max(0, state.vmCap - instances),
        cpus: 1, load: { one: 0, five: 0, fifteen: 0 },
        memory: { totalBytes: 1, availableBytes: 1 }, disk: { totalBytes: 1, freeBytes: 1 } };
    } else {
      assert.ok(name);
      effect(`${operation}:${name}`);
      if (operation === 'create') {
        assert.ok(state.locals.length < state.vmCap, 'VM cap is independently enforced');
        const instance = local(name);
        state.locals.push(instance);
        state.runners.push(github(Math.max(0, ...state.runners.map((runner) => runner.id)) + 1, name));
        body = instance;
      } else if (operation === 'remove') {
        state.locals = state.locals.filter((instance) => instance.name !== name);
        body = { name, deregisteredLocally: false };
      } else {
        const instance = state.locals.find((instance) => instance.name === name);
        assert.ok(instance);
        instance.active = operation === 'stop' ? 'inactive' : 'active';
        body = { name, unit: instance.unit, active: instance.active };
      }
    }
    await state.step(`vm.${operation}.after`);
    return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, ...body }) };
  };
  const config = { publicBaseUrl: 'http://127.0.0.1', github: { scope: 'repo' },
    runners: { cap: 3, defaultLabels: [], protectedNames: [] } } as unknown as Config;
  const sessions = new SessionStore('synthetic-round2-secret-at-least-32-characters', 3600);
  const identity = { sub: 'synthetic', username: 'tester', email: null, name: null, groups: [] };
  let session = sessions.create(identity);
  const app = Fastify();
  let activeRequest: FastifyRequest;
  app.addHook('onRequest', async (req) => { activeRequest = req; });
  await app.register(cookie);
  registerApiRoutes(app, { config, sessions, registry, audit, control: new RunnerVmControl(vm),
    credential: { getToken: async () => 'synthetic', describe: () => 'synthetic' } });
  const gates: ReturnType<typeof gate>[] = [];
  t.after(async () => { for (const hold of gates) hold.release(); await app.close(); });
  const headers = () => ({ cookie: `${SESSION_COOKIE}=${session}`, origin: config.publicBaseUrl });
  return { state, config, registry, audit,
    hold() { const hold = gate(); gates.push(hold); return hold; },
    cancel(reason: 'revoked' | 'disconnected') {
      if (reason === 'revoked') sessions.destroy(session);
      else Object.defineProperty(activeRequest.raw, 'aborted', { value: true, configurable: true });
    },
    signIn() { session = sessions.create(identity); },
    request: (method: 'POST' | 'DELETE', url: string, payload?: object) =>
      app.inject({ method, url, headers: headers(), payload }),
    async inventory() {
      const response = await app.inject({ url: '/api/inventory', headers: headers() });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Inventory>();
    },
  };
}

test('a delayed rejected mutation cannot acquire or release a later owner\'s slot', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const first = f.hold();
  const rejected = f.hold();
  const third = f.hold();
  let tokens = 0;
  f.state.step = async (phase) => {
    if (phase === 'registration-token') await (++tokens === 1 ? first : third).wait();
  };
  f.audit.beforeRecord = async (entry) => {
    if (entry.target === 'one' && entry.action === 'runner.delete' && entry.outcome === 'pending') await rejected.wait();
  };
  const a = Promise.resolve(f.request('POST', '/api/runners', { name: 'one' }));
  await first.entered;
  const b = Promise.resolve(f.request('DELETE', '/api/runners/one'));
  await rejected.entered;
  first.release();
  assert.equal((await a).statusCode, 200);
  const c = Promise.resolve(f.request('POST', '/api/runners', { name: 'three' }));
  await third.entered;
  rejected.release();
  assert.equal((await b).statusCode, 409);
  assert.equal((await f.request('POST', '/api/runners/one/stop')).statusCode, 409);
  third.release();
  assert.equal((await c).statusCode, 200);
  assert.deepEqual(f.state.effects, ['registration-token', 'create:one', 'registration-token', 'create:three']);
  assert.deepEqual(f.state.locals.map((runner) => runner.name), ['one', 'three']);
});

test('failed delayed create outcome blocks delete until completion and duplicate retry stays refused', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const outcome = f.hold();
  f.audit.beforeRecord = async (entry) => {
    if (entry.action === 'runner.create' && entry.outcome === 'success') {
      await outcome.wait();
      throw new Error('synthetic outcome write failure');
    }
  };
  const creating = Promise.resolve(f.request('POST', '/api/runners', { name: 'runner' }));
  await outcome.entered;
  assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 409);
  outcome.release();
  const failed = await creating;
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().operationState, 'completed');
  assert.match(failed.json().hint, /refresh inventory/i);
  f.audit.beforeRecord = async () => {};
  assert.equal((await f.request('POST', '/api/runners', { name: 'runner' })).statusCode, 409);
  assert.deepEqual(f.state.effects, ['registration-token', 'create:runner']);
  assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 200);
  assert.deepEqual((await f.inventory()).runners, []);
});

for (const change of ['count-high', 'list-high', 'console-lower', 'inspection-failure', 'headroom-failure'] as const) {
  test(`create rechecks ${change} after token issuance, then recovers from a fresh snapshot`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    f.state.step = async (phase) => {
      if (phase !== 'registration-token') return;
      if (change === 'count-high') f.state.countedInstances = 3;
      if (change === 'list-high') {
        f.state.locals = ['a', 'b', 'c'].map((name) => ({ ...local(name), active: 'deactivating' }));
        f.state.countedInstances = 0;
      }
      if (change === 'console-lower') { f.config.runners.cap = 1; f.state.countedInstances = 1; }
      if (change === 'inspection-failure') f.state.listUnavailable = true;
      if (change === 'headroom-failure') f.state.headroomUnavailable = true;
    };
    const response = await f.request('POST', '/api/runners', { name: 'runner' });
    assert.equal(response.statusCode, change === 'inspection-failure' ? 500 : 409, response.body);
    assert.deepEqual(f.state.effects, ['registration-token']);
    if (change !== 'inspection-failure') {
      const inventory = await f.inventory();
      assert.equal(inventory.cap.canCreate, false);
      if (change === 'list-high') {
        assert.equal(inventory.cap.used, 3);
        assert.ok(inventory.runners.every((runner) => Object.values(runner.actions).every((allowed) => !allowed)));
      }
    }
    f.state.step = async () => {};
    f.state.locals = []; f.state.countedInstances = null;
    f.state.listUnavailable = f.state.headroomUnavailable = false;
    assert.equal((await f.request('POST', '/api/runners', { name: 'runner' })).statusCode, 200);
    assert.equal(f.state.locals.length, 1);
  });
}

for (const evolution of ['replace-id', 'rename-survivor', 'new-busy-duplicate'] as const) {
  test(`duplicate cleanup handles ${evolution} between GitHub deletions`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    f.state.runners = [github(1), github(2)];
    f.state.step = async (phase) => {
      if (phase !== 'deleted:1') return;
      if (evolution === 'replace-id') f.state.runners = [github(3)];
      if (evolution === 'rename-survivor') f.state.runners = [{ ...github(2, 'other'), busy: true }];
      if (evolution === 'new-busy-duplicate') f.state.runners.push({ ...github(3), busy: true });
    };
    const response = await f.request('DELETE', '/api/runners/runner');
    assert.equal(response.statusCode, evolution === 'rename-survivor' ? 200 : evolution === 'replace-id' ? 502 : 409, response.body);
    assert.deepEqual(f.state.effects, ['delete:1']);
    if (evolution === 'rename-survivor') {
      assert.deepEqual(f.state.runners.map((runner) => [runner.id, runner.name, runner.busy]), [[2, 'other', true]]);
    } else {
      assert.equal(response.json().operationState, 'failed');
      assert.match(response.json().hint, /registration 1 deleted/);
      f.state.step = async () => {};
      f.state.runners.forEach((runner) => { runner.busy = false; });
      assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 200);
      assert.deepEqual(f.state.runners, []);
      assert.equal(f.state.effects.filter((effect) => effect === 'delete:1').length, 1);
    }
  });
}

for (const failedRead of [2, 3, 4, 5, 6, 7]) {
  test(`GitHub outage at removal read ${failedRead} permits only the already-authorized prefix`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    f.state.locals = [local()];
    f.state.runners = [github(1), github(2)];
    f.state.step = async (phase) => {
      if (phase === 'github.list' && f.state.listCalls === failedRead) f.state.githubUnavailable = true;
    };
    const response = await f.request('DELETE', '/api/runners/runner');
    assert.ok(response.statusCode >= 500, response.body);
    const prefix = ['remove-token', 'remove:runner', 'delete:1', 'delete:2'];
    const authorized = failedRead === 2 ? 0 : failedRead === 3 ? 1 : failedRead <= 5 ? 2 : failedRead - 3;
    assert.deepEqual(f.state.effects, prefix.slice(0, authorized));
    assert.equal(response.json().operationState, authorized < 2 ? 'not-started' : 'failed');
    assert.match(response.json().hint, /Refresh inventory/);
    if (authorized >= 2) assert.match(response.json().hint, /local instance removed/);
    if (authorized >= 3) assert.match(response.json().hint, /registration 1 deleted/);
    const duringOutage = await f.inventory();
    assert.equal(duringOutage.githubAvailable, false);
    assert.equal(duringOutage.cap.canCreate, false);
    assert.ok(duringOutage.runners.every((runner) => Object.values(runner.actions).every((allowed) => !allowed)));
    f.state.step = async () => {};
    f.state.githubUnavailable = false;
    const retry = await f.request('DELETE', '/api/runners/runner');
    assert.equal(retry.statusCode, failedRead === 7 ? 404 : 200, retry.body);
    assert.deepEqual((await f.inventory()).runners, []);
    assert.deepEqual(f.state.effects.filter((effect) => effect !== 'remove-token'), prefix.slice(1));
    assert.equal(f.state.effects.filter((effect) => effect === 'remove-token').length, failedRead === 3 ? 2 : 1);
  });
}

test('lost GitHub deletion acknowledgement retains the survivor and retry does not reuse the old id', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  f.state.runners = [github(1), github(2)];
  f.state.step = async (phase) => {
    if (phase === 'deleted:1') throw new GitHubApiError('synthetic timeout after committed deletion', 502);
  };
  const response = await f.request('DELETE', '/api/runners/runner');
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().operationState, 'failed');
  assert.match(response.json().hint, /Confirmed steps: none/);
  assert.doesNotMatch(response.json().error, /was not started/);
  assert.deepEqual(f.state.runners.map((runner) => runner.id), [2]);
  assert.deepEqual(f.state.effects, ['delete:1']);
  f.state.step = async () => {};
  assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 200);
  assert.deepEqual(f.state.effects, ['delete:1', 'delete:2']);
  assert.deepEqual((await f.inventory()).runners, []);
});

for (const reason of ['revoked', 'disconnected'] as const) {
  test(`${reason} request after the first duplicate deletion cannot delete the survivor`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    f.state.runners = [github(1), github(2)];
    f.state.step = async (phase) => { if (phase === 'deleted:1') f.cancel(reason); };
    const response = await f.request('DELETE', '/api/runners/runner');
    assert.equal(response.statusCode, reason === 'revoked' ? 401 : 409, response.body);
    assert.equal(response.json().operationState, 'failed');
    assert.match(response.json().hint, /registration 1 deleted/);
    assert.deepEqual(f.state.effects, ['delete:1']);
    assert.deepEqual(f.state.runners.map((runner) => runner.id), [2]);
    f.signIn(); f.state.step = async () => {};
    assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 200);
    assert.deepEqual(f.state.effects, ['delete:1', 'delete:2']);
  });
}

test('timeout after a partial VM stop keeps cleanup guarded until service uncertainty settles', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  f.state.locals = [local()]; f.state.runners = [github()];
  f.state.step = async (phase) => {
    if (phase !== 'vm.remove.before') return;
    f.state.effects.push('partial-remove:runner');
    f.state.locals[0]!.active = 'deactivating';
    throw new VmError('synthetic timeout after stop dispatch');
  };
  const failed = await f.request('DELETE', '/api/runners/runner');
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.json().operationState, 'failed');
  const row = (await f.inventory()).runners[0]!;
  assert.equal(row.state, 'service-changing');
  assert.match(row.detail, /wait|refresh/i);
  assert.doesNotMatch(row.detail, /delete it here|will not.*work/i);
  assert.ok(Object.values(row.actions).every((allowed) => !allowed));
  f.state.step = async () => {};
  assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 409);
  assert.deepEqual(f.state.effects, ['remove-token', 'partial-remove:runner']);
  f.state.locals[0]!.active = 'inactive';
  assert.equal((await f.request('DELETE', '/api/runners/runner')).statusCode, 200);
  assert.deepEqual((await f.inventory()).runners, []);
});

// Keep the forward correction within the session lifetime to isolate confirmation timing.
for (const shift of [-60 * 60 * 1000, 5 * 60 * 1000]) {
  test(`create confirmation deadline survives a ${shift < 0 ? 'backward' : 'forward'} clock correction and releases the mutation slot`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    let wall = Date.now();
    let elapsed = 0;
    const monotonic = Math.floor(performance.now());
    const timeout = setTimeout;
    t.mock.method(Date, 'now', () => wall);
    t.mock.method(performance, 'now', () => monotonic + elapsed);
    // Advance the polling budget without waiting a real minute; all other timers retain their behavior.
    t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 3000) { elapsed += delay; wall += delay; }
      return timeout(callback, delay === 3000 ? 1 : delay, ...args);
    });
    let confirmationReads = 0;
    f.state.step = async (phase) => {
      if (phase === 'vm.create.after') f.state.runners[0]!.status = 'offline';
      if (phase !== 'github.list' || f.state.locals.length === 0) return;
      if (++confirmationReads === 1) wall += shift;
      // Bound the broken implementation too, so a failed regression leaves no polling loop behind.
      if (elapsed > 60_000) throw new GitHubApiError('synthetic polling budget exhausted', 502);
    };
    const response = await f.request('POST', '/api/runners', { name: 'runner' });
    const observation = { status: response.statusCode, body: response.json(), elapsed, confirmationReads };
    f.state.step = async () => {};
    assert.equal(f.state.locals.length, 1);
    assert.deepEqual(f.state.effects, ['registration-token', 'create:runner']);
    assert.ok(f.audit.entries.every((entry) => entry.durationMs >= 0), 'round-one audit clock fix remains intact');
    assert.equal((await f.request('POST', '/api/runners/runner/stop')).statusCode, 200, 'slot is released after confirmation exits');
    assert.equal(response.statusCode, 200, JSON.stringify(observation));
    assert.equal(response.json().confirmedInGitHub, false);
    assert.equal(response.json().githubStatus, 'offline');
    assert.equal(elapsed, 60_000, JSON.stringify(observation));
  });
}
