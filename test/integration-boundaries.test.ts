import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import ssh2, { type Connection } from 'ssh2';
import { AuditLog } from '../src/audit.js';
import { SessionStore } from '../src/auth/session.js';
import type { Config } from '../src/config.js';
import type { GitHubRunner, RunnerRegistry } from '../src/github/registry.js';
import type { Inventory } from '../src/reconcile.js';
import { registerApiRoutes } from '../src/routes/api.js';
import { SESSION_COOKIE } from '../src/routes/auth.js';
import { RunnerVmControl, type LocalInstance } from '../src/vm/ctl.js';
import { RunnerVm } from '../src/vm/ssh.js';

const { Server, utils } = ssh2;
const registrationToken = 'synthetic_registration_12345';
const removeToken = 'synthetic_removal_67890';
// This bypasses Config to test transport encoding; vm-boundaries.py tests wrapper validation.
const runnerGroup = 'ops $(id); `id` \'quoted\' "double"\nsecond line';
const registrationUrl = 'https://github.com/synthetic';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function local(name: string): LocalInstance {
  return { name, dir: `/synthetic/${name}`, unit: `actions.runner.synthetic.${name}.service`,
    registered: true, serviceInstalled: true, active: 'active', enabled: 'enabled',
    subState: 'running', activeSince: null, legacy: false };
}

type Fault = 'nonzero' | 'refused' | 'malformed' | 'invalid-shape' | 'disconnect' | 'timeout' | 'partial-create' | 'partial-remove';
type Command = { command: string; argv: string[]; stdin: string };

