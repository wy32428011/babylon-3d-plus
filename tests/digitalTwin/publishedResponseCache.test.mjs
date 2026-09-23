import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const base = 'https://fixture.test/digital-twin/releases/12/34/';
const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = new TextEncoder().encode('a published response');
const file = { path: 'assets/app.js', size: bytes.length, sha256: sha(bytes), contentType: 'text/javascript', storage: 'response' };

async function fixture() {
  const events = new Map();
  const data = new Map();
  let quota = false;
  let responseFactory;
  const counts = new Map();
  const manifest = { version: 1, cacheRevision: 'r34', totalBytes: bytes.length, files: [file] };
  const caches = {
    keys: async () => [...data.keys()],
    open: async name => {
      if (!data.has(name)) data.set(name, new Map());
      const values = data.get(name);
      return {
        match: async key => values.get(typeof key === 'string' ? key : key.url)?.clone(),
        put: async (key, value) => { if (quota) throw new DOMException('Full', 'QuotaExceededError'); values.set(typeof key === 'string' ? key : key.url, new Response(await value.arrayBuffer(), { status: value.status, headers: value.headers })); },
        delete: async key => values.delete(typeof key === 'string' ? key : key.url),
      };
    },
  };
  const context = vm.createContext({ URL, Request, Response, Headers, ReadableStream, TransformStream, TextEncoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, AbortController, DOMException, Set, Map, Math, Number, String, JSON, Promise, crypto: webcrypto, caches,
    fetch: async (input, options) => {
      const url = typeof input === 'string' ? input : input.url;
      counts.set(url, (counts.get(url) ?? 0) + 1);
      if (url === base + 'release-cache-manifest.json') return Response.json(manifest);
      if (responseFactory) return responseFactory(options);
      return new Response(bytes, { headers: { 'Content-Type': file.contentType } });
    },
    self: { registration: { scope: base }, location: new URL(base + 'published-cache-worker.js'), clients: { claim: async () => {} }, addEventListener: (name, fn) => events.set(name, fn), skipWaiting: async () => {} },
  });
  vm.runInContext(await readFile(new URL('../../public/published-cache-worker.js', import.meta.url), 'utf8'), context);
  let requestId = 0;
  async function message(type, extra = {}) {
    let result;
    let pending;
    events.get('message')({ data: { protocol: 1, type, sessionId: 'test-session', requestId: String(++requestId), cacheRevision: 'r34', ...extra }, source: { id: 'test-client', url: base }, ports: [{ postMessage: value => { result = value; } }], waitUntil: value => { pending = value; } });
    await pending;
    return result;
  }
  async function request(path, options) {
    let response;
    const pending = [];
    events.get('fetch')({ request: new Request(base + path, options), respondWith: value => { response = value; }, waitUntil: value => pending.push(value) });
    const result = response ? await response : undefined;
    await Promise.all(pending);
    return result;
  }
  return { context, data, counts, caches, manifest, message, request, setQuota: value => { quota = value; }, setResponse: factory => { responseFactory = factory; } };
}

test('incremental SHA-256 matches trusted hashes across stream boundaries', async () => {
  const f = await fixture();
  for (const length of [0, 1, 55, 56, 63, 64, 65, 129, 100000]) {
    const input = Uint8Array.from({ length }, (_, i) => i % 251);
    f.context.input = input;
    const actual = await vm.runInContext('hashResponse(new Response(input))', f.context);
    assert.equal(actual.hash, sha(input));
    assert.equal(actual.size, length);
  }
  const input = Uint8Array.from({ length: 65539 }, (_, i) => i % 251);
  f.context.input = input;
  const chunked = await vm.runInContext(`hashResponse(new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < input.length; offset += 997) controller.enqueue(input.subarray(offset, offset + 997)); controller.close();
  } })))`, f.context);
  assert.equal(chunked.hash, sha(input));
});

