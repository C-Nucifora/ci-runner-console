import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunnerVmControl } from '../src/vm/ctl.js';
import { RunnerVm, VmError } from '../src/vm/ssh.js';

test('VM response data is validated before it can authorize inventory or report success', async () => {
  let response: unknown;
  const control = new RunnerVmControl({ json: async () => response } as unknown as RunnerVm);
  const local = { name: 'runner', dir: '/opt/runners/runner', unit: 'actions.runner.console.runner.service',
    registered: true, serviceInstalled: true, active: 'active', enabled: 'enabled', subState: 'running',
    activeSince: null, legacy: false };
  for (const patch of [{ serviceInstalled: 'false' }, { active: {} }, { name: '../runner' }, { legacy: 'false' }]) {
    response = { ok: true, instances: [{ ...local, ...patch }] };
    await assert.rejects(control.list(), VmError);
  }
  response = { ok: true, instances: [local] };
  assert.deepEqual(await control.list(), [local]);
  const headroom = { cpus: 4, load: { one: 0, five: 0, fifteen: 0 },
    memory: { totalBytes: 100, availableBytes: 50 }, disk: { totalBytes: 100, freeBytes: 50 },
    cap: 3, instances: 1, remaining: 2 };
  for (const patch of [{ cap: '3' }, { instances: -100 }, { remaining: 3 }, { memory: { totalBytes: 1, availableBytes: 2 } }]) {
    response = { ok: true, ...headroom, ...patch };
    await assert.rejects(control.headroom(), VmError);
  }
  response = { ok: true, ...headroom };
  assert.deepEqual(await control.headroom(), headroom);
  for (const action of ['start', 'stop', 'restart'] as const) {
    for (response of [{ ok: true }, { ok: true, name: 'other', unit: local.unit, active: 'active' }]) {
      await assert.rejects(control[action]('runner'), VmError);
    }
    response = { ok: true, name: 'runner', unit: local.unit, active: 'active' };
    assert.equal((await control[action]('runner')).name, 'runner');
  }
  response = { ok: true, name: 'other', dir: local.dir, unit: local.unit, active: 'active' };
  await assert.rejects(control.create({ name: 'runner', labels: [], url: 'https://github.com/synthetic', registrationToken: 'synthetic_token_123' }), VmError);
  response = { ok: true, name: 'runner', deregisteredLocally: 'true' };
  await assert.rejects(control.remove('runner', 'synthetic_token_123'), VmError);
  response = { ok: true, lines: [42] };
  await assert.rejects(control.logs('runner'), VmError);
});
