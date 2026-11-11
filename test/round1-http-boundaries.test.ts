import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { OidcClient } from '../src/auth/oidc.js';
import { LoginStateStore, SessionStore } from '../src/auth/session.js';
import { AuditLog, AuditWriteError, audited, type AuditEntry } from '../src/audit.js';
import { registerAuthRoutes } from '../src/routes/auth.js';
import { registerApiRoutes } from '../src/routes/api.js';
import { RunnerVmControl } from '../src/vm/ctl.js';
import type { RunnerVm } from '../src/vm/ssh.js';
import type { RunnerRegistry } from '../src/github/registry.js';
import type { Config } from '../src/config.js';
import { runHealthChecks } from '../src/health.js';
import { boundedFetch } from '../src/http.js';

// Run only this file, serially, under the shared heavy.lock. All providers are synthetic.
const identity = { sub: 'round1', username: 'round1', email: null, name: null, groups: ['operators'] };
const config = { publicBaseUrl: 'http://127.0.0.1', sessionTtlSeconds: 60,
  runners: { cap: 3, defaultLabels: [], protectedNames: [] } } as unknown as Config;
const entry: AuditEntry = { at: '2026-11-12T00:00:00Z',
  actor: { sub: identity.sub, username: identity.username, email: identity.email }, action: 'runner.stop',
  target: 'synthetic', params: {}, outcome: 'success', durationMs: 1, requestId: 'round1',
  operationId: '8eec12f4-2509-4324-a379-217d1a1cc71e' };

async function provider(t: TestContext) {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'round1', alg: 'ES256', use: 'sig' };
  const state = { path: '', mode: 'normal', unexpected: 0, exchanges: 0,
    patch: {} as Record<string, unknown>, bytes: 0, stalls: 0 };
  let issuer = '';
  const server = createServer((req, res) => {
    void respond(req.url!, res).catch(() => res.destroy());
  });
  async function respond(path: string, res: ServerResponse) {
    if (path === '/unexpected') state.unexpected++;
    if (path === '/token') state.exchanges++;
    if (path === state.path && state.mode === 'redirect') {
      res.writeHead(302, { location: issuer + '/unexpected' }); res.end(); return;
    }
    if (path === state.path && state.mode === 'partial') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{"partial":');
      setImmediate(() => res.destroy()); return;
    }
    if (path === state.path && state.mode.startsWith('stalled-')) {
      state.stalls++;
      if (state.mode === 'stalled-body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
      }
      return;
    }
    let value: Record<string, unknown>;
    if (path === '/.well-known/openid-configuration') {
      value = { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks' };
    } else if (path === '/jwks') {
      value = { keys: [jwk] };
    } else if (path === '/token') {
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ iss: issuer, aud: 'console', sub: identity.sub, iat: now,
        exp: now + 60, nonce: 'nonce', groups: identity.groups, ...state.patch })
        .setProtectedHeader({ alg: 'ES256', kid: 'round1' }).sign(privateKey);
      value = { id_token: token };
    } else { res.writeHead(404); res.end(); return; }
    // A finite 2 MiB padding field probes the same ceiling already used for GitHub.
    if (path === state.path && state.mode.endsWith('oversized')) value.padding = 'x'.repeat(2 * 1024 * 1024);
    const body = JSON.stringify(value);
    if (path === state.path) state.bytes = Buffer.byteLength(body);
    res.writeHead(200, { 'content-type': 'application/json',
      ...(path === '/token' || state.mode === 'chunked-oversized' ? {} : { 'content-length': Buffer.byteLength(body) }) });
    if (path === '/token' || state.mode === 'chunked-oversized') {
      res.write(body.slice(0, 64));
      res.end(body.slice(64));
    } else res.end(body);
  }
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    server.closeAllConnections(); await closed; assert.equal(server.address(), null);
  });
  const client = () => new OidcClient({ issuer, clientId: 'console', clientSecret: 'synthetic-only', allowedGroups: ['operators'] },
    'http://127.0.0.1/auth/callback');
  return { state, client, issuer };
}

