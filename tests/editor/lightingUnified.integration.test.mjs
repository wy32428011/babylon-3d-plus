import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = await mkdtemp(path.resolve('node_modules/.lighting-unified-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
let store, initial;
after(async () => {
  if (store && initial) store.setState(initial, true);
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (path.dirname(root) !== path.resolve('node_modules') || !path.basename(root).startsWith('.lighting-unified-test-')) {
    throw new Error('统一光照测试目录越界');
  }
  await rm(root, { recursive: true, force: true });
});
const entry = path.join(root, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';",
].join('\n'));
await build({ configFile: false, publicDir: false, logLevel: 'silent',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: entry, outDir: path.join(root, 'ssr'), rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } },
});
const { useEditorStore, createEmptySceneDocument, createCommandHistory, serializeScene, deserializeScene, getSceneLightingBakeSignature }
  = await import(pathToFileURL(path.join(root, 'ssr/modules.mjs')).href);
store = useEditorStore;
initial = store.getState();
beforeEach(() => {
  store.setState(initial, true);
  store.setState({ scene: createEmptySceneDocument('统一光照验收'), history: createCommandHistory(),
    sceneSessionId: 'unified-lighting-session', runtimeMode: 'edit', hierarchySelectionIds: [], logs: [] });
});
const draft = patch => ({ baseScene: store.getState().scene, sceneSessionId: store.getState().sceneSessionId, ...patch });
const legacyKeys = ['theme', 'shadows', 'lightingBake', 'lightingPolicy', 'lightingBakeResult'];
const addMesh = () => { store.getState().createMesh('cube'); return store.getState().scene.selectedEntityId; };

test('新场景只使用版本化lighting与appearance，保存不再写旧五组配置', () => {
  const scene = store.getState().scene;
  assert.equal(scene.sceneSettings.lighting?.version, 2);
  assert.equal(scene.sceneSettings.appearance?.version, 1);
  assert.equal(scene.sceneSettings.lighting.environment?.source, 'sandbox');
  assert.equal(scene.sceneSettings.lighting.main.source, 'managed');
  assert.equal(scene.sceneSettings.lighting.main.enabled, true);
  assert.equal(scene.sceneSettings.lighting.fill.intensity, 0.8);
  assert.equal(scene.sceneSettings.lighting.environmentIntensity, 1);
  assert.equal(scene.sceneSettings.lighting.bake.enabled, true);
  const saved = JSON.parse(serializeScene(scene));
  assert.equal(saved.version, 6, '旧编辑器必须明确拒绝新格式，不能按旧阴影默认值误读');
  for (const key of legacyKeys) assert.equal(Object.hasOwn(saved.scene.sceneSettings, key), false, key);
  assert.deepEqual(deserializeScene(JSON.stringify(saved)).sceneSettings.lighting, scene.sceneSettings.lighting);
});

test('旧主题转换保留有效灯光、实体可见性、材质及业务扩展，打开不改原内容', () => {
  const mesh = addMesh();
  store.getState().createLight('directional'); const directional = store.getState().scene.selectedEntityId;
  store.getState().createLight('point'); const point = store.getState().scene.selectedEntityId;
  const raw = JSON.parse(serializeScene(store.getState().scene));
  delete raw.scene.sceneSettings.lighting; delete raw.scene.sceneSettings.appearance;
  raw.scene.customBusiness = { name: '设备业务字段', threshold: 0, enabled: false };
  raw.scene.sceneSettings.theme = { version: 1, presetId: 'industrial-daylight', environmentLighting: 'original',
    mainColor: '#ffeecc', fillColor: '#ccddee', groundColor: '#334455', environmentIntensity: 0.8,
    backgroundColor: '#101112', skyboxVisible: false, exposure: 1.4, contrast: 1.1, glowIntensity: 0.4,
    bloomEnabled: false, bloomWeight: 0.1, fogEnabled: false, fogColor: '#334455', fogStart: 100, fogEnd: 500 };
  raw.scene.sceneSettings.shadows = { enabled: false, mode: 'baked', sunAzimuthDegrees: 210,
    sunElevationDegrees: 35, sunIntensity: 0.7, fillIntensity: 0.3, iblIntensityMax: 0.45, quality: 'balanced' };
  const original = JSON.stringify(raw), entities = structuredClone(raw.scene.entities);
  const restored = deserializeScene(original);
  assert.equal(JSON.stringify(raw), original);
  assert.equal(restored.sceneSettings.lighting.version, 2);
  assert.equal(restored.sceneSettings.lighting.main.color, '#ffeecc');
  assert.equal(restored.sceneSettings.lighting.environmentIntensity, 0.45);
  assert.ok(restored.sceneSettings.lighting.disabledLightIds.includes(directional));
  assert.equal(restored.sceneSettings.lighting.disabledLightIds.includes(point), false);
  for (const id of [mesh, directional, point]) {
    assert.equal(restored.entities[id].visible, entities[id].visible);
    assert.deepEqual(restored.entities[id].components, entities[id].components);
  }
  assert.deepEqual(restored.customBusiness, raw.scene.customBusiness);
  const saved = serializeScene(restored);
  for (const key of legacyKeys) assert.equal(Object.hasOwn(JSON.parse(saved).scene.sceneSettings, key), false);
  assert.equal(serializeScene(deserializeScene(saved)), saved);
});

