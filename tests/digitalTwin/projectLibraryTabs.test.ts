import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { ProjectSkyboxAssetEntry } from '../../src/editor/assets/AssetDatabase.ts';

import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const PROJECT_PANEL_PATH = 'src/editor/panels/ProjectPanel.tsx';
const PROJECT_LIBRARY_PATH = 'src/editor/assets/projectLibrary.ts';
const ASSET_DATABASE_PATH = 'src/editor/assets/AssetDatabase.ts';
const ELECTRON_TYPES_PATH = 'electron/types.ts';
const VITE_ENV_PATH = 'src/vite-env.d.ts';
const PROJECT_ASSET_STORE_PATH = 'electron/ipc/projectAssetStore.ts';
const ASSET_IPC_PATH = 'electron/ipc/assetIpc.ts';
const INSPECTOR_PANEL_PATH = 'src/editor/panels/InspectorPanel.tsx';
const POI_EFFECT_INSPECTOR_PATH = 'src/editor/panels/PoiEffectInspector.tsx';
const GLOBAL_STYLE_PATH = 'src/styles/global.css';
const SCENE_SETTINGS_PANEL_PATH = 'src/editor/panels/SceneSettingsPanel.tsx';
const PROJECT_IPC_PATH = 'electron/ipc/projectIpc.ts';
const SKYBOX_SYNC_CONTROLLER_PATH = 'src/editor/assets/skyboxSyncController.ts';

const [{
  formatSkyboxSyncError,
  formatSkyboxSyncProgressCount,
  normalizeSkyboxSyncProgress,
  refreshCurrentSkyboxAfterProjectAssetsLoad,
}] =
  await importIsolatedTypeScriptModules<[
    typeof import('../../src/editor/assets/skyboxAssets'),
  ]>(['src/editor/assets/skyboxAssets.ts']);

function readLibraryBranch(source: string, libraryKey: 'model' | 'skybox'): string {
  const branchStart = `if (activeLibrary.key === '${libraryKey}') {`;
  const startIndex = source.indexOf(branchStart);
  assert.notEqual(startIndex, -1, `未找到 ${libraryKey} 资源库分支`);

  const nextBranchIndex = source.indexOf("\n    if (activeLibrary.key === '", startIndex + branchStart.length);
  return source.slice(startIndex, nextBranchIndex === -1 ? source.length : nextBranchIndex);
}

function readProjectLibraryDefinition(source: string, libraryKey: string): string {
  const normalizedSource = source.replace(/\r\n/g, '\n');
  const keyMarker = `    key: '${libraryKey}',`;
  const keyIndex = normalizedSource.indexOf(keyMarker);
  assert.notEqual(keyIndex, -1, `未找到 ${libraryKey} 资源库定义`);

  const startIndex = normalizedSource.lastIndexOf('  {', keyIndex);
  const nextLibraryIndex = normalizedSource.indexOf("\n  {\n    key: '", keyIndex + keyMarker.length);
  return normalizedSource.slice(startIndex, nextLibraryIndex === -1 ? normalizedSource.length : nextLibraryIndex);
}

test('天空盒资源只出现在天空盒 Tab，不混入模型库', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');
  const modelBranch = readLibraryBranch(source, 'model');
  const skyboxBranch = readLibraryBranch(source, 'skybox');

  assert.match(modelBranch, /createModelLibraryItems\(modelAssets\)/);
  assert.doesNotMatch(modelBranch, /createSkyboxLibraryItems\(skyboxAssets\)/);
  assert.match(skyboxBranch, /createSkyboxLibraryItems\(skyboxAssets\)/);
});

test('模型库空状态只由普通模型资产决定', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');

  assert.match(source, /activeLibrary\.key === 'model' && modelAssets\.length === 0/);
  assert.doesNotMatch(
    source,
    /activeLibrary\.key === 'model' && modelAssets\.length === 0 && skyboxAssets\.length === 0/,
  );
});

