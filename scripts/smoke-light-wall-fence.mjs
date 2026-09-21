import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import mqttPacket from 'mqtt-packet';

const output = path.resolve('output/playwright/light-wall-fence');
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
// 运行预览沿用项目现有 MQTT 预检，只提供本地握手/订阅响应，不发送设备数据。
const broker = new WebSocketServer({ noServer: true });
server.httpServer.on('upgrade', (request, socket, head) => {
  if (request.url === '/__light_wall_mqtt__') broker.handleUpgrade(request, socket, head, ws => broker.emit('connection', ws, request));
});
broker.on('connection', socket => {
  const parser = mqttPacket.parser();
  let protocolVersion = 4;
  const send = packet => socket.send(mqttPacket.generate(packet, { protocolVersion }));
  socket.on('message', data => parser.parse(data));
  parser.on('error', () => socket.close());
  parser.on('packet', packet => {
    if (packet.cmd === 'connect') { protocolVersion = packet.protocolVersion; send({ cmd: 'connack', returnCode: 0, reasonCode: 0, sessionPresent: false }); }
    if (packet.cmd === 'subscribe') send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(subscription => subscription.qos) });
    if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
    if (packet.cmd === 'disconnect') socket.close();
  });
});
let browser, page;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  const html = await server.transformIndexHtml('/__light_wall__', '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/lightWallFence.harness.tsx"></script></body></html>');
  await page.route('**/__light_wall__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__light_wall__', { waitUntil: 'commit' });
  await page.getByRole('button', { name: '特效库', exact: true }).waitFor({ timeout: 180000 });
  await page.getByRole('button', { name: '特效库', exact: true }).click();
  await page.getByRole('button', { name: /光墙围栏/ }).click();
  await page.waitForFunction(() => window.lightWallHarness.wall()?.isReady(true), null, { timeout: 120000 });
  await page.evaluate(() => window.lightWallHarness.camera());
  await page.getByLabel('围栏高度 (m)').fill('4');
  await page.getByLabel('流动速度', { exact: true }).fill('0');
  const outline = page.getByLabel('轮廓顶点 (X, Z)', { exact: true });
  await outline.fill('-6,-5\n6,-5\n6,1\n3,1\n3,5\n-6,5');
  await page.getByLabel('透明度 (%)').fill('20');
  assert.match(await outline.inputValue(), /3,1/);
  await page.getByRole('button', { name: '应用轮廓', exact: true }).click();
  assert.equal((await page.evaluate(() => window.lightWallHarness.current())).lightWall.points.length, 6);
  await outline.fill('0,0\n3,3\n0,3\n3,0');
  await page.getByRole('button', { name: '应用轮廓', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '轮廓' }).waitFor();
  assert.equal((await page.evaluate(() => window.lightWallHarness.current())).lightWall.points.length, 6);
  await page.getByRole('button', { name: '生成矩形轮廓', exact: true }).click();
  await page.getByLabel('围栏颜色').fill('#ff8a22');
  await page.evaluate(() => window.lightWallHarness.camera());
  await page.screenshot({ path: path.join(output, 'editor.png') });
  const saved = await page.evaluate(() => window.lightWallHarness.save());
  await page.evaluate(content => window.lightWallHarness.reopen(content), saved);
  await page.evaluate(() => { const h = window.lightWallHarness; const state = h.store.getState(); const id = state.scene.entityIds.find(id => state.scene.entities[id].components.poiEffect); state.selectEntity(id); h.camera(true); });
  await page.getByLabel('围栏高度 (m)').waitFor();
  assert.equal(await page.getByLabel('围栏高度 (m)').inputValue(), '4');
  assert.equal(await page.getByLabel('透明度 (%)').inputValue(), '20');
  assert.equal(await page.getByLabel('流动速度', { exact: true }).inputValue(), '0');
  // 对同一投影下的实际 canvas 像素采样，底部应明显亮于上部。
  const sample = async () => {
    const png = await page.screenshot();
    return page.evaluate(async data => {
      const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return [0.1, 1.5, 3.8].map(y => { const p = window.lightWallHarness.project(4, y, -4); return [...ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data]; });
    }, png.toString('base64'));
  };
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let still = await sample();
  const readyDeadline = Date.now() + 15000;
  let stableFrames = 0;
  // 重开会异步同步材质并恢复相机；必须等实际像素稳定后再测零速。
  while (stableFrames < 3 && Date.now() < readyDeadline) {
    await page.waitForTimeout(170);
    const next = await sample();
    stableFrames = next[0][0] >= 150 && JSON.stringify(next) === JSON.stringify(still) ? stableFrames + 1 : 0;
    still = next;
  }
  assert.equal(stableFrames, 3, '重开后的零速光墙和相机必须达到稳定画面');
  await page.waitForTimeout(350);
  assert.deepEqual(await sample(), still, '速度为 0 时像素静止');
  assert.ok(still[0][0] > still[2][0] + 35, '底部比顶部更明亮：' + JSON.stringify(still));
  const meshId = await page.evaluate(() => window.lightWallHarness.wall().uniqueId);
  await page.getByLabel('流动速度', { exact: true }).fill('2');
  const motion1 = await sample(); await page.waitForTimeout(200); const motion2 = await sample();
  assert.notDeepEqual(motion1, motion2, '流动速度变化必须改变可见像素');
  await page.getByLabel('透明度 (%)').fill('100');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const transparent = await sample();
  assert.ok(transparent[0][0] < still[0][0] - 35, '完全透明后底部光墙消失');
  assert.equal(await page.evaluate(() => window.lightWallHarness.wall().uniqueId), meshId, '外观调整保留 Mesh');
  await page.getByLabel('透明度 (%)').fill('20');
  await page.getByLabel('流动速度', { exact: true }).fill('1');
  await page.evaluate(() => window.lightWallHarness.camera());
  await page.getByLabel('启用特效').uncheck();
  await page.waitForFunction(() => !window.lightWallHarness.wall());
  assert.equal(await page.evaluate(() => window.lightWallHarness.scene().meshes.some(mesh => mesh.name.endsWith('_poiEffectPickShell') && mesh.isVisible)), false, '禁用时实际SceneRuntime不能残留中心壳');
  await page.getByLabel('启用特效').check();
  await page.waitForFunction(() => window.lightWallHarness.wall()?.isReady(true));
  const preview = await page.evaluate(() => {
    const store = window.lightWallHarness.store;
    store.getState().updateMqttConfig({ ...store.getState().scene.mqttConfig, enabled: true, address: 'ws://' + location.host + '/__light_wall_mqtt__', ip: '', simulatorEnabled: false });
    return store.getState().startRuntimePreview();
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  await page.waitForFunction(() => window.lightWallHarness.store.getState().runtimeMode === 'preview' && window.lightWallHarness.wall()?.isReady(true));
  await page.screenshot({ path: path.join(output, 'preview.png') });
  await page.evaluate(() => window.lightWallHarness.store.getState().stopRuntimePreview());
  await page.waitForFunction(() => window.lightWallHarness.store.getState().runtimeMode === 'edit');
  await page.evaluate(() => {
    const state = window.lightWallHarness.store.getState();
    state.selectEntity(state.scene.entityIds.find(id => state.scene.entities[id].components.poiEffect));
  });
  await page.getByLabel('围栏颜色').fill('#22dfff');
  await page.evaluate(() => window.lightWallHarness.camera());
  await page.waitForTimeout(300);
  const clipped = await page.locator('.light-wall-inspector label > span').evaluateAll(spans => spans.filter(span => span.scrollWidth > span.clientWidth).map(span => span.textContent));
  assert.deepEqual(clipped, [], '围栏参数标签应完整显示');
  await page.screenshot({ path: path.join(output, 'final.png') });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, still, motion1, motion2, transparent, errors }, null, 2));
  await page.evaluate(() => window.lightWallHarness.dispose());
  console.log('PASS: 特效库添加、属性即时调整、草稿保留、凹轮廓与非法输入、保存重开、底亮顶淡、零速静止、动画可见像素、全透明及材质原位更新。');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') });
  throw error;
} finally {
  await browser?.close();
  for (const socket of broker.clients) socket.terminate();
  await new Promise(resolve => broker.close(resolve));
  await server.close();
}
