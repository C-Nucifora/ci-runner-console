import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Client } from 'ssh2';
import { RunnerVm } from '../src/vm/ssh.js';

test('SSH transport fails closed without opening sockets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vm-ssh-'));
  const key = join(dir, 'key');
  writeFileSync(key, 'synthetic key');
  const cfg = { host: '127.0.0.1', port: 1, user: 'fake', privateKeyPath: key,
    hostKey: Buffer.alloc(32, 1).toString('base64'), connectTimeoutMs: 50, commandTimeoutMs: 50 };
  const original = { connect: Client.prototype.connect, exec: Client.prototype.exec, destroy: Client.prototype.destroy };
  let mode = 'ok';
  let sent = '';
  let supplied = '';
  let verified = false;
  let dispatches = 0;
  let destroyed = 0;
  let streamDestroyed = 0;
  let lateReady: (() => void) | undefined;
  let lateExec: (() => void) | undefined;
  Client.prototype.connect = function (options: any) {
    if (mode === 'connect-throws') throw new Error('synthetic_token_123');
    verified = options.hostVerifier(Buffer.alloc(32, 1)) && !options.hostVerifier(Buffer.alloc(32, 2));
    if (mode === 'late-ready') {
      lateReady = () => { this.emit('ready'); };
      return this;
    }
    queueMicrotask(() => this.emit(mode === 'disconnect' ? 'close' : 'ready'));
    return this;
  };
  Client.prototype.destroy = function () { destroyed++; this.emit('close'); return this; };
  Client.prototype.exec = function (this: Client, command: string, callback: any): any {
    dispatches++;
    sent = command;
    const stream: any = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.write = (value: string) => { supplied = value; };
    stream.destroy = () => { streamDestroyed++; stream.emit('close', 0); };
    stream.end = () => queueMicrotask(() => {
      if (mode === 'timeout') return;
      if (mode === 'flood') { stream.emit('data', Buffer.alloc(1024 * 1024 + 1)); return; }
      if (mode === 'stderr-flood') { stream.stderr.emit('data', Buffer.alloc(1024 * 1024 + 1)); return; }
      if (mode === 'combined-flood') {
        stream.emit('data', Buffer.from('{"ok":true}'));
        stream.stderr.emit('data', Buffer.alloc(1024 * 1024));
        return;
      }
      if (mode === 'utf8') {
        const bytes = Buffer.from('{"ok":true,"message":"✓"}');
        for (const byte of bytes) stream.emit('data', Buffer.from([byte]));
        stream.emit('close', 0);
        return;
      }
      if (mode === 'error') { stream.emit('error', new Error('synthetic')); return; }
      stream.emit('data', Buffer.from(mode === 'truthy' ? '{"ok":"yes"}' : '{"ok":true}'));
      stream.stderr.emit('data', Buffer.from('synthetic_token_123'));
      stream.emit('close', mode === 'failed' ? 1 : mode === 'signal' ? null : 0);
    });
    if (mode === 'late-exec') lateExec = () => callback(null, stream);
    else callback(null, stream);
    return this;
  } as any;
  try {
    assert.throws(() => new RunnerVm({ ...cfg, hostKey: cfg.hostKey + '!' }));
    const vm = new RunnerVm(cfg);
    const reply = await vm.run(['create', 'r', '', 'https://github.com/org'], 'synthetic_token_123');
    assert.equal(reply.stderr, '[redacted]');
    assert.equal(supplied, 'synthetic_token_123\n');
    assert.equal(verified, true);
    assert.deepEqual(JSON.parse(Buffer.from(sent, 'base64').toString()), ['create', 'r', '', 'https://github.com/org']);
    assert.ok(!sent.includes('synthetic_token_123'));
    for (mode of ['connect-throws', 'failed', 'signal', 'truthy', 'disconnect', 'flood', 'stderr-flood', 'combined-flood', 'error', 'timeout']) {
      const previousDestroyed = destroyed;
      await assert.rejects(vm.json(['list']), mode);
      assert.equal(destroyed, previousDestroyed + 1, mode);
    }
    mode = 'late-ready';
    const previousDispatches = dispatches;
    await assert.rejects(vm.json(['list']), /timed out/);
    lateReady!();
    assert.equal(dispatches, previousDispatches);
    mode = 'late-exec';
    supplied = '';
    await assert.rejects(vm.run(['remove', 'r'], 'synthetic_token_123'), /timed out/);
    const previousStreamDestroyed = streamDestroyed;
    lateExec!();
    assert.equal(supplied, '');
    assert.equal(streamDestroyed, previousStreamDestroyed + 1);
    mode = 'utf8';
    assert.deepEqual(await vm.json(['list']), { ok: true, message: '✓' });
    await assert.rejects(vm.run(['list'], 'bad\nsecret'));
  } finally {
    Object.assign(Client.prototype, original);
    rmSync(dir, { recursive: true, force: true });
  }
});
