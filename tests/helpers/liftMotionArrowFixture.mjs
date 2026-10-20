import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import mqttPacket from 'mqtt-packet';
export { countCyanPixels } from './stackerMotionArrowFixture.mjs';

export const liftId = 'lift-arrow-fixture', hcId = 'hclift-arrow-fixture';
export const assetCodes = { lift: 'LIFT-ARROW-FIXTURE', hclift: 'HCLIFT-ARROW-FIXTURE' };
export const idleFields = {
  lift: { mode: 1, reference_upper_step: 1, level_upper: 1, work_state: 0, normal: true, errorCode: 0 },
  hclift: { mode: 1, lift_current_level: 1, task_target_level: 1, work_state: 0, normal: true, errorCode: 0 },
};

/** 已知尺寸的真实 GLB 夹具，声明固定柱与载货台，不实现任何设备动作。 */
export async function createLiftFixture(output) {
  const modelRoot = path.join(output, 'model'); await mkdir(modelRoot, { recursive: true });
  const source = await readFile('public/builtin-model-packages/virtual-conveyor/virtual-conveyor.glb');
  const jsonLength = source.readUInt32LE(12), base = JSON.parse(source.subarray(20, 20 + jsonLength).toString());
  const binary = source.subarray(28 + jsonLength);
  const transform = (x = 0, y = 0, z = 0, scale = { x: 1, y: 1, z: 1 }) => ({ position: { x, y, z }, rotation: { x: 0, y: 0, z: 0 }, scale });
  const entity = (id, name, components) => ({ id, name, visible: true, locked: false, parentId: null, childrenIds: [], components });
  const assetUrl = file => 'editor-asset://local/' + encodeURIComponent(file);
  const models = [];
  for (const [type, prefix, id, x] of [['lift', 'Lift', liftId, -2.5], ['hclift', 'Hc', hcId, 2.5]]) {
    const json = structuredClone(base);
    const box = (name, bx, y, z, width, height, depth) => ({ name, mesh: 0, translation: [bx, y - height / 2, z], scale: [width, height / .05, depth] });
    json.nodes = [box(prefix + 'Column', -.85, 3, 0, .22, 6, .35), box(prefix + 'Deck', 0, .5, 0, 1.5, .15, 1.5)];
    json.scenes = [{ nodes: [0, 1] }];
    json.materials[0].pbrMetallicRoughness.baseColorFactor = [.37, .39, .43, 1];
    const encoded = Buffer.from(JSON.stringify(json)), chunk = Buffer.concat([encoded, Buffer.from(' '.repeat((4 - encoded.length % 4) % 4))]);
    const result = Buffer.alloc(28 + chunk.length + binary.length);
    result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
    result.writeUInt32LE(chunk.length, 12); result.writeUInt32LE(0x4e4f534a, 16); chunk.copy(result, 20);
    result.writeUInt32LE(binary.length, 20 + chunk.length); result.writeUInt32LE(0x004e4942, 24 + chunk.length); binary.copy(result, 28 + chunk.length);
    const modelPath = path.join(modelRoot, 'arrow-' + type + '.glb'), scriptPath = path.join(modelRoot, 'arrow-' + type + '.model.ts');
    const dataDriven = { device: { devType: type, defaultAssetCode: assetCodes[type] }, fixedNodes: [prefix + 'Column'],
      motion: { lift: { nodes: [prefix + 'Deck'], speed: .8 } }, cargo: { nodes: [prefix + 'Deck'] } };
    await writeFile(modelPath, result);
    await writeFile(scriptPath, '// 本地验收只声明固定柱和台面，不改变运行逻辑。\nexport const dataDriven = ' + JSON.stringify(dataDriven, null, 2) + ' as const;\n');
    models.push(entity(id, type === 'lift' ? '提升机箭头验收' : '换层提升机箭头验收', {
      transform: transform(x), modelAsset: { assetCode: assetCodes[type], sourcePath: modelPath, sourceUrl: assetUrl(modelPath), lengthUnit: 'meter',
        unitScaleToMeters: 1, dataDrivenConfig: dataDriven, scriptAssets: [{ path: scriptPath, sourceUrl: assetUrl(scriptPath), name: path.basename(scriptPath) }] },
      telemetryBinding: { enabled: true, sourceId: 'default', deviceType: type, expectedIntervalMs: 150, staleAfterMs: 1200, cargoOriginDevice: false,
        ...(type === 'lift' ? { incomingLayerBindings: { '1': ['lift-input'], '2': ['lift-input-high'] }, outgoingLayerBindings: { '1': ['lift-output'] } } : { aisleCode: 'ARROW-A1' }) },
    }));
  }
  const conveyorPath = path.join(modelRoot, 'arrow-conveyor.glb'), conveyorScript = path.join(modelRoot, 'arrow-conveyor.model.ts');
  await writeFile(conveyorPath, source);
  const conveyorConfig = { device: { devType: 'conveyor' }, cargo: { nodes: ['VCConveyorBelt'] } };
  await writeFile(conveyorScript, 'export const dataDriven = ' + JSON.stringify(conveyorConfig) + ' as const;\n');
  const stations = [['lift-input', -5, .575], ['lift-input-high', -5, 4.575], ['lift-output', 0, .575]].map(([id, x, y]) => entity(id, id, {
    transform: transform(x, y), modelAsset: { assetCode: id, sourcePath: conveyorPath, sourceUrl: assetUrl(conveyorPath), lengthUnit: 'meter', unitScaleToMeters: 1,
      dataDrivenConfig: conveyorConfig, scriptAssets: [{ path: conveyorScript, sourceUrl: assetUrl(conveyorScript), name: path.basename(conveyorScript) }] },
    telemetryBinding: { enabled: true, sourceId: 'default', deviceType: 'conveyor', cargoOriginDevice: id === 'lift-input', surfaceArrows: { enabled: false } },
  }));
  const locator = entity('lift-arrow-locator', '换层站台', { transform: transform(2.5), locator: {
    assetId: 'HC-ARROW-SLOTS', storageDepth: 'near', length: 1, width: 1, height: 1, columns: 1, layers: 5, startColumn: -1, startLayer: 1,
    columnReversed: false, columnGap: 0, layerGap: 0, deviceAssetCode: assetCodes.hclift, aisleCode: 'ARROW-A1', rowNumber: 1,
    builtInBinding: { hostEntityId: hcId, rowIndex: 0, originOffset: { x: 0, y: 0, z: 0 }, kind: 'layerChangePlatform' },
  } });
  const light = entity('lift-arrow-light', '光源', { transform: transform(4, 8, -4), light: { lightKind: 'point', intensity: 1.5 } });
  const entities = [...models, ...stations, locator, light];
  return { version: 2, units: { length: 'meter' }, scene: { id: 'lift-arrows-scene', name: '提升机运动箭头验收',
    entityIds: entities.map(value => value.id), entities: Object.fromEntries(entities.map(value => [value.id, value])), selectedEntityId: liftId,
    mqttConfig: { enabled: true, ip: '', address: '', topic: 'dt/factory/logistics/+/+/twindatadriven/joint', simulatorEnabled: false } } };
}

