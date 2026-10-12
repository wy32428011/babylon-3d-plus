import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/prismatic-opening'), root = path.join(output, 'published-viewer');
const requests = new Map(), errors = [];
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (pathname === '/api/v1/digital-twin/runtime-config/detail') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, data: { projectId: '123', runtimeEnabled: true } })); return;
  }
  const file = path.resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  try {
    const bytes = await readFile(file); requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
    response.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' }[path.extname(file)] ?? 'application/octet-stream' }).end(bytes);
  } catch { console.error('Viewer 404:', pathname); response.writeHead(404).end(); }
});
let browser;
const report = { ok: false, errors, checks: [], boundary: '真实Electron导出的本地DIST Viewer、Chrome/WebGL与GLB夹具，业务API使用本地配置桩；不代表线上部署。' };
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); } });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  const host = page.locator('.prismatic-opening'); await host.waitFor({ timeout: 60000 });
  await page.waitForFunction(() => Number(document.querySelector('.prismatic-controls input')?.max) === 22, null, { timeout: 45000 });
  await page.waitForTimeout(300);
  const initialGlbReads = [...requests.entries()].filter(([url]) => url.startsWith('/project/assets/environments/') && url.endsWith('.glb'));
  await host.getByRole('button', { name: '暂停', exact: true }).click();
  for (const seconds of [2, 5, 10.5, 18]) {
    await host.locator('input').evaluate((range, value) => { range.value = String(value); range.dispatchEvent(new Event('input', { bubbles: true })); }, seconds);
    await page.locator('.prismatic-artboard').screenshot({ path: path.join(output, `viewer-${seconds}s.png`) });
  }
  const modules = await readdir(path.join(root, 'assets')), storeFile = modules.find(name => name.startsWith('engineStore-') && name.endsWith('.js'));
  await page.evaluate(async name => {
    const module = await import('/assets/' + name); const store = Object.values(module).find(value => Array.isArray(value?.Instances));
    window.prismaticViewerScene = store.Instances.flatMap(engine => engine.scenes).find(s => s.meshes.some(m => m.metadata?.editorEnvironmentMesh));
  }, storeFile);
  const state = () => page.evaluate(() => ({ frame: window.prismaticViewerScene.getFrameId(), alpha: window.prismaticViewerScene.activeCamera.alpha,
    env: window.prismaticViewerScene.meshes.filter(m => m.metadata?.editorEnvironmentMesh).length }));
  const before = await state(); await page.waitForTimeout(250); const after = await state();
  assert.ok(before.env > 100); assert.ok(after.frame > before.frame); assert.equal(after.alpha, before.alpha);
  const frozen = await host.locator('.prismatic-world').evaluate(c => c.toDataURL()); await page.waitForTimeout(150);
  assert.equal(await host.locator('.prismatic-world').evaluate(c => c.toDataURL()), frozen);
  await host.getByRole('button', { name: '进入场景', exact: true }).click(); await host.waitFor({ state: 'detached' });
  assert.equal(await page.locator('canvas.player-canvas').count(), 1);
  const canvas = page.locator('canvas.player-canvas'), box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 35, { steps: 6 }); await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(150); assert.notEqual((await state()).alpha, before.alpha);
  const glbRequests = [...requests.entries()].filter(([url]) => url.startsWith('/project/assets/environments/') && url.endsWith('.glb'));
  report.environmentRequests = { initial: initialGlbReads, after: glbRequests };
  assert.equal(new Set(glbRequests.map(([url]) => decodeURIComponent(url))).size, 1); assert.deepEqual(glbRequests, initialGlbReads);
  report.checks.push('四段实际DIST画面', '暂停冻结与业务帧继续', '跳过后相机手势可用', '开场不额外请求环境GLB');
  await page.screenshot({ path: path.join(output, 'viewer-business-after-skip.png') });
  await page.reload({ waitUntil: 'load' }); await host.waitFor({ timeout: 45000 }); await host.waitFor({ state: 'detached', timeout: 45000 });
  report.checks.push('22秒自然播放完成'); assert.deepEqual(errors, []); report.ok = true; console.log('PASS: 实际DIST Viewer开场画面、隔离、跳过、资源复用及自然完成');
} finally {
  await writeFile(path.join(output, 'viewer-webgl-result.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
