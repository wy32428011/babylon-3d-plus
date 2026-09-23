import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.conveyor-arrows-editor-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
let store;
let originalState;
after(async () => {
  if (store && originalState) store.setState(originalState, true);
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules')
    || !path.basename(temporaryRoot).startsWith('.conveyor-arrows-editor-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});

const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument, createModelEntity } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { createDefaultConveyorSurfaceArrowsConfig } from '../../src/editor/model/conveyorSurfaceArrows.ts';",
  "export { normalizeTelemetryBindingComponent } from '../../src/editor/model/telemetryBinding.ts';",
  "export { conveyorSurfaceArrowSession } from '../../src/runtime/conveyorSurfaceArrowSession.ts';",
  "export { readConveyorSurfaceArrowStyleDrop } from '../../src/editor/assets/conveyorSurfaceArrowDrag.ts';",
  "export { BUILT_IN_ASSET_DRAG_MIME_TYPE, encodeBuiltInAssetDragPayload } from '../../src/editor/assets/AssetDatabase.ts';",
  "export { getConveyorSurfaceArrowDirectionError } from '../../src/editor/model/conveyorSurfaceArrows.ts';",
].join('\n'));
await build({
  configFile: false, publicDir: false, logLevel: 'silent',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: entry, outDir: path.join(temporaryRoot, 'ssr'),
    rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } },
});
const {
  useEditorStore, createEmptySceneDocument, createModelEntity, createCommandHistory,
  serializeScene, deserializeScene, createDefaultConveyorSurfaceArrowsConfig,
  normalizeTelemetryBindingComponent, conveyorSurfaceArrowSession,
  readConveyorSurfaceArrowStyleDrop, BUILT_IN_ASSET_DRAG_MIME_TYPE,
  encodeBuiltInAssetDragPayload, getConveyorSurfaceArrowDirectionError,
} = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
store = useEditorStore;
originalState = store.getState();

beforeEach(() => {
  store.setState(originalState, true);
  const scene = createEmptySceneDocument('输送线表面箭头验收');
  const entity = createModelEntity('model.glb', 'editor-asset://local/model.glb', '输送线');
  entity.components.modelAsset.dataDrivenConfig = { device: { devType: 'conveyor' }, fixedNodes: [] };
  entity.components.telemetryBinding = normalizeTelemetryBindingComponent({ deviceType: 'conveyor' });
  scene.entityIds.push(entity.id);
  scene.entities[entity.id] = entity;
  scene.selectedEntityId = entity.id;
  store.setState({ scene, history: createCommandHistory(), runtimeMode: 'edit',
    hierarchySelectionIds: [entity.id], entityClipboard: null, logs: [] });
  conveyorSurfaceArrowSession.clear();
});

function selectedBinding() {
  const { scene } = store.getState();
  return scene.entities[scene.selectedEntityId].components.telemetryBinding;
}
function configure(patch = {}) {
  store.getState().updateSelectedTelemetryBinding({ ...selectedBinding(),
    surfaceArrows: { ...createDefaultConveyorSurfaceArrowsConfig(), enabled: true, ...patch } });
}

test('表面箭头配置通过真实编辑命令保存并支持撤销重做', () => {
  const before = structuredClone(selectedBinding());
  configure({ speed: 0, opacity: 0, surfaceNode: 'Belt.Surface', offsetAcross: -0.15 });
  assert.equal(selectedBinding().surfaceArrows.enabled, true);
  assert.equal(selectedBinding().surfaceArrows.speed, 0);
  assert.equal(selectedBinding().surfaceArrows.opacity, 0);
  const configured = structuredClone(selectedBinding());
  assert.equal(store.getState().history.undoStack.length, 1);
  store.getState().undo();
  assert.deepEqual(selectedBinding(), before);
  store.getState().redo();
  assert.deepEqual(selectedBinding(), configured);
});

test('保存重开、关闭状态及旧场景缺省配置兼容，临时预览和诊断不入场景', () => {
  configure({ enabled: false, speed: 0 });
  const { scene } = store.getState();
  const id = scene.selectedEntityId;
  const configured = structuredClone(selectedBinding().surfaceArrows);
  conveyorSurfaceArrowSession.setPreview(id, -1);
  conveyorSurfaceArrowSession.setDiagnostic(id, '临时诊断不应入场景');
  const content = serializeScene(scene);
  assert.equal(content.includes('临时诊断不应入场景'), false);
  assert.equal(content.includes('surfaceArrowPreview'), false);
  assert.deepEqual(deserializeScene(content).entities[id].components.telemetryBinding.surfaceArrows, configured);
  assert.equal(configured.enabled, false);
  assert.equal(configured.speed, 0);
  const legacy = JSON.parse(content);
  delete legacy.scene.entities[id].components.telemetryBinding.surfaceArrows;
  assert.deepEqual(deserializeScene(JSON.stringify(legacy)).entities[id].components.telemetryBinding.surfaceArrows, createDefaultConveyorSurfaceArrowsConfig());
});

