import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeModelDataDrivenConfig,
  normalizeTelemetryBindingComponent,
  type TelemetryBindingComponent,
  type TelemetryMotionChannel,
} from '../../src/editor/model/telemetryBinding';
import type { ModelAssetComponent } from '../../src/editor/model/components';
import {
  compileTelemetryMotionBinding,
  createTelemetryBindingKey,
} from '../../src/runtime/babylon/telemetry/motionBindingCompiler';
import {
  resolveSpecializedTelemetryBinding,
  resolveSpecializedTelemetrySnapshot,
} from '../../src/runtime/babylon/telemetry/specializedTelemetryBinding';
import { DeviceTelemetryStore, type DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';

test('normalizeTelemetryBindingComponent 将 deviceType 去空格并统一为小写', () => {
  const binding = normalizeTelemetryBindingComponent({
    enabled: true,
    sourceId: 'line-a',
    deviceType: ' Stacker ',
    expectedIntervalMs: 300,
  });

  assert.equal(binding?.deviceType, 'stacker');
});

test('模型 dataDriven devType 在导入配置边界统一为小写', () => {
  const config = normalizeModelDataDrivenConfig({
    device: { devType: ' StAcKeR ' },
    motion: {},
    fixedNodes: [],
  });

  assert.equal(config?.device.devType, 'stacker');
});

test('createTelemetryBindingKey 将空白 sourceId 防御性归一为 default', () => {
  assert.equal(
    createTelemetryBindingKey('   ', ' Stacker ', 'STK-01'),
    ['default', 'stacker', 'STK-01'].join('\u0000'),
  );
});
test('createTelemetryBindingKey 只归一 sourceId 和 deviceType，保留 assetCode 大小写语义', () => {
  const upperAssetKey = createTelemetryBindingKey(' line-a ', ' Stacker ', 'Stk-01');
  const lowerAssetKey = createTelemetryBindingKey('line-a', 'stacker', 'stk-01');

  assert.equal(upperAssetKey, ['line-a', 'stacker', 'Stk-01'].join('\u0000'));
  assert.notEqual(upperAssetKey, lowerAssetKey);
});

test('专用 resolver 接受混合大小写绑定并查询小写 deviceType store', () => {
  const store = new DeviceTelemetryStore();
  store.upsert(createSnapshot({ deviceType: 'stacker', sourceId: 'line-a', fields: { speed: 2 } }));

  const resolved = resolveSpecializedTelemetryBinding({
    modelAssetCode: 'STK-01',
    deviceType: 'stacker',
    binding: createBinding({ sourceId: ' line-a ', deviceType: ' Stacker ' }),
  });

  assert.ok(resolved);
  assert.equal(resolved.deviceType, 'stacker');
  assert.equal(resolved.sourceId, 'line-a');
  assert.deepEqual(resolveSpecializedTelemetrySnapshot(store, resolved)?.fields, { speed: 2 });
});

test('Stacker 和 stacker 两个通用绑定生成同一冲突 key', () => {
  const upperBinding = compileTelemetryMotionBinding({
    entityId: 'upper',
    modelAsset: createModelAsset(),
    binding: createBinding({ sourceId: ' line-a ', deviceType: 'Stacker' }),
    externalDataDrivenConfigs: [],
  });
  const lowerBinding = compileTelemetryMotionBinding({
    entityId: 'lower',
    modelAsset: createModelAsset(),
    binding: createBinding({ sourceId: 'line-a', deviceType: 'stacker' }),
    externalDataDrivenConfigs: [],
  });

  assert.ok(upperBinding);
  assert.ok(lowerBinding);
  assert.equal(upperBinding.key, lowerBinding.key);
});

/** 创建包含最小运动通道的模型资产，确保通用绑定编译能生成 key。 */
function createModelAsset(): ModelAssetComponent {
  return {
    assetCode: 'STK-01',
    sourcePath: 'fixtures/stacker.glb',
    sourceUrl: 'fixtures/stacker.glb',
    lengthUnit: 'meter',
    unitScaleToMeters: 1,
    dataDrivenConfig: {
      device: { devType: 'stacker', interpolationMs: 200 },
      motion: { x: createMotionChannel() },
      fixedNodes: [],
    },
  };
}

/** 创建标准遥测绑定测试数据，按用例覆盖关键字段。 */
function createBinding(overrides: Partial<TelemetryBindingComponent> = {}): TelemetryBindingComponent {
  return {
    enabled: true,
    sourceId: 'default',
    deviceType: 'stacker',
    assetCode: 'STK-01',
    expectedIntervalMs: 500,
    staleAfterMs: 2000,
    channelOverrides: {},
    ...overrides,
  };
}

/** 创建最小绝对位移通道，保证绑定编译不会被空 motion 丢弃。 */
function createMotionChannel(): TelemetryMotionChannel {
  return {
    channel: 'x',
    fields: ['x'],
    mode: 'absolute',
    target: { kind: 'root' },
    property: 'position',
    axis: 'x',
    space: 'local',
    scale: 1,
    offset: 0,
    invert: false,
  };
}

/** 创建只包含绑定关键字段的遥测快照。 */
function createSnapshot(overrides: Partial<DeviceTelemetrySnapshot> = {}): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'stacker',
    assetCode: 'STK-01',
    payloadDeviceCode: 'STK-01',
    sourceTimestamp: null,
    sequence: 1,
    receivedAt: 1000,
    fields: {},
    currentLocationKey: null,
    targetLocationKey: null,
    hasTargetLocation: false,
    faulted: false,
    message: '',
    ...overrides,
  };
}
