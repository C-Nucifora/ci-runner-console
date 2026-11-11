import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { AuditLog } from '../src/audit.js';
import { SessionStore } from '../src/auth/session.js';
import type { Config } from '../src/config.js';
import type { GitHubRunner, RunnerRegistry } from '../src/github/registry.js';
import { buildInventory, needsAttention } from '../src/reconcile.js';
import { registerApiRoutes } from '../src/routes/api.js';
import { SESSION_COOKIE } from '../src/routes/auth.js';
import { RunnerVmControl, type LocalInstance } from '../src/vm/ctl.js';
import { RunnerVm, type CtlResult } from '../src/vm/ssh.js';

const local: LocalInstance = {
  name: 'followup', dir: '/synthetic/followup', unit: 'actions.runner.followup.service',
  registered: true, serviceInstalled: true, active: 'active', enabled: 'enabled',
  subState: 'running', activeSince: null, legacy: false,
};
const github: GitHubRunner = {
  name: local.name, id: 17, os: 'linux', status: 'online', busy: false, labels: [],
};
const disabled = { start: false, stop: false, restart: false, delete: false };

function fixture() {
  const state = {
    locals: [local], runners: [] as GitHubRunner[], githubFailure: false,
    headroomFailure: false, instances: 1, cap: 3, reply: null as CtlResult | null,
    effects: [] as string[],
  };
  const registry: RunnerRegistry = {
    async listRunners() {
      if (state.githubFailure) throw new Error('synthetic unavailable GitHub state');
      return state.runners;
    },
    async createRegistrationToken() { state.effects.push('registration-token'); throw new Error('unexpected token'); },
    async createRemoveToken() { state.effects.push('remove-token'); throw new Error('unexpected token'); },
    async deleteRunner() { state.effects.push('delete-registration'); },
    describe: () => 'synthetic/followup', registrationUrl: () => 'https://github.com/synthetic/followup',
  };
  // Exercise the real JSON/schema boundary without constructing keys or connecting SSH.
  const vm = Object.create(RunnerVm.prototype) as RunnerVm;
  vm.run = async (argv) => {
    if (argv[0] === 'list') return state.reply ?? {
      code: 0, stdout: JSON.stringify({ ok: true, instances: state.locals }), stderr: '',
    };
    if (argv[0] === 'headroom') {
      if (state.headroomFailure) throw new Error('synthetic unavailable headroom');
      return { code: 0, stderr: '', stdout: JSON.stringify({
        ok: true, cpus: 1, load: { one: 0, five: 0, fifteen: 0 },
        memory: { totalBytes: 1, availableBytes: 1 }, disk: { totalBytes: 1, freeBytes: 1 },
        instances: state.instances, cap: state.cap, remaining: Math.max(0, state.cap - state.instances),
      }) };
    }
    state.effects.push(argv.join(' '));
    throw new Error('unexpected VM mutation');
  };
  const control = new RunnerVmControl(vm);
  const inventory = () => buildInventory(registry, control, { cap: 3, protectedNames: [] });
  return { state, registry, control, inventory };
}

for (const registered of [true, false]) {
  test(`missing GitHub registration preserves service uncertainty through refresh, registered=${registered}`, async () => {
    const f = fixture();
    for (const active of ['activating', 'reloading', 'refreshing', 'maintenance', 'future-state']) {
      f.state.locals = [{ ...local, registered, active }];
      const row = (await f.inventory()).runners[0]!;
      assert.equal(row.state, ['activating', 'reloading', 'refreshing'].includes(active)
        ? 'service-changing' : 'service-unknown');
      assert.equal(needsAttention(row.state), true);
      assert.deepEqual(row.actions, disabled);
      assert.match(row.detail, /wait|refresh|inspect/i);
      assert.doesNotMatch(row.detail, /delete it here|cannot pick up jobs|never registered/i);
    }
    f.state.locals = [{ ...local, registered, active: 'inactive' }];
    const settled = (await f.inventory()).runners[0]!;
    assert.equal(settled.state, registered ? 'orphan-local' : 'unregistered');
    assert.deepEqual(settled.actions, { start: true, stop: false, restart: true, delete: true });
    f.state.locals = [{ ...local, registered }];
    assert.deepEqual((await f.inventory()).runners[0]!.actions,
      { start: false, stop: true, restart: true, delete: true });
    assert.deepEqual(f.state.effects, []);
  });
}

