import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'vite';

const temporary = await mkdtemp(path.resolve('node_modules/.glb-preview-manager-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const cleanupState = { store: null, originalState: null };
after(async () => {
  if (cleanupState.store && cleanupState.originalState) cleanupState.store.setState(cleanupState.originalState, true);
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (path.dirname(temporary) !== path.resolve('node_modules') || !path.basename(temporary).startsWith('.glb-preview-manager-test-')) {
    throw new Error('GLB预览测试临时目录不在预期范围');
  }
  await rm(temporary, { recursive: true, force: true });
});
const entry = path.join(temporary, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument, createSkyboxEntity } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { createLightingManagerDraft, applyLightingManagerPreset, isLightingManagerDraftDirty } from '../../src/editor/panels/lightingBakeManagerModel.ts';",
  "export { LightingBakeManagerLighting } from '../../src/editor/panels/LightingBakeManagerLighting.tsx';",
].join('\n'));
await build({ configFile: false, publicDir: false, logLevel: 'silent',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: entry, outDir: path.join(temporary, 'ssr'), rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } },
});
const { useEditorStore, createEmptySceneDocument, createSkyboxEntity, createCommandHistory, serializeScene, deserializeScene,
  createLightingManagerDraft, applyLightingManagerPreset, isLightingManagerDraftDirty, LightingBakeManagerLighting }
  = await import(pathToFileURL(path.join(temporary, 'ssr/modules.mjs')).href);
const store = useEditorStore;
const originalState = store.getState();
Object.assign(cleanupState, { store, originalState });
const presetId = 'glb-standard-preview';

beforeEach(() => {
  store.setState(originalState, true);
  const scene = createEmptySceneDocument('已有场景的 GLB 预览回归');
  scene.sceneSettings.lighting = { ...scene.sceneSettings.lighting,
    main: { ...scene.sceneSettings.lighting.main, enabled: true, intensity: 1.7 },
    fill: { ...scene.sceneSettings.lighting.fill, intensity: 0.45 }, environmentIntensity: 0.65,
    environment: { source: 'scene', rotationDegrees: 0 }, allowDayNightCycle: true,
    shadows: { ...scene.sceneSettings.lighting.shadows, enabled: true }, disabledLightIds: ['saved-disabled'],
  };
  scene.sceneSettings.appearance = { ...scene.sceneSettings.appearance, exposure: 1.4, contrast: 1.2,
    skyboxVisible: true, toneMappingEnabled: true, bloomEnabled: true, fogEnabled: true };
  store.setState({ scene, history: createCommandHistory(), sceneSessionId: 'glb-preview-session', runtimeMode: 'edit',
    hierarchySelectionIds: [], logs: [] });
});

test('打开管理器保留已有照明和显示，未选择标准预览时不改场景', () => {
  const state = store.getState(), before = serializeScene(state.scene);
  const draft = createLightingManagerDraft(state.scene, state.sceneSessionId);
  assert.equal(draft.lighting.environment?.source, 'scene');
  assert.equal(draft.lighting.main.intensity, 1.7);
  assert.equal(draft.appearance.exposure, 1.4);
  assert.equal(isLightingManagerDraftDirty(draft), false);
  assert.equal(serializeScene(store.getState().scene), before);
  assert.equal(store.getState().history.undoStack.length, 0);
});

test('GLB标准预览同时暂存照明与显示，保留规则、烘焙资产、扩展和实体例外', () => {
  store.getState().createLight('point');
  const state = store.getState(), lightId = state.scene.selectedEntityId;
  const draft = createLightingManagerDraft(state.scene, state.sceneSessionId);
  draft.lighting.policy = { version: 1, defaults: {}, rules: [
    { id: 'preserved-rule', enabled: true, target: { kind: 'all' }, values: { castShadows: false } },
  ] };
  draft.lighting.result = { version: 1, signature: 'lighting-v2:previous-input', createdAt: '2026-10-21T00:00:00.000Z', engineVersion: 'test',
    assets: ['geometry', 'lightmap', 'probes'].map(kind => ({ id: kind, kind, url: 'editor-asset://local/' + kind, byteLength: 4 })),
    surfaces: [{ key: 'machine/root', entityId: 'machine', nodeKey: 'root', geometryAssetId: 'geometry', lightmapAssetId: 'lightmap' }],
    probeAssetId: 'probes', statistics: { meshCount: 1, triangleCount: 12, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 1 } };
  draft.lighting.metadata = { author: 'existing' };
  draft.appearance.metadata = { purpose: 'existing' };
  draft.entityLighting[lightId] = null;
  const beforeScene = serializeScene(state.scene), beforeDraft = structuredClone(draft);
  const next = applyLightingManagerPreset(draft, presetId, 'lighting');
  assert.equal(next.lighting.environment?.source, 'sandbox');
  assert.ok(Math.abs(next.lighting.environment.rotationDegrees - 5.54 * 180 / Math.PI) < 1e-8);
  assert.equal(next.lighting.main.source, 'managed');
  assert.equal(next.lighting.main.enabled, false);
  assert.equal(next.lighting.fill.intensity, 0);
  assert.equal(next.lighting.environmentIntensity, 1);
  assert.equal(next.lighting.shadows.enabled, false);
  assert.equal(next.lighting.allowDayNightCycle, false);
  assert.deepEqual(new Set(next.lighting.disabledLightIds), new Set(['saved-disabled', lightId]));
  assert.equal(next.appearance.exposure, 1);
  assert.equal(next.appearance.contrast, 1);
  for (const field of ['skyboxVisible', 'toneMappingEnabled', 'bloomEnabled', 'fogEnabled']) assert.equal(next.appearance[field], false, field);
  assert.deepEqual(next.lighting.bake, { ...draft.lighting.bake, enabled: false });
  assert.deepEqual(next.lighting.policy, draft.lighting.policy);
  assert.deepEqual(next.lighting.result, draft.lighting.result);
  assert.deepEqual(next.entityLighting, draft.entityLighting);
  assert.deepEqual(next.lighting.metadata, { author: 'existing' });
  assert.deepEqual(next.appearance.metadata, { purpose: 'existing' });
  assert.deepEqual(draft, beforeDraft, '选择预设不能原地污染旧草稿');
  assert.equal(serializeScene(store.getState().scene), beforeScene, '未应用的草稿不得写进场景');
  assert.equal(isLightingManagerDraftDirty(next), true);
});

