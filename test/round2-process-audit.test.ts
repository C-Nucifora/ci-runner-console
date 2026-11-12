import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import ssh2 from 'ssh2';
import { AuditLog, AuditWriteError, audited, type AuditEntry } from '../src/audit.js';

const identity = { sub: 'round2', username: 'synthetic', email: null, name: null, groups: [] };
const ctx = { identity, action: 'runner.start', requestId: 'round2' };
const entry: AuditEntry = { at: '2026-01-01T00:00:00Z', actor: identity, action: 'runner.start',
  target: 'synthetic', params: {}, outcome: 'success', durationMs: 0, requestId: 'background' };

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'crc-round2-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const probe = await open(join(dir, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const path = join(dir, 'audit.jsonl');
  return { dir, path, prototype, log: new AuditLog(path) };
}

// A syscall-order test, not a claim to reproduce power loss on this host.
for (const nested of [false, true]) {
  test(`R2 new audit ${nested ? 'directory tree' : 'file'} is durably linked before dispatch`, async t => {
    const f = await fixture(t);
    const path = nested ? join(f.dir, 'new', 'nested', 'audit.jsonl') : f.path;
    const synced = new Set<number>();
    const sync = f.prototype.sync;
    t.mock.method(f.prototype, 'sync', async function (this: FileHandle) {
      await sync.call(this);
      synced.add((await this.stat()).ino);
    });
    let missing: number[] = [];
    await audited(new AuditLog(path), ctx, async () => {
      const required = nested ? [f.dir, join(f.dir, 'new'), dirname(path)] : [f.dir];
      missing = (await Promise.all(required.map(p => stat(p)))).map(info => info.ino).filter(ino => !synced.has(ino));
      assert.ok(synced.has((await stat(path)).ino), 'the pending file contents were synced');
    });
    assert.deepEqual(missing, [], `missing directory fsync before dispatch: ${missing.length} directory entries`);
  });
}

for (const location of ['containing', 'new-ancestor', 'existing-ancestor'] as const) {
  for (const phase of ['sync', 'close'] as const) {
    for (const reopen of [false, true]) {
      test(`R2 ${location} directory ${phase} failure recovers with ${reopen ? 'a reopened' : 'the same'} writer`, async t => {
        const f = await fixture(t);
        const directories = [join(f.dir, 'new', 'nested'), join(f.dir, 'new'), f.dir];
        const path = join(directories[0]!, 'audit.jsonl');
        const failedPath = directories[location === 'containing' ? 0 : location === 'new-ancestor' ? 1 : 2]!;
        let log = new AuditLog(path);
        let injected = false;
        let effects = 0;
        const handles = new Set<FileHandle>();
        const synced = new Set<number>();
        const sync = f.prototype.sync;
        t.mock.method(f.prototype, 'sync', async function (this: FileHandle) {
          handles.add(this);
          const info = await this.stat();
          if (info.isDirectory() && !injected && info.ino === (await stat(failedPath)).ino) {
            injected = true;
            const fail = () => { throw new Error('synthetic directory durability failure'); };
            if (phase === 'sync') fail();
            const close = this.close;
            t.mock.method(this, 'close', async function (this: FileHandle) {
              await close.call(this);
              fail();
            });
          }
          await sync.call(this);
          if (info.isDirectory()) synced.add(info.ino);
        });
        await assert.rejects(audited(log, ctx, async () => { effects++; }),
          err => err instanceof AuditWriteError && err.operationState === 'not-started');
        assert.equal(injected, true);
        assert.equal(effects, 0);
        assert.ok([...handles].every(handle => handle.fd === -1), 'failure closed file and directory descriptors');
        synced.clear();
        if (reopen) log = new AuditLog(path);
        await audited(log, { ...ctx, requestId: 'retry' }, async () => {
          const required = await Promise.all(directories.map(directory => stat(directory)));
          assert.ok(required.every(info => synced.has(info.ino)), 'retry synced the entire partially persisted tree');
          assert.equal((await new AuditLog(path).tail())[0]?.outcome, 'pending');
          effects++;
        });
        assert.equal(effects, 1);
        assert.equal((await log.tail())[0]?.outcome, 'success');
        assert.ok([...handles].every(handle => handle.fd === -1), 'retry closed all descriptors');
      });
    }
  }
}

