import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DIGITAL_TWIN_BRIDGE_CHANNEL,
  DIGITAL_TWIN_BRIDGE_VERSION,
  DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY,
  DIGITAL_TWIN_HARDWARE_GPU_CAPABILITY,
  DIGITAL_TWIN_START_AUTO_PATROL_CAPABILITY,
  DIGITAL_TWIN_START_MANUAL_ROAM_CAPABILITY,
  DIGITAL_TWIN_VIEWER_ERROR_CODES,
  parseDigitalTwinBridgeMessage,
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
  assert.equal(DIGITAL_TWIN_START_AUTO_PATROL_CAPABILITY, 'startAutoPatrol');
  assert.equal(DIGITAL_TWIN_START_MANUAL_ROAM_CAPABILITY, 'startManualRoam');
});

test('v1 协议解析自动巡检、手动漫游命令及无资产结果', () => {
  for (const action of ['startAutoPatrol', 'startManualRoam'] as const) {
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
