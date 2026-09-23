import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { chromium } from 'playwright';

test('真实 IndexedDB 配额复用、完整状态、跨页租约和整版本清理', async () => {
  const entry = `
    import * as storage from '/src/player/publishedReleaseStorage.ts';
    import {IndexedDbPublishedCacheStore} from '/src/runtime/assets/publishedCacheStore.ts';
    Object.assign(window, storage, {IndexedDbPublishedCacheStore});
  `;
  const sourceRoot = path.resolve('src');
  const server = createServer(async (request, response) => {
    if (request.url.startsWith('/src/') && request.url.endsWith('.ts')) {
      const file = path.resolve(`.${request.url}`);
      if (!file.startsWith(`${sourceRoot}${path.sep}`)) { response.statusCode = 404; response.end(); return; }
      response.setHeader('Content-Type', 'application/javascript');
      response.end(ts.transpileModule(await fs.readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
      return;
    }
    response.setHeader('Content-Type', request.url === '/app.js' ? 'application/javascript' : 'text/html');
    response.end(request.url === '/app.js' ? entry : '<script type="module" src="/app.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext();
    const first = await context.newPage();
    const second = await context.newPage();
    const url = `http://127.0.0.1:${server.address().port}`;
    await Promise.all([first.goto(url), second.goto(url)]);
    const original = await first.evaluate(async () => {
      const base = `${location.origin}/digital-twin/releases/42/7/`;
      const manifest = { cacheRevision: 'a', totalBytes: 12, files: [{ path: 'app.js', size: 4, storage: 'response' }] };
      window.identity = await window.createPublishedReleaseStorageIdentity(base, 'a');
      window.session = await window.openPublishedReleaseStorage(base, manifest);
      await window.session.rawStore.put('model', { blob: new Blob(['12345678']), type: 'model' }, 8);
      window.session.dispose();
      Object.defineProperty(navigator.storage, 'estimate', { configurable: true, value: async () => ({ quota: 1000, usage: 995 }) });
      window.session = await window.openPublishedReleaseStorage(base, manifest);
      const partialAdmitted = window.session.admitted;
      await (await caches.open(window.identity.responseCacheName)).put(`${base}app.js`, new Response('code'));
      await window.session.markComplete({ phase: 'ready', completedFiles: 2, totalFiles: 2 });
      window.session.dispose();
      Object.defineProperty(navigator.storage, 'estimate', { configurable: true, value: async () => ({ quota: 1000, usage: 1000 }) });
      window.session = await window.openPublishedReleaseStorage(base, manifest);
      const fullAdmitted = window.session.admitted;
      window.catalog = new window.IndexedDbPublishedCacheStore({ databaseName: 'zending-published-release-catalog-v1', evict: false });
      const record = await window.catalog.get(window.identity.databaseName);
      await window.catalog.put(window.identity.databaseName, { ...record, lastUsed: Date.now() - 8 * 86400_000 }, 1000);
      const active = (await navigator.locks.query()).held.some(lock => lock.name === window.identity.databaseName && lock.mode === 'shared');
      return { partialAdmitted, fullAdmitted, complete: record.complete, active, databaseName: window.identity.databaseName, cacheName: window.identity.responseCacheName };
    });
    assert.equal(original.partialAdmitted, true);
    assert.equal(original.fullAdmitted, true);
    assert.equal(original.complete, true);
    assert.equal(original.active, true);
    await second.evaluate(async () => {
      window.session = await window.openPublishedReleaseStorage(`${location.origin}/digital-twin/releases/42/8/`, { cacheRevision: 'b', totalBytes: 100 });
    });
    assert.equal(await first.evaluate(async () => (await window.session.rawStore.get('model')).blob.text()), '12345678');
    assert.equal(await second.evaluate(name => caches.has(name), original.cacheName), true);
    await first.evaluate(() => { window.session.dispose(); window.catalog.close(); });
    await second.evaluate(async () => {
      window.session.dispose();
      window.session = await window.openPublishedReleaseStorage(`${location.origin}/digital-twin/releases/42/9/`, { cacheRevision: 'c', totalBytes: 100 });
    });
    const cleared = await second.evaluate(async ({ databaseName, cacheName }) => {
      const old = new window.IndexedDbPublishedCacheStore({ databaseName, evict: false });
      const keys = await old.keys(); old.close();
      return { keys, cachePresent: await caches.has(cacheName), databaseShellPresent: (await indexedDB.databases()).some(database => database.name === databaseName) };
    }, original);
    assert.deepEqual(cleared, { keys: [], cachePresent: false, databaseShellPresent: true });
    const fallback = await second.evaluate(async () => {
      const base = `${location.origin}/digital-twin/releases/99/1/`;
      window.other = await window.openPublishedReleaseStorage(base, { cacheRevision: 'x', totalBytes: 100 });
      await window.other.rawStore.put('model', { blob: new Blob(['kept']), type: 'model' }, 4);
      window.other.dispose();
      Object.defineProperty(navigator.storage, 'estimate', { configurable: true, value: async () => ({ quota: 10, usage: 10 }) });
      const controller = new AbortController();
      window.other = await window.openPublishedReleaseStorage(base, { cacheRevision: 'x', totalBytes: 100 }, controller.signal);
      const admitted = window.other.admitted;
      const text = await (await window.other.rawStore.get('model')).blob.text();
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 0));
      const held = (await navigator.locks.query()).held.some(lock => lock.name === window.other.databaseName);
      return { admitted, text, held };
    });
    assert.deepEqual(fallback, { admitted: false, text: 'kept', held: false });
    const reclaimed = await second.evaluate(async () => {
      const legacy = new window.IndexedDbPublishedCacheStore();
      await legacy.put('fixture:raw:source', 'original', 16);
      await legacy.put('fixture:decoded:mesh', new Uint8Array(400), 400);
      Object.defineProperty(navigator.storage, 'estimate', {
        configurable: true,
        value: async () => ({ quota: 500, usage: (await legacy.keys()).includes('fixture:decoded:mesh') ? 500 : 100 }),
      });
      const session = await window.openPublishedReleaseStorage(`${location.origin}/digital-twin/releases/100/1/`, { cacheRevision: 'reclaim', totalBytes: 100 });
      const result = { admitted: session.admitted, original: await legacy.get('fixture:raw:source'), decodedPresent: (await legacy.keys()).includes('fixture:decoded:mesh') };
      await session.markComplete({ phase: 'partial', completedFiles: 1, totalFiles: 2 });
      const catalog = new window.IndexedDbPublishedCacheStore({ databaseName: 'zending-published-release-catalog-v1', evict: false });
      result.partialComplete = (await catalog.get(session.databaseName)).complete;
      catalog.close(); session.dispose(); legacy.close();
      return result;
    });
    assert.deepEqual(reclaimed, { admitted: true, original: 'original', decodedPresent: false, partialComplete: false });
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
