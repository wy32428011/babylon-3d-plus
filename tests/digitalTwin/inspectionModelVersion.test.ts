import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DIGITAL_TWIN_BRIDGE_CHANNEL,
  parseDigitalTwinBridgeMessage,
  parseDigitalTwinInspectionMessage,
  type DigitalTwinModelVersionInspectionLoad,
} from '../../src/player/digitalTwinInteractionProtocol.ts';
import {
  resolveInspectionModelVersionUrl,
  validateSelfContainedInspectionAsset,
} from '../../src/inspection/inspectionModelVersionAsset.ts';

function loadMessage() {
  const payload: DigitalTwinModelVersionInspectionLoad = {
    loadId: 'load-v1', assetCode: 'PUMP-01', entityId: 'entity-1',
    inspection: {
      schemaVersion: 2, source: 'model-version', device: { deviceType: 'PUMP' },
      model: {
        modelId: '2052962163445780481', versionId: '2052962163445780482',
        fileUrl: 'https://platform.example/api/v1/files/models/pump-v1.glb',
        fileExtension: '.glb', unitScaleToMeters: 0.001,
      },
      parts: [{ partKey: 'motor', name: '电机', nodePath: 'Assembly/Motor',
        axis: { x: 1, y: 0, z: 0 }, distanceMeters: 0.5, fixed: false }],
    },
  };
  return { channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: 1, sessionId: 'session-1',
    type: 'command.inspectionLoadModelVersion', requestId: 'request-1', payload };
}

test('平台固定版本独立加载，只需设备类型且不混用旧包摘要', () => {
  const message = loadMessage();
  assert.deepEqual(parseDigitalTwinInspectionMessage(message), message);
  assert.equal(parseDigitalTwinBridgeMessage(message), null);
  assert.equal(parseDigitalTwinInspectionMessage({ ...message, type: 'command.inspectionLoad' }), null);
  assert.equal(parseDigitalTwinInspectionMessage({ ...message,
    payload: { ...message.payload, inspection: { ...message.payload.inspection, contentSha256: 'a'.repeat(64) } },
  }), null);
  message.payload.inspection.device.namespace = 'site';
  message.payload.inspection.device.deviceNo = '000001';
  assert.deepEqual(parseDigitalTwinInspectionMessage(message), message);
});

test('平台版本拒绝数值Long、超出Long、外部协议和无效零件规则', () => {
  const base = loadMessage();
  const mutations = [
    (m: any) => { m.payload.inspection.model.modelId = 2052962163445780481; },
    (m: any) => { m.payload.inspection.model.versionId = '9223372036854775808'; },
    (m: any) => { m.payload.inspection.model.fileUrl = 'file:///C:/models/pump.glb'; },
    (m: any) => { m.payload.inspection.model.fileUrl = 'https://user:password@platform.example/api/v1/files/a.glb'; },
    (m: any) => { m.payload.inspection.model.fileUrl = 'https://platform.example/uncontrolled/a.glb'; },
    (m: any) => { m.payload.inspection.parts = []; },
    (m: any) => { m.payload.inspection.parts.push({ ...m.payload.inspection.parts[0] }); },
    (m: any) => { m.payload.inspection.parts[0].axis = { x: 0, y: 0, z: 0 }; },
    (m: any) => { m.payload.inspection.parts[0].distanceMeters = -1; },
    (m: any) => { m.payload.inspection.parts[0].parentPartKey = 'motor'; },
    (m: any) => { m.payload.inspection.parts[0].parentPartKey = 'missing'; },
    (m: any) => { m.payload.inspection.parts[0].nodePath = 'Assembly/../Motor'; },
  ];
  for (const mutate of mutations) {
    const message = structuredClone(base);
    mutate(message);
    assert.equal(parseDigitalTwinInspectionMessage(message), null, mutate.toString());
  }
});

test('平台清单支持超过128项，保留完整装配关系', () => {
  const message = loadMessage();
  message.payload.inspection.parts = Array.from({ length: 600 }, (_, index) => ({
    partKey: `part-${index}`, name: `零件${index}`, nodePath: `Assembly/Part${index}`,
    axis: { x: 1, y: 0, z: 0 }, distanceMeters: 0.5, fixed: false,
  }));
  const parsed = parseDigitalTwinInspectionMessage(message);
  assert.equal(parsed?.type, 'command.inspectionLoadModelVersion');
  if (parsed?.type === 'command.inspectionLoadModelVersion') assert.equal(parsed.payload.inspection.parts.length, 600);
});

