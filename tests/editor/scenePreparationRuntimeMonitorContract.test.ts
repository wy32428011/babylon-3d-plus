import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('场景准备完成后停止轮询，同场景再次刷新时恢复轮询', async () => {
  const source = await readFile(
    new URL('../../src/editor/panels/SceneViewPanel.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /if \(preparationState\.sceneSessionId !== sceneSessionId \|\| preparationState\.completed\) \{\s*stopReadinessPolling\(\);\s*return;\s*\}/,
  );
  assert.match(source, /subscribeScenePreparation/);
  assert.match(
    source,
    /subscribeScenePreparation\(\(\) => \{[\s\S]*?if \(preparationState\.sceneSessionId !== sceneSessionId \|\| preparationState\.completed\) \{[\s\S]*?stopReadinessPolling\(\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?startReadinessPolling\(\);[\s\S]*?\}\)/,
  );
  assert.match(source, /sampleReadiness\(\);\s*startReadinessPolling\(\);/);
  assert.match(source, /unsubscribeScenePreparation\(\);/);
});

test('运行时准备超时会写入 Console，且同一观察窗口只记录一次', async () => {
  const source = await readFile(
    new URL('../../src/editor/panels/SceneViewPanel.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /sceneRuntimeTimeoutLoggedRef/);
  assert.match(
    source,
    /sceneRuntimeTimeoutLoggedRef\.current = false;[\s\S]*?pushLog\(SCENE_PREPARATION_RUNTIME_TIMEOUT_WARNING\);[\s\S]*?settleSceneRuntimeWithWarning\(sceneSessionId, SCENE_PREPARATION_RUNTIME_TIMEOUT_WARNING\);/,
  );
  assert.match(
    source,
    /if \(preparationState\.runtime\.generation !== sceneRuntimeReadinessGeneration\) \{[\s\S]*?sceneRuntimeTimeoutLoggedRef\.current = false;/,
  );
});
