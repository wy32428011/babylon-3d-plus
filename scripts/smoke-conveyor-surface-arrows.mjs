import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import mqttPacket from 'mqtt-packet';

const output = path.resolve('output/conveyor-surface-arrows');
await mkdir(output, { recursive: true });
const fixture = JSON.parse(await readFile('examples/scenes/virtual-conveyor-mqtt-demo.scene.json', 'utf8'));
const [id] = fixture.scene.entityIds;
const entity = fixture.scene.entities[id];
fixture.scene.entityIds = [id]; fixture.scene.entities = { [id]: entity }; fixture.scene.selectedEntityId = id;
entity.name = '表面箭头验收输送线'; entity.components.transform.position = { x: 0, y: 0, z: 0 };
const asset = entity.components.modelAsset;
const packageRoot = path.resolve('public/builtin-model-packages/virtual-conveyor');
const toUrl = file => 'editor-asset://local/' + encodeURIComponent(file);
asset.sourcePath = path.join(packageRoot, 'virtual-conveyor.glb'); asset.sourceUrl = toUrl(asset.sourcePath);
for (const script of asset.scriptAssets ?? []) { script.path = path.join(packageRoot, path.basename(script.path.replaceAll('\\', '/'))); script.sourceUrl = toUrl(script.path); }
asset.parameterValues = { ...asset.parameterValues, length: 6, width: 1.5, color: '#666666' };
entity.components.telemetryBinding.cargoOriginDevice = false;
delete entity.components.telemetryBinding.surfaceArrows;

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
const broker = new WebSocketServer({ noServer: true });
const clients = new Map();
server.httpServer.on('upgrade', (request, socket, head) => {
  if (request.url === '/__arrow_mqtt__') broker.handleUpgrade(request, socket, head, ws => broker.emit('connection', ws));
});
broker.on('connection', socket => {
  const parser = mqttPacket.parser(); let protocolVersion = 4;
  const send = packet => { if (socket.readyState === 1) socket.send(mqttPacket.generate(packet, { protocolVersion })); };
  socket.on('message', data => parser.parse(data)); socket.on('close', () => clients.delete(socket));
  parser.on('error', () => socket.close());
  parser.on('packet', packet => {
    if (packet.cmd === 'connect') { protocolVersion = packet.protocolVersion; send({ cmd: 'connack', returnCode: 0, reasonCode: 0, sessionPresent: false }); }
    if (packet.cmd === 'subscribe') { clients.set(socket, send); send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(s => s.qos) }); }
    if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
    if (packet.cmd === 'disconnect') socket.close();
  });
});
let movement = 1, customDirection = 'F', fault = false, publishEnabled = true, sequence = 0;
const ticker = setInterval(() => {
  if (!publishEnabled) return;
  const payload = JSON.stringify({ seq: ++sequence, data: [
    { e: asset.assetCode, p: 'movement_x', v: movement },
    { e: asset.assetCode, p: 'line.direction', v: customDirection },
    { e: asset.assetCode, p: 'normal', v: !fault },
  ] });
  for (const send of clients.values()) send({ cmd: 'publish', topic: `dt/factory/logistics/conveyor/${asset.assetCode}/twindatadriven/joint`, payload, qos: 0, retain: false, dup: false });
}, 150);

