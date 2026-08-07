import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeSceneRuntimeHighlightEntityIds } from '../../src/runtime/babylon/sceneRuntimeHighlight.ts';

test('外部描边与编辑器选区合并且不修改输入集合', () => {
  const selected = new Set(['selected-a', 'shared']);
  const external = new Set(['external-b', 'shared']);
  const merged = mergeSceneRuntimeHighlightEntityIds(selected, external);

  assert.deepEqual([...merged], ['selected-a', 'shared', 'external-b']);
  assert.deepEqual([...selected], ['selected-a', 'shared']);
  assert.deepEqual([...external], ['external-b', 'shared']);
});

test('空选区和空外部描边得到空集合', () => {
  assert.deepEqual([...mergeSceneRuntimeHighlightEntityIds(new Set(), new Set())], []);
});
