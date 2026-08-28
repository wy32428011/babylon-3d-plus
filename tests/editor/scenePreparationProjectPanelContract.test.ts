import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('打开场景优先关联本地模型缓存且不等待后台模型同步', async () => {
  const source = await readFile(
    new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /useEffect\(\(\) => \{\s*let active = true;[\s\S]*?skipSceneModelSync\(sceneSessionId, null\);[\s\S]*?beginSceneModelAssetRefresh\(sceneSessionId, refreshId\);[\s\S]*?loadProjectAssets\(\{\s*refreshModels: true,\s*refreshEnvironment: refreshStartupEnvironment,\s*refreshSkybox: true,\s*\}\)/,
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
    /progress\.phase === 'completed'\s*&& shouldRefreshProjectModelsAfterSync\(progress\)/,
  );
  assert.match(
    source,
    /const runtimeChangedResourceKeys = progress\.runtimeChangedResourceKeys \?\? null;[\s\S]*?loadProjectAssets\(\{\s*refreshModels: runtimeChangedResourceKeys === null \|\| runtimeChangedResourceKeys\.length > 0,\s*modelResourceKeys: runtimeChangedResourceKeys,\s*\}\)/,
  );
  assert.match(
    source,
    /const assetsToRefresh = filterProjectModelsForSyncRefresh\(\s*modelAssets,\s*options\.modelResourceKeys === undefined \? null : options\.modelResourceKeys,\s*\);/,
  );
  assert.doesNotMatch(source, /reportSceneModelSyncProgress\(/);
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
    /lastSceneRefreshEnvironmentSyncRunIdRef\.current = progress\.runId;\s*void \(async \(\) => \{\s*if \(\s*!await waitForInitialProjectAssetsLoad\(progressSceneSessionId\)\s*\|\| lastSceneRefreshEnvironmentSyncRunIdRef\.current !== progress\.runId\s*\) return;\s*const loaded = await loadProjectAssets\(\{ refreshEnvironment: true \}\);/,
  );
});
