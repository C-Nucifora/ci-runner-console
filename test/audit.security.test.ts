import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
