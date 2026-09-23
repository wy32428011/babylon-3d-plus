import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import mqttPacket from 'mqtt-packet';
export { countCyanPixels } from './stackerMotionArrowFixture.mjs';

export const rgvId = 'rgv-arrow-fixture', assetCode = 'RGV-ARROW-FIXTURE';
export const channels = ['travel', 'front', 'back'];
export const nodeNames = { travel: 'RgvRails', front: 'RgvFrontDeck', back: 'RgvBackDeck' };
export const idleFields = { mode: 1, go_column: 0, front_y: 1, back_y: 3, front_command: 0, back_command: 0,
  front_movement_z: 0, back_movement_z: 0, front_task: 11, back_task: 12, normal: true, errorCode: 0 };

/** 三维夹具明确声明双轨与双台面，避免依赖业务模型包或现场数据。 */
export async function createRgvFixture(output) {
  const modelRoot = path.join(output, 'model'); await mkdir(modelRoot, { recursive: true });
  const source = await readFile('public/builtin-model-packages/virtual-conveyor/virtual-conveyor.glb');
  const jsonLength = source.readUInt32LE(12), json = JSON.parse(source.subarray(20, 20 + jsonLength).toString());
  const binary = source.subarray(28 + jsonLength);
  const box = (name, x, y, z, width, height, depth) => ({ name, mesh: 0, translation: [x, y, z], scale: [width, height / .05, depth] });
  json.nodes = [
    { name: 'RgvRails', children: [1, 2] },
    box('RgvRailLeft', -.8, 0, 0, .16, .16, 16), box('RgvRailRight', .8, 0, 0, .16, .16, 16),
    box('RgvBody', 0, .2, 0, 1.9, .4, 3),
    box('RgvFrontDeck', 0, .65, .85, 1.8, .12, 1.25), box('RgvBackDeck', 0, .65, -.85, 1.8, .12, 1.25),
  ];
  json.scenes = [{ nodes: [0, 3, 4, 5] }];
  json.materials[0].pbrMetallicRoughness.baseColorFactor = [.37, .39, .43, 1];
  const encoded = Buffer.from(JSON.stringify(json)), jsonChunk = Buffer.concat([encoded, Buffer.from(' '.repeat((4 - encoded.length % 4) % 4))]);
  const result = Buffer.alloc(28 + jsonChunk.length + binary.length);
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonChunk.length, 12); result.writeUInt32LE(0x4e4f534a, 16); jsonChunk.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + jsonChunk.length); result.writeUInt32LE(0x004e4942, 24 + jsonChunk.length); binary.copy(result, 28 + jsonChunk.length);
  const modelPath = path.join(modelRoot, 'arrow-rgv.glb'), scriptPath = path.join(modelRoot, 'arrow-rgv.model.ts');
  const dataDriven = { device: { devType: 'rgv', defaultAssetCode: assetCode }, fixedNodes: ['RgvRails'],
    motion: { travel: { nodes: ['RgvBody', 'RgvFrontDeck', 'RgvBackDeck'], speed: .8 } },
    cargo: { frontNodes: ['RgvFrontDeck'], backNodes: ['RgvBackDeck'] } };
  await writeFile(modelPath, result);
  await writeFile(scriptPath, '// 本地验收声明固定轨道与载货面，不改写设备动作。\nexport const dataDriven = ' + JSON.stringify(dataDriven, null, 2) + ' as const;\n');
  const transform = (x = 0, y = 0, z = 0, scale = { x: 1, y: 1, z: 1 }) => ({ position: { x, y, z }, rotation: { x: 0, y: 0, z: 0 }, scale });
  const entity = (id, name, components) => ({ id, name, visible: true, locked: false, parentId: null, childrenIds: [], components });
  const assetUrl = file => 'editor-asset://local/' + encodeURIComponent(file);
  const model = entity(rgvId, 'RGV 运动箭头验收', { transform: transform(), modelAsset: { assetCode, sourcePath: modelPath,
    sourceUrl: assetUrl(modelPath), lengthUnit: 'meter', unitScaleToMeters: 1, dataDrivenConfig: dataDriven,
    scriptAssets: [{ path: scriptPath, sourceUrl: assetUrl(scriptPath), name: path.basename(scriptPath) }] },
    telemetryBinding: { enabled: true, sourceId: 'default', deviceType: 'rgv', expectedIntervalMs: 150, staleAfterMs: 1200, cargoOriginDevice: false,
      columnBindings: { '1': ['rgv-column-1'], '2': ['rgv-column-2'], '3': ['rgv-column-3'], '4': ['rgv-column-4'] } } });
  const stations = [[3, .85], [-3, 4.85], [3, -.85], [-3, 3.15]].map(([x, z], index) => entity('rgv-column-' + (index + 1), '接驳位 ' + (index + 1), {
    transform: transform(x, .65, z, { x: 1.8, y: .2, z: 1.2 }), meshRenderer: { meshKind: 'cube', materialColor: '#777777' },
  }));
  const light = entity('rgv-arrow-light', '验收光源', { transform: transform(4, 8, -4), light: { lightKind: 'point', intensity: 1.5 } });
  const entities = [model, ...stations, light];
  return { version: 2, units: { length: 'meter' }, scene: { id: 'rgv-arrows-scene', name: 'RGV 运动箭头验收',
    entityIds: entities.map(item => item.id), entities: Object.fromEntries(entities.map(item => [item.id, item])), selectedEntityId: rgvId,
    mqttConfig: { enabled: true, ip: '', address: '', topic: 'dt/factory/logistics/rgv/+/twindatadriven/joint', simulatorEnabled: false } } };
}

/** 仅监听测试自己的 loopback WebSocket 服务。 */
export function createRgvBroker(server) {
  const broker = new WebSocketServer({ noServer: true }), clients = new Map(), errors = [];
  let fields = { ...idleFields }, publishing = true, sequence = 0, publications = 0;
  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/__rgv_mqtt__') broker.handleUpgrade(request, socket, head, ws => broker.emit('connection', ws));
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
      socket.send(mqttPacket.generate({ cmd: 'publish', topic: `dt/factory/logistics/rgv/${assetCode}/twindatadriven/joint`, payload, qos: 0, retain: false, dup: false }, { protocolVersion: state.version })); publications++;
    }
  }, 150);
  return { drive: values => { fields = { ...idleFields, ...values }; publishing = true; }, pause: () => { publishing = false; }, errors,
    get publications() { return publications; }, close: async () => { clearInterval(ticker); for (const socket of clients.keys()) socket.terminate(); await new Promise(resolve => broker.close(resolve)); } };
}
