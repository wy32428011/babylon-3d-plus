import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// 仅用 288 字节立方体验证真实 IndexedDB，不加载业务资源，不运行 GPU 渲染。
const output = await mkdtemp(path.join(os.tmpdir(), 'skybox-cache-integrity-'));
const html = `<!doctype html><script type="module">
import { openSkyboxDecodedCache, readSkyboxDecodedCache, writeSkyboxDecodedCache, SKYBOX_CUBE_FACES } from '/src/runtime/babylon/skyboxDecodedCache.ts';
window.runCacheChecks = async () => {
  const database = await openSkyboxDecodedCache();
  const cube = { size: 2, format: 4, type: 1, gammaSpace: false,
    ...Object.fromEntries(SKYBOX_CUBE_FACES.map(face => [face, new Float32Array(12)])) };
  const transaction = (stores, mode, action) => new Promise((resolve, reject) => {
    const tx = database.transaction(stores, mode);
    const request = action(tx);
    tx.oncomplete = () => resolve(request?.result);
    tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
  });
  const get = key => transaction(['cubemaps'], 'readonly', tx => tx.objectStore('cubemaps').get(key));
  const put = record => transaction(['cubemaps'], 'readwrite', tx => tx.objectStore('cubemaps').put(record));
  const getMeta = () => transaction(['metadata'], 'readonly', tx => tx.objectStore('metadata').getAll());
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
  const results = {};
  try {
    // 故意让 digest 跨越多个事件循环；写入及命中均不能依赖仍处于活动状态的旧事务。
    crypto.subtle.digest = async (...args) => { await new Promise(resolve => setTimeout(resolve, 10)); return nativeDigest(...args); };
    results.write = await writeSkyboxDecodedCache(database, 'good', cube);
    results.hit = Boolean(await readSkyboxDecodedCache(database, 'good', 2));
    crypto.subtle.digest = nativeDigest;
    const pristine = await get('good');
    const tampered = structuredClone(pristine);
    tampered.cube.front[0] = 123;
    await put(tampered);
    results.sameShapeTamperRejected = await readSkyboxDecodedCache(database, 'good', 2) === null;
    results.corruptDataRemoved = (await get('good')) === undefined;
    results.corruptMetadataRemoved = (await getMeta()).length === 0;

    await writeSkyboxDecodedCache(database, 'race', cube);
    const correct = await get('race');
    const damaged = structuredClone(correct); damaged.cube.right[0] = 321;
    await put(damaged);
    let allowDigest, digestStarted;
    const gate = new Promise(resolve => { allowDigest = resolve; });
    const started = new Promise(resolve => { digestStarted = resolve; });
    crypto.subtle.digest = async (...args) => { digestStarted(); await gate; return nativeDigest(...args); };
    const reading = readSkyboxDecodedCache(database, 'race', 2);
    await started;
    // 另一 Worker 在校验期间提交同 key 的完整新代数据，旧读取不能将它删除。
    correct.generation = crypto.randomUUID();
    await transaction(['metadata', 'cubemaps'], 'readwrite', tx => {
      tx.objectStore('metadata').put({ key: 'race', byteLength: 288, lastUsed: Date.now(), generation: correct.generation });
      return tx.objectStore('cubemaps').put(correct);
    });
    allowDigest();
    results.raceOldRejected = await reading === null;
    crypto.subtle.digest = nativeDigest;
    results.raceNewPreserved = Boolean(await readSkyboxDecodedCache(database, 'race', 2));

    await transaction(['metadata'], 'readwrite', tx => tx.objectStore('metadata').put({ key: 'race', byteLength: -999, lastUsed: Number.NaN }));
    await writeSkyboxDecodedCache(database, 'next', cube, 2, 600);
    results.invalidMetadataRemoved = (await getMeta()).every(entry => entry.key !== 'race');
    results.invalidMetadataDataRemoved = (await get('race')) === undefined;
    results.lastValidHit = Boolean(await readSkyboxDecodedCache(database, 'next', 2));
    return results;
  } finally { crypto.subtle.digest = nativeDigest; database.close(); }
};
window.ready = true;
</script>`;
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(output, '.vite'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false }, optimizeDeps: { noDiscovery: true },
  plugins: [{ name: 'cache-integrity', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== '/cache-check') { next(); return; }
      void server.transformIndexHtml(request.url, html).then(value => { response.setHeader('Content-Type', 'text/html'); response.end(value); },
        error => { response.statusCode = 500; response.end(String(error)); });
    });
  } }] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => console.error(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/cache-check`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.ready, undefined, { timeout: 30_000 });
  let timer;
  const results = await Promise.race([page.evaluate(() => window.runCacheChecks()), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('IndexedDB 聚焦验证超过 30 秒。')), 30_000);
  })]).finally(() => clearTimeout(timer));
  for (const [check, passed] of Object.entries(results)) assert.equal(passed, true, check);
  await writeFile(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, ...results }, null, 2));
} finally { await browser?.close(); await server.close(); }