test('response manifest excludes raw assets, config, traversal and duplicate paths', async () => {
  const f = await fixture();
  assert.equal((await f.message('configure')).ok, true);
  assert.equal((await f.message('ensure', { path: file.path })).ok, true);
  assert.equal((await f.message('ensure', { path: 'project/assets/raw.glb' })).ok, false);
  assert.equal((await f.message('ensure', { path: 'runtime-config.json' })).ok, false);
  for (const path of ['../evil.js', '%2e%2e/evil.js', 'assets/app.js?token=secret', '/absolute.js', 'assets\\evil.js']) {
    const other = await fixture(); other.manifest.files = [{ ...file, path }];
    assert.equal((await other.message('configure')).ok, false, path);
  }
  const other = await fixture(); other.manifest.files.push(file);
  assert.equal((await other.message('configure')).ok, false);
});

test('ensure coalesces downloads and cached responses are hash verified on every read', async () => {
  const f = await fixture();
  await f.message('configure');
  assert.equal((await Promise.all([f.message('ensure', { path: file.path }), f.message('ensure', { path: file.path })])).every(x => x.ok), true);
  assert.equal(f.counts.get(base + file.path), 1);
  assert.equal(await (await f.request(file.path)).text(), new TextDecoder().decode(bytes));
  assert.equal(f.counts.get(base + file.path), 1);
  const values = [...f.data.values()][0];
  values.set(base + file.path, new Response('corrupt'));
  assert.equal((await f.message('has', { path: file.path })).ok, false);
  assert.equal((await f.message('ensure', { path: file.path })).ok, true);
  assert.equal(f.counts.get(base + file.path), 2);
});

test('ranges read cached bytes and unsupported/unlisted requests bypass caching', async () => {
  const f = await fixture(); await f.message('configure'); await f.message('ensure', { path: file.path });
  const response = await f.request(file.path, { headers: { Range: 'bytes=2-7' } });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), new TextDecoder().decode(bytes.slice(2, 8)));
  assert.equal(await f.request('unknown.js'), undefined);
  assert.equal(await f.request(file.path, { method: 'POST', body: 'data' }), undefined);
  assert.equal(await f.request(file.path, { headers: { Authorization: 'Bearer private' } }), undefined);
});

test('quota failure returns network response, reports incomplete and allows later repair', async () => {
  const f = await fixture(); await f.message('configure'); f.setQuota(true);
  assert.equal(await (await f.request(file.path)).text(), new TextDecoder().decode(bytes));
  assert.equal((await f.message('has', { path: file.path })).ok, false);
  assert.equal((await f.message('ensure', { path: file.path })).ok, false);
  f.setQuota(false);
  assert.equal((await f.message('ensure', { path: file.path })).ok, true);
});

test('oversized streams abort before consuming the full response and remove partial writes', async () => {
  for (const native of [false, true]) {
    const f = await fixture(); await f.message('configure');
    let aborted = false;
    let chunks = 0;
    f.setResponse(options => new Response(new ReadableStream({
      start(controller) { options.signal.addEventListener('abort', () => { aborted = true; controller.error(new DOMException('Aborted', 'AbortError')); }, { once: true }); },
      pull(controller) { controller.enqueue(new Uint8Array(16)); if (++chunks === 100) controller.close(); },
    })));
    if (native) {
      const response = await f.request(file.path);
      await assert.rejects(response.text());
    } else assert.equal((await f.message('ensure', { path: file.path })).ok, false);
    assert.equal(aborted, true, 'the shared fetch controller must cancel both cache and validation streams');
    assert.ok(chunks < 100, 'an oversized body must not be fully downloaded');
    assert.equal((await f.message('has', { path: file.path })).ok, false);
  }
});

test('HTTP error responses remain readable and are never saved as static files', async () => {
  const f = await fixture(); await f.message('configure');
  const body = 'not found '.repeat(100);
  f.setResponse(() => new Response(body, { status: 404 }));
  const response = await f.request(file.path);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), body);
  assert.equal((await f.message('has', { path: file.path })).ok, false);
});
