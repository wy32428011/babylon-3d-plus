import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { stat, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const source = process.argv[2];
if (!source) throw new Error('用法：node scripts/smoke-skybox-decoded-data.mjs <EXR绝对路径> [输出目录]');
const output = path.resolve(process.argv[3] ?? 'output/playwright/skybox-decoded-data');
const sourceInfo = await stat(source);
const sha = createHash('sha256');
for await (const chunk of createReadStream(source)) sha.update(chunk);
const sourceHash = sha.digest('hex');
const html = `<!doctype html><html><body>天空盒 Worker 原算法对照<script type="module">
import { ReadExrDataAsync } from '@babylonjs/core/Materials/Textures/Loaders/exrTextureLoader';
import { PanoramaToCubeMapTools } from '@babylonjs/core/Misc/HighDynamicRange/panoramaToCubemap';
import { GetCubeMapTextureData } from '@babylonjs/core/Misc/HighDynamicRange/hdr';
import { prepareSkyboxData, getSkyboxDecodeMetrics } from '/src/runtime/babylon/skyboxDecodedData.ts';
import { SKYBOX_CACHE_DATABASE, SKYBOX_CUBE_FACES, openSkyboxDecodedCache, writeSkyboxDecodedCache, readSkyboxDecodedCache } from '/src/runtime/babylon/skyboxDecodedCache.ts';
let blob;
let workerStarts = 0, workerStops = 0;
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker { constructor(...args) { super(...args); workerStarts++; } terminate() { workerStops++; super.terminate(); } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = stage => console.log('[SkyboxDecodeBenchmark]', stage);
const digest = async cube => Object.fromEntries(await Promise.all(SKYBOX_CUBE_FACES.map(async face => {
  const hash = await crypto.subtle.digest('SHA-256', cube[face]);
  return [face, Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')];
})));
const measured = async task => {
  let beats = 0, last = performance.now(), maximumGapMs = 0;
  const interval = setInterval(() => { const now = performance.now(); maximumGapMs = Math.max(maximumGapMs, now - last); last = now; beats++; }, 10);
  await sleep(20);
  const start = performance.now();
  try {
    const cube = await task();
    const totalMs = performance.now() - start;
    await sleep(30);
    return { cube, totalMs, maximumGapMs, beats };
  } finally { clearInterval(interval); }
};
const readMetadata = async () => {
  const database = await openSkyboxDecodedCache();
  try { return await new Promise((resolve, reject) => {
    const request = database.transaction('metadata').objectStore('metadata').getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  }); } finally { database.close(); }
};
window.runSkyboxBenchmark = async () => {
  log('读取真实 EXR');
  blob = await (await fetch('/__source.exr')).blob();
  const results = {};
  log('主线程 Babylon 原算法解码和转换');
  const direct = await measured(async () => {
    const exr = await ReadExrDataAsync(await blob.arrayBuffer());
    return PanoramaToCubeMapTools.ConvertPanoramaToCubemap(exr.data, exr.width, exr.height, 512, false, false);
  });
  results.direct = { totalMs: direct.totalMs, maximumGapMs: direct.maximumGapMs, beats: direct.beats, hashes: await digest(direct.cube) };
  direct.cube = null;
  log('Worker 冷缓存完整解码和转换');
  const cold = await measured(() => prepareSkyboxData(blob, 'exr', 512, undefined, { onStage: log }));
  if (!cold.cube) throw new Error('当前 PIZ EXR 不应退回旧加载器');
  results.cold = { totalMs: cold.totalMs, maximumGapMs: cold.maximumGapMs, beats: cold.beats, hashes: await digest(cold.cube), metrics: getSkyboxDecodeMetrics() };
  cold.cube = null;
  log('Worker 热缓存读取');
  const hot = await measured(() => prepareSkyboxData(blob, 'exr', 512, undefined, { onStage: log }));
  results.hot = { totalMs: hot.totalMs, maximumGapMs: hot.maximumGapMs, beats: hot.beats, hashes: await digest(hot.cube), metrics: getSkyboxDecodeMetrics() };
  hot.cube = null;
  const beforeCancel = await readMetadata();
  log('取消正在解码的 Worker');
  const controller = new AbortController();
  let abortedAt = 0;
  try {
    await prepareSkyboxData(blob, 'exr', 256, controller.signal, { onStage: stage => {
      if (stage === 'decode') setTimeout(() => { abortedAt = performance.now(); controller.abort(); }, 100);
    } });
    throw new Error('应取消的解码任务意外成功');
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
    results.cancel = { latencyMs: performance.now() - abortedAt, metadataBefore: beforeCancel.length, metadataAfter: (await readMetadata()).length };
  }
  log('损坏资源与离线兼容检查');
  try { await prepareSkyboxData(new Blob(['not EXR']), 'exr', 512); throw new Error('损坏资源意外成功'); }
  catch (error) { if (error.message === '损坏资源意外成功') throw error; results.corrupt = error.message; }
  const original = new Uint8Array(await blob.arrayBuffer());
  const marker = new TextEncoder().encode('compression\\0compression\\0');
  let index = -1;
  for (let i = 0; i < 4096 - marker.length; i++) {
    if (marker.every((value, offset) => original[i + offset] === value)) { index = i + marker.length + 4; break; }
  }
  if (index < 0) throw new Error('未找到 EXR compression 属性');
  original[index] = 3;
  results.zipFallback = await prepareSkyboxData(new Blob([original]), 'exr', 512) === null;
  log('HDR 原算法和 Worker 对照');
  const hdrHeader = new TextEncoder().encode('#?RADIANCE\\nFORMAT=32-bit_rle_rgbe\\n\\n-Y 4 +X 8\\n');
  const hdrRows = Uint8Array.from(Array.from({ length: 4 }, () => [2, 2, 0, 8, 136, 128, 136, 64, 136, 32, 136, 129]).flat());
  const hdrBlob = new Blob([hdrHeader, hdrRows]);
  const hdrDirect = GetCubeMapTextureData(await hdrBlob.arrayBuffer(), 4, false);
  const hdrWorker = await prepareSkyboxData(hdrBlob, 'hdr', 4);
  const hdrCached = await prepareSkyboxData(hdrBlob, 'hdr', 4);
  results.hdr = { direct: await digest(hdrDirect), worker: await digest(hdrWorker), cached: await digest(hdrCached), metrics: getSkyboxDecodeMetrics() };
  log('IndexedDB 有界事务与无效记录检查');
  const database = await openSkyboxDecodedCache();
  const tiny = { size: 2, format: 4, type: 1, gammaSpace: false,
    ...Object.fromEntries(SKYBOX_CUBE_FACES.map(face => [face, new Float32Array(12)])) };
  try {
    await writeSkyboxDecodedCache(database, 'fixture-a', tiny, 2, 600);
    await sleep(2);
    await writeSkyboxDecodedCache(database, 'fixture-b', tiny, 2, 600);
    await sleep(2);
    await writeSkyboxDecodedCache(database, 'fixture-c', tiny, 2, 600);
    results.cacheBounds = (await readMetadata()).map(({ key, byteLength }) => ({ key, byteLength }));
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('cubemaps', 'readwrite');
      transaction.objectStore('cubemaps').put({ key: 'fixture-broken', cube: { ...tiny, up: new Float32Array(1) } });
      transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    });
    results.rejectsIncompleteCache = await readSkyboxDecodedCache(database, 'fixture-broken', 2) === null;
  } finally { database.close(); }
  results.workerLifecycle = { starts: workerStarts, stops: workerStops };
  return results;
};
window.ready = true;
</script></body></html>`;
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(output, '.vite-cache'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: { include: ['@babylonjs/core/Materials/Textures/Loaders/exrTextureLoader', '@babylonjs/core/Misc/HighDynamicRange/panoramaToCubemap'] },
  plugins: [{ name: 'skybox-worker-benchmark', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url === '/__source.exr') { response.setHeader('Content-Type', 'image/x-exr'); createReadStream(source).pipe(response); }
      else if (request.url === '/__skybox-test') {
        void server.transformIndexHtml(request.url, html).then(result => { response.setHeader('Content-Type', 'text/html'); response.end(result); },
          error => { response.statusCode = 500; response.end(String(error)); });
      } else next();
    });
  } }] });