test('特效库紧跟 POI 库并承载全部内置 EFF，POI 库仅保留七个指定入口', () => {
  const source = readFileSync(PROJECT_LIBRARY_PATH, 'utf8');
  const poiLibrary = readProjectLibraryDefinition(source, 'poi');
  const effectLibrary = readProjectLibraryDefinition(source, 'effect');
  const poiIndex = source.indexOf("    key: 'poi',");
  const effectIndex = source.indexOf("    key: 'effect',");
  const themeIndex = source.indexOf("    key: 'theme',");

  assert.ok(poiIndex < effectIndex && effectIndex < themeIndex, '特效库应位于 POI 库与主题库之间');
  assert.deepEqual(
    [...poiLibrary.matchAll(/id: '(poi-[^']+)'/g)].map((match) => match[1]),
    ['poi-auto-patrol', 'poi-model-generator', 'poi-click-event-binding', 'poi-chart-marker', 'poi-panel', 'poi-alarm', 'poi-roam'],
  );
  assert.ok(!poiLibrary.includes('createPoiEffectLibraryItems()'));
  assert.ok(effectLibrary.includes("label: '特效库'"));
  assert.ok(effectLibrary.includes("searchLabel: '特效名称'"));
  assert.ok(effectLibrary.includes("searchPlaceholder: '请输入特效名称...'"));
  assert.ok(effectLibrary.includes('items: createPoiEffectLibraryItems()'));
});

test('特效 Inspector 使用独立于 POI 的用户可见术语', () => {
  const inspectorSource = readFileSync(INSPECTOR_PANEL_PATH, 'utf8');
  const effectInspectorSource = readFileSync(POI_EFFECT_INSPECTOR_PATH, 'utf8');

  assert.ok(inspectorSource.includes("poiEffect ? '特效名称'"));
  assert.ok(inspectorSource.includes("modelGenerator || clickEventBinding || autoPatrol || selectedEntity.components.chartMarker ? 'POI名称'"));
  assert.ok(effectInspectorSource.includes('<legend>特效</legend>'));
  assert.ok(!effectInspectorSource.includes('POI 特效'));
});

test('模型库提供 deviceType 下拉筛选并与名称筛选组合生效', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');
  const styles = readFileSync(GLOBAL_STYLE_PATH, 'utf8');

  assert.ok(source.includes("from '../assets/modelLibraryDeviceTypeFilter'"));
  assert.ok(source.includes("const [modelDeviceTypeFilter, setModelDeviceTypeFilter] = useState('')"));
  assert.ok(source.includes('createModelDeviceTypeOptions(modelAssets)'));
  assert.ok(source.includes("activeLibrary.key === 'model' && !modelDeviceTypes.includes(modelDeviceTypeFilter)"));
  assert.ok(source.includes('matchesModelDeviceType(item, modelDeviceTypeFilter)'));
  assert.ok(source.includes('id="project-library-model-type"'));
  assert.ok(source.includes('<option value="">全部类型</option>'));
  assert.ok(source.includes('未找到符合当前筛选条件的资源'));
  assert.match(styles, /\.project-library \.library-filter-select/);
});

test('切换资源库或聚焦模型卡片时重置模型类型筛选', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');

  const resetCalls = source.match(/setModelDeviceTypeFilter\(''\)/g) ?? [];
  assert.ok(resetCalls.length >= 2, 'Tab 切换和模型聚焦至少各有一次类型重置');
});


test('三处天空盒类型包含一致来源、可用性与 Long 字符串元数据', () => {
  for (const sourcePath of [ELECTRON_TYPES_PATH, VITE_ENV_PATH, ASSET_DATABASE_PATH]) {
    const source = readFileSync(sourcePath, 'utf8');
    assert.match(source, /source:\s*'project'\s*\|\s*'data-platform'/, sourcePath);
    assert.match(source, /availability:\s*'active'\s*\|\s*'orphaned'/, sourcePath);
    assert.match(source, /dataPlatformResourceId\?:\s*string/, sourcePath);
    assert.match(source, /dataPlatformRevision\?:\s*string/, sourcePath);
    assert.match(source, /fileSha256\?:\s*string/, sourcePath);
  }
});