test('R2 repeated appends and file recreation sync the file before its directory', async t => {
  const f = await fixture(t);
  await f.log.record(entry);
  const synced: string[] = [];
  const sync = f.prototype.sync;
  t.mock.method(f.prototype, 'sync', async function (this: FileHandle) {
    await sync.call(this);
    const info = await this.stat();
    if (info.isDirectory()) assert.equal(info.ino, (await stat(f.dir)).ino, 'durable ancestors stay cached');
    synced.push(info.isFile() ? 'file' : 'directory');
  });
  for (const recreate of [false, true]) {
    if (recreate) await rm(f.path);
    synced.length = 0;
    await f.log.record(entry);
    assert.deepEqual(synced, ['file', 'directory']);
    assert.equal((await f.log.tail())[0]?.outcome, 'success');
  }
});

for (const phase of ['intent', 'success', 'failure'] as const) {
  test(`R2 cached directory sync failure during ${phase} preserves operation state and retries`, async t => {
    const f = await fixture(t);
    await f.log.record(entry);
    const sync = f.prototype.sync;
    let directories = 0;
    const handles = new Set<FileHandle>();
    t.mock.method(f.prototype, 'sync', async function (this: FileHandle) {
      handles.add(this);
      if ((await this.stat()).isDirectory() && ++directories === (phase === 'intent' ? 2 : 3)) {
        throw new Error('synthetic cached directory sync failure');
      }
      await sync.call(this);
    });
    let effects = 0;
    await assert.rejects(audited(f.log, ctx, async () => {
      effects++;
      if (phase === 'failure') throw new Error('synthetic operation failure');
    }), err => err instanceof AuditWriteError && err.operationState ===
      (phase === 'intent' ? 'not-started' : phase === 'success' ? 'completed' : 'failed'));
    assert.equal(effects, phase === 'intent' ? 0 : 1);
    assert.ok([...handles].every(handle => handle.fd === -1));
    await audited(f.log, { ...ctx, requestId: 'retry' }, async () => { effects++; });
    assert.equal(effects, phase === 'intent' ? 1 : 2);
    assert.equal((await f.log.tail())[0]?.requestId, 'retry');
    assert.ok([...handles].every(handle => handle.fd === -1));
  });
}

test('R2 initial mkdir failure does not poison readiness or permit an effect on retry', async t => {
  const f = await fixture(t);
  const parent = join(f.dir, 'blocked');
  await writeFile(parent, 'synthetic obstruction');
  const log = new AuditLog(join(parent, 'audit.jsonl'));
  let effects = 0;
  await assert.rejects(audited(log, ctx, async () => { effects++; }),
    err => err instanceof AuditWriteError && err.operationState === 'not-started');
  assert.equal(effects, 0);
  await rm(parent);
  await audited(log, ctx, async () => { effects++; });
  assert.equal(effects, 1);
  assert.equal((await new AuditLog(join(parent, 'audit.jsonl')).tail())[0]?.outcome, 'success');
});

for (const phase of ['stat', 'chmod', 'preflight-sync', 'intent-sync', 'close'] as const) {
  test(`R2 first-file ${phase} failure closes handles and permits recovery`, async t => {
    const f = await fixture(t);
    const handles = new Set<FileHandle>();
    const originalStat = f.prototype.stat;
    const originalSync = f.prototype.sync;
    const originalChmod = f.prototype.chmod;
    let syncs = 0;
    let injected = false;
    const fail = () => { injected = true; throw Object.assign(new Error('synthetic storage failure'), { code: 'EIO' }); };
    t.mock.method(f.prototype, 'stat', async function (this: FileHandle) {
      handles.add(this);
      if (!injected && phase === 'close') {
        const close = this.close;
        t.mock.method(this, 'close', async function (this: FileHandle) {
          // Linux close may report a delayed write error after releasing the descriptor.
          await close.call(this);
          return fail();
        });
      }
      if (!injected && phase === 'stat') return fail();
      return originalStat.call(this);
    });
    t.mock.method(f.prototype, 'chmod', async function (this: FileHandle, mode: number) {
      if (!injected && phase === 'chmod') return fail();
      return originalChmod.call(this, mode);
    });
    t.mock.method(f.prototype, 'sync', async function (this: FileHandle) {
      if ((await originalStat.call(this)).isFile()) {
        syncs++;
        if (!injected && ((phase === 'preflight-sync' && syncs === 1) || (phase === 'intent-sync' && syncs === 2))) return fail();
      }
      return originalSync.call(this);
    });
    let effects = 0;
    await assert.rejects(audited(f.log, ctx, async () => { effects++; }),
      err => err instanceof AuditWriteError && err.operationState === 'not-started');
    assert.equal(injected, true);
    assert.equal(effects, 0);
    assert.ok([...handles].every(handle => handle.fd === -1), 'failed append closed its descriptor');
    await audited(f.log, { ...ctx, requestId: 'retry' }, async () => { effects++; });
    assert.equal(effects, 1);
    assert.equal((await new AuditLog(f.path).tail())[0]?.requestId, 'retry');
    assert.ok([...handles].every(handle => handle.fd === -1), 'recovery closed its descriptors');
  });
}

