import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('场景自然完成后停止轮询，超时完成或同场景刷新时继续轮询', async () => {
  const source = await readFile(
    new URL('../../src/editor/panels/SceneViewPanel.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /preparationState\.sceneSessionId !== sceneSessionId[\s\S]*?preparationState\.completed && !preparationState\.runtime\.forcedSettled[\s\S]*?stopReadinessPolling\(\);\s*return;/,
  );
  assert.match(source, /subscribeScenePreparation/);
  assert.match(
    source,
    /subscribeScenePreparation\(\(\) => \{[\s\S]*?preparationState\.completed && !preparationState\.runtime\.forcedSettled[\s\S]*?stopReadinessPolling\(\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?startReadinessPolling\(\);[\s\S]*?\}\)/,
  );
  assert.match(source, /!preparationState\.completed \|\| preparationState\.runtime\.forcedSettled/);
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

test('自动巡检等待场景自然就绪，超时放行蒙版后仍继续观察真实加载', async () => {
  const source = await readFile(
    new URL('../../src/editor/panels/SceneViewPanel.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /sceneReadyForAutoPatrol/);
  assert.match(source, /!sceneDocument\.sceneSettings\.environment \|\| environmentRuntimePhase === 'ready'/);
  assert.match(
    source,
    /preparationState\.completed\s*&&\s*!preparationState\.runtime\.forcedSettled/,
  );
  assert.match(
    source,
    /if \(!sceneReadyForAutoPatrol\) return;[\s\S]*?findAutoStartPatrolRoute/,
  );
  assert.match(
    source,
    /autoPatrolPlaybackRequest\.action === 'start'[\s\S]*?autoPatrolPlaybackRequest\.action === 'resume'[\s\S]*?!sceneReadyForAutoPatrol/,
  );
  assert.match(
    source,
    /autoPatrolPlaybackRequest\.action === 'start'[\s\S]*?autoPatrolPlaybackRequest\.action === 'resume'[\s\S]*?!isRuntimePreview[\s\S]*?consumeAutoPatrolPlaybackRequest/,
  );
  assert.match(source, /autoPatrolPreviewAutoStartCancelledRef/);
  assert.match(
    source,
    /autoPatrolPlaybackRequest\.action === 'start'[\s\S]*?autoPatrolPlaybackRequest\.action === 'resume'[\s\S]*?autoPatrolPreviewAutoStartCancelledRef\.current = true/,
  );
  assert.match(
    source,
    /autoPatrolPlaybackRequest\.action === 'stop'[\s\S]*?autoPatrolPreviewAutoStartCancelledRef\.current = true/,
  );
});
