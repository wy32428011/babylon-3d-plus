import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { PublishedAssetCache, type PublishedCacheStore } from '../../src/runtime/assets/publishedAssetCache.ts';
import { installPublishedAssetCache } from '../../src/runtime/assets/runtimeAssetFetch.ts';
import { readSkyboxTextureBlob } from '../../src/runtime/babylon/skyboxTextureLoad.ts';

function memoryStore(): PublishedCacheStore {
  const records = new Map<string, unknown>();
  return { async get(key) { return structuredClone(records.get(key)); }, async put(key, value) { records.set(key, structuredClone(value)); } };
}
function session(store: PublishedCacheStore, revision = 'release-1', base = 'http://viewer.test/a/') {
  return new PublishedAssetCache({ baseUrl: base, revision, assetBase: new URL('project/assets/', base).href,
    documentUrls: [new URL('project/scene.json', base).href], store });
}

test('刷新创建新会话后，同版本天空盒只下载一次，新版本重新下载，回滚复用旧版本', async () => {
  const original = globalThis.fetch;
  const store = memoryStore();
  let downloads = 0;
  globalThis.fetch = async () => { downloads++; return new Response(new Uint8Array([downloads, 2, 3])); };
  try {
    for (const [revision, expected] of [['release-1', 1], ['release-1', 1], ['release-2', 2], ['release-1', 1]] as const) {
      const cache = session(store, revision);
      const restore = installPublishedAssetCache(cache);
      const blob = await readSkyboxTextureBlob('http://viewer.test/a/project/assets/sky.hdr', new AbortController().signal);
      assert.equal(new Uint8Array(await blob.arrayBuffer())[0], expected);
      restore(); cache.dispose();
    }
    assert.equal(downloads, 2);
  } finally { globalThis.fetch = original; }
});

test('解码结果跨会话复用并保持实例数据独立，参数、版本和项目均隔离', async () => {
  const store = memoryStore();
  let decodes = 0;
  const decode = async () => { decodes++; return new Uint8Array([4, 5, 6]); };
  const data = new Uint8Array([1, 2, 3]);
  const validate = (value: unknown): value is Uint8Array => value instanceof Uint8Array && value.length === 3;
  const first = await session(store).decode('decoder-v1', data, decode, validate, value => value.byteLength);
  first[0] = 99;
  assert.deepEqual(await session(store).decode('decoder-v1', data, decode, validate, value => value.byteLength), new Uint8Array([4, 5, 6]));
  assert.equal(decodes, 1);
  await session(store).decode('decoder-v2', data, decode, validate, value => value.byteLength);
  await session(store, 'release-2').decode('decoder-v1', data, decode, validate, value => value.byteLength);
  await session(store, 'release-1', 'http://viewer.test/b/').decode('decoder-v1', data, decode, validate, value => value.byteLength);
  assert.equal(decodes, 4);
});

test('仅缓存部署目录静态资源；实时接口、跨源 URL、旧包均不进入缓存', () => {
  const cache = session(memoryStore());
  assert.equal(cache.accepts('http://viewer.test/a/project/assets/model.glb?rev=1'), true);
  assert.equal(cache.accepts('http://viewer.test/a/project/scene.json'), true);
  for (const url of ['http://viewer.test/api/data', 'http://viewer.test/a/runtime-config.json',
    'http://other.test/a/project/assets/model.glb', 'http://viewer.test/a/project/assets/../private', 'blob:http://viewer.test/id']) {
    assert.equal(cache.accepts(url), false, url);
  }
});

