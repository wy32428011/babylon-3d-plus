import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.scene-theme-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const deadline = setTimeout(() => {
  console.error('场景主题集成验证超时');
  process.exit(1);
}, 120_000);
let store;
let originalState;
after(async () => {
  clearTimeout(deadline);
  if (store && originalState) store.setState(originalState, true);
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules')
    || !path.basename(temporaryRoot).startsWith('.scene-theme-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});

// 共用一次预构建和同一 Store，验证真实编辑命令及持久化链路。
const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument, sanitizeSceneEnvironment } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { createTechBlueNightTheme, TECH_BLUE_NIGHT_SHADOWS, getSceneThemePreset } from '../../src/editor/model/sceneTheme.ts';",
  "export { beginScenePreparation, skipSceneModelSync, beginSceneModelAssetRefresh, settleSceneModelAssetRefresh, settleSceneRuntimeWithWarning, allowScenePreparationEditing, getScenePreparationSnapshot } from '../../src/editor/loading/scenePreparationProgress.ts';",
  "export { WARM_WORK_LIGHT_SETTINGS } from '../../src/editor/model/lightSettings.ts';",
].join('\n'));
await build({
  configFile: false, publicDir: false, logLevel: 'silent',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: {
    ssr: entry, outDir: path.join(temporaryRoot, 'ssr'),
    rolldownOptions: { output: { entryFileNames: 'modules.mjs' } },
  },
});
const {
  useEditorStore, createEmptySceneDocument, sanitizeSceneEnvironment, createCommandHistory,
  serializeScene, deserializeScene, createTechBlueNightTheme, TECH_BLUE_NIGHT_SHADOWS, getSceneThemePreset,
  WARM_WORK_LIGHT_SETTINGS, beginScenePreparation, skipSceneModelSync, beginSceneModelAssetRefresh, settleSceneModelAssetRefresh, settleSceneRuntimeWithWarning, allowScenePreparationEditing, getScenePreparationSnapshot,
} = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
store = useEditorStore;
originalState = store.getState();
beforeEach(() => {
  settlePreparationForFixture(getScenePreparationSnapshot().sceneSessionId);
  store.setState(originalState, true);
  store.setState({
    scene: createEmptySceneDocument('科技蓝夜景验收'), history: createCommandHistory(),
    runtimeMode: 'edit', hierarchySelectionIds: [], entityClipboard: null, logs: [],
  });
});

function settlePreparationForFixture(sessionId) {
  skipSceneModelSync(sessionId, null);
  beginSceneModelAssetRefresh(sessionId, 'theme-fixture-refresh');
  settleSceneModelAssetRefresh(sessionId, null, 'theme-fixture-refresh');
  settleSceneRuntimeWithWarning(sessionId, 'Node 夹具无需等待 WebGL 首帧', true);
}

function historyLength() { return store.getState().history.undoStack.length; }
function selectedLight() {
  const { scene } = store.getState();
  return scene.entities[scene.selectedEntityId].components.light;
}
function unrelatedSettings(settings) {
  const { theme: _theme, shadows: _shadows, ...remaining } = settings;
  return remaining;
}

test('应用主题只产生一次历史记录，重复应用不增加实体或历史', () => {
  const before = structuredClone(store.getState().scene);
  store.getState().applySceneTheme();
  const applied = store.getState().scene;
  assert.equal(historyLength(), 1);
  assert.deepEqual(applied.sceneSettings.theme, createTechBlueNightTheme());
  for (const [key, value] of Object.entries(TECH_BLUE_NIGHT_SHADOWS)) assert.equal(applied.sceneSettings.shadows[key], value);
  assert.deepEqual(applied.entityIds, before.entityIds);
  assert.deepEqual(applied.entities, before.entities);
  store.getState().applySceneTheme();
  assert.equal(historyLength(), 1);
  assert.deepEqual(store.getState().scene, applied);
});

const presetIds = ['tech-blue-night', 'industrial-daylight', 'graphite-neutral', 'teal-night', 'warm-gold-dusk'];

