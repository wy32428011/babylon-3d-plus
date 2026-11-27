import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.warehouse-quick-lighting-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };

let store;
let originalState;

after(async () => {
  if (store && originalState) store.setState(originalState, true);
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules')
    || !path.basename(temporaryRoot).startsWith('.warehouse-quick-lighting-test-')) {
    throw new Error('测试临时目录范围无效');
  }
  await rm(temporaryRoot, { recursive: true, force: true });
});

const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { applyWarehouseLightingPreset, applyWarehouseQualityTier } from '../../electron/shared/warehouseLightingPresets.ts';",
].join('\n'));

await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: {
    ssr: entry,
    outDir: path.join(temporaryRoot, 'ssr'),
    rolldownOptions: { output: { entryFileNames: 'modules.mjs' } },
  },
});

const {
  useEditorStore,
  createEmptySceneDocument,
  createCommandHistory,
  serializeScene,
  deserializeScene,
  applyWarehouseLightingPreset,
  applyWarehouseQualityTier,
} = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);

store = useEditorStore;
originalState = store.getState();

beforeEach(() => {
  store.setState(originalState, true);
  store.setState({
    scene: createEmptySceneDocument('仓储实时光照单测'),
    history: createCommandHistory(),
    sceneSessionId: 'warehouse-quick-lighting-session',
    runtimeMode: 'edit',
    hierarchySelectionIds: [],
    logs: [],
  });
});

function addMesh() {
  store.getState().createMesh('cube');
  return store.getState().scene.selectedEntityId;
}

test('applyQuickLightingUpdate 支持仓储一键预设、画质档切换、持久化与一次撤销重做', () => {
  const before = serializeScene(store.getState().scene);
  const startUndo = store.getState().history.undoStack.length;

  const applied = store.getState().applyQuickLightingUpdate(
    '应用仓储预设：明亮洁净仓',
    ({ lighting, appearance }) => applyWarehouseLightingPreset(lighting, appearance, 'warehouse-bright'),
  );
  assert.equal(applied.ok, true);
  assert.equal(store.getState().history.undoStack.length, startUndo + 1);

  const scene = store.getState().scene;
  assert.equal(scene.sceneSettings.lighting.bake.enabled, false);
  assert.equal(scene.sceneSettings.lighting.shadows.managementMode, 'automatic');
  assert.equal(scene.sceneSettings.lighting.environment?.preset, 'warehouse-bright');
  assert.equal(scene.sceneSettings.appearance.toneMappingEnabled, true);
  assert.equal(scene.sceneSettings.appearance.ssaoMode, 'balanced');

  const restored = deserializeScene(serializeScene(scene));
  assert.deepEqual(restored.sceneSettings.lighting, scene.sceneSettings.lighting);
  assert.deepEqual(restored.sceneSettings.appearance, scene.sceneSettings.appearance);

  const tierResult = store.getState().applyQuickLightingUpdate(
    '切换画质：流畅',
    ({ lighting, appearance }) => applyWarehouseQualityTier(lighting, appearance, 'performance'),
  );
  assert.equal(tierResult.ok, true);
  assert.equal(store.getState().scene.sceneSettings.lighting.shadows.receiverScope, 'ground-only');
  assert.equal(store.getState().scene.sceneSettings.lighting.shadows.mobileBlobShadows, true);
  assert.equal(store.getState().scene.sceneSettings.appearance.ssaoMode, undefined);

  store.getState().undo();
  assert.equal(store.getState().scene.sceneSettings.appearance.ssaoMode, 'balanced');
  store.getState().undo();
  assert.equal(serializeScene(store.getState().scene), before);
  store.getState().redo();
  assert.equal(store.getState().scene.sceneSettings.lighting.environment?.preset, 'warehouse-bright');
});

test('applyQuickLightingUpdate 在运行预览和烘焙进行中拒绝修改', () => {
  const before = serializeScene(store.getState().scene);

  store.setState({ runtimeMode: 'preview' });
  const previewResult = store.getState().applyQuickLightingUpdate(
    '应用仓储预设',
    ({ lighting, appearance }) => applyWarehouseLightingPreset(lighting, appearance, 'warehouse-bright'),
  );
  assert.equal(previewResult.ok, false);
  assert.equal(serializeScene(store.getState().scene), before);

  store.setState({ runtimeMode: 'edit', lightingBakeRequest: { id: 'bake-1' } });
  const bakeResult = store.getState().applyQuickLightingUpdate(
    '应用仓储预设',
    ({ lighting, appearance }) => applyWarehouseLightingPreset(lighting, appearance, 'warehouse-bright'),
  );
  assert.equal(bakeResult.ok, false);
  assert.equal(serializeScene(store.getState().scene), before);
});

test('updateEntityQuickShadowOverride 在全自动阴影下启用例外尊重、保留其余字段继承并支持撤销', () => {
  const roofId = addMesh();
  const lockedId = addMesh();
  store.getState().applyQuickLightingUpdate(
    '开启自动阴影',
    ({ lighting }) => ({
      lighting: {
        ...lighting,
        shadows: { ...lighting.shadows, managementMode: 'automatic' },
      },
    }),
  );
  const current = store.getState().scene;
  store.setState({
    scene: {
      ...current,
      entities: {
        ...current.entities,
        [lockedId]: { ...current.entities[lockedId], locked: true },
      },
    },
  });

  const before = serializeScene(store.getState().scene);
  const undoCount = store.getState().history.undoStack.length;

  store.getState().updateEntityQuickShadowOverride([roofId, lockedId], 'castShadows', false);
  assert.equal(store.getState().history.undoStack.length, undoCount + 1);

  const updated = store.getState().scene;
  assert.equal(updated.sceneSettings.lighting.shadows.respectEntityShadowOverrides, true);
  assert.equal(updated.entities[roofId].components.lighting?.castShadows, false);
  assert.deepEqual(updated.entities[roofId].components.lighting?.inheritPolicy, ['mobility', 'receiveShadows', 'bakeIndirect']);
  assert.equal(updated.entities[lockedId].components.lighting, undefined);

  const reopened = deserializeScene(serializeScene(updated));
  assert.equal(reopened.entities[roofId].components.lighting?.castShadows, false);
  assert.equal(reopened.sceneSettings.lighting.shadows.respectEntityShadowOverrides, true);

  store.getState().undo();
  assert.equal(serializeScene(store.getState().scene), before);
});
