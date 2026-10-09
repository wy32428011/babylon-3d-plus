import assert from 'node:assert/strict';
import { createReadStream, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const label = process.argv[2] ?? 'fixed';
assert.match(label, /^[a-z0-9-]+$/);
const output = path.resolve('output/playwright/skybox-mosaic', label);
await mkdir(output, { recursive: true });
const compact = path.resolve('public/builtin-skyboxes/partly-cloudy-light/partly-cloudy-light.hdr');
const hdr = await readFile(compact);
assert.ok(hdr.length <= 2000000);
// 光滑的解析信号不含真实云细节，避免把画质降低或模糊误判为修复。
const width = 64, height = 32;
const gradient = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const longitude = (x + 0.5) / width * Math.PI * 2;
  const i = (y * width + x) * 4;
  gradient[i] = Math.round(110 + 85 * Math.sin(longitude));
  gradient[i + 1] = Math.round(120 + 70 * Math.cos(longitude));
  gradient[i + 2] = Math.round(130 + 60 * Math.sin(longitude * 2));
  gradient[i + 3] = 129;
}
const gradientFile = path.join(output, 'smooth-gradient.hdr');
await writeFile(gradientFile, Buffer.concat([Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`), gradient]));
const errors = [], remote = [];
const report = { label, hdrBytes: hdr.length, hdrSha256: createHash('sha256').update(hdr).digest('hex'), errors, remote, captures: {} };
const baselineWorkerSource = label === 'baseline' ? execFileSync('git', ['show', 'HEAD:src/runtime/babylon/skyboxDecodedData.worker.ts'], { encoding: 'utf8' }) : null;
if (baselineWorkerSource) await writeFile(path.join(output, 'baseline-worker.ts'), baselineWorkerSource);
const pinWorker = () => ({ name: 'pin-pre-fix-worker', enforce: 'pre', load(id) {
  if (baselineWorkerSource && id.replaceAll('\\', '/').split('?')[0].endsWith('/src/runtime/babylon/skyboxDecodedData.worker.ts')) return baselineWorkerSource;
} });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', cacheDir: path.join(output, '.vite-cache'),
  optimizeDeps: { noDiscovery: true, include: ['@babylonjs/core', '@babylonjs/loaders', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@linkiez/dxf-renew'] },
  worker: { plugins: () => [pinWorker()] },
  server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [pinWorker(), { name: 'mosaic-probe', configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
      if (pathname === '/compact.hdr' || pathname === '/gradient.hdr') {
        const file = pathname === '/compact.hdr' ? compact : gradientFile;
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': statSync(file).size, 'Cache-Control': 'no-store' });
        createReadStream(file).on('error', error => response.destroy(error)).pipe(response); return;
      }
      if (pathname !== '/probe') return next();
      void vite.transformIndexHtml(pathname, '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><canvas width="1536" height="864"></canvas><script type="module" src="/tests/fixtures/skyboxMosaic.harness.ts"></script></body></html>')
        .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }, error => { response.statusCode = 500; response.end(String(error)); });
    });
  } }] });
let browser, page;
try {
  await server.listen(); await server.watcher.close();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1536, height: 864 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) remote.push(request.url()); });
  await page.goto(origin + '/probe', { waitUntil: 'commit' });
  await page.waitForFunction(() => Boolean(window.skyboxMosaic), null, { timeout: 120000 });
  report.compact = await page.evaluate(() => window.skyboxMosaic.load('compact'));
  assert.ok(!/SwiftShader|llvmpipe|Software Renderer/i.test(report.compact.engine.renderer));
  for (let direction = 0; direction < 4; direction++) {
    report.captures['cloud-' + direction] = await page.evaluate(yaw => window.skyboxMosaic.capture(yaw), direction * Math.PI / 2);
    await page.locator('canvas').screenshot({ path: path.join(output, `cloud-${direction}.png`) });
  }
  await page.evaluate(() => window.skyboxMosaic.capture(0, 0.35, 0.24));
  await page.locator('canvas').screenshot({ path: path.join(output, 'cloud-detail.png') });
  report.gradient = await page.evaluate(() => window.skyboxMosaic.load('gradient'));
  report.gradientMetrics = await page.evaluate(() => window.skyboxMosaic.capture(0, 0.1, 0.7));
  await page.locator('canvas').screenshot({ path: path.join(output, 'gradient.png') });
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  await page.evaluate(() => window.skyboxMosaic.dispose());
  if (label === 'baseline') {
    assert.equal(report.compact.diagnostics.decoded.decoderVersion, 'babylon-9.12.0-panorama-v1', '基线必须固定旧转换实现');
    assert.ok(report.gradientMetrics.cubePlateauFraction > 0.8, '旧算法须真实复现台阶');
    assert.ok(report.gradientMetrics.maximumJump > 2, '旧算法须真实复现像素跳变');
  } else {
    const baseline = JSON.parse(await readFile(path.resolve('output/playwright/skybox-mosaic/baseline/result.json'), 'utf8'));
    assert.equal(report.hdrSha256, baseline.hdrSha256, '同一HDR资源必须未改变');
    assert.equal(report.compact.textureSize.width, baseline.compact.textureSize.width, '同一面分辨率');
    assert.ok(report.gradientMetrics.cubePlateauFraction < baseline.gradientMetrics.cubePlateauFraction * 0.25, '浮点面数据台阶须大幅减少');
    assert.ok(report.gradientMetrics.maximumJump <= 2, '光滑梯度不得出现可见最近邻跳变');
  }
  report.status = 'passed';
  console.log(JSON.stringify({ label, gradient: report.gradientMetrics, compact: report.compact }, null, 2));
} catch (error) {
  report.status = 'failed'; report.failure = String(error); throw error;
} finally {
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  const cleanup = await Promise.allSettled([browser?.close(), server.close()]);
  for (const result of cleanup) if (result.status === 'rejected') console.error(result.reason);
}
