import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import mqttPacket from 'mqtt-packet';

export const stackerId = 'stacker-arrow-fixture';
export const assetCode = 'STACKER-ARROW-FIXTURE';
export const channels = ['travel', 'lift', 'frontFork', 'backFork'];
export const nodeNames = { travel: 'ArrowBase', lift: 'ArrowMast', frontFork: 'ArrowFrontFork', backFork: 'ArrowBackFork' };
export const idleFields = { mode: 1, front_command: 0, back_command: 0, front_x: 1, front_y: 1, front_z: 2,
  to_x: 0, to_y: 0, to_z: 0, front_movement_z: 0, back_movement_z: 0, normal: true, errorCode: 0 };

/** 独立节点避免父子层级叠加移动，轨道固定，前后叉可分别验证。 */
export async function createStackerFixture(output) {
  const modelRoot = path.join(output, 'model');
  await mkdir(modelRoot, { recursive: true });
  const source = await readFile('public/builtin-model-packages/virtual-conveyor/virtual-conveyor.glb');
  const jsonLength = source.readUInt32LE(12);
  const json = JSON.parse(source.subarray(20, 20 + jsonLength).toString());
  const binary = source.subarray(28 + jsonLength);
  const box = (name, x, y, z, width, height, depth) => ({ name, mesh: 0, translation: [x, y, z], scale: [width, height / .05, depth] });
  json.nodes = [
    box('ArrowRail', 0, 0, 0, .25, .12, 18),
    box('ArrowBase', 0, .12, 0, 1.8, .35, 2.6),
    box('ArrowMast', -.62, .47, 0, .35, 6.5, .5),
    box('ArrowPlatform', 0, .35, 0, 1.6, .45, 1.7),
    box('ArrowFrontFork', 0, .8, -.5, 1.6, .12, .48),
    box('ArrowBackFork', 0, .8, .5, 1.6, .12, .48),
  ];
  json.scenes = [{ nodes: json.nodes.map((_, index) => index) }];
  json.materials[0].pbrMetallicRoughness.baseColorFactor = [.37, .39, .43, 1];
  const encoded = Buffer.from(JSON.stringify(json));
  const jsonChunk = Buffer.concat([encoded, Buffer.from(' '.repeat((4 - encoded.length % 4) % 4))]);
  const result = Buffer.alloc(28 + jsonChunk.length + binary.length);
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonChunk.length, 12); result.writeUInt32LE(0x4e4f534a, 16); jsonChunk.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + jsonChunk.length); result.writeUInt32LE(0x004e4942, 24 + jsonChunk.length); binary.copy(result, 28 + jsonChunk.length);
  const modelPath = path.join(modelRoot, 'arrow-stacker.glb');
  const scriptPath = path.join(modelRoot, 'arrow-stacker.model.ts');
  const dataDriven = { device: { devType: 'stacker', defaultAssetCode: assetCode }, fixedNodes: ['ArrowRail'], motion: {
    travel: { nodes: ['ArrowBase', 'ArrowMast', 'ArrowPlatform', 'ArrowFrontFork', 'ArrowBackFork'], speed: .8 },
    lift: { nodes: ['ArrowPlatform', 'ArrowFrontFork', 'ArrowBackFork'], speed: .55, limits: { min: 0, max: 5.5 } },
    fork: { frontStageOneNodes: ['ArrowFrontFork'], frontStageTwoNodes: [], backStageOneNodes: ['ArrowBackFork'], backStageTwoNodes: [], speed: .45 },
  } };
  await writeFile(modelPath, result);
  await writeFile(scriptPath, '// 本地验收模型只声明运动节点，不改写节点或设备状态。\nexport const dataDriven = ' + JSON.stringify(dataDriven, null, 2) + ' as const;\n');
  const transform = (x = 0, y = 0, z = 0, ry = 0) => ({ position: { x, y, z }, rotation: { x: 0, y: ry, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
  const entity = (id, name, components) => ({ id, name, visible: true, locked: false, parentId: null, childrenIds: [], components });
  const assetUrl = file => 'editor-asset://local/' + encodeURIComponent(file);
  const model = entity(stackerId, '堆垛机运动箭头验收', { transform: transform(), modelAsset: { assetCode, sourcePath: modelPath,
    sourceUrl: assetUrl(modelPath), lengthUnit: 'meter', unitScaleToMeters: 1, dataDrivenConfig: dataDriven,
    scriptAssets: [{ path: scriptPath, sourceUrl: assetUrl(scriptPath), name: path.basename(scriptPath) }] },
    telemetryBinding: { enabled: true, sourceId: 'default', deviceType: 'stacker', expectedIntervalMs: 150, staleAfterMs: 1200, cargoOriginDevice: false } });
  const locator = entity('arrow-locator', '箭头验收货格', { transform: transform(2.5, .92, -5, -90), locator: {
    assetId: 'ARROW-SLOTS', storageDepth: 'near', length: 1, width: 1, height: 1, columns: 5, layers: 4, startColumn: 1, startLayer: 1,
    columnReversed: false, columnGap: 1.5, layerGap: .3, deviceAssetCode: assetCode, aisleCode: '', rowNumber: 2,
  } });
  const light = entity('arrow-light', '验收光源', { transform: transform(4, 8, -4), light: { lightKind: 'point', intensity: 1.5 } });
  return { version: 2, units: { length: 'meter' }, scene: { id: 'stacker-arrows-scene', name: '堆垛机运动箭头验收',
    entityIds: [model.id, locator.id, light.id], entities: { [model.id]: model, [locator.id]: locator, [light.id]: light }, selectedEntityId: stackerId,
    mqttConfig: { enabled: true, ip: '', address: '', topic: 'dt/factory/logistics/stacker/+/twindatadriven/joint', simulatorEnabled: false } } };
}

/** 只监听 loopback HTTP 服务的 MQTT 路由，不连接现场 Broker。 */
export function createStackerBroker(server) {
  const broker = new WebSocketServer({ noServer: true });
  const clients = new Map(), errors = [];
  let fields = { ...idleFields }, publishing = true, sequence = 0, publications = 0;
  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/__stacker_mqtt__') broker.handleUpgrade(request, socket, head, ws => broker.emit('connection', ws));
  });
  broker.on('connection', socket => {
    const state = { version: 4, subscribed: false }; clients.set(socket, state);
    const send = packet => { if (socket.readyState === 1) socket.send(mqttPacket.generate(packet, { protocolVersion: state.version })); };
    const parser = mqttPacket.parser();
    socket.on('message', data => parser.parse(data)); socket.on('close', () => clients.delete(socket));
    socket.on('error', error => errors.push(error.message)); parser.on('error', error => { errors.push(error.message); socket.close(); });
    parser.on('packet', packet => {
      if (packet.cmd === 'connect') { state.version = packet.protocolVersion; send({ cmd: 'connack', returnCode: 0, reasonCode: 0, sessionPresent: false }); }
      else if (packet.cmd === 'subscribe') { state.subscribed = true; send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 0) }); }
      else if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
      else if (packet.cmd === 'disconnect') socket.close();
    });
  });
  const ticker = setInterval(() => {
    if (!publishing) return;
    const payload = Buffer.from(JSON.stringify({ seq: ++sequence, data: Object.entries(fields).map(([p, v]) => ({ e: assetCode, p, v })) }));
    for (const [socket, state] of clients) if (state.subscribed && socket.readyState === 1) {
      socket.send(mqttPacket.generate({ cmd: 'publish', topic: `dt/factory/logistics/stacker/${assetCode}/twindatadriven/joint`, payload, qos: 0, retain: false, dup: false }, { protocolVersion: state.version })); publications++;
    }
  }, 150);
  return { drive: values => { fields = { ...idleFields, ...values }; publishing = true; }, pause: () => { publishing = false; }, errors,
    get publications() { return publications; }, close: async () => { clearInterval(ticker); for (const socket of clients.keys()) socket.terminate(); await new Promise(resolve => broker.close(resolve)); } };
}