/** 仅监听本测试创建的 loopback 端口，分别发送两类设备的 MQTT 数据。 */
export function createLiftBroker(server) {
  const broker = new WebSocketServer({ noServer: true }), clients = new Map(), errors = [];
  let fields = structuredClone(idleFields), publishing = true, sequence = 0, publications = 0;
  const conveyors = new Map();
  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/__lift_mqtt__') broker.handleUpgrade(request, socket, head, ws => broker.emit('connection', ws));
  });
  broker.on('connection', socket => {
    const state = { version: 4, subscribed: false }; clients.set(socket, state);
    const send = packet => { if (socket.readyState === 1) socket.send(mqttPacket.generate(packet, { protocolVersion: state.version })); };
    const parser = mqttPacket.parser(); socket.on('message', data => parser.parse(data)); socket.on('close', () => clients.delete(socket));
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
    for (const { type, assetCode, values } of [
      ...['lift', 'hclift'].map(type => ({ type, assetCode: assetCodes[type], values: fields[type] })),
      ...[...conveyors].map(([assetCode, values]) => ({ type: 'conveyor', assetCode, values })),
    ]) {
      const payload = Buffer.from(JSON.stringify({ seq: ++sequence, data: Object.entries(values).map(([p, v]) => ({ e: assetCode, p, v })) }));
      for (const [socket, state] of clients) if (state.subscribed && socket.readyState === 1) {
        socket.send(mqttPacket.generate({ cmd: 'publish', topic: `dt/factory/logistics/${type}/${assetCode}/twindatadriven/joint`, payload, qos: 0, retain: false, dup: false }, { protocolVersion: state.version })); publications++;
      }
    }
  }, 150);
  return { drive: (type, values) => { fields[type] = { ...idleFields[type], ...values }; publishing = true; }, driveConveyor: (assetCode, values) => {
      if (!['lift-input', 'lift-input-high', 'lift-output'].includes(assetCode)) throw new Error('未知的验收 conveyor：' + assetCode);
      conveyors.set(assetCode, { mode: 1, movement_x: 0, task: 0, normal: true, errorCode: 0, ...values }); publishing = true;
    }, pause: () => { publishing = false; }, errors,
    get publications() { return publications; }, close: async () => { clearInterval(ticker); for (const socket of clients.keys()) socket.terminate(); await new Promise(resolve => broker.close(resolve)); } };
}
