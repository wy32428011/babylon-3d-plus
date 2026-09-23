import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const mqttRequire = createRequire(require.resolve('mqtt'));
const mqttPacket = mqttRequire('mqtt-packet');
const { WebSocket, WebSocketServer } = mqttRequire('ws');
const output = path.resolve('output/conveyor-surface-arrows');
const packages = JSON.parse(await readFile(path.join(output, 'packages-result.json'), 'utf8'));
assert.equal(packages.ok, true, '先完成 SOURCE/DIST 验证');
const fixtures = {};
for (const key of ['model', 'point', 'legacy', 'disabled']) {
  assert.ok(packages.viewers?.[key], '缺少实际 DIST ' + key);
  const root = path.resolve(packages.viewers[key]);
  assert.equal(path.dirname(root), output, '只允许读取本任务产出的 Viewer');
  const document = JSON.parse(await readFile(path.join(root, 'project/scene.json'), 'utf8'));
  const conveyors = Object.values(document.scene.entities).filter(entity => entity.components.telemetryBinding?.deviceType === 'conveyor');
  assert.ok(conveyors.length > 0);
  const target = conveyors[0], binding = target.components.telemetryBinding;
  assert.ok(binding.staleAfterMs > 0 && binding.staleAfterMs <= 15000, '本地 stale 阈值应在 15 秒以内');
  const axis = target.components.modelAsset?.dataDrivenConfig?.cargo?.travel?.axis ?? 'x';
  const trajectory = binding.trajectoryDirection ?? 'x';
  fixtures[key] = { root, conveyors, target, binding, meshName: '__conveyorSurfaceArrows_' + target.id,
    forwardDirection: trajectory.replace('-', '') === axis && trajectory.startsWith('-') ? -1 : 1 };
}
assert.ok(fixtures.legacy.conveyors.every(entity => entity.components.telemetryBinding.surfaceArrows === undefined), '旧场景包必须实际缺少配置');
assert.ok(fixtures.disabled.conveyors.every(entity => entity.components.telemetryBinding.surfaceArrows.enabled === false), '关闭场景包必须明确 false');

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.ts': 'text/plain', '.json': 'application/json', '.css': 'text/css', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const [, key, ...segments] = pathname.split('/');
    const fixture = fixtures[key];
    if (!fixture) { res.writeHead(404).end(); return; }
    const file = path.resolve(fixture.root, segments.join('/') || 'index.html');
    const relative = path.relative(fixture.root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
    await pipeline(createReadStream(file), res);
  } catch (error) { if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(); }
});

// 每个场景均来自实际 DIST；这里只替代平台连接配置并通过 loopback MQTT 推送点位。
const broker = new WebSocketServer({ noServer: true });
const clients = new Map(), brokerErrors = [];
let sequence = 0, publications = 0, timer, activeConveyors = [];
server.on('upgrade', (request, socket, head) => {
  if (request.url === '/mqtt') broker.handleUpgrade(request, socket, head, ws => broker.emit('connection', ws));
  else socket.destroy();
});
const send = (socket, packet) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(mqttPacket.generate(packet, { protocolVersion: clients.get(socket)?.protocolVersion ?? 4 }));
};
broker.on('connection', socket => {
  const state = { protocolVersion: 4, topics: [] };
  clients.set(socket, state);
  const parser = mqttPacket.parser();
  socket.on('message', data => parser.parse(data));
  socket.on('error', error => brokerErrors.push(error.message));
  socket.on('close', () => clients.delete(socket));
  parser.on('error', error => { brokerErrors.push(error.message); socket.close(); });
  parser.on('packet', packet => {
    if (packet.cmd === 'connect') {
      state.protocolVersion = packet.protocolVersion;
      send(socket, { cmd: 'connack', returnCode: 0, reasonCode: 0, sessionPresent: false });
    } else if (packet.cmd === 'subscribe') {
      state.topics.push(...packet.subscriptions.map(subscription => subscription.topic));
      send(socket, { cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 0) });
    } else if (packet.cmd === 'pingreq') send(socket, { cmd: 'pingresp' });
    else if (packet.cmd === 'disconnect') socket.close();
  });
});
function matches(filter, topic) {
  const parts = topic.split('/'), filters = filter.split('/');
  for (let index = 0; index < filters.length; index += 1) {
    if (filters[index] === '#') return true;
    if (filters[index] !== '+' && filters[index] !== parts[index]) return false;
  }
  return filters.length === parts.length;
}
function drive(value, faulted = false, pointField = null, omitPoint = false) {
  clearInterval(timer);
  if (value === null) return;
  const publish = () => {
    sequence += 1;
    for (const entity of activeConveyors) {
      const code = entity.components.telemetryBinding.assetCode ?? entity.components.modelAsset.assetCode;
      const topic = `dt/factory/logistics/conveyor/${code}/twindatadriven/joint`;
      // 自定义点位时 movement_x 保持 0，证明箭头数据源独立于货物运动字段。
      const fields = { movement_x: pointField ? 0 : value, mode: 0, task: 0, normal: !faulted, errorCode: faulted ? 1 : 0 };
      if (pointField && !omitPoint) fields[pointField] = value;
      const payload = Buffer.from(JSON.stringify({ seq: sequence, ts: Date.now(), data: Object.entries(fields).map(([p, v]) => ({ e: code, p, v })) }));
      for (const [socket, state] of clients) {
        if (!state.topics.some(filter => matches(filter, topic))) continue;
        send(socket, { cmd: 'publish', topic, payload, qos: 0, retain: false, dup: false });
        publications += 1;
      }
    }
  };
  publish();
  timer = setInterval(publish, 200);
}

