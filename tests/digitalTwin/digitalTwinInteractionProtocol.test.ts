import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DIGITAL_TWIN_BRIDGE_CHANNEL,
  DIGITAL_TWIN_BRIDGE_VERSION,
  DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY,
  DIGITAL_TWIN_GLOBAL_OVERVIEW_CAPABILITY,
  DIGITAL_TWIN_HARDWARE_GPU_CAPABILITY,
  DIGITAL_TWIN_START_AUTO_PATROL_CAPABILITY,
  DIGITAL_TWIN_START_MANUAL_ROAM_CAPABILITY,
  DIGITAL_TWIN_VIEWER_ERROR_CODES,
  parseDigitalTwinBridgeMessage,
  parseDigitalTwinInspectionMessage,
  getInspectionDataIssue,
} from '../../src/player/digitalTwinInteractionProtocol.ts';

type ContractFixture = {
  fixtureVersion: number;
  protocolVersion: number;
  channel: string;
  viewerErrorCodes: string[];
  valid: Array<{ name: string; message: unknown }>;
  invalid: Array<{ name: string; message: unknown }>;
};

const fixture = JSON.parse(readFileSync(new URL('../fixtures/digitalTwinInteraction.v1.json', import.meta.url), 'utf8')) as ContractFixture;

test('Viewer 协议常量与 v1 合同夹具保持一致', () => {
  assert.equal(fixture.fixtureVersion, 1);
  assert.equal(fixture.protocolVersion, DIGITAL_TWIN_BRIDGE_VERSION);
  assert.equal(fixture.channel, DIGITAL_TWIN_BRIDGE_CHANNEL);
  assert.deepEqual(fixture.viewerErrorCodes, [...DIGITAL_TWIN_VIEWER_ERROR_CODES]);
  assert.equal(DIGITAL_TWIN_HARDWARE_GPU_CAPABILITY, 'hardwareGpu');
  assert.equal(DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY, 'focusAsset');
  assert.equal(DIGITAL_TWIN_GLOBAL_OVERVIEW_CAPABILITY, 'globalOverview');
  assert.equal(DIGITAL_TWIN_START_AUTO_PATROL_CAPABILITY, 'startAutoPatrol');
  assert.equal(DIGITAL_TWIN_START_MANUAL_ROAM_CAPABILITY, 'startManualRoam');
});

test('v1 协议解析全局概览、自动巡检、手动漫游命令及无资产结果', () => {
  for (const action of ['globalOverview', 'startAutoPatrol', 'startManualRoam'] as const) {
    const command = {
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: 'session',
      type: `command.${action}`,
      requestId: `request-${action}`,
    };
    assert.deepEqual(parseDigitalTwinBridgeMessage(command), command);

    const result = {
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: 'session',
      type: 'command.result',
      requestId: `request-${action}`,
      ok: true,
      payload: { action },
    };
    assert.deepEqual(parseDigitalTwinBridgeMessage(result), result);
  }
});

test('v1 合同中的合法消息均可严格解析', () => {
  for (const entry of fixture.valid) {
    assert.deepEqual(parseDigitalTwinBridgeMessage(entry.message), entry.message, entry.name);
  }
});

test('v1 合同中的非法消息均被拒绝', () => {
  for (const entry of fixture.invalid) {
    assert.equal(parseDigitalTwinBridgeMessage(entry.message), null, entry.name);
  }
});

test('协议解析器拒绝超长标识、资产编号和错误消息', () => {
  assert.equal(parseDigitalTwinBridgeMessage({
    channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
    version: DIGITAL_TWIN_BRIDGE_VERSION,
    sessionId: 's'.repeat(257),
    type: 'host.hello',
  }), null);

  assert.equal(parseDigitalTwinBridgeMessage({
    channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
    version: DIGITAL_TWIN_BRIDGE_VERSION,
    sessionId: 'session',
    type: 'command.focusAsset',
    requestId: 'request',
    payload: { assetCode: 'A'.repeat(129) },
  }), null);

  assert.equal(parseDigitalTwinBridgeMessage({
    channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
    version: DIGITAL_TWIN_BRIDGE_VERSION,
    sessionId: 'session',
    type: 'command.result',
    requestId: 'request',
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'x'.repeat(1025) },
  }), null);
});