test('项目资源结果分离 orphaned 天空盒且无项目返回四字段空值', () => {
  const types = readFileSync(ELECTRON_TYPES_PATH, 'utf8');
  const rendererTypes = readFileSync(VITE_ENV_PATH, 'utf8');
  const store = readFileSync(PROJECT_ASSET_STORE_PATH, 'utf8');

  assert.match(types, /orphanedSkyboxes:\s*ProjectSkyboxAssetEntry\[\]/);
  assert.match(rendererTypes, /orphanedSkyboxes:\s*ProjectSkyboxAssetEntry\[\]/);
  assert.match(store, /projectRoot: null,[\s\S]*?skyboxSyncContextKey: null,[\s\S]*?orphanedSkyboxes: \[\]/);
  assert.match(store, /\[\.\.\.skyboxes, \.\.\.orphanedSkyboxes\]/);
});

test('共享模型根授权不再顺带放开整个共享天空盒目录', () => {
  const source = readFileSync(PROJECT_ASSET_STORE_PATH, 'utf8');
  const helperStart = source.indexOf('function authorizeSharedProjectAssetRoots');
  const helperEnd = source.indexOf('\n}', helperStart);
  assert.notEqual(helperStart, -1, '应定义独立的共享模型资源授权函数');
  const helper = source.slice(helperStart, helperEnd + 2);

  assert.match(helper, /getProjectModelsRoot/);
  assert.match(helper, /getProjectEnvironmentsRoot/);
  assert.match(helper, /getProjectImagesRoot/);
  assert.doesNotMatch(helper, /getProjectSkyboxesRoot/);
  assert.match(source, /setSharedProjectAssetRoot[\s\S]*?authorizeSharedProjectAssetRoots\(sharedProjectAssetRoot\)/);
});

test('天空盒卡片只接收 active 并显示固定来源文案', () => {
  const source = readFileSync(PROJECT_LIBRARY_PATH, 'utf8');

  assert.match(source, /filter\(\(asset\) => asset\.availability === 'active'\)/);
  assert.ok(source.includes("asset.source === 'data-platform' ? '数据中台' : '项目本地'"));
  assert.match(source, /\$\{sourceLabel\} · \$\{asset\.format\.toUpperCase\(\)\} · \$\{formatSkyboxFileSize\(asset\.fileSizeBytes\)\}/);
});

