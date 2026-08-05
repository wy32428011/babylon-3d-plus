import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PROJECT_PANEL_PATH = 'src/editor/panels/ProjectPanel.tsx';
const PROJECT_LIBRARY_PATH = 'src/editor/assets/projectLibrary.ts';
const INSPECTOR_PANEL_PATH = 'src/editor/panels/InspectorPanel.tsx';
const POI_EFFECT_INSPECTOR_PATH = 'src/editor/panels/PoiEffectInspector.tsx';

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
