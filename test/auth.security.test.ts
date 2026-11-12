import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { SessionStore, LoginStateStore } from '../src/auth/session.js';
import { OidcClient } from '../src/auth/oidc.js';
import { registerAuthRoutes, SESSION_COOKIE } from '../src/routes/auth.js';
import type { Config } from '../src/config.js';

const identity = { sub: 'test-user', username: 'tester', email: null, name: null, groups: ['operators'] };

test('session integrity, expiry and single-use login state', () => {
  const sessions = new SessionStore('synthetic-secret'.repeat(3), 60);
  const user = structuredClone(identity);
  const token = sessions.create(user);
  user.groups.push('admin');
  assert.deepEqual(sessions.get(token), identity);
  sessions.get(token)!.groups.push('admin');
  assert.deepEqual(sessions.get(token), identity);
  const forged = token.split('.')[0] + '.forged';
  assert.equal(sessions.get(forged), null);
  sessions.destroy(forged);
  assert.ok(sessions.get(token));
  sessions.destroy(token);
  assert.equal(sessions.get(token), null);
  const expired = new SessionStore('synthetic-secret'.repeat(3), -1);
  assert.equal(expired.get(expired.create(identity)), null);
  const states = new LoginStateStore();
  const state = states.create({ verifier: 'test', nonce: 'test', returnTo: '/' });
  assert.ok(states.consume(state));
  assert.equal(states.consume(state), null);
});

test('pending logins are bounded and expired slots are recovered', (t) => {
  const now = t.mock.method(Date, 'now', () => 1_000_000);
  const states = new LoginStateStore();
  const request = { verifier: 'test', nonce: 'test', returnTo: '/' };
  const first = states.create(request);
  for (let i = 1; i < 1000; i++) states.create(request);
  assert.throws(() => states.create(request), /Too many pending sign-ins/);
  assert.ok(states.consume(first));
  states.create(request);
  now.mock.mockImplementation(() => 1_600_001);
  assert.ok(states.create(request));
  assert.equal(states.consume(first), null);
});

test('login browser binding, redirects, replay, rotation, cookies and logout origin', async () => {
  const app = Fastify();
  await app.register(cookie);
  const sessions = new SessionStore('synthetic-secret'.repeat(3), 60);
  let exchanges = 0;
  const oidc = {
    beginLogin: async () => ({ url: 'https://id.example/authorize', verifier: 'test', nonce: 'test' }),
    completeLogin: async () => { exchanges++; return identity; },
    endSessionUrl: async () => null,
  } as unknown as OidcClient;
  registerAuthRoutes(app, { config: { publicBaseUrl: 'https://console.example', sessionTtlSeconds: 60 } as Config,
    sessions, oidc, loginStates: new LoginStateStore() });
  try {
    for (const path of ['//evil.example', '/\\evil.example', '/\t/evil.example']) {
      const start = await app.inject('/auth/login?returnTo=' + encodeURIComponent(path));
      const state = new URL(start.headers.location!).searchParams.get('state')!;
      const bound = start.cookies.find((c) => c.name === 'crc_login')!;
      assert.equal(bound.httpOnly, true);
      assert.equal(bound.secure, true);
      assert.equal(bound.sameSite, 'Lax');
      assert.equal(start.headers['cache-control'], 'no-store');
      const url = '/auth/callback?code=synthetic&state=' + state;
      const before = exchanges;
      assert.equal((await app.inject(url)).statusCode, 400);
      assert.equal(exchanges, before);
      const old = sessions.create(identity);
      const response = await app.inject({ url, cookies: { crc_login: bound.value, [SESSION_COOKIE]: old } });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/');
      assert.equal(sessions.get(old), null);
      const session = response.cookies.find((c) => c.name === SESSION_COOKIE)!;
      assert.equal(session.httpOnly, true);
      assert.equal(session.secure, true);
      assert.equal((await app.inject({ url, cookies: { crc_login: bound.value } })).statusCode, 400);
      for (const origin of [undefined, 'null', 'https://evil.example']) {
        const denied = await app.inject({ method: 'POST', url: '/auth/logout',
          headers: origin ? { origin } : {}, cookies: { [SESSION_COOKIE]: session.value } });
        assert.equal(denied.statusCode, 403);
        assert.ok(sessions.get(session.value));
      }
      assert.equal((await app.inject({ method: 'POST', url: '/auth/logout',
        headers: { origin: 'https://console.example' }, cookies: { [SESSION_COOKIE]: session.value } })).statusCode, 200);
      assert.equal(sessions.get(session.value), null);
    }
  } finally { await app.close(); }
});

test('OIDC validates issuer, required claims, authorized party and groups with synthetic signed tokens', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const issuer = 'https://id.example/application/o/test/';
  let claims: Record<string, unknown> = {};
  let metadataIssuer = issuer;
  let invalidSignature = false;
  const otherKey = await generateKeyPair('RS256');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({
      issuer: metadataIssuer, authorization_endpoint: 'https://id.example/authorize',
      token_endpoint: 'https://id.example/token', jwks_uri: 'https://id.example/jwks',
    });
    if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    assert.equal(url, 'https://id.example/token');
    assert.equal(init?.redirect, 'error');
    const token = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(invalidSignature ? otherKey.privateKey : privateKey);
    return Response.json({ id_token: token });
  };
  const client = () => new OidcClient({ issuer, clientId: 'console', clientSecret: 'synthetic', allowedGroups: ['operators'] }, 'https://console.example/auth/callback');
  const valid = { iss: issuer, aud: 'console', sub: 'user', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, nonce: 'nonce', groups: ['operators'] };
  try {
    claims = valid;
    assert.equal((await client().completeLogin('code', 'verifier', 'nonce')).sub, 'user');
    for (const patch of [{ exp: undefined }, { iat: undefined }, { sub: '' }, { nonce: 'wrong' }, { aud: 'other' },
      { iss: 'https://other.example' }, { exp: 1 }, { azp: 'other' }, { aud: ['console', 'other'] },
      { iat: Math.floor(Date.now() / 1000) + 600 }, { nbf: Math.floor(Date.now() / 1000) + 600 },
      { groups: ['outsiders'] }, { groups: 'operators' }, { groups: ['operators', 1] }]) {
      claims = { ...valid, ...patch };
      await assert.rejects(client().completeLogin('code', 'verifier', 'nonce'));
    }
    claims = valid;
    invalidSignature = true;
    await assert.rejects(client().completeLogin('code', 'verifier', 'nonce'), /signature verification failed/);
    metadataIssuer = 'https://other.example';
    await assert.rejects(client().metadata(), /issuer mismatch/);
  } finally { globalThis.fetch = originalFetch; }
});

test('OIDC refuses plaintext remote endpoints and permits isolated loopback providers', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let endpoint = 'http://127.0.0.1:1234';
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ issuer: 'http://127.0.0.1:1234', authorization_endpoint: endpoint + '/authorize',
      token_endpoint: endpoint + '/token', jwks_uri: endpoint + '/jwks' });
  };
  const client = (issuer: string) => new OidcClient({ issuer, clientId: 'console', clientSecret: 'synthetic', allowedGroups: [] }, 'http://127.0.0.1/auth/callback');
  try {
    await assert.rejects(client('http://id.example').metadata(), /must use HTTPS/);
    assert.equal(calls, 0);
    assert.equal((await client('http://127.0.0.1:1234').metadata()).issuer, 'http://127.0.0.1:1234');
    endpoint = 'http://id.example';
    await assert.rejects(client('http://127.0.0.1:1234').metadata(), /must use HTTPS/);
  } finally { globalThis.fetch = originalFetch; }
});