export async function countCyanPixels(page, png) {
  return page.evaluate(async data => {
    const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; let cyan = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > 70 && pixels[i + 1] > pixels[i] * 1.4 && pixels[i + 2] > pixels[i] * 1.6) cyan++;
    return cyan;
  }, png.toString('base64'));
}

/** 读取真实网格矩阵和平台位置，把 Shader 缺口及上下可见区间投影到画布。 */
export async function readStackerArrowGeometry(page, globalName) {
  return page.evaluate(name => {
    const scene = window[name].scene(), engine = scene.getEngine();
    const rail = scene.meshes.find(mesh => mesh.name === 'ArrowRail');
    const platform = scene.meshes.find(mesh => mesh.name === 'ArrowPlatform');
    const travel = scene.meshes.find(mesh => mesh.metadata?.stackerMotionArrow && mesh.metadata.channel === 'travel');
    const lift = scene.meshes.find(mesh => mesh.metadata?.stackerMotionArrow && mesh.metadata.channel === 'lift');
    const Vector = rail.position.constructor, viewport = scene.activeCamera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
    for (const mesh of [rail, platform, travel, lift]) mesh?.computeWorldMatrix(true);
    const bounds = mesh => ({ min: mesh.getBoundingInfo().boundingBox.minimumWorld.asArray(), max: mesh.getBoundingInfo().boundingBox.maximumWorld.asArray() });
    const projectBand = (from, to) => [[from - .5, -.48], [to - .5, -.48], [to - .5, .48], [from - .5, .48]].map(([x, z]) => {
      const point = Vector.Project(new Vector(x, 0, z), lift.getWorldMatrix(), scene.getTransformMatrix(), viewport); return [point.x, point.y];
    });
    const floats = lift?.material?._floats ?? {};
    const min = floats.liftGapMin, max = floats.liftGapMax;
    return { rail: bounds(rail), platform: bounds(platform), travel: travel ? { ...bounds(travel), center: travel.getBoundingInfo().boundingBox.centerWorld.asArray(),
      length: Vector.TransformNormal(new Vector(1, 0, 0), travel.getWorldMatrix()).length() } : null,
      gap: { min, max, enabled: floats.liftGapEnabled },
      polygons: lift && max > min ? { gap: projectBand(min + .018, max - .018), below: projectBand(.05, min - .02), above: projectBand(max + .02, .95) } : null,
      renderSize: { width: engine.getRenderWidth(), height: engine.getRenderHeight() } };
  }, globalName);
}