test('天空盒拖拽兼容旧本地载荷并严格拒绝 orphaned 或不完整中台元数据', () => {
  const source = readFileSync(ASSET_DATABASE_PATH, 'utf8');

  assert.match(source, /source[^\n]+\?\? 'project'/);
  assert.match(source, /availability[^\n]+\?\? 'active'/);
  assert.match(source, /availability !== 'active'/);
  assert.match(source, /dataPlatformResourceId/);
  assert.match(source, /dataPlatformRevision/);
  assert.match(source, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(source, /Object\.getOwnPropertyDescriptor/);
});


test('天空盒导入结果携带 orphaned 并复用 listProjectAssets 的共享加载 helper', () => {
  const electronTypes = readFileSync(ELECTRON_TYPES_PATH, 'utf8');
  const rendererTypes = readFileSync(VITE_ENV_PATH, 'utf8');
  const store = readFileSync(PROJECT_ASSET_STORE_PATH, 'utf8');
  const assetIpc = readFileSync(ASSET_IPC_PATH, 'utf8');

  assert.match(electronTypes, /ImportSkyboxFileResult[\s\S]*?orphanedSkyboxes:\s*ProjectSkyboxAssetEntry\[\]/);
  assert.match(rendererTypes, /ImportSkyboxFileResult[\s\S]*?orphanedSkyboxes:\s*ProjectSkyboxAssetEntry\[\]/);
  assert.ok((store.match(/loadProjectSkyboxAssets\(/g) ?? []).length >= 3);
  assert.match(assetIpc, /orphanedSkyboxes:\s*\[\]/);
  assert.match(assetIpc, /const \{ importedAsset, skyboxes, orphanedSkyboxes \}/);
});

test('天空盒同步纯逻辑仅在 completed 编排资源刷新，并安全归一化计数和未知错误', () => {
  for (const phase of ['querying', 'downloading', 'validating', 'promoting', 'failed'] as const) {
    const result = normalizeSkyboxSyncProgress({
      runId: `run-${phase}`,
      contextKey: 'project-a',
      phase,
      completed: 1,
      total: 3,
      message: phase,
      error: phase === 'failed' ? 'failed' : null,
    });
    assert.equal(result.valid, true, phase);
    assert.equal(result.shouldReloadProjectAssets, false, phase);
    assert.equal(formatSkyboxSyncProgressCount(result.progress), '1/3');
  }

  const completed = normalizeSkyboxSyncProgress({
    runId: 'run-completed',
    contextKey: 'project-a',
    phase: 'completed',
    completed: 3,
    total: 3,
    message: 'done',
    error: null,
  });
  assert.equal(completed.valid, true);
  assert.equal(completed.shouldReloadProjectAssets, true);
  assert.equal(formatSkyboxSyncProgressCount(completed.progress), '3/3');

  const malicious = {
    [Symbol.toPrimitive](): never {
      throw new Error('不应执行 toPrimitive');
    },
  };
  const invalid = normalizeSkyboxSyncProgress({
    runId: 'run-invalid',
    contextKey: 'project-a',
    phase: 'failed',
    completed: Number.POSITIVE_INFINITY,
    total: -1,
    message: malicious,
    error: malicious,
  });
  assert.equal(invalid.valid, false);
  assert.equal(formatSkyboxSyncProgressCount(invalid.progress), null);
  assert.equal(invalid.progress.message, '收到无效的天空盒同步状态。');
  assert.equal(invalid.progress.error, '收到无效的天空盒同步状态。');
  assert.equal(formatSkyboxSyncError(malicious), '未知错误');
  assert.equal(formatSkyboxSyncError(new Error('网络异常')), '网络异常');
  assert.equal(formatSkyboxSyncProgressCount({ completed: 4, total: 3 }), null);

  const invalidPhase = normalizeSkyboxSyncProgress({
    runId: 'run-invalid-phase',
    contextKey: 'project-a',
    phase: 'unknown',
    completed: 0,
    total: 0,
    message: 'invalid',
    error: null,
  });
  assert.equal(invalidPhase.valid, false);
  assert.equal(invalidPhase.progress.phase, 'failed');
  assert.equal(invalidPhase.shouldReloadProjectAssets, false);
});

test('项目资源初载不刷新当前天空盒，显式刷新才委托稳定 ID 重关联', () => {
  const skyboxes: ProjectSkyboxAssetEntry[] = [];
  const calls: ProjectSkyboxAssetEntry[][] = [];
  const refresh = (assets: ProjectSkyboxAssetEntry[]): boolean => {
    calls.push(assets);
    return true;
  };

  assert.equal(refreshCurrentSkyboxAfterProjectAssetsLoad(false, skyboxes, refresh), false);
  assert.deepEqual(calls, []);
  assert.equal(refreshCurrentSkyboxAfterProjectAssetsLoad(true, skyboxes, refresh), true);
  assert.deepEqual(calls, [skyboxes]);
});

test('ProjectPanel 天空盒 Tab 使用现有同步 API、固定阶段文案并接入纯 controller', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');

  assert.ok(source.includes('syncDataPlatformSkyboxes?: () => Promise<boolean>'));
  assert.ok(source.includes('retryDataPlatformSkyboxSync?: () => Promise<boolean>'));
  assert.ok(source.includes('onDataPlatformSkyboxSyncProgress?:'));
  for (const [phase, label] of [
    ['querying', '查询天空盒'],
    ['downloading', '下载天空盒'],
    ['validating', '校验天空盒'],
    ['promoting', '写入天空盒库'],
    ['completed', '同步完成'],
    ['failed', '同步失败'],
  ]) {
    assert.ok(source.includes(`${phase}: '${label}'`), `缺少 ${phase} 固定文案`);
  }
  assert.ok(source.includes('createSkyboxSyncController({'));
  assert.ok(source.includes('const [skyboxSyncState, setSkyboxSyncState]'));
  assert.ok(source.includes('const skyboxSyncProgress = skyboxSyncState.progress'));
  assert.ok(source.includes('const [orphanedSkyboxAssets, setOrphanedSkyboxAssets]'));
});

test('天空盒同步订阅委托 controller 清理迟到事件，列表成功后才按稳定 ID 命令重关联', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');
  const controllerSource = readFileSync(SKYBOX_SYNC_CONTROLLER_PATH, 'utf8');

  assert.ok(source.includes('onDataPlatformSkyboxSyncProgress?.((progress) => {'));
  assert.ok(source.includes('controller.receiveProgress(progress);'));
  assert.ok(source.includes('unsubscribe?.();'));
  assert.ok(source.includes('controller.dispose();'));
  assert.ok(source.includes('if (!await waitForInitialProjectAssetsLoad(reloadSceneSessionId)) {'));
  assert.ok(source.includes('const result = await loadProjectAssets();'));
  assert.ok(source.includes('applyAssets: (assets, sceneId) => relinkCurrentSkyboxFromAssets(assets, sceneId)'));
  assert.ok(source.includes('updateSkyboxConfig(refreshedSkybox)'));
  assert.match(controllerSource, /await options\.reloadAssets\(\)/);
  assert.match(controllerSource, /result !== 'applied' && result !== 'unchanged'/);

  const loadStart = source.indexOf('const loadProjectAssets = useCallback');
  const loadEnd = source.indexOf('/** 从主进程本地图片索引加载同步图片', loadStart);
  const loadProjectAssetsSource = source.slice(loadStart, loadEnd);
  assert.ok(loadProjectAssetsSource.includes('options.refreshSkybox === true'));
  assert.ok(loadProjectAssetsSource.includes('refreshCurrentSkyboxAfterProjectAssetsLoad('));

  const importStart = source.indexOf('async function handleImportSkyboxFile');
  const importEnd = source.indexOf('/** 根据当前资源库选择对应的模型', importStart);
  const importHandler = source.slice(importStart, importEnd);
  assert.ok(importHandler.includes('refreshCurrentSkyboxFromAssets([result.importedAsset])'));
  assert.doesNotMatch(source, /useEditorStore.setState/);
});

