import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import mqttPacket from 'mqtt-packet';

const modelIndex = process.argv.indexOf('--model');
const requestedModel = modelIndex >= 0 ? process.argv[modelIndex + 1] : process.env.SCENE_THEME_MODEL;
if (modelIndex >= 0 && !requestedModel) throw new Error('--model 需要可读的模型文件路径');
const model = path.resolve(requestedModel ?? 'output/playwright/scene-theme/factory.glb');
await access(model);
const output = path.resolve(requestedModel ? 'output/playwright/scene-theme/real-factory' : 'output/playwright/scene-theme/presets');
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: 'node_modules/.vite-scene-theme-presets', optimizeDeps: { entries: ['tests/fixtures/sceneTheme.harness.tsx'], holdUntilCrawlEnd: false },
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
const broker = new WebSocketServer({ noServer: true });
server.httpServer.on('upgrade', (request, socket, head) => {
  if (request.url === '/__scene_theme_mqtt__') broker.handleUpgrade(request, socket, head, ws => broker.emit('connection', ws, request));
});
broker.on('connection', socket => {
  const parser = mqttPacket.parser(); let protocolVersion = 4;
  const send = packet => socket.send(mqttPacket.generate(packet, { protocolVersion }));
  socket.on('message', data => parser.parse(data)); parser.on('error', () => socket.close());
  parser.on('packet', packet => {
    if (packet.cmd === 'connect') { protocolVersion = packet.protocolVersion; send({ cmd: 'connack', returnCode: 0, reasonCode: 0, sessionPresent: false }); }
    if (packet.cmd === 'subscribe') send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(subscription => subscription.qos) });
    if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
    if (packet.cmd === 'disconnect') socket.close();
  });
});
let browser, page, modelRequests = 0;
const errors = [], results = [];
try {
  await server.listen(); await server.watcher.close();
  // 私有缓存首次扫描结束后再打开浏览器，避免首屏请求跨越依赖优化的哈希切换。
  const optimizer = server.environments.client.depsOptimizer;
  let optimizationTimeout;
  try {
    await Promise.race([
      (async () => {
        await optimizer?.scanProcessing;
        await Promise.all(Object.values(optimizer?.metadata.discovered ?? {}).map(dependency => dependency.processing));
      })(),
      new Promise((_, reject) => { optimizationTimeout = setTimeout(() => reject(new Error('主题验收依赖准备超时')), 90000); }),
    ]);
  } finally { clearTimeout(optimizationTimeout); }
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  page = await browser.newPage({ viewport: { width: 1500, height: 1050 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (request.url().split('?')[0].toLowerCase().endsWith('.glb')) modelRequests++; });
  await page.addInitScript(value => { window.sceneThemeFixturePath = value; window.sceneThemeFixtureFit = true; }, model);
  const html = await server.transformIndexHtml('/__theme_presets__', '<!doctype html><div id="root"></div><script type="module" src="/tests/fixtures/sceneTheme.harness.tsx"></script>');
  await page.route('**/__theme_presets__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__theme_presets__', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.sceneThemeHarness?.ready(), null, { timeout: 180000 });
  await page.evaluate(() => {
    const state = window.sceneThemeHarness.store.getState();
    state.updateMqttConfig({ ...state.scene.mqttConfig, enabled: true, address: 'ws://' + location.host + '/__scene_theme_mqtt__', ip: '', simulatorEnabled: false });
    window.sceneThemeHarness.camera();
  });
  const initialRequests = modelRequests;
  const root = await page.evaluate(() => window.sceneThemeHarness.environmentRoot().uniqueId);
  const presets = await page.evaluate(async () => (await import('/src/editor/model/sceneTheme.ts')).SCENE_THEME_PRESETS);
  await page.getByRole('button', { name: '主题库', exact: true }).click();
  for (const preset of presets) {
    await page.getByRole('button', { name: new RegExp(preset.name) }).click();
    await page.waitForFunction(id => window.sceneThemeHarness.store.getState().scene.sceneSettings.theme?.presetId === id, preset.id);
    const images = [];
    for (const mode of ['editor', 'preview']) {
      if (mode === 'preview') {
        const started = await page.evaluate(() => window.sceneThemeHarness.store.getState().startRuntimePreview());
        assert.equal(started.ok, true, JSON.stringify(started));
        await page.waitForFunction(() => window.sceneThemeHarness.store.getState().runtimeMode === 'preview');
      }
      await page.evaluate(() => window.sceneThemeHarness.camera());
      const frame = await page.evaluate(() => window.sceneThemeHarness.scene().getFrameId());
      await page.waitForFunction(value => {
        const harness = window.sceneThemeHarness;
        return harness.scene().getFrameId() > value + 20 && harness.meshes().length > 0 && harness.meshes().every(mesh => mesh.isReady(true));
      }, frame, { timeout: 90000 });
      const state = await page.evaluate(() => {
        const harness = window.sceneThemeHarness, scene = harness.scene(), main = scene.lights.filter(light => light.name === '__SceneThemeMain');
        const camera = scene.activeCamera;
        return { mainLights: main.length, mainColor: main[0].diffuse.toHexString().toLowerCase(), exposure: scene.imageProcessingConfiguration.exposure,
          root: harness.environmentRoot().uniqueId, lights: scene.lights.length, meshCount: harness.meshes().length,
          camera: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.asArray() } };
      });
      assert.equal(state.mainLights, 1); assert.equal(state.mainColor, preset.settings.mainColor);
      assert.equal(state.exposure, preset.settings.exposure); assert.equal(state.root, root);
      assert.equal(modelRequests, initialRequests, '真实模型切换主题及预览不能重新下载 GLB');
      const screenshot = path.join(output, mode + '-' + preset.id + '.png');
      await page.locator('canvas').first().screenshot({ path: screenshot }); images.push({ mode, state, screenshot });
      if (mode === 'preview') {
        await page.evaluate(() => window.sceneThemeHarness.store.getState().stopRuntimePreview());
        await page.waitForFunction(() => window.sceneThemeHarness.store.getState().runtimeMode === 'edit');
      }
    }
    results.push({ id: preset.id, images });
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, model, initialRequests, modelRequests, results, errors, platformConfig: 'local-MQTT-fixture' }, null, 2));
  await page.evaluate(() => window.sceneThemeHarness.dispose());
  console.log('PASS: 固定真实模型与相机的五主题 Editor/Preview 截图、唯一主光及无 GLB 重载。');
} catch (error) { if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined); throw error; }
finally {
  await browser?.close(); for (const socket of broker.clients) socket.terminate();
  await new Promise(resolve => broker.close(resolve)); await server.close();
}
