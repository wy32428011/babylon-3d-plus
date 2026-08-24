import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLocatorBoxIndex, resolveLocatorCellLocalBounds, resolveLocatorCellLocalIndex, resolveStackerStorageTargetOffsets } from '../../src/runtime/babylon/telemetry/stackerStorageLocation';

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
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, toX: 1, toY: 1 }), 0);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, toX: 4, toY: 2 }), 7);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 5, startLayer: 1, columns: 2, layers: 2, toX: 6, toY: 2 }), 3);
});

test('目标列/层越界时返回 null，由调用方回退 locator 根节点', () => {
  assert.equal(resolveLocatorBoxIndex({ startColumn: 2, startLayer: 1, columns: 4, layers: 3, toX: 1, toY: 1 }), null);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, toX: 5, toY: 1 }), null);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, toX: 1, toY: 0 }), null);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 4, layers: 3, toX: 1, toY: 4 }), null);
});

test('起始层偏移参与下标换算，可以为 0', () => {
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 3, columns: 4, layers: 3, toX: 1, toY: 3 }), 0);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 3, columns: 4, layers: 3, toX: 4, toY: 4 }), 7);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 3, columns: 4, layers: 3, toX: 1, toY: 2 }), null);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 3, columns: 4, layers: 3, toX: 1, toY: 6 }), null);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 0, startLayer: 0, columns: 2, layers: 2, toX: 0, toY: 0 }), 0);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 0, startLayer: 0, columns: 2, layers: 2, toX: 1, toY: 1 }), 3);
});

test('单格口 Locator 只接受第一列第一层', () => {
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 1, layers: 1, toX: 1, toY: 1 }), 0);
  assert.equal(resolveLocatorBoxIndex({ startColumn: 1, startLayer: 1, columns: 1, layers: 1, toX: 2, toY: 1 }), null);
});

test('业务坐标排-列-层换算为 boxes 下标，排不匹配返回 null', () => {
  const locator = { startColumn: 1, startLayer: 1, rowNumber: 2, columns: 4, layers: 3 };
  assert.equal(resolveLocatorCellLocalIndex(locator, { row: 2, column: 1, layer: 1 }), 0);
  assert.equal(resolveLocatorCellLocalIndex(locator, { row: 2, column: 4, layer: 2 }), 7);
  assert.equal(resolveLocatorCellLocalIndex(locator, { row: 1, column: 1, layer: 1 }), null);
  assert.equal(resolveLocatorCellLocalIndex(locator, { row: 2, column: 5, layer: 1 }), null);
});

test('单格本地 AABB 与渲染网格同源：底面中心=(列*步距, 层*步距, 0)', () => {
  const locator = {
    columns: 4,
    layers: 3,
    cellSteps: { columnStepX: 1.2, layerStepY: 0.8 },
    cellSize: { length: 1, height: 0.6, width: 0.9 },
  };
  const first = resolveLocatorCellLocalBounds(locator, 0);
  assert.ok(first);
  assert.deepEqual(first.center, { x: 0, y: 0.3, z: 0 });
  assert.deepEqual(first.min, { x: -0.5, y: 0, z: -0.45 });
  assert.deepEqual(first.max, { x: 0.5, y: 0.6, z: 0.45 });

  const cell = resolveLocatorCellLocalBounds(locator, 7);
  assert.ok(cell);
  assert.equal(cell.columnIndex, 3);
  assert.equal(cell.layerIndex, 1);
  assert.ok(Math.abs(cell.center.x - 3.6) < 1e-9);
  assert.ok(Math.abs(cell.center.y - 1.1) < 1e-9);
  assert.equal(cell.center.z, 0);
  assert.ok(Math.abs(cell.min.x - 3.1) < 1e-9);
  assert.equal(cell.min.y, 0.8);
  assert.equal(cell.min.z, -0.45);
  assert.ok(Math.abs(cell.max.x - 4.1) < 1e-9);
  assert.ok(Math.abs(cell.max.y - 1.4) < 1e-9);
  assert.equal(cell.max.z, 0.45);
});

test('负向列步距仍输出合法 min/max AABB', () => {
  const locator = {
    columns: 3,
    layers: 1,
    cellSteps: { columnStepX: -1.5, layerStepY: 1 },
    cellSize: { length: 1, height: 0.8, width: 1.2 },
  };
  const cell = resolveLocatorCellLocalBounds(locator, 2);
  assert.ok(cell);
  assert.deepEqual(cell.center, { x: -3, y: 0.4, z: 0 });
  assert.equal(cell.min.x, -3.5);
  assert.equal(cell.max.x, -2.5);
  assert.equal(cell.min.y, 0);
  assert.equal(cell.max.y, 0.8);
});

test('单格本地 AABB 越界返回 null', () => {
  const locator = {
    columns: 2,
    layers: 2,
    cellSteps: { columnStepX: 1, layerStepY: 1 },
    cellSize: { length: 1, height: 1, width: 1 },
  };
  assert.equal(resolveLocatorCellLocalBounds(locator, -1), null);
  assert.equal(resolveLocatorCellLocalBounds(locator, 4), null);
  assert.equal(resolveLocatorCellLocalBounds(locator, 1.5), null);
});