async function appFixture(t: TestContext, oidc?: OidcClient, control?: RunnerVmControl) {
  const dir = await mkdtemp(join(tmpdir(), 'round1-http-'));
  const path = join(dir, 'audit.jsonl');
  const audit = new AuditLog(path);
  const sessions = new SessionStore('round1-synthetic-secret'.repeat(3), 60);
  const session = sessions.create(identity);
  const loginStates = new LoginStateStore();
  const registry = { listRunners: async () => [], describe: () => 'synthetic',
    registrationUrl: () => 'https://example.invalid/synthetic' } as unknown as RunnerRegistry;
  const app = Fastify();
  await app.register(cookie);
  registerApiRoutes(app, { config, sessions, registry, control: control ?? {} as RunnerVmControl, audit,
    credential: { getToken: async () => 'synthetic-only', describe: () => 'synthetic' } });
  if (oidc) registerAuthRoutes(app, { config, sessions, loginStates, oidc });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const readAudit = () => app.inject({ url: '/api/audit', headers: { cookie: `crc_session=${session}` } });
  return { app, audit, path, session, sessions, loginStates, readAudit };
}

test('R1 provider response byte bounds, redirects and interrupted bodies', { timeout: 25_000 }, async t => {
  const f = await provider(t);
  for (const path of ['/.well-known/openid-configuration', '/token', '/jwks']) {
    for (const mode of ['redirect', 'partial', 'oversized', 'chunked-oversized']) {
      await t.test(`${path} ${mode}`, async () => {
        Object.assign(f.state, { path, mode, unexpected: 0, bytes: 0 });
        const result = await f.client().completeLogin('synthetic-code', 'verifier', 'nonce')
          .then(value => ({ accepted: true, value }), error => ({ accepted: false, error }));
        if (mode.endsWith('oversized')) {
          assert.ok(f.state.bytes > 2 * 1024 * 1024);
          t.diagnostic(`${path}: ${f.state.bytes} bytes, login accepted=${result.accepted}`);
        }
        assert.equal(f.state.unexpected, 0, 'provider redirects must not be followed');
        assert.equal(result.accepted, false, `${path} ${mode} must reject before creating an identity`);
      });
    }
  }
});

test('R1 OIDC health bounds discovery and JWKS bodies', { timeout: 20_000 }, async t => {
  const f = await provider(t);
  const deps = {
    config: { oidc: { issuer: f.issuer, clientId: 'console', allowedGroups: [] },
      vm: { user: 'synthetic', host: '127.0.0.1', port: 1, hostKey: 'synthetic' } } as unknown as Config,
    credential: { getToken: async () => { throw new Error('synthetic unavailable'); }, describe: () => 'synthetic' },
    registry: { describe: () => 'synthetic' } as RunnerRegistry,
    control: { headroom: async () => { throw new Error('synthetic unavailable'); } } as unknown as RunnerVmControl,
  };
  for (const path of ['/.well-known/openid-configuration', '/jwks']) {
    for (const mode of ['normal', 'redirect', 'partial', 'oversized', 'chunked-oversized']) {
      await t.test(`${path} ${mode}`, async () => {
        Object.assign(f.state, { path, mode, unexpected: 0 });
        const checks = await runHealthChecks(deps);
        assert.equal(checks[2]!.ok, mode === 'normal');
        assert.equal(f.state.unexpected, 0);
        assert.equal(JSON.stringify(checks).includes('padding'), false);
      });
    }
  }
});

test('R1 response limit counts bytes and cancels unfinished oversized streams', async t => {
  const limit = 2 * 1024 * 1024;
  let bodySize = limit;
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bodySize));
      if (bodySize === limit) controller.close();
    },
    cancel() { cancelled = true; },
  })));
  for (const size of [limit, limit + 1]) {
    bodySize = size;
    cancelled = false;
    if (size === limit) {
      assert.equal((await (await boundedFetch('http://127.0.0.1')).arrayBuffer()).byteLength, limit);
    } else {
      await assert.rejects(boundedFetch('http://127.0.0.1'), /size limit/);
      assert.equal(cancelled, true);
    }
  }
});

test('R1 every OIDC login response retains header and body deadlines', { timeout: 10_000 }, async t => {
  const f = await provider(t);
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    deadlines.push(ms);
    return timeout(100);
  });
  for (const path of ['/.well-known/openid-configuration', '/token', '/jwks']) {
    for (const mode of ['stalled-headers', 'stalled-body']) {
      await t.test(`${path} ${mode}`, async () => {
        Object.assign(f.state, { path, mode, stalls: 0 });
        await assert.rejects(f.client().completeLogin('synthetic', 'verifier', 'nonce'));
        assert.equal(f.state.stalls, 1, 'the intended endpoint must be reached before its deadline');
      });
    }
  }
  assert.ok(deadlines.includes(10_000));
  assert.ok(deadlines.includes(5_000), 'the earlier JOSE JWKS deadline must still apply');
});