test('主题展示只传递有界项目和大屏标识，拒绝 URL 和多余字段', () => {
  const base = { channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
    sessionId: 'session', type: 'viewer.showScreen', payload: { projectId: '1', screenId: '3' } };
  assert.deepEqual(parseDigitalTwinBridgeMessage(base), base);
  for (const payload of [
    { projectId: '1' }, { projectId: '1', screenId: '' },
    { projectId: '1', screenId: 3 }, { projectId: ' '.repeat(3), screenId: '3' },
    { projectId: '1'.repeat(65), screenId: '3' }, { projectId: '1', screenId: '3'.repeat(129) },
    { ...base.payload, screenUrl: 'https://unexpected.example' },
  ]) assert.equal(parseDigitalTwinBridgeMessage({ ...base, payload }), null);
  assert.equal(parseDigitalTwinBridgeMessage({ ...base, requestId: 'unexpected' }), null);
});

test('点击扩展支持无资产编号的生成单元并保持类型与安全边界', () => {
  const base = { channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION, sessionId: 'session', type: 'event.assetClicked' };
  for (const payload of [
    { unit: { kind: 'cargo', containerCode: 'BOX-001' }, host: { entityId: 'carrier', assetCode: '001005' } },
    { slot: { row: 0, column: 2, layer: 3 }, business: { enabled: false, count: 0, tags: ['A'] } },
    { assetCode: '001005', entityId: 'entity-1' },
  ]) assert.deepEqual(parseDigitalTwinBridgeMessage({ ...base, payload }), { ...base, payload });
  for (const payload of [
    { unit: { kind: 'unknown' } },
    { unit: { kind: ['cargo'] } },
    { host: { entityId: 1 } },
    { business: { value: Number.NaN } },
    { business: 'x'.repeat(16_385) },
    JSON.parse('{"business":{"__proto__":{"polluted":true}}}'),
  ]) assert.equal(parseDigitalTwinBridgeMessage({ ...base, payload }), null);
});

test('取消选择协议携带选择标记且严格校验命令和回执', () => {
  const base = { channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION, sessionId: 'session' };
  const command = { ...base, type: 'command.clearSelection', requestId: 'close-1', payload: { selectionToken: 'selection-1' } };
  assert.deepEqual(parseDigitalTwinBridgeMessage(command), command);
  for (const selectionToken of ['', ' ', 1, 'x'.repeat(257), null]) {
    assert.equal(parseDigitalTwinBridgeMessage({ ...command, payload: { selectionToken } }), null);
  }
  assert.equal(parseDigitalTwinBridgeMessage({ ...command, payload: { ...command.payload, unexpected: true } }), null);
  for (const cleared of [true, false]) {
    const result = { ...base, type: 'command.result', requestId: 'close-1', ok: true, payload: { action: 'clearSelection', cleared } };
    assert.deepEqual(parseDigitalTwinBridgeMessage(result), result);
    assert.equal(parseDigitalTwinBridgeMessage({ ...result, payload: { action: 'clearSelection' } }), null);
    assert.equal(parseDigitalTwinBridgeMessage({ ...result, payload: { action: 'clearSelection', cleared: 1 } }), null);
  }
  const screen = { ...base, type: 'viewer.showScreen', payload: { projectId: '1', screenId: '2', selectionToken: 'selection-1' } };
  assert.deepEqual(parseDigitalTwinBridgeMessage(screen), screen);
  assert.equal(parseDigitalTwinBridgeMessage({ ...screen, payload: { ...screen.payload, selectionToken: '' } }), null);
});