for (const outcome of ['success', 'failure'] as const) {
  test(`R2 backlog pressure during an active ${outcome} preserves intent and recovers`, { timeout: 5_000 }, async t => {
    const f = await fixture(t);
    const active = gate();
    const finish = gate();
    const blocked = gate();
    const release = gate();
    const failure = new Error('synthetic action failure');
    const operation = audited(f.log, ctx, async () => {
      active.resolve();
      await finish.promise;
      if (outcome === 'failure') throw failure;
    });
    const result = operation.then(() => null, error => error as unknown);
    await active.promise;
    const originalSync = f.prototype.sync;
    let hold = true;
    const mock = t.mock.method(f.prototype, 'sync', async function (this: FileHandle) {
      if (hold) { hold = false; blocked.resolve(); await release.promise; }
      return originalSync.call(this);
    });
    const backlog = Array.from({ length: 64 }, (_, i) => f.log.record({ ...entry, requestId: `queued-${i}` }));
    const drained = Promise.allSettled(backlog);
    try {
      await blocked.promise;
      let forbidden = false;
      await assert.rejects(audited(f.log, { ...ctx, requestId: 'rejected' }, async () => { forbidden = true; }),
        err => err instanceof AuditWriteError && err.operationState === 'not-started');
      assert.equal(forbidden, false);
      finish.resolve();
      const error = await result;
      assert.ok(error instanceof AuditWriteError);
      assert.equal(error.operationState, outcome === 'success' ? 'completed' : 'failed');
      assert.equal((await new AuditLog(f.path).tail()).find(row => row.requestId === ctx.requestId)?.outcome, 'pending');
    } finally {
      finish.resolve(); release.resolve();
      await result;
      await drained;
      mock.mock.restore();
    }
    assert.ok((await drained).every(row => row.status === 'fulfilled'));
    await audited(f.log, { ...ctx, requestId: 'recovered' }, async () => {});
    const recovered = await new AuditLog(f.path).tail();
    assert.equal(recovered[0]?.outcome, 'success');
    assert.equal(recovered.find(row => row.requestId === ctx.requestId)?.outcome, 'pending');
  });
}

