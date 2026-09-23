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
const root = path.resolve(packages.viewerRoot);
assert.equal(path.dirname(root), output, '只允许读取本任务产出的 Viewer');
const document = JSON.parse(await readFile(path.join(root, 'project/scene.json'), 'utf8'));
const conveyors = Object.values(document.scene.entities).filter(entity => entity.components.telemetryBinding?.surfaceArrows?.enabled);
const target = conveyors.find(entity => entity.components.telemetryBinding.surfaceArrows.speed > 0 && entity.components.telemetryBinding.surfaceArrows.opacity > 0);
assert.ok(target, '验收场景需要至少一台可见且流动的表面箭头输送线');
const binding = target.components.telemetryBinding;
const staleAfterMs = binding.staleAfterMs;
assert.ok(staleAfterMs > 0 && staleAfterMs <= 15000, '本地夹具 stale 阈值应在 15 秒以内');
const meshName = '__conveyorSurfaceArrows_' + target.id;
const axis = target.components.modelAsset?.dataDrivenConfig?.cargo?.travel?.axis ?? 'x';
const trajectory = binding.trajectoryDirection ?? 'x';
const forwardDirection = trajectory.replace('-', '') === axis && trajectory.startsWith('-') ? -1 : 1;

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.ts': 'text/plain', '.json': 'application/json', '.css': 'text/css', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
    await pipeline(createReadStream(file), res);
  } catch (error) { if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(); }
});

