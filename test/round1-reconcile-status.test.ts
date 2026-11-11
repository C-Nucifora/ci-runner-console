import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInventory, needsAttention } from '../src/reconcile.js';
import type { RunnerRegistry } from '../src/github/registry.js';
import type { LocalInstance, RunnerVmControl } from '../src/vm/ctl.js';

async function inventory(active: string | null, githubAvailable = true, busy = false) {
  const local: LocalInstance = {
    name: 'state-test', dir: '/synthetic/state-test',
    unit: 'actions.runner.console.state-test.service', registered: true,
    serviceInstalled: true, active, enabled: 'enabled', subState: null,
    activeSince: null, legacy: false,
  };
  const registry = {
    listRunners: async () => {
      if (!githubAvailable) throw new Error('synthetic GitHub outage');
      return [{ id: 1, name: local.name, os: 'linux', status: 'online' as const, busy, labels: [] }];
    },
    describe: () => 'synthetic/example', registrationUrl: () => 'https://github.com/synthetic/example',
  } as unknown as RunnerRegistry;
  const control = {
    list: async () => [local],
    headroom: async () => ({ cpus: 2, load: { one: 0, five: 0, fifteen: 0 },
      memory: { totalBytes: 1, availableBytes: 1 }, disk: { totalBytes: 1, freeBytes: 1 },
      instances: 1, cap: 3, remaining: 2 }),
  } as unknown as RunnerVmControl;
  return (await buildInventory(registry, control, { cap: 3, protectedNames: [] })).runners[0]!;
}

for (const state of ['activating', 'deactivating', 'reloading', 'refreshing', 'maintenance', 'unknown', null]) {
  test(`systemd ${state} is not proof that a service is stopped`, async () => {
    const row = await inventory(state);
    const expected = ['activating', 'deactivating', 'reloading', 'refreshing'].includes(state ?? '')
      ? 'service-changing' : 'service-unknown';
    assert.equal(row.state, expected, `reported ${JSON.stringify(row)}`);
    assert.equal(needsAttention(row.state), true);
    assert.match(row.detail, new RegExp(state ?? 'unknown'));
    assert.ok(Object.values(row.actions).every(action => !action), 'wait for a settled state before mutations');
    assert.equal(row.actions.start, false, 'start requires confirmed inactive or failed service');
    assert.doesNotMatch(row.detail, /will not (be able to )?send|will not be able to send/);
  });
}

test('stable systemd states retain their existing controls', async () => {
  const active = await inventory('active');
  assert.equal(active.state, 'online');
  assert.equal(active.actions.start, false);
  assert.equal(active.actions.stop, true);
  assert.equal(active.actions.restart, true);
  assert.equal(active.actions.delete, true);
  for (const state of ['inactive', 'failed']) {
    const row = await inventory(state);
    assert.equal(row.state, 'stopped');
    assert.equal(row.actions.start, true);
    assert.equal(row.actions.stop, false);
    assert.equal(row.actions.restart, true);
    assert.equal(row.actions.delete, true);
  }
});


test('GitHub outage preserves transitional and unknown service classifications', async () => {
  for (const state of ['activating', 'deactivating', 'reloading', 'refreshing', 'maintenance', 'unknown', null]) {
    const row = await inventory(state, false);
    assert.equal(row.state, (await inventory(state)).state);
    assert.match(row.detail, /GitHub state unknown/);
    assert.ok(Object.values(row.actions).every(action => !action));
  }
  assert.equal((await inventory('active', false)).state, 'disconnected');
  assert.equal((await inventory('inactive', false)).state, 'stopped');
  assert.equal((await inventory('failed', false)).state, 'stopped');
});

test('busy registrations retain mutation guards across local service states', async () => {
  for (const state of ['active', 'inactive', 'failed', 'activating', 'unknown', null]) {
    const row = await inventory(state, true, true);
    assert.ok(Object.values(row.actions).every(action => !action));
  }
  assert.equal((await inventory('active', true, true)).state, 'busy');
});