test('R1 audit malformed rows cannot break or replace valid API history', { timeout: 10_000 }, async t => {
  const f = await appFixture(t);
  const invalidRows = [null, {}, [], false, { operationId: entry.operationId, outcome: 'success' },
    ...[{ actor: null }, { actor: { ...entry.actor, sub: [] } }, { action: [] }, { target: {} },
      { params: null }, { params: [] }, { outcome: 'unknown' }, { durationMs: -1 }, { durationMs: '1' },
      { at: 'invalid' }, { requestId: {} }, { operationId: {} }, { error: {} }]
      .map(patch => ({ ...entry, ...patch }))];
  for (const row of invalidRows) {
    await t.test(JSON.stringify(row), async () => {
      await writeFile(f.path, JSON.stringify(entry) + '\n' + JSON.stringify(row) + '\n');
      const response = await f.readAudit();
      t.diagnostic(`row=${JSON.stringify(row)} status=${response.statusCode} body=${response.body}`);
      assert.equal(response.statusCode, 200, 'one malformed row must not disable audit reads');
      assert.deepEqual(response.json().entries, [entry], 'invalid rows must not escape or shadow a valid operation');
    });
  }
  await t.test('syntax error and incomplete final line are already skipped', async () => {
    await writeFile(f.path, '{bad json}\n' + JSON.stringify(entry) + '\n{"partial":');
    assert.deepEqual((await f.readAudit()).json().entries, [entry]);
  });
  await t.test('valid legacy rows remain visible and stored secrets stay redacted', async () => {
    const { operationId, ...legacy } = entry;
    const unsafe = { ...legacy, params: { token: 'synthetic-secret', labels: ['linux'] },
      error: 'upstream synthetic-secret', extra: 'synthetic-secret',
      actor: { ...entry.actor, extra: 'synthetic-secret' } };
    await writeFile(f.path, [legacy, entry, unsafe].map(row => JSON.stringify(row)).join('\n') + '\n');
    const response = await f.readAudit();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().entries, [
      { ...legacy, params: { token: '[redacted]', labels: ['linux'] }, error: 'Operation failed' }, entry, legacy,
    ]);
    assert.equal(response.body.includes('synthetic-secret'), false);
  });
});

test('R1 audit append after torn row preserves readable intent before side effects', { timeout: 10_000 }, async t => {
  const f = await appFixture(t);
  const prior = JSON.stringify(entry) + '\n{"interrupted":';
  await writeFile(f.path, prior);
  const record = f.audit.record.bind(f.audit);
  f.audit.record = async value => {
    if (value.outcome !== 'pending') throw new Error('synthetic loss of outcome write');
    await record(value);
  };
  let during: AuditEntry[] = [];
  let sideEffects = 0;
  await assert.rejects(audited(f.audit, { identity, action: 'runner.restart', requestId: 'new' }, async () => {
    during = (await f.readAudit()).json().entries;
    sideEffects++;
  }), error => error instanceof AuditWriteError && error.operationState === 'completed');
  const after = (await f.readAudit()).json().entries;
  const raw = await readFile(f.path, 'utf8');
  t.diagnostic(`sideEffects=${sideEffects}; visible during=${JSON.stringify(during)}; after=${JSON.stringify(after)}`);
  assert.ok(raw.includes('"outcome":"pending"'), 'intent bytes did reach storage');
  assert.ok(raw.startsWith(prior + '\n'), 'all prior bytes must be preserved');
  assert.equal(sideEffects, 1);
  assert.ok(during.some(row => row.requestId === 'new' && row.outcome === 'pending'),
    'durable intent must be independently readable before starting an operation after a torn append');
  assert.ok(after.some((row: AuditEntry) => row.requestId === 'new' && row.outcome === 'pending'));
});

