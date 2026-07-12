import assert from 'node:assert/strict';
import test from 'node:test';

import * as stackerStorageLocation from '../../src/runtime/babylon/telemetry/stackerStorageLocation';

test('近排库位只允许第一段货叉行程', () => {
  assert.equal(stackerStorageLocation.resolveStackerStorageForkReach('near', 0.8, 0.8), 0.8);
});

test('远排库位允许第一段与第二段货叉总行程', () => {
  assert.equal(stackerStorageLocation.resolveStackerStorageForkReach('far', 0.8, 0.8), 1.6);
});

test('非法或负数货叉行程按 0 防御，不扩大运行范围', () => {
  assert.equal(stackerStorageLocation.resolveStackerStorageForkReach('near', Number.NaN, 0.8), 0);
  assert.equal(stackerStorageLocation.resolveStackerStorageForkReach('far', -1, Number.POSITIVE_INFINITY), 0);
});


test('目标库位世界坐标必须相对货叉初始锚点换算行走与升降偏移', () => {
  const resolver = (stackerStorageLocation as unknown as {
    resolveStackerStorageTargetOffsets?: (input: {
      targetTravelCoordinate: number;
      targetLiftCoordinate: number;
      referenceTravelCoordinate: number;
      referenceLiftCoordinate: number;
    }) => { travelOffset: number; liftOffset: number };
  }).resolveStackerStorageTargetOffsets;

  assert.equal(typeof resolver, 'function');
  const offsets = resolver!({
    targetTravelCoordinate: 4,
    targetLiftCoordinate: 1.2,
    referenceTravelCoordinate: -7.8385433618,
    referenceLiftCoordinate: 0.8921632311,
  });
  assert.ok(Math.abs(offsets.travelOffset - 11.8385433618) < 1e-9);
  assert.ok(Math.abs(offsets.liftOffset - 0.3078367689) < 1e-9);
});
