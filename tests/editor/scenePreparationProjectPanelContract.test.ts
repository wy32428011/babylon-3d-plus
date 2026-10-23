import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

/** 在实际注册的 effect 内验证合同，避免其他主动同步路径污染同名源码断言。 */
function effectSource(source: string, marker: string): string {
  const ast = ts.createSourceFile('ProjectPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes(marker)) matches.push(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(matches.length, 1, '须唯一定位实际注册的 effect：' + marker);
  return matches[0];
}

test('打开场景优先关联本地模型缓存且不等待后台模型同步', async () => {
  const source = await readFile(
    new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /useEffect\(\(\) => \{\s*let active = true;[\s\S]*?if \(sceneResourcePolicy === 'preserve-snapshot'\) skipSceneModelSync\(sceneSessionId, null\);[\s\S]*?beginSceneModelAssetRefresh\(sceneSessionId, refreshId\);[\s\S]*?loadProjectAssets\(\{\s*refreshModels: sceneResourcePolicy === 'preserve-snapshot',\s*preserveResolvedSnapshots: true,\s*preservePackagedEnvironment: true,\s*refreshEnvironment: sceneResourcePolicy === 'preserve-snapshot' && refreshStartupEnvironment,\s*refreshSkybox: sceneResourcePolicy !== 'local-refresh',\s*\}\)/,
  );
  assert.match(
    source,
    /return \(\) => \{\s*active = false;[\s\S]*?projectAssetsLoadRequestRef\.current \+= 1;/,
  );
  assert.doesNotMatch(source, /modelSyncDiscoveryTimerRef/);
});

test('后台模型同步仅在模型库实际变化时刷新场景', async () => {
  const source = await readFile(
    new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /progress\.phase === 'completed'\s*&& !localResourcePreparingRef\.current[\s\S]*?refreshSceneModelsForSyncRun\(progress, progressSceneSessionId\)/,
  );
  assert.match(
    source,
    /const runtimeChangedResourceKeys = progress\.runtimeChangedResourceKeys \?\? null;[\s\S]*?loadProjectAssets\(\{\s*refreshModels: !libraryOnly && \(runtimeChangedResourceKeys === null \|\| runtimeChangedResourceKeys\.length > 0\),\s*preserveResolvedSnapshots: true,\s*modelResourceKeys: runtimeChangedResourceKeys,\s*modelSyncRunId: progress\.runId,\s*\}\)/,
  );
  assert.match(
    source,
    /const assetsToRefresh = filterProjectModelsForSyncRefresh\(\s*modelAssets,\s*options\.modelResourceKeys === undefined \? null : options\.modelResourceKeys,\s*\);/,
  );
  const progressEffect = effectSource(source, 'const refreshSceneModelsForSyncRun');
  assert.match(progressEffect, /const libraryOnly = useEditorStore\.getState\(\)\.sceneResourcePolicy !== 'preserve-snapshot'\s*\|\| isScenePreparationSettled\(getScenePreparationSnapshot\(\)\)/);
  assert.doesNotMatch(progressEffect, /reportSceneModelSyncProgress\(/);
});

test('环境与天空盒同步刷新必须等待首次模型本地关联完成', async () => {
  const source = await readFile(
    new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /const waitForInitialProjectAssetsLoad = useCallback\(async \([\s\S]*?const initialLoadPromise = initialProjectAssetsLoadPromiseRef\.current;[\s\S]*?await initialLoadPromise;[\s\S]*?initialProjectAssetsLoadPromiseRef\.current === initialLoadPromise[\s\S]*?sceneSessionIdRef\.current === expectedSceneSessionId;/,
  );
  assert.match(
    source,
    /reloadAssets: async \(\) => \{\s*const reloadSceneSessionId = sceneSessionIdRef\.current;\s*if \(!await waitForInitialProjectAssetsLoad\(reloadSceneSessionId\)\) \{[\s\S]*?\}\s*const result = await loadProjectAssets\(\);/,
  );
  assert.match(
    source,
    /lastSceneRefreshEnvironmentSyncRunIdRef\.current = progress\.runId;\s*void \(async \(\) => \{\s*if \(\s*!await waitForInitialProjectAssetsLoad\(progressSceneSessionId\)\s*\|\| lastSceneRefreshEnvironmentSyncRunIdRef\.current !== progress\.runId\s*\) return;\s*const libraryOnly = useEditorStore\.getState\(\)\.sceneResourcePolicy !== 'preserve-snapshot'\s*\|\| isScenePreparationSettled\(getScenePreparationSnapshot\(\)\);\s*const loaded = await loadProjectAssets\(\{ refreshEnvironment: !libraryOnly, environmentSyncRunId: progress\.runId,\s*preservePackagedEnvironment: true \}\);/,
  );
});
