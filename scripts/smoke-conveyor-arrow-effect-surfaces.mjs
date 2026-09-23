import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/conveyor-arrow-effects/surface');
await mkdir(output, { recursive: true });
const fixture = JSON.parse(await readFile('examples/scenes/virtual-conveyor-mqtt-demo.scene.json', 'utf8'));
const [id] = fixture.scene.entityIds, entity = fixture.scene.entities[id];
fixture.scene.entityIds = [id]; fixture.scene.entities = { [id]: entity }; fixture.scene.selectedEntityId = id;
entity.name = '六款箭头表面样式验收'; entity.components.transform.position = { x: 0, y: 0, z: 0 };
const asset = entity.components.modelAsset, packageRoot = path.resolve('public/builtin-model-packages/virtual-conveyor');
const toUrl = file => 'editor-asset://local/' + encodeURIComponent(file);
asset.sourcePath = path.join(packageRoot, 'virtual-conveyor.glb'); asset.sourceUrl = toUrl(asset.sourcePath);
for (const script of asset.scriptAssets ?? []) { script.path = path.join(packageRoot, path.basename(script.path.replaceAll('\\', '/'))); script.sourceUrl = toUrl(script.path); }
asset.parameterValues = { ...asset.parameterValues, length: 6, width: 1.5, color: '#666666' };
entity.components.telemetryBinding.cargoOriginDevice = false;
delete entity.components.telemetryBinding.surfaceArrows;
const styles = [
  ['单一直线箭头', 'conveyor-arrow-single', 4], ['连续箭头流向', 'conveyor-arrow-chevron', 5],
  ['分段式箭头', 'conveyor-arrow-segmented', 6], ['宽幅带式箭头', 'conveyor-arrow-ribbon', 7],
  ['双列前进箭头', 'conveyor-arrow-double', 8], ['高速流动箭头', 'conveyor-arrow-speed', 9],
  ['输送方向箭头', 'conveyor-direction', 0], ['移动双箭头', 'moving-double-arrow', 1],
  ['管线流动箭头', 'pipeline-flow-arrows', 2], ['流动箭头', 'flow-arrows', 3],
];
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
let browser, page;
const errors = [], result = { styles: {} };
try {
  await server.listen(); await server.watcher.close();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript(content => { window.conveyorArrowScene = content; }, JSON.stringify(fixture));
  const html = await server.transformIndexHtml('/__conveyor_effect_surfaces__', '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/conveyorSurfaceArrows.harness.tsx"></script></body></html>');
  await page.route('**/__conveyor_effect_surfaces__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__conveyor_effect_surfaces__', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.conveyorArrowHarness?.ready(), null, { timeout: 180000 });
  await page.evaluate(() => { const state = window.conveyorArrowHarness.store.getState(); state.selectEntity(state.scene.entityIds[0]); });
  const panel = page.getByTestId('conveyor-surface-arrows');
  await panel.getByText('箭头外观与动画', { exact: true }).click();
  await panel.getByLabel('启用呼吸效果', { exact: true }).uncheck();
  await panel.getByLabel(/^流动速度/).fill('0');
  await panel.getByRole('button', { name: '正向', exact: true }).click();
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().some(value => value.enabled && value.ready));
  await page.evaluate(() => {
    const camera = window.conveyorArrowHarness.scene().activeCamera;
    camera.setTarget(camera.target.scale(0)); camera.alpha = -Math.PI / 2; camera.beta = .08; camera.radius = 11;
    camera.mode = 1; camera.orthoLeft = -4; camera.orthoRight = 4; camera.orthoTop = 2.6; camera.orthoBottom = -2.6;
  });
  async function capture(name) {
    const before = await page.evaluate(() => window.conveyorArrowHarness.scene().getFrameId());
    await page.waitForFunction(frame => window.conveyorArrowHarness.scene().getFrameId() > frame + 4, before);
    const png = await page.locator('canvas.scene-canvas').screenshot(name ? { path: path.join(output, name + '.png') } : {});
    return page.evaluate(async data => {
      const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let cyan = 0, brightness = 0, hash = 2166136261;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 1] > 50 && pixels[offset + 1] > pixels[offset] * 1.4 && pixels[offset + 2] > pixels[offset] * 1.6) {
          cyan++; brightness += pixels[offset + 1] + pixels[offset + 2];
        }
        for (let channel = 0; channel < 3; channel++) { hash ^= pixels[offset + channel]; hash = Math.imul(hash, 16777619); }
      }
      return { cyan, brightness, hash: hash >>> 0 };
    }, png.toString('base64'));
  }
  await panel.getByRole('button', { name: '停止', exact: true }).click();
  result.stopped = await capture('stopped');
  await panel.getByRole('button', { name: '正向', exact: true }).click();
  const baseline = await page.evaluate(() => ({ visual: window.conveyorArrowHarness.visual()[0], entities: window.conveyorArrowHarness.store.getState().scene.entityIds.length }));
  await page.getByRole('button', { name: '特效库', exact: true }).click();
  const card = page.locator('button.resource-card').filter({ has: page.getByText('单一直线箭头', { exact: true }) });
  await card.dragTo(page.getByTestId('conveyor-surface-arrow-style-drop'));
  await page.waitForFunction(() => window.conveyorArrowHarness.current().components.telemetryBinding.surfaceArrows.style === 'conveyor-arrow-single');
  assert.equal(await page.evaluate(() => window.conveyorArrowHarness.store.getState().scene.entityIds.length), baseline.entities, '拖入表面框不得新增独立实体');
  for (const [name, kind, code] of styles) {
    await panel.getByLabel('箭头样式', { exact: true }).selectOption(kind);
    await page.waitForFunction(value => window.conveyorArrowHarness.visual()[0]?.uniforms.arrowStyle === value, code);
    const visual = await page.evaluate(() => window.conveyorArrowHarness.visual()[0]);
    assert.equal(visual.id, baseline.visual.id); assert.equal(visual.materialId, baseline.visual.materialId);
    result.styles[kind] = await capture(kind);
    assert.ok(result.styles[kind].cyan > result.stopped.cyan + 100, `${name} 必须实际绘制在输送面：${JSON.stringify(result.styles[kind])}`);
  }
  assert.equal(new Set(styles.slice(0, 6).map(([, kind]) => result.styles[kind].hash)).size, 6, '输送面六款必须呈现不同形态');
  await panel.getByLabel('箭头样式', { exact: true }).selectOption('conveyor-arrow-single');
  await panel.getByRole('button', { name: '反向', exact: true }).click();
  await page.waitForFunction(() => window.conveyorArrowHarness.visual()[0]?.uniforms.direction === -1);
  result.reverse = await capture('reverse');
  assert.notEqual(result.reverse.hash, result.styles['conveyor-arrow-single'].hash);
  await panel.getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().every(value => !value.enabled));
  result.stoppedNew = await capture('stopped-new');
  assert.ok(result.stoppedNew.cyan < result.styles['conveyor-arrow-single'].cyan - 100);
  await panel.getByRole('button', { name: '正向', exact: true }).click();
  await panel.getByLabel(/^流动速度/).fill('1.3');
  result.motion1 = await capture(); await page.waitForTimeout(250); result.motion2 = await capture();
  assert.notEqual(result.motion1.hash, result.motion2.hash, '输送面新增样式须持续运动');
  await page.screenshot({ path: path.join(output, 'editor.png') });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, ...result, errors }, null, 2));
  await page.evaluate(() => window.conveyorArrowHarness.dispose());
  console.log('PASS: 新卡片真实拖入输送面、六新款及四旧款 UI 切换、Mesh/材质复用、可见像素、正反停与动画。');
} catch (error) { if (page) await page.screenshot({ path: path.join(output, 'failure.png') }); throw error; }
finally { await browser?.close(); await server.close(); }
