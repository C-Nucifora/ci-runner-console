import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { runHealthChecks } from '../src/health.js';
import type { RunnerRegistry } from '../src/github/registry.js';
import type { RunnerVmControl } from '../src/vm/ctl.js';

const { publicKey } = generateKeyPairSync('ed25519');
const jwk = publicKey.export({ format: 'jwk' });
const kind = Buffer.from('ssh-ed25519');
const raw = Buffer.from(jwk.x!, 'base64url');
const size = (data: Buffer) => {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(data.length);
  return Buffer.concat([prefix, data]);
};
const hostKey = `ssh-ed25519 ${Buffer.concat([size(kind), size(raw)]).toString('base64')}`;
const env = {
  PUBLIC_BASE_URL: 'https://console.example.invalid/',
  SESSION_SECRET: 'synthetic-session-secret-32-characters',
  OIDC_ISSUER: 'https://auth.example.invalid/application/o/test/',
  OIDC_CLIENT_ID: 'synthetic-client', OIDC_CLIENT_SECRET: 'synthetic-secret',
  GITHUB_TOKEN: 'synthetic-token', GITHUB_OWNER: 'example', GITHUB_REPO: 'test',
  RUNNER_VM_HOST: 'runner.example.invalid', RUNNER_VM_KEY_PATH: '/nonexistent/synthetic-key',
  RUNNER_VM_HOST_KEY: hostKey,
};

test('configuration validation and secret files', async (t) => {
  const original = process.env;
  const dir = mkdtempSync(join(tmpdir(), 'crc-config-'));
  t.after(() => { process.env = original; rmSync(dir, { recursive: true, force: true }); });
  const load = (overrides: Record<string, string | undefined> = {}) => {
    process.env = { ...env, ...overrides };
    return loadConfig();
  };
  await t.test('normalizes the public origin and binds locally', () => {
    const config = load({ PUBLIC_BASE_URL: 'https://CONSOLE.example.invalid:443/' });
    assert.equal(config.publicBaseUrl, 'https://console.example.invalid');
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.runners.cap, 3);
  });
  for (const url of ['not a url', 'http://console.example.invalid', 'file:///tmp/console', 'ftp://console.example.invalid', 'https://user:pass@example.invalid',
    'https://example.invalid/path', 'https://example.invalid/?x=1', 'https://example.invalid/#x']) {
    await t.test(`rejects public URL ${url}`, () => assert.throws(() => load({ PUBLIC_BASE_URL: url }), /Invalid configuration/));
  }
  for (const field of ['OIDC_ISSUER', 'GITHUB_API_BASE_URL']) {
    await t.test(`rejects unsafe ${field}`, () => {
      for (const value of ['file:///tmp/metadata', 'ftp://example.invalid', 'http://example.invalid',
        'https://user:pass@example.invalid', 'https://example.invalid/?secret=value', 'https://example.invalid/#fragment']) {
        assert.throws(() => load({ [field]: value }), /Invalid configuration/);
      }
    });
  }
  for (const [field, value] of Object.entries({ GITHUB_OWNER: '../other', GITHUB_REPO: 'bad/repo', GITHUB_RUNNER_GROUP: 'bad;group', RUNNER_DEFAULT_LABELS: 'bad label', RUNNER_PROTECTED_NAMES: '../runner', RUNNER_VM_CONNECT_TIMEOUT_MS: '2147483648', RUNNER_VM_COMMAND_TIMEOUT_MS: 'Infinity', PORT: '0', RUNNER_CAP: '17', POLL_INTERVAL_MS: '0', SESSION_TTL_SECONDS: '-1', RUNNER_VM_HOST_KEY: 'ssh-ed25519 garbage' })) {
    await t.test(`rejects invalid ${field}`, () => assert.throws(() => load({ [field]: value }), /Invalid configuration/));
  }
  await t.test('rejects invalid and overflowing numeric settings', () => {
    for (const field of ['PORT', 'RUNNER_CAP', 'POLL_INTERVAL_MS', 'SESSION_TTL_SECONDS', 'RUNNER_VM_CONNECT_TIMEOUT_MS', 'RUNNER_VM_COMMAND_TIMEOUT_MS']) {
      for (const value of ['NaN', 'Infinity', '-Infinity', '2147483648', 'bad']) {
        assert.throws(() => load({ [field]: value }), /Invalid configuration/);
      }
    }
  });
  await t.test('allows explicit loopback HTTP for synthetic services', () => {
    for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
      assert.equal(load({ PUBLIC_BASE_URL: `http://${host}:8080` }).publicBaseUrl, `http://${host}:8080`);
      assert.equal(load({ OIDC_ISSUER: `http://${host}:8080/oidc/` }).oidc.issuer, `http://${host}:8080/oidc/`);
      assert.equal(load({ GITHUB_API_BASE_URL: `http://${host}:8080/api/` }).github.apiBaseUrl, `http://${host}:8080/api/`);
    }
    for (const field of ['OIDC_ISSUER', 'GITHUB_API_BASE_URL']) {
      assert.throws(() => load({ [field]: 'http://example.invalid' }), /Invalid configuration/);
    }
  });
  await t.test('accepts timer bounds and rejects overflow without coercing it to a short timeout', () => {
    for (const field of ['POLL_INTERVAL_MS', 'RUNNER_VM_CONNECT_TIMEOUT_MS', 'RUNNER_VM_COMMAND_TIMEOUT_MS']) {
      for (const value of ['1', '2147483647']) assert.doesNotThrow(() => load({ [field]: value }));
      for (const value of ['', '0', '-1', '0.5', '2147483648']) assert.throws(() => load({ [field]: value }), /Invalid configuration/);
    }
    assert.equal(load({ SESSION_TTL_SECONDS: '2147483' }).sessionTtlSeconds, 2147483);
    assert.throws(() => load({ SESSION_TTL_SECONDS: '2147484' }), /Invalid configuration/);
  });
  await t.test('requires repo only for repo scope', () => {
    assert.throws(() => load({ GITHUB_REPO: '' }), /GITHUB_REPO/);
    assert.equal(load({ GITHUB_SCOPE: 'org', GITHUB_REPO: '' }).github.scope, 'org');
    assert.throws(() => load({ GITHUB_RUNNER_GROUP: 'group' }), /GITHUB_RUNNER_GROUP/);
  });
  await t.test('file secrets take precedence and trim newlines', () => {
    const file = join(dir, 'secret');
    writeFileSync(file, 'synthetic-file-secret\n');
    assert.equal(load({ GITHUB_TOKEN_FILE: file }).github.token, 'synthetic-file-secret');
    writeFileSync(file, '\n');
    assert.throws(() => load({ GITHUB_TOKEN_FILE: file }), /Invalid configuration/);
    assert.throws(() => load({ GITHUB_TOKEN_FILE: join(dir, 'missing') }), /ENOENT/);
  });
  await t.test('configuration errors never echo secrets', () => {
    assert.throws(() => load({ SESSION_SECRET: 'private' }), (err: Error) => !err.message.includes('private'));
  });
});

