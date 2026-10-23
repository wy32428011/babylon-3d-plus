import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

// 验证公开 Store 的跨域事务；预编译同一模块图，避免依赖传输超时影响行为验证。
const temporary = await mkdtemp(path.join(os.tmpdir(), 'p3-editor-slices-'));
after(() => rm(temporary, { recursive: true, force: true }));
const entry = path.join(temporary, 'input.ts');
await writeFile(entry, [
  ['src/editor/store/editorStore.ts', 'store'],
  ['src/editor/model/SceneDocument.ts', 'document'],
  ['src/editor/project/SceneSerializer.ts', 'serialization'],
].map(([file, name]) => `export * as ${name} from ${JSON.stringify(path.resolve(file).replace(/\\/g, '/'))};`).join('\n'));
await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true },
  build: { ssr: entry, outDir: path.join(temporary, 'out'), minify: false,
    rollupOptions: { output: { entryFileNames: 'entry.mjs' } } } });
const loaded = await import(pathToFileURL(path.join(temporary, 'out/entry.mjs')).href);
const { useEditorStore: store } = loaded.store;
const { createEmptySceneDocument } = loaded.document;
const { serializeScene } = loaded.serialization;
const initial = store.getState();
const originalWindow = globalThis.window;
after(() => { store.setState(initial, true); globalThis.window = originalWindow; });
beforeEach(() => {
  globalThis.window = { editorApi: {} };
  store.setState(initial, true);
  const scene = createEmptySceneDocument('P3 跨 Slice 场景');
  scene.mqttConfig = { ...scene.mqttConfig, enabled: true, simulatorEnabled: true };
  store.getState().loadSceneFromContent(serializeScene(scene), 'fixture');
});

test('公开命令仍通过一次通知原子提交文档、选区与撤销历史', () => {
  const notifications = [];
  const unsubscribe = store.subscribe(state => notifications.push(state));
  try {
    store.getState().createMesh('box', { x: 2, y: 3, z: 4 });
    assert.equal(notifications.length, 1);
    const created = notifications[0];
    const id = created.scene.selectedEntityId;
    assert.ok(id);
    assert.deepEqual(created.hierarchySelectionIds, [id]);
    assert.deepEqual(created.scene.entities[id].components.transform.position, { x: 2, y: 3, z: 4 });
    assert.equal(created.history.undoStack.length, 1);
    store.getState().undo();
    assert.equal(store.getState().scene.entities[id], undefined);
    assert.deepEqual(store.getState().hierarchySelectionIds, []);
    store.getState().redo();
    assert.deepEqual(store.getState().scene.entities[id].components.transform.position, { x: 2, y: 3, z: 4 });
    assert.deepEqual(store.getState().hierarchySelectionIds, [id]);
  } finally { unsubscribe(); }
});

test('光照草稿、视口与运行快照不会加入文档历史或产生未保存更改', () => {
  const before = store.getState();
  store.getState().setSnapEnabled(true);
  store.getState().setCameraProjection('orthographic');
  store.getState().openLightingManager({ tab: 'overview' });
  store.getState().setLightingClassification([]);
  store.getState().setLightingDebugVisible(true);
  store.getState().setAutoPatrolPlaybackSnapshot({ ...before.autoPatrolPlaybackSnapshot, taskId: 'task' });
  const state = store.getState();
  assert.equal(state.scene, before.scene);
  assert.equal(state.history, before.history);
  assert.equal(state.hasUnsavedChanges(), false);
  assert.equal(state.lightingManagerOpen, true);
  assert.equal(state.cameraProjection, 'orthographic');
});

test('运行门控跨 Slice 生效，进入预览后所有文档命令保持只读', () => {
  store.setState({ lightingBakeRequest: { id: 'bake' } });
  assert.equal(store.getState().startRuntimePreview().code, 'lighting-bake-active');
  store.setState({ lightingBakeRequest: null, cadImportProgress: { active: true } });
  assert.equal(store.getState().startRuntimePreview().code, 'cad-import-active');
  store.setState({ cadImportProgress: null });
  assert.equal(store.getState().startRuntimePreview({ performance: true }).ok, true);
  const before = store.getState();
  store.getState().createMesh('box');
  store.getState().renameScene('应被拒绝');
  store.getState().undo();
  const state = store.getState();
  assert.equal(state.scene, before.scene);
  assert.equal(state.history, before.history);
  assert.equal(state.runtimePerformanceEnabled, true);
  assert.ok(state.logs[0].message.includes('运行预览只读'));
  state.stopRuntimePreview();
  assert.equal(store.getState().runtimeMode, 'edit');
  assert.equal(store.getState().runtimePerformanceEnabled, false);
});

test('中台资源事务拒绝旧会话/旧文档，阻止未校验保存，成功事务仍能撤销', async () => {
  const before = store.getState();
  const next = { ...before.scene, name: '新版资源' };
  assert.equal(before.commitLatestSceneResources('old-session', before.scene, next), false);
  assert.equal(before.commitLatestSceneResources(before.sceneSessionId, { ...before.scene }, next), false);
  assert.equal(store.getState().scene, before.scene);
  assert.equal(before.commitLatestSceneResources(before.sceneSessionId, before.scene, next), true);
  assert.equal(store.getState().latestSceneResourceTransaction.after, next);
  let saveCalls = 0;
  globalThis.window.editorApi.saveScene = async () => { saveCalls += 1; return { canceled: false }; };
  assert.equal(await store.getState().saveScene(), false);
  assert.equal(saveCalls, 0);
  store.getState().finishLatestSceneResources(before.sceneSessionId, next);
  assert.equal(store.getState().latestSceneResourceTransaction, null);
  store.getState().undo();
  assert.equal(store.getState().scene, before.scene);
});

test('切换场景仍统一清空跨域预览/事务状态，历史和资源门控不泄漏', () => {
  store.getState().createMesh('box');
  store.getState().openLightingManager({ tab: 'overview' });
  store.getState().requestOpeningAnimationPreview('play');
  const session = store.getState().sceneSessionId;
  const scene = createEmptySceneDocument('新的会话');
  assert.equal(store.getState().loadSceneFromContent(serializeScene(scene), 'new-scene'), true);
  const state = store.getState();
  assert.notEqual(state.sceneSessionId, session);
  assert.equal(state.scene.name, '新的会话');
  assert.equal(state.history.undoStack.length, 0);
  assert.deepEqual(state.hierarchySelectionIds, []);
  assert.equal(state.openingAnimationPreviewRequest, null);
  assert.equal(state.lightingManagerOpen, false);
  assert.equal(state.latestSceneResourceTransaction, null);
  assert.equal(state.hasUnsavedChanges(), false);
});

test('等待 Electron 打开确认期间切换会话，旧结果不会覆盖新场景', async () => {
  let confirm;
  let started;
  const confirmationStarted = new Promise(resolve => { started = resolve; });
  globalThis.window.editorApi = {
    loadSceneFile: async () => ({ canceled: false, sceneOpenToken: 9,
      content: serializeScene(createEmptySceneDocument('旧异步结果')), filePath: 'old.scene.json' }),
    confirmSceneOpen: () => { started(); return new Promise(resolve => { confirm = resolve; }); },
  };
  const pending = store.getState().loadSceneFromFile('old.scene.json');
  await confirmationStarted;
  const current = createEmptySceneDocument('当前场景');
  store.getState().loadSceneFromContent(serializeScene(current), 'current');
  confirm(true);
  assert.equal(await pending, false);
  assert.equal(store.getState().scene.name, '当前场景');
});