for (const presetId of presetIds) {
  test('应用主题并保存重开具体预设：' + presetId, () => {
    store.getState().applySceneTheme(presetId);
    assert.equal(store.getState().scene.sceneSettings.theme.presetId, presetId);
    assert.equal(historyLength(), 1);
    const applied = structuredClone(store.getState().scene.sceneSettings);
    const preset = getSceneThemePreset(presetId);
    assert.deepEqual(applied.theme, preset.settings);
    for (const [key, value] of Object.entries(preset.shadows)) assert.equal(applied.shadows[key], value);
    assert.equal(store.getState().history.undoStack[0].label, '应用' + preset.name);
    assert.ok(store.getState().logs[0].message.includes(preset.name));
    store.getState().applySceneTheme(presetId);
    assert.equal(historyLength(), 1);
    store.getState().updateSceneTheme({ exposure: 1.7, fogStart: 60, fogEnd: 1600 });
    const adjusted = structuredClone(store.getState().scene.sceneSettings);
    const reopened = deserializeScene(serializeScene(store.getState().scene));
    assert.ok(adjusted.theme);
    assert.deepEqual(reopened.sceneSettings.theme, adjusted.theme);
    assert.deepEqual(reopened.sceneSettings.shadows, adjusted.shadows);
    store.getState().applySceneTheme(presetId);
    assert.deepEqual(store.getState().scene.sceneSettings, applied, '当前主题恢复对应默认值');
    assert.equal(historyLength(), 3);
    store.getState().undo();
    assert.deepEqual(store.getState().scene.sceneSettings, adjusted);
    store.getState().redo();
    assert.deepEqual(store.getState().scene.sceneSettings, applied);
  });
}

test('五套主题连续切换各产生一次历史，并保留阴影模式与质量', () => {
  const customShadows = { ...store.getState().scene.sceneSettings.shadows, enabled: false, mode: 'realtime', quality: 'quality', catcherEnabled: false, distanceMeters: 300, bias: 0.002, normalBias: 0.015 };
  store.setState({ scene: { ...store.getState().scene, sceneSettings: { ...store.getState().scene.sceneSettings, shadows: customShadows } } });
  const snapshots = [structuredClone(store.getState().scene.sceneSettings)];
  for (const presetId of presetIds) {
    store.getState().applySceneTheme(presetId);
    const settings = store.getState().scene.sceneSettings;
    for (const key of ['enabled', 'mode', 'quality', 'catcherEnabled', 'distanceMeters', 'bias', 'normalBias', 'bake']) assert.deepEqual(settings.shadows[key], customShadows[key], key);
    assert.equal(settings.theme.presetId, presetId);
    snapshots.push(structuredClone(settings));
  }
  assert.equal(historyLength(), presetIds.length);
  for (let i = snapshots.length - 2; i >= 0; i--) {
    store.getState().undo();
    assert.deepEqual(store.getState().scene.sceneSettings, snapshots[i]);
  }
  for (let i = 1; i < snapshots.length; i++) {
    store.getState().redo();
    assert.deepEqual(store.getState().scene.sceneSettings, snapshots[i]);
  }
});

for (const statePatch of [
  { environmentApplyRequest: { id: 'theme-guard-request' } },
  { environmentRuntimeSnapshot: { phase: 'loading' } },
  { shadowBakeStatus: { phase: 'baking', message: '正在生成静态阴影' } },
]) {
  test('准备中或阴影烘焙中保护主题和历史：' + Object.keys(statePatch)[0], () => {
    store.getState().applySceneTheme();
    const before = structuredClone(store.getState().scene);
    const count = historyLength();
    assert.ok(before.sceneSettings.theme);
    assert.equal(count, 1);
    store.setState(statePatch);
    store.getState().applySceneTheme('industrial-daylight');
    store.getState().updateSceneTheme({ exposure: 2 });
    store.getState().clearSceneTheme();
    assert.deepEqual(store.getState().scene, before);
    assert.equal(historyLength(), count);
    for (const [key, value] of Object.entries(statePatch)) assert.deepEqual(store.getState()[key], value);
  });
}

