import assert from 'node:assert/strict';
import test from 'node:test';

import { isRuntimeModelSelectionCandidate } from '../../src/runtime/babylon/sceneRuntimeSelection.ts';

function entity(components: Record<string, unknown>, isFolder = false) {
  return { isFolder, components };
}

test('运行态模型选择接受真实模型类型且不受编辑锁定影响', () => {
  const visibleLocked = { visible: true, locked: true };
  assert.equal(isRuntimeModelSelectionCandidate(entity({ modelAsset: {} }), visibleLocked), true);
  assert.equal(isRuntimeModelSelectionCandidate(entity({ meshRenderer: {} }), visibleLocked), true);
  assert.equal(isRuntimeModelSelectionCandidate(entity({ modelArrayInstance: {} }), visibleLocked), true);
  assert.equal(isRuntimeModelSelectionCandidate(entity({ modelGenerator: {} }), visibleLocked), true);
});

test('运行态模型选择拒绝隐藏对象、文件夹和编辑辅助实体', () => {
  assert.equal(isRuntimeModelSelectionCandidate(entity({ modelAsset: {} }), { visible: false, locked: false }), false);
  assert.equal(isRuntimeModelSelectionCandidate(entity({ modelAsset: {} }, true), { visible: true, locked: false }), false);
  assert.equal(isRuntimeModelSelectionCandidate(entity({ autoPatrol: {} }), { visible: true, locked: false }), false);
  assert.equal(isRuntimeModelSelectionCandidate(entity({ light: {} }), { visible: true, locked: false }), false);
  assert.equal(isRuntimeModelSelectionCandidate(entity({ camera: {} }), { visible: true, locked: false }), false);
  assert.equal(isRuntimeModelSelectionCandidate(entity({ skybox: {} }), { visible: true, locked: false }), false);
  assert.equal(isRuntimeModelSelectionCandidate(entity({ locator: {} }), { visible: true, locked: false }), false);
  assert.equal(isRuntimeModelSelectionCandidate(entity({ poiEffect: {} }), { visible: true, locked: false }), false);
});
