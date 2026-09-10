import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// 使用真实非安全 HTTP 地址与生产 Worker，验证完整缓存路径；不代替业务场景验收。
const host = process.env.SKYBOX_TEST_HOST ?? Object.values(os.networkInterfaces()).flat().find(entry => entry.family === 'IPv4' && !entry.internal && entry.address.startsWith('192.168.'))?.address;
if (!host) throw new Error('此测试需要非 loopback IPv4 地址验证真实 HTTP 非安全上下文。');
const output = await mkdtemp(path.join(os.tmpdir(), 'skybox-http-cache-'));
const html = `<!doctype html><script type="module">
import { prepareSkyboxData, getSkyboxDecodeMetrics } from '/src/runtime/babylon/skyboxDecodedData.ts';
import { hashSkyboxCubeFaces, openSkyboxDecodedCache } from '/src/runtime/babylon/skyboxDecodedCache.ts';
import { GetCubeMapTextureData } from '@babylonjs/core/Misc/HighDynamicRange/hdr';
window.runChecks = async () => {
  const results = { secure: isSecureContext, subtle: Boolean(crypto.subtle), randomUUID: Boolean(crypto.randomUUID) };
  const header = new TextEncoder().encode('#?RADIANCE\\nFORMAT=32-bit_rle_rgbe\\n\\n-Y 4 +X 8\\n');
  const rows = Uint8Array.from(Array.from({ length: 4 }, () => [2, 2, 0, 8, 136, 128, 136, 64, 136, 32, 136, 129]).flat());
  const blob = new Blob([header, rows]);
  const original = GetCubeMapTextureData(await blob.arrayBuffer(), 4, false);
  results.original = await hashSkyboxCubeFaces(original);
  results.cold = await hashSkyboxCubeFaces(await prepareSkyboxData(blob, 'hdr', 4));
  results.coldMetrics = getSkyboxDecodeMetrics();
  results.hot = await hashSkyboxCubeFaces(await prepareSkyboxData(blob, 'hdr', 4));
  results.hotMetrics = getSkyboxDecodeMetrics();
  const database = await openSkyboxDecodedCache();
  try {
    await new Promise((resolve, reject) => {
      const tx = database.transaction('cubemaps', 'readwrite');
      const store = tx.objectStore('cubemaps');
      const request = store.getAll();
      request.onsuccess = () => { const record = request.result[0]; record.cube.front[0] = 999; store.put(record); };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { database.close(); }
  results.repaired = await hashSkyboxCubeFaces(await prepareSkyboxData(blob, 'hdr', 4));
  results.repairedMetrics = getSkyboxDecodeMetrics();
  await prepareSkyboxData(blob, 'hdr', 4);
  results.repairedHotMetrics = getSkyboxDecodeMetrics();
  return results;
};
window.ready = true;
</script>`;
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(output, '.vite'), logLevel: 'error',
  server: { host, port: 0, hmr: false }, optimizeDeps: { noDiscovery: true },
  plugins: [{ name: 'http-cache-integrity', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== '/http-cache-check') { next(); return; }
      void server.transformIndexHtml(request.url, html).then(value => { response.setHeader('Content-Type', 'text/html'); response.end(value); },
        error => { response.statusCode = 500; response.end(String(error)); });
    });
  } }] });
let browser;
try {
  await server.listen();
  const url = `http://${host}:${server.httpServer.address().port}/http-cache-check`;
  console.log(JSON.stringify({ url, output }));
  if (process.env.SKYBOX_TEST_SERVE_ONLY === '1') await new Promise(() => {});
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => console.error(error.message));
  await page.goto(`http://${host}:${server.httpServer.address().port}/http-cache-check`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.ready, undefined, { timeout: 30_000 });
  let timer;
  const results = await Promise.race([page.evaluate(() => window.runChecks()), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('HTTP Worker 缓存验证超过 30 秒。')), 30_000);
  })]).finally(() => clearTimeout(timer));
  assert.equal(results.secure, false); assert.equal(results.subtle, false); assert.equal(results.randomUUID, false);
  for (const kind of ['cold', 'hot', 'repaired']) assert.deepEqual(results[kind], results.original);
  assert.equal(results.coldMetrics.cache, 'miss'); assert.equal(results.hotMetrics.cache, 'hit');
  assert.equal(results.repairedMetrics.cache, 'miss'); assert.equal(results.repairedHotMetrics.cache, 'hit');
  assert.equal(results.hotMetrics.stages.decode, undefined);
  assert.deepEqual(results.coldMetrics.warnings, []); assert.deepEqual(results.hotMetrics.warnings, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, ...results }, null, 2));
} finally { await browser?.close(); await server.close(); }
