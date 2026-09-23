import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/alarm-appearance');
await mkdir(output, { recursive: true });
const positions = new Float32Array([-1,-1,-1,1,-1,-1,1,1,-1,-1,1,-1,-1,-1,1,1,-1,1,1,1,1,-1,1,1]);
const indices = new Uint16Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,1,2,6,1,6,5,0,4,7,0,7,3]);
const binary = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
const modelPath = path.join(output, 'device.gltf');
await writeFile(modelPath, JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'DeviceCube', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [.1,.4,.3,1], metallicFactor: 0, roughnessFactor: 1 } }], buffers: [{ byteLength: binary.length, uri: 'data:application/octet-stream;base64,' + binary.toString('base64') }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }, { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength }], accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-1,-1,-1], max: [1,1,1] }, { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' }] }));
const server = await createServer({ cacheDir: path.join(output, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
let browser, page;
const errors = [];
async function cyanCount(png) {
  return page.evaluate(async base64 => {
    const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let cyan = 0;
    // 只比较左侧设备区域，排除中央坐标轴与右上角方向控件。
    for (let y = 70; y < canvas.height - 50; y++) for (let x = 0; x < canvas.width / 2 - 20; x++) {
      const i = (y * canvas.width + x) * 4;
      if (pixels[i + 1] > 100 && pixels[i + 2] > 100 && pixels[i + 1] > pixels[i] + 35 && pixels[i + 2] > pixels[i] + 45 && pixels[i + 2] > pixels[i + 1]) cyan++;
    }
    return cyan;
  }, png.toString('base64'));
}
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript(value => { window.alarmFixturePath = value; }, modelPath);
  const html = await server.transformIndexHtml('/__alarm_appearance__', '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/alarmAppearance.harness.tsx"></script></body></html>');
  await page.route('**/__alarm_appearance__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__alarm_appearance__', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.alarmAppearanceHarness?.ready(), null, { timeout: 180000 });
  await page.evaluate(() => window.alarmAppearanceHarness.camera());
  const slot = page.getByRole('group', { name: '报警外观特效', exact: true });
  await slot.waitFor();
  await page.getByRole('button', { name: '模型库', exact: true }).click();
  await page.getByRole('button', { name: /^立方体/ }).dragTo(slot);
  await page.getByRole('alert').filter({ hasText: '请从特效库拖入' }).waitFor();
  assert.equal(await page.evaluate(() => window.alarmAppearanceHarness.config().appearanceEffect), null);
  await page.getByRole('button', { name: '特效库', exact: true }).click();
  await page.getByRole('button', { name: /^定位光柱 \/ 光锥/ }).dragTo(slot);
  await page.waitForFunction(() => window.alarmAppearanceHarness.config().appearanceEffect?.effectKind === 'light-pillar');
  assert.equal(await page.evaluate(() => window.alarmAppearanceHarness.store.getState().scene.entityIds.length), 3, '拖入属性不创建独立特效实体');
  await page.evaluate(() => window.alarmAppearanceHarness.store.getState().undo());
  await page.waitForFunction(() => window.alarmAppearanceHarness.config().appearanceEffect === null);
  await page.evaluate(() => window.alarmAppearanceHarness.store.getState().redo());
  await page.waitForFunction(() => window.alarmAppearanceHarness.config().appearanceEffect?.effectKind === 'light-pillar');
  console.log('PASS: 特效库拖入、模型拒绝、撤销重做');
  const saved = await page.evaluate(() => window.alarmAppearanceHarness.save());
  await writeFile(path.join(output, 'scene.scene.json'), saved);
  await page.evaluate(content => window.alarmAppearanceHarness.reopen(content), saved);
  await page.waitForFunction(() => window.alarmAppearanceHarness.ready() && window.alarmAppearanceHarness.config().appearanceEffect?.effectKind === 'light-pillar');
  await page.screenshot({ path: path.join(output, 'configured.png') });
  console.log('PASS: 保存重开');
  const readiness = await page.evaluate(() => window.alarmAppearanceHarness.store.getState().startRuntimePreview());
  assert.equal(readiness.ok, true, JSON.stringify(readiness));
  await page.evaluate(() => window.alarmAppearanceHarness.camera());
  const baselineFrame = await page.evaluate(() => window.alarmAppearanceHarness.scene().getFrameId());
  await page.waitForFunction(frame => window.alarmAppearanceHarness.scene().getFrameId() > frame + 30, baselineFrame);
  const baselinePixels = await cyanCount(await page.locator('canvas').first().screenshot({ path: path.join(output, 'baseline-canvas.png') }));
  await page.evaluate(() => window.alarmAppearanceHarness.signal(0, true));
  await page.waitForFunction(() => !!window.alarmAppearanceHarness.effect(0));
  assert.equal(await page.evaluate(() => !!window.alarmAppearanceHarness.effect(1)), false);
  const frame = await page.evaluate(() => window.alarmAppearanceHarness.scene().getFrameId());
  await page.waitForFunction(frame => window.alarmAppearanceHarness.scene().getFrameId() > frame + 30, frame);
  const png = await page.locator('canvas').first().screenshot({ path: path.join(output, 'active-canvas.png') });
  const cyanPixels = await cyanCount(png);
  assert.ok(cyanPixels > baselinePixels + 200, '必须比未报警画面多出可见的青色光柱像素：' + cyanPixels + '/' + baselinePixels);
  console.log('光柱像素', { baselinePixels, cyanPixels });
  await page.evaluate(() => window.alarmAppearanceHarness.signal(1, true));
  await page.waitForFunction(() => !!window.alarmAppearanceHarness.effect(1));
  await page.evaluate(() => window.alarmAppearanceHarness.signal(0, false));
  await page.waitForFunction(() => !window.alarmAppearanceHarness.effect(0) && !!window.alarmAppearanceHarness.effect(1));
  await page.evaluate(() => window.alarmAppearanceHarness.store.getState().stopRuntimePreview());
  await page.waitForFunction(() => !window.alarmAppearanceHarness.effect(0) && !window.alarmAppearanceHarness.effect(1));
  await page.evaluate(() => window.alarmAppearanceHarness.store.getState().selectEntity(window.alarmAppearanceHarness.managerId));
  await page.getByRole('button', { name: /^高度渐变着色/ }).dragTo(slot);
  await page.waitForFunction(() => window.alarmAppearanceHarness.config().appearanceEffect?.effectKind === 'height-gradient');
  assert.equal((await page.evaluate(() => window.alarmAppearanceHarness.store.getState().startRuntimePreview())).ok, true);
  await page.evaluate(() => { window.alarmAppearanceHarness.camera(); window.alarmAppearanceHarness.signal(0, true); });
  await page.waitForFunction(() => window.alarmAppearanceHarness.modelMeshes(0).some(mesh => mesh.material?.name.endsWith('_effect')));
  const surfaceFrame = await page.evaluate(() => window.alarmAppearanceHarness.scene().getFrameId());
  await page.waitForFunction(frame => window.alarmAppearanceHarness.scene().getFrameId() > frame + 30, surfaceFrame);
  const surfacePixels = await cyanCount(await page.locator('canvas').first().screenshot({ path: path.join(output, 'surface-canvas.png') }));
  assert.ok(surfacePixels > baselinePixels + 1000, '模型表面必须实际显示渐变特效：' + surfacePixels);
  await page.evaluate(() => window.alarmAppearanceHarness.store.getState().stopRuntimePreview());
  await page.waitForFunction(() => window.alarmAppearanceHarness.modelMeshes(0).every(mesh => !mesh.material?.name.endsWith('_effect')));
  await page.evaluate(() => window.alarmAppearanceHarness.store.getState().selectEntity(window.alarmAppearanceHarness.managerId));
  await page.getByRole('button', { name: '清空报警外观特效', exact: true }).click();
  await page.waitForFunction(() => window.alarmAppearanceHarness.config().appearanceEffect === null);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.alarmAppearanceHarness.dispose());
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, baselinePixels, cyanPixels, surfacePixels, errors, checks: ['library-drag', 'reject-model', 'undo-redo', 'save-reopen', 'preview', 'visible-effect-pixels', 'per-device-alarm', 'clear-stop'] }, null, 2));
  console.log('PASS: 特效库真实拖放、模型拒绝、撤销重做、保存重开、运行预览可见像素、多设备报警与停止清理。cyanPixels=' + cyanPixels);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') });
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