test('统一灯光、外观、规则和对象例外一次应用、一次撤销重做', () => {
  const id = addMesh(), state = store.getState(), before = serializeScene(state.scene);
  const lighting = state.scene.sceneSettings.lighting;
  assert.ok(lighting);
  const count = state.history.undoStack.length;
  const response = state.applyLightingManagementDraft(draft({
    lighting: { ...lighting, main: { ...lighting.main, intensity: 1.7 },
      policy: { version: 1, defaults: { castShadows: false }, rules: [] } },
    appearance: { ...state.scene.sceneSettings.appearance, exposure: 1.3 },
    entityLighting: { [id]: { mobility: 'static', castShadows: true, receiveShadows: false, bakeIndirect: true, nodeOverrides: {} } },
  }));
  assert.equal(response.ok, true);
  assert.equal(store.getState().history.undoStack.length, count + 1);
  assert.equal(store.getState().scene.sceneSettings.lighting.main.intensity, 1.7);
  assert.equal(store.getState().scene.sceneSettings.appearance.exposure, 1.3);
  const after = serializeScene(store.getState().scene);
  store.getState().undo(); assert.equal(serializeScene(store.getState().scene), before);
  store.getState().redo(); assert.equal(serializeScene(store.getState().scene), after);
});

test('纯外观改变不使烘焙输入过期，主光或补光真实变化会使其过期', () => {
  addMesh(); const original = structuredClone(store.getState().scene);
  assert.ok(original.sceneSettings.lighting);
  // 显式指定实际主光，避免用例依赖新建场景预设；只有启用主光的强度才属于烘焙输入。
  original.sceneSettings.lighting.main = { ...original.sceneSettings.lighting.main, source: 'managed', enabled: true };
  const signature = getSceneLightingBakeSignature(original);
  const change = patch => ({ ...original, sceneSettings: { ...original.sceneSettings, ...patch } });
  assert.equal(getSceneLightingBakeSignature(change({ appearance: { ...original.sceneSettings.appearance,
    exposure: 1.7, contrast: 1.3, fogEnabled: true, fogColor: '#abcdef' } })), signature);
  const lighting = original.sceneSettings.lighting;
  assert.notEqual(getSceneLightingBakeSignature(change({ lighting: { ...lighting,
    main: { ...lighting.main, intensity: lighting.main.intensity + 1 } } })), signature);
  assert.notEqual(getSceneLightingBakeSignature(change({ lighting: { ...lighting,
    fill: { ...lighting.fill, intensity: lighting.fill.intensity + 1 } } })), signature);
  const disabled = { ...lighting, main: { ...lighting.main, enabled: false } };
  assert.equal(getSceneLightingBakeSignature(change({ lighting: disabled })), getSceneLightingBakeSignature(change({ lighting: {
    ...disabled, main: { ...disabled.main, intensity: disabled.main.intensity + 1 } } })), '未启用的主光强度不属于实际烘焙输入');
});

test('普通配置草稿不能伪造、替换或清除烘焙结果', () => {
  addMesh(); const scene = store.getState().scene, before = serializeScene(scene);
  assert.ok(scene.sceneSettings.lighting);
  const response = store.getState().applyLightingManagementDraft(draft({
    lighting: { ...scene.sceneSettings.lighting, result: { signature: '伪造结果' } },
  }));
  assert.equal(response.ok, false);
  assert.match(response.message, /结果|烘焙/);
  assert.equal(serializeScene(store.getState().scene), before);
});

test('旧太阳阴影任务与旧主题直接写入口已经移除', () => {
  for (const key of ['requestShadowBake', 'completeShadowBake', 'failShadowBake', 'updateShadowSettings',
    'applySceneTheme', 'updateSceneTheme', 'clearSceneTheme']) {
    assert.equal(typeof store.getState()[key], 'undefined', key);
  }
});

test('无法识别的新光照版本明确失败，不回落旧配置', () => {
  const saved = JSON.parse(serializeScene(store.getState().scene));
  saved.scene.sceneSettings.lighting = { version: 999 };
  assert.throws(() => deserializeScene(JSON.stringify(saved)), /不支持|版本/);
});