test('R2 actual wall-clock rollback across intent and outcome keeps append order after reopen', async t => {
  const f = await fixture(t);
  const RealDate = Date;
  let now = RealDate.parse('2026-11-12T00:00:00Z');
  class ClockDate extends RealDate {
    constructor(value?: string | number) { super(value ?? now); }
    static override now() { return now; }
  }
  globalThis.Date = ClockDate as DateConstructor;
  t.after(() => { globalThis.Date = RealDate; });
  const originalRecord = f.log.record.bind(f.log);
  f.log.record = async value => {
    if (value.outcome === 'pending') now -= 3_600_000;
    return originalRecord(value);
  };
  for (const outcome of ['success', 'failure'] as const) {
    const failure = new Error('synthetic failure');
    const operation = audited(f.log, { ...ctx, requestId: outcome }, async () => {
      now -= 3_600_000;
      if (outcome === 'failure') throw failure;
    });
    if (outcome === 'failure') await assert.rejects(operation, err => err === failure);
    else await operation;
  }
  const raw = (await readFile(f.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as AuditEntry);
  assert.ok(raw[1]!.at < raw[0]!.at && raw[3]!.at < raw[2]!.at, 'ISO timestamps also moved backward');
  assert.deepEqual(raw.map(row => row.durationMs), [0, 0, 0, 0]);
  assert.deepEqual((await new AuditLog(f.path).tail()).map(row => [row.requestId, row.outcome]),
    [['failure', 'failure'], ['success', 'success']]);
});

type Phase = 'intent-sync' | 'mutation' | 'outcome-before' | 'outcome-sync' | 'outcome-torn';
type Stop = 'drain' | 'deadline' | 'kill';

async function marker(path: string, check: () => void = () => {}) {
  for (let i = 0; i < 400; i++) {
    check();
    try { return await readFile(path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`fixture did not reach ${path}`);
}

async function processFixture(t: TestContext, phase: Phase, stop: Stop) {
  const dir = await mkdtemp(join(tmpdir(), 'crc-round2-process-'));
  const children: Array<{ child: ReturnType<typeof spawn>; exit: Promise<unknown> }> = [];
  t.after(async () => {
    for (const { child, exit } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exit;
    }
    await rm(dir, { recursive: true, force: true });
  });
  await cp(new URL('../src/', import.meta.url), join(dir, 'dist'), { recursive: true });
  await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'));
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await mkdir(join(dir, 'web/dist/assets'), { recursive: true });
  await writeFile(join(dir, 'web/dist/index.html'), '<html>synthetic</html>');
  // ssh2 strips leading zero bytes from generated Ed25519 public keys.
  const keys = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 });
  await writeFile(join(dir, 'key'), keys.private, { mode: 0o600 });
  await writeFile(join(dir, 'synthetic.mjs'), `
    import { OidcClient } from './dist/auth/oidc.js';
    import { RepoRunnerRegistry } from './dist/github/registry.js';
    import { RunnerVmControl } from './dist/vm/ctl.js';
    import { readFile, writeFile, open } from 'node:fs/promises';
    import { writeFileSync } from 'node:fs';
    import { Server } from 'node:http';
    globalThis.fetch = async () => { throw new Error('unexpected external request'); };
    const phase = process.env.FIXTURE_PHASE;
    const emit = Server.prototype.emit;
    Server.prototype.emit = function(event, ...args) {
      if (event === 'request' && args[0].url === '/api/runners') {
        args[0].socket.once('close', () => writeFileSync('request-disconnected', 'yes'));
      }
      return emit.call(this, event, ...args);
    };
    process.on('removeListener', event => {
      if (event === 'SIGTERM') writeFileSync('shutdown-cleared', 'yes');
    });
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => {
      if (ms === 300000) {
        writeFileSync('shutdown-armed', 'yes');
        if (process.env.FIXTURE_STOP === 'deadline') ms = 150;
      }
      return realTimeout(fn, ms, ...args);
    };
    async function hold() {
      await writeFile('held', phase);
      while (true) {
        try { await readFile('release'); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await new Promise(resolve => realTimeout(resolve, 10));
      }
    }
    const probe = await open('probe', 'w');
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const write = prototype.writeFile;
    const sync = prototype.sync;
    const content = new WeakMap();
    prototype.writeFile = async function(data, options) {
      if (typeof data === 'string' && data.startsWith('{')) {
        const row = JSON.parse(data);
        content.set(this, row.outcome);
        if (row.outcome === 'success' && phase === 'outcome-before') await hold();
        if (row.outcome === 'success' && phase === 'outcome-torn') {
          await write.call(this, data.slice(0, 50));
          await hold();
          return write.call(this, data.slice(50), options);
        }
      }
      return write.call(this, data, options);
    };
    prototype.sync = async function() {
      if ((phase === 'intent-sync' && content.get(this) === 'pending') ||
          (phase === 'outcome-sync' && content.get(this) === 'success')) await hold();
      return sync.call(this);
    };
    const locals = async () => {
      try { return JSON.parse(await readFile('instances.json', 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    };
    OidcClient.prototype.beginLogin = async () => ({ url: 'https://oidc.example.invalid/authorize', verifier: 'synthetic', nonce: 'synthetic' });
    OidcClient.prototype.completeLogin = async () => ({ sub: 'round2', username: 'synthetic', email: null, name: null, groups: [] });
    RepoRunnerRegistry.prototype.listRunners = async () => (await locals()).map((row, i) => ({ id: i + 1, name: row.name, os: 'linux', status: 'online', busy: false, labels: [] }));
    RepoRunnerRegistry.prototype.createRegistrationToken = async () => ({ token: 'synthetic_token_123', expiresAt: '' });
    RunnerVmControl.prototype.list = locals;
    RunnerVmControl.prototype.headroom = async () => ({ cap: 3, instances: (await locals()).length, remaining: 3 - (await locals()).length,
      cpus: 4, load: { one: 0, five: 0, fifteen: 0 }, memory: { totalBytes: 100, availableBytes: 100 }, disk: { totalBytes: 100, freeBytes: 100 } });
    RunnerVmControl.prototype.create = async ({ name }) => {
      const row = { name, dir: '/synthetic/' + name, unit: 'actions.runner.synthetic.service', registered: true,
        serviceInstalled: true, active: 'active', enabled: 'enabled', subState: 'running', activeSince: null, legacy: false };
      await writeFile('instances.json', JSON.stringify([...(await locals()), row]));
      if (phase === 'mutation') await hold();
      return row;
    };
  `);
  const path = join(dir, 'audit.jsonl');
  async function start(restart = false) {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    assert.ok(address && typeof address === 'object');
    await new Promise<void>((resolve, reject) => reservation.close(err => err ? reject(err) : resolve()));
    const base = `http://127.0.0.1:${address.port}`;
    const child = spawn(process.execPath, ['--import', join(dir, 'synthetic.mjs'), join(dir, 'dist/index.js')], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: {
        PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: '--max-old-space-size=512', HOST: '127.0.0.1', PORT: String(address.port),
        PUBLIC_BASE_URL: base, SESSION_SECRET: 'synthetic-round2-session-secret-32-characters',
        OIDC_ISSUER: 'http://127.0.0.1:1/never', OIDC_CLIENT_ID: 'synthetic', OIDC_CLIENT_SECRET: 'synthetic',
        GITHUB_API_BASE_URL: 'http://127.0.0.1:1', GITHUB_TOKEN: 'synthetic', GITHUB_OWNER: 'example', GITHUB_REPO: 'synthetic',
        RUNNER_VM_HOST: '127.0.0.1', RUNNER_VM_PORT: '1', RUNNER_VM_KEY_PATH: join(dir, 'key'), RUNNER_VM_HOST_KEY: keys.public,
        AUDIT_LOG_PATH: path, FIXTURE_PHASE: restart ? '' : phase, FIXTURE_STOP: stop,
      },
    });
    const exit = once(child, 'close');
    children.push({ child, exit });
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk; });
    child.stderr!.on('data', chunk => { output += chunk; });
    const check = () => assert.ok(child.exitCode === null && child.signalCode === null, output);
    let ready = false;
    for (let i = 0; i < 200; i++) {
      check();
      try {
        const response = await fetch(base + '/healthz', { signal: AbortSignal.timeout(500) });
        assert.equal(response.status, 200);
        await response.arrayBuffer(); ready = true; break;
      } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.equal(ready, true, output);
    const login = await fetch(base + '/auth/login', { redirect: 'manual' });
    const state = new URL(login.headers.get('location')!).searchParams.get('state');
    const bound = login.headers.get('set-cookie')!.split(';')[0]!;
    await login.arrayBuffer();
    const callback = await fetch(base + '/auth/callback?code=synthetic&state=' + state,
      { redirect: 'manual', headers: { cookie: bound } });
    assert.equal(callback.status, 302);
    const session = callback.headers.getSetCookie().find(value => value.startsWith('crc_session='))!.split(';')[0]!;
    await callback.arrayBuffer();
    const headers = { cookie: session, origin: base, 'content-type': 'application/json' };
    const create = (name: string, signal: AbortSignal = AbortSignal.timeout(5_000)) => fetch(base + '/api/runners', {
      method: 'POST', headers, body: JSON.stringify({ name }), signal,
    });
    return { child, exit, check, create, base, headers, output: () => output };
  }
  return { dir, path, start };
}

