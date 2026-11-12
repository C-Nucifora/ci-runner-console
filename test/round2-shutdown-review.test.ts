import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ssh2 from 'ssh2';

// These probes isolate signal/HTTP-close ordering. The process-audit suite covers real route work.
for (const mode of ['drain', 'deadline'] as const) {
  test(`R2 independent: ${mode} after HTTP close retains handlers and one unreferenced watchdog`, { timeout: 10_000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'crc-r2-independent-shutdown-'));
    let stop = async () => {};
    t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
    await cp(new URL('../src/', import.meta.url), join(dir, 'dist'), { recursive: true });
    await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'));
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await mkdir(join(dir, 'web/dist/assets'), { recursive: true });
    await writeFile(join(dir, 'web/dist/index.html'), '<html>synthetic</html>');
    // ssh2 strips leading zero bytes from generated Ed25519 public keys.
    const keys = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 });
    await writeFile(join(dir, 'key'), keys.private, { mode: 0o600 });
    await writeFile(join(dir, 'fixture.mjs'), `
      import { Server } from 'node:http';
      import { existsSync, writeFileSync } from 'node:fs';
      globalThis.fetch = async () => { throw new Error('unexpected external request'); };
      const watchdogs = [];
      const timeout = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...args) => {
        if (ms !== 300000) return timeout(fn, ms, ...args);
        const timer = timeout(fn, ${mode === 'deadline' ? 500 : 5_000}, ...args);
        watchdogs.push(timer);
        return timer;
      };
      process.on('exit', () => writeFileSync('exited', JSON.stringify({
        count: watchdogs.length, referenced: watchdogs.map(timer => timer.hasRef()),
      })));
      const listen = Server.prototype.listen;
      Server.prototype.listen = function(options, ...args) {
        this.once('listening', () => writeFileSync('listening', String(this.address().port)));
        this.once('close', () => {
          const work = setInterval(() => {
            if (existsSync('release')) clearInterval(work);
          }, 10);
          setImmediate(() => writeFileSync('closed', JSON.stringify({
            term: process.listenerCount('SIGTERM'), interrupt: process.listenerCount('SIGINT'),
          })));
        });
        return listen.call(this, { ...options, host: '127.0.0.1', port: 0 }, ...args);
      };
    `);
    const child = spawn(process.execPath, ['--import', join(dir, 'fixture.mjs'), join(dir, 'dist/index.js')], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: {
        PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: '--max-old-space-size=512',
        HOST: '127.0.0.1', PORT: '12345', PUBLIC_BASE_URL: 'http://127.0.0.1:12345',
        SESSION_SECRET: 'synthetic-independent-review-secret-32-characters',
        OIDC_ISSUER: 'http://127.0.0.1:1', OIDC_CLIENT_ID: 'synthetic', OIDC_CLIENT_SECRET: 'synthetic',
        GITHUB_API_BASE_URL: 'http://127.0.0.1:1', GITHUB_TOKEN: 'synthetic', GITHUB_OWNER: 'example', GITHUB_REPO: 'synthetic',
        RUNNER_VM_HOST: '127.0.0.1', RUNNER_VM_PORT: '1', RUNNER_VM_KEY_PATH: join(dir, 'key'), RUNNER_VM_HOST_KEY: keys.public,
        AUDIT_LOG_PATH: join(dir, 'audit.jsonl'),
      },
    });
    const exit = once(child, 'close');
    let output = '';
    child.stdout!.on('data', data => { output += data; });
    child.stderr!.on('data', data => { output += data; });
    stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exit;
    };
    const marker = async (name: string) => {
      for (let i = 0; i < 300; i++) {
        assert.equal(child.exitCode, null, output);
        assert.equal(child.signalCode, null, output);
        try { return await readFile(join(dir, name), 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(`missing ${name}: ${output}`);
    };
    const port = await marker('listening');
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(base + '/healthz', { headers: { connection: 'close' }, signal: AbortSignal.timeout(1_000) });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    child.kill('SIGTERM');
    const handlers = JSON.parse(await marker('closed')) as { term: number; interrupt: number };
    assert.equal(handlers.term, 1);
    assert.equal(handlers.interrupt, 1);
    child.kill('SIGINT');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(child.signalCode, null, output);
    assert.equal(child.exitCode, null, output);
    child.kill('SIGTERM');
    if (mode === 'drain') await writeFile(join(dir, 'release'), 'yes');
    assert.deepEqual(await exit, [mode === 'drain' ? 0 : 1, null], output);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'exited'), 'utf8')), { count: 1, referenced: [false] });
    await assert.rejects(fetch(base + '/healthz', { signal: AbortSignal.timeout(500) }));
  });
}
