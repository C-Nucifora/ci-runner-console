// Bounded audit and inventory recovery regressions using isolated state.
// Serial execution only, under heavy.lock and the designated TMPDIR. No network.
import assert from 'node:assert/strict';
import fs, { type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AuditLog, type AuditEntry } from '../src/audit.js';
import { buildInventory } from '../src/reconcile.js';
import type { GitHubRunner, RunnerRegistry } from '../src/github/registry.js';
import type { Headroom, LocalInstance, RunnerVmControl } from '../src/vm/ctl.js';

const entry: AuditEntry = {
  at: '2026-11-12T00:00:00.000Z', actor: { sub: 'synthetic', username: 'fixture', email: null },
  action: 'runner.restart', target: 'synthetic-runner', params: {}, outcome: 'pending',
  operationId: 'synthetic-operation', requestId: 'synthetic-request', durationMs: 0,
};
async function auditFixture(t: TestContext) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'crc-r4-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'audit.jsonl');
  const handle = await fs.open(path, 'w');
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  return { path, prototype, log: new AuditLog(path) };
}

// FileHandle.read may legally return fewer bytes than requested before EOF.
// Hypothesis: a single successful short read is treated as the complete tail,
// so a durable outcome becomes invisible even though its bytes remain on disk.
for (const prefixBytes of [0, 1024 * 1024 + 37]) {
  test(`R4 audit short reads retain complete outcomes with ${prefixBytes} old bytes`, { timeout: 5_000 }, async t => {
    const f = await auditFixture(t);
    const rows = [entry, { ...entry, operationId: 'other-operation', requestId: 'other-request' },
      { ...entry, params: { labels: ['caf\u00e9'], token: 'synthetic-secret' }, outcome: 'success', durationMs: 17 }];
    const data = (prefixBytes ? 'x'.repeat(prefixBytes) + '\n' : '') +
      rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    await fs.writeFile(f.path, data);
    const originalRead = f.prototype.read;
    let calls = 0;
    let bytesReturned = 0;
    const maxChunk = prefixBytes ? 16_381 : 127;
    const mock = t.mock.method(f.prototype, 'read', async function (
      this: FileHandle, buffer: Buffer, offset: number, length: number, position: number,
    ) {
      assert.ok(++calls <= 128, 'bounded fixture must not spin on short reads');
      const result = await Reflect.apply(originalRead, this,
        [buffer, offset, Math.min(length, maxChunk), position]) as { bytesRead: number; buffer: Buffer };
      bytesReturned += result.bytesRead;
      return result;
    });
    let actual: AuditEntry[];
    try { actual = await f.log.tail(); } finally { mock.mock.restore(); }
    assert.deepEqual(actual.map(row => [row.operationId, row.outcome]),
      [['synthetic-operation', 'success'], ['other-operation', 'pending']],
      'legal short reads must not hide the stored outcome or another unresolved intent');
    assert.deepEqual(actual[0]!.params, { labels: ['caf\u00e9'], token: '[redacted]' });
    assert.ok(calls > 1, 'fixture must exercise more than one underlying read');
    assert.ok(bytesReturned <= 1024 * 1024, 'tail read remains within its one MiB budget');
    assert.equal(await fs.readFile(f.path, 'utf8'), data, 'history reads never rewrite prior bytes');
  });
}

test('R4 audit reader stops at EOF after a short read', { timeout: 5_000 }, async t => {
  const f = await auditFixture(t);
  const row = JSON.stringify(entry) + '\n';
  await fs.writeFile(f.path, row + row);
  let calls = 0;
  t.mock.method(f.prototype, 'read', async (buffer: Buffer, offset: number) => {
    assert.ok(++calls <= 2, 'EOF must terminate the read loop');
    if (calls === 1) buffer.write(row, offset);
    return { bytesRead: calls === 1 ? Buffer.byteLength(row) : 0, buffer };
  });
  assert.equal((await f.log.tail()).length, 1);
  assert.equal(calls, 2);
});

test('R4 interleaved operations deduplicate after limits and survive a malformed later outcome', async t => {
  const f = await auditFixture(t);
  const a = { ...entry, operationId: 'operation-a', requestId: 'shared-request' };
  const b = { ...entry, operationId: 'operation-b', requestId: 'shared-request' };
  const { operationId: _operationId, ...legacy } = entry;
  const payloads = [a, b, { ...a, outcome: 'success', durationMs: 3 },
    { ...a, outcome: 'failure', params: null }, legacy,
    { ...b, outcome: 'failure', durationMs: 4, params: {
      labels: ['linux'], token: { nested: 'synthetic-secret' }, state: ['synthetic-secret'],
      target: { token: 'synthetic-secret' }, hadLocal: true, hadGitHub: false,
    }, error: 'synthetic-secret' }];
  await fs.writeFile(f.path, payloads.map(row => JSON.stringify(row)).join('\n') + '\n{"torn":');
  const recent = await f.log.tail(3);
  assert.deepEqual(recent.map(row => [row.operationId, row.outcome]),
    [['operation-b', 'failure'], [undefined, 'pending'], ['operation-a', 'success']]);
  assert.equal(JSON.stringify(recent).includes('synthetic-secret'), false);
  assert.deepEqual(recent[0]!.params, { labels: ['linux'], token: '[redacted]', state: '[redacted]',
    target: '[redacted]', hadLocal: true, hadGitHub: false });
  assert.deepEqual(await f.log.tail(2), recent.slice(0, 2));
  await f.log.record({ ...b, outcome: 'success', durationMs: 5 });
  const reopened = await new AuditLog(f.path).tail(3);
  assert.deepEqual(reopened.map(row => [row.operationId, row.outcome]),
    [['operation-b', 'success'], [undefined, 'pending'], ['operation-a', 'success']]);
});