for (const phase of ['mutation', 'outcome-before'] as const) {
  test(`R2 shutdown deadline still bounds disconnected ${phase}`, { timeout: 10_000 }, async t => {
    const f = await processFixture(t, phase, 'deadline');
    const server = await f.start();
    // An unpooled client cannot open a replacement socket when this one is destroyed.
    const request = httpRequest(server.base + '/api/runners', {
      method: 'POST', headers: { ...server.headers, connection: 'close' }, agent: false,
    });
    const response = new Promise<void>((resolve, reject) => {
      request.once('error', () => resolve());
      request.once('response', reply => { reply.resume(); reject(new Error('held request unexpectedly completed')); });
    });
    t.after(() => { request.destroy(); });
    request.end(JSON.stringify({ name: 'interrupted' }));
    await marker(join(f.dir, 'held'), server.check);
    request.destroy(new Error('synthetic client disconnect'));
    await response;
    await marker(join(f.dir, 'request-disconnected'), server.check);
    server.child.kill('SIGTERM');
    await marker(join(f.dir, 'shutdown-armed'));
    const expired = gate();
    const timer = setTimeout(expired.resolve, 750);
    const exit = await Promise.race([server.exit, expired.promise.then(() => null)]);
    clearTimeout(timer);
    if (exit === null) {
      assert.equal(await readFile(join(f.dir, 'shutdown-cleared'), 'utf8'), 'yes');
      assert.equal((await new AuditLog(f.path).tail())[0]?.outcome, 'pending');
    }
    assert.notEqual(exit, null, 'closing HTTP sockets cleared the 150 ms fixture deadline while the mutation/audit write remained in flight');
    assert.deepEqual(exit, [1, null]);
  });
}

