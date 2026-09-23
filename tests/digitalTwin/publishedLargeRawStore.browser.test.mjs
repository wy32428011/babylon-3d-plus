import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { chromium } from 'playwright';

test('真实浏览器保存重开 520 MiB 原始文件并测量 32 MiB 校验长任务', { timeout: 180_000 }, async context => {
  const sourceRoot = path.resolve('src');
  const entry = `
    import {PublishedRawStore} from '/src/runtime/assets/publishedRawStore.ts';
    import {IndexedDbPublishedCacheStore} from '/src/runtime/assets/publishedCacheStore.ts';
    import {hashPublishedBlob} from '/src/runtime/assets/publishedBlobHash.ts';
    Object.assign(window, {PublishedRawStore, IndexedDbPublishedCacheStore, hashPublishedBlob});
  `;
  const server = createServer(async (request, response) => {
    try {
      if (request.url.startsWith('/src/') && request.url.endsWith('.ts')) {
        const file = path.resolve(`.${request.url}`);
        if (!file.startsWith(`${sourceRoot}${path.sep}`)) { response.writeHead(404).end(); return; }
        response.setHeader('Content-Type', 'application/javascript');
        response.end(ts.transpileModule(await fs.readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
        return;
      }
      response.setHeader('Content-Type', request.url === '/app.js' ? 'application/javascript' : 'text/html');
      response.end(request.url === '/app.js' ? entry : '<script type="module" src="/app.js"></script>');
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const browserContext = await browser.newContext();
    const page = await browserContext.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const result = await page.evaluate(async () => {
      const mib = 1024 * 1024;
      const pattern = new Uint8Array(mib);
      for (let index = 0; index < pattern.length; index += 1) pattern[index] = (index * 31 + 17) & 255;
      const unit = new Blob([pattern]);
      const blob = new Blob(Array.from({ length: 520 }, () => unit), { type: 'application/octet-stream' });
      const databaseName = `zending-large-raw-smoke-${crypto.randomUUID()}`;
      let store;
      let underlying;
      const quota = await navigator.storage.estimate();
      const report = { size: blob.size, quota: quota.quota, usageBefore: quota.usage, samples: [] };
      try {
        if (quota.quota - quota.usage < blob.size * 1.1) {
          report.largeSkipped = '浏览器可用配额不足 520 MiB 与元信息余量';
        } else {
          store = new window.PublishedRawStore(databaseName);
          const start = performance.now();
          await store.put('large', { blob, type: blob.type, sha256: 'fixture-pattern' }, blob.size);
          report.writeMs = Math.round(performance.now() - start);
          store.close();
          store = new window.PublishedRawStore(databaseName);
          const readStart = performance.now();
          const restored = await store.get('large');
          report.reopenReadMs = Math.round(performance.now() - readStart);
          report.restoredSize = restored.blob.size;
          for (const offset of [0, 16 * mib - 32, 260 * mib, blob.size - 64]) {
            const slice = restored.blob.slice(offset, offset + 64);
            const bytes = new Uint8Array(await slice.arrayBuffer());
            const valid = bytes.every((value, index) => value === (((offset + index) * 31 + 17) & 255));
            report.samples.push({ offset, length: bytes.length, valid, sha256: await window.hashPublishedBlob(slice) });
          }
          underlying = new window.IndexedDbPublishedCacheStore({ databaseName, evict: false });
          report.chunkCount = (await underlying.keys()).filter(key => key.includes(':chunk:')).length;
          report.usageAfter = (await navigator.storage.estimate()).usage;
        }
        const hashBlob = new Blob(Array.from({ length: 32 }, () => unit));
        report.hash = [];
        for (const chunkBytes of [4 * mib, mib]) {
          const longTasks = [];
          const observer = new PerformanceObserver(list => { for (const item of list.getEntries()) longTasks.push(item.duration); });
          observer.observe({ type: 'longtask' });
          const start = performance.now();
          const sha256 = await window.hashPublishedBlob(hashBlob, undefined, chunkBytes);
          const elapsedMs = Math.round(performance.now() - start);
          await new Promise(resolve => setTimeout(resolve, 100));
          observer.disconnect();
          report.hash.push({ size: hashBlob.size, chunkBytes, elapsedMs, longTasks: longTasks.length, maxLongTaskMs: Math.round(Math.max(0, ...longTasks)), sha256 });
        }
        return report;
      } finally {
        store?.close(); underlying?.close();
        // 唯一测试库无其他页面持有；关闭所有本测试连接后删除，profile 随 browser.close 销毁。
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName);
          request.onsuccess = resolve; request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('测试数据库清理被意外连接阻塞'));
        });
      }
    });
    if (result.largeSkipped) context.diagnostic(`UNVERIFIED: ${result.largeSkipped}`);
    else {
      assert.equal(result.restoredSize, 520 * 1024 * 1024);
      assert.equal(result.chunkCount, 33);
      assert.equal(result.samples.length, 4);
      assert.ok(result.samples.every(sample => sample.valid && sample.length === 64));
    }
    assert.equal(result.hash[0].sha256, result.hash[1].sha256);
    context.diagnostic(JSON.stringify(result));
    const concurrentDatabase = `zending-raw-concurrent-${Date.now()}`;
    const second = await browserContext.newPage();
    await second.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(databaseName => {
      const store = new window.IndexedDbPublishedCacheStore({ databaseName, evict: false });
      const put = store.put.bind(store);
      let firstChunk = true;
      store.put = async (...args) => {
        await put(...args);
        if (firstChunk && args[0].includes(':chunk:')) {
          firstChunk = false; window.chunkWritten = true;
          await new Promise(resolve => { window.resumeWrite = resolve; });
        }
      };
      window.concurrentStore = store;
      window.concurrentRaw = new window.PublishedRawStore(databaseName, store, 3);
      window.writePromise = window.concurrentRaw.put('model', { blob: new Blob(['AAAAAAAAAAAA']), type: 'model' }, 12);
    }, concurrentDatabase);
    await page.waitForFunction(() => window.chunkWritten);
    await second.evaluate(databaseName => {
      const store = new window.IndexedDbPublishedCacheStore({ databaseName, evict: false });
      const put = store.put.bind(store);
      window.writes = 0;
      store.put = async (...args) => { window.writes += 1; return put(...args); };
      window.concurrentStore = store;
      window.concurrentRaw = new window.PublishedRawStore(databaseName, store, 3);
      window.writePromise = window.concurrentRaw.put('model', { blob: new Blob(['BBBBBBBBBBB']), type: 'model' }, 11);
    }, concurrentDatabase);
    await second.waitForFunction(async databaseName => (await navigator.locks.query()).pending.some(lock => lock.name === `${databaseName}:write:model`), concurrentDatabase);
    assert.equal(await second.evaluate(() => window.writes), 0);
    await page.evaluate(() => window.resumeWrite());
    await Promise.all([page.evaluate(() => window.writePromise), second.evaluate(() => window.writePromise)]);
    const concurrent = await second.evaluate(async () => {
      const head = await window.concurrentStore.get('model');
      const keys = await window.concurrentStore.keys();
      return { text: await (await window.concurrentRaw.get('model')).blob.text(), keys: keys.length, chunks: head.chunks.length, noOrphans: keys.every(key => key === 'model' || head.chunks.includes(key)) };
    });
    assert.deepEqual(concurrent, { text: 'BBBBBBBBBBB', keys: 5, chunks: 4, noOrphans: true });
    await Promise.all([page.evaluate(() => window.concurrentRaw.close()), second.evaluate(() => window.concurrentRaw.close())]);
    await page.evaluate(databaseName => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = resolve; request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('并发测试库清理被阻塞'));
    }), concurrentDatabase);
    context.diagnostic(`concurrent: ${JSON.stringify(concurrent)}`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
