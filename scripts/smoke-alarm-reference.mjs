import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const output = path.resolve('output/playwright/alarm-reference');
await mkdir(output, { recursive: true });
const selectedKinds = process.argv.find(value => value.startsWith('--kinds='))?.slice('--kinds='.length).split(',');
const previousResults = selectedKinds ? JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8')).results : [];
let previousFocusedResults = [];
if (selectedKinds) {
  try { previousFocusedResults = JSON.parse(await readFile(path.join(output, 'result-focused.json'), 'utf8')).results ?? []; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const socket = createNetServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const server = await createServer({ cacheDir: path.join(output, 'vite-cache'),
  optimizeDeps: { entries: ['tests/fixtures/alarmReference.harness.ts', 'tests/fixtures/alarmAppearance.harness.tsx'] },
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false } });
const expectedKinds = ['model-color', 'model-flash', 'breathing-ring', 'model-outline', 'warning-beacon', 'alarm-icon', 'light-pillar', 'ripple-ring', 'alarm-zone', 'alarm-label', 'smoke-plume', 'alarm-route'];
const animatedKinds = new Set(['model-flash', 'breathing-ring', 'warning-beacon', 'alarm-icon', 'ripple-ring', 'smoke-plume', 'alarm-route']);
const results = [], errors = [];
let browser, page;

async function waitFrames(count = 20) {
  const frame = await page.evaluate(() => (window.alarmReferenceHarness?.scene ?? window.alarmAppearanceHarness.scene()).getFrameId());
  await page.waitForFunction(({ frame, count }) => (window.alarmReferenceHarness?.scene ?? window.alarmAppearanceHarness.scene()).getFrameId() > frame + count, { frame, count });
}

async function changedPixels(before, after, rectangles = []) {
  return page.evaluate(async ({ before, after, rectangles }) => {
    const load = async data => {
      const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return { data: context.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height };
    };
    const [a, b] = await Promise.all([load(before), load(after)]);
    let changed = 0;
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
      if (rectangles.some(rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) continue;
      const offset = (y * a.width + x) * 4;
      if (Math.max(...[0, 1, 2].map(channel => Math.abs(a.data[offset + channel] - b.data[offset + channel]))) > 18) changed++;
    }
    return changed;
  }, { before: before.toString('base64'), after: after.toString('base64'), rectangles });
}

async function routeHarness(url, source) {
  const html = await server.transformIndexHtml(url, '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="' + source + '"></script></body></html>');
  await page.route('**' + url, route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + url.slice(1), { waitUntil: 'domcontentloaded', timeout: 180000 });
}

try {
  await server.listen();
  await server.watcher.close();
  console.log('报警参考图验证服务：' + server.resolvedUrls.local[0]);
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  page = await browser.newPage({ viewport: { width: 1100, height: 810 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error('浏览器：' + message.text()); });
  await routeHarness('/__alarm_reference__', '/tests/fixtures/alarmReference.harness.ts');
  await page.waitForFunction(() => !!window.alarmReferenceHarness, null, { timeout: 180000 });
  console.log('PASS: 真实Babylon参考图fixture已加载');
  const presets = await page.evaluate(() => window.alarmReferenceHarness.presets);
  assert.deepEqual(presets.map(preset => preset.effectKind), expectedKinds, '12项应逐一对应参考图');
  for (const [index, preset] of [...presets.entries()].filter(([, preset]) => !selectedKinds || selectedKinds.includes(preset.effectKind))) {
    console.log('验证 ' + preset.name);
    await page.evaluate(id => window.alarmReferenceHarness.setPreset(id), preset.id);
    await waitFrames(5);
    const baseline = await page.locator('#alarm-canvas').screenshot();
    const resourceBaselineSample = await page.evaluate(() => window.alarmReferenceHarness.sample());
    const resourceBaseline = resourceBaselineSample.resources;
    await page.evaluate(() => window.alarmReferenceHarness.signal(0, true));
    await page.waitForFunction(() => window.alarmReferenceHarness.sample().active[0]);
    await waitFrames(40);
    const sample = await page.evaluate(() => window.alarmReferenceHarness.sample());
    assert.deepEqual(sample.active, [true, false]);
    assert.equal(sample.restored[1], true, '正常设备不能被覆盖：' + preset.name);
    assert.ok(sample.roots[0], '报警外观必须挂到当前设备：' + preset.name);
    if (!['model-color', 'model-flash', 'model-outline'].includes(preset.effectKind)) assert.ok(sample.effectMeshes.some(mesh => mesh.visible), '该效果应创建可见几何：' + preset.name);
    const imageName = String(index + 1).padStart(2, '0') + '-' + preset.effectKind + '.png';
    let active = await page.locator('#alarm-canvas').screenshot();
    let visualChangedPixels = await changedPixels(baseline, active);
    if (preset.effectKind === 'model-flash') {
      // 闪烁的熄灭帧与正常画面一致，取一个完整周期内最明显的亮起帧作为静态交付图。
      for (let phase = 0; phase < 5; phase++) {
        await waitFrames(12);
        const candidate = await page.locator('#alarm-canvas').screenshot();
        const difference = await changedPixels(baseline, candidate);
        if (difference > visualChangedPixels) { visualChangedPixels = difference; active = candidate; }
      }
    }
    await writeFile(path.join(output, imageName), active);
    assert.ok(visualChangedPixels > 150, '必须实际改变画布像素：' + preset.name + ' / ' + visualChangedPixels);
    let animationChangedPixels = null;
    if (animatedKinds.has(preset.effectKind)) {
      let maximum = 0;
      for (let frame = 0; frame < 3; frame++) {
        await waitFrames(12);
        const animated = await page.locator('#alarm-canvas').screenshot({ path: frame === 2 ? path.join(output, String(index + 1).padStart(2, '0') + '-animation.png') : undefined });
        maximum = Math.max(maximum, await changedPixels(active, animated, preset.effectKind === 'model-flash' ? [] : sample.deviceRects));
        const visibleDifference = await changedPixels(baseline, animated);
        if (visibleDifference > visualChangedPixels) { visualChangedPixels = visibleDifference; active = animated; }
      }
      animationChangedPixels = maximum;
      assert.ok(maximum > 12, '设备范围外应有实际动画帧变化：' + preset.name + ' / ' + maximum);
      await writeFile(path.join(output, imageName), active);
    }
    await page.evaluate(() => { window.alarmReferenceHarness.signal(0, true); window.alarmReferenceHarness.signal(0, false, 'other-point'); window.alarmReferenceHarness.advance(86400000); });
    await waitFrames(12);
    assert.equal(await page.evaluate(() => window.alarmReferenceHarness.sample().active[0]), true, '相同值/其它点位/超时均应持续：' + preset.name);
    assert.equal(await page.evaluate(() => window.alarmReferenceHarness.sample().activations), 1, '保持报警不产生重复激活：' + preset.name);
    const beforeMove = await page.evaluate(() => window.alarmReferenceHarness.sample().roots[0][0]);
    await page.evaluate(() => window.alarmReferenceHarness.move(1.25));
    await waitFrames(8);
    const afterMove = await page.evaluate(() => window.alarmReferenceHarness.sample().roots[0][0]);
    assert.ok(Math.abs(afterMove - beforeMove - 1.25) < .001, '外观跟随设备位移：' + preset.name);
    await page.evaluate(() => window.alarmReferenceHarness.signal(0, false));
    await page.waitForFunction(() => !window.alarmReferenceHarness.sample().active[0]);
    await waitFrames(8);
    const cleared = await page.evaluate(() => window.alarmReferenceHarness.sample());
    assert.deepEqual(cleared.restored, [true, true], '解除必须恢复原材质：' + preset.name);
    assert.deepEqual(cleared.roots, [null, null], '解除必须移除附着外观：' + preset.name);
    assert.deepEqual(cleared.resources, resourceBaseline, '解除必须释放本次效果资源：' + preset.name + ' / 新增材质=' + cleared.materialNames.filter(name => !resourceBaselineSample.materialNames.includes(name)));
    results.push({ ...preset, screenshot: imageName, visualChangedPixels, animationChangedPixels, effectMeshes: sample.effectMeshes.map(mesh => mesh.name), checks: ['raw-mqtt', 'device-isolation', 'visible-pixels', 'last-value-hold', 'same-value-hold', 'follow-device', 'restore-material', 'release-resources'] });
    console.log('PASS ' + String(index + 1).padStart(2, '0') + ': ' + preset.name + ' pixels=' + visualChangedPixels + ' animation=' + animationChangedPixels);
  }
  await page.evaluate(() => window.alarmReferenceHarness.dispose());

  // 实际编辑器操作：目标从空槽位开始，使用真实模型库拖放、样式选择和属性控件。
  if (!process.argv.includes('--skip-editor')) {
  const positions = new Float32Array([-1,-1,-1,1,-1,-1,1,1,-1,-1,1,-1,-1,-1,1,1,-1,1,1,1,1,-1,1,1]);
  const indices = new Uint16Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,1,2,6,1,6,5,0,4,7,0,7,3]);
  const binary = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const sourcePath = path.join(output, 'scene-model-versions', 'a'.repeat(64), 'b'.repeat(64), 'Model-42-设备', 'device.gltf');
  const libraryPath = path.join(output, 'shared-models', 'Model-42-设备', 'device.gltf');
  const gltf = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'DeviceCube', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [.1,.4,.3,1], metallicFactor: 0, roughnessFactor: 1 } }], buffers: [{ byteLength: binary.length, uri: 'data:application/octet-stream;base64,' + binary.toString('base64') }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }, { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength }], accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-1,-1,-1], max: [1,1,1] }, { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' }] });
  for (const file of [sourcePath, libraryPath]) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, gltf); }
  await page.setViewportSize({ width: 1500, height: 1050 });
  await page.addInitScript(value => { window.alarmFixturePaths = value; }, { sourcePath, libraryPath });
  await routeHarness('/__alarm_reference_editor__', '/tests/fixtures/alarmAppearance.harness.tsx');
  await page.waitForFunction(() => window.alarmAppearanceHarness?.ready(), null, { timeout: 180000 });
  await page.getByLabel('监听属性', { exact: true }).selectOption('CUSTOM PROPERTY');
  await page.getByLabel('火警属性', { exact: true }).fill('normal');
  await page.getByLabel('触发值', { exact: true }).fill('true');
  await page.getByLabel('目标 Size', { exact: true }).fill('1');
  await page.getByLabel('目标 Size', { exact: true }).press('Enter');
  await page.getByRole('button', { name: '模型库', exact: true }).click();
  await page.getByRole('button', { name: /^报警测试设备/ }).dragTo(page.getByRole('group', { name: '设备类型 1', exact: true }));
  await page.waitForFunction(() => window.alarmAppearanceHarness.resolvedTargetCount() === 2);
  const presetSelect = page.getByLabel('报警外观样式', { exact: true });
  for (const preset of presets) {
    await presetSelect.selectOption(preset.id);
    assert.equal(await page.evaluate(() => window.alarmAppearanceHarness.config().appearanceEffect.effectKind), preset.effectKind);
  }
  const chosen = presets.find(preset => preset.effectKind === 'alarm-icon');
  await presetSelect.selectOption(chosen.id);
  const appearance = page.getByRole('group', { name: '报警外观属性', exact: true });
  await appearance.getByLabel('主颜色', { exact: true }).fill('#ff9900');
  assert.equal(await page.evaluate(() => window.alarmAppearanceHarness.config().appearanceEffect.primaryColor), '#ff9900');
  const saved = await page.evaluate(() => window.alarmAppearanceHarness.save());
  await writeFile(path.join(output, 'configured.scene.json'), saved);
  await page.evaluate(content => window.alarmAppearanceHarness.reopen(content), saved);
  await page.waitForFunction(() => window.alarmAppearanceHarness.ready() && window.alarmAppearanceHarness.config().appearanceEffect.effectKind === 'alarm-icon');
  assert.equal(await appearance.getByLabel('主颜色', { exact: true }).inputValue(), '#ff9900');
  await page.screenshot({ path: path.join(output, 'editor-configured.png') });
  assert.equal((await page.evaluate(() => window.alarmAppearanceHarness.store.getState().startRuntimePreview())).ok, true);
  await page.evaluate(() => { window.alarmAppearanceHarness.camera(); window.alarmAppearanceHarness.signal(0, true); });
  await page.waitForFunction(() => !!window.alarmAppearanceHarness.effect(0));
  await waitFrames(35);
  assert.equal(await page.evaluate(() => !!window.alarmAppearanceHarness.effect(1)), false);
  await page.locator('canvas').first().screenshot({ path: path.join(output, 'editor-alarm-icon.png') });
  await page.evaluate(() => window.alarmAppearanceHarness.signal(0, false));
  await page.waitForFunction(() => !window.alarmAppearanceHarness.effect(0));
  await page.evaluate(() => window.alarmAppearanceHarness.store.getState().stopRuntimePreview());
  await page.evaluate(() => window.alarmAppearanceHarness.dispose());
  console.log('PASS: 真实编辑器12项选择、颜色修改、保存重开、normal=true图标预览、false解除');
  }

  const focusedResults = presets.map(preset => results.find(result => result.id === preset.id) ?? previousFocusedResults.find(result => result.id === preset.id)).filter(Boolean);
  const galleryResults = presets.map(preset => focusedResults.find(result => result.id === preset.id) ?? previousResults.find(result => result.id === preset.id)).filter(Boolean);
  const tiles = await Promise.all(galleryResults.map(async result => '<figure style="margin:0;background:#101f2d;border:1px solid #1d5976;border-radius:9px;overflow:hidden"><figcaption style="padding:12px 14px;color:#d7efff;font:bold 20px system-ui">' + result.name + '</figcaption><div style="height:290px;overflow:hidden;position:relative"><img style="display:block;position:absolute;width:210%;max-width:none;left:-34%;top:-20%" src="data:image/png;base64,' + (await readFile(path.join(output, result.screenshot))).toString('base64') + '"></div><div style="padding:10px 14px;color:#81b4c9;font:13px system-ui">' + result.effectKind + ' · 实际报警运行时</div></figure>'));
  await page.setViewportSize({ width: 1760, height: 1200 });
  await page.setContent('<html><body style="margin:0;padding:24px;background:#06101b"><h1 style="margin:0 0 8px;color:#ddf4ff;font:32px system-ui">数字孪生报警外观 · 12项真实WebGL验证</h1><p style="color:#80aac4;font:15px system-ui;margin:0 0 22px">实际画布中的报警设备局部。每张原始截图同时保留正常设备，用于核对设备隔离。</p><div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px">' + tiles.join('') + '</div></body></html>');
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.screenshot({ path: path.join(output, 'reference-gallery.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, selectedKinds ? 'result-focused.json' : 'result.json'), JSON.stringify({ ok: true, results: selectedKinds ? focusedResults : results, editor: process.argv.includes('--skip-editor') ? null : { realTargetDrag: true, presetSelectionCount: 12, colorEdit: true, saveReopen: true, preview: true, clear: true }, errors }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
    console.error('现场', JSON.stringify(await page.evaluate(() => window.alarmReferenceHarness?.sample() ?? window.alarmAppearanceHarness?.diagnostic()), null, 2));
  }
  await writeFile(path.join(output, selectedKinds ? 'result-focused.json' : 'result.json'), JSON.stringify({ ok: false, error: String(error), results, errors }, null, 2));
  throw error;
} finally { await browser?.close(); await server.close(); }
