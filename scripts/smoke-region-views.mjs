import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ArcRotateCamera, Camera, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { build } from 'vite';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const deadline = setTimeout(() => { console.error('区域视角集成验证超时'); process.exit(1); }, 240_000);
let engine;
let store;
let original;
try {
  console.log('加载区域视角保存、相机与 Viewer 模块…');
  const work = path.resolve('output/region-views-work');
  await mkdir(work, { recursive: true });
  const entry = path.join(work, 'region-entry.mjs');
  await writeFile(entry, [
    "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
    "export { createEmptySceneDocument, createMeshEntity } from '../../src/editor/model/SceneDocument.ts';",
    "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
    "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
    "export { ArcRotateCameraViewController } from '../../src/runtime/babylon/ArcRotateCameraViewController.ts';",
    "export { DigitalTwinInteractionController } from '../../src/player/DigitalTwinInteractionController.ts';",
  ].join('\n'));
  await build({ configFile: false, root: process.cwd(), ssr: { noExternal: ['@linkiez/dxf-renew'] },
    build: { ssr: entry, outDir: path.join(work, 'ssr'), emptyOutDir: false,
      rolldownOptions: { output: { entryFileNames: 'region-modules.mjs' } } } });
  const { useEditorStore, createEmptySceneDocument, createMeshEntity, serializeScene, deserializeScene,
    createCommandHistory, ArcRotateCameraViewController, DigitalTwinInteractionController } = await import(pathToFileURL(path.join(work, 'ssr/region-modules.mjs')).href);
  store = useEditorStore; original = store.getState();
  const document = createEmptySceneDocument('区域视角验收');
  document.sceneSettings.shadows.enabled = false;
  for (const x of [-8, 8]) {
    const mesh = createMeshEntity('cube', { x, y: 1, z: 0 });
    document.entityIds.push(mesh.id); document.entities[mesh.id] = mesh;
  }
  store.setState({ scene: document, history: createCommandHistory(), runtimeMode: 'edit', regionViewRequest: null, cameraResetRequest: null, logs: [] });
  engine = new NullEngine({ renderWidth: 1280, renderHeight: 720 });
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('regions', 0.8, 1.1, 20, new Vector3(-8, 1, 0), scene);
  scene.activeCamera = camera;
  let now = 0;
  const controller = new ArcRotateCameraViewController(camera, engine, scene, { now: () => now, prefersReducedMotion: () => false });
  const save = (name, id) => {
    store.getState().requestRegionView('save', name, id);
    const request = store.getState().regionViewRequest;
    assert.ok(request);
    store.getState().consumeRegionViewRequest(request.id, controller.getCameraView());
  };
  save('入库区');
  const id = store.getState().scene.sceneSettings.regionViews[0].id;
  camera.target.x = 8; camera.radius = 12;
  controller.setCameraProjection('orthographic');
  save('出库区');
  store.getState().renameRegionView(id, '入库作业区');
  camera.target.x = -8; camera.radius = 24;
  controller.setCameraProjection('perspective');
  save('', id);
  assert.equal(store.getState().scene.sceneSettings.regionViews[0].id, id);
  assert.equal(store.getState().scene.sceneSettings.regionViews[0].camera.savedPose.radius, 24);
  store.getState().undo();
  assert.equal(store.getState().scene.sceneSettings.regionViews[0].camera.savedPose.radius, 20);
  store.getState().redo();
  const beforeMove = structuredClone(store.getState().scene.sceneSettings.regionViews);
  const historyBeforeMove = store.getState().history;
  store.getState().reorderRegionView(id, id, 'after');
  store.getState().reorderRegionView(id, beforeMove[1].id, 'before');
  store.getState().reorderRegionView('deleted', id, 'before');
  store.getState().reorderRegionView(id, 'deleted', 'after');
  store.getState().moveRegionView(id, 'up');
  store.getState().moveRegionView(beforeMove[1].id, 'down');
  store.getState().moveRegionView('deleted', 'down');
  assert.equal(store.getState().history, historyBeforeMove, '边界和失效 ID 不生成撤销记录');
  store.setState({ runtimeMode: 'preview' });
  store.getState().reorderRegionView(id, beforeMove[1].id, 'after');
  store.getState().moveRegionView(id, 'down');
  assert.deepEqual(store.getState().scene.sceneSettings.regionViews, beforeMove, '运行预览禁止调整顺序');
  assert.equal(store.getState().history, historyBeforeMove);
  store.setState({ runtimeMode: 'edit' });
  store.getState().requestRegionView('apply', '', id);
  const pendingMove = store.getState().regionViewRequest;
  store.getState().reorderRegionView(id, beforeMove[1].id, 'after');
  store.getState().moveRegionView(id, 'down');
  assert.equal(store.getState().history, historyBeforeMove, '相机请求处理中禁止调整顺序');
  store.getState().consumeRegionViewRequest(pendingMove.id);
  store.getState().reorderRegionView(id, beforeMove[1].id, 'after');
  assert.deepEqual(store.getState().scene.sceneSettings.regionViews, [beforeMove[1], beforeMove[0]]);
  store.getState().undo();
  assert.deepEqual(store.getState().scene.sceneSettings.regionViews, beforeMove, '一次拖拽只生成一条撤销记录');
  store.getState().redo();
  store.getState().reorderRegionView(id, beforeMove[1].id, 'before');
  assert.deepEqual(store.getState().scene.sceneSettings.regionViews, beforeMove);
  store.getState().moveRegionView(id, 'down');
  const reordered = [beforeMove[1], beforeMove[0]];
  assert.deepEqual(store.getState().scene.sceneSettings.regionViews, reordered, '下移只改变顺序，保持 ID、名称和相机');
  store.getState().undo();
  assert.deepEqual(store.getState().scene.sceneSettings.regionViews, beforeMove);
  store.getState().redo();
  assert.deepEqual(store.getState().scene.sceneSettings.regionViews, reordered);
  store.getState().moveRegionView(id, 'up');
  assert.deepEqual(store.getState().scene.sceneSettings.regionViews, beforeMove);
  store.getState().undo();
  assert.deepEqual(store.getState().scene.sceneSettings.regionViews, reordered);
  const saved = serializeScene(store.getState().scene);
  const views = store.getState().scene.sceneSettings.regionViews;
  assert.deepEqual(deserializeScene(saved).sceneSettings.regionViews, views);
  assert.deepEqual(store.getState().scene.sceneSettings.camera, document.sceneSettings.camera);
  store.getState().requestRegionView('save', '', id);
  const stale = store.getState().regionViewRequest;
  store.getState().loadSceneFromContent(saved, '重新打开');
  store.getState().consumeRegionViewRequest(stale.id, controller.getCameraView());
  assert.deepEqual(store.getState().scene.sceneSettings.regionViews, views);
  assert.equal(store.getState().hasUnsavedChanges(), false);
  store.getState().moveRegionView(id, 'up');
  assert.equal(store.getState().hasUnsavedChanges(), true, '排序需要保存场景');
  store.getState().undo();
  assert.equal(store.getState().hasUnsavedChanges(), false);
  store.getState().deleteRegionView(id); store.getState().undo();
  assert.deepEqual(store.getState().scene.sceneSettings.regionViews, views);

  let receive;
  const parent = {};
  const messages = [];
  const interaction = new DigitalTwinInteractionController({ parentWindow: parent, viewerOrigin: 'https://local.test',
    subscribeToMessages: listener => { receive = listener; return () => {}; }, postToParent: message => messages.push(message) });
  const send = message => receive({ source: parent, origin: 'https://local.test', data: {
    channel: 'zending.digital-twin.bridge', version: 1, sessionId: 's1', ...message } });
  const runtime = { hardwareGpuVerified: true, getRegionViews: () => views,
    applyRegionView: (viewId, options) => controller.applyCameraView({ ...views.find(view => view.id === viewId).camera, viewDistance: 12000 }, { ...options, lockStandardOrientation: false }),
    cancelCameraTransition: reason => controller.cancelTransition(reason), clearExternalHighlight() {},
    getPatrolPhase: () => 'idle', notifyCameraChangedWhilePaused() {} };
  interaction.markViewerReady(runtime);
  send({ type: 'host.hello' });
  assert.deepEqual(messages.at(-1).payload.capabilities, ['hardwareGpu', 'focusAsset'], '旧握手保持原能力列表');
  send({ type: 'host.regionViews', requestId: 'list' });
  assert.deepEqual(messages.at(-1).payload.views, views.map(({ id, name }) => ({ id, name })));
  send({ type: 'command.regionView', requestId: 'a', payload: { viewId: views[0].id, animate: true } });
  send({ type: 'command.regionView', requestId: 'b', payload: { viewId: views[1].id, animate: true } });
  assert.ok(messages.some(message => message.requestId === 'a' && message.ok === false));
  assert.ok(!messages.some(message => message.requestId === 'b' && message.ok === true), '过渡未完成不能提前回执');
  now += 500; scene.render();
  assert.equal(messages.at(-1).ok, true);
  assert.equal(camera.mode, views[1].camera.savedProjection === 'orthographic' ? Camera.ORTHOGRAPHIC_CAMERA : Camera.PERSPECTIVE_CAMERA);
  assert.deepEqual(controller.getCameraPose(), views[1].camera.savedPose);
  send({ type: 'command.regionView', requestId: 'c', payload: { viewId: views[0].id, animate: true } });
  interaction.notifyManualCameraInput();
  assert.equal(messages.at(-1).error.code, 'COMMAND_CANCELLED');
  send({ type: 'command.regionView', requestId: 'missing', payload: { viewId: 'deleted', animate: false } });
  assert.equal(messages.at(-1).error.code, 'REGION_VIEW_NOT_FOUND');
  interaction.dispose(); controller.dispose();
  const output = path.resolve('output/region-views');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'scene.scene.json'), saved, 'utf8');
  await writeFile(path.join(output, 'integration-result.json'), JSON.stringify({ ok: true, views, checks: ['save', 'rename', 'update-id', 'reorder', 'drag-before-after', 'drag-single-undo', 'drag-no-op', 'reorder-boundaries', 'reorder-readonly', 'reorder-pending', 'reorder-dirty', 'undo-redo', 'serialize-reopen', 'stale-session', 'legacy-handshake', 'completion', 'latest-wins', 'manual-cancel', 'missing-id'] }, null, 2));
  console.log('区域视角 Store / 序列化 / 真实 Babylon 相机 / Viewer 控制器验证通过');
} finally {
  clearTimeout(deadline);
  engine?.dispose();
  if (store && original) store.setState(original, true);
}