async function comparePixels(page, first, second) {
  return page.evaluate(async images => {
    const arrays = [];
    for (const data of images) {
      const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      arrays.push(context.getImageData(0, 0, canvas.width, canvas.height).data);
    }
    let changed = 0;
    const brightness = arrays.map(pixels => {
      let value = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > 60 && pixels[i + 1] > pixels[i] * 1.3 && pixels[i + 2] > pixels[i] * 1.3) value += pixels[i + 1] + pixels[i + 2];
      return value;
    });
    for (let i = 0; i < arrays[0].length; i += 4) {
      const distance = Math.abs(arrays[0][i] - arrays[1][i]) + Math.abs(arrays[0][i + 1] - arrays[1][i + 1]) + Math.abs(arrays[0][i + 2] - arrays[1][i + 2]);
      if (distance > 45) changed += 1;
    }
    return { changed, brightness };
  }, [first.toString('base64'), second.toString('base64')]);
}

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
let browser, page;
const errors = [];
async function runViewer(key) {
  const fixture = fixtures[key];
  const { root, binding, meshName, forwardDirection } = fixture;
  const point = key === 'point', pointField = point ? binding.surfaceArrows.directionBinding.field : null;
  const positive = 1, negative = point ? 'R' : 2, stop = point ? 'S' : 0;
  const publish = (value, faulted = false, omit = false) => drive(value, faulted, pointField, omit);
  activeConveyors = fixture.conveyors;
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.route('**/api/v1/digital-twin/runtime-config/detail', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { projectId: '123', runtimeEnabled: true, mqttBrokerUrl: base.replace('http:', 'ws:') + '/mqtt' } }) }));
  await page.goto(base + '/' + key + '/', { waitUntil: 'load' });
  const engineModule = (await readdir(path.join(root, 'assets'))).find(name => name.startsWith('engineStore-'));
  assert.ok(engineModule, '实际 DIST 应包含 Babylon EngineStore 模块');
  await page.evaluate(async url => {
    const module = await import(url);
    window.conveyorViewerEngines = Object.values(module).find(value => Array.isArray(value?.Instances));
  }, base + '/' + key + '/assets/' + engineModule);
  await page.getByRole('progressbar').waitFor({ state: 'hidden', timeout: 60000 });
  // 箭头首次无数据时允许懒创建；用真正的输送模型就绪作为门槛，不能被网格辅助线提前满足。
  await page.waitForFunction(() => window.conveyorViewerEngines?.Instances.some(engine => engine.scenes.some(scene => scene.meshes.some(mesh => mesh.name.includes('VCConveyorBelt') && mesh.getTotalVertices() > 0 && mesh.isReady(true)))) , null, { timeout: 60000 });
  if (key === 'disabled') {
    publish(positive);
    const startFrame = await page.evaluate(() => window.conveyorViewerEngines.Instances.flatMap(engine => engine.scenes)[0].getFrameId());
    await page.waitForFunction(frame => window.conveyorViewerEngines.Instances.flatMap(engine => engine.scenes)[0].getFrameId() > frame + 20, startFrame);
    const arrows = await page.evaluate(() => window.conveyorViewerEngines.Instances.flatMap(engine => engine.scenes.flatMap(scene => scene.meshes)).filter(mesh => mesh.name.startsWith('__conveyorSurfaceArrows_')).length);
    assert.equal(arrows, 0, '显式关闭的实际 DIST 不应创建箭头');
    drive(null); await page.close(); page = null;
    return { arrows, explicitDisabled: true };
  }
  const readState = () => page.evaluate(name => {
    const engine = window.conveyorViewerEngines.Instances.find(engine => engine.scenes.some(scene => scene.meshes.some(mesh => mesh.name === name)));
    if (!engine) return { exists: false, enabled: false };
    const scene = engine.scenes.find(scene => scene.meshes.some(mesh => mesh.name === name));
    const mesh = scene.meshes.find(mesh => mesh.name === name);
    return { exists: true, id: mesh.uniqueId, enabled: mesh.isEnabled(), ready: mesh.isReady(true), pickable: mesh.isPickable,
      direction: mesh.material?._floats.direction, phase: mesh.material?._floats.phase, arrowStyle: mesh.material?._floats.arrowStyle,
      breathingPhase: mesh.material?._floats.breathingPhase, breathingFactor: mesh.material?._floats.breathingFactor,
      opacity: mesh.material?._floats.opacity, material: mesh.material?.getClassName(), frame: scene.getFrameId(), renderer: engine.getGlInfo().renderer };
  }, meshName);
  const waitState = (enabled, direction) => page.waitForFunction(({ name, enabled, direction }) => {
    const mesh = window.conveyorViewerEngines.Instances.flatMap(engine => engine.scenes.flatMap(scene => scene.meshes)).find(mesh => mesh.name === name);
    return mesh && mesh.isEnabled() === enabled && (!enabled || mesh.isReady(true)) && (direction === null || mesh.material?._floats.direction === direction);
  }, { name: meshName, enabled, direction: direction ?? null }, { timeout: Math.max(10000, binding.staleAfterMs + 5000) });
  const initial = await readState();
  assert.equal(initial.enabled, false, '无 MQTT 快照时箭头可以尚未创建，但不得显示');
  publish(positive);
  await waitState(true, forwardDirection);
  await page.evaluate(name => {
    const scene = window.conveyorViewerEngines.Instances.flatMap(engine => engine.scenes).find(scene => scene.meshes.some(mesh => mesh.name === name));
    const mesh = scene.meshes.find(mesh => mesh.name === name);
    mesh.computeWorldMatrix(true);
    const bounds = mesh.getBoundingInfo().boundingBox;
    scene.activeCamera.setTarget(bounds.centerWorld.clone());
    scene.activeCamera.alpha = -Math.PI / 2;
    scene.activeCamera.beta = 0.28;
    scene.activeCamera.radius = Math.max(5, bounds.extendSizeWorld.length() * 3);
  }, meshName);
  const forward = await readState();
  assert.equal(forward.material, 'ShaderMaterial'); assert.equal(forward.pickable, false);
  assert.equal(forward.arrowStyle, point ? 3 : 0);
  if (!point) await page.waitForFunction(({ name, phase }) => window.conveyorViewerEngines.Instances.some(engine => engine.scenes.some(scene => scene.meshes.some(mesh => mesh.name === name && mesh.material?._floats.phase !== phase))), { name: meshName, phase: forward.phase });
  const prefix = key === 'model' ? 'viewer' : 'viewer-' + key;
  const forwardPng = await page.locator('canvas').first().screenshot();
  await writeFile(path.join(output, prefix + '-forward.png'), forwardPng);
  publish(negative); await waitState(true, -forwardDirection);
  const reverse = await readState();
  assert.equal(reverse.id, forward.id, '正反切换必须复用箭头 Mesh');
  await page.screenshot({ path: path.join(output, prefix + '-reverse.png') });
  publish(stop); await waitState(false);
  const stopped = await readState();
  const stoppedPng = await page.locator('canvas').first().screenshot();
  await writeFile(path.join(output, prefix + '-stopped.png'), stoppedPng);
  const pixels = await comparePixels(page, forwardPng, stoppedPng);
  assert.ok(pixels.changed > 80, '运行与停止画面应有实际箭头像素差异：' + pixels.changed);
  publish(positive); await waitState(true, forwardDirection);
  publish(positive, true); await waitState(false);
  const faulted = await readState();
  publish(positive); await waitState(true, forwardDirection);
  drive(null); await waitState(false);
  const stale = await readState();
  publish(negative); await waitState(true, -forwardDirection);
  const restored = await readState();
  assert.equal(restored.id, forward.id, '断流恢复必须复用 Mesh');
  const extra = {};
  if (point) {
    publish('01'); await waitState(false);
    extra.leadingZeroHidden = await readState();
    publish('1'); await waitState(true, forwardDirection);
    extra.stringOne = await readState();
    publish('unmapped'); await waitState(false);
    extra.unknownHidden = await readState();
    publish(1); await waitState(true, forwardDirection);
    publish(1, false, true); await waitState(false);
    extra.missingHidden = await readState();
    publish(1); await waitState(true, forwardDirection);
    assert.equal(binding.surfaceArrows.speed, 0, '呼吸验收必须关闭流动，避免像素差来自位移');
    const waitBreathing = bright => page.waitForFunction(({ name, bright }) => {
      const mesh = window.conveyorViewerEngines.Instances.flatMap(engine => engine.scenes.flatMap(scene => scene.meshes)).find(mesh => mesh.name === name);
      const factor = mesh?.material?._floats.breathingFactor;
      return bright ? factor > 0.98 : factor < 0.32;
    }, { name: meshName, bright }, { timeout: 6000 });
    await waitBreathing(true);
    const bright = await readState(), brightPng = await page.locator('canvas').first().screenshot();
    await waitBreathing(false);
    const dim = await readState(), dimPng = await page.locator('canvas').first().screenshot();
    assert.equal(bright.phase, dim.phase, '零速时流动相位必须静止');
    const breathingPixels = await comparePixels(page, brightPng, dimPng);
    assert.ok(breathingPixels.changed > 80, '呼吸必须改变实际可见像素');
    assert.ok(breathingPixels.brightness[0] > breathingPixels.brightness[1] * 1.25, '亮暗呼吸需要明显亮度差：' + JSON.stringify(breathingPixels));
    await writeFile(path.join(output, prefix + '-breathing-bright.png'), brightPng);
    await writeFile(path.join(output, prefix + '-breathing-dim.png'), dimPng);
    extra.breathing = { bright, dim, pixels: breathingPixels };
  }
  drive(null); await page.close(); page = null;
  return { initial, forward, reverse, stopped, faulted, stale, restored, pixels, ...extra };
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = {};
  for (const key of ['model', 'point', 'legacy', 'disabled']) results[key] = await runViewer(key);
  assert.ok(publications > 0, '必须通过真实 WebSocket MQTT 发布字段');
  assert.deepEqual(errors, []); assert.deepEqual(brokerErrors, []);
  await writeFile(path.join(output, 'viewer-result.json'), JSON.stringify({
    ok: true, results, publications, errors, brokerErrors, platformConfig: 'local-fixture', mqtt: 'local-websocket-fixture',
    checks: ['actual-DIST-four-fixtures', 'model-MQTT-1-2-0', 'custom-point-independent-of-movement', 'scalar-exact-match-and-leading-zero',
      'unknown-and-missing-hidden', 'zero-speed-breathing-WebGL-pixels', 'legacy-absent-default-on', 'explicit-disabled-no-mesh',
      'shader-phase-progress', 'fault-hidden', 'stale-hidden', 'recovery-Mesh-reuse'],
  }, null, 2));
  console.log('PASS: 实际 DIST Viewer 默认/自定义 MQTT、精确值匹配、零速呼吸像素、旧缺省开启和显式关闭。');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'viewer-failure.png') }).catch(() => {});
  throw error;
} finally {
  clearInterval(timer);
  await browser?.close();
  for (const socket of clients.keys()) socket.terminate();
  await new Promise(resolve => broker.close(resolve));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