test('全局模型准备期间阻止主题入口，允许继续编辑后恢复', () => {
  store.getState().applySceneTheme();
  const before = structuredClone(store.getState().scene);
  const count = historyLength();
  beginScenePreparation('theme-model-preparation');
  store.getState().applySceneTheme('teal-night');
  store.getState().updateSceneTheme({ exposure: 2 });
  store.getState().clearSceneTheme();
  assert.deepEqual(store.getState().scene, before);
  assert.equal(historyLength(), count);
  settlePreparationForFixture('theme-model-preparation');
  allowScenePreparationEditing('theme-model-preparation', true);
  store.getState().applySceneTheme('teal-night');
  assert.equal(store.getState().scene.sceneSettings.theme.presetId, 'teal-night');
  assert.equal(historyLength(), count + 1);
});

test('非法预设不会破坏场景和历史，错误信息明确', () => {
  const before = structuredClone(store.getState().scene);
  store.getState().applySceneTheme('unknown-theme');
  assert.deepEqual(store.getState().scene, before);
  assert.equal(historyLength(), 0);
  assert.match(store.getState().logs[0].message, /主题|预设/);
});

test('应用、参数微调和停用都可单步撤销重做，微调不修改原始预设', () => {
  const original = structuredClone(store.getState().scene.sceneSettings);
  store.getState().applySceneTheme();
  const applied = structuredClone(store.getState().scene.sceneSettings);
  store.getState().updateSceneTheme({ exposure: 1.3, fogEnd: 950, groundColor: '#314966' });
  const adjusted = structuredClone(store.getState().scene.sceneSettings);
  assert.equal(historyLength(), 2);
  assert.equal(adjusted.theme.exposure, 1.3);
  assert.equal(createTechBlueNightTheme().exposure, applied.theme.exposure);
  store.getState().undo();
  assert.deepEqual(store.getState().scene.sceneSettings, applied);
  store.getState().undo();
  assert.deepEqual(store.getState().scene.sceneSettings, original);
  store.getState().redo();
  store.getState().redo();
  assert.deepEqual(store.getState().scene.sceneSettings, adjusted);
  store.getState().clearSceneTheme();
  assert.equal(historyLength(), 3);
  assert.equal(store.getState().scene.sceneSettings.theme, null);
  store.getState().undo();
  assert.deepEqual(store.getState().scene.sceneSettings, adjusted);
  store.getState().redo();
  assert.equal(store.getState().scene.sceneSettings.theme, null);
});

test('主题保存实际快照，重开保留手动曝光、雾和背景配置', () => {
  store.getState().applySceneTheme();
  store.getState().updateSceneTheme({ exposure: 1.3, fogStart: 75, fogEnd: 850, backgroundColor: '#0c1b30', skyboxVisible: true });
  const expected = structuredClone(store.getState().scene.sceneSettings.theme);
  assert.ok(expected);
  const content = serializeScene(store.getState().scene);
  const reopened = deserializeScene(content);
  assert.deepEqual(reopened.sceneSettings.theme, expected);
  assert.deepEqual(JSON.parse(content).scene.sceneSettings.theme, expected);
  assert.equal(store.getState().loadSceneFromContent(content, '夜景场景.json'), true);
  assert.deepEqual(store.getState().scene.sceneSettings.theme, expected);
  assert.equal(historyLength(), 0);
});

test('没有主题字段的旧场景继续保留原场景设置和旧灯光数据', () => {
  store.getState().createLight('point', { x: 3, y: 4, z: 5 });
  const id = store.getState().scene.selectedEntityId;
  const original = structuredClone(store.getState().scene);
  const file = JSON.parse(serializeScene(original));
  delete file.scene.sceneSettings.theme;
  const reopened = deserializeScene(JSON.stringify(file));
  assert.equal(reopened.sceneSettings.theme ?? null, null);
  assert.deepEqual(unrelatedSettings(reopened.sceneSettings), unrelatedSettings(original.sceneSettings));
  assert.deepEqual(reopened.sceneSettings.shadows, original.sceneSettings.shadows);
  assert.deepEqual(reopened.entities[id].components.light, original.entities[id].components.light);
  assert.equal('color' in reopened.entities[id].components.light, false);
  assert.equal('range' in reopened.entities[id].components.light, false);
});

