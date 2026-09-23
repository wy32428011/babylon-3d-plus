import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPublishedCacheVersion, verifyPublishedCacheVersion } from '../../src/player/publishedCacheVersion.ts';

const base = 'http://viewer.test/published/';
const config = { paths: { scene: './project/scene.json', assetManifest: './project/asset-manifest.json', assetBase: './project/assets/' } };
const manifest = (hash = 'a'.repeat(64)) => ({ version: 1, assets: [
  { logicalUrl: 'editor-asset://local/model.glb', path: './model.glb', size: 3, sha256: hash },
  { logicalUrl: 'editor-asset://local/sky.hdr', path: './sky.hdr', size: 4, sha256: 'b'.repeat(64) },
] });

test('旧配置通过完整资源清单获得跨刷新稳定版本；清单改变后版本改变', async t => {
  let current = manifest();
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init?.cache, 'no-store');
    return Response.json(current);
  });
  const first = await loadPublishedCacheVersion(config, base, new AbortController().signal);
  const refreshed = await loadPublishedCacheVersion(config, base, new AbortController().signal);
  assert.ok(first);
  assert.equal(first.revision, refreshed?.revision);
  assert.deepEqual(first.assetManifest, current);
  assert.equal(first.resources?.get(base + 'project/assets/sky.hdr')?.size, 4);
  current = manifest('c'.repeat(64));
  assert.notEqual((await loadPublishedCacheVersion(config, base, new AbortController().signal))?.revision, first.revision);
});

test('新包直接使用发布标识，不额外下载清单', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('不应联网'); });
  const version = await loadPublishedCacheVersion({ ...config, cacheRevision: 'release-2' }, base, new AbortController().signal);
  assert.equal(version?.revision, 'release-2');
  assert.equal(version?.resources, undefined);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('无哈希、缺项、冲突和越界清单不启用旧包缓存', async t => {
  for (const value of [
    { version: 1, assets: { 'editor-asset://local/model.glb': './model.glb' } },
    { version: 1, assets: [{ ...manifest().assets[0], sha256: undefined }] },
    { version: 1, assets: [{ ...manifest().assets[0], size: -1 }] },
    { version: 1, assets: [{ ...manifest().assets[0], path: '../../api/data' }] },
    { version: 1, assets: [{ ...manifest().assets[0], path: 'http://other.test/model.glb' }] },
    { version: 1, assets: [manifest().assets[0], { ...manifest().assets[0], sha256: 'c'.repeat(64) }] },
  ]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(value));
    assert.equal(await loadPublishedCacheVersion(config, base, new AbortController().signal), null);
    t.mock.restoreAll();
  }
});

test('读取失败与取消保留错误，不把不完整清单当成有效版本', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(loadPublishedCacheVersion(config, base, new AbortController().signal), /503/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadPublishedCacheVersion(config, base, controller.signal), { name: 'AbortError' });
});


test('场景读取期间重新发布必须阻断启动，不能把新场景与热缓存旧资源混用', async t => {
  let current = manifest();
  let latestConfig = config;
  t.mock.method(globalThis, 'fetch', async url => Response.json(String(url).endsWith('runtime-config.json') ? latestConfig : current));
  const version = await loadPublishedCacheVersion(config, base, new AbortController().signal);
  assert.ok(version);
  await verifyPublishedCacheVersion(config, base, version, new AbortController().signal);
  current = manifest('c'.repeat(64));
  await assert.rejects(verifyPublishedCacheVersion(config, base, version, new AbortController().signal), /发布版本已变更/);
  current = manifest();
  latestConfig = {paths:{...config.paths, assetBase:'./next/assets/'}};
  await assert.rejects(verifyPublishedCacheVersion(config, base, version, new AbortController().signal), /发布版本已变更/);
});

test('新包启动复核与旧格式升级到带发布号的配置均会识别版本切换', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({...config, cacheRevision:'release-2'}));
  await assert.rejects(verifyPublishedCacheVersion({...config,cacheRevision:'release-1'}, base,
    {revision:'release-1'}, new AbortController().signal), /发布版本已变更/);
  await assert.rejects(verifyPublishedCacheVersion(config, base,
    {revision:'manifest-old',resources:new Map()}, new AbortController().signal), /发布版本已变更/);
});
