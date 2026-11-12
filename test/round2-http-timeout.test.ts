import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

// Run serially under heavy.lock. The child owns its loopback server and GC flags.
async function stalledBodyProbe(httpModuleUrl: string, collect: boolean) {
  const { createServer } = await import('node:http');
  const { boundedFetch } = await import(httpModuleUrl);
  const events: { event: string; ms: number; name?: string }[] = [];
  const start = performance.now();
  const record = (event: string, error?: unknown) => events.push({
    event, ms: Math.round(performance.now() - start),
    ...(error instanceof Error ? { name: error.name } : {}),
  });
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  let deadline: AbortSignal | undefined;
  AbortSignal.timeout = () => {
    deadline = nativeTimeout(400);
    deadline.addEventListener('abort', () => record('deadline fired'), { once: true });
    return deadline;
  };
  const timers: ReturnType<typeof setTimeout>[] = [];
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await nativeFetch(url, init);
    record('headers received');
    if (collect) {
      for (const delay of [30, 70, 110, 150]) {
        timers.push(setTimeout(() => { global.gc!(); record('gc'); }, delay));
      }
    }
    return response;
  };
  const originalRead = ReadableStreamDefaultReader.prototype.read;
  ReadableStreamDefaultReader.prototype.read = function () {
    record('read started');
    return originalRead.call(this).then(value => {
      record(value.done ? 'read ended' : 'chunk read');
      return value;
    }, error => { record('read rejected', error); throw error; });
  };
  const originalCancel = ReadableStreamDefaultReader.prototype.cancel;
  ReadableStreamDefaultReader.prototype.cancel = function (reason) {
    record('cancel started');
    return originalCancel.call(this, reason).then(() => { record('cancel resolved'); }, error => {
      record('cancel rejected', error); throw error;
    });
  };
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let outcome = 'pending';
  let rejection: string | undefined;
  const work = boundedFetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    .then(() => { outcome = 'resolved'; }, (error: Error) => {
      outcome = 'rejected'; rejection = error.name; record('operation rejected', error);
    });
  let observed;
  try {
    await Promise.race([work, new Promise<void>(resolve => {
      timers.push(setTimeout(resolve, 1_000));
    })]);
    // Capture before closing sockets so fixture cleanup cannot masquerade as a deadline.
    observed = { outcome, rejection, aborted: deadline?.aborted, events: [...events] };
  } finally {
    timers.forEach(clearTimeout);
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    await work;
  }
  process.stdout.write(JSON.stringify({ ...observed, fixtureClosed: server.address() === null }));
}

for (const collect of [false, true]) {
  test(`R2 body deadline rejects with a retained signal${collect ? ' after GC' : ''}`, { timeout: 7_000 }, async t => {
    const moduleUrl = new URL('../src/http.js', import.meta.url).href;
    const script = `(${stalledBodyProbe.toString()})(${JSON.stringify(moduleUrl)}, ${collect})`;
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      ['--expose-gc', '--input-type=module', '--eval', script], {
        cwd: process.cwd(),
        timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' },
      });
    assert.equal(stderr, '');
    const result = JSON.parse(stdout);
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.fixtureClosed, true);
    assert.equal(result.aborted, true, 'the retained timeout signal must fire');
    assert.ok(result.events.some((entry: { event: string }) => entry.event === 'chunk read'));
    assert.equal(result.outcome, 'rejected', 'body read must settle before fixture cleanup');
    assert.equal(result.rejection, 'TimeoutError');
    assert.ok(result.events.some((entry: { event: string }) => entry.event === 'cancel started'));
  });
}