test('存储故障不阻断加载，失败响应不缓存，取消不读取过期结果', async () => {
  const original = globalThis.fetch;
  const broken: PublishedCacheStore = { async get() { throw new Error('denied'); }, async put() { throw new Error('quota'); } };
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('ok', { status: calls === 1 ? 503 : 200 }); };
  const cache = session(broken);
  try {
    const url = 'http://viewer.test/a/project/assets/model.glb';
    assert.equal((await cache.fetch(url)).status, 503);
    assert.equal(await (await cache.fetch(url)).text(), 'ok');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(cache.fetch(url, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; cache.dispose(); }
});

test('缓存路径配置为站点根时仍不能缓存实时接口', () => {
  const cache = new PublishedAssetCache({ baseUrl: 'http://viewer.test/', revision: 'v1', assetBase: 'http://viewer.test/', documentUrls: [] });
  assert.equal(cache.accepts('http://viewer.test/api/config'), false);
  cache.dispose();
});

test('未知长度响应仍保留天空盒限额，超限数据不进入缓存', async () => {
  const original = globalThis.fetch;
  const store = memoryStore();
  let writes = 0;
  const put = store.put; store.put = async (...args) => { writes++; await put(...args); };
  globalThis.fetch = async () => new Response(new Uint8Array(5));
  const cache = session(store);
  const restore = installPublishedAssetCache(cache);
  try {
    await assert.rejects(readSkyboxTextureBlob('http://viewer.test/a/project/assets/sky.hdr', new AbortController().signal, 4), /读取上限/);
    assert.equal(writes, 0);
  } finally { globalThis.fetch = original; restore(); cache.dispose(); }
});

test('取消会话后进行中的解码不提交缓存', async () => {
  const store = memoryStore();
  let writes = 0;
  store.put = async () => { writes++; };
  const cache = session(store);
  let finish!: () => void;
  const started = new Promise<void>(resolve => { finish = resolve; });
  let complete!: (value: Uint8Array) => void;
  const decode = cache.decode('deferred', new Uint8Array([1]), () => { finish(); return new Promise<Uint8Array>(resolve => { complete = resolve; }); },
    (value): value is Uint8Array => value instanceof Uint8Array, value => value.byteLength);
  await started; cache.dispose(); complete(new Uint8Array([5]));
  await assert.rejects(decode, { name: 'AbortError' });
  assert.equal(writes, 0);
});

test('损坏解码记录重算，解码失败不缓存', async () => {
  const store = memoryStore();
  store.get = async () => ({ invalid: true });
  let writes = 0; store.put = async () => { writes++; };
  const cache = session(store);
  const valid = (value: unknown): value is Uint8Array => value instanceof Uint8Array;
  assert.deepEqual(await cache.decode('test', new Uint8Array([1]), async () => new Uint8Array([2]), valid, value => value.byteLength), new Uint8Array([2]));
  await assert.rejects(cache.decode('test', new Uint8Array([1]), async () => { throw new Error('decode failed'); }, valid, value => value.byteLength), /decode failed/);
  assert.equal(writes, 1);
});

test('下载期间发布版本变化时拒绝写入，防止旧版本缓存混入新文件', async () => {
  const original = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async () => new Response('new version bytes');
  const cache = new PublishedAssetCache({ baseUrl: 'http://viewer.test/a/', revision: 'old',
    assetBase: 'http://viewer.test/a/project/assets/', documentUrls: [],
    store: { async get() { return undefined; }, async put() { writes++; } },
    async verifyRevision() { throw new Error('发布版本已变更'); } });
  try {
    await assert.rejects(cache.fetch('http://viewer.test/a/project/assets/model.glb'), /发布版本已变更/);
    assert.equal(writes, 0);
  } finally { cache.dispose(); globalThis.fetch = original; }
});

test('命中缓存和已声明长度都不能绕过调用方读取上限', async () => {
  const original = globalThis.fetch;
  let cancelled = false;
  const cache = session(memoryStore());
  const url = 'http://viewer.test/a/project/assets/file.bin';
  globalThis.fetch = async () => new Response(new Uint8Array(5), { headers: { 'content-length': '5' } });
  try {
    await cache.fetch(url);
    await assert.rejects(cache.fetch(url, {}, undefined, 4), /读取上限/);
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': '9' } });
    await assert.rejects(cache.fetch(url+'?uncached=1', {}, undefined, 4), /读取上限/);
    assert.equal(cancelled, true);
  } finally { cache.dispose(); globalThis.fetch = original; }
});

test('额度不足只降级缓存，POST 与自定义请求头不缓存', async () => {
  const original = globalThis.fetch;
  const seen: RequestInit[] = [];
  let writes = 0;
  const store: PublishedCacheStore = { async get() { return undefined; }, async put() { writes++; throw new Error('QuotaExceededError'); } };
  const cache = session(store);
  const url = 'http://viewer.test/a/project/assets/file.bin';
  globalThis.fetch = async (_url, init) => { seen.push(init ?? {}); return new Response('payload'); };
  try {
    assert.equal(await (await cache.fetch(url)).text(), 'payload');
    assert.equal(await (await cache.fetch(url)).text(), 'payload');
    await cache.fetch(url, { method: 'POST', body: 'live' });
    await cache.fetch(url, { headers: { Accept: 'application/json' } });
    assert.equal(writes, 1);
    assert.equal(cache.metrics.storageFailures, 1);
    assert.equal(seen[2].method, 'POST');
    assert.deepEqual(seen[3].headers, { Accept: 'application/json' });
  } finally { cache.dispose(); globalThis.fetch = original; }
});

test('并发缓存操作一起失败时只降级一次并继续完成全部网络加载', async context => {
  let fail!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
  const store: PublishedCacheStore = { get: () => pending, async put() {} };
  const warning = context.mock.method(console, 'warn', () => undefined);
  const network = context.mock.method(globalThis, 'fetch', async () => new Response('model'));
  const cache = session(store);
  const requests = Array.from({ length: 8 }, (_, index) => cache.fetch('http://viewer.test/a/project/assets/' + index + '.glb'));
  fail(new Error('发布缓存读写超时。'));
  const responses = await Promise.all(requests);
  assert.deepEqual(await Promise.all(responses.map(response => response.text())), Array(8).fill('model'));
  assert.equal(network.mock.callCount(), 8);
  assert.equal(warning.mock.callCount(), 1);
  assert.equal(cache.metrics.storageFailures, 1);
  cache.dispose();
});


test('旧格式清单只缓存列出的模型和天空盒，下载内容必须匹配哈希后才能跨会话复用', async t => {
  const store = memoryStore();
  const base = 'http://viewer.test/a/';
  const modelUrl = base + 'project/assets/model.glb';
  const skyboxUrl = base + 'project/assets/sky.hdr';
  const resources = new Map([modelUrl, skyboxUrl].map(url => [url, { size: 3, sha256: createHash('sha256').update('old').digest('hex') }]));
  const create = () => new PublishedAssetCache({baseUrl:base, revision:'legacy', assetBase:'project/assets/', documentUrls:[], store, resources});
  let contents = 'bad'; let downloads = 0;
  t.mock.method(globalThis, 'fetch', async () => { downloads++; return new Response(contents); });
  const first = create();
  assert.equal(first.accepts(base + 'project/scene.json'), false);
  assert.equal(first.accepts(base + 'project/assets/unlisted.glb'), false);
  assert.equal(first.accepts(skyboxUrl + '?assetRevision=hash&skyboxResolution=256'), true);
  await assert.rejects(first.fetch(modelUrl), /资源与清单不一致/);
  contents = 'old';
  assert.equal(await (await first.fetch(modelUrl)).text(), 'old');
  first.dispose();
  const refreshed = create();
  assert.equal(await (await refreshed.fetch(modelUrl)).text(), 'old');
  assert.equal(downloads, 2, '不缓存坏文件，正确文件刷新后无需再次下载');
  contents = 'new-release';
  await assert.rejects(refreshed.fetch(skyboxUrl), /资源与清单不一致/);
  refreshed.dispose();
});

test('完整缓存预热与原生资源读取合并下载，持久内容损坏时重新获取', async t => {
  const store = memoryStore();
  const url = 'https://viewer.test/release/project/assets/model.glb';
  const resources = new Map([[url, { size: 3, sha256: createHash('sha256').update('abc').digest('hex') }]]);
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async () => { downloads++; await new Promise(resolve => setTimeout(resolve, 5)); return new Response('abc'); });
  const cache = new PublishedAssetCache({ baseUrl: 'https://viewer.test/release/', revision: 'r1', assetBase: 'project/assets/', documentUrls: [], resources, rawStore: store });
  const loaded = await Promise.all([cache.fetch(url), cache.fetch(url + '?assetRevision=1')]);
  assert.deepEqual(await Promise.all(loaded.map(response => response.text())), ['abc', 'abc']);
  assert.equal(downloads, 1);
  assert.equal(await cache.hasResource(url), true);
  const get = store.get;
  store.get = async key => {
    const record = await get(key) as { blob?: Blob } | undefined;
    return record?.blob ? { ...record, blob: new Blob(['bad']) } : record;
  };
  assert.equal(await (await cache.fetch(url)).text(), 'abc');
  assert.equal(downloads, 2);
  cache.dispose();
});