/** 同一真实渲染帧内取矩阵与像素，避免行走期间画面横移造成投影区域错位。 */
export async function captureStackerGapFrame(page, globalName, screenshotPath) {
  await page.evaluate(name => new Promise(resolve => {
    const scene = window[name].scene(), engine = scene.getEngine();
    scene.onAfterRenderObservable.addOnce(() => {
      window.stackerGapPausedRendering = { engine, callbacks: [...engine.activeRenderLoops] };
      engine.stopRenderLoop(); resolve();
    });
  }), globalName);
  try {
    const geometry = await readStackerArrowGeometry(page, globalName);
    const png = await page.locator('canvas').first().screenshot({ path: screenshotPath });
    return { geometry, png };
  } finally {
    await page.evaluate(() => {
      const state = window.stackerGapPausedRendering;
      for (const callback of state.callbacks) state.engine.runRenderLoop(callback);
      delete window.stackerGapPausedRendering;
    });
  }
}

/** 缺口内不应有青色箭头像素；上下区域继续显示，避免用整个通道隐藏冒充缺口。 */
export async function inspectLiftGapPixels(page, png, geometry) {
  return page.evaluate(async ({ data, geometry }) => {
    const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const scaleX = canvas.width / geometry.renderSize.width, scaleY = canvas.height / geometry.renderSize.height;
    const inside = (x, y, polygon) => {
      let result = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) result = !result;
      }
      return result;
    };
    return Object.fromEntries(Object.entries(geometry.polygons).map(([key, points]) => {
      const polygon = points.map(([x, y]) => [x * scaleX, y * scaleY]);
      const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]); let samples = 0, cyan = 0;
      for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(canvas.height, Math.ceil(Math.max(...ys))); y++) {
        for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(canvas.width, Math.ceil(Math.max(...xs))); x++) {
          if (!inside(x + .5, y + .5, polygon)) continue;
          samples++; const offset = (y * canvas.width + x) * 4;
          if (pixels[offset + 1] > 145 && pixels[offset + 2] > 160 && pixels[offset + 1] > pixels[offset] * 1.5 && pixels[offset + 2] > pixels[offset] * 1.6) cyan++;
        }
      }
      return [key, { samples, cyan }];
    }));
  }, { data: png.toString('base64'), geometry });
}
