// Bounded provider and SSH response regressions using in-process fakes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { OidcClient } from '../src/auth/oidc.js';
import { LoginStateStore, SessionStore } from '../src/auth/session.js';
import { registerAuthRoutes, SESSION_COOKIE } from '../src/routes/auth.js';
import { RunnerVmControl } from '../src/vm/ctl.js';
import { VmError, type RunnerVm } from '../src/vm/ssh.js';
import type { Config } from '../src/config.js';

const identity = { sub: 'synthetic-r4', username: 'synthetic-r4', email: null, name: null, groups: ['operators'] };

test('R4 failed callback consumes only its bound state and preserves existing session', { timeout: 5_000 }, async t => {
  const app = Fastify();
  await app.register(cookie);
  t.after(() => app.close());
  const sessions = new SessionStore('synthetic-round-four-secret'.repeat(3), 60);
  const states = new LoginStateStore();
  const old = sessions.create(identity);
  let exchanges = 0;
  let reject = true;
  const oidc = {
    beginLogin: async () => ({ url: 'https://identity.invalid/authorize', verifier: 'synthetic-v', nonce: 'synthetic-n' }),
    completeLogin: async () => { exchanges++; if (reject) throw new Error('synthetic upstream refusal'); return identity; },
    endSessionUrl: async () => null,
  } as unknown as OidcClient;
  registerAuthRoutes(app, { oidc, sessions, loginStates: states,
    config: { publicBaseUrl: 'https://console.invalid', sessionTtlSeconds: 60 } as Config });
  async function begin() {
    const response = await app.inject('/auth/login');
    assert.equal(response.statusCode, 302);
    return response.cookies.find(c => c.name === 'crc_login')!.value;
  }
  const a = await begin();
  const b = await begin();
  const callback = (state: string, binding: string) => app.inject({
    url: `/auth/callback?code=synthetic&state=${state}`,
    cookies: { crc_login: binding, [SESSION_COOKIE]: old },
  });
  assert.equal((await callback(a, b)).statusCode, 400);
  assert.equal(exchanges, 0, 'cross-browser mismatch must not reach provider');
  const failed = await callback(a, a);
  assert.equal(failed.statusCode, 403);
  assert.equal(failed.cookies.some(c => c.name === SESSION_COOKIE), false);
  assert.deepEqual(sessions.get(old), identity, 'failed login must not destroy prior session');
  reject = false;
  assert.equal((await callback(a, a)).statusCode, 400, 'failed provider exchange remains single-use');
  assert.equal(exchanges, 1);
  const successful = await callback(b, b);
  assert.equal(successful.statusCode, 302, 'other browser state remains usable');
  assert.equal(exchanges, 2);
  assert.equal(sessions.get(old), null, 'successful rotation invalidates old session');
  const fresh = successful.cookies.find(c => c.name === SESSION_COOKIE)!.value;
  assert.deepEqual(sessions.get(fresh), identity);
  assert.equal((await callback(b, b)).statusCode, 400);
});

test('R4 signed group lookalikes reject without poisoning cached provider recovery', { timeout: 10_000 }, async t => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'r4', alg: 'ES256', use: 'sig' };
  const issuer = 'https://identity.invalid';
  let groups: unknown = identity.groups;
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    paths.push(url);
    if (url === issuer + '/.well-known/openid-configuration') return Response.json({ issuer,
      authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks' });
    if (url === issuer + '/jwks') return Response.json({ keys: [jwk] });
    assert.equal(url, issuer + '/token', 'no unexpected provider request');
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ iss: issuer, aud: 'console', sub: identity.sub,
      iat: now, exp: now + 60, nonce: 'r4-nonce', groups })
      .setProtectedHeader({ alg: 'ES256', kid: 'r4' }).sign(privateKey);
    return Response.json({ id_token: token });
  });
  const client = new OidcClient({ issuer, clientId: 'console', clientSecret: 'synthetic-only', allowedGroups: ['operators'] },
    'https://console.invalid/auth/callback');
  for (const denied of [[], ['Operators'], ['operators '], [' operators'], ['operators\u0000'],
    ['operat\u043ers'], ['prefix/operators'], ['operators,sudo'], ['operators', 1]]) {
    groups = denied;
    await assert.rejects(client.completeLogin('synthetic', 'r4-verifier', 'r4-nonce'), Error, JSON.stringify(denied));
    groups = ['unrelated', 'operators'];
    assert.equal((await client.completeLogin('synthetic', 'r4-verifier', 'r4-nonce')).sub, identity.sub);
  }
  assert.equal(paths.filter(path => path.endsWith('/.well-known/openid-configuration')).length, 1);
  assert.equal(paths.filter(path => path.endsWith('/jwks')).length, 1);
});

test('R4 each malformed VM response rejects independently and the next valid reply recovers', { timeout: 5_000 }, async () => {
  let response: unknown;
  const calls: string[][] = [];
  const control = new RunnerVmControl({ json: async (argv: string[]) => {
    calls.push(argv);
    return JSON.parse(JSON.stringify(response)); // Match the actual JSON wire domain.
  } } as unknown as RunnerVm);
  const local = { name: 'r4', dir: '/opt/runners/r4', unit: 'actions.runner.console.r4.service',
    registered: true, serviceInstalled: true, active: 'active', enabled: 'enabled', subState: 'running',
    activeSince: null, legacy: false };
  const headroom = { cpus: 1, load: { one: 0, five: 0, fifteen: 0 }, memory: { totalBytes: 2, availableBytes: 1 },
    disk: { totalBytes: 2, freeBytes: 1 }, instances: 1, cap: 3, remaining: 2 };
  const cases: { name: string; valid: Record<string, unknown>; run: () => Promise<unknown> }[] = [
    { name: 'list', valid: { instances: [local] }, run: () => control.list() },
    { name: 'headroom', valid: headroom, run: () => control.headroom() },
    { name: 'logs', valid: { lines: ['synthetic'] }, run: () => control.logs('r4', 1) },
    ...(['start', 'stop', 'restart'] as const).map(name => ({ name,
      valid: { name: 'r4', unit: local.unit, active: 'active' }, run: () => control[name]('r4') })),
    { name: 'create', valid: { name: 'r4', dir: local.dir, unit: local.unit, active: 'active' },
      run: () => control.create({ name: 'r4', labels: [], url: 'https://github.com/synthetic', registrationToken: 'synthetic_token_123' }) },
    { name: 'remove', valid: { name: 'r4', deregisteredLocally: true }, run: () => control.remove('r4', 'synthetic_token_123') },
  ];
  for (const item of cases) {
    const fields = Object.keys(item.valid);
    for (const field of fields) {
      const damaged = { ...item.valid };
      delete damaged[field];
      response = damaged;
      await assert.rejects(item.run(), VmError, `${item.name}: missing ${field}`);
      response = item.valid;
      await item.run();
    }
    for (const shape of [null, [], false, 'synthetic']) {
      response = shape;
      await assert.rejects(item.run(), VmError, `${item.name}: ${JSON.stringify(shape)}`);
    }
    response = { ...item.valid, ignored: 'synthetic untrusted extra field' };
    assert.equal(JSON.stringify(await item.run()).includes('synthetic untrusted extra field'), false);
  }
  assert.ok(calls.length < 150, 'bounded response matrix');
});