test('复制后的表面箭头配置可以独立编辑，恢复模型默认绑定可撤销', () => {
  configure({ color: '#112233', length: 5 });
  const originalId = store.getState().scene.selectedEntityId;
  const configured = structuredClone(selectedBinding());
  store.getState().copySelectedEntities();
  store.getState().pasteEntityClipboard();
  const copyId = store.getState().scene.selectedEntityId;
  assert.notEqual(copyId, originalId);
  assert.deepEqual(selectedBinding().surfaceArrows, configured.surfaceArrows);
  configure({ color: '#aabbcc' });
  assert.equal(store.getState().scene.entities[originalId].components.telemetryBinding.surfaceArrows.color, '#112233');
  assert.equal(selectedBinding().surfaceArrows.color, '#aabbcc');
  const copyConfig = structuredClone(selectedBinding());
  store.getState().restoreSelectedTelemetryBindingDefault();
  assert.deepEqual(selectedBinding().surfaceArrows, createDefaultConveyorSurfaceArrowsConfig());
  store.getState().undo();
  assert.deepEqual(selectedBinding(), copyConfig);
});

test('运行预览阻止配置修改，保持原场景和命令历史', () => {
  configure();
  const before = structuredClone(store.getState().scene);
  const count = store.getState().history.undoStack.length;
  store.setState({ runtimeMode: 'preview' });
  configure({ color: '#ffffff' });
  store.getState().restoreSelectedTelemetryBindingDefault();
  assert.deepEqual(store.getState().scene, before);
  assert.equal(store.getState().history.undoStack.length, count);
});

test('新输送线及旧缺省字段默认开启移动双箭头并关闭呼吸，显式关闭保留且其他设备不受影响', () => {
  assert.equal(selectedBinding().surfaceArrows.enabled, true);
  assert.equal(selectedBinding().surfaceArrows.breathingEnabled, false);
  assert.equal(selectedBinding().surfaceArrows.style, 'moving-double-arrow');
  assert.equal(normalizeTelemetryBindingComponent({ deviceType: 'rgv' }).surfaceArrows, undefined);
  configure({ enabled: false });
  assert.equal(selectedBinding().surfaceArrows.enabled, false);
});

test('箭头拖拽只改样式，可撤销重做且不新增实体；呼吸和点位字符串完整保存', () => {
  const directionBinding = { mode: 'point', field: '00017', forwardValue: '01', reverseValue: '02', stopValue: '00' };
  configure({ style: 'conveyor-direction', color: '#112233', length: 6, breathingEnabled: false, breathingPeriod: 2.7, breathingStrength: 0, directionBinding });
  const before = structuredClone(selectedBinding().surfaceArrows);
  const beforeIds = [...store.getState().scene.entityIds];
  const count = store.getState().history.undoStack.length;
  const payload = encodeBuiltInAssetDragPayload({ kind: 'poi-effect', effectKind: 'moving-double-arrow' });
  const style = readConveyorSurfaceArrowStyleDrop({ types: [BUILT_IN_ASSET_DRAG_MIME_TYPE], files: { length: 0 }, getData: () => payload });
  assert.equal(style, 'moving-double-arrow');
  store.getState().updateSelectedTelemetryBinding({ ...selectedBinding(), surfaceArrows: { ...before, style } });
  assert.deepEqual(store.getState().scene.entityIds, beforeIds);
  assert.equal(store.getState().history.undoStack.length, count + 1);
  assert.deepEqual(selectedBinding().surfaceArrows, { ...before, style });
  store.getState().undo();
  assert.deepEqual(selectedBinding().surfaceArrows, before);
  store.getState().redo();
  const scene = store.getState().scene;
  const reopened = deserializeScene(serializeScene(scene)).entities[scene.selectedEntityId].components.telemetryBinding.surfaceArrows;
  assert.deepEqual(reopened, { ...before, style });
  assert.deepEqual(reopened.directionBinding, directionBinding);
  assert.equal(reopened.breathingEnabled, false);
  assert.equal(reopened.breathingStrength, 0);
});

test('自定义点位空值和冲突保持原配置并报告校验，不静默回退模型默认映射', () => {
  const directionBinding = { mode: 'point', field: '', forwardValue: '01', reverseValue: '01', stopValue: '00' };
  configure({ directionBinding });
  assert.deepEqual(selectedBinding().surfaceArrows.directionBinding, directionBinding);
  assert.match(getConveyorSurfaceArrowDirectionError(selectedBinding().surfaceArrows.directionBinding), /点位/);
  configure({ directionBinding: { ...directionBinding, field: 'movement_x' } });
  assert.match(getConveyorSurfaceArrowDirectionError(selectedBinding().surfaceArrows.directionBinding), /互不相同/);
  const scene = store.getState().scene;
  const reopened = deserializeScene(serializeScene(scene)).entities[scene.selectedEntityId].components.telemetryBinding.surfaceArrows;
  assert.deepEqual(reopened.directionBinding, { ...directionBinding, field: 'movement_x' });
});

test('重开同一场景保留场景和实体 ID，但生成新的会话供表单草稿与预览隔离', () => {
  configure({ directionBinding: { mode: 'point', field: '00017', forwardValue: '01', reverseValue: '02', stopValue: '00' } });
  const before = store.getState();
  const sceneId = before.scene.id;
  const entityId = before.scene.selectedEntityId;
  const beforeSession = before.sceneSessionId;
  const content = serializeScene(before.scene);
  assert.equal(store.getState().loadSceneFromContent(content, '同一场景重新打开.scene.json'), true);
  assert.equal(store.getState().scene.id, sceneId);
  assert.ok(store.getState().scene.entities[entityId]);
  assert.notEqual(store.getState().sceneSessionId, beforeSession);
  assert.deepEqual(store.getState().scene.entities[entityId].components.telemetryBinding.surfaceArrows,
    before.scene.entities[entityId].components.telemetryBinding.surfaceArrows);
});
