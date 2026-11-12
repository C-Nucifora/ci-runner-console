import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Octokit } from '@octokit/rest';
import { RepoRunnerRegistry, OrgRunnerRegistry, GitHubApiError } from '../src/github/registry.js';

const credential = { getToken: async () => 'synthetic-secret', describe: () => 'synthetic' };
const raw = { id: 1, name: 'runner', os: 'linux', busy: false, status: 'online', labels: [{ name: 'linux' }] };
function registry(scope: 'repo' | 'org', responses: { body: unknown; status?: number }[]) {
  const urls: string[] = [];
  const client = new Octokit({ baseUrl: 'http://127.0.0.1', auth: 'synthetic-secret', log: { debug() {}, info() {}, warn() {}, error() {} }, request: {
    fetch: async (url: string) => {
      urls.push(String(url));
      const response = responses.shift();
      assert.ok(response, 'unexpected API call');
      return new Response(JSON.stringify(response.body), { status: response.status ?? 200,
        headers: { 'content-type': 'application/json' } });
    },
  } });
  class Repo extends RepoRunnerRegistry { protected override async client() { return client; } }
  class Org extends OrgRunnerRegistry { protected override async client() { return client; } }
  return { urls, instance: scope === 'repo'
    ? new Repo(credential, 'http://127.0.0.1', 'synthetic', 'synthetic')
    : new Org(credential, 'http://127.0.0.1', 'synthetic') };
}

for (const scope of ['repo', 'org'] as const) {
  test(`${scope} malformed or incomplete GitHub inventory fails closed`, async () => {
    for (const body of [{}, [], { total_count: 0 }, { total_count: 1, runners: [] },
      { total_count: 1, runners: [{ ...raw, busy: undefined }] },
      { total_count: 1, runners: [{ ...raw, status: 'unexpected' }] },
      { total_count: 1, runners: [{ ...raw, id: '1' }] },
      { total_count: 10_001, runners: [raw] },
      { total_count: 101, runners: Array.from({ length: 101 }, (_, i) => ({ ...raw, id: i + 1 })) },
      { total_count: 2, runners: [raw] }]) {
      await assert.rejects(registry(scope, [{ body }]).instance.listRunners(), GitHubApiError);
    }
    assert.deepEqual(await registry(scope, [{ body: { total_count: 0, runners: [] } }]).instance.listRunners(), []);
  });
  test(`${scope} collects every page and rejects repeated ids`, async () => {
    const f = registry(scope, [
      { body: { total_count: 101, runners: Array.from({ length: 100 }, (_, i) => ({ ...raw, id: i + 1 })) } },
      { body: { total_count: 101, runners: [{ ...raw, id: 101 }] } },
    ]);
    assert.deepEqual((await f.instance.listRunners()).map((r) => r.id), Array.from({ length: 101 }, (_, i) => i + 1));
    assert.ok(f.urls[1]?.includes('page=2'));
    await assert.rejects(registry(scope, [
      { body: { total_count: 101, runners: Array.from({ length: 100 }, (_, i) => ({ ...raw, id: i + 1 })) } },
      { body: { total_count: 101, runners: [raw] } },
    ]).instance.listRunners(), GitHubApiError);
  });
  test(`${scope} response errors and malformed tokens never expose upstream text`, async () => {
    for (const action of ['listRunners', 'createRegistrationToken', 'createRemoveToken', 'deleteRunner'] as const) {
      const f = registry(scope, [{ status: 403, body: { message: 'synthetic-secret private upstream content' } }]);
      await assert.rejects(f.instance[action](1), (error: unknown) => {
        assert.ok(error instanceof GitHubApiError);
        assert.ok(!JSON.stringify(error).includes('synthetic-secret'));
        assert.ok(!error.message.includes('private upstream'));
        return true;
      });
    }
    await assert.rejects(registry(scope, [{ body: { token: { secret: 'synthetic-secret' } } }]).instance.createRegistrationToken(),
      (error: unknown) => error instanceof GitHubApiError && !error.message.includes('synthetic-secret'));
  });
}


test('changing pagination totals fail closed without fetching more pages', async () => {
  for (const scope of ['repo', 'org'] as const) {
    const f = registry(scope, [
      { body: { total_count: 101, runners: Array.from({ length: 100 }, (_, i) => ({ ...raw, id: i + 1 })) } },
      { body: { total_count: 102, runners: [{ ...raw, id: 101 }, { ...raw, id: 102 }] } },
    ]);
    await assert.rejects(f.instance.listRunners(), GitHubApiError);
    assert.equal(f.urls.length, 2);
  }
});

test('real client aborts stalled requests and body reads with bounded timeouts', async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    deadlines.push(ms);
    return timeout(ms === 10_000 ? 5 : ms);
  });
  for (const phase of ['headers', 'body']) {
    t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      assert.ok(init);
      assert.equal(init.redirect, 'error');
      const signal = init.signal as AbortSignal;
      if (phase === 'headers') return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      } }), { headers: { 'content-type': 'application/json' } });
    });
    const instances = [new RepoRunnerRegistry(credential, 'http://127.0.0.1', 'synthetic', 'synthetic'),
      new OrgRunnerRegistry(credential, 'http://127.0.0.1', 'synthetic')];
    // AbortSignal timers are unref'd; keep this isolated test alive until they fire.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      for (const instance of instances) {
        for (const action of ['listRunners', 'createRegistrationToken', 'createRemoveToken', 'deleteRunner'] as const) {
          await assert.rejects(instance[action](1), GitHubApiError);
        }
      }
    } finally { clearTimeout(keepAlive); }
  }
  assert.equal(deadlines.filter((ms) => ms === 10_000).length, 16);
  assert.equal(deadlines.filter((ms) => ms === 30_000).length, 4);
});

test('real client cancels oversized response streams before parsing JSON', async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } }));
  const instance = new RepoRunnerRegistry(credential, 'http://127.0.0.1', 'synthetic', 'synthetic');
  await assert.rejects(instance.listRunners(), GitHubApiError);
  assert.equal(cancelled, true);
});
