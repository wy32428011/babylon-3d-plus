/* global document, window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createServer } from 'vite';
import { chromium } from 'playwright';

function png(size, rgba) {
  const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (type, bytes) => { const name = Buffer.from(type), header = Buffer.alloc(4), checksum = Buffer.alloc(4); header.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc(Buffer.concat([name, bytes]))); return Buffer.concat([header, name, bytes, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(size * (size * 4 + 1)); for (let row = 0; row < size; row++) rows.set(rgba.subarray(row * size * 4, (row + 1) * size * 4), row * (size * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const originalPixels = [211,31,73,17, 23,179,91,63, 59,113,227,127, 139,197,41,239];
const smallPng = png(2, Buffer.from(originalPixels));
const randomPixels = Buffer.alloc(256 * 256 * 4); let random = 12345;
for (let index = 0; index < randomPixels.length; index++) { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; randomPixels[index] = random & 255; }
const largePng = png(256, randomPixels);
const geometry = Buffer.from(JSON.stringify({ version: 1, positions: [0,0,0,1,0,0,0,1,0], normals: [0,0,1,0,0,1,0,0,1], uvs: [0,0,1,0,0,1], bakeUvs: [0,0,1,0,0,1], indices: [0,1,2] }));
const probes = Buffer.from(JSON.stringify({ version: 1, encoding: 'ambient-cube', spacing: 1, probes: [{ position: [0,0,0], irradiance: Array(18).fill(0.5) }] }));
const output = path.resolve('output/playwright/lighting-resources-q0');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'lighting-resources-webgl-'));
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(temporary, 'cache'), appType: 'custom',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true } });
server.middlewares.use('/__lighting_resources__', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html'); response.end(await server.transformIndexHtml('/__lighting_resources__', '<!doctype html><meta charset="utf-8"><title>GI 资源 Q0 WebGL 验证</title><h1>GI 资源 Q0：RGBM 字节与翻转验证</h1><canvas width="64" height="64"></canvas><div id="result"></div>'));
});
const payload = id => id === 'geometry' ? geometry : id === 'probes' ? probes : id.startsWith('small') ? smallPng : largePng;
server.middlewares.use('/__lighting_asset__', async (request, response) => {
  const url = new URL(request.url, 'http://localhost'), id = url.pathname.slice(1); const delay = Number(url.searchParams.get('delay') ?? 0);
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  response.setHeader('Content-Type', id === 'geometry' || id === 'probes' ? 'application/json' : 'image/png'); response.setHeader('Cache-Control', 'no-store'); response.end(payload(id));
});
function fixture(size, delay, label) {
  const ids = Array.from({ length: 8 }, (_, index) => (size === 2 ? 'small-' : 'large-') + index).concat(['geometry', 'probes']);
  return { version: 1, signature: label, createdAt: '2026-10-24T00:00:00Z', engineVersion: 'fixture',
    assets: ids.map(id => ({ id, kind: id === 'geometry' ? 'geometry' : id === 'probes' ? 'probes' : 'lightmap', url: '/__lighting_asset__/' + id + '?delay=' + delay + '&run=' + label,
      byteLength: payload(id).byteLength, sha256: createHash('sha256').update(payload(id)).digest('hex'), ...(id.endsWith('geometry') || id.endsWith('probes') ? {} : { rgbmRange: 1 }) })),
    surfaces: [{ key: 'fixed/root', entityId: 'fixed', nodeKey: 'root', geometryAssetId: 'geometry', lightmapAssetId: ids[0] }], probeAssetId: 'probes',
    statistics: { meshCount: 1, triangleCount: 1, atlasCount: 8, probeCount: 1, textureBytes: 8 * size * size * 4, durationMs: 0 } };
}
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.LIGHTING_RESOURCE_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__lighting_resources__', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async snapshots => {
    const [{ Engine }, { Scene }, { loadLightingResources }] = await Promise.all([
      import('/node_modules/@babylonjs/core/Engines/engine.js'), import('/node_modules/@babylonjs/core/scene.js'), import('/src/runtime/babylon/lightingRuntimeResources.ts'),
    ]);
    const engine = new Engine(document.querySelector('canvas'), false, { preserveDrawingBuffer: true });
    const scene = new Scene(engine), loaded = [], bitmapCalls = [], originalBitmap = window.createImageBitmap, originalClose = ImageBitmap.prototype.close;
    let created = 0, closed = 0;
    window.createImageBitmap = async (...args) => { bitmapCalls.push(args[1]); const bitmap = await originalBitmap.apply(window, args); created++; return bitmap; };
    ImageBitmap.prototype.close = function () { closed++; return originalClose.call(this); };
    try {
      const old = await loadLightingResources(snapshots.small, scene, undefined, { concurrency: 1, textureDecoder: 'image' }); loaded.push(old);
      const bitmap = await loadLightingResources(snapshots.small, scene, undefined, { concurrency: 4, textureDecoder: 'bitmap' }); loaded.push(bitmap);
      const read = async resource => Array.from(await resource.textures.values().next().value.readPixels());
      const before = { image: await read(old), bitmap: await read(bitmap), created, closed };
      const extension = engine._gl.getExtension('WEBGL_lose_context'); if (!extension) throw new Error('WEBGL_lose_context unavailable');
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebGL restore timeout')), 10000);
        engine.onContextRestoredObservable.addOnce(() => { clearTimeout(timeout); resolve(); });
        document.querySelector('canvas').addEventListener('webglcontextlost', () => setTimeout(() => extension.restoreContext(), 100), { once: true }); extension.loseContext();
      });
      const after = { image: await read(old), bitmap: await read(bitmap) };
      const samples = [];
      for (const textureDecoder of ['image', 'bitmap']) { const warm = await loadLightingResources(snapshots.warm, scene, undefined, { concurrency: 4, textureDecoder }); warm.dispose(); }
      // 用同一 image 解码路径隔离队列收益；真实读取、SHA、PNG 解码与 GPU 上传，HTTP 每资源固定延迟 100 ms。
      for (const [index, snapshot] of snapshots.performance.entries()) {
        const concurrency = index % 3 ? 4 : 1, textureDecoder = index % 3 === 2 ? 'bitmap' : 'image', start = performance.now();
        const resources = await loadLightingResources(snapshot, scene, undefined, { concurrency, textureDecoder });
        samples.push({ concurrency, textureDecoder, durationMs: performance.now() - start, atlasCount: resources.textures.size }); resources.dispose();
      }
      old.dispose(); bitmap.dispose(); loaded.length = 0;
      const glInfo = engine.getGlInfo(); document.querySelector('#result').textContent = JSON.stringify({ glInfo, before, after, samples }, null, 2);
      return { glInfo, before, after, samples, bitmapCalls, created, closed, remainingTextures: scene.textures.length };
    } finally { for (const resource of loaded) resource.dispose(); window.createImageBitmap = originalBitmap; ImageBitmap.prototype.close = originalClose; scene.dispose(); engine.dispose(); }
  }, { small: fixture(2, 0, 'pixels'), warm: fixture(256, 0, 'warm'), performance: Array.from({ length: 9 }, (_, index) => fixture(256, 100, 'ab-' + index)) });
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ...result, originalPixels, errors, note: '合成 8 图集，真实硬件 WebGL；HTTP 固定延迟模拟受限网络，不能替代业务场景验收。' }, null, 2));
  await page.screenshot({ path: path.join(output, 'result.png'), fullPage: true });
  assert.ok(!/swiftshader|llvmpipe|software/i.test(result.glInfo.renderer), '需要真实硬件 WebGL');
  const expected = originalPixels.slice(8).concat(originalPixels.slice(0, 8));
  assert.deepEqual(result.before.image, expected); assert.deepEqual(result.before.bitmap, expected); assert.deepEqual(result.after, { image: expected, bitmap: expected });
  assert.equal(result.before.created, 8); assert.equal(result.before.closed, 0); assert.equal(result.created, result.closed); assert.equal(result.remainingTextures, 0);
  assert.ok(result.bitmapCalls.every(options => options.imageOrientation === 'flipY' && options.premultiplyAlpha === 'none' && options.colorSpaceConversion === 'none'));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ renderer: result.glInfo.renderer, pixelBytesIdentical: true, contextRestoreIdentical: true, bitmapsCreated: result.created, bitmapsClosed: result.closed,
    samples: result.samples, output }, null, 2));
} finally { await browser?.close(); await server.close(); }
