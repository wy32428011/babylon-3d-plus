import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { chromium } from 'playwright';

const assetPaths = [
  'project/assets/models/a.glb',
  'project/assets/environments/env.glb',
  'project/assets/skyboxes/a.exr',
  'project/assets/models/lazy-model.glb',
];

async function createHttpFixture() {
  const sourceRoot = path.resolve('src');
  const requests = new Map();
  const entry = `
    import {preparePublishedReleaseCache} from '/src/player/publishedReleaseCache.ts';
    import {PublishedAssetCache} from '/src/runtime/assets/publishedAssetCache.ts';
    import {createPublishedReleaseStorageIdentity} from '/src/player/publishedReleaseStorage.ts';
    import {IndexedDbPublishedCacheStore} from '/src/runtime/assets/publishedCacheStore.ts';
    Object.assign(window, {preparePublishedReleaseCache, PublishedAssetCache,
      createPublishedReleaseStorageIdentity, IndexedDbPublishedCacheStore});
  `;
  let revision = 'first';
  const bytesFor = file => Buffer.from(`${revision}:${file}`);
  const manifest = () => {
    const files = [...assetPaths, 'app.js'].map(file => ({
      path: file, size: bytesFor(file).length,
      sha256: createHash('sha256').update(bytesFor(file)).digest('hex'),
      contentType: file.endsWith('.js') ? 'application/javascript' : 'application/octet-stream',
      storage: file.startsWith('project/assets/') ? 'asset' : 'response',
    }));
    return { version: 1, cacheRevision: revision, files, totalBytes: files.reduce((sum, file) => sum + file.size, 0) };
  };
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://fixture.test').pathname;
      response.setHeader('Cache-Control', 'no-store');
      if (pathname.startsWith('/src/') && pathname.endsWith('.ts')) {
        const file = path.resolve(`.${pathname}`);
        if (!file.startsWith(`${sourceRoot}${path.sep}`)) { response.writeHead(404); response.end(); return; }
        response.setHeader('Content-Type', 'application/javascript');
        response.end(ts.transpileModule(await fs.readFile(file, 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText);
        return;
      }
      const release = pathname.match(/^\/digital-twin\/releases\/42\/\d+\/(.+)$/);
      if (release) {
        requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
        if (release[1] === 'release-cache-manifest.json') {
          response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(manifest())); return;
        }
        if (assetPaths.includes(release[1]) || release[1] === 'app.js') {
          response.setHeader('Content-Type', 'application/octet-stream'); response.end(bytesFor(release[1])); return;
        }
        response.writeHead(404); response.end(); return;
      }
      response.setHeader('Content-Type', pathname === '/entry.js' ? 'application/javascript' : 'text/html');
      response.end(pathname === '/entry.js' ? entry : '<script type="module" src="/entry.js"></script>');
    } catch (error) {
      response.writeHead(500); response.end(String(error));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://cache-http.test:${server.address().port}`,
    requests,
    setRevision(value) { revision = value; },
    async close() { await new Promise(resolve => server.close(resolve)); },
  };
}

async function openPage(browser, fixture) {
  const page = await browser.newPage();
  await page.goto(fixture.url);
  await page.waitForFunction(() => typeof window.preparePublishedReleaseCache === 'function');
  return page;
}

async function runRelease(page, revision, release = '1') {
  return page.evaluate(async ({ assetPaths, revision, release }) => {
    const baseUrl = `${location.origin}/digital-twin/releases/42/${release}/`;
    const controller = new AbortController();
    const states = [];
    let finish;
    const completed = new Promise(resolve => { finish = resolve; });
    const session = await window.preparePublishedReleaseCache({ cacheRevision: revision,
      cacheManifest: 'release-cache-manifest.json' }, baseUrl, controller.signal, state => {
      states.push(state);
      if (state.phase === 'partial' || state.phase === 'ready') finish(state);
    });
    if (!session) throw new Error('发布缓存初始化未返回会话');
    const cache = new window.PublishedAssetCache({ baseUrl, revision, assetBase: 'project/assets/',
      documentUrls: [], rawStore: session.rawStore, resources: session.resources });
    try {
      // 模拟首帧实际按需读取；第四个未展示模型必须由完整预缓存补齐。
      const demandContents = [];
      for (const file of assetPaths.slice(0, 3)) demandContents.push(await (await cache.fetch(`${baseUrl}${file}`)).text());
      session.prefetch(cache, async () => {});
      const state = await completed;
      const cached = await Promise.all(assetPaths.map(file => cache.hasResource(`${baseUrl}${file}`)));
      const identity = await window.createPublishedReleaseStorageIdentity(baseUrl, revision);
      const catalog = new window.IndexedDbPublishedCacheStore({ databaseName: 'zending-published-release-catalog-v1', evict: false });
      const record = await catalog.get(identity.databaseName); catalog.close();
      return { state, cached, demandContents, metrics: cache.metrics, markedComplete: record.complete,
        reportedReady: states.some(item => item.phase === 'ready') };
    } finally { cache.dispose(); session.dispose(); controller.abort(); }
  }, { assetPaths, revision, release });
}

function assertAssetRequests(fixture, release, expected) {
  for (const file of assetPaths) assert.equal(fixture.requests.get(`/digital-twin/releases/42/${release}/${file}`) ?? 0, expected, file);
}