test('天空盒工具栏支持手动同步、失败重试关闭、资源库重载，且 readOnly 双重门控', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');

  assert.ok(source.includes('同步数据中台天空盒'));
  assert.ok(source.includes('isSkyboxSyncActive'));
  assert.ok(source.includes('disabled={props.readOnly || isStartingSkyboxSync || isSkyboxSyncActive || isRetryingSkyboxSync}'));
  assert.ok(source.includes('重试同步'));
  assert.ok(source.includes('重新加载资源库'));
  assert.ok(source.includes('关闭'));
  assert.ok(source.includes("activeLibrary.key === 'skybox' && skyboxSyncProgress ? ("));
  assert.ok(source.includes('role="status" aria-live="polite"'));
  assert.ok(source.includes('async function handleSyncDataPlatformSkyboxes'));
  assert.ok(source.includes('skyboxSyncControllerRef.current?.start()'));
  assert.ok(source.includes('async function handleRetryDataPlatformSkyboxSync'));
  assert.ok(source.includes('skyboxSyncControllerRef.current?.retry()'));
  const retryStart = source.indexOf('async function handleRetryDataPlatformSkyboxSync');
  const retryEnd = source.indexOf('async function handleReloadSkyboxAssets', retryStart);
  const retryHandler = source.slice(retryStart, retryEnd);
  assert.ok(retryHandler.includes('props.readOnly'));
  assert.ok(source.includes('disabled={props.readOnly || isRetryingSkyboxSync || isReloadingSkyboxAssets}'));

  const dismissStart = source.indexOf('function handleDismissDataPlatformSkyboxSyncFailure');
  const dismissEnd = source.indexOf('function handleDismissDataPlatformModelSyncFailure', dismissStart);
  const dismissHandler = source.slice(dismissStart, dismissEnd);
  assert.ok(dismissHandler.includes('dismissFailure()'));
  assert.doesNotMatch(dismissHandler, /retryDataPlatformSkyboxSync|clearDataPlatformSkyboxSyncRetryContext/);
});

