import assert from 'node:assert/strict';
import fs, { type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AuditLog, AuditWriteError, audited } from '../src/audit.js';

const ctx = {
  identity: { sub: 'review', username: 'synthetic', email: null, name: null, groups: [] },
  action: 'runner.start', requestId: 'review',
};

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'crc-r2-independent-audit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const probe = await fs.open(join(dir, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const path = join(dir, 'new', 'nested', 'audit.jsonl');
  return { dir, path, prototype, log: new AuditLog(path) };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const phase of ['initial-ancestor', 'cached-intent', 'cached-outcome'] as const) {
  test(`R2 independent: blocked ${phase} fsync cannot release its caller`, { timeout: 5_000 }, async t => {
    const f = await fixture(t);
    if (phase !== 'initial-ancestor') await f.log.checkWritable();
    const entered = gate();
    const release = gate();
    const sync = f.prototype.sync;
    let directoryCalls = 0;
    const blockedCall = phase === 'initial-ancestor' ? 3 : phase === 'cached-intent' ? 2 : 3;
    const mock = t.mock.method(f.prototype, 'sync', async function (this: FileHandle) {
      if ((await this.stat()).isDirectory() && ++directoryCalls === blockedCall) {
        entered.resolve();
        await release.promise;
      }
      return sync.call(this);
    });
    let effects = 0;
    let settled = false;
    const operation = audited(f.log, ctx, async () => { effects++; return 'done'; });
    const result = operation.then(value => { settled = true; return value; });
    try {
      await entered.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(effects, phase === 'cached-outcome' ? 1 : 0);
      assert.equal(settled, false, 'directory durability is part of the awaited append');
    } finally {
      release.resolve();
      try { await result; } finally { mock.mock.restore(); }
    }
    assert.equal(await result, 'done');
    assert.equal(effects, 1);
    assert.equal((await new AuditLog(f.path).tail())[0]?.outcome, 'success');
  });
}

for (const level of [0, 1, 2]) {
  test(`R2 independent: directory open failure at level ${level} closes descriptors and retries ancestors`, { timeout: 5_000 }, async t => {
    const f = await fixture(t);
    const directories = [dirname(f.path), dirname(dirname(f.path)), f.dir];
    const originalOpen = fs.open;
    const opened: FileHandle[] = [];
    const visited: string[] = [];
    let injected = false;
    const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const [path, flags] = args;
      if (typeof flags === 'number' && (flags & constants.O_DIRECTORY) !== 0) {
        visited.push(String(path));
        if (!injected && path === directories[level]) {
          injected = true;
          throw Object.assign(new Error('synthetic directory open failure'), { code: 'EACCES' });
        }
      }
      const handle = await originalOpen(...args);
      opened.push(handle);
      return handle;
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    let effects = 0;
    await assert.rejects(audited(f.log, ctx, async () => { effects++; }),
      error => error instanceof AuditWriteError && error.operationState === 'not-started');
    assert.equal(injected, true);
    assert.equal(effects, 0);
    assert.ok(opened.every(handle => handle.fd === -1));
    visited.length = 0;
    await audited(f.log, { ...ctx, requestId: 'retry' }, async () => {
      assert.deepEqual(visited.slice(0, 3), directories);
      assert.ok(visited.includes('/'), 'initialization still reaches the filesystem root');
      effects++;
    });
    assert.equal(effects, 1);
    assert.ok(opened.every(handle => handle.fd === -1));
    assert.equal((await new AuditLog(f.path).tail())[0]?.requestId, 'retry');
  });
}
