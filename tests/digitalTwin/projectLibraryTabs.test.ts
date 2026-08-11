import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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

test('特效库紧跟 POI 库并承载全部内置 EFF，POI 库仅保留六个指定入口', () => {
  const source = readFileSync(PROJECT_LIBRARY_PATH, 'utf8');
  const poiLibrary = readProjectLibraryDefinition(source, 'poi');
  const effectLibrary = readProjectLibraryDefinition(source, 'effect');
  const poiIndex = source.indexOf("    key: 'poi',");
  const effectIndex = source.indexOf("    key: 'effect',");
  const themeIndex = source.indexOf("    key: 'theme',");

  assert.ok(poiIndex < effectIndex && effectIndex < themeIndex, '特效库应位于 POI 库与主题库之间');
  assert.deepEqual(
    [...poiLibrary.matchAll(/id: '(poi-[^']+)'/g)].map((match) => match[1]),
    ['poi-auto-patrol', 'poi-model-generator', 'poi-chart-marker', 'poi-panel', 'poi-alarm', 'poi-roam'],
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
  assert.ok(inspectorSource.includes("modelGenerator || autoPatrol ? 'POI名称'"));
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
  assert.match(store, /return \{ projectRoot: null, assets: \[\], skyboxes: \[\], orphanedSkyboxes: \[\] \};/);
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