test('active 与 orphaned 天空盒严格分离，当前场景只按稳定 ID 显示孤立警告', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');
  const sceneSettingsSource = readFileSync(SCENE_SETTINGS_PANEL_PATH, 'utf8');

  assert.ok(source.includes('setSkyboxAssets(result.skyboxes ?? [])'));
  assert.ok(source.includes('setOrphanedSkyboxAssets(result.orphanedSkyboxes ?? [])'));
  assert.ok(source.includes('findOrphanedSkyboxForSettings(currentSkybox, orphanedSkyboxAssets)'));
  assert.ok(source.includes('className="library-sync-status library-sync-status-warning" role="status"'));
  assert.ok(source.includes('资源已从数据中台删除'));
  assert.ok(source.includes('orphanedCurrentSkybox.displayName'));
  assert.ok(source.includes('orphanedCurrentSkybox.dataPlatformResourceId'));
  assert.ok(source.includes('当前场景继续使用本地兼容缓存，但不能用于新场景；现有场景显示不受影响，重新选择天空盒时需使用仍在资源库中的资源。'));
  const styles = readFileSync(GLOBAL_STYLE_PATH, 'utf8');
  assert.match(styles, /library-sync-status-warning/);
  assert.match(styles, /library-sync-status p[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.match(styles, /library-sync-status p[\s\S]*?white-space:\s*normal/);
  assert.ok(source.includes('createSkyboxLibraryItems(skyboxAssets)'));
  assert.ok(!source.includes('createSkyboxLibraryItems(orphanedSkyboxAssets)'));
  assert.ok(sceneSettingsSource.includes('const assets = result.skyboxes ?? [];'));
  assert.ok(sceneSettingsSource.includes('setSkyboxAssets(assets);'));
  assert.doesNotMatch(sceneSettingsSource, /orphanedSkyboxes/);
});

test('手动天空盒同步不依赖业务项目且明确不存在本地场景自动联网入口', () => {
  const projectPanelSource = readFileSync(PROJECT_PANEL_PATH, 'utf8');
  const sceneSettingsSource = readFileSync(SCENE_SETTINGS_PANEL_PATH, 'utf8');
  const projectIpcSource = readFileSync(PROJECT_IPC_PATH, 'utf8');
  const forbidden = /syncDataPlatformSkyboxesAfterLocalSceneLoad/;

  assert.doesNotMatch(projectPanelSource, forbidden);
  assert.doesNotMatch(sceneSettingsSource, forbidden);
  assert.doesNotMatch(projectIpcSource, forbidden);
  const startSyncStart = projectPanelSource.indexOf('startSync: async () => {');
  const startSyncEnd = projectPanelSource.indexOf('retrySync: async () => {', startSyncStart);
  assert.notEqual(startSyncStart, -1);
  assert.notEqual(startSyncEnd, -1);
  const startSync = projectPanelSource.slice(startSyncStart, startSyncEnd);
  assert.ok(startSync.includes('syncDataPlatformSkyboxes()'));
  assert.doesNotMatch(startSync, /projectRoot|binding/);
});