async function fixture(options: { wrongHostKey?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'runner-integration-'));
  const app = Fastify();
  const connections = new Set<Connection>();
  const holds: ReturnType<typeof deferred<void>>[] = [];
  const protocolErrors: unknown[] = [];
  const state = {
    locals: [] as LocalInstance[], runners: [] as GitHubRunner[], commands: [] as Command[],
    registryCalls: [] as string[], authentications: 0, fault: null as Fault | null,
    hold: null as null | { operation: string; entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> },
  };
  const host = utils.generateKeyPairSync('ed25519');
  const client = utils.generateKeyPairSync('ed25519');
  const parsedClient = utils.parseKey(client.private);
  assert.ok(!(parsedClient instanceof Error));
  const server = new Server({ hostKeys: [host.private] }, (connection) => {
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
    // Host verification failures and deliberate disconnects are expected here.
    connection.on('error', () => {});
    connection.on('authentication', (ctx) => {
      state.authentications++;
      if (ctx.method === 'publickey' && ctx.username === 'synthetic' &&
          ctx.key.data.equals(parsedClient.getPublicSSH()) &&
          (!ctx.signature || parsedClient.verify(ctx.blob!, ctx.signature, ctx.hashAlgo))) ctx.accept();
      else ctx.reject();
    });
    connection.on('ready', () => connection.on('session', (accept) => {
      accept().on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        stream.on('error', () => {});
        const command = { command: info.command,
          argv: JSON.parse(Buffer.from(info.command, 'base64').toString('utf8')) as string[], stdin: '' };
        state.commands.push(command);
        stream.on('data', (data: Buffer) => { command.stdin += data.toString('utf8'); });
        stream.on('end', () => {
          void respond().catch((error: unknown) => { protocolErrors.push(error); connection.end(); });
        });
        async function respond() {
          const [operation, name] = command.argv;
          const fault = operation === 'create' || operation === 'remove' ? state.fault : null;
          if (fault === 'disconnect') { connection.end(); return; }
          if (fault === 'timeout') return;
          if (fault === 'nonzero') {
            stream.stderr.write(`${removeToken}\n`);
            stream.write(JSON.stringify({ ok: false, error: `synthetic refusal ${removeToken}` }));
            stream.exit(1); stream.end(); return;
          }
          if (fault === 'refused') {
            stream.stderr.write(JSON.stringify({ error: `synthetic wrapper refusal ${removeToken}` }) + '\n');
            stream.exit(42); stream.end(); return;
          }
          if (fault === 'malformed') {
            stream.write('not JSON'); stream.exit(0); stream.end(); return;
          }
          if (fault === 'invalid-shape') {
            stream.write('{"ok":true}'); stream.exit(0); stream.end(); return;
          }
          let body: object;
          switch (operation) {
            case 'list': body = { instances: state.locals }; break;
            case 'headroom': body = { cap: 3, instances: state.locals.length, remaining: 3 - state.locals.length,
              cpus: 4, load: { one: 0, five: 0, fifteen: 0 }, memory: { totalBytes: 1024, availableBytes: 512 },
              disk: { totalBytes: 1024, freeBytes: 512 } }; break;
            case 'create': {
              const instance = local(name!);
              state.locals.push(instance);
              // Keep successful API creates out of the 60-second GitHub polling path.
              state.runners.push({ id: 1, name: name!, os: 'linux', status: 'online', busy: false, labels: [] });
              body = instance;
              break;
            }
            case 'remove':
              state.locals = state.locals.filter((instance) => instance.name !== name);
              body = { name, deregisteredLocally: false };
              break;
            case 'start': case 'stop': case 'restart': {
              const instance = state.locals.find((instance) => instance.name === name);
              assert.ok(instance);
              instance.active = operation === 'stop' ? 'inactive' : 'active';
              body = { name, unit: instance.unit, active: instance.active };
              break;
            }
            default: throw new Error(`Unexpected synthetic operation ${operation}`);
          }
          const hold = state.hold;
          if (hold?.operation === operation) {
            state.hold = null;
            hold.entered.resolve();
            await hold.release.promise;
          }
          if (fault === 'partial-create' || fault === 'partial-remove') return;
          stream.write(JSON.stringify({ ...body, ok: true }));
          stream.exit(0);
          stream.end();
        }
      });
    }));
  });
  async function close() {
    for (const hold of holds) hold.resolve();
    try {
      for (const connection of connections) connection.end();
      await Promise.all([
        app.close(),
        server.address() ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve(),
      ]);
      assert.equal(server.address(), null, 'SSH fixture listener was closed');
    } finally { await rm(dir, { recursive: true, force: true }); }
    assert.deepEqual(protocolErrors, [], 'fake SSH server encountered an unexpected protocol error');
  }
  try {
    const keyPath = join(dir, 'client-key');
    await writeFile(keyPath, client.private, { mode: 0o600 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const config = { publicBaseUrl: 'http://127.0.0.1',
      vm: { host: '127.0.0.1', port: address.port, user: 'synthetic', privateKeyPath: keyPath,
        hostKey: options.wrongHostKey ? client.public : host.public, connectTimeoutMs: 1500, commandTimeoutMs: 1500 },
      github: { scope: 'org', runnerGroup }, runners: { cap: 3, defaultLabels: ['linux', 'default'], protectedNames: [] },
    } as unknown as Config;
    const registry: RunnerRegistry = {
      async listRunners() { return structuredClone(state.runners); },
      async createRegistrationToken() { state.registryCalls.push('registration'); return { token: registrationToken, expiresAt: '' }; },
      async createRemoveToken() { state.registryCalls.push('removal'); return { token: removeToken, expiresAt: '' }; },
      async deleteRunner(id) {
        state.registryCalls.push(`delete:${id}`);
        state.runners = state.runners.filter((runner) => runner.id !== id);
      },
      describe: () => 'synthetic registry', registrationUrl: () => registrationUrl,
    };
    const sessions = new SessionStore('synthetic-session-secret-with-32-characters', 3600);
    const session = sessions.create({ sub: 'synthetic', username: 'tester', email: null, name: null, groups: [] });
    const headers = { cookie: `${SESSION_COOKIE}=${session}`, origin: config.publicBaseUrl };
    const audit = new AuditLog(join(dir, 'audit.jsonl'));
    await app.register(cookie);
    registerApiRoutes(app, { config, registry, sessions, audit,
      control: new RunnerVmControl(new RunnerVm(config.vm)),
      credential: { getToken: async () => 'synthetic', describe: () => 'synthetic' } });
    return { state, app, sessions, session, headers, audit, dir, close,
      hold(operation: string) {
        const hold = { operation, entered: deferred<void>(), release: deferred<void>() };
        holds.push(hold.release);
        state.hold = hold;
        return hold;
      },
      request: (method: 'POST' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers, payload }),
      async inventory() {
        const response = await app.inject({ url: '/api/inventory', headers });
        assert.equal(response.statusCode, 200, response.body);
        return response.json<Inventory>();
      },
    };
  } catch (error) { await close(); throw error; }
}

function mutations(commands: Command[]) {
  return commands.filter(({ argv }) => !['list', 'headroom'].includes(argv[0]!));
}

