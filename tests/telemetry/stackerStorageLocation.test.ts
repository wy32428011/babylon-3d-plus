import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLocatorBoxIndex, resolveStackerStorageTargetOffsets } from '../../src/runtime/babylon/telemetry/stackerStorageLocation';

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
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, columnReversed: false, toX: 1, toY: 1 }), 0);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, columnReversed: false, toX: 4, toY: 2 }), 7);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 5, startLayer: 1, columns: 2, layers: 2, columnReversed: false, toX: 6, toY: 2 }), 3);
});

test('列反向时大数列映射到靠近原点的下标 0', () => {
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, columnReversed: true, toX: 4, toY: 1 }), 0);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, columnReversed: true, toX: 1, toY: 1 }), 3);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, columnReversed: true, toX: 4, toY: 2 }), 4);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, columnReversed: true, toX: 1, toY: 3 }), 11);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, columnReversed: true, toX: 5, toY: 1 }), null);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, columnReversed: true, toX: 0, toY: 1 }), null);
});

test('目标列/层越界时返回 null，由调用方回退 locator 根节点', () => {
  assert.equal(resolveLocatorBoxIndex({ startColumn: 2, startLayer: 1, columns: 4, layers: 3, columnReversed: false, toX: 1, toY: 1 }), null);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, columnReversed: false, toX: 5, toY: 1 }), null);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, columnReversed: false, toX: 1, toY: 0 }), null);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, columnReversed: false, toX: 1, toY: 4 }), null);
});

test('起始层偏移参与下标换算，可以为 0', () => {
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 3, columns: 4, layers: 3, columnReversed: false, toX: 1, toY: 3 }), 0);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 3, columns: 4, layers: 3, columnReversed: false, toX: 4, toY: 4 }), 7);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 3, columns: 4, layers: 3, columnReversed: false, toX: 1, toY: 2 }), null);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 3, columns: 4, layers: 3, columnReversed: false, toX: 1, toY: 6 }), null);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 0, startLayer: 0, columns: 2, layers: 2, columnReversed: false, toX: 0, toY: 0 }), 0);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 0, startLayer: 0, columns: 2, layers: 2, columnReversed: false, toX: 1, toY: 1 }), 3);
});

test('单格口 Locator 只接受第一列第一层', () => {
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 1, layers: 1, columnReversed: false, toX: 1, toY: 1 }), 0);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 1, layers: 1, columnReversed: false, toX: 2, toY: 1 }), null);
});