let browser, page; const errors = []; const results = {};
try {
  await server.listen(); await server.watcher.close();
  fixture.scene.mqttConfig = { ...fixture.scene.mqttConfig, enabled: true, simulatorEnabled: false, ip: '', address: `ws://127.0.0.1:${server.httpServer.address().port}/__arrow_mqtt__` };
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  page = await browser.newPage({ viewport: { width: 1420, height: 940 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); } });
  await page.addInitScript(content => { window.conveyorArrowScene = content; }, JSON.stringify(fixture));
  const html = await server.transformIndexHtml('/__arrows__', '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/conveyorSurfaceArrows.harness.tsx"></script></body></html>');
  await page.route('**/__arrows__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__arrows__', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.conveyorArrowHarness, null, { timeout: 90000 });
  await page.waitForFunction(() => window.conveyorArrowHarness?.ready(), null, { timeout: 90000 });
  console.log('编辑器与模型夹具已加载');
  await page.evaluate(() => { const s = window.conveyorArrowHarness.store.getState(); s.selectEntity(s.scene.entityIds[0]); });
  const panel = page.getByTestId('conveyor-surface-arrows');
  const measuredBefore = await page.evaluate(() => window.conveyorArrowHarness.store.getState().selectedModelMeasurement?.sizeMeters);
  assert.equal(await panel.getByLabel('启用表面箭头', { exact: true }).isChecked(), true, '旧场景缺字段也默认启用，无需逐设备勾选');
  results.defaultEnabled = true;
  await panel.getByText('箭头外观与动画', { exact: true }).click();
  await panel.getByLabel('启用呼吸效果', { exact: true }).uncheck();
  await panel.getByRole('button', { name: '正向', exact: true }).click();
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().some(v => v.enabled && v.ready));
  await page.evaluate(() => window.conveyorArrowHarness.camera());

  async function capture(name) {
    const frame = await page.evaluate(() => window.conveyorArrowHarness.scene().getFrameId());
    await page.waitForFunction(value => window.conveyorArrowHarness.scene().getFrameId() > value + 4, frame);
    const png = await page.locator('canvas').first().screenshot({ path: path.join(output, name + '.png') });
    return page.evaluate(async data => {
      const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let cyan = 0, brightness = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > 50 && pixels[i + 1] > pixels[i] * 1.4 && pixels[i + 2] > pixels[i] * 1.6) { cyan++; brightness += pixels[i + 1] + pixels[i + 2]; }
      return { cyan, brightness };
    }, png.toString('base64'));
  }
  results.forward = await capture('editor-forward');
  assert.deepEqual(await page.evaluate(() => window.conveyorArrowHarness.store.getState().selectedModelMeasurement?.sizeMeters), measuredBefore, '装饰箭头不改变设备实测尺寸');
  const firstPhase = await page.evaluate(() => window.conveyorArrowHarness.visual()[0].uniforms.phase);
  await page.waitForTimeout(250);
  assert.notEqual(await page.evaluate(() => window.conveyorArrowHarness.visual()[0].uniforms.phase), firstPhase);
  await panel.getByRole('button', { name: '反向', exact: true }).click();
  await page.waitForFunction(() => window.conveyorArrowHarness.visual()[0]?.uniforms.direction === -1);
  results.reverse = await capture('editor-reverse');
  await panel.getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().every(v => !v.enabled));
  results.stopped = await capture('editor-stopped');
  assert.ok(results.forward.cyan > results.stopped.cyan + 200, JSON.stringify(results));
  assert.ok(results.reverse.cyan > results.stopped.cyan + 200, JSON.stringify(results));

  await panel.getByLabel('流动速度(m/s)', { exact: true }).fill('0');
  await panel.getByRole('button', { name: '正向', exact: true }).click();
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().some(v => v.enabled));
  const stillPhase = await page.evaluate(() => window.conveyorArrowHarness.visual()[0].uniforms.phase);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.conveyorArrowHarness.visual()[0].uniforms.phase), stillPhase, '零速度显示静止箭头');
  results.uncovered = await capture('uncovered');
  await page.evaluate(() => window.conveyorArrowHarness.setOccluder(true));
  results.occluded = await capture('occluded');
  assert.ok(results.occluded.cyan < results.uncovered.cyan - 100, '货箱必须真实遮挡箭头像素：' + JSON.stringify(results));
  await page.evaluate(() => window.conveyorArrowHarness.setOccluder(false));
  await page.getByRole('button', { name: '特效库', exact: true }).click();
  const drop = page.getByTestId('conveyor-surface-arrow-style-drop');
  const baselineVisual = await page.evaluate(() => window.conveyorArrowHarness.visual()[0]);
  const baselineEntities = await page.evaluate(() => window.conveyorArrowHarness.store.getState().scene.entityIds.length);
  const styles = [['移动双箭头', 'moving-double-arrow', 1], ['管线流动箭头', 'pipeline-flow-arrows', 2], ['流动箭头', 'flow-arrows', 3], ['输送方向箭头', 'conveyor-direction', 0]];
  results.styles = {};
  for (const [name, kind, code] of styles) {
    const card = page.locator('button.resource-card').filter({ has: page.getByText(name, { exact: true }) });
    await card.dragTo(drop);
    await page.waitForFunction(style => window.conveyorArrowHarness.current().components.telemetryBinding.surfaceArrows.style === style, kind);
    await page.waitForFunction(style => window.conveyorArrowHarness.visual()[0]?.uniforms.arrowStyle === style, code);
    const visual = await page.evaluate(() => window.conveyorArrowHarness.visual()[0]);
    assert.equal(visual.id, baselineVisual.id); assert.equal(visual.materialId, baselineVisual.materialId);
    assert.equal(await page.evaluate(() => window.conveyorArrowHarness.store.getState().scene.entityIds.length), baselineEntities, '拖入样式不添加独立特效实体');
    results.styles[kind] = await capture('style-' + kind);
  }
  assert.equal(new Set(Object.values(results.styles).map(value => value.brightness)).size, 4, '四种内置样式必须绘制不同画面');
  const beforeReject = await page.evaluate(() => JSON.stringify(window.conveyorArrowHarness.current().components.telemetryBinding.surfaceArrows));
  const wall = page.locator('button.resource-card').filter({ has: page.getByText('光墙围栏', { exact: true }) });
  await wall.dragTo(drop);
  assert.equal(await page.evaluate(() => JSON.stringify(window.conveyorArrowHarness.current().components.telemetryBinding.surfaceArrows)), beforeReject, '非箭头特效不得覆盖配置');
  await panel.getByLabel('启用呼吸效果', { exact: true }).check();
  await page.waitForFunction(() => window.conveyorArrowHarness.visual()[0]?.uniforms.breathingFactor > .98);
  results.breathHigh = await capture('breathing-high');
  await page.waitForFunction(() => window.conveyorArrowHarness.visual()[0]?.uniforms.breathingFactor < .32);
  results.breathLow = await capture('breathing-low');
  assert.ok(results.breathHigh.brightness > results.breathLow.brightness * 1.35, '零流速时呼吸仍有明显的真实明暗差异：' + JSON.stringify({ high: results.breathHigh, low: results.breathLow }));
  await panel.getByLabel('流动速度(m/s)', { exact: true }).fill('0.7');
  await page.evaluate(() => window.conveyorArrowHarness.store.getState().updateSelectedModelParameterValue('length', 8));
  await page.waitForFunction(() => window.conveyorArrowHarness.visual()[0]?.uniforms.stripLength > 7.5);
  results.parameterResize = true;
  await page.evaluate(() => window.conveyorArrowHarness.store.getState().updateSelectedModelParameterValue('length', 6));
  await page.waitForFunction(() => window.conveyorArrowHarness.visual()[0]?.uniforms.stripLength < 6);
  const surfaceNode = panel.getByLabel('输送面部件', { exact: true });
  await surfaceNode.fill('missing-test-surface'); await surfaceNode.press('Enter');
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().every(v => !v.enabled));
  assert.match(await panel.getByRole('status').filter({ hasText: '箭头状态' }).textContent(), /未找到/);
  await surfaceNode.fill('VCConveyorBelt'); await surfaceNode.press('Enter');
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().some(v => v.enabled));
  await surfaceNode.fill(''); await surfaceNode.press('Enter');
  results.surfaceSelection = true;

  const saved = await page.evaluate(() => window.conveyorArrowHarness.save());
  await writeFile(path.join(output, 'scene.scene.json'), saved);
  await page.evaluate(content => window.conveyorArrowHarness.reopen(content), saved);
  await page.waitForFunction(() => window.conveyorArrowHarness.ready());
  await page.evaluate(() => { const s = window.conveyorArrowHarness.store.getState(); s.selectEntity(s.scene.entityIds[0]); });
  assert.equal(await panel.getByLabel('启用表面箭头', { exact: true }).isChecked(), true);
  assert.equal(await page.evaluate(() => window.conveyorArrowHarness.session.getPreview(window.conveyorArrowHarness.current().id)), null);
  const started = await page.evaluate(() => window.conveyorArrowHarness.store.getState().startRuntimePreview());
  assert.notEqual(started, false, '运行预览须通过真实 MQTT fixture 预检');
  await page.waitForFunction(() => window.conveyorArrowHarness.store.getState().runtimeMode === 'preview');
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().some(v => v.enabled && v.uniforms.direction === 1));
  results.mqttForward = await capture('mqtt-forward');
  movement = 2;
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().some(v => v.enabled && v.uniforms.direction === -1));
  results.mqttReverse = await capture('mqtt-reverse');
  movement = 0;
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().every(v => !v.enabled));
  movement = 1; fault = true;
  await page.waitForFunction(() => /故障/.test(window.conveyorArrowHarness.session.getDiagnostic(window.conveyorArrowHarness.current().id)));
  assert.equal(await page.evaluate(() => window.conveyorArrowHarness.visual().some(v => v.enabled)), false);
  fault = false;
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().some(v => v.enabled));
  publishEnabled = false;
  await page.waitForFunction(() => /过期/.test(window.conveyorArrowHarness.session.getDiagnostic(window.conveyorArrowHarness.current().id)));
  assert.equal(await page.evaluate(() => window.conveyorArrowHarness.visual().some(v => v.enabled)), false);
  publishEnabled = true;
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().some(v => v.enabled));
  await page.evaluate(() => window.conveyorArrowHarness.store.getState().stopRuntimePreview());
  await page.waitForFunction(() => window.conveyorArrowHarness.store.getState().runtimeMode === 'edit');
  assert.equal(await page.evaluate(() => window.conveyorArrowHarness.visual().some(v => v.enabled)), false);
  await page.evaluate(() => { const s = window.conveyorArrowHarness.store.getState(); s.selectEntity(s.scene.entityIds[0]); });
  await panel.getByText('MQTT 箭头方向', { exact: true }).click();
  await panel.getByLabel('方向来源', { exact: true }).selectOption('point');
  await panel.getByLabel('方向点位(p)', { exact: true }).fill('line.direction');
  await panel.getByLabel('正向值', { exact: true }).fill('F');
  await panel.getByLabel('反向值', { exact: true }).fill('F ');
  assert.equal(await panel.getByRole('button', { name: '应用方向绑定', exact: true }).isDisabled(), true, '归一化后重复的映射值必须被阻止');
  await panel.getByLabel('反向值', { exact: true }).fill('R');
  await panel.getByLabel('停止值', { exact: true }).fill('S');
  await panel.getByRole('button', { name: '应用方向绑定', exact: true }).click();
  const customSaved = await page.evaluate(() => window.conveyorArrowHarness.save());
  await writeFile(path.join(output, 'scene.scene.json'), customSaved);
  await page.evaluate(content => window.conveyorArrowHarness.reopen(content), customSaved);
  await page.waitForFunction(() => window.conveyorArrowHarness.ready());
  movement = 0; customDirection = 'F';
  await page.evaluate(() => window.conveyorArrowHarness.store.getState().startRuntimePreview());
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().some(v => v.enabled && v.uniforms.direction === 1));
  customDirection = 'R';
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().some(v => v.enabled && v.uniforms.direction === -1));
  customDirection = 'S';
  await page.waitForFunction(() => window.conveyorArrowHarness.visual().every(v => !v.enabled));
  customDirection = 'other';
  await page.waitForFunction(() => /未命中/.test(window.conveyorArrowHarness.session.getDiagnostic(window.conveyorArrowHarness.current().id)));
  assert.equal(await page.evaluate(() => window.conveyorArrowHarness.visual().some(v => v.enabled)), false);
  results.customPointMqtt = true;
  await page.evaluate(() => window.conveyorArrowHarness.store.getState().stopRuntimePreview());
  await page.waitForFunction(() => window.conveyorArrowHarness.store.getState().runtimeMode === 'edit');
  const arrayScene = JSON.parse(saved);
  const copy = structuredClone(arrayScene.scene.entities[id]);
  copy.id = 'surface-arrow-array-copy'; copy.name = '禁用绑定的阵列预览';
  copy.components.modelArrayInstance = { sourceEntityId: id };
  copy.components.modelAsset.assetCode = 'VirtualConveyor-PreviewCopy';
  copy.components.telemetryBinding.enabled = false;
  copy.components.transform.position.z = 2;
  arrayScene.scene.entities[copy.id] = copy; arrayScene.scene.entityIds.push(copy.id);
  await page.evaluate(content => window.conveyorArrowHarness.reopen(content), JSON.stringify(arrayScene));
  await page.waitForFunction(() => window.conveyorArrowHarness.ready());
  await page.evaluate(copyId => window.conveyorArrowHarness.store.getState().selectEntity(copyId), copy.id);
  await panel.getByRole('button', { name: '正向', exact: true }).click();
  await page.waitForFunction(copyId => window.conveyorArrowHarness.visual().some(v => v.name.endsWith(copyId) && v.enabled), copy.id);
  results.arrayDisabledBindingPreview = true;
  await page.evaluate(() => window.conveyorArrowHarness.store.getState().deleteSelectedEntity());
  await page.waitForFunction(copyId => window.conveyorArrowHarness.visual().every(v => !v.name.endsWith(copyId)), copy.id);
  results.arrayDeleteCleanup = true;
  await page.screenshot({ path: path.join(output, 'editor.png') });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'editor-result.json'), JSON.stringify({ ok: true, results, errors, mqtt: 'local-websocket-fixture' }, null, 2));
  await page.evaluate(() => window.conveyorArrowHarness.dispose());
  console.log('PASS: 默认开启 / 库卡片真实拖拽四样式与拒绝非箭头 / 呼吸WebGL明暗 / 保存重开 / 默认及自定义MQTT / 遮挡与阵列清理');
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }); console.error(await page.evaluate(() => ({ visual: window.conveyorArrowHarness?.visual(), state: window.conveyorArrowHarness?.store.getState().runtimeMode, diagnostics: window.conveyorArrowHarness?.session.getDiagnostic(window.conveyorArrowHarness?.current()?.id) }))); }
  throw error;
} finally {
  clearInterval(ticker); for (const socket of broker.clients) socket.close();
  await browser?.close(); await new Promise(resolve => broker.close(resolve)); await server.close();
}