// MQTT 数据只由本地 loopback fixture 产生，不连接中台或真实设备 Broker。
const broker = new WebSocketServer({ noServer: true });
const clients = new Map();
const brokerErrors = [];
let sequence = 0, publications = 0, timer;
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
function drive(movement, faulted = false) {
  clearInterval(timer);
  if (movement === null) return;
  const publish = () => {
    sequence += 1;
    for (const entity of conveyors) {
      const code = entity.components.telemetryBinding.assetCode ?? entity.components.modelAsset.assetCode;
      const topic = `dt/factory/logistics/conveyor/${code}/twindatadriven/joint`;
      const fields = { movement_x: movement, mode: 0, task: 0, normal: !faulted, errorCode: faulted ? 1 : 0 };
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

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
let browser, page;
const errors = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.route('**/api/v1/digital-twin/runtime-config/detail', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { projectId: '123', runtimeEnabled: true, mqttBrokerUrl: base.replace('http:', 'ws:') + '/mqtt' } }) }));
  await page.goto(base, { waitUntil: 'load' });
  const engineModule = (await readdir(path.join(root, 'assets'))).find(name => name.startsWith('engineStore-'));
  assert.ok(engineModule, '实际 DIST 应包含 Babylon EngineStore 模块');
  await page.evaluate(async source => {
    const module = await import('/assets/' + source);
    window.conveyorViewerEngines = Object.values(module).find(value => Array.isArray(value?.Instances));
  }, engineModule);
  await page.waitForFunction(name => window.conveyorViewerEngines?.Instances.some(engine => engine.scenes.some(scene => scene.meshes.some(mesh => mesh.name === name))), meshName, { timeout: 60000 });
  await page.getByRole('progressbar').waitFor({ state: 'hidden', timeout: 60000 });
  const readState = () => page.evaluate(name => {
    const engine = window.conveyorViewerEngines.Instances.find(engine => engine.scenes.some(scene => scene.meshes.some(mesh => mesh.name === name)));
    const scene = engine.scenes.find(scene => scene.meshes.some(mesh => mesh.name === name));
    const mesh = scene.meshes.find(mesh => mesh.name === name);
    return { id: mesh.uniqueId, enabled: mesh.isEnabled(), ready: mesh.isReady(true), pickable: mesh.isPickable,
      direction: mesh.material?._floats.direction, phase: mesh.material?._floats.phase,
      opacity: mesh.material?._floats.opacity, material: mesh.material?.getClassName(), frame: scene.getFrameId(), renderer: engine.getGlInfo().renderer };
  }, meshName);
  const waitState = (enabled, direction) => page.waitForFunction(({ name, enabled, direction }) => {
    const mesh = window.conveyorViewerEngines.Instances.flatMap(engine => engine.scenes.flatMap(scene => scene.meshes)).find(mesh => mesh.name === name);
    return mesh && mesh.isEnabled() === enabled && (!enabled || mesh.isReady(true)) && (direction === null || mesh.material?._floats.direction === direction);
  }, { name: meshName, enabled, direction: direction ?? null }, { timeout: Math.max(10000, staleAfterMs + 5000) });
  const initial = await readState();
  assert.equal(initial.enabled, false, '无 MQTT 快照时不得显示运行箭头');
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
  drive(1);
  await waitState(true, forwardDirection);
  const forward = await readState();
  assert.equal(forward.material, 'ShaderMaterial'); assert.equal(forward.pickable, false);
  await page.waitForFunction(({ name, phase }) => window.conveyorViewerEngines.Instances.some(engine => engine.scenes.some(scene => scene.meshes.some(mesh => mesh.name === name && mesh.material?._floats.phase !== phase))), { name: meshName, phase: forward.phase });
  const forwardPng = await page.locator('canvas').first().screenshot();
  await writeFile(path.join(output, 'viewer-forward.png'), forwardPng);
  drive(2);
  await waitState(true, -forwardDirection);
  const reverse = await readState();
  assert.equal(reverse.id, forward.id, '正反切换必须复用箭头 Mesh');
  await page.screenshot({ path: path.join(output, 'viewer-reverse.png') });
  drive(0);
  await waitState(false);
  const stopped = await readState();
  const stoppedPng = await page.locator('canvas').first().screenshot();
  await writeFile(path.join(output, 'viewer-stopped.png'), stoppedPng);
  const changedPixels = await page.evaluate(async images => {
    const arrays = [];
    for (const data of images) {
      const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      arrays.push(context.getImageData(0, 0, canvas.width, canvas.height).data);
    }
    let changed = 0;
    for (let i = 0; i < arrays[0].length; i += 4) {
      const distance = Math.abs(arrays[0][i] - arrays[1][i]) + Math.abs(arrays[0][i + 1] - arrays[1][i + 1]) + Math.abs(arrays[0][i + 2] - arrays[1][i + 2]);
      if (distance > 45) changed += 1;
    }
    return changed;
  }, [forwardPng.toString('base64'), stoppedPng.toString('base64')]);
  assert.ok(changedPixels > 80, '运行与停止画面应有实际箭头像素差异：' + changedPixels);
  drive(1);
  await waitState(true, forwardDirection);
  drive(1, true);
  await waitState(false);
  const faulted = await readState();
  drive(1);
  await waitState(true, forwardDirection);
  drive(null);
  await waitState(false);
  const stale = await readState();
  drive(2);
  await waitState(true, -forwardDirection);
  const restored = await readState();
  assert.equal(restored.id, forward.id, '断流恢复必须复用 Mesh');
  assert.ok(publications > 0, '必须通过真实 WebSocket MQTT 发布字段');
  assert.deepEqual(errors, []); assert.deepEqual(brokerErrors, []);
  await writeFile(path.join(output, 'viewer-result.json'), JSON.stringify({
    ok: true, initial, forward, reverse, stopped, faulted, stale, restored, changedPixels, publications, errors, brokerErrors,
    platformConfig: 'local-fixture', mqtt: 'local-websocket-fixture',
    checks: ['actual-DIST', 'no-snapshot-hidden', 'MQTT-forward-reverse-stop', 'shader-phase-progress', 'visible-WebGL-pixels', 'fault-hidden', 'stale-hidden', 'recovery-Mesh-reuse'],
  }, null, 2));
  console.log('PASS: 实际 DIST Viewer 的 MQTT 正转/反转/停止、故障、断流恢复、Shader 状态和可见 WebGL 像素。');
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