test('R1 malformed signed claims and duplicate auth fields cannot manufacture access', { timeout: 20_000 }, async t => {
  const f = await provider(t);
  const a = await appFixture(t, f.client());
  const patches = [{ sub: [] }, { sub: 1 }, { aud: { 0: 'console' } }, { aud: [1, 'other'] },
    { exp: '9999999999' }, { exp: null }, { iat: [] }, { nonce: ['nonce'] },
    { groups: { 0: 'operators' } }, { groups: [null, 'operators'] }, { azp: ['console'] }];
  for (const patch of patches) {
    f.state.patch = patch;
    const state = a.loginStates.create({ verifier: 'verifier', nonce: 'nonce', returnTo: '/' });
    const response = await a.app.inject({ url: `/auth/callback?code=synthetic&state=${state}`, headers: { cookie: `crc_login=${state}` } });
    assert.equal(response.statusCode, 403, JSON.stringify(patch));
    assert.equal(response.cookies.some(c => c.name === 'crc_session'), false);
  }
  f.state.patch = {};
  for (const cookies of ['crc_session=forged; crc_session=also-forged',
    'crc_session=%ZZ; crc_session=forged', 'crc_session=; crc_session=forged']) {
    const response = await a.app.inject({ url: '/api/me', headers: { cookie: cookies,
      'x-forwarded-user': 'administrator', 'x-authentik-groups': 'operators' } });
    assert.equal(response.statusCode, 401);
  }
  for (const suffix of ['&state=other', '&code=other']) {
    const state = a.loginStates.create({ verifier: 'verifier', nonce: 'nonce', returnTo: '/' });
    const before = f.state.exchanges;
    assert.equal((await a.app.inject({ url: `/auth/callback?code=synthetic&state=${state}${suffix}`,
      headers: { cookie: `crc_login=${state}` } })).statusCode, 400);
    assert.equal(f.state.exchanges, before);
  }
  const state = a.loginStates.create({ verifier: 'verifier', nonce: 'nonce', returnTo: '/' });
  const callback = { url: `/auth/callback?code=synthetic&state=${state}`, headers: { cookie: `crc_login=${state}; crc_login=other` } };
  const responses = await Promise.all([a.app.inject(callback), a.app.inject(callback)]);
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [302, 400]);
  const valid = responses.find(r => r.statusCode === 302)!.cookies.find(c => c.name === 'crc_session')!.value;
  a.sessions.destroy(valid);
  for (const cookies of [`crc_session=${valid}; crc_session=forged`, `crc_session=forged; crc_session=${valid}`]) {
    assert.equal((await a.app.inject({ url: '/api/me', headers: { cookie: cookies } })).statusCode, 401);
  }
  t.diagnostic('11 signed malformed claim cases, 3 forged-cookie/header combinations, 2 duplicate query cases, 2 concurrent callbacks and 2 revoked-cookie orders');
});

test('R1 runtime VM malformed combinations fail closed through inventory API', { timeout: 10_000 }, async t => {
  const local = { name: 'synthetic', dir: '/synthetic/runner', unit: null,
    registered: false, serviceInstalled: false, active: null, enabled: null,
    subState: null, activeSince: null, legacy: false };
  const headroom = { cpus: 1, load: { one: 0, five: 0, fifteen: 0 }, memory: { totalBytes: 1, availableBytes: 1 },
    disk: { totalBytes: 1, freeBytes: 1 }, cap: 3, instances: 1, remaining: 2 };
  let response: unknown = { instances: [local] };
  const control = new RunnerVmControl({ json: async (argv: string[]) => argv[0] === 'list' ? response : headroom } as unknown as RunnerVm);
  const f = await appFixture(t, undefined, control);
  for (const patch of [{ serviceInstalled: true, unit: null }, { active: ['active'], legacy: null },
    { registered: 1, name: 'synthetic' }, { dir: '/synthetic/\u0000runner', active: 'active' }]) {
    response = { instances: [{ ...local, ...patch }] };
    const result = await f.app.inject({ url: '/api/inventory', headers: { cookie: `crc_session=${f.session}` } });
    assert.equal(result.statusCode, 500);
    assert.deepEqual(result.json(), { error: 'Internal error' });
  }
  response = { instances: [local] };
  const recovered = await f.app.inject({ url: '/api/inventory', headers: { cookie: `crc_session=${f.session}` } });
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.json().runners[0].state, 'unregistered');
});
