import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLocatorBoxIndex, resolveStackerStorageForkReach, resolveStackerStorageTargetOffsets } from '../../src/runtime/babylon/telemetry/stackerStorageLocation';

test('近排库位只允许一段货叉行程，远排允许一段+二段', () => {
  assert.equal(resolveStackerStorageForkReach('near', 0.8, 0.8), 0.8);
  assert.equal(resolveStackerStorageForkReach('far', 0.8, 0.8), 1.6);
});

test('非法货叉行程参数防御为 0', () => {
  assert.equal(resolveStackerStorageForkReach('near', -1, Infinity), 0);
  assert.equal(resolveStackerStorageForkReach('far', NaN, 0.8), 0.8);
});

test('目标库位世界坐标必须相对货叉初始锚点换算行走与升降偏移', () => {
  assert.equal(typeof resolveStackerStorageTargetOffsets, 'function');
  const offsets = resolveStackerStorageTargetOffsets({
    targetTravelCoordinate: 4,
    targetLiftCoordinate: 1.2,
    referenceTravelCoordinate: -7.8385433618,
    referenceLiftCoordinate: 0.8921632311,
  });
  assert.ok(Math.abs(offsets.travelOffset - 11.8385433618) < 1e-9);
  assert.ok(Math.abs(offsets.liftOffset - 0.3078367689) < 1e-9);
});

test('目标列/层换算为 Locator boxes 下标，层优先行展开', () => {
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, columns: 4, layers: 3, toX: 1, toY: 1 }), 0);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, columns: 4, layers: 3, toX: 4, toY: 2 }), 7);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 5, columns: 2, layers: 2, toX: 6, toY: 2 }), 3);
});

test('目标列/层越界时返回 null，由调用方回退 locator 根节点', () => {
  assert.equal(resolveLocatorBoxIndex({ startColumn: 2, columns: 4, layers: 3, toX: 1, toY: 1 }), null);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, columns: 4, layers: 3, toX: 5, toY: 1 }), null);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, columns: 4, layers: 3, toX: 1, toY: 0 }), null);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, columns: 4, layers: 3, toX: 1, toY: 4 }), null);
});

test('单格口 Locator 只接受第一列第一层', () => {
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, columns: 1, layers: 1, toX: 1, toY: 1 }), 0);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, columns: 1, layers: 1, toX: 2, toY: 1 }), null);
});
