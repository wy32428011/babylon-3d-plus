import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { TelemetryBindingComponent } from '../../src/editor/model/telemetryBinding';
import {
  collectSpecializedTelemetryConflictKeys,
  resolveSpecializedTelemetryBinding,
  resolveSpecializedTelemetrySnapshot,
} from '../../src/runtime/babylon/telemetry/specializedTelemetryBinding';
import { DeviceTelemetryStore, type DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';

test('专用驱动按 sourceId/deviceType/assetCode 完整主键读取快照', () => {
  const store = new DeviceTelemetryStore();
  store.upsert(createSnapshot({ sourceId: 'default', fields: { speed: 1 } }));
  store.upsert(createSnapshot({ sourceId: 'line-a', fields: { speed: 2 } }));

  const resolved = resolveSpecializedTelemetryBinding({
    modelAssetCode: 'STK-01',
    deviceType: 'stacker',
    binding: createBinding({ sourceId: 'line-a' }),
  });

  assert.ok(resolved);
  assert.equal(resolved.key.includes('line-a'), true);
  assert.deepEqual(resolveSpecializedTelemetrySnapshot(store, resolved)?.fields, { speed: 2 });
});

test('专用驱动只把完全相同主键的多个模型判定为冲突', () => {
  const first = resolveSpecializedTelemetryBinding({
    modelAssetCode: 'STK-01',
    deviceType: 'stacker',
    binding: createBinding({ sourceId: 'line-a' }),
  });
  const duplicate = resolveSpecializedTelemetryBinding({
    modelAssetCode: 'STK-01',
    deviceType: 'stacker',
    binding: createBinding({ sourceId: 'line-a' }),
  });
  const otherSource = resolveSpecializedTelemetryBinding({
    modelAssetCode: 'STK-01',
    deviceType: 'stacker',
    binding: createBinding({ sourceId: 'line-b' }),
  });

  assert.ok(first);
  assert.ok(duplicate);
  assert.ok(otherSource);
  const conflicts = collectSpecializedTelemetryConflictKeys([first, duplicate, otherSource]);
  assert.deepEqual([...conflicts], [first.key]);
});

test('SceneRuntime 使用专用绑定解析器执行冲突检测和完整主键查询', () => {
  const source = readFileSync('src/runtime/babylon/SceneRuntime.ts', 'utf8');
  assert.match(source, /resolveSpecializedTelemetryBinding/);
  assert.match(source, /collectSpecializedTelemetryConflictKeys/);
  assert.match(source, /resolveSpecializedTelemetrySnapshot/);
});
test('SceneRuntime 只在所有专用驱动都无有效绑定时清理诊断', () => {
  const source = readFileSync('src/runtime/babylon/SceneRuntime.ts', 'utf8');
  const collectStart = source.indexOf('private collectSpecializedTelemetryModels');
  const collectEnd = source.indexOf('private resolveSpecializedTelemetryDeviceType', collectStart);
  const collectBlock = source.slice(collectStart, collectEnd);
  const applyStart = source.indexOf('private applyDeviceTelemetryFrame');
  const applyEnd = source.indexOf('private applyStackerTelemetryFrame', applyStart);
  const applyBlock = source.slice(applyStart, applyEnd);

  assert.doesNotMatch(collectBlock, /clearSpecializedTelemetryDiagnostics/);
  assert.match(source, /private clearInactiveSpecializedTelemetryDiagnostics/);
  assert.match(applyBlock, /clearInactiveSpecializedTelemetryDiagnostics/);
});
test('专用驱动尊重禁用状态并拒绝设备类型错配', () => {
  const disabled = resolveSpecializedTelemetryBinding({
    modelAssetCode: 'STK-01',
    deviceType: 'stacker',
    binding: createBinding({ enabled: false }),
  });
  const mismatched = resolveSpecializedTelemetryBinding({
    modelAssetCode: 'STK-01',
    deviceType: 'stacker',
    binding: createBinding({ deviceType: 'conveyor' }),
  });

  assert.equal(disabled, null);
  assert.equal(mismatched, null);
});

/** 创建专用驱动绑定测试数据。 */
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

test('SceneRuntime 按 Locator near/far 决定一段或两段货叉，并在目标缺失时禁止伸出', () => {
  const source = readFileSync('src/runtime/babylon/SceneRuntime.ts', 'utf8');
  assert.match(source, /resolveStackerStorageForkReach\(targetLocator\.storageDepth, reach\.stageOne, reach\.stageTwo\)/);
  assert.match(source, /snapshot\.hasTargetLocation[\s\S]*resolveTargetLocatorForkReach\(targetLocator, reach\) \?\? 0/);
  assert.match(source, /targetStorageDepth: targetLocator\?\.storageDepth \?\? null/);
  assert.match(source, /distanceX !== null && targetTravelOffset === null/);
  assert.match(source, /distanceY !== null && targetLiftOffset === null/);
});

test('Stacker 库位演示脚本不发送货叉距离，由 to_x to_y to_z 和 Locator 参数决定段数', () => {
  const publisher = readFileSync('scripts/publish-stacker-full-demo.mjs', 'utf8');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  const sequence = JSON.parse(readFileSync('examples/mqtt/stacker-full-demo-sequence.json', 'utf8')) as {
    locations: Array<{ assetId: string; storageDepth: string }>;
  };
  assert.doesNotMatch(publisher, /point\(assetCode, 'front_distance_z'/);
  assert.doesNotMatch(publisher, /point\(assetCode, 'back_distance_z'/);
  assert.doesNotMatch(publisher, /point\(assetCode, 'distance_x'/);
  assert.doesNotMatch(publisher, /point\(assetCode, 'distance_y'/);
  assert.match(publisher, /point\(assetCode, 'to_x'/);
  assert.equal(packageJson.scripts['demo:stacker:mqtt'], 'node scripts/publish-stacker-full-demo.mjs');
  assert.equal(packageJson.scripts['demo:stacker:mqtt:legacy'], 'node scripts/simulate-stacker-mqtt.mjs');
  assert.deepEqual(sequence.locations.map((location) => [location.assetId, location.storageDepth]), [
    ['1-1-1', 'near'],
    ['1-2-1', 'far'],
    ['2-1-1', 'near'],
    ['2-2-1', 'far'],
  ]);
});

test('Locator 库位资产编号重复时从目标索引移除并输出冲突日志', () => {
  const source = readFileSync('src/runtime/babylon/SceneRuntime.ts', 'utf8');
  assert.match(source, /this\.locatorTargets\.delete\(assetId\)/);
  assert.match(source, /库位资产编号冲突，已停止目标绑定/);
});

test('SceneRuntime 在任何 Stacker 遥测运动前捕获未运动的货叉世界锚点', () => {
  const source = readFileSync('src/runtime/babylon/SceneRuntime.ts', 'utf8');
  assert.match(
    source,
    /private captureReadyTelemetryPreviewBaselines[\s\S]*resolveSpecializedTelemetryDeviceType\(model\) === 'stacker'[\s\S]*getStackerTargetReferencePosition\(model\)/,
  );
  assert.match(
    source,
    /captureReadyTelemetryPreviewBaselines\(\);[\s\S]*applyStackerTelemetryFrame\(\);/,
  );
});
