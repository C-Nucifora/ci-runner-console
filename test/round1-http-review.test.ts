import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type RequestListener } from 'node:http';
import { appendFile, mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { boundedFetch } from '../src/http.js';
import { OidcClient } from '../src/auth/oidc.js';
import { runHealthChecks } from '../src/health.js';
import { AuditLog, audited, type AuditEntry } from '../src/audit.js';
import type { Config } from '../src/config.js';
import type { RunnerRegistry } from '../src/github/registry.js';
import type { RunnerVmControl } from '../src/vm/ctl.js';

const identity = { sub: 'review', username: 'review', email: null, name: null, groups: [] };
const entry: AuditEntry = {
  at: '2026-11-12T10:00:00+10:00', actor: { sub: 'review', username: 'review', email: null },
  action: 'runner.stop', target: 'synthetic', params: {}, outcome: 'pending',
  operationId: 'review-operation', durationMs: 0, requestId: 'review',
};

async function serverFixture(t: TestContext, listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    server.closeAllConnections();
    await closed;
    assert.equal(server.address(), null);
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function auditFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'round1-http-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'audit.jsonl');
  return { path, log: new AuditLog(path), observer: new AuditLog(path) };
}

test('review: compressed wire length cannot bypass the decoded response ceiling', { timeout: 5_000 }, async t => {
  const limit = 2 * 1024 * 1024;
  const url = await serverFixture(t, (req, res) => {
    const encoded = gzipSync(Buffer.alloc(req.url === '/over' ? limit + 1 : limit, 0x78));
    assert.ok(encoded.length < 4096, 'fixture remains small on the wire');
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': encoded.length });
    res.end(encoded);
  });
  assert.equal((await (await boundedFetch(url)).arrayBuffer()).byteLength, limit);
  await assert.rejects(boundedFetch(`${url}/over`), /size limit/);
});

test('review: HEAD and bodyless HTTP statuses survive response reconstruction', { timeout: 5_000 }, async t => {
  const url = await serverFixture(t, (req, res) => {
    res.writeHead(req.method === 'HEAD' ? 200 : Number(req.url!.slice(1)), { 'x-review': 'preserved' });
    res.end();
  });
  for (const [path, method, status] of [['/', 'HEAD', 200], ['/204', 'GET', 204], ['/304', 'GET', 304]] as const) {
    const response = await boundedFetch(url + path, { method });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('x-review'), 'preserved');
    assert.equal(response.body, null);
  }
});

test('review: caller abort before dispatch and after headers rejects without poisoning the next request', { timeout: 5_000 }, async t => {
  let requests = 0;
  const url = await serverFixture(t, (req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/stalled') res.write('{');
    else res.end('{"ok":true}');
  });
  const before = new AbortController();
  before.abort();
  await assert.rejects(boundedFetch(url, { signal: before.signal }));
  assert.equal(requests, 0);
  const during = new AbortController();
  const nativeFetch = globalThis.fetch;
  const mock = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await nativeFetch(input, init);
    during.abort();
    return response;
  });
  try {
    await assert.rejects(boundedFetch(`${url}/stalled`, { signal: during.signal }));
    assert.equal(requests, 1);
  } finally { mock.mock.restore(); }
  assert.deepEqual(await (await boundedFetch(url)).json(), { ok: true });
});

test('review: rejected stream cancellation still releases the reader', async t => {
  let response: Response | undefined;
  let cancellations = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel() { cancellations++; throw new Error('synthetic cancellation failure'); },
    }));
    return response;
  });
  await assert.rejects(boundedFetch('http://127.0.0.1'));
  assert.equal(cancellations, 1);
  assert.equal(response!.body!.locked, false);
});

