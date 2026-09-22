import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import mqttPacket from 'mqtt-packet';

const output = path.resolve('output/playwright/scene-theme');
await mkdir(output, { recursive: true });

// 带法线的 PBR 厂房和地面走真实 GLB/环境材质路径，验证受光切换而非替代渲染器。
async function createFactoryFixture() {
  const faces = [
    { normal: [0, 0, -1], points: [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]] },
    { normal: [0, 0, 1], points: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { normal: [-1, 0, 0], points: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
    { normal: [1, 0, 0], points: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
    { normal: [0, 1, 0], points: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
    { normal: [0, -1, 0], points: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  ];
  const positions = new Float32Array(faces.flatMap(face => face.points.flat()));
  const normals = new Float32Array(faces.flatMap(face => face.points.flatMap(() => face.normal)));
  const indices = new Uint16Array(faces.flatMap((_, index) => [0, 1, 2, 0, 2, 3].map(vertex => index * 4 + vertex)));
  const binary = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(normals.buffer), Buffer.from(indices.buffer)]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1, 2] }],
    nodes: [
      { name: 'BuildingA', mesh: 0, translation: [-4, 2, 1], scale: [2.5, 2, 3] },
      { name: 'BuildingB', mesh: 0, translation: [4, 3, 1], scale: [2.5, 3, 3] },
      { name: 'Ground', mesh: 1, translation: [0, -0.15, 0], scale: [11, 0.15, 10] },
    ],
    meshes: [0, 1].map(material => ({ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material }] })),
    materials: [
      { name: 'Facade', pbrMetallicRoughness: { baseColorFactor: [0.46, 0.5, 0.55, 1], metallicFactor: 0, roughnessFactor: 0.85 } },
      { name: 'Road', pbrMetallicRoughness: { baseColorFactor: [0.22, 0.25, 0.28, 1], metallicFactor: 0.05, roughnessFactor: 0.7 } },
    ],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength },
      { buffer: 0, byteOffset: positions.byteLength + normals.byteLength, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  };
  const json = Buffer.from(JSON.stringify(gltf));
  const paddedJson = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + paddedJson.length + binary.length, 8);
  header.writeUInt32LE(paddedJson.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0); binaryHeader.writeUInt32LE(0x004e4942, 4);
  const modelPath = path.join(output, 'factory.glb');
  await writeFile(modelPath, Buffer.concat([header, paddedJson, binaryHeader, binary]));
  return modelPath;
}