test('health failures disclose no upstream bodies or exception messages', async (t) => {
  const originalEnv = process.env;
  process.env = { ...env };
  const config = loadConfig();
  process.env = originalEnv;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const marker = 'synthetic-private-upstream-token';
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://api.github.com/rate_limit') {
      return Response.json({ message: marker }, { status: 403 });
    }
    assert.equal(url, `${config.oidc.issuer}.well-known/openid-configuration`);
    return new Response(marker, { status: 200 });
  };
  const checks = await runHealthChecks({
    config,
    credential: { getToken: async () => marker, describe: () => 'synthetic' },
    registry: { describe: () => 'synthetic' } as RunnerRegistry,
    control: { headroom: async () => { throw new Error(marker); } } as unknown as RunnerVmControl,
  });
  assert.equal(calls.length, 2);
  assert.ok(checks.every(check => !check.ok));
  assert.match(checks[0]!.detail, /GitHub.*HTTP 403/);
  assert.match(checks[1]!.detail, /Runner VM.*connectivity/);
  assert.match(checks[2]!.detail, /OIDC.*discovery/);
  assert.ok(!JSON.stringify(checks).includes(marker));
});

test('GitHub health passes an effective deadline to fetch', async (t) => {
  const originalEnv = process.env;
  process.env = { ...env };
  const config = loadConfig();
  process.env = originalEnv;
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { deadlines.push(ms); return timeout(5); });
  let githubSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!String(url).endsWith('/rate_limit')) return new Response('{}', { status: 404 });
    assert.ok(init?.signal);
    githubSignal = init.signal;
    return new Promise<Response>((_resolve, reject) => {
      githubSignal!.addEventListener('abort', () => reject(githubSignal!.reason), { once: true });
    });
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const checks = await runHealthChecks({ config,
      credential: { getToken: async () => 'synthetic', describe: () => 'synthetic' },
      registry: { describe: () => 'synthetic' } as RunnerRegistry,
      control: { headroom: async () => { throw new Error('synthetic'); } } as unknown as RunnerVmControl,
    });
    assert.equal(githubSignal?.aborted, true);
    assert.equal(checks[0]!.ok, false);
    assert.ok(deadlines.includes(10_000));
  } finally { clearTimeout(keepAlive); }
});

test('OIDC health validates metadata without following foreign JWKS URLs', async (t) => {
  const originalEnv = process.env;
  process.env = { ...env };
  const config = loadConfig();
  process.env = originalEnv;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const deps = {
    config,
    credential: { getToken: async () => { throw new Error('synthetic unavailable'); }, describe: () => 'synthetic' },
    registry: { describe: () => 'synthetic' } as RunnerRegistry,
    control: { headroom: async () => { throw new Error('synthetic unavailable'); } } as unknown as RunnerVmControl,
  };
  for (const [name, metadata] of Object.entries({
    mismatch: { issuer: 'https://other.example.invalid', jwks_uri: `${config.oidc.issuer}jwks/` },
    foreign: { issuer: config.oidc.issuer, jwks_uri: 'https://foreign.example.invalid/keys' },
    malformed: null,
  })) {
    await t.test(name, async () => {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return Response.json(metadata); };
      const checks = await runHealthChecks(deps);
      assert.equal(checks[2]!.ok, false);
      assert.equal(calls, 1);
      assert.equal(checks.length, 3);
    });
  }
  await t.test('valid metadata and nonempty key array', async () => {
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
      assert.equal(options?.redirect, 'error');
      return Response.json(++calls === 1 ? { issuer: config.oidc.issuer, jwks_uri: `${config.oidc.issuer}jwks/` } : { keys: [{}] });
    };
    const checks = await runHealthChecks(deps);
    assert.equal(checks[2]!.ok, true);
    assert.equal(calls, 2);
  });
});