test('标准预览通过现有事务一次应用、一次撤销，并随保存重开保留环境来源', () => {
  store.getState().createLight('point');
  const state = store.getState(), before = serializeScene(state.scene), undoCount = state.history.undoStack.length;
  const draft = applyLightingManagerPreset(createLightingManagerDraft(state.scene, state.sceneSessionId), presetId, 'lighting');
  assert.equal(serializeScene(store.getState().scene), before);
  assert.equal(state.applyLightingManagementDraft(draft).ok, true);
  const applied = store.getState();
  assert.equal(applied.history.undoStack.length, undoCount + 1);
  assert.equal(applied.scene.sceneSettings.lighting.environment?.source, 'sandbox');
  assert.equal(applied.scene.sceneSettings.appearance.exposure, 1);
  assert.equal(applied.scene.sceneSettings.appearance.toneMappingEnabled, false);
  const saved = serializeScene(applied.scene), reopened = deserializeScene(saved);
  assert.equal(reopened.sceneSettings.lighting.environment?.source, 'sandbox');
  assert.equal(reopened.sceneSettings.appearance.exposure, 1);
  store.getState().undo();
  assert.equal(serializeScene(store.getState().scene), before);
  store.getState().redo();
  assert.equal(serializeScene(store.getState().scene), saved);
});

test('照明表单显示标准预览、来源与未配置提示，不把来源选择伪装成加载完成', () => {
  const scene = store.getState().scene;
  const render = lighting => renderToStaticMarkup(createElement(LightingBakeManagerLighting,
    { scene, lighting, disabled: false, onChange() {}, onPreset() {} }));
  const configured = render(scene.sceneSettings.lighting);
  assert.match(configured, /GLB 标准预览（对齐 Sandbox）/);
  assert.match(configured, /aria-label="环境照明来源"/);
  assert.match(configured, /环境照明与反射强度/);
  assert.match(configured, /未配置场景天空盒/);
  assert.doesNotMatch(configured, /aria-label="环境旋转"/);
  const sandbox = render({ ...scene.sceneSettings.lighting, environment: { source: 'sandbox', rotationDegrees: 20 } });
  assert.match(sandbox, /aria-label="环境旋转"/);
  assert.match(sandbox, /value="20"/);
  assert.doesNotMatch(sandbox, /未配置场景天空盒|已加载|加载完成/);
  assert.match(sandbox, /同时.*照明.*显示/);
});

test('新建场景增加标准环境且保留基础对象照明，旧场景不自动注入标准环境', () => {
  const fresh = createEmptySceneDocument('新的 GLB 场景');
  assert.equal(fresh.sceneSettings.lighting.environment?.source, 'sandbox');
  assert.equal(fresh.sceneSettings.lighting.main.source, 'managed');
  assert.equal(fresh.sceneSettings.lighting.main.enabled, true);
  assert.equal(fresh.sceneSettings.lighting.fill.intensity, 0.8);
  assert.equal(fresh.sceneSettings.lighting.bake.enabled, true);
  assert.equal(fresh.sceneSettings.appearance.skyboxVisible, true);
  const restored = deserializeScene(JSON.stringify({ version: 5, units: { length: 'meter' },
    scene: { id: 'legacy-without-settings', name: '旧场景', entityIds: [], entities: {} } }));
  assert.equal(restored.sceneSettings.lighting.environment?.source ?? 'scene', 'scene');
});

test('场景天空盒实体是实际环境来源，不误报为尚未配置', () => {
  const scene = structuredClone(store.getState().scene);
  const skybox = createSkyboxEntity({ packagePath: 'skybox', sourcePath: 'skybox/studio.hdr',
    sourceUrl: 'editor-asset://local/studio.hdr', format: 'hdr', rotationDegrees: 25, intensity: 1, resolution: 256 });
  scene.entityIds.push(skybox.id);
  scene.entities[skybox.id] = skybox;
  scene.sceneSettings.skybox = null;
  const html = renderToStaticMarkup(createElement(LightingBakeManagerLighting,
    { scene, lighting: scene.sceneSettings.lighting, disabled: false, onChange() {}, onPreset() {} }));
  assert.doesNotMatch(html, /未配置场景天空盒/);
  assert.match(html, /环境资源与旋转沿用场景天空盒配置/);
});
