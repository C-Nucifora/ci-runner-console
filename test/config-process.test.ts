import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`full server rejects anonymous requests and drains on ${signal}`, { timeout: 15_000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'crc-process-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await cp(new URL('../src/', import.meta.url), join(dir, 'dist'), { recursive: true });
    await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'));
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await mkdir(join(dir, 'web/dist/assets'), { recursive: true });
    await writeFile(join(dir, 'web/dist/index.html'), '<html>synthetic private shell</html>');
    await writeFile(join(dir, 'web/dist/assets/test.js'), 'console.log("synthetic")');
    // Replace external services in this child only. Sessions and HTTP routes stay real.
    await writeFile(join(dir, 'synthetic.mjs'), `
      import { OidcClient } from './dist/auth/oidc.js';
      import { RepoRunnerRegistry } from './dist/github/registry.js';
      import { RunnerVmControl } from './dist/vm/ctl.js';
      import { writeFile } from 'node:fs/promises';
      globalThis.fetch = async () => { throw new Error('unexpected external request'); };
      OidcClient.prototype.beginLogin = async () => ({
        url: 'https://oidc.example.invalid/authorize', verifier: 'synthetic', nonce: 'synthetic',
      });
      OidcClient.prototype.completeLogin = async (code) => {
        if (code === 'synthetic-rejected-code') throw new Error('synthetic-upstream-error-secret');
        return { sub: 'synthetic', username: 'tester', email: null, name: null, groups: [] };
      };
      let created = false;
      RepoRunnerRegistry.prototype.listRunners = async () => created ? [{
        id: 1, name: 'shutdown-test', os: 'linux', status: 'online', busy: false, labels: [],
      }] : [];
      RepoRunnerRegistry.prototype.createRegistrationToken = async () => ({ token: 'synthetic_token_123', expiresAt: '' });
      RunnerVmControl.prototype.create = async () => {
        await writeFile('mutation-started', 'yes');
        await new Promise(resolve => setTimeout(resolve, 500));
        created = true;
        return { name: 'shutdown-test', dir: '/synthetic', unit: 'actions.runner.synthetic.service', active: 'active' };
      };
      RunnerVmControl.prototype.list = async () => [];
      RunnerVmControl.prototype.headroom = async () => ({
        cap: 3, instances: 0, remaining: 3, cpus: 4, load: { one: 0, five: 0, fifteen: 0 },
        memory: { totalBytes: 1, availableBytes: 1 }, disk: { totalBytes: 1, freeBytes: 1 },
      });
    `);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await writeFile(join(dir, 'key'), privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
    const keyType = Buffer.from('ssh-ed25519');
    const key = Buffer.concat([Buffer.from([0, 0, 0, keyType.length]), keyType, Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close(err => err ? reject(err) : resolve()));
    const child = spawn(process.execPath, ['--import', join(dir, 'synthetic.mjs'), join(dir, 'dist/index.js')], {
      cwd: dir,
      env: {
        PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port),
        PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, SESSION_SECRET: 'synthetic-session-secret-32-characters',
        OIDC_ISSUER: 'http://127.0.0.1:1/never-contact', OIDC_CLIENT_ID: 'synthetic', OIDC_CLIENT_SECRET: 'synthetic',
        GITHUB_API_BASE_URL: 'http://127.0.0.1:1', GITHUB_TOKEN: 'synthetic', GITHUB_OWNER: 'example', GITHUB_REPO: 'test',
        RUNNER_VM_HOST: '127.0.0.1', RUNNER_VM_PORT: '1', RUNNER_VM_KEY_PATH: join(dir, 'key'),
        RUNNER_VM_HOST_KEY: `ssh-ed25519 ${key}`, AUDIT_LOG_PATH: join(dir, 'audit.jsonl'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exit = once(child, 'close');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
    let output = '';
    let phase = 'startup';
    t.after(() => { if (t.signal.aborted) t.diagnostic(`Stopped during ${phase}: ${output}`); });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const base = `http://127.0.0.1:${port}`;
    let started = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) assert.fail(output);
      try {
        const response = await fetch(`${base}/healthz`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: 'ok', service: 'ci-runner-console' });
        started = true;
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 30)); }
    }
    assert.ok(started, output);
    for (const path of ['/api/inventory', '/api/settings', '/api/audit']) {
      const response = await fetch(base + path, { headers: {
        'x-authentik-username': 'admin', 'x-authentik-arbitrary': 'admin', 'x-forwarded-user': 'admin',
        'x-remote-user': 'admin', cookie: 'crc_session=forged',
      } });
      assert.equal(response.status, 401, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      await response.arrayBuffer();
    }
    const unknown = await fetch(`${base}/api/does-not-exist`);
    assert.equal(unknown.status, 404);
    await unknown.arrayBuffer();
    const shell = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(shell.status, 302);
    assert.equal(shell.headers.get('cache-control'), 'no-store');
    assert.match(shell.headers.get('location')!, /^\/auth\/login/);
    assert.equal(shell.headers.get('x-frame-options'), 'DENY');
    assert.equal(shell.headers.get('x-content-type-options'), 'nosniff');
    await shell.arrayBuffer();
    const missingAsset = await fetch(base + '/assets/missing.js');
    assert.equal(missingAsset.status, 404);
    assert.equal(missingAsset.headers.get('cache-control'), 'no-store');
    assert.equal(await missingAsset.text(), 'Not found');
    for (const path of ['/assets/..%2findex.html', '/assets/%2f..%2findex.html', '/api/%69nventory', '/api//inventory']) {
      const response = await fetch(base + path, { redirect: 'manual' });
      assert.notEqual(response.status, 200, `noncanonical path bypassed authorization: ${path}`);
      assert.ok(!(await response.text()).includes('synthetic private shell'), path);
    }
    const asset = await fetch(base + '/assets/test.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control')!, /immutable/);
    await asset.arrayBuffer();
    assert.match(output, /x-authentik-arbitrary/);
    const secrets = ['synthetic-code-secret', 'synthetic-state-secret', 'synthetic-cookie-secret',
      'synthetic-authorization-secret', 'synthetic-header-secret', 'synthetic-query-secret',
      'synthetic-rejected-code', 'synthetic-upstream-error-secret'];
    const rejected = await fetch(`${base}/auth/callback?code=${secrets[0]}&state=${secrets[1]}`, { headers: {
      cookie: `crc_session=${secrets[2]}`, authorization: `Bearer ${secrets[3]}`,
      'x-authentik-secret': secrets[4]!,
    } });
    assert.equal(rejected.status, 400);
    await rejected.arrayBuffer();
    const login = async (code: string) => {
      const start = await fetch(`${base}/auth/login?returnTo=%2F`, { redirect: 'manual' });
      assert.equal(start.status, 302);
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      secrets.push(state);
      const bound = start.headers.get('set-cookie')!.split(';')[0]!;
      await start.arrayBuffer();
      return fetch(`${base}/auth/callback?code=${code}&state=${state}`, { redirect: 'manual', headers: { cookie: bound } });
    };
    const signedIn = await login(secrets[0]!);
    assert.equal(signedIn.status, 302);
    const session = signedIn.headers.getSetCookie().find(value => value.startsWith('crc_session='))!.split(';')[0]!;
    secrets.push(session.slice('crc_session='.length));
    await signedIn.arrayBuffer();
    for (const path of ['/api/inventory', '/api/settings', '/api/audit']) {
      const response = await fetch(base + path + `?synthetic=${secrets[5]}`, { headers: { cookie: session } });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      assert.ok(await response.json(), path);
    }
    const failedLogin = await login('synthetic-rejected-code');
    assert.equal(failedLogin.status, 403);
    await failedLogin.arrayBuffer();
    phase = 'mutation startup';
    const mutation = fetch(base + '/api/runners', { method: 'POST', headers: {
      cookie: session, origin: base, 'content-type': 'application/json',
    }, body: JSON.stringify({ name: 'shutdown-test' }) });
    for (let i = 0; ; i++) {
      try { await readFile(join(dir, 'mutation-started')); break; } catch {
        assert.ok(i < 150, 'mutation entered before shutdown');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    assert.equal(JSON.parse((await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').at(-1)!).outcome, 'pending');
    phase = 'mutation shutdown';
    child.kill(signal);
    const mutationResponse = await mutation;
    phase = 'mutation response body';
    assert.equal(mutationResponse.status, 200, await mutationResponse.text());
    phase = 'process exit';
    const [code, terminatingSignal] = await exit;
    assert.equal(code, 0, output);
    assert.equal(terminatingSignal, null);
    const auditRecords = (await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(auditRecords.at(-1).outcome, 'success');
    for (const secret of secrets) assert.ok(!output.includes(secret), `request logs leaked ${secret}`);
    const logs = output.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(logs.some(log => log.msg === 'incoming request' && log.req.method === 'GET' && log.req.route === '/auth/callback' && log.reqId));
    assert.ok(logs.some(log => log.msg === 'request completed' && log.res.statusCode === 403 && log.reqId));
    assert.ok(logs.some(log => log.msg === 'OIDC login rejected' && log.level === 40 && log.reqId));
  });
}