test('API lifecycle uses actual SSH with exact base64 argv and stdin-only tokens', { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const created = await f.request('POST', '/api/runners', { name: 'runner-1', labels: ['default', 'extra'] });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().confirmedInGitHub, true);
    assert.equal((await f.inventory()).runners[0]?.state, 'online');
    for (const [action, expected] of [['stop', 'stopped'], ['start', 'online'], ['restart', 'online']] as const) {
      const response = await f.request('POST', `/api/runners/runner-1/${action}`);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal((await f.inventory()).runners[0]?.state, expected);
    }
    const removed = await f.request('DELETE', '/api/runners/runner-1');
    assert.equal(removed.statusCode, 200, removed.body);
    assert.deepEqual((await f.inventory()).runners, []);
    assert.deepEqual(mutations(f.state.commands).map(({ argv, stdin }) => ({ argv, stdin })), [
      { argv: ['create', 'runner-1', 'linux,default,extra', registrationUrl, runnerGroup], stdin: registrationToken + '\n' },
      ...['stop', 'start', 'restart'].map((action) => ({ argv: [action, 'runner-1'], stdin: '' })),
      { argv: ['remove', 'runner-1'], stdin: removeToken + '\n' },
    ]);
    for (const { command, argv } of f.state.commands) {
      assert.equal(command, Buffer.from(JSON.stringify(argv)).toString('base64'));
      assert.match(command, /^[A-Za-z0-9+/]+={0,2}$/);
      assert.ok(!command.includes(registrationToken) && !command.includes(removeToken));
    }
    assert.deepEqual(f.state.registryCalls, ['registration', 'removal', 'delete:1']);
    const auditText = await readFile(join(f.dir, 'audit.jsonl'), 'utf8');
    for (const secret of [registrationToken, removeToken]) {
      assert.ok(!auditText.includes(secret));
      assert.ok(!created.body.includes(secret) && !removed.body.includes(secret));
    }
    assert.deepEqual((await f.audit.tail()).map(({ action, outcome }) => [action, outcome]),
      ['delete', 'restart', 'start', 'stop', 'create'].map((action) => [`runner.${action}`, 'success']));
  } finally { await f.close(); }
});

test('pinned host mismatch blocks API mutations before SSH authentication or token minting', { timeout: 10_000 }, async () => {
  const f = await fixture({ wrongHostKey: true });
  try {
    const response = await f.request('POST', '/api/runners', { name: 'runner-1' });
    assert.ok(response.statusCode >= 500, response.body);
    assert.deepEqual(f.state.commands, []);
    assert.equal(f.state.authentications, 0);
    assert.deepEqual(f.state.registryCalls, []);
    assert.deepEqual(f.state.locals, []);
    assert.equal((await f.audit.tail())[0]?.outcome, 'failure');
  } finally { await f.close(); }
});

test('shell syntax in API names or labels is refused before reaching SSH', async () => {
  const f = await fixture();
  try {
    for (const payload of [{ name: 'runner;id' }, { name: 'runner-1', labels: ['$(id)'] }]) {
      assert.equal((await f.request('POST', '/api/runners', payload)).statusCode, 400);
    }
    for (const method of ['POST', 'DELETE'] as const) {
      const url = '/api/runners/' + encodeURIComponent('runner;id') + (method === 'POST' ? '/restart' : '');
      assert.equal((await f.request(method, url)).statusCode, 400);
    }
    assert.deepEqual(f.state.commands, []);
    assert.deepEqual(f.state.registryCalls, []);
  } finally { await f.close(); }
});

for (const fault of ['nonzero', 'refused', 'malformed', 'invalid-shape', 'disconnect', 'timeout'] as const) {
  test(`SSH ${fault} removal returns failure, retains registration and allows retry`, { timeout: 15_000 }, async () => {
    const f = await fixture();
    try {
      assert.equal((await f.request('POST', '/api/runners', { name: 'runner-1' })).statusCode, 200);
      f.state.fault = fault;
      const response = await f.request('DELETE', '/api/runners/runner-1');
      assert.equal(response.statusCode, 502, response.body);
      assert.ok(!response.body.includes(removeToken));
      assert.equal(f.state.locals.length, 1);
      assert.equal(f.state.runners.length, 1);
      assert.ok(!f.state.registryCalls.includes('delete:1'));
      assert.equal((await f.audit.tail())[0]?.outcome, 'failure');
      assert.ok(!JSON.stringify(await f.audit.tail()).includes(removeToken));
      f.state.fault = null;
      assert.equal((await f.request('DELETE', '/api/runners/runner-1')).statusCode, 200);
      assert.deepEqual((await f.inventory()).runners, []);
    } finally { await f.close(); }
  });
}