test('非安全 HTTP 完整缓存模型、环境与天空盒，刷新复用，重新发布后重建缓存', { timeout: 60_000 }, async () => {
  const fixture = await createHttpFixture();
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true,
      args: ['--host-resolver-rules=MAP cache-http.test 127.0.0.1', '--no-proxy-server'] });
    const page = await openPage(browser, fixture);
    const warnings = [];
    page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
    assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, storage: typeof navigator.storage,
      indexedDB: typeof indexedDB, serviceWorker: typeof navigator.serviceWorker })),
    { secure: false, storage: 'undefined', indexedDB: 'object', serviceWorker: 'undefined' });

    const first = await runRelease(page, 'first');
    assert.deepEqual(first.cached, [true, true, true, true], '没有 estimate 时也必须预缓存尚未按需加载的模型');
    assertAssetRequests(fixture, '1', 1);
    assert.deepEqual(first.demandContents, assetPaths.slice(0, 3).map(file => `first:${file}`));
    assert.equal(first.state.phase, 'partial', 'HTTP 不支持 response 缓存，不得虚报整包 ready');
    assert.equal(first.state.completedFiles, 4);
    assert.equal(first.state.totalFiles, 5);
    assert.equal(first.markedComplete, false);
    assert.equal(first.reportedReady, false);
    assert.ok(warnings.some(message => message.includes('[Viewer cache]')), 'partial 状态必须保留控制台警告');

    fixture.requests.clear();
    await page.reload();
    await page.waitForFunction(() => typeof window.preparePublishedReleaseCache === 'function');
    const refreshed = await runRelease(page, 'first');
    assert.deepEqual(refreshed.cached, [true, true, true, true]);
    assert.equal(refreshed.metrics.downloads, 0);
    assertAssetRequests(fixture, '1', 0);

    // 稳定地址更换 revision，以及不可变 release 地址切换，都必须重新下载四项。
    fixture.setRevision('second');
    const republished = await runRelease(page, 'second');
    assert.deepEqual(republished.cached, [true, true, true, true]);
    assert.deepEqual(republished.demandContents, assetPaths.slice(0, 3).map(file => `second:${file}`));
    assertAssetRequests(fixture, '1', 1);
    fixture.requests.clear();
    const nextRelease = await runRelease(page, 'second', '2');
    assert.deepEqual(nextRelease.cached, [true, true, true, true]);
    assertAssetRequests(fixture, '2', 1);
  } finally { await browser?.close(); await fixture.close(); }
});

test('存储能力异常仅降级缓存，不阻断发布资源加载', { timeout: 60_000 }, async t => {
  const fixture = await createHttpFixture();
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true,
      args: ['--host-resolver-rules=MAP cache-http.test 127.0.0.1', '--no-proxy-server'] });
    await t.test('容量估算拒绝时仍可完整保存四类 asset', async () => {
      const page = await openPage(browser, fixture);
      try {
        await page.evaluate(() => Object.defineProperty(navigator, 'storage', { configurable: true,
          value: { estimate: async () => { throw new DOMException('fixture estimate rejected', 'SecurityError'); } } }));
        const result = await runRelease(page, 'first');
        assert.deepEqual(result.cached, [true, true, true, true]);
        assert.equal(result.state.completedFiles, 4);
        assert.equal(result.markedComplete, false);
      } finally { await page.close(); }
    });
    await t.test('IndexedDB 被禁用时正常返回网络模型', async () => {
      const page = await openPage(browser, fixture);
      try {
        const result = await page.evaluate(async file => {
          Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
          const baseUrl = `${location.origin}/digital-twin/releases/42/1/`;
          const controller = new AbortController();
          const session = await window.preparePublishedReleaseCache({ cacheRevision: 'first',
            cacheManifest: 'release-cache-manifest.json' }, baseUrl, controller.signal);
          const cache = new window.PublishedAssetCache({ baseUrl, revision: 'first',
            assetBase: 'project/assets/', documentUrls: [] });
          try {
            const content = await (await cache.fetch(`${baseUrl}${file}`)).text();
            return { sessionUnavailable: session === null, content, storageFailures: cache.metrics.storageFailures };
          } finally { cache.dispose(); session?.dispose(); controller.abort(); }
        }, assetPaths[0]);
        assert.deepEqual(result, { sessionUnavailable: true, content: `first:${assetPaths[0]}`, storageFailures: 1 });
      } finally { await page.close(); }
    });
    await t.test('实际写入配额失败仍能加载模型、环境与天空盒，并保持 partial', async () => {
      const page = await openPage(browser, fixture);
      const warnings = [];
      page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
      try {
        await page.evaluate(() => {
          const originalPut = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function (value, ...args) {
            if (value instanceof Blob) throw new DOMException('fixture raw quota exceeded', 'QuotaExceededError');
            return originalPut.call(this, value, ...args);
          };
        });
        const result = await runRelease(page, 'first');
        assert.deepEqual(result.demandContents, assetPaths.slice(0, 3).map(file => `first:${file}`));
        assert.deepEqual(result.cached, [false, false, false, false]);
        assert.equal(result.metrics.storageFailures, 1);
        assert.equal(result.state.phase, 'partial');
        assert.equal(result.state.completedFiles, 0);
        assert.equal(result.markedComplete, false);
        assert.equal(result.reportedReady, false);
        assert.ok(warnings.some(message => message.includes('fixture raw quota exceeded')));
      } finally { await page.close(); }
    });
  } finally { await browser?.close(); await fixture.close(); }
});
