import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const output = path.resolve('output/playwright/published-cache-storage');
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'cache-storage-regression', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== '/__cache-storage') { next(); return; }
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><body>发布缓存事务回归</body></html>');
    });
  } }] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__cache-storage');
  const result = await page.evaluate(async () => {
    const { IndexedDbPublishedCacheStore } = await import('/src/runtime/assets/publishedCacheStore.ts');
    const transactionFactory = IDBDatabase.prototype.transaction;
    const nativeTimeout = window.setTimeout;
    let watchdog = null;
    let raceArmed = true;
    let replayed = 0;
    const raceErrors = [];
    // 使用真实、已完成的 IndexedDB 事务，仅控制应用完成回调与其超时回调的交付顺序。
    window.setTimeout = function(callback, delay, ...args) {
      if (delay === 3000 || delay === 30000) watchdog = callback;
      return nativeTimeout(callback, delay, ...args);
    };
    IDBDatabase.prototype.transaction = function(...args) {
      const transaction = transactionFactory.apply(this, args);
      if (!raceArmed || !Array.from(transaction.objectStoreNames).includes('values')) return transaction;
      raceArmed = false;
      let complete;
      Object.defineProperty(transaction, 'oncomplete', { configurable: true, set(callback) { complete = callback; }, get() { return complete; } });
      transaction.addEventListener('complete', event => {
        replayed++;
        try { watchdog(); } catch (error) { raceErrors.push(error.name + ': ' + error.message); }
        complete?.call(transaction, event);
      });
      return transaction;
    };
    const raceStore = new IndexedDbPublishedCacheStore();
    try { await raceStore.get('race:missing'); }
    finally { raceStore.close(); IDBDatabase.prototype.transaction = transactionFactory; window.setTimeout = nativeTimeout; }

    const store = new IndexedDbPublishedCacheStore();
    const count = 12;
    const entryBytes = 16 * 1024 * 1024;
    const sample = new Uint8Array(entryBytes);
    sample[0] = 37; sample[sample.length - 1] = 93;
    const started = performance.now();
    const writes = Promise.all(Array.from({ length: count }, (_, index) => store.put('stress:' + index, sample, sample.byteLength)));
    await new Promise(resolve => setTimeout(resolve, 50));
    const busyUntil = performance.now() + 3500;
    while (performance.now() < busyUntil) { /* 模拟大型模型同步初始化占用主线程。 */ }
    await writes;
    const values = await Promise.all(Array.from({ length: count }, (_, index) => store.get('stress:' + index)));
    const valid = values.every(value => value instanceof Uint8Array && value.length === entryBytes && value[0] === 37 && value[value.length - 1] === 93);
    // 写入会先提交批量访问时间；验证后台 LRU 更新不阻塞读取且与后续写入保持顺序。
    await store.put('after-stress', 'ready', 5);
    store.close();
    const reopened = new IndexedDbPublishedCacheStore();
    const persisted = await reopened.get('stress:11');
    reopened.close();
    return { replayed, raceErrors, entries: count, bytes: count * entryBytes, valid,
      persisted: persisted instanceof Uint8Array && persisted[0] === 37, elapsedMs: performance.now() - started };
  });
  assert.equal(result.replayed, 1);
  assert.deepEqual(result.raceErrors, []);
  assert.equal(result.valid, true);
  assert.equal(result.persisted, true);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ...result, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', ...result, pageErrors: errors }));
} finally { await browser?.close(); await server.close(); }