for (const operation of ['create', 'remove'] as const) {
  test(`SSH timeout after partial ${operation} leaves visible state that can be cleaned up`, { timeout: 15_000 }, async () => {
    const f = await fixture();
    try {
      if (operation === 'remove') assert.equal((await f.request('POST', '/api/runners', { name: 'runner-1' })).statusCode, 200);
      f.state.fault = operation === 'create' ? 'partial-create' : 'partial-remove';
      const started = Date.now();
      const response = operation === 'create'
        ? await f.request('POST', '/api/runners', { name: 'runner-1' })
        : await f.request('DELETE', '/api/runners/runner-1');
      assert.equal(response.statusCode, 502, response.body);
      assert.ok(Date.now() - started >= 1500, 'the unresponsive SSH command reached its deadline');
      assert.match(response.json().error, /could not be confirmed/);
      assert.equal(response.json().operationState, 'failed');
      assert.match(response.json().hint, /Refresh inventory/i);
      assert.equal(f.state.runners.length, 1);
      assert.ok(!f.state.registryCalls.includes('delete:1'));
      assert.equal((await f.audit.tail())[0]?.outcome, 'failure');
      const inventory = await f.inventory();
      assert.equal(inventory.runners[0]?.state, operation === 'create' ? 'online' : 'orphan-github');
      assert.equal(inventory.runners[0]?.actions.delete, true);
      const count = mutations(f.state.commands).length;
      assert.equal((await f.request('POST', '/api/runners', { name: 'runner-1' })).statusCode, 409);
      assert.equal(mutations(f.state.commands).length, count);
      f.state.fault = null;
      assert.equal((await f.request('DELETE', '/api/runners/runner-1')).statusCode, 200);
      assert.deepEqual((await f.inventory()).runners, []);
    } finally { await f.close(); }
  });
}

test('session revoked while SSH inventory is pending prevents privileged mutation', { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    const hold = f.hold('list');
    const response = Promise.resolve(f.request('POST', '/api/runners', { name: 'runner-1' }));
    await Promise.race([hold.entered.promise, response.then((reply) => {
      assert.fail(`Request completed before reaching the SSH hold: ${reply.statusCode} ${reply.body}`);
    })]);
    f.sessions.destroy(f.session);
    hold.release.resolve();
    assert.equal((await response).statusCode, 401);
    assert.ok(f.state.commands.some(({ argv }) => argv[0] === 'list'));
    assert.deepEqual(mutations(f.state.commands), []);
    assert.deepEqual(f.state.registryCalls, []);
    assert.deepEqual(f.state.locals, []);
    assert.deepEqual(f.state.runners, []);
    assert.equal((await f.audit.tail())[0]?.outcome, 'failure');
  } finally { await f.close(); }
});

for (const operation of ['list', 'remove'] as const) {
  test(`HTTP disconnect during SSH ${operation} preserves recoverable state`, { timeout: 15_000 }, async () => {
    const f = await fixture();
    let request: ReturnType<typeof httpRequest> | undefined;
    try {
      const socketClosed = deferred<void>();
      const sent = deferred<{ status: number; body: string }>();
      f.app.addHook('onRequest', async (req) => { req.raw.socket.once('close', () => socketClosed.resolve()); });
      f.app.addHook('onSend', async (_req, reply, payload) => {
        sent.resolve({ status: reply.statusCode, body: String(payload) });
        return payload;
      });
      // Seed synthetic state without an earlier request consuming the hooks.
      f.state.locals.push(local('runner-1'));
      f.state.runners.push({ id: 1, name: 'runner-1', os: 'linux', status: 'online', busy: false, labels: [] });
      const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
      const hold = f.hold(operation);
      request = httpRequest(base + (operation === 'list' ? '/api/runners/runner-1/restart' : '/api/runners/runner-1'),
        { method: operation === 'list' ? 'POST' : 'DELETE', headers: f.headers });
      // A client cancellation deliberately produces a socket hang-up.
      request.on('error', () => {});
      request.end();
      await Promise.race([hold.entered.promise, sent.promise.then((reply) => {
        assert.fail(`Request completed before reaching the SSH hold: ${reply.status} ${reply.body}`);
      })]);
      request.destroy();
      await socketClosed.promise;
      hold.release.resolve();
      const response = await sent.promise;
      assert.equal(response.status, 409, response.body);
      assert.equal((await f.audit.tail())[0]?.outcome, 'failure');
      assert.ok(!f.state.registryCalls.includes('delete:1'));
      if (operation === 'list') {
        assert.deepEqual(mutations(f.state.commands), []);
        assert.deepEqual(f.state.registryCalls, []);
        assert.equal((await f.inventory()).runners[0]?.state, 'online');
        assert.equal((await f.request('POST', '/api/runners/runner-1/stop')).statusCode, 200);
        assert.equal((await f.inventory()).runners[0]?.state, 'stopped');
      } else {
        assert.equal((await f.inventory()).runners[0]?.state, 'orphan-github');
        assert.deepEqual(mutations(f.state.commands).map(({ argv }) => argv), [['remove', 'runner-1']]);
        assert.equal((await f.request('DELETE', '/api/runners/runner-1')).statusCode, 200);
        assert.deepEqual((await f.inventory()).runners, []);
      }
    } finally { request?.destroy(); await f.close(); }
  });
}
