import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, AuditWriteError, audited, type AuditEntry } from '../src/audit.js';

const identity = { sub: 'test', username: 'tester', email: null, name: null, groups: [] };
const entry: AuditEntry = { at: '2026-01-01T00:00:00Z', actor: identity, action: 'runner.create',
  target: 'test', params: {}, outcome: 'success', durationMs: 1, requestId: 'test' };

test('audit backlog is bounded and accepts new writes after draining', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-backlog-'));
  try {
    const log = new AuditLog(join(dir, 'audit.jsonl'));
    const results = await Promise.allSettled(Array.from({ length: 65 }, () => log.record(entry)));
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal((await log.tail()).length, 64);
    await log.record(entry);
    assert.equal((await log.tail()).length, 65);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('audit redaction, concurrent JSONL writes, bounds and file permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-test-'));
  try {
    const path = join(dir, 'audit.jsonl');
    const log = new AuditLog(path);
    await Promise.all(Array.from({ length: 30 }, (_, i) => log.record({ ...entry, requestId: String(i),
      params: { labels: ['linux'], token: 'synthetic-secret', nested: { clientSecret: 'synthetic-secret' } },
      error: 'upstream echoed synthetic-secret' })));
    const text = await readFile(path, 'utf8');
    assert.equal(text.includes('synthetic-secret'), false);
    assert.equal(text.trim().split('\n').length, 30);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await log.tail()).length, 30);
    assert.deepEqual(await log.tail(0), []);
    assert.deepEqual(await log.tail(-1), []);
    assert.equal((await log.tail(1))[0]!.requestId, '29');
    await symlink(path, join(dir, 'link'));
    await assert.rejects(new AuditLog(join(dir, 'link')).record(entry));
    await assert.rejects(new AuditLog(dir).record(entry));
    let started = false;
    await assert.rejects(audited(new AuditLog(dir), { identity, action: 'test', requestId: 'test' }, async () => { started = true; }),
      (err) => err instanceof AuditWriteError && err.operationState === 'not-started');
    assert.equal(started, false);
    const unterminated = JSON.stringify(entry);
    await writeFile(path, unterminated);
    await log.record({ ...entry, requestId: 'after-complete-row' });
    assert.ok((await readFile(path, 'utf8')).startsWith(unterminated + '\n'));
    assert.deepEqual((await log.tail()).map(row => row.requestId), ['after-complete-row', 'test']);
    await writeFile(path, 'x'.repeat(2 * 1024 * 1024) + '\n' + JSON.stringify(entry) + '\n' + '{"partial":');
    assert.equal((await log.tail()).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('audited snapshots context and preserves outcomes when audit writing fails', async () => {
  const records: AuditEntry[] = [];
  const log = { checkWritable: async () => {}, record: async (entry: AuditEntry) => { records.push(entry); } } as unknown as AuditLog;
  const ctx = { identity: structuredClone(identity), action: 'runner.start', requestId: 'test', params: { state: 'stopped' } };
  assert.equal(await audited(log, ctx, async () => { ctx.params.state = 'changed'; return 42; }), 42);
  assert.equal(records[0]!.params.state, 'stopped');
  const error = new Error('synthetic-secret');
  await assert.rejects(audited(log, ctx, async () => { throw error; }), (err) => err === error);
  assert.deepEqual(records.map(r => r.outcome), ['pending', 'success', 'pending', 'failure']);
  assert.equal(records[3]!.error, 'Operation failed');
  const failedWrites: AuditEntry[] = [];
  const broken = { checkWritable: async () => {}, record: async (entry: AuditEntry) => {
    if (entry.outcome === 'pending') return;
    failedWrites.push(entry); throw new Error('disk failure');
  } } as unknown as AuditLog;
  await assert.rejects(audited(broken, ctx, async () => 42), (err) => err instanceof AuditWriteError && err.operationState === 'completed');
  assert.equal(failedWrites.length, 1);
  assert.equal(failedWrites[0]!.outcome, 'success');
  for (const operationState of ['completed', 'not-started'] as const) {
    const known = Object.assign(new Error('synthetic failure'), { operationState });
    await assert.rejects(audited(broken, ctx, async () => { throw known; }),
      err => err instanceof AuditWriteError && err.operationState === operationState);
  }
});

test('intent is durable before side effects and remains visible without an outcome', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-intent-'));
  try {
    const path = join(dir, 'audit.jsonl');
    const log = new AuditLog(path);
    const original = log.record.bind(log);
    log.record = async record => {
      if (record.outcome !== 'pending') throw new Error('simulated process interruption');
      return original(record);
    };
    await assert.rejects(audited(log, { identity, action: 'runner.start', requestId: 'same-request-id' }, async () => {
      assert.equal((await new AuditLog(path).tail())[0]?.outcome, 'pending');
      await writeFile(join(dir, 'side-effect'), 'completed');
    }), err => err instanceof AuditWriteError && err.operationState === 'completed');
    assert.equal(await readFile(join(dir, 'side-effect'), 'utf8'), 'completed');
    assert.equal((await new AuditLog(path).tail())[0]?.outcome, 'pending');
    log.record = original;
    await audited(log, { identity, action: 'runner.stop', requestId: 'same-request-id' }, async () => {});
    assert.deepEqual((await log.tail()).map(record => record.outcome), ['success', 'pending']);
    assert.deepEqual((await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line).outcome),
      ['pending', 'pending', 'success']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('torn audit boundary failures prevent side effects and allow a durable retry', async t => {
  for (const phase of ['read', 'separator', 'intent-before', 'intent', 'sync'] as const) {
    await t.test(phase, async t => {
      const dir = await mkdtemp(join(tmpdir(), 'audit-torn-'));
      const path = join(dir, 'audit.jsonl');
      t.after(() => rm(dir, { recursive: true, force: true }));
      const prior = JSON.stringify(entry) + '\n{"torn":';
      await writeFile(path, prior);
      const handle = await open(path, 'r');
      const prototype = Object.getPrototypeOf(handle) as FileHandle;
      await handle.close();
      const originalWrite = prototype.writeFile;
      const originalSync = prototype.sync;
      let syncs = 0;
      const mock = phase === 'read'
        ? t.mock.method(prototype, 'read', async () => { throw new Error('synthetic read failure'); })
        : phase === 'sync'
          ? t.mock.method(prototype, 'sync', async function (this: FileHandle) {
            if ((await this.stat()).isFile() && ++syncs === 2) throw new Error('synthetic fsync failure');
            return originalSync.call(this);
          })
          : t.mock.method(prototype, 'writeFile', async function (this: FileHandle,
            data: Parameters<FileHandle['writeFile']>[0], options?: Parameters<FileHandle['writeFile']>[1]) {
            if (phase === 'separator' && data === '\n') throw new Error('synthetic repair failure');
            if (phase === 'intent-before' && typeof data === 'string' && data.length > 1) throw new Error('synthetic interruption after repair');
            if (phase === 'intent' && typeof data === 'string' && data.length > 1) {
              await originalWrite.call(this, data.slice(0, 50));
              throw new Error('synthetic partial write');
            }
            return originalWrite.call(this, data, options);
          });
      const log = new AuditLog(path);
      let effects = 0;
      try {
        await assert.rejects(audited(log, { identity, action: 'runner.start', requestId: 'failed' }, async () => { effects++; }),
          err => err instanceof AuditWriteError && err.operationState === 'not-started');
        assert.equal(effects, 0);
      } finally { mock.mock.restore(); }
      const interrupted = await readFile(path, 'utf8');
      assert.ok(interrupted.startsWith(prior));
      await audited(log, { identity, action: 'runner.start', requestId: 'retry' }, async () => {
        assert.ok((await new AuditLog(path).tail()).some(row => row.requestId === 'retry' && row.outcome === 'pending'));
        effects++;
      });
      assert.equal(effects, 1);
      assert.ok((await readFile(path, 'utf8')).startsWith(interrupted));
      assert.equal((await log.tail())[0]!.requestId, 'retry');
    });
  }
});

test('concurrent intents after a torn line remain independently readable', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-torn-concurrent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'audit.jsonl');
  const prior = JSON.stringify(entry) + '\n{"torn":';
  await writeFile(path, prior);
  const log = new AuditLog(path);
  await Promise.all(Array.from({ length: 8 }, (_, i) => {
    const requestId = `concurrent-${i}`;
    return audited(log, { identity, action: 'runner.start', requestId }, async () => {
      assert.ok((await new AuditLog(path).tail()).some(row => row.requestId === requestId && row.outcome === 'pending'));
    });
  }));
  const raw = await readFile(path, 'utf8');
  assert.ok(raw.startsWith(prior + '\n'));
  const rows = raw.slice(prior.length + 1).trim().split('\n').map(line => JSON.parse(line) as AuditEntry);
  assert.equal(rows.filter(row => row.outcome === 'pending').length, 8);
  assert.equal(rows.filter(row => row.outcome === 'success').length, 8);
  assert.equal((await log.tail()).length, 9);
});
