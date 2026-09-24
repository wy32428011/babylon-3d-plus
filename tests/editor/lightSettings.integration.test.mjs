import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.light-settings-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const deadline = setTimeout(() => {
  console.error('光源集成验证超时');
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
    || !path.basename(temporaryRoot).startsWith('.light-settings-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});

// 共用一次预构建和同一 Store，验证真实编辑命令及持久化链路。
const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { encodeBuiltInAssetDragPayload, decodeBuiltInAssetDragPayload } from '../../src/editor/assets/AssetDatabase.ts';",
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
  useEditorStore, createEmptySceneDocument, createCommandHistory,
  serializeScene, deserializeScene,
  encodeBuiltInAssetDragPayload, decodeBuiltInAssetDragPayload,
} = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
store = useEditorStore;
originalState = store.getState();
beforeEach(() => {
  store.setState(originalState, true);
  store.setState({
    scene: createEmptySceneDocument('光源编辑验收'), history: createCommandHistory(),
    runtimeMode: 'edit', hierarchySelectionIds: [], entityClipboard: null, logs: [],
  });
});


function selectedLight() {
  const { scene } = store.getState();
  return scene.entities[scene.selectedEntityId].components.light;
}

for (const [kind, patch] of [
  ['spot', { angle: Math.PI / 4, exponent: 3.5, range: 24 }],
  ['rectArea', { width: 6.5, height: 1.2 }],
]) {
  test(kind + ' 参数单独编辑、撤销重做、保存重载完整保留', () => {
    store.getState().createLight(kind);
    const initial = structuredClone(selectedLight());
    for (const [field, value] of Object.entries(patch)) {
      store.getState().updateSelectedLight({ [field]: value });
      assert.equal(selectedLight()[field], value);
    }
    const adjusted = structuredClone(selectedLight());
    for (let i = 0; i < Object.keys(patch).length; i++) store.getState().undo();
    assert.deepEqual(selectedLight(), initial);
    for (let i = 0; i < Object.keys(patch).length; i++) store.getState().redo();
    assert.deepEqual(selectedLight(), adjusted);
    const scene = store.getState().scene;
    const restored = deserializeScene(serializeScene(scene));
    assert.deepEqual(restored.entities[scene.selectedEntityId].components.light, adjusted);
    const length = store.getState().history.undoStack.length;
    store.getState().updateSelectedLight(patch);
    assert.equal(store.getState().history.undoStack.length, length);
  });
}

test('旧三类光源保存不注入新增字段，强度零保留，未知类型拒绝读取', () => {
  for (const kind of ['hemispheric', 'directional', 'point']) {
    store.getState().createLight(kind);
    store.getState().updateSelectedLight({ intensity: 0 });
    assert.deepEqual(selectedLight(), { lightKind: kind, intensity: 0 });
  }
  const document = store.getState().scene;
  const saved = serializeScene(document);
  const restored = deserializeScene(saved);
  for (const id of document.entityIds) assert.deepEqual(restored.entities[id].components, document.entities[id].components);
  const broken = JSON.parse(saved);
  broken.scene.entities[document.selectedEntityId].components.light.lightKind = 'unsupported';
  assert.throws(() => deserializeScene(JSON.stringify(broken)));
});


test('五类光源的拖拽协议与创建入口一致，拒绝伪造光源', () => {
  for (const lightKind of ['directional', 'spot', 'point', 'hemispheric', 'rectArea']) {
    const payload = { kind: 'light', lightKind };
    assert.deepEqual(decodeBuiltInAssetDragPayload(encodeBuiltInAssetDragPayload(payload)), payload);
  }
  assert.equal(decodeBuiltInAssetDragPayload(JSON.stringify({ kind: 'light', lightKind: 'ibl' })), null);
});
