import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeSceneModelSelectionPointer,
  createSceneModelSelectionPointerSnapshot,
  updateSceneModelSelectionPointerSnapshot,
} from '../../src/shared/sceneModelSelectionPointer.ts';

const tolerancePx = 4;

test('主鼠标短按保留修饰键并使用释放坐标完成模型选择', () => {
  const snapshot = createSceneModelSelectionPointerSnapshot({
    pointerId: 7,
    button: 0,
    clientX: 100,
    clientY: 200,
    isPrimary: true,
    ctrlKey: true,
    metaKey: false,
  });

  assert.ok(snapshot);
  assert.deepEqual(
    completeSceneModelSelectionPointer(snapshot, {
      pointerId: 7,
      button: 0,
      clientX: 102,
      clientY: 201,
    }, tolerancePx),
    { clientX: 102, clientY: 201, toggleSelection: true },
  );
});

test('单指轻触可以选择，非主触点和非左键不会开始选择会话', () => {
  assert.ok(createSceneModelSelectionPointerSnapshot({
    pointerId: 1,
    button: 0,
    clientX: 10,
    clientY: 20,
    isPrimary: true,
    ctrlKey: false,
    metaKey: false,
  }));
  assert.equal(createSceneModelSelectionPointerSnapshot({
    pointerId: 2,
    button: 0,
    clientX: 10,
    clientY: 20,
    isPrimary: false,
    ctrlKey: false,
    metaKey: false,
  }), null);
  assert.equal(createSceneModelSelectionPointerSnapshot({
    pointerId: 1,
    button: 2,
    clientX: 10,
    clientY: 20,
    isPrimary: true,
    ctrlKey: false,
    metaKey: false,
  }), null);
});

test('超过阈值后即使指针回到起点也保持拖拽判定', () => {
  const initial = createSceneModelSelectionPointerSnapshot({
    pointerId: 3,
    button: 0,
    clientX: 50,
    clientY: 50,
    isPrimary: true,
    ctrlKey: false,
    metaKey: false,
  });
  assert.ok(initial);

  const dragged = updateSceneModelSelectionPointerSnapshot(initial, {
    pointerId: 3,
    clientX: 60,
    clientY: 50,
  });
  const returned = updateSceneModelSelectionPointerSnapshot(dragged, {
    pointerId: 3,
    clientX: 50,
    clientY: 50,
  });

  assert.equal(returned.maxTravelDistancePx, 10);
  assert.equal(completeSceneModelSelectionPointer(returned, {
    pointerId: 3,
    button: 0,
    clientX: 50,
    clientY: 50,
  }, tolerancePx), null);
});

test('其他指针的移动不会污染当前点击会话', () => {
  const initial = createSceneModelSelectionPointerSnapshot({
    pointerId: 4,
    button: 0,
    clientX: 1,
    clientY: 2,
    isPrimary: true,
    ctrlKey: false,
    metaKey: true,
  });
  assert.ok(initial);

  const unchanged = updateSceneModelSelectionPointerSnapshot(initial, {
    pointerId: 9,
    clientX: 100,
    clientY: 200,
  });
  assert.deepEqual(unchanged, initial);
  assert.equal(completeSceneModelSelectionPointer(unchanged, {
    pointerId: 9,
    button: 0,
    clientX: 1,
    clientY: 2,
  }, tolerancePx), null);
});