test('主题切换保留环境、实体、业务配置及其它相机设置', () => {
  const environment = sanitizeSceneEnvironment({
    packagePath: 'C:/fixture/environment', activeVariantUrl: 'editor-asset://local/factory.glb',
    variants: [{ name: '默认预设', sourcePath: 'C:/fixture/environment/factory.glb', sourceUrl: 'editor-asset://local/factory.glb' }],
  });
  store.getState().updateEnvironmentConfig(environment);
  store.getState().createMesh('cube', { x: 5, y: 2, z: 3 });
  store.getState().createLight('point', { x: 5, y: 8, z: 3 });
  store.getState().updateSelectedLight(WARM_WORK_LIGHT_SETTINGS);
  const before = structuredClone(store.getState().scene);
  for (const action of [
    () => store.getState().applySceneTheme(),
    () => store.getState().updateSceneTheme({ exposure: 1.2 }),
    () => store.getState().clearSceneTheme(),
    () => store.getState().undo(),
  ]) {
    action();
    const current = store.getState().scene;
    assert.deepEqual(current.entities, before.entities);
    assert.deepEqual(current.entityIds, before.entityIds);
    assert.deepEqual(current.mqttConfig, before.mqttConfig);
    assert.deepEqual(current.fetchConfig, before.fetchConfig);
    assert.deepEqual(unrelatedSettings(current.sceneSettings), unrelatedSettings(before.sceneSettings));
  }
});

test('预览模式拦截应用、微调和停用，主题及历史保持不变', () => {
  store.getState().applySceneTheme();
  const before = structuredClone(store.getState().scene);
  const count = historyLength();
  store.setState({ runtimeMode: 'preview' });
  store.getState().applySceneTheme();
  store.getState().updateSceneTheme({ exposure: 2 });
  store.getState().clearSceneTheme();
  assert.deepEqual(store.getState().scene, before);
  assert.equal(historyLength(), count);
});

test('无效或相同微调不增加历史，非法主题文件不能静默加载', () => {
  store.getState().applySceneTheme();
  const before = structuredClone(store.getState().scene);
  const count = historyLength();
  store.getState().updateSceneTheme({ exposure: before.sceneSettings.theme.exposure });
  store.getState().updateSceneTheme({ exposure: NaN });
  store.getState().updateSceneTheme({ fogEnd: before.sceneSettings.theme.fogStart });
  assert.deepEqual(store.getState().scene, before);
  assert.equal(historyLength(), count);
  const file = JSON.parse(serializeScene(before));
  file.scene.sceneSettings.theme.version = 999;
  assert.throws(() => deserializeScene(JSON.stringify(file)));
});

test('暖白作业灯新增参数支持编辑撤销、复制粘贴与保存重开', () => {
  store.getState().createLight('point', { x: 8, y: 6, z: 2 });
  const original = structuredClone(selectedLight());
  const transform = structuredClone(store.getState().scene.entities[store.getState().scene.selectedEntityId].components.transform);
  store.getState().updateSelectedLight(WARM_WORK_LIGHT_SETTINGS);
  assert.deepEqual(selectedLight(), WARM_WORK_LIGHT_SETTINGS);
  assert.deepEqual(store.getState().scene.entities[store.getState().scene.selectedEntityId].components.transform, transform);
  store.getState().undo();
  assert.deepEqual(selectedLight(), original);
  store.getState().redo();
  assert.deepEqual(selectedLight(), WARM_WORK_LIGHT_SETTINGS);
  store.getState().copySelectedEntities();
  store.getState().pasteEntityClipboard();
  const copyId = store.getState().scene.selectedEntityId;
  assert.deepEqual(selectedLight(), WARM_WORK_LIGHT_SETTINGS);
  const reopened = deserializeScene(serializeScene(store.getState().scene));
  assert.deepEqual(reopened.entities[copyId].components.light, WARM_WORK_LIGHT_SETTINGS);
  store.getState().updateSelectedLight({ range: undefined });
  assert.equal('range' in selectedLight(), false);
  store.getState().undo();
  assert.equal(selectedLight().range, WARM_WORK_LIGHT_SETTINGS.range);
  store.getState().createLight('hemispheric');
  store.getState().updateSelectedLight({ color: '#829ec7', groundColor: '#293b55', nightBehavior: 'dim' });
  const hemiId = store.getState().scene.selectedEntityId;
  assert.deepEqual(deserializeScene(serializeScene(store.getState().scene)).entities[hemiId].components.light, selectedLight());
});
