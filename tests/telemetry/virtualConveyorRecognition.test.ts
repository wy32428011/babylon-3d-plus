import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModelAssetComponent } from '../../src/editor/model/components';
import {
  isSpecializedTelemetryDeviceType,
  normalizeModelDataDrivenConfig,
} from '../../src/editor/model/telemetryBinding';
import {
  isConveyorModelAsset,
  readConveyorCargoTravelConfig,
} from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';
import { CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND } from '../../src/runtime/babylon/telemetry/specialized/types';

/** 虚拟输送线模型包声明的 dataDriven（与 meta.json / virtual-conveyor.model.ts 保持一致）。 */
const VIRTUAL_CONVEYOR_DATA_DRIVEN = {
  device: { devType: 'conveyor', defaultAssetCode: 'VirtualConveyor' },
  cargo: { travel: { axis: 'x', speed: 0.3, nodes: [] } },
};

/** 演示场景 A 机 modelAsset 的最小形状。 */
function createVirtualConveyorModelAsset(): ModelAssetComponent {
  return {
    assetCode: 'VirtualConveyor-A',
    sourcePath: 'C:\\Projects\\babylon-3d-plus\\public\\builtin-model-packages\\virtual-conveyor\\virtual-conveyor.glb',
    sourceUrl: 'editor-asset://local/C%3A%5CProjects%5Cbabylon-3d-plus%5Cpublic%5Cbuiltin-model-packages%5Cvirtual-conveyor%5Cvirtual-conveyor.glb',
    lengthUnit: 'meter',
    unitScaleToMeters: 1,
  } as unknown as ModelAssetComponent;
}

/** 最小模型桩：reader 只消费 externalScriptRuntime.getDataDrivenConfigs()。 */
function createModelStub(dataDriven?: unknown): ModelRuntimeEntry {
  return {
    externalScriptRuntime: dataDriven === undefined
      ? null
      : { getDataDrivenConfigs: () => [dataDriven] },
  } as unknown as ModelRuntimeEntry;
}

test('assetCode 含 conveyor 即命中输送线能力识别', () => {
  assert.equal(isConveyorModelAsset(createVirtualConveyorModelAsset()), true);
  assert.equal(
    isConveyorModelAsset({ ...createVirtualConveyorModelAsset(), assetCode: 'VC-1001', sourcePath: 'x.glb', sourceUrl: 'editor-asset://local/x.glb' } as unknown as ModelAssetComponent),
    false,
    '编号与路径都不含输送线签名时不应误判',
  );
  assert.equal(
    isConveyorModelAsset({ assetCode: 'DDJ2', sourcePath: 'F:\\3d-models\\Stacker.glb', sourceUrl: 'editor-asset://local/F%3A%5C3d-models%5CStacker.glb' } as unknown as ModelAssetComponent),
    false,
    '堆垛机模型不应命中输送线',
  );
});

test('devType=conveyor 是 specialized 设备类型，解锁 Inspector 绑定区门控', () => {
  assert.equal(isSpecializedTelemetryDeviceType('conveyor'), true);
});

test('normalizeModelDataDrivenConfig 对 specialized devType 原样透传 cargo 配置', () => {
  const normalized = normalizeModelDataDrivenConfig(VIRTUAL_CONVEYOR_DATA_DRIVEN);
  assert.equal(normalized?.device.devType, 'conveyor');
  assert.equal(normalized?.device.defaultAssetCode, 'VirtualConveyor');
  assert.deepEqual(normalized?.cargo, VIRTUAL_CONVEYOR_DATA_DRIVEN.cargo);
});

test('虚拟输送线 cargo.travel 读取：nodes 留空时字段/动作映射走默认兜底', () => {
  const config = readConveyorCargoTravelConfig(createModelStub(VIRTUAL_CONVEYOR_DATA_DRIVEN));
  assert.equal(config.axis, 'x');
  assert.equal(config.speed, 0.3);
  assert.deepEqual(config.nodes, []);
  assert.deepEqual(config.fields, ['movement_x']);
  assert.deepEqual(config.actionMap, { 0: 0, 1: 1, 2: -1 });
});

test('脚本 dataDriven 缺失时速度回退默认值且不报错', () => {
  const config = readConveyorCargoTravelConfig(createModelStub(undefined));
  assert.equal(config.speed, CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND);
  assert.deepEqual(config.fields, ['movement_x']);
});