let browser;
try {
  await server.listen();
  console.log('独立天空盒测试服务已启动');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  page.on('console', message => { if (message.text().includes('[SkyboxDecodeBenchmark]') || message.type() === 'error') console.log(message.text()); });
  page.on('pageerror', error => console.error('页面错误：', error.message));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const external = [];
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) external.push(request.url()); });
  await page.goto(origin + '/__skybox-test', { waitUntil: 'commit', timeout: 120_000 });
  await page.waitForFunction(() => window.ready, undefined, { timeout: 120_000 });
  let timer;
  const result = await Promise.race([page.evaluate(() => window.runSkyboxBenchmark()), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('真实 EXR Worker 对照超过 180 秒。')), 180_000);
  })]).finally(() => clearTimeout(timer));
  assert.deepEqual(result.cold.hashes, result.direct.hashes);
  assert.deepEqual(result.hot.hashes, result.direct.hashes);
  assert.equal(result.cold.metrics.cache, 'miss'); assert.equal(result.hot.metrics.cache, 'hit');
  assert.ok(result.cancel.latencyMs < 500); assert.equal(result.cancel.metadataBefore, result.cancel.metadataAfter);
  assert.equal(result.zipFallback, true); assert.equal(result.rejectsIncompleteCache, true);
  assert.deepEqual(result.cacheBounds.map(entry => entry.key).sort(), ['fixture-b', 'fixture-c']);
  assert.ok(result.cacheBounds.reduce((sum, entry) => sum + entry.byteLength, 0) <= 600);
  assert.equal(result.workerLifecycle.starts, result.workerLifecycle.stops);
  assert.deepEqual(result.hdr.worker, result.hdr.direct); assert.deepEqual(result.hdr.cached, result.hdr.direct);
  assert.equal(result.hdr.metrics.cache, 'hit');
  assert.deepEqual(external, [], 'Worker 与基线算法均不得请求 CDN');
  await mkdir(output, { recursive: true });
  const report = { scope: 'real-exr-original-babylon-vs-worker-and-indexeddb', sourceBytes: sourceInfo.size, sourceSha256: sourceHash, externalRequests: external, ...result };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await server.close(); }
