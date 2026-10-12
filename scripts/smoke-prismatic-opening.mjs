import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { NullEngine, Scene, MeshBuilder, StandardMaterial, Color3 } from '@babylonjs/core';
import { GLTF2Export } from '@babylonjs/serializers/glTF/2.0/glTFSerializer.js';
import { buildPrismaticOpeningPackage } from './build-prismatic-opening-package.mjs';

const output = path.resolve('output/playwright/prismatic-opening'); await mkdir(output, { recursive: true });
const packageResult = await buildPrismaticOpeningPackage();
const modelEngine = new NullEngine();
async function environmentFile(kind) {
  const scene = new Scene(modelEngine), material = new StandardMaterial('fixture-surface', scene);
  material.diffuseColor = new Color3(.3, .45, .55);
  const box = (name, x, y, z, width, height, depth) => {
    const mesh = MeshBuilder.CreateBox(name, { width, height, depth }, scene); mesh.position.set(x, y, z); mesh.material = material;
  };
  if (kind === 'warehouse') {
    box('warehouse-floor', 0, .1, 0, 24, .2, 18);
    for (let row = 0; row < 4; row++) for (let col = 0; col < 5; col++) {
      const x = row * 5 - 7.5, z = col * 3 - 6;
      for (const side of [-1, 1]) box(`shelf-post-${row}-${col}-${side}`, x + side * 1.1, 3, z, .12, 6, .12);
      for (let level = 1; level <= 5; level++) box(`shelf-${row}-${col}-${level}`, x, level, z, 2.4, .09, 2.3);
    }
  } else {
    box('tower-podium', 0, .1, 0, 12, .2, 12); box('tower-core', 0, 10, 0, 6, 20, 6);
    for (let level = 1; level <= 9; level++) box(`tower-floor-${level}`, 0, level * 2, 0, 8, .15, 8);
  }
  const glb = await GLTF2Export.GLBAsync(scene, kind); const bytes = Buffer.from(await glb.glTFFiles[`${kind}.glb`].arrayBuffer());
  scene.dispose(); await writeFile(path.join(output, `${kind}.glb`), bytes); return bytes;
}
const models = { warehouse: await environmentFile('warehouse'), tower: await environmentFile('tower') }; modelEngine.dispose();
const siteRoot = path.join(output, 'editor-fixture');
await build({ configFile: false, logLevel: 'warn', publicDir: false, cacheDir: path.join(output, '.vite-build'), build: {
  outDir: siteRoot, emptyOutDir: true, target: 'esnext', minify: false, assetsInlineLimit: 0,
  rolldownOptions: { input: path.resolve('tests/fixtures/prismaticOpening.html') },
} });
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
  const file = path.resolve(siteRoot, `.${decodeURIComponent(pathname)}`);
  if (!file.startsWith(`${siteRoot}${path.sep}`)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(file)] ?? 'application/octet-stream');
    const bytes = await readFile(file).catch(() => readFile(path.join(path.resolve('public'), path.relative(siteRoot, file))));
    response.end(bytes);
  } catch { console.error('fixture 404:', pathname); response.writeHead(404).end(); }
});
let browser;
const report = { ok: false, checks: [], errors: [], screenshots: [], boundary: '真实Editor组件、Chrome/WebGL、程序生成并实际加载的GLB环境夹具；不代表用户业务模型或线上部署。' };
const note = message => { console.log(message); report.checks.push(message); };
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } }); page.setDefaultTimeout(45000);
  page.on('pageerror', error => { report.errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') { report.errors.push(message.text()); console.error(message.text()); } });
  page.on('console', message => { if (message.type() === 'warning') console.log('Editor诊断:', message.text()); });
  await page.route('**/__prismatic__/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/definition.json')) return route.fulfill({ json: packageResult.definition });
    const match = /\/(warehouse|tower)\.glb$/.exec(pathname);
    if (match) return route.fulfill({ contentType: 'model/gltf-binary', body: models[match[1]] });
    const file = path.resolve(packageResult.folder, pathname.split('/__prismatic__/')[1]);
    assert.ok(!path.relative(packageResult.folder, file).startsWith('..'));
    await route.fulfill({ body: await readFile(file), contentType: file.endsWith('.svg') ? 'image/svg+xml' : 'application/json' });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/tests/fixtures/prismaticOpening.html`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.prismaticHarness?.environmentReady(), null, { timeout: 45000 }).catch(async error => {
    console.error('Editor启动诊断:', await page.locator('body').innerText());
    await page.screenshot({ path: path.join(output, 'editor-startup-failure.png') }); throw error;
  });
  await page.getByRole('button', { name: '导入开场包', exact: true }).click();
  await page.getByRole('button', { name: '应用到当前场景', exact: true }).click();
  const checkbox = page.locator('label').filter({ hasText: '进入场景时播放' }).locator('input'); await checkbox.check();
  const saved = await page.evaluate(() => window.prismaticHarness.save());
  await writeFile(path.join(output, 'editor.scene.json'), saved);
  await page.evaluate(content => window.prismaticHarness.reopen(content), saved);
  await page.waitForFunction(() => window.prismaticHarness.environmentReady());
  assert.equal(JSON.parse(await page.evaluate(() => window.prismaticHarness.save())).scene.sceneSettings.openingAnimation.package.id, 'prismatic-genesis');
  note('真实Editor导入、应用、启用和保存重开通过');
  await page.evaluate(() => window.prismaticHarness.startProbe());
  const before = await page.evaluate(() => window.prismaticHarness.state());
  const host = page.locator('.prismatic-opening');
  const seek = async seconds => {
    await host.locator('input[type="range"]').evaluate((range, value) => { range.value = String(value); range.dispatchEvent(new Event('input', { bubbles: true })); }, seconds);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const capture = async name => { const file = path.join(output, name + '.png'); await page.locator('.prismatic-artboard').screenshot({ path: file }); report.screenshots.push(file); };
  const open = async () => {
    await page.getByRole('button', { name: '预览开场动画', exact: true }).click();
    await host.getByRole('button', { name: '暂停', exact: true }).waitFor({ timeout: 35000 }).catch(async error => {
      console.error('预览诊断:', await page.locator('body').innerText()); throw error;
    });
    await page.waitForFunction(() => Number(document.querySelector('.prismatic-controls input')?.max) === 22);
    await host.getByRole('button', { name: '暂停', exact: true }).click();
  };
  await open();
  for (const [seconds, phase] of [[2, 'core'], [5, 'tunnel'], [10.5, 'assembly'], [18, 'showcase']]) {
    await seek(seconds); assert.equal(await host.locator('.prismatic-artboard').getAttribute('data-phase'), phase); await capture(phase);
  }
  const warehouseImage = await host.locator('.prismatic-world').evaluate(canvas => canvas.toDataURL());
  const frozen = await host.locator('.prismatic-atmosphere').evaluate(canvas => canvas.toDataURL());
  await page.waitForTimeout(250); assert.equal(await host.locator('.prismatic-atmosphere').evaluate(canvas => canvas.toDataURL()), frozen);
  const during = await page.evaluate(() => window.prismaticHarness.state());
  assert.ok(during.frames > before.frames); assert.ok(during.alpha > before.alpha); assert.deepEqual(during.models, before.models);
  await host.getByRole('button', { name: '重播', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.prismatic-artboard')?.dataset.phase === 'core');
  await host.getByRole('button', { name: '暂停', exact: true }).click();
  await seek(10.5);
  await host.getByRole('button', { name: '播放', exact: true }).click(); await page.waitForTimeout(250);
  assert.ok(Number(await host.locator('input[type="range"]').inputValue()) > 10.5);
  await host.getByRole('button', { name: '进入场景', exact: true }).click(); await host.waitFor({ state: 'detached' });
  const after = await page.evaluate(() => window.prismaticHarness.state()); assert.equal(after.engines, before.engines); assert.deepEqual(after.models, before.models);
  note('四段真实WebGL截图、拖动寻帧、暂停、恢复、重播、跳过与业务相机/环境隔离通过');
  await page.evaluate(() => window.prismaticHarness.switchEnvironment('tower')); await page.waitForFunction(() => window.prismaticHarness.environmentReady());
  await open(); await seek(18); await capture('alternate-environment');
  assert.notEqual(await host.locator('.prismatic-world').evaluate(canvas => canvas.toDataURL()), warehouseImage, '更换环境模型必须改变真实三维像素');
  await page.getByRole('button', { name: '关闭开场预览 · Esc', exact: true }).click(); await host.waitFor({ state: 'detached' });
  note('切换不同GLB环境改变实际仓库几何，关闭预览释放独立Engine通过');
  await page.evaluate(() => window.prismaticHarness.switchEnvironment('missing'));
  await page.getByRole('button', { name: '预览开场动画', exact: true }).click();
  await page.waitForTimeout(500); assert.equal(await host.count(), 0); assert.equal(await page.locator('.opening-editor-preview').count(), 0);
  assert.deepEqual(report.errors, []); report.ok = true; note('缺失环境不生成假仓库，退出开场且无浏览器错误');
  await page.evaluate(() => window.prismaticHarness.dispose());
} finally {
  await writeFile(path.join(output, 'webgl-result.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
