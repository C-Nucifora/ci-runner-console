const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Bound the entire response read, including chunked and decoded bodies. */
export async function boundedFetch(url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const response = await fetch(url, { ...init, signal, redirect: 'error' });
  const reader = response.body?.getReader();
  if (!reader) return response;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('HTTP response exceeds size limit');
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
  return new Response(Buffer.concat(chunks), {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}
