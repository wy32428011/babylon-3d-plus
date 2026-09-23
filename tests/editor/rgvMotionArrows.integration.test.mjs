import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.rgv-arrows-editor-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
let store;
let originalState;
after(async () => {
  if (store && originalState) store.setState(originalState, true);
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules')
    || !path.basename(temporaryRoot).startsWith('.rgv-arrows-editor-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});

const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument, createModelEntity } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { createDefaultRgvMotionArrowsConfig } from '../../src/editor/model/rgvMotionArrows.ts';",
  "export { normalizeTelemetryBindingComponent } from '../../src/editor/model/telemetryBinding.ts';",
  "export { rgvMotionArrowSession } from '../../src/runtime/rgvMotionArrowSession.ts';",
  "export { RgvMotionArrowsInspector } from '../../src/editor/panels/RgvMotionArrowsInspector.tsx';",
  "export { TelemetryBindingInspector } from '../../src/editor/panels/TelemetryBindingInspector.tsx';",
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
  serializeScene, deserializeScene, createDefaultRgvMotionArrowsConfig,
  normalizeTelemetryBindingComponent, rgvMotionArrowSession,
  RgvMotionArrowsInspector, TelemetryBindingInspector,
  readConveyorSurfaceArrowStyleDrop, BUILT_IN_ASSET_DRAG_MIME_TYPE, encodeBuiltInAssetDragPayload,
} = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
store = useEditorStore;
originalState = store.getState();

beforeEach(() => {
  store.setState(originalState, true);
  const scene = createEmptySceneDocument('RGV运动箭头验收');
  const entity = createModelEntity('model.glb', 'editor-asset://local/model.glb', 'RGV');
  entity.components.modelAsset.dataDrivenConfig = { device: { devType: 'rgv' }, fixedNodes: [] };
  entity.components.telemetryBinding = normalizeTelemetryBindingComponent({ deviceType: 'rgv' });
  scene.entityIds.push(entity.id);
  scene.entities[entity.id] = entity;
  scene.selectedEntityId = entity.id;
  store.setState({ scene, history: createCommandHistory(), runtimeMode: 'edit',
    hierarchySelectionIds: [entity.id], entityClipboard: null, logs: [] });
  rgvMotionArrowSession.clear();
});

function selectedBinding() {
  const { scene } = store.getState();
  return scene.entities[scene.selectedEntityId].components.telemetryBinding;
}
function configure(patch = {}) {
  const config = { ...createDefaultRgvMotionArrowsConfig(), enabled: true, ...patch };
  store.getState().updateSelectedTelemetryBinding({ ...selectedBinding(), rgvMotionArrows: config });
}

test('三路运动箭头配置走编辑命令并支持撤销重做，恢复默认不自动启用', () => {
  const before = structuredClone(selectedBinding());
  const defaults = createDefaultRgvMotionArrowsConfig();
  configure({ speed: 0, channels: { ...defaults.channels, front: { ...defaults.channels.front, surfaceNode: 'FrontDeck', reverse: true } } });
  assert.equal(selectedBinding().rgvMotionArrows.enabled, true);
  assert.equal(selectedBinding().rgvMotionArrows.speed, 0);
  assert.equal(selectedBinding().rgvMotionArrows.channels.front.surfaceNode, 'FrontDeck');
  const configured = structuredClone(selectedBinding());
  assert.equal(store.getState().history.undoStack.length, 1);
  store.getState().undo();
  assert.deepEqual(selectedBinding(), before);
  store.getState().redo();
  assert.deepEqual(selectedBinding(), configured);
  store.getState().restoreSelectedTelemetryBindingDefault();
  assert.equal(selectedBinding().rgvMotionArrows, undefined);
  store.getState().undo();
  assert.deepEqual(selectedBinding(), configured);
});

test('保存重开保留三路配置与关闭状态，旧场景缺省不启用，临时预览诊断不入场景', () => {
  configure({ enabled: false, speed: 0 });
  const { scene } = store.getState();
  const id = scene.selectedEntityId;
  const configured = structuredClone(selectedBinding().rgvMotionArrows);
  rgvMotionArrowSession.setPreview(id, 'travel', -1);
  rgvMotionArrowSession.setDiagnostic(id, 'front', '临时诊断不应入场景');
  const content = serializeScene(scene);
  assert.equal(content.includes('临时诊断不应入场景'), false);
  assert.deepEqual(deserializeScene(content).entities[id].components.telemetryBinding.rgvMotionArrows, configured);
  assert.equal(configured.enabled, false);
  const legacy = JSON.parse(content);
  delete legacy.scene.entities[id].components.telemetryBinding.rgvMotionArrows;
  assert.equal(deserializeScene(JSON.stringify(legacy)).entities[id].components.telemetryBinding.rgvMotionArrows, undefined);
});

test('复制后的三路配置可独立编辑，不复用预览状态', () => {
  configure({ color: '#112233' });
  const originalId = store.getState().scene.selectedEntityId;
  rgvMotionArrowSession.setPreview(originalId, 'travel', 1);
  const configured = structuredClone(selectedBinding().rgvMotionArrows);
  store.getState().copySelectedEntities();
  store.getState().pasteEntityClipboard();
  const copyId = store.getState().scene.selectedEntityId;
  assert.notEqual(copyId, originalId);
  assert.deepEqual(selectedBinding().rgvMotionArrows, configured);
  assert.equal(rgvMotionArrowSession.getPreview(copyId, 'travel'), null);
  configure({ color: '#aabbcc', channels: { ...configured.channels, front: { ...configured.channels.front, enabled: false } } });
  const original = store.getState().scene.entities[originalId].components.telemetryBinding.rgvMotionArrows;
  assert.equal(original.color, '#112233');
  assert.equal(original.channels.front.enabled, true);
  assert.equal(selectedBinding().rgvMotionArrows.channels.front.enabled, false);
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
  store.getState().updateSelectedTelemetryBinding({ ...before, rgvMotionArrows: { ...before.rgvMotionArrows, style } });
  assert.deepEqual(store.getState().scene.entityIds, beforeIds);
  assert.deepEqual(selectedBinding(), { ...before, rgvMotionArrows: { ...before.rgvMotionArrows, style } });
  store.getState().undo();
  assert.deepEqual(selectedBinding(), before);
  store.getState().redo();
  const scene = store.getState().scene;
  assert.deepEqual(deserializeScene(serializeScene(scene)).entities[scene.selectedEntityId].components.telemetryBinding, selectedBinding());
});

test('RGV 面板包含十种样式、三路独立预览，行走没有侧面和偏移控件', () => {
  const config = { ...createDefaultRgvMotionArrowsConfig(), enabled: true };
  const html = renderToStaticMarkup(createElement(RgvMotionArrowsInspector, {
    entityId: store.getState().scene.selectedEntityId, config, disabled: false, onChange() {},
  }));
  assert.match(html, /RGV 运动箭头/);
  for (const channel of ['travel', 'front', 'back']) assert.match(html, new RegExp(`data-testid="rgv-motion-arrow-${channel}"`));
  assert.equal((html.match(/箭头编辑预览/g) ?? []).length, 3);
  const travel = html.split('data-testid="rgv-motion-arrow-travel"')[1].split('data-testid="rgv-motion-arrow-front"')[0];
  assert.match(travel, /轨道正上方/);
  assert.match(travel, /宽度\(m，0自动\)/);
  assert.match(travel, /离面距离\(m\)/);
  assert.doesNotMatch(travel, /横向偏移|沿运动偏移|value="side"|长度\(m，0自动\)/);
  assert.match(html, /前工位箭头编辑预览/);
  assert.match(html, /后工位箭头编辑预览/);
  const appearanceSelect = html.split('<span>箭头样式</span>')[1].split('</select>')[0];
  assert.equal((appearanceSelect.match(/<option /g) ?? []).length, 10);
});

test('已解析的设备绑定仅为 rgv 时展示专用箭头面板，不自动迁移 shuttle 类型', () => {
  for (const deviceType of ['rgv', 'shuttle', 'conveyor', 'stacker', 'lift']) {
    const html = renderToStaticMarkup(createElement(TelemetryBindingInspector, {
      entityId: store.getState().scene.selectedEntityId,
      binding: normalizeTelemetryBindingComponent({ deviceType }),
      dataDrivenConfig: { device: { devType: deviceType }, fixedNodes: [] },
      disabled: false, modelAssetCode: '', onChange() {}, onRestoreDefault() {},
    }));
    assert.equal(html.includes('data-testid="rgv-motion-arrows"'), deviceType === 'rgv', deviceType);
  }
});

