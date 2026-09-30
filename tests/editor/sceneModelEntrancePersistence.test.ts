import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.model-entrance-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} } as unknown as Window & typeof globalThis;
after(async () => {
  if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else globalThis.window = previousWindow;
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules')
    || !path.basename(temporaryRoot).startsWith('.model-entrance-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});
const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument } from '../../src/editor/model/SceneDocument.ts';",
  "export { sanitizeSceneEnvironment } from '../../src/editor/model/SceneDocument.ts';",
  "export { ENVIRONMENT_EFFECT_TARGET_ID } from '../../src/editor/model/environmentBuildingEffect.ts';",
  "export { SceneModelEntrancePanel } from '../../src/editor/panels/SceneModelEntrancePanel.tsx';",
  "export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
].join('\n'));
await build({ configFile: false, publicDir: false, logLevel: 'silent',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: entry, outDir: path.join(temporaryRoot, 'ssr'),
    rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } } });
const { useEditorStore: store, createEmptySceneDocument, createCommandHistory, serializeScene, deserializeScene,
  sanitizeSceneEnvironment, ENVIRONMENT_EFFECT_TARGET_ID, SceneModelEntrancePanel, createElement, renderToStaticMarkup }
  = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
const original = store.getState();
after(() => store.setState(original, true));

test('保存重开保留非默认效果、零值和指定实体；旧场景默认停用', () => {
  const scene = createEmptySceneDocument('入场保存验收');
  store.setState({ scene, history: createCommandHistory(), runtimeMode: 'edit', logs: [] });
  store.getState().updateSceneModelEntranceSettings({ enabled: true, effect: 'assembly', axis: 'z', reverse: true,
    durationSeconds: 7, color: '#123456', intensity: 0, delaySeconds: 0, spreadMeters: 0,
    assemblyDistanceMeters: 0, scope: 'selected', targetEntityIds: ['missing-is-preserved'], loop: true, loopIntervalSeconds: 0 });
  const saved = store.getState().scene;
  assert.deepEqual(deserializeScene(serializeScene(saved)).sceneSettings.modelEntrance, saved.sceneSettings.modelEntrance);
  const legacy = JSON.parse(serializeScene(scene));
  delete legacy.scene.sceneSettings.modelEntrance;
  assert.equal(deserializeScene(JSON.stringify(legacy)).sceneSettings.modelEntrance.enabled, false);
});

test('配置动作仅创建必要历史，撤销保留相机；运行预览拒绝写入', () => {
  const scene = createEmptySceneDocument('入场历史验收');
  store.setState({ scene, history: createCommandHistory(), runtimeMode: 'edit', logs: [] });
  store.getState().updateSceneModelEntranceSettings({ enabled: true, effect: 'particles' });
  store.getState().updateSceneModelEntranceSettings({ enabled: true, effect: 'particles' });
  assert.equal(store.getState().history.undoStack.length, 1);
  const configured = store.getState().scene.sceneSettings.modelEntrance;
  const changed = store.getState().scene;
  store.setState({ scene: { ...changed, sceneSettings: { ...changed.sceneSettings, camera: { ...changed.sceneSettings.camera, viewDistance: 2000 } } } });
  store.getState().undo();
  assert.equal(store.getState().scene.sceneSettings.modelEntrance.enabled, false);
  assert.equal(store.getState().scene.sceneSettings.camera.viewDistance, 2000);
  store.getState().redo();
  assert.deepEqual(store.getState().scene.sceneSettings.modelEntrance, configured);
  store.setState({ runtimeMode: 'preview' });
  store.getState().updateSceneModelEntranceSettings({ effect: 'fade' });
  assert.deepEqual(store.getState().scene.sceneSettings.modelEntrance, configured);
});

test('环境模型可单独指定，界面选项与保存重开及撤销保留稳定环境目标', () => {
  const scene = createEmptySceneDocument('环境入场验收');
  scene.sceneSettings.environment = sanitizeSceneEnvironment({ packagePath:'C:/fixtures', displayName:'测试厂房',
    activeVariantUrl:'editor-asset://local/environment.glb', visible:true, opacity:1, lengthUnit:'meter',unitScaleToMeters:1,
    placementMode:'scene-base', variants:[{name:'默认',sourcePath:'C:/fixtures/environment.glb',sourceUrl:'editor-asset://local/environment.glb'}] });
  store.setState({scene,history:createCommandHistory(),runtimeMode:'edit',logs:[]});
  store.getState().updateSceneModelEntranceSettings({enabled:true,scope:'selected',targetEntityIds:[ENVIRONMENT_EFFECT_TARGET_ID]});
  const saved=store.getState().scene;
  // SSR 读取初始快照；将本用例真实 Store 状态提供给这一轮服务端渲染。
  const initial=store.getInitialState(), previousInitial={...initial};
  let html: string;
  try { Object.assign(initial,store.getState()); html=renderToStaticMarkup(createElement(SceneModelEntrancePanel)); }
  finally { Object.assign(initial,previousInitial); }
  assert.match(html,/全部模型（含环境）/);
  assert.match(html,/环境模型：测试厂房/);
  assert.ok(html.includes('value="'+ENVIRONMENT_EFFECT_TARGET_ID+'" selected=""'));
  const reopened=deserializeScene(serializeScene(saved));
  assert.deepEqual(reopened.sceneSettings.modelEntrance.targetEntityIds,[ENVIRONMENT_EFFECT_TARGET_ID]);
  assert.equal(reopened.sceneSettings.environment.displayName,'测试厂房');
  store.getState().undo(); assert.deepEqual(store.getState().scene.sceneSettings.modelEntrance.targetEntityIds,[]);
  store.getState().redo(); assert.deepEqual(store.getState().scene.sceneSettings.modelEntrance.targetEntityIds,[ENVIRONMENT_EFFECT_TARGET_ID]);
});