test('partial or failed inventory replies never become GitHub-only cleanup rows', async () => {
  const f = fixture();
  f.state.runners = [github];
  const good = JSON.stringify({ ok: true, instances: [local] });
  const failure = JSON.stringify({ ok: false, error: 'service discovery uncertain' });
  for (const reply of [
    { code: 1, stdout: failure, stderr: '' },
    { code: 1, stdout: good, stderr: 'late discovery failure' },
    { code: 0, stdout: `${good}\n${failure}`, stderr: '' },
    { code: 0, stdout: JSON.stringify({ ok: true, instances: [local, { ...local, name: 'tail', active: {} }] }), stderr: '' },
  ]) {
    f.state.reply = reply;
    await assert.rejects(f.inventory(), /Cannot reach the runner VM/);
  }
  f.state.reply = null;
  assert.equal((await f.inventory()).runners[0]!.state, 'online');
  assert.deepEqual(f.state.effects, []);
});

test('headroom disagreement and outage preserve capacity while uncertain services stay guarded', async () => {
  const f = fixture();
  f.state.locals = [{ ...local, active: null }];
  f.state.instances = 3;
  let result = await f.inventory();
  assert.deepEqual(result.cap, { used: 3, limit: 3, remaining: 0, canCreate: false });
  assert.deepEqual(result.runners[0]!.actions, disabled);
  f.state.headroomFailure = true;
  result = await f.inventory();
  assert.deepEqual(result.cap, { used: 1, limit: 3, remaining: 2, canCreate: false });
  assert.match(result.warnings.join(' '), /headroom is unavailable/);
  assert.deepEqual(result.runners[0]!.actions, disabled);
});

test('duplicate local order and any busy duplicate keep uncertain rows immutable', async () => {
  for (const reversed of [false, true]) {
    const f = fixture();
    const locals = [local, { ...local, dir: '/synthetic/other', active: 'refreshing', legacy: true }];
    f.state.locals = reversed ? locals.reverse() : locals;
    f.state.instances = 2;
    f.state.runners = [github, { ...github, id: 18, busy: true }];
    const result = await f.inventory();
    assert.equal(result.runners.length, 1);
    assert.equal(result.cap.used, 2);
    assert.equal(result.runners[0]!.protectedRunner, true);
    assert.equal(result.runners[0]!.github!.busy, true);
    assert.deepEqual(result.runners[0]!.actions, disabled);
    assert.match(result.runners[0]!.detail, /Multiple local instances/);
  }
});

test('GitHub outage after a healthy refresh disables cleanup for both service and directory-only remnants', async () => {
  const f = fixture();
  for (const patch of [{ active: 'active' }, { active: null, unit: null, serviceInstalled: false }]) {
    f.state.locals = [{ ...local, ...patch }];
    f.state.githubFailure = false;
    assert.equal((await f.inventory()).runners[0]!.actions.delete, true);
    f.state.githubFailure = true;
    const result = await f.inventory();
    assert.equal(result.githubAvailable, false);
    assert.equal(result.cap.canCreate, false);
    assert.equal(result.cap.used, 1);
    assert.deepEqual(result.runners[0]!.actions, disabled);
    assert.match(result.runners[0]!.detail, /GitHub state unknown/);
  }
});

test('API gates uncertain, failed-inventory, and GitHub-outage requests before token or mutation calls', async (t) => {
  const f = fixture();
  const dir = await mkdtemp(join(tmpdir(), 'round1-state-followup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = Fastify();
  t.after(() => app.close());
  await app.register(cookie);
  const sessions = new SessionStore('synthetic-followup-session-secret-at-least-32', 3600);
  const session = sessions.create({ sub: 'synthetic', username: 'review', email: null, name: null, groups: [] });
  const config = { publicBaseUrl: 'http://127.0.0.1',
    runners: { cap: 3, defaultLabels: [], protectedNames: [] }, github: { scope: 'repo' },
  } as unknown as Config;
  registerApiRoutes(app, { config, registry: f.registry, control: f.control, sessions,
    audit: new AuditLog(join(dir, 'audit.jsonl')),
    credential: { getToken: async () => 'synthetic', describe: () => 'synthetic' },
  });
  for (const scenario of ['uncertain-service', 'discovery-error', 'github-outage']) {
    f.state.locals = [{ ...local, active: scenario === 'uncertain-service' ? 'refreshing' : 'active' }];
    f.state.githubFailure = scenario === 'github-outage';
    f.state.reply = scenario === 'discovery-error'
      ? { code: 1, stdout: '{"ok":false,"error":"service discovery uncertain"}', stderr: '' } : null;
    for (const action of ['start', 'stop', 'restart', 'delete']) {
      const response = await app.inject({ method: action === 'delete' ? 'DELETE' : 'POST',
        url: `/api/runners/followup${action === 'delete' ? '' : `/${action}`}`,
        headers: { cookie: `${SESSION_COOKIE}=${session}`, origin: config.publicBaseUrl },
      });
      assert.equal(response.statusCode, scenario === 'uncertain-service' ? 409 : scenario === 'github-outage' ? 503 : 500);
      assert.deepEqual(f.state.effects, [], `${scenario}: ${response.body}`);
    }
  }
});