test('巡检扩展独立于 v1 能力握手，并校验固定版本和设备身份', () => {
  const envelope = { channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: 1, sessionId: 's' };
  const ready = { ...envelope, type: 'viewer.inspectionReady', requestId: 'r', payload: { role: 'detail', capabilities: ['inspectionLoad', 'selectPart'] } };
  assert.deepEqual(parseDigitalTwinInspectionMessage(ready), ready);
  assert.equal(parseDigitalTwinBridgeMessage(ready), null);
  assert.equal(parseDigitalTwinInspectionMessage({ ...ready, payload: { ...ready.payload, capabilities: ['unknown'] } }), null);
  assert.equal(parseDigitalTwinBridgeMessage({ ...envelope, type: 'viewer.ready', payload: { capabilities: ['inspectionLoad'] } }), null);
  const open = { ...envelope, type: 'command.openInspectionAsset', requestId: 'open', payload: { assetCode: 'A', entityId: 'e' } };
  assert.deepEqual(parseDigitalTwinInspectionMessage(open), open);
  assert.equal(parseDigitalTwinBridgeMessage(open), null);
  assert.equal(parseDigitalTwinInspectionMessage({ ...open, payload: { ...open.payload, partKey: 'unexpected' } }), null);
  const inspection = {
    schemaVersion: 1, device: { namespace: 'tenant', deviceType: 'pump', deviceNo: '0005' },
    model: { dataPlatformModel: { sourceKey: 'server', kind: 'model', resourceId: '2051942646011785218', modelPath: 'pump.glb' },
      versionId: '2051942646011785219', contentSha256: 'a'.repeat(64), sourcePath: 'pump.glb',
      sourceUrl: 'editor-asset://pump.glb', metaPath: 'meta.json', metaUrl: 'editor-asset://meta.json', unitScaleToMeters: 1 },
    configuration: { id: 'fixed', parameters: {} }, parts: [],
  };
  const load = { ...envelope, type: 'command.inspectionLoad', requestId: 'load', payload: { loadId: 'generation-1', assetCode: 'ASSET-01', entityId: 'entity', inspection } };
  assert.deepEqual(parseDigitalTwinInspectionMessage(load), load);
  assert.equal(parseDigitalTwinInspectionMessage({ ...load, payload: { ...load.payload, inspection: { ...inspection, device: undefined } } }), null);
  assert.equal(parseDigitalTwinInspectionMessage({ ...load, payload: { ...load.payload, inspection: { ...inspection, model: { ...inspection.model, versionId: 2051942646011785219 } } } }), null);
  const closed = { ...envelope, type: 'event.inspectionClosed', payload: { loadId: 'generation-1', assetCode: 'ASSET-01' } };
  assert.deepEqual(parseDigitalTwinInspectionMessage(closed), closed);
  assert.equal(parseDigitalTwinInspectionMessage({ ...closed, payload: { ...closed.payload, progress: 0.5 } }), null);
});

test('巡检协议支持一万零件并对超出容量及因果字段严格限界', () => {
  const envelope = { channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: 1, sessionId: 's' };
  const identity = { loadId: 'load', assetCode: 'A' };
  const inspection = {
    schemaVersion: 1, device: { namespace: 'tenant', deviceType: 'pump', deviceNo: '0005' },
    model: { dataPlatformModel: { sourceKey: 's', kind: 'model', resourceId: '1', modelPath: 'a.glb' },
      versionId: '2', contentSha256: 'a'.repeat(64), sourcePath: 'a.glb', sourceUrl: 'editor-asset://a.glb',
      metaPath: 'meta.json', metaUrl: 'editor-asset://meta.json', unitScaleToMeters: 1 },
    configuration: { id: 'fixed', parameters: {} },
    parts: Array.from({ length: 10_000 }, (_, index) => ({ partKey: `p${index}`, name: `part${index}`,
      nodePath: `node${index}`, axis: { x: 0, y: 1, z: 0 }, distanceMeters: 1, fixed: false })),
  };
  const load = { ...envelope, type: 'command.inspectionLoad', requestId: 'r', payload: { ...identity, entityId: 'e', inspection } };
  assert.equal(parseDigitalTwinInspectionMessage(load)?.type, 'command.inspectionLoad');
  assert.equal(getInspectionDataIssue({ ...inspection, parts: [...inspection.parts, inspection.parts[0]] }), 'budget');
  const oversized = { ...inspection, parts: inspection.parts.map((part, index) => ({ ...part, nodePath: `${'n'.repeat(1900)}${index}` })) };
  assert.equal(getInspectionDataIssue(oversized), 'budget');
  const selected = { ...envelope, type: 'event.inspectionPartSelected', payload: { ...identity, partKey: 'p1', causeRequestId: 'request' } };
  assert.deepEqual(parseDigitalTwinInspectionMessage(selected), selected);
  assert.equal(parseDigitalTwinInspectionMessage({ ...selected, payload: { ...selected.payload, causeRequestId: '' } }), null);
  const cancel = { ...envelope, type: 'command.inspectionCancelSelect', payload: identity };
  assert.deepEqual(parseDigitalTwinInspectionMessage(cancel), cancel);
  assert.equal(parseDigitalTwinInspectionMessage({ ...cancel, requestId: 'extra' }), null);
});
