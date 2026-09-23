import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.stacker-arrows-editor-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
let store;
let originalState;
after(async () => {
  if (store && originalState) store.setState(originalState, true);
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules')
    || !path.basename(temporaryRoot).startsWith('.stacker-arrows-editor-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});

const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument, createModelEntity } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { createDefaultStackerMotionArrowsConfig } from '../../src/editor/model/stackerMotionArrows.ts';",
  "export { normalizeTelemetryBindingComponent } from '../../src/editor/model/telemetryBinding.ts';",
  "export { stackerMotionArrowSession } from '../../src/runtime/stackerMotionArrowSession.ts';",
  "export { readConveyorSurfaceArrowStyleDrop } from '../../src/editor/assets/conveyorSurfaceArrowDrag.ts';",
  "export { BUILT_IN_ASSET_DRAG_MIME_TYPE, encodeBuiltInAssetDragPayload } from '../../src/editor/assets/AssetDatabase.ts';",
].join('\n'));
await build({
  configFile: false, publicDir: false, logLevel: 'silent',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: entry, outDir: path.join(temporaryRoot, 'ssr'),
    rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } },
});
const {
  useEditorStore, createEmptySceneDocument, createModelEntity, createCommandHistory,
  serializeScene, deserializeScene, createDefaultStackerMotionArrowsConfig,
  normalizeTelemetryBindingComponent, stackerMotionArrowSession,
  readConveyorSurfaceArrowStyleDrop, BUILT_IN_ASSET_DRAG_MIME_TYPE, encodeBuiltInAssetDragPayload,
} = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
store = useEditorStore;
originalState = store.getState();

beforeEach(() => {
  store.setState(originalState, true);
  const scene = createEmptySceneDocument('堆垛机运动箭头验收');
  const entity = createModelEntity('model.glb', 'editor-asset://local/model.glb', '堆垛机');
  entity.components.modelAsset.dataDrivenConfig = { device: { devType: 'stacker' }, fixedNodes: [] };
  entity.components.telemetryBinding = normalizeTelemetryBindingComponent({ deviceType: 'stacker' });
  scene.entityIds.push(entity.id);
  scene.entities[entity.id] = entity;
  scene.selectedEntityId = entity.id;
  store.setState({ scene, history: createCommandHistory(), runtimeMode: 'edit',
    hierarchySelectionIds: [entity.id], entityClipboard: null, logs: [] });
  stackerMotionArrowSession.clear();
});

function selectedBinding() {
  const { scene } = store.getState();
  return scene.entities[scene.selectedEntityId].components.telemetryBinding;
}
function configure(patch = {}) {
  const config = { ...createDefaultStackerMotionArrowsConfig(), enabled: true, ...patch };
  store.getState().updateSelectedTelemetryBinding({ ...selectedBinding(), stackerMotionArrows: config });
}

test('四路运动箭头配置走编辑命令并支持撤销重做，恢复默认不自动启用', () => {
  const before = structuredClone(selectedBinding());
  const defaults = createDefaultStackerMotionArrowsConfig();
  configure({ speed: 0, channels: { ...defaults.channels, lift: { ...defaults.channels.lift, surfaceNode: 'Mast', reverse: true } } });
  assert.equal(selectedBinding().stackerMotionArrows.enabled, true);
  assert.equal(selectedBinding().stackerMotionArrows.speed, 0);
  assert.equal(selectedBinding().stackerMotionArrows.channels.lift.surfaceNode, 'Mast');
  const configured = structuredClone(selectedBinding());
  assert.equal(store.getState().history.undoStack.length, 1);
  store.getState().undo();
  assert.deepEqual(selectedBinding(), before);
  store.getState().redo();
  assert.deepEqual(selectedBinding(), configured);
  store.getState().restoreSelectedTelemetryBindingDefault();
  assert.equal(selectedBinding().stackerMotionArrows, undefined);
  store.getState().undo();
  assert.deepEqual(selectedBinding(), configured);
});

