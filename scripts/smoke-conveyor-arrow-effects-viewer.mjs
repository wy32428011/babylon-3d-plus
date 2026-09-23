import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const output = path.resolve('output/conveyor-arrow-effects');
await mkdir(output, { recursive: true });
const packageResult = JSON.parse(await readFile(path.join(output, 'packages-result.json'), 'utf8'));
assert.equal(packageResult.ok, true);
const root = path.resolve(packageResult.viewerRoot);
assert.equal(path.dirname(root), output, '只运行本次验收目录中的 DIST Viewer');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
    await pipeline(createReadStream(file), response);
  } catch (error) { if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
const errors = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  // 业务启用配置使用本地 fixture；场景、运行时模块和 Shader 均来自实际 DIST ZIP。
  await page.route('**/api/v1/digital-twin/runtime-config/detail', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { projectId: '123', runtimeEnabled: true } }) }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  const engineModule = (await readdir(path.join(root, 'assets'))).find(name => name.startsWith('engineStore-'));
  assert.ok(engineModule);
  await page.evaluate(async source => {
    const module = await import('/assets/' + source);
    window.arrowViewerEngineStore = Object.values(module).find(value => Array.isArray(value?.Instances));
  }, engineModule);
  await page.waitForFunction(() => window.arrowViewerEngineStore?.Instances.some(engine => engine.scenes.some(scene => {
    const meshes = scene.meshes.filter(mesh => mesh.name.endsWith('_conveyor_arrow'));
    return meshes.length === 6 && meshes.every(mesh => mesh.isReady(true));
  })), null, { timeout: 120000 });
  await page.evaluate(() => {
    const scene = window.arrowViewerEngineStore.Instances.flatMap(engine => engine.scenes).find(scene => scene.meshes.some(mesh => mesh.name.endsWith('_conveyor_arrow')));
    const camera = scene.activeCamera; camera.alpha = -Math.PI / 2; camera.beta = 0.015; camera.radius = 30;
    camera.setTarget(camera.target.scale(0)); camera.mode = 1;
    camera.orthoLeft = -12; camera.orthoRight = 12; camera.orthoTop = 8; camera.orthoBottom = -8;
  });
  const pixels = async () => {
    const png = await page.locator('canvas').first().screenshot();
    return page.evaluate(async data => {
      const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const cells = Array.from({ length: 6 }, () => ({ cyan: 0, brightness: 0 }));
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const offset = (y * canvas.width + x) * 4;
        if (!(pixels[offset + 1] > 70 && pixels[offset + 1] > pixels[offset] * 1.25 && pixels[offset + 2] > pixels[offset] * 1.35)) continue;
        const cell = cells[Math.min(2, Math.floor(y * 3 / canvas.height)) * 2 + Math.min(1, Math.floor(x * 2 / canvas.width))];
        cell.cyan++; cell.brightness += pixels[offset + 1] + pixels[offset + 2];
      }
      return cells;
    }, png.toString('base64'));
  };
  let first = await pixels();
  const deadline = Date.now() + 15000;
  while (first.some(cell => cell.cyan < 100) && Date.now() < deadline) { await page.waitForTimeout(150); first = await pixels(); }
  assert.ok(first.every(cell => cell.cyan > 100), 'DIST Viewer 的六个位置必须都有可见箭头像素：' + JSON.stringify(first));
  await page.waitForTimeout(250); const second = await pixels();
  assert.ok(first.every((cell, index) => cell.brightness !== second[index].brightness), 'DIST Viewer 的六款箭头均应持续变化：' + JSON.stringify({ first, second }));
  const state = await page.evaluate(() => {
    const engine = window.arrowViewerEngineStore.Instances.find(engine => engine.scenes.some(scene => scene.meshes.some(mesh => mesh.name.endsWith('_conveyor_arrow'))));
    const meshes = engine.scenes.flatMap(scene => scene.meshes).filter(mesh => mesh.name.endsWith('_conveyor_arrow'));
    return { renderer: engine.getGlInfo().renderer, meshes: meshes.map(mesh => ({ name: mesh.name, vertices: mesh.getTotalVertices(), material: mesh.material.getClassName() })) };
  });
  assert.equal(state.meshes.length, 6); assert.ok(state.meshes.every(mesh => mesh.vertices > 0 && mesh.material === 'ShaderMaterial'));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'viewer.png') });
  await writeFile(path.join(output, 'viewer-result.json'), JSON.stringify({ ok: true, first, second, ...state, errors, platformConfig: 'local-fixture' }, null, 2));
  console.log('PASS: 实际 DIST Viewer 加载六款箭头、Shader 编译、六处 WebGL 可见像素与持续动画。');
} catch (error) { if (page) await page.screenshot({ path: path.join(output, 'viewer-failure.png') }); throw error; }
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
