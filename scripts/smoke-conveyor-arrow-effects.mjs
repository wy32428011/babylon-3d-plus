import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import mqttPacket from 'mqtt-packet';

const output = path.resolve('output/conveyor-arrow-effects');
await mkdir(output, { recursive: true });
const variants = [
  ['单一直线箭头', 'conveyor-arrow-single'], ['连续箭头流向', 'conveyor-arrow-chevron'],
  ['分段式箭头', 'conveyor-arrow-segmented'], ['宽幅带式箭头', 'conveyor-arrow-ribbon'],
  ['双列前进箭头', 'conveyor-arrow-double'], ['高速流动箭头', 'conveyor-arrow-speed'],
];
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
// 仅满足运行预览的 MQTT 连接预检；此夹具不代表真实设备数据验收。
const broker = new WebSocketServer({ noServer: true });
server.httpServer.on('upgrade', (request, socket, head) => {
  if (request.url === '/__conveyor_effect_mqtt__') broker.handleUpgrade(request, socket, head, ws => broker.emit('connection', ws));
});
broker.on('connection', socket => {
  const parser = mqttPacket.parser(); let protocolVersion = 4;
  const send = packet => { if (socket.readyState === 1) socket.send(mqttPacket.generate(packet, { protocolVersion })); };
  socket.on('message', data => parser.parse(data)); parser.on('error', () => socket.close());
  parser.on('packet', packet => {
    if (packet.cmd === 'connect') { protocolVersion = packet.protocolVersion; send({ cmd: 'connack', returnCode: 0, reasonCode: 0, sessionPresent: false }); }
    if (packet.cmd === 'subscribe') send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(item => item.qos) });
    if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
    if (packet.cmd === 'disconnect') socket.close();
  });
});
let browser, page;
const errors = [], results = { variants: {} };
try {
  await server.listen(); await server.watcher.close();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  page = await browser.newPage({ viewport: { width: 1510, height: 1050 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  const html = await server.transformIndexHtml('/__conveyor_effects__', '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/conveyorArrowEffects.harness.tsx"></script></body></html>');
  await page.route('**/__conveyor_effects__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__conveyor_effects__', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.conveyorEffectsHarness?.ready(), null, { timeout: 180000 });
  await page.getByRole('button', { name: '特效库', exact: true }).click();
  const canvas = page.locator('canvas.scene-canvas');
  for (const [index, [name, kind]] of variants.entries()) {
    const card = page.locator('button.resource-card').filter({ has: page.getByText(name, { exact: true }) });
    await card.dragTo(canvas, { targetPosition: { x: 150, y: 140 } });
    await page.waitForFunction(expected => window.conveyorEffectsHarness.current()?.components.poiEffect?.effectKind === expected, kind);
    await page.evaluate(value => window.conveyorEffectsHarness.place(value), index);
    await page.getByLabel('长度（米）', { exact: true }).fill('8');
    await page.getByLabel('宽度（米）', { exact: true }).fill('2');
    await page.getByTestId('conveyor-arrow-effect-inspector').getByLabel(/^不透明度/).fill('0.85');
    if (['conveyor-arrow-chevron', 'conveyor-arrow-segmented', 'conveyor-arrow-double'].includes(kind)) {
      await page.getByLabel('箭头/分段数量', { exact: true }).fill('5');
    }
    await page.getByLabel('速度', { exact: true }).fill('0');
    const entity = await page.evaluate(() => window.conveyorEffectsHarness.current());
    assert.equal(entity.components.poiEffect.conveyorArrow.length, 8);
    assert.equal(entity.components.poiEffect.conveyorArrow.width, 2);
    assert.equal(entity.components.poiEffect.conveyorArrow.opacity, .85);
    if (['conveyor-arrow-chevron', 'conveyor-arrow-segmented', 'conveyor-arrow-double'].includes(kind)) assert.equal(entity.components.poiEffect.conveyorArrow.count, 5);
    assert.equal(entity.components.poiEffect.speed, 0);
  }
  assert.equal(await page.evaluate(() => window.conveyorEffectsHarness.entities().length), 6);
  await page.waitForFunction(() => window.conveyorEffectsHarness.meshes().length === 6 && window.conveyorEffectsHarness.meshes().every(mesh => mesh.isReady(true)), null, { timeout: 120000 });
  const renderedStyles = await page.evaluate(() => {
    const h = window.conveyorEffectsHarness;
    return h.entities().map(entity => h.meshes().find(mesh => mesh.metadata?.editorEntityId === entity.id).material._floats.arrowStyle);
  });
  assert.deepEqual(renderedStyles, [0, 1, 2, 3, 4, 5], '六个实体必须分别编译实际对应的样式分支');
  const select = async index => page.evaluate(value => { const h = window.conveyorEffectsHarness; h.store.getState().selectEntity(value === null ? null : h.entities()[value].id); }, index);
  const frame = async (index, filename) => {
    const currentFrame = await page.evaluate(() => window.conveyorEffectsHarness.scene().getFrameId());
    await page.waitForFunction(value => window.conveyorEffectsHarness.scene().getFrameId() > value + 4, currentFrame);
    const png = await canvas.screenshot(filename ? { path: path.join(output, filename + '.png') } : {});
    return page.evaluate(async ({ data, index }) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
      const screenshot = document.createElement('canvas'); screenshot.width = img.width; screenshot.height = img.height;
      const context = screenshot.getContext('2d'); context.drawImage(img, 0, 0);
      const region = window.conveyorEffectsHarness.region(index);
      const pixels = context.getImageData(Math.round(region.x), Math.round(region.y), Math.round(region.width), Math.round(region.height)).data;
      let cyan = 0, brightness = 0, hash = 2166136261;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const visible = pixels[offset + 1] > 70 && pixels[offset + 1] > pixels[offset] * 1.25 && pixels[offset + 2] > pixels[offset] * 1.35;
        if (visible) { cyan++; brightness += pixels[offset + 1] + pixels[offset + 2]; }
        for (let channel = 0; channel < 3; channel++) { hash ^= pixels[offset + channel]; hash = Math.imul(hash, 16777619); }
      }
      return { cyan, brightness, hash: hash >>> 0 };
    }, { data: png.toString('base64'), index });
  };
  await select(null); await page.evaluate(() => window.conveyorEffectsHarness.camera());
  // 等待重建材质、选择高亮与相机过渡结束后，才比较真正静止的像素。
  let previous = await frame(0), stable = 0;
  const stableDeadline = Date.now() + 15000;
  while (stable < 3 && Date.now() < stableDeadline) {
    await page.waitForTimeout(150); const next = await frame(0);
    stable = next.cyan > 100 && next.hash === previous.hash ? stable + 1 : 0; previous = next;
  }
  assert.equal(stable, 3, '零速度箭头必须达到稳定画面');
  for (const [index, [, kind]] of variants.entries()) {
    results.variants[kind] = await frame(index);
    assert.ok(results.variants[kind].cyan > 100, `${kind} 必须有可见青色像素：${JSON.stringify(results.variants[kind])}`);
  }
  assert.equal(new Set(Object.values(results.variants).map(value => value.hash)).size, 6, '六款箭头必须呈现不同画面');
  await page.waitForTimeout(300);
  for (const [index, [, kind]] of variants.entries()) {
    assert.deepEqual(await frame(index, index === 0 ? 'six-variants' : undefined), results.variants[kind], `${kind} 速度 0 必须保持静止像素`);
  }
  const periodFrames = [];
  for (const phase of [0, 1]) {
    await page.evaluate(value => {
      const h = window.conveyorEffectsHarness, id = h.entities()[3].id;
      h.meshes().find(mesh => mesh.metadata?.editorEntityId === id).material.setFloat('flowPhase', value);
    }, phase);
    await frame(3);
    periodFrames.push((await canvas.screenshot()).toString('base64'));
  }
  results.ribbonPeriod = await page.evaluate(async frames => {
    const region = window.conveyorEffectsHarness.region(3), arrays = [];
    for (const data of frames) {
      const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      arrays.push(context.getImageData(Math.round(region.x), Math.round(region.y), Math.round(region.width), Math.round(region.height)).data);
    }
    let sum = 0, changed = 0;
    for (let offset = 0; offset < arrays[0].length; offset += 4) for (let channel = 0; channel < 3; channel++) {
      const difference = Math.abs(arrays[0][offset + channel] - arrays[1][offset + channel]);
      sum += difference; if (difference > 2) changed++;
    }
    const channels = arrays[0].length * .75;
    return { meanDifference: sum / channels, changedRatio: changed / channels };
  }, periodFrames);
  assert.ok(results.ribbonPeriod.meanDifference < .25 && results.ribbonPeriod.changedRatio < .01,
    '蜂窝纹理相位 1 回到 0 必须保持连续像素：' + JSON.stringify(results.ribbonPeriod));

  await select(0);
  const before = await page.evaluate(() => window.conveyorEffectsHarness.current().components.poiEffect);
  await page.getByLabel('反向', { exact: true }).check();
  const after = await page.evaluate(() => window.conveyorEffectsHarness.current().components.poiEffect);
  assert.equal(after.conveyorArrow.reverse, true);
  await page.evaluate(() => window.conveyorEffectsHarness.store.getState().undo());
  assert.deepEqual(await page.evaluate(() => window.conveyorEffectsHarness.current().components.poiEffect), before);
  await page.evaluate(() => window.conveyorEffectsHarness.store.getState().redo());
  assert.deepEqual(await page.evaluate(() => window.conveyorEffectsHarness.current().components.poiEffect), after);
  await select(null); results.reverse = await frame(0, 'reverse');
  assert.notEqual(results.reverse.hash, results.variants[variants[0][1]].hash, '反向必须改变实际可见箭头方向');
  await select(0);
  await page.evaluate(() => { const state = window.conveyorEffectsHarness.store.getState(); state.copySelectedEntities(); state.pasteEntityClipboard(); });
  assert.equal(await page.evaluate(() => window.conveyorEffectsHarness.entities().length), 7);
  assert.deepEqual(await page.evaluate(() => window.conveyorEffectsHarness.current().components.poiEffect), after, '复制保留全部箭头参数');
  await page.evaluate(() => window.conveyorEffectsHarness.store.getState().undo());
  assert.equal(await page.evaluate(() => window.conveyorEffectsHarness.entities().length), 6);
  await select(0);
  await page.getByLabel('速度', { exact: true }).fill('2');
  await select(null); results.motion1 = await frame(0); await page.waitForTimeout(250); results.motion2 = await frame(0);
  assert.notEqual(results.motion1.hash, results.motion2.hash, '非零速度必须驱动实际可见像素');
  await select(0); await page.getByTestId('conveyor-arrow-effect-inspector').getByLabel(/^不透明度/).fill('0');
  await select(null); results.transparent = await frame(0, 'transparent');
  assert.ok(results.transparent.cyan < results.variants[variants[0][1]].cyan * .1, '零不透明度必须隐藏箭头像素');
  await select(0); await page.getByTestId('conveyor-arrow-effect-inspector').getByLabel(/^不透明度/).fill('0.85');
  await page.getByLabel('启用特效', { exact: true }).uncheck();
  await page.waitForFunction(() => window.conveyorEffectsHarness.meshes().length === 5);
  await select(null); results.disabled = await frame(0, 'disabled');
  assert.ok(results.disabled.cyan < results.variants[variants[0][1]].cyan * .1, '禁用必须隐藏箭头像素');
  await select(0); await page.getByLabel('启用特效', { exact: true }).check();
  // 发布夹具包含六款有动画的独立实体，SOURCE 次场景额外覆盖零值。
  for (let index = 0; index < variants.length; index++) { await select(index); await page.getByLabel('速度', { exact: true }).fill('1.3'); }
  const saved = await page.evaluate(() => window.conveyorEffectsHarness.save());
  await writeFile(path.join(output, 'scene.scene.json'), saved);
  const configured = await page.evaluate(() => window.conveyorEffectsHarness.entities().map(entity => entity.components.poiEffect));
  await page.evaluate(content => window.conveyorEffectsHarness.reopen(content), saved);
  await page.waitForFunction(() => window.conveyorEffectsHarness.ready() && window.conveyorEffectsHarness.meshes().length === 6 && window.conveyorEffectsHarness.meshes().every(mesh => mesh.isReady(true)));
  assert.deepEqual(await page.evaluate(() => window.conveyorEffectsHarness.entities().map(entity => entity.components.poiEffect)), configured, '保存重开保留六款全部参数');
  await select(0); assert.equal(await page.getByLabel('反向', { exact: true }).isChecked(), true);
  const started = await page.evaluate(() => {
    const state = window.conveyorEffectsHarness.store.getState();
    state.updateMqttConfig({ ...state.scene.mqttConfig, enabled: true, address: 'ws://' + location.host + '/__conveyor_effect_mqtt__', ip: '', simulatorEnabled: false });
    return state.startRuntimePreview();
  });
  assert.notEqual(started, false, JSON.stringify(started));
  if (started && typeof started === 'object') assert.notEqual(started.ok, false, JSON.stringify(started));
  await page.waitForFunction(() => window.conveyorEffectsHarness.store.getState().runtimeMode === 'preview' && window.conveyorEffectsHarness.meshes().length === 6);
  await page.evaluate(() => window.conveyorEffectsHarness.camera());
  await page.screenshot({ path: path.join(output, 'preview.png') });
  await page.evaluate(() => window.conveyorEffectsHarness.store.getState().stopRuntimePreview());
  await page.waitForFunction(() => window.conveyorEffectsHarness.store.getState().runtimeMode === 'edit');
  await select(0); await page.evaluate(() => window.conveyorEffectsHarness.camera());
  await page.screenshot({ path: path.join(output, 'editor.png') });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, ...results, errors, mqtt: 'local-handshake-fixture' }, null, 2));
  await page.evaluate(() => window.conveyorEffectsHarness.dispose());
  console.log('PASS: 六款真实库拖入、Inspector、撤销重做、复制、保存重开、WebGL 区分、零速/运动/反向/透明/禁用与运行预览。');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') });
  throw error;
} finally {
  await browser?.close();
  for (const socket of broker.clients) socket.terminate();
  await new Promise(resolve => broker.close(resolve));
  await server.close();
}
