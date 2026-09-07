import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scenePanelSource = await readFile(
  new URL('../../src/editor/panels/SceneViewPanel.tsx', import.meta.url),
  'utf8',
);

test('编辑器场景准备把当前环境作为独立模型计入总数与稳定条件', () => {
  assert.match(
    scenePanelSource,
    /totalSceneModels = modelEntityIds\.length \+ \(sceneRuntimeEnvironmentSourceUrl \? 1 : 0\)/,
  );
  assert.match(
    scenePanelSource,
    /environmentSnapshot\.phase === 'ready'[\s\S]*?environmentSnapshot\.sourceUrl === sceneRuntimeEnvironmentSourceUrl/,
  );
  assert.match(
    scenePanelSource,
    /if \(sceneRuntimeEnvironmentSourceUrl && environmentReady\) settledModels \+= 1/,
  );
  assert.match(
    scenePanelSource,
    /readyNow = settledModels >= totalSceneModels[\s\S]*?batchedEntities >= expectedBatchedEntities/,
  );
});