const local = (name: string, patch: Partial<LocalInstance> = {}): LocalInstance => ({
  name, dir: `/synthetic/${name}`, unit: `actions.runner.synthetic.${name}.service`,
  active: 'active', enabled: 'enabled', activeSince: null, subState: 'running',
  registered: true, serviceInstalled: true, legacy: false, ...patch,
});
const github = (name: string, id: number, busy = false): GitHubRunner => ({
  name, id, busy, status: 'online', os: 'linux', labels: [],
});
const disabled = { start: false, stop: false, restart: false, delete: false };

// Mix independent names and resource disagreements through repeated reads. This
// challenges cross-row interference and recovery rather than another single-row
// state table. Input arrays and records are frozen to detect accidental mutation.
for (const reversed of [false, true]) {
  test(`R4 mixed inventory recovery remains conservative with reversed=${reversed}`, async () => {
    const effects: string[] = [];
    const locals = Object.freeze([
      Object.freeze(local('guarded', { legacy: true })),
      Object.freeze(local('waiting', { active: 'refreshing' })),
      Object.freeze(local('busy')),
    ]);
    const registrations = Object.freeze([
      Object.freeze(github('guarded', 1)), Object.freeze(github('waiting', 2)),
      Object.freeze(github('busy', 3)), Object.freeze(github('busy', 4, true)),
      Object.freeze(github('remote-only', 5)),
    ]);
    let githubUnavailable = false;
    let headroomUnavailable = false;
    let instances = 5;
    const registry: RunnerRegistry = {
      async listRunners() {
        if (githubUnavailable) throw new Error('synthetic registry outage');
        return reversed ? [...registrations].reverse() : [...registrations];
      },
      async createRegistrationToken() { effects.push('create-token'); throw new Error('unexpected effect'); },
      async createRemoveToken() { effects.push('remove-token'); throw new Error('unexpected effect'); },
      async deleteRunner() { effects.push('delete'); throw new Error('unexpected effect'); },
      describe: () => 'synthetic target', registrationUrl: () => 'https://github.com/synthetic/fixture',
    };
    const control = {
      async list() { return reversed ? [...locals].reverse() : [...locals]; },
      async headroom(): Promise<Headroom> {
        if (headroomUnavailable) throw new Error('synthetic headroom outage');
        return { cpus: 1, load: { one: 0, five: 0, fifteen: 0 },
          memory: { totalBytes: 10, availableBytes: 5 }, disk: { totalBytes: 20, freeBytes: 10 },
          instances, cap: 4, remaining: Math.max(0, 4 - instances) };
      },
    } as unknown as RunnerVmControl;
    const read = () => buildInventory(registry, control, { cap: 6, protectedNames: [] });
    const first = await read();
    assert.deepEqual(first.cap, { used: 5, limit: 4, remaining: 0, canCreate: false });
    for (const name of ['guarded', 'waiting', 'busy']) {
      assert.deepEqual(first.runners.find(row => row.name === name)!.actions, disabled);
    }
    assert.equal(first.runners.find(row => row.name === 'remote-only')!.actions.delete, true);
    githubUnavailable = true;
    const unavailable = await read();
    assert.equal(unavailable.runners.length, 3, 'an unavailable registry cannot preserve stale remote-only rows');
    assert.ok(unavailable.runners.every(row => Object.values(row.actions).every(allowed => !allowed)));
    assert.equal(unavailable.cap.canCreate, false);
    headroomUnavailable = true;
    const bothUnavailable = await read();
    assert.equal(bothUnavailable.cap.used, 3);
    assert.equal(bothUnavailable.cap.canCreate, false);
    assert.equal(bothUnavailable.warnings.length, 2);
    githubUnavailable = false;
    const registryRecovered = await read();
    assert.equal(registryRecovered.runners.length, 4);
    assert.equal(registryRecovered.cap.canCreate, false, 'registry recovery alone does not justify capacity');
    headroomUnavailable = false;
    instances = 2;
    const recovered = await read();
    assert.deepEqual(recovered.cap, { used: 3, limit: 4, remaining: 1, canCreate: true });
    assert.equal(recovered.warnings.length, 0);
    for (const name of ['guarded', 'waiting', 'busy']) {
      assert.deepEqual(recovered.runners.find(row => row.name === name)!.actions, disabled);
    }
    assert.deepEqual(first.cap, { used: 5, limit: 4, remaining: 0, canCreate: false },
      'later recovery must not alter the earlier returned snapshot');
    assert.deepEqual(effects, []);
  });
}