test('review: success-shaped HTTP error bodies cannot authenticate or produce healthy checks', { timeout: 5_000 }, async t => {
  let issuer = '';
  let jwksRequests = 0;
  let runnerLists = 0;
  const marker = 'synthetic-upstream-secret';
  issuer = await serverFixture(t, (req, res) => {
    let status = 200;
    let body: unknown;
    if (req.url === '/.well-known/openid-configuration') {
      body = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` };
    } else if (req.url === '/token') {
      status = 401; body = { id_token: marker };
    } else if (req.url === '/jwks') {
      jwksRequests++; status = 503; body = { keys: [{ kid: marker }] };
    } else {
      status = 403; body = { message: marker, resources: { core: { remaining: 1, limit: 1, reset: 0 } } };
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const client = new OidcClient({ issuer, clientId: 'review', clientSecret: 'synthetic-only', allowedGroups: [] }, `${issuer}/callback`);
  await assert.rejects(client.completeLogin('synthetic', 'synthetic', 'synthetic'), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes(marker), false);
    return true;
  });
  assert.equal(jwksRequests, 0, 'a rejected token response must not trigger key retrieval');
  const checks = await runHealthChecks({
    config: { github: { apiBaseUrl: issuer }, oidc: { issuer, clientId: 'review', allowedGroups: [] },
      vm: { user: 'review', host: '127.0.0.1', port: 1, hostKey: 'synthetic' } } as unknown as Config,
    credential: { getToken: async () => 'synthetic-only', describe: () => 'synthetic' },
    registry: { describe: () => 'synthetic', listRunners: async () => { runnerLists++; return []; } } as unknown as RunnerRegistry,
    control: { headroom: async () => { throw new Error(marker); } } as unknown as RunnerVmControl,
  });
  assert.deepEqual(checks.map(check => check.ok), [false, false, false]);
  assert.match(checks[0]!.detail, /HTTP 403/);
  assert.equal(runnerLists, 0);
  assert.equal(jwksRequests, 1);
  assert.equal(JSON.stringify(checks).includes(marker), false);
});

test('review: independent audit reader withholds a split UTF-8 outcome until its newline', async t => {
  const f = await auditFixture(t);
  const { operationId: _operationId, ...legacy } = entry;
  const historical = { ...legacy, outcome: 'success', params: { labels: ['linux'], credential: 'synthetic-secret' }, error: 'synthetic-secret' };
  await writeFile(f.path, `${JSON.stringify(historical)}\n${JSON.stringify(entry)}\n`);
  const outcome = Buffer.from(JSON.stringify({ ...entry, outcome: 'success', requestId: 'réview', durationMs: 1 }));
  const split = outcome.indexOf(Buffer.from('é')) + 1;
  await appendFile(f.path, outcome.subarray(0, split));
  assert.deepEqual((await f.observer.tail()).map(row => row.outcome), ['pending', 'success']);
  await appendFile(f.path, outcome.subarray(split));
  assert.deepEqual((await f.observer.tail()).map(row => row.outcome), ['pending', 'success']);
  await appendFile(f.path, '\n');
  await appendFile(f.path, `${JSON.stringify({ ...entry, actor: null, outcome: 'failure' })}\n`);
  const rows = await f.observer.tail();
  assert.deepEqual(rows.map(row => row.outcome), ['success', 'success']);
  assert.equal(rows[0]!.requestId, 'réview');
  assert.equal(rows[1]!.operationId, undefined);
  assert.equal(rows[1]!.at, historical.at);
  assert.deepEqual(rows[1]!.params, { labels: ['linux'], credential: '[redacted]' });
  assert.equal(JSON.stringify(rows).includes('synthetic-secret'), false);
});

test('review: a blocked fsync prevents effects while preserving torn non-UTF-8 bytes', { timeout: 5_000 }, async t => {
  const f = await auditFixture(t);
  const prior = Buffer.from([0x7b, 0x22, 0xff, 0xc3]);
  await writeFile(f.path, prior);
  const handle = await open(f.path, 'r');
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  const originalSync = prototype.sync;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let syncs = 0;
  let effects = 0;
  const mock = t.mock.method(prototype, 'sync', async function (this: FileHandle) {
    if ((await this.stat()).isFile() && ++syncs === 2) { entered(); await gate; }
    return originalSync.call(this);
  });
  const operation = audited(f.log, { identity, action: 'runner.stop', requestId: 'blocked-sync' }, async () => {
    effects++;
    assert.equal((await f.observer.tail())[0]!.outcome, 'pending');
  });
  try {
    await waiting;
    assert.equal(effects, 0);
    const raw = await readFile(f.path);
    assert.deepEqual(raw.subarray(0, prior.length + 1), Buffer.concat([prior, Buffer.from('\n')]));
    assert.equal((await f.observer.tail())[0]!.outcome, 'pending');
  } finally {
    release();
    try { await operation; } finally { mock.mock.restore(); }
  }
  assert.equal(effects, 1);
  assert.equal((await f.observer.tail())[0]!.outcome, 'success');
});

test('review: a backward wall-clock adjustment cannot hide completed audit outcomes', async t => {
  for (const outcome of ['success', 'failure'] as const) {
    await t.test(outcome, async t => {
      const f = await auditFixture(t);
      let now = 1000;
      t.mock.method(Date, 'now', () => now);
      const failure = new Error('synthetic operation failure');
      const operation = audited(f.log, { identity, action: 'runner.stop', requestId: outcome }, async () => {
        now -= 250;
        if (outcome === 'failure') throw failure;
        return 'completed';
      });
      if (outcome === 'failure') await assert.rejects(operation, error => error === failure);
      else assert.equal(await operation, 'completed');
      const stored = (await readFile(f.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as AuditEntry);
      assert.equal(stored[1]!.outcome, outcome, 'the outcome append itself succeeded');
      t.diagnostic(`stored duration=${stored[1]!.durationMs}; reader outcome=${(await f.observer.tail())[0]!.outcome}`);
      assert.equal((await f.observer.tail())[0]!.outcome, outcome, 'a clock correction must not turn a known outcome into an unresolved intent');
      assert.ok(stored[1]!.durationMs >= 0);
    });
  }
});
