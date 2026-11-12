import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { boundedFetch } from '../src/http.js';

// Serial under heavy.lock. Mock fetch deliberately omits Undici's abort handling.
for (const phase of ['before-reader', 'pending-read', 'chunk-ready', 'eof-ready', 'cancel-rejects']) {
  test(`abort review: ${phase} rejects and releases the reader and listener`, { timeout: 2_000 }, async t => {
    const caller = new AbortController();
    const reason = new Error(`synthetic ${phase}`);
    let signal: AbortSignal | undefined;
    let cancellations = 0;
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (phase === 'before-reader') return;
        if (phase === 'chunk-ready') controller.enqueue(new Uint8Array([1]));
        if (phase === 'eof-ready') controller.close();
        caller.abort(reason);
      },
      cancel(value) {
        cancellations++;
        cancelReason = value;
        if (phase === 'cancel-rejects') return Promise.reject(new Error('synthetic cancel failure'));
      },
    }, { highWaterMark: 0 });
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      signal = init.signal!;
      assert.equal(init.redirect, 'error');
      if (phase === 'before-reader') caller.abort(reason);
      return new Response(body);
    });
    await assert.rejects(boundedFetch('http://127.0.0.1', { signal: caller.signal }), error => error === reason);
    assert.equal(body.locked, false);
    assert.equal(getEventListeners(signal!, 'abort').length, 0);
    assert.equal(cancellations, phase === 'eof-ready' ? 0 : 1);
    if (cancellations) assert.equal(cancelReason, reason);
  });
}

for (const outcome of ['success', 'read-error', 'oversize']) {
  test(`abort review: ${outcome} removes listener before a later abort`, { timeout: 2_000 }, async t => {
    const caller = new AbortController();
    const failure = new Error('synthetic read error');
    let signal: AbortSignal | undefined;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (outcome === 'read-error') { controller.error(failure); return; }
        controller.enqueue(new Uint8Array(outcome === 'oversize' ? 2 * 1024 * 1024 + 1 : 1));
        if (outcome === 'success') controller.close();
      },
      cancel() { cancellations++; },
    });
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      signal = init.signal!;
      return new Response(body);
    });
    const work = boundedFetch('http://127.0.0.1', { signal: caller.signal });
    if (outcome === 'success') assert.equal((await (await work).arrayBuffer()).byteLength, 1);
    else if (outcome === 'read-error') await assert.rejects(work, error => error === failure);
    else await assert.rejects(work, /size limit/);
    assert.equal(body.locked, false);
    assert.equal(getEventListeners(signal!, 'abort').length, 0);
    const before = cancellations;
    caller.abort(new Error('late abort'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cancellations, before);
    assert.equal(cancellations, outcome === 'oversize' ? 1 : 0);
  });
}

// Compile to a src/test layout before invoking: child imports the emitted helper.
async function combinedSignalProbe(moduleUrl: string, source: string) {
  const { boundedFetch } = await import(moduleUrl);
  const { createServer } = await import('node:http');
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  let deadline: AbortSignal | undefined;
  AbortSignal.timeout = () => { deadline = nativeTimeout(source === 'deadline' ? 400 : 2_000); return deadline; };
  const caller = new AbortController();
  const reason = new Error('synthetic caller cancellation');
  const timers: ReturnType<typeof setTimeout>[] = [];
  let collections = 0;
  let headers = false;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await nativeFetch(url, init);
    headers = true;
    for (const delay of [30, 70, 110]) timers.push(setTimeout(() => { global.gc!(); collections++; }, delay));
    if (source === 'caller') timers.push(setTimeout(() => caller.abort(reason), 250));
    return response;
  };
  const server = createServer((_req, res) => { res.writeHead(200); res.write('x'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let outcome = 'pending';
  let errorName: string | undefined;
  let sameReason = false;
  const work = boundedFetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { signal: caller.signal })
    .then(() => { outcome = 'resolved'; }, (error: Error) => {
      outcome = 'rejected'; errorName = error.name; sameReason = error === reason;
    });
  let observed;
  try {
    await Promise.race([work, new Promise<void>(resolve => timers.push(setTimeout(resolve, 1_200)))]);
    observed = { outcome, errorName, sameReason, collections, headers, deadlineAborted: deadline?.aborted };
  } finally {
    timers.forEach(clearTimeout);
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    await work;
  }
  process.stdout.write(JSON.stringify({ ...observed, fixtureClosed: server.address() === null }));
}

for (const source of ['caller', 'deadline']) {
  test(`abort review: combined ${source} signal survives GC during a native body read`, { timeout: 7_000 }, async t => {
    const script = `(${combinedSignalProbe.toString()})(${JSON.stringify(new URL('../src/http.js', import.meta.url).href)}, ${JSON.stringify(source)})`;
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      ['--expose-gc', '--input-type=module', '--eval', script], {
        cwd: process.cwd(), timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024,
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' },
      });
    assert.equal(stderr, '');
    const result = JSON.parse(stdout);
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.fixtureClosed, true);
    assert.equal(result.headers, true);
    assert.equal(result.collections, 3);
    assert.equal(result.outcome, 'rejected', 'must reject before fixture teardown');
    assert.equal(result.errorName, source === 'caller' ? 'Error' : 'TimeoutError');
    assert.equal(result.sameReason, source === 'caller');
    assert.equal(result.deadlineAborted, source === 'deadline');
  });
}