for (const [phase, stop] of [
  ['intent-sync', 'drain'], ['outcome-before', 'drain'], ['outcome-sync', 'drain'],
  ['intent-sync', 'deadline'], ['mutation', 'deadline'], ['outcome-torn', 'kill'], ['outcome-sync', 'kill'],
] as const) {
  test(`R2 process ${stop} at ${phase} preserves restart evidence`, { timeout: 15_000 }, async t => {
    const f = await processFixture(t, phase, stop);
    const first = await f.start();
    const response = first.create('interrupted').then(async reply => ({ status: reply.status, body: await reply.text() }), error => ({ error }));
    await marker(join(f.dir, 'held'), first.check);
    const before = await new AuditLog(f.path).tail();
    assert.equal(before[0]?.outcome, phase === 'outcome-sync' ? 'success' : 'pending');
    if (stop === 'kill') first.child.kill('SIGKILL');
    else {
      first.child.kill('SIGTERM');
      await marker(join(f.dir, 'shutdown-armed'));
      if (stop === 'drain') {
        first.child.kill('SIGINT');
        first.check();
        await writeFile(join(f.dir, 'release'), 'yes');
      }
    }
    const [code, signal] = await first.exit;
    const reply = await response;
    if (stop === 'drain') {
      assert.equal(code, 0, first.output());
      assert.equal(signal, null);
      assert.ok('status' in reply && reply.status === 200, JSON.stringify(reply));
    } else {
      assert.equal(code, stop === 'kill' ? null : 1, first.output());
      assert.equal(signal, stop === 'kill' ? 'SIGKILL' : null);
      assert.ok('error' in reply, 'interrupted HTTP response must not claim completion');
    }
    const expected = stop === 'drain' || phase === 'outcome-sync' ? 'success' : 'pending';
    assert.equal((await new AuditLog(f.path).tail())[0]?.outcome, expected);
    const restarted = await f.start(true);
    const history = await fetch(restarted.base + '/api/audit', { headers: restarted.headers });
    assert.equal(history.status, 200);
    assert.equal((await history.json() as { entries: AuditEntry[] }).entries[0]?.outcome, expected);
    const retry = await restarted.create('after-restart');
    assert.equal(retry.status, 200, await retry.text());
    const final = await new AuditLog(f.path).tail();
    assert.deepEqual(final.map(row => [row.target, row.outcome]), [['after-restart', 'success'], ['interrupted', expected]]);
    const instances = JSON.parse(await readFile(join(f.dir, 'instances.json'), 'utf8')) as Array<{ name: string }>;
    assert.deepEqual(instances.map(row => row.name), phase === 'intent-sync' && stop !== 'drain'
      ? ['after-restart'] : ['interrupted', 'after-restart']);
    restarted.child.kill('SIGTERM');
    assert.deepEqual(await restarted.exit, [0, null]);
    await assert.rejects(fetch(restarted.base + '/healthz', { signal: AbortSignal.timeout(500) }), 'owned listener was closed');
  });
}
