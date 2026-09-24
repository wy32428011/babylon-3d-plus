import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve('output/digital-twin-effects/viewer');
const output = path.resolve('output/playwright/digital-twin-effects');
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
    await pipeline(createReadStream(file), res);
  } catch (error) { if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
const errors = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  // 仅模拟业务平台的启用配置；加载的场景、JS、Shader 均来自实际 DIST ZIP。
  await page.route('**/api/v1/digital-twin/runtime-config/detail', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { projectId: '123', runtimeEnabled: true } }) }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  const engineModule = (await readdir(path.join(root, 'assets'))).find(name => name.startsWith('engineStore-'));
  assert.ok(engineModule);
  await page.evaluate(async source => {
    const module = await import('/assets/' + source);
    window.viewerEngineStore = Object.values(module).find(value => Array.isArray(value?.Instances));
  }, engineModule);
  await page.waitForFunction(() => window.viewerEngineStore?.Instances.some(engine => engine.scenes.some(scene => scene.meshes.some(mesh => mesh.metadata?.effectRole === 'energy-hemisphere' && mesh.isReady(true)))), null, { timeout: 120000 });
  await page.evaluate(() => {
    const scene = window.viewerEngineStore.Instances.flatMap(engine=>engine.scenes).find(scene=>scene.meshes.some(mesh=>mesh.metadata?.effectRole==='energy-hemisphere'));
    const camera=scene.activeCamera;const center=camera.target.clone();center.set(0,2.5,0);camera.setTarget(center);camera.alpha=-1.2;camera.beta=1.1;camera.radius=24;
    const count=scene.transformNodes.filter(node=>node.name.endsWith('_poiEffectRoot')).length;
    if(count!==43)throw Error('发布特效实例数量不符: '+count);
  });
  const pixels = async () => {
    const png = await page.locator('canvas').first().screenshot();
    return page.evaluate(async data => {
      const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
      let count = 0, brightness = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i+1] > 60 && pixels[i+1] > pixels[i] * 1.3 && pixels[i+2] > pixels[i] * 1.5) { count++; brightness += pixels[i] + pixels[i + 1]; }
      return { count, brightness };
    }, png.toString('base64'));
  };
  let first = await pixels();
  const deadline = Date.now() + 15000;
  while (first.count < 500 && Date.now() < deadline) { await page.waitForTimeout(100); first = await pixels(); }
  assert.ok(first.count > 500, '发布 Viewer 必须绘制可见特效：' + JSON.stringify(first));
  await page.waitForTimeout(230);
  const second = await pixels();
  assert.notDeepEqual(second, first, '发布 Viewer 特效应持续流动');
  const state = await page.evaluate(() => {
    const engine = window.viewerEngineStore.Instances.find(engine => engine.scenes.some(scene => scene.meshes.some(mesh => mesh.metadata?.effectRole === 'energy-hemisphere')));
    const mesh = engine.scenes.flatMap(scene => scene.meshes).find(mesh => mesh.metadata?.effectRole === 'energy-hemisphere');
    return { renderer: engine.getGlInfo().renderer, vertices: mesh.getTotalVertices(), indices: mesh.getTotalIndices(), material: mesh.material.getClassName() };
  });
  assert.ok(state.vertices > 100); assert.ok(state.indices > 100);
  assert.equal(state.material, 'ShaderMaterial'); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'viewer.png') });
  await writeFile(path.join(output, 'viewer-result.json'), JSON.stringify({ ok: true, first, second, ...state, errors, platformConfig: 'local-fixture' }, null, 2));
  console.log('PASS: 实际 DIST Viewer 加载新版特效、Shader 编译、硬件 WebGL 可见像素与持续动画。');
} catch (error) { if (page) await page.screenshot({ path: path.join(output, 'viewer-failure.png') }); throw error; }
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