const modelPath = await createFactoryFixture();
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
// 预览仅连接本地 MQTT 握手 fixture，证明预览链路而不代表业务 Broker 验收。
const broker = new WebSocketServer({ noServer: true });
server.httpServer.on('upgrade', (request, socket, head) => {
  if (request.url === '/__scene_theme_mqtt__') broker.handleUpgrade(request, socket, head, ws => broker.emit('connection', ws, request));
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
let glbRequests = 0;
try {
  await server.listen();
  await server.watcher.close();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); } });
  page.on('request', request => { if (request.url().includes('factory.glb')) glbRequests++; });
  await page.addInitScript(value => { window.sceneThemeFixturePath = value; }, modelPath);
  const html = await server.transformIndexHtml('/__scene_theme__', '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/sceneTheme.harness.tsx"></script></body></html>');
  await page.route('**/__scene_theme__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__scene_theme__', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.sceneThemeHarness?.ready(), null, { timeout: 180000 });

  async function waitForFrame() {
    const frame = await page.evaluate(() => window.sceneThemeHarness.scene().getFrameId());
    await page.waitForFunction(value => {
      const harness = window.sceneThemeHarness;
      return harness.scene().getFrameId() > value + 10 && harness.meshes().every(mesh => mesh.isReady(true));
    }, frame);
  }
  async function canvasImage(filename) {
    await waitForFrame();
    return page.locator('canvas').first().screenshot({ path: filename ? path.join(output, filename) : undefined });
  }
  async function compareImages(before, after) {
    return page.evaluate(async images => {
      const pixels = await Promise.all(images.map(async data => {
        const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        return { data: context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
      }));
      let changed = 0, totalDifference = 0, backgroundDifference = 0, backgroundPixels = 0;
      for (let index = 0; index < pixels[0].data.length; index += 4) {
        const difference = Math.abs(pixels[0].data[index] - pixels[1].data[index])
          + Math.abs(pixels[0].data[index + 1] - pixels[1].data[index + 1]) + Math.abs(pixels[0].data[index + 2] - pixels[1].data[index + 2]);
        if (difference > 15) changed++;
        totalDifference += difference;
        const x = (index / 4) % pixels[0].width, y = Math.floor(index / 4 / pixels[0].width);
        // 左上方天空无建筑、网格和坐标轴，避免把 FXAA 边缘变化误判成全屏曝光变化。
        if (x > pixels[0].width * 0.1 && x < pixels[0].width * 0.3 && y > pixels[0].height * 0.05 && y < pixels[0].height * 0.15) {
          backgroundDifference += difference / 3; backgroundPixels++;
        }
      }
      return { changedPixels: changed, meanDifference: totalDifference / (pixels[0].data.length / 4),
        backgroundDifference: backgroundDifference / backgroundPixels };
    }, [before.toString('base64'), after.toString('base64')]);
  }
  async function imageVisibility(png) {
    return page.evaluate(async data => {
      const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let visiblePixels = 0, totalBrightness = 0, min = 255, max = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const brightness = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
        if (brightness > 12) visiblePixels++;
        totalBrightness += brightness; min = Math.min(min, brightness); max = Math.max(max, brightness);
      }
      return { visiblePixels, meanBrightness: totalBrightness / (pixels.length / 4), brightnessRange: max - min };
    }, png.toString('base64'));
  }

  await page.evaluate(() => window.sceneThemeHarness.camera());
  const baseline = await canvasImage('before.png');
  const original = await page.evaluate(() => {
    const harness = window.sceneThemeHarness, state = harness.store.getState();
    return { root: harness.environmentRoot().uniqueId, entityIds: state.scene.entityIds,
      entities: JSON.stringify(state.scene.entities), shadows: state.scene.sceneSettings.shadows,
      history: state.history.undoStack.length, lightCount: harness.scene().lights.length };
  });
  const originalLoads = glbRequests;
  await page.getByRole('button', { name: '主题库', exact: true }).click();
  const card = page.getByRole('button', { name: /科技蓝夜景/ });
  assert.equal(await page.getByRole('button', { name: /暗色城市/ }).isDisabled(), true);
  await card.click();
  await page.waitForFunction(() => window.sceneThemeHarness.store.getState().scene.sceneSettings.theme?.presetId === 'tech-blue-night');
  await page.getByRole('button', { name: '恢复主题默认值', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.sceneThemeHarness.store.getState().scene.selectedEntityId), null);
  assert.match(await card.innerText(), /当前使用/);
  await page.waitForFunction(() => window.sceneThemeHarness.meshes().every(mesh => !mesh.material?.unlit && !mesh.material?.disableLighting));
  const night = await canvasImage('night.png');
  const nightDifference = await compareImages(baseline, night);
  assert.ok(nightDifference.changedPixels > 5000 && nightDifference.meanDifference > 3, JSON.stringify(nightDifference));
  const afterApply = await page.evaluate(() => ({ entityIds: window.sceneThemeHarness.store.getState().scene.entityIds,
    entities: JSON.stringify(window.sceneThemeHarness.store.getState().scene.entities),
    root: window.sceneThemeHarness.environmentRoot().uniqueId,
    lightCount: window.sceneThemeHarness.scene().lights.length,
    history: window.sceneThemeHarness.store.getState().history.undoStack.length }));
  assert.deepEqual(afterApply.entityIds, original.entityIds);
  assert.equal(afterApply.entities, original.entities, '主题不覆盖已有实体和业务参数');
  assert.equal(afterApply.root, original.root, '主题切换复用环境根节点');
  assert.equal(afterApply.history, original.history + 1, '应用主题是一条历史命令');
  await card.click();
  assert.equal(await page.evaluate(() => window.sceneThemeHarness.store.getState().history.undoStack.length), afterApply.history, '重复应用默认主题不增加历史');
  assert.equal(await page.evaluate(() => window.sceneThemeHarness.scene().lights.length), afterApply.lightCount, '重复应用不新增灯光');
  await page.evaluate(() => window.sceneThemeHarness.store.getState().undo());
  assert.equal(await page.evaluate(() => window.sceneThemeHarness.store.getState().scene.sceneSettings.theme ?? null), null);
  assert.deepEqual(await page.evaluate(() => window.sceneThemeHarness.store.getState().scene.sceneSettings.shadows), original.shadows);
  await page.waitForFunction(() => window.sceneThemeHarness.meshes().every(mesh => mesh.material?.unlit || mesh.material?.disableLighting));
  await card.dragTo(page.locator('canvas').first());
  await page.waitForFunction(() => window.sceneThemeHarness.store.getState().scene.sceneSettings.theme?.presetId === 'tech-blue-night');

  await page.locator('.scene-theme-group > summary').filter({ hasText: '画面与光晕' }).click();
  const exposure = page.getByLabel('曝光', { exact: true });
  await exposure.fill('1.4'); await exposure.press('Enter');
  assert.equal(await page.evaluate(() => window.sceneThemeHarness.store.getState().scene.sceneSettings.theme.exposure), 1.4);
  assert.match(await card.innerText(), /已调整/);
  const custom = await canvasImage('adjusted.png');
  const exposureDifference = await compareImages(night, custom);
  assert.ok(exposureDifference.changedPixels > 1000, JSON.stringify(exposureDifference));
  await page.getByLabel('柔和泛光', { exact: true }).check();
  const bloomWeight = page.getByLabel('泛光强度', { exact: true });
  await bloomWeight.fill('0'); await bloomWeight.press('Enter');
  const zeroBloom = await canvasImage('bloom-zero.png');
  const zeroBloomDifference = await compareImages(custom, zeroBloom);
  assert.ok(zeroBloomDifference.meanDifference < 5 && zeroBloomDifference.backgroundDifference < 3,
    '泛光权重为零时不能重复曝光或伽马处理：' + JSON.stringify(zeroBloomDifference));
  await bloomWeight.fill('0.12'); await bloomWeight.press('Enter');
  const bloomImage = await canvasImage('bloom-on.png');
  const bloomDifference = await compareImages(custom, bloomImage);
  assert.ok(bloomDifference.backgroundDifference < 3, '少量泛光不能整体提亮深蓝背景：' + JSON.stringify(bloomDifference));
  const bloomOn = await imageVisibility(bloomImage);
  assert.ok(bloomOn.visiblePixels > 20000 && bloomOn.meanBrightness > 8 && bloomOn.brightnessRange > 20,
    'Bloom 开启后仍有明暗层次与可见场景：' + JSON.stringify(bloomOn));

  async function pipelineSnapshot() {
    return page.evaluate(() => {
      const scene = window.sceneThemeHarness.scene();
      return { activeCameraId: scene.activeCamera.uniqueId, postProcessCount: scene.postProcesses.length,
        // Babylon 把相机后处理保存在已声明的 _postProcesses；scene.postProcesses 不包含这些附件。
        activePostProcessNames: scene.activeCamera._postProcesses.filter(Boolean).map(process => process.name),
        inactivePostProcessCount: scene.cameras.filter(camera => camera !== scene.activeCamera)
          .reduce((count, camera) => count + camera._postProcesses.filter(Boolean).length, 0),
        pipelines: scene.postProcessRenderPipelineManager.supportedPipelines
          .filter(pipeline => pipeline.name === 'sceneThemeBloom')
          .map(pipeline => ({ name: pipeline.name, cameraIds: pipeline.cameras.map(camera => camera.uniqueId) })) };
    });
  }
  const originalPipeline = await pipelineSnapshot();
  assert.equal(originalPipeline.pipelines.length, 1);
  assert.ok(originalPipeline.activePostProcessNames.length > 0, '相机实际挂载泛光后处理');
  assert.equal(originalPipeline.inactivePostProcessCount, 0);
  assert.deepEqual(originalPipeline.pipelines[0].cameraIds, [originalPipeline.activeCameraId]);
  const cameraSwitches = [];
  for (let pass = 0; pass < 3; pass++) {
    for (const alternate of [true, false]) {
      const cameraId = await page.evaluate(value => window.sceneThemeHarness.switchCamera(value), alternate);
      await waitForFrame();
      const snapshot = await pipelineSnapshot();
      assert.equal(snapshot.postProcessCount, originalPipeline.postProcessCount, '切换相机不累积后处理实例');
      assert.deepEqual(snapshot.activePostProcessNames, originalPipeline.activePostProcessNames, '当前相机后处理数量和顺序保持不变');
      assert.equal(snapshot.inactivePostProcessCount, 0, '旧相机必须移除主题后处理');
      assert.deepEqual(snapshot.pipelines, [{ name: 'sceneThemeBloom', cameraIds: [cameraId] }], '管线只绑定当前相机');
      cameraSwitches.push(snapshot);
      if (pass === 0) {
        const visibility = await imageVisibility(await canvasImage(alternate ? 'bloom-alternate-camera.png' : 'bloom-restored-camera.png'));
        assert.ok(visibility.visiblePixels > 20000 && visibility.brightnessRange > 20, '切换相机后实际画布仍可见');
      }
    }
  }
  await page.evaluate(() => window.sceneThemeHarness.disposeAlternateCamera());
  await page.getByLabel('柔和泛光', { exact: true }).uncheck();
  const bloomOff = await imageVisibility(await canvasImage('bloom-off.png'));
  const disabledPipeline = await pipelineSnapshot();
  assert.deepEqual(disabledPipeline.activePostProcessNames, [], '关闭泛光清除相机后处理');
  assert.deepEqual(disabledPipeline.pipelines, [], '关闭泛光释放渲染管线');
  assert.ok(bloomOff.visiblePixels > 20000 && bloomOff.meanBrightness > 8 && bloomOff.brightnessRange > 20,
    'Bloom 关闭并释放管线后仍正常渲染：' + JSON.stringify(bloomOff));
  await page.getByLabel('环境受光', { exact: true }).selectOption('original');
  await page.waitForFunction(() => window.sceneThemeHarness.meshes().every(mesh => mesh.material?.unlit || mesh.material?.disableLighting));
  await page.getByLabel('环境受光', { exact: true }).selectOption('scene');
  await page.waitForFunction(() => window.sceneThemeHarness.meshes().every(mesh => !mesh.material?.unlit && !mesh.material?.disableLighting));
  assert.equal(glbRequests, originalLoads, '修改主题不重新请求环境 GLB');
  assert.equal(await page.evaluate(() => window.sceneThemeHarness.environmentRoot().uniqueId), original.root);

  // 实际属性输入与快捷按钮必须同时更新持久配置和 Babylon 局部灯光。
  const pointId = await page.evaluate(() => {
    const state = window.sceneThemeHarness.store.getState();
    const id = state.scene.entityIds.find(entityId => state.scene.entities[entityId].components.light?.lightKind === 'point');
    state.selectEntity(id); return id;
  });
  await page.getByLabel('灯光颜色', { exact: true }).fill('#ffb45e');
  await page.getByLabel('照射范围 (m)', { exact: true }).fill('32');
  await page.waitForFunction(id => {
    const light = window.sceneThemeHarness.scene().getLightByName(id);
    return light?.diffuse.toHexString().toLowerCase() === '#ffb45e' && light.range === 32;
  }, pointId);
  await page.getByRole('button', { name: '暖白作业灯', exact: true }).click();
  await page.waitForFunction(id => {
    const light = window.sceneThemeHarness.scene().getLightByName(id);
    return light?.isEnabled() && light.diffuse.toHexString().toLowerCase() === '#ffd6a3'
      && light.range === 20 && light.intensity === 1.5;
  }, pointId);
  const warmLight = await page.evaluate(id => window.sceneThemeHarness.store.getState().scene.entities[id].components.light, pointId);
  assert.equal(warmLight.color, '#ffd6a3'); assert.equal(warmLight.range, 20); assert.equal(warmLight.nightBehavior, 'keep');
  await page.screenshot({ path: path.join(output, 'warm-work-light.png') });
  await page.evaluate(() => window.sceneThemeHarness.store.getState().selectEntity(null));

  const saved = await page.evaluate(() => window.sceneThemeHarness.save());
  await writeFile(path.join(output, 'scene.scene.json'), saved);
  const savedTheme = await page.evaluate(() => window.sceneThemeHarness.store.getState().scene.sceneSettings.theme);
  await page.evaluate(content => window.sceneThemeHarness.reopen(content), saved);
  await page.waitForFunction(() => window.sceneThemeHarness.ready());
  await page.evaluate(() => { window.sceneThemeHarness.store.getState().selectEntity(null); window.sceneThemeHarness.camera(); });
  assert.deepEqual(await page.evaluate(() => window.sceneThemeHarness.store.getState().scene.sceneSettings.theme), savedTheme);
  assert.deepEqual(await page.evaluate(id => window.sceneThemeHarness.store.getState().scene.entities[id].components.light, pointId), warmLight);
  await waitForFrame();
  await page.screenshot({ path: path.join(output, 'editor-reopened.png') });

  await page.evaluate(() => window.sceneThemeHarness.setReadOnly(true));
  assert.equal(await card.isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '恢复主题默认值', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.sceneThemeHarness.setReadOnly(false));
  const preview = await page.evaluate(() => {
    const state = window.sceneThemeHarness.store.getState();
    state.updateMqttConfig({ ...state.scene.mqttConfig, enabled: true, address: 'ws://' + location.host + '/__scene_theme_mqtt__', ip: '', simulatorEnabled: false });
    return window.sceneThemeHarness.store.getState().startRuntimePreview();
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  await page.waitForFunction(() => window.sceneThemeHarness.store.getState().runtimeMode === 'preview');
  assert.equal(await card.isDisabled(), true, '运行预览禁止应用主题');
  assert.equal(await page.getByRole('button', { name: '恢复主题默认值', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.sceneThemeHarness.camera());
  await waitForFrame();
  await page.screenshot({ path: path.join(output, 'preview.png') });
  assert.deepEqual(await page.evaluate(() => window.sceneThemeHarness.store.getState().scene.sceneSettings.theme), savedTheme);
  await page.evaluate(() => window.sceneThemeHarness.store.getState().stopRuntimePreview());
  await page.waitForFunction(() => window.sceneThemeHarness.store.getState().runtimeMode === 'edit');
  await page.getByRole('button', { name: '恢复主题默认值', exact: true }).click();
  assert.equal(await page.evaluate(() => window.sceneThemeHarness.store.getState().scene.sceneSettings.theme.exposure), 1.05);
  assert.doesNotMatch(await card.innerText(), /已调整/);
  await page.getByRole('button', { name: '停用主题', exact: true }).click();
  await page.waitForFunction(() => window.sceneThemeHarness.store.getState().scene.sceneSettings.theme == null);
  await page.waitForFunction(() => window.sceneThemeHarness.meshes().every(mesh => mesh.material?.unlit || mesh.material?.disableLighting));
  await page.waitForFunction(count => window.sceneThemeHarness.scene().lights.length === count, original.lightCount);
  await page.evaluate(() => window.sceneThemeHarness.store.getState().undo());
  await page.waitForFunction(() => window.sceneThemeHarness.meshes().every(mesh => !mesh.material?.unlit && !mesh.material?.disableLighting));
  await page.screenshot({ path: path.join(output, 'final.png') });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, nightDifference, exposureDifference, zeroBloomDifference, bloomDifference,
    bloomOn, bloomOff, originalPipeline, disabledPipeline, cameraSwitches, warmLight,
    originalLoads, glbRequests, errors, checks: ['real-glb-pbr', 'theme-card-click', 'real-card-drag', 'no-extra-entities',
      'single-undo', 'idempotent-apply', 'exposure-pixels', 'bloom-on-off-visible', 'bloom-zero-no-double-processing',
      'bloom-background-preserved', 'active-camera-switch-no-pipeline-leak', 'warm-work-light-ui', 'environment-lighting-toggle', 'no-glb-reload',
      'save-reopen', 'read-only', 'preview-lock', 'reset-defaults', 'disable-restores-light-count', 'disable-undo'] }, null, 2));
  await page.evaluate(() => window.sceneThemeHarness.dispose());
  console.log('PASS: 科技蓝夜景主题点击/拖放、可见画面、参数、撤销、保存重开、只读与运行预览。');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
  throw error;
} finally {
  await browser?.close();
  for (const socket of broker.clients) socket.terminate();
  await new Promise(resolve => broker.close(resolve));
  await server.close();
}
