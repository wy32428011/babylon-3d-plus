import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';
import {
  readConveyorCargoSignalFields,
  readConveyorCargoTravelConfig,
} from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import { CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND } from '../../src/runtime/babylon/telemetry/specialized/types';

/** 最小模型桩：reader 只消费 externalScriptRuntime.getDataDrivenConfigs()。 */
function createModelStub(dataDriven?: unknown): ModelRuntimeEntry {
  return {
    externalScriptRuntime: dataDriven === undefined
      ? null
      : { getDataDrivenConfigs: () => [dataDriven] },
  } as unknown as ModelRuntimeEntry;
}

test('cargo.travel 完整声明按原值归一化', () => {
  const config = readConveyorCargoTravelConfig(createModelStub({
    device: { devType: 'conveyor' },
    cargo: {
      travel: {
        axis: 'z',
        speed: 0.5,
        nodes: ['GT.3', 'Ban.4'],
        fallbackPattern: 'GT|辊',
        fields: ['movement_y'],
        actionMap: { '0': 0, '1': -1, '2': 1 },
      },
    },
  }));

  assert.deepEqual(config, {
    axis: 'z',
    speed: 0.5,
    nodes: ['GT.3', 'Ban.4'],
    fallbackPattern: 'GT|辊',
    fields: ['movement_y'],
    actionMap: { '0': 0, '1': -1, '2': 1 },
  });
});

test('cargo 缺失或 devType 非 conveyor 时走全缺省', () => {
  const expected = {
    axis: 'x',
    speed: CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND,
    nodes: [],
    fallbackPattern: null,
    fields: ['movement_x'],
    actionMap: { '0': 0, '1': 1, '2': -1 },
  };

  assert.deepEqual(readConveyorCargoTravelConfig(createModelStub()), expected);
  assert.deepEqual(readConveyorCargoTravelConfig(createModelStub({ device: { devType: 'conveyor' } })), expected);
  assert.deepEqual(readConveyorCargoTravelConfig(createModelStub({
    device: { devType: 'stacker' },
    cargo: { travel: { axis: 'z', speed: 9 } },
  })), expected);
});

test('cargo.travel 部分声明逐键回退，非法 speed/axis 被拒', () => {
  const config = readConveyorCargoTravelConfig(createModelStub({
    device: { devType: 'conveyor' },
    cargo: { travel: { axis: 'y', speed: -1, nodes: ['GT'] } },
  }));

  assert.equal(config.axis, 'x');
  assert.equal(config.speed, CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND);
  assert.deepEqual(config.nodes, ['GT']);
  assert.deepEqual(config.fields, ['movement_x']);
});

test('光电字段从顶层 cargo 读取，缺省回退 front_has_goods/back_has_goods', () => {
  assert.deepEqual(readConveyorCargoSignalFields(createModelStub({
    device: { devType: 'conveyor' },
    cargo: { frontHasGoodsField: 'front_sensor', backHasGoodsField: 'back_sensor' },
  })), { frontHasGoods: 'front_sensor', backHasGoods: 'back_sensor' });

  assert.deepEqual(readConveyorCargoSignalFields(createModelStub({
    device: { devType: 'conveyor' },
    cargo: { travel: { axis: 'x' } },
  })), { frontHasGoods: 'front_has_goods', backHasGoods: 'back_has_goods' });
});