test('保存重开保留四路配置与关闭状态，旧场景缺省不启用，临时预览诊断不入场景', () => {
  configure({ enabled: false, speed: 0 });
  const { scene } = store.getState();
  const id = scene.selectedEntityId;
  const configured = structuredClone(selectedBinding().stackerMotionArrows);
  stackerMotionArrowSession.setPreview(id, 'travel', -1);
  stackerMotionArrowSession.setDiagnostic(id, 'lift', '临时诊断不应入场景');
  const content = serializeScene(scene);
  assert.equal(content.includes('临时诊断不应入场景'), false);
  assert.deepEqual(deserializeScene(content).entities[id].components.telemetryBinding.stackerMotionArrows, configured);
  assert.equal(configured.enabled, false);
  const legacy = JSON.parse(content);
  delete legacy.scene.entities[id].components.telemetryBinding.stackerMotionArrows;
  assert.equal(deserializeScene(JSON.stringify(legacy)).entities[id].components.telemetryBinding.stackerMotionArrows, undefined);
});

test('复制后的四路配置可独立编辑，不复用预览状态', () => {
  configure({ color: '#112233' });
  const originalId = store.getState().scene.selectedEntityId;
  stackerMotionArrowSession.setPreview(originalId, 'travel', 1);
  const configured = structuredClone(selectedBinding().stackerMotionArrows);
  store.getState().copySelectedEntities();
  store.getState().pasteEntityClipboard();
  const copyId = store.getState().scene.selectedEntityId;
  assert.notEqual(copyId, originalId);
  assert.deepEqual(selectedBinding().stackerMotionArrows, configured);
  assert.equal(stackerMotionArrowSession.getPreview(copyId, 'travel'), null);
  configure({ color: '#aabbcc', channels: { ...configured.channels, frontFork: { ...configured.channels.frontFork, enabled: false } } });
  const original = store.getState().scene.entities[originalId].components.telemetryBinding.stackerMotionArrows;
  assert.equal(original.color, '#112233');
  assert.equal(original.channels.frontFork.enabled, true);
  assert.equal(selectedBinding().stackerMotionArrows.channels.frontFork.enabled, false);
});

test('运行预览阻止配置修改，保持场景和命令历史', () => {
  configure();
  const before = structuredClone(store.getState().scene);
  const count = store.getState().history.undoStack.length;
  store.setState({ runtimeMode: 'preview' });
  configure({ color: '#ffffff' });
  store.getState().restoreSelectedTelemetryBindingDefault();
  assert.deepEqual(store.getState().scene, before);
  assert.equal(store.getState().history.undoStack.length, count);
});

test('拖入箭头样式只更新外观，可撤销，不创建新实体或改变设备绑定', () => {
  configure({ color: '#112233', breathingPeriod: 2.7, breathingStrength: 0 });
  const before = structuredClone(selectedBinding());
  const beforeIds = [...store.getState().scene.entityIds];
  const payload = encodeBuiltInAssetDragPayload({ kind: 'poi-effect', effectKind: 'conveyor-arrow-chevron' });
  const style = readConveyorSurfaceArrowStyleDrop({ types: [BUILT_IN_ASSET_DRAG_MIME_TYPE], files: { length: 0 }, getData: () => payload });
  assert.equal(style, 'conveyor-arrow-chevron');
  store.getState().updateSelectedTelemetryBinding({ ...before, stackerMotionArrows: { ...before.stackerMotionArrows, style } });
  assert.deepEqual(store.getState().scene.entityIds, beforeIds);
  assert.deepEqual(selectedBinding(), { ...before, stackerMotionArrows: { ...before.stackerMotionArrows, style } });
  store.getState().undo();
  assert.deepEqual(selectedBinding(), before);
  store.getState().redo();
  const scene = store.getState().scene;
  assert.deepEqual(deserializeScene(serializeScene(scene)).entities[scene.selectedEntityId].components.telemetryBinding, selectedBinding());
});
