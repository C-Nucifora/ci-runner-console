import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInventory } from '../src/reconcile.js';
import type { RunnerRegistry } from '../src/github/registry.js';
import type { LocalInstance, RunnerVmControl } from '../src/vm/ctl.js';

type Github = 'present' | 'missing' | 'outage';
async function inventory(github: Github, patch: Partial<LocalInstance> = {},
  options: { busy?: boolean; vmOutage?: boolean; noLocal?: boolean; protected?: boolean } = {}) {
  const local: LocalInstance = {
    name: 'review', dir: '/synthetic/review', unit: 'actions.runner.review.service',
    serviceInstalled: true, registered: true, active: 'active', enabled: 'enabled',
    subState: null, activeSince: null, legacy: false, ...patch,
  };
  const registry = {
    listRunners: async () => {
      if (github === 'outage') throw new Error('synthetic outage');
      return github === 'missing' ? [] : [{ id: 9, name: local.name, os: 'linux',
        status: 'offline' as const, busy: options.busy ?? false, labels: [] }];
    },
    describe: () => 'synthetic/example', registrationUrl: () => 'https://github.com/synthetic/example',
  } as unknown as RunnerRegistry;
  const control = {
    list: async () => {
      if (options.vmOutage) throw new Error('synthetic VM outage');
      return options.noLocal ? [] : [local];
    },
    headroom: async () => ({ cpus: 1, load: { one: 0, five: 0, fifteen: 0 },
      memory: { totalBytes: 1, availableBytes: 1 }, disk: { totalBytes: 1, freeBytes: 1 },
      instances: 1, cap: 3, remaining: 2 }),
  } as unknown as RunnerVmControl;
  return buildInventory(registry, control, { cap: 3, protectedNames: options.protected ? ['review'] : [] });
}

for (const github of ['present', 'missing', 'outage'] as const) {
  for (const installed of [true, false]) {
    for (const active of ['active', 'failed', 'deactivating', null]) {
      test(`${github}, installed=${installed}, state=${active}: action boundary`, async () => {
        const result = await inventory(github, { active, serviceInstalled: installed,
          unit: installed ? 'actions.runner.review.service' : null });
        const row = result.runners[0]!;
        assert.equal(result.cap.used, 1);
        if (github === 'outage' || installed && (active === 'deactivating' || active === null)) {
          assert.deepEqual(row.actions, { start: false, stop: false, restart: false, delete: false });
        } else {
          assert.equal(row.actions.start, installed && active === 'failed');
          assert.equal(row.actions.stop, installed && active === 'active');
          assert.equal(row.actions.restart, installed);
          assert.equal(row.actions.delete, true);
        }
        if (github === 'outage') {
          assert.equal(result.cap.canCreate, false);
          assert.match(row.detail, /GitHub state unknown/);
        }
      });
    }
  }
}

for (const registered of [true, false]) {
  for (const active of ['deactivating', null]) {
    test(`missing registration, registered=${registered}, state=${active}: actionable guidance`, async () => {
      const row = (await inventory('missing', { registered, active })).runners[0]!;
      assert.ok(Object.values(row.actions).every(value => !value));
      assert.match(row.detail, /refresh|inspect|wait/i,
        `uncertain service blocks every action but offers no recovery guidance: ${JSON.stringify(row)}`);
      assert.doesNotMatch(row.detail, /delete it here|cannot pick up jobs/i);
    });
  }
}

test('busy and protected states override all otherwise available controls', async () => {
  for (const active of ['active', 'failed', 'deactivating', null]) {
    for (const options of [{ busy: true }, { protected: true }]) {
      const row = (await inventory('present', { active }, options)).runners[0]!;
      assert.ok(Object.values(row.actions).every(value => !value));
    }
  }
});

test('VM inventory outages fail closed even with known GitHub registrations', async () => {
  for (const github of ['present', 'missing', 'outage'] as const) {
    await assert.rejects(inventory(github, {}, { vmOutage: true }), /Cannot reach the runner VM/);
  }
});

test('genuine GitHub-only registration still permits cleanup', async () => {
  const row = (await inventory('present', {}, { noLocal: true })).runners[0]!;
  assert.equal(row.state, 'orphan-github');
  assert.deepEqual(row.actions, { start: false, stop: false, restart: false, delete: true });
});
