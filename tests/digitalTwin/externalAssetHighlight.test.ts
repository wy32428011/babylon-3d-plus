import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeSceneRuntimeHighlightEntityIds } from '../../src/runtime/babylon/sceneRuntimeHighlight.ts';

test('编辑器选区、Viewer 本地高亮与外部描边合并且不修改输入集合', () => {
  const selected = new Set(['selected-a', 'shared']);
  const local = new Set(['local-b', 'shared']);
  const external = new Set(['external-c', 'shared']);
  const merged = mergeSceneRuntimeHighlightEntityIds(selected, local, external);

  assert.deepEqual([...merged], ['selected-a', 'shared', 'local-b', 'external-c']);
  assert.deepEqual([...selected], ['selected-a', 'shared']);
  assert.deepEqual([...local], ['local-b', 'shared']);
  assert.deepEqual([...external], ['external-c', 'shared']);
});

test('任意数量的空高亮来源得到空集合', () => {
  assert.deepEqual([...mergeSceneRuntimeHighlightEntityIds(new Set(), new Set(), new Set())], []);
});