test('普通低模设备上下文与清空不需要inspection绑定', () => {
  const base = { channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: 1, sessionId: 'scene', type: 'event.deviceContext' };
  for (const context of [null, { assetCode: 'PUMP-01', entityId: 'e1', deviceType: 'PUMP' },
    { assetCode: 'PUMP-01', entityId: 'e1', deviceType: 'PUMP', parametersUnavailable: true },
    { assetCode: 'PUMP-01', entityId: 'e1', deviceType: 'PUMP', parameterValues: { width: 6, hasGuard: false } }]) {
    const message = { ...base, payload: { context, causeRequestId: 'focus-1' } };
    assert.deepEqual(parseDigitalTwinInspectionMessage(message), message);
  }
  for (const context of [
    { assetCode: 'PUMP-01', entityId: 'e1', deviceType: 12 },
    { assetCode: 'PUMP-01', entityId: 'e1', deviceNo: 123 },
    { assetCode: 'PUMP-01', entityId: 'e1', parameterValues: {}, parametersUnavailable: true },
    { assetCode: 'PUMP-01', entityId: 'e1', parameterValues: { huge: 'a'.repeat(65_536) } },
  ]) assert.equal(parseDigitalTwinInspectionMessage({ ...base, payload: { context } }), null);
});

test('设备点击校验已知身份字段，保留旧v1点击结构', () => {
  const base = { channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: 1, sessionId: 'scene', type: 'event.assetClicked' };
  const valid = { ...base, payload: { assetCode: 'PUMP-01', deviceType: 'PUMP', deviceNo: '0008' } };
  assert.deepEqual(parseDigitalTwinBridgeMessage(valid), valid);
  assert.equal(parseDigitalTwinBridgeMessage({ ...base, payload: { deviceType: 23 } }), null);
  assert.equal(parseDigitalTwinBridgeMessage({ ...base, payload: { parameterValues: [] } }), null);
});

test('平台资源地址限当前中台受控文件路径，不接受外部资源或票据', () => {
  const origin = 'https://platform.example';
  assert.equal(resolveInspectionModelVersionUrl(`${origin}/api/v1/files/a.glb`, origin), `${origin}/api/v1/files/a.glb`);
  for (const url of [
    'https://elsewhere.example/api/v1/files/a.glb', `${origin}/other/a.glb`,
    `${origin}/api/v1/files/../secret`, `${origin}/api/v1/files/%2fsecret`,
    `${origin}/api/v1/files/a.glb?ticket=x`, `${origin}/api/v1/files/a.glb#fragment`,
    'editor-asset://local/a.glb', 'file:///C:/model.glb',
  ]) assert.throws(() => resolveInspectionModelVersionUrl(url, origin));
});

test('自包含检查使用真实GLB字节并拒绝外部纹理与缓冲区', () => {
  const bytes = readFileSync(new URL('../fixtures/inspection/assembly-animation.glb', import.meta.url));
  assert.doesNotThrow(() => validateSelfContainedInspectionAsset(bytes, '.glb'));
  const gltf = (extra: object) => new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, ...extra }));
  assert.doesNotThrow(() => validateSelfContainedInspectionAsset(gltf({ buffers: [{ uri: 'data:application/octet-stream;base64,AAAA' }] }), '.gltf'));
  assert.throws(() => validateSelfContainedInspectionAsset(gltf({ buffers: [{ uri: 'buffer.bin' }] }), '.gltf'), /外部/);
  assert.throws(() => validateSelfContainedInspectionAsset(gltf({ images: [{ uri: 'https://elsewhere.example/tex.png' }] }), '.gltf'), /外部/);
  assert.throws(() => validateSelfContainedInspectionAsset(bytes.subarray(0, bytes.length - 1), '.glb'), /长度/);
  assert.throws(() => validateSelfContainedInspectionAsset(new Uint8Array([0xff]), '.gltf'), /JSON/);
});
