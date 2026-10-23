import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporary = await mkdtemp(path.resolve('node_modules/.lighting-operations-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const entry = path.join(temporary, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument } from '../../src/editor/model/SceneDocument.ts';",
  "export { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
].join('\n'));
await build({ configFile: false, publicDir: false, logLevel: 'silent',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: entry, outDir: path.join(temporary, 'dist'), rolldownOptions: { output: { entryFileNames: 'entry.mjs' } } } });
const { useEditorStore: store, createEmptySceneDocument, createCommandHistory, getSceneLightingBakeSignature } = await import(pathToFileURL(path.join(temporary, 'dist/entry.mjs')).href);
const initial = store.getState(), previousApi = globalThis.window.editorApi;
beforeEach(() => {
  store.setState(initial, true);
  store.setState({ scene: createEmptySceneDocument('预检与草稿'), sceneSessionId: 'operations-session',
    history: createCommandHistory(), runtimeMode: 'edit', lightingManagerOpen: true });
  globalThis.window.editorApi = previousApi;
});
after(async () => {
  store.setState(initial, true);
  if (previousWindow === undefined) delete globalThis.window;
  else { globalThis.window = previousWindow; globalThis.window.editorApi = previousApi; }
  assert.equal(path.dirname(temporary), path.resolve('node_modules'));
  assert.match(path.basename(temporary), /^\.lighting-operations-/);
  await rm(temporary, { recursive: true, force: true });
});

test('预检是会话状态且旧请求不能覆盖新场景', () => {
  const before = store.getState(), scene = before.scene, history = before.history;
  before.requestLightingBakePreflight();
  const request = store.getState().lightingBakePreflightRequest;
  assert.ok(request?.id);
  assert.equal(store.getState().lightingBakePreflight.phase, 'checking');
  assert.equal(store.getState().scene, scene);
  assert.equal(store.getState().history, history);
  store.setState({ sceneSessionId: 'next-session' });
  store.getState().completeLightingBakePreflight(request.id, { signature: 'old', issues: [] });
  assert.notEqual(store.getState().lightingBakePreflight.phase, 'ready');
});

test('预检阻止原因保留而不覆盖真实烘焙失败', () => {
  store.setState({ lightingBakeStatus: { phase: 'error', message: '引擎失败' } });
  store.getState().requestLightingBakePreflight();
  const id = store.getState().lightingBakePreflightRequest.id;
  store.getState().completeLightingBakePreflight(id, { signature: getSceneLightingBakeSignature(store.getState().scene), issues: [{ code: 'probe-limit', severity: 'error', message: '探针超限' }] });
  assert.equal(store.getState().lightingBakePreflight.phase, 'blocked');
  assert.equal(store.getState().lightingBakeStatus.message, '引擎失败');
});

test('临时草稿预览不写文档或撤销，关闭归还', () => {
  const before = store.getState(), scene = before.scene, history = before.history;
  const draft = { baseScene: scene, sceneSessionId: before.sceneSessionId,
    lighting: scene.sceneSettings.lighting, appearance: { ...scene.sceneSettings.appearance, exposure: 1.4 } };
  assert.equal(before.setLightingDraftPreview(draft).ok, true);
  assert.ok(store.getState().lightingDraftPreview);
  assert.equal(store.getState().scene, scene);
  assert.equal(store.getState().history, history);
  store.getState().closeLightingManager();
  assert.equal(store.getState().lightingDraftPreview, null);
  assert.equal(store.getState().scene, scene);
});

test('历史的迟到响应不能跨场景写入', async () => {
  let resolve;
  globalThis.window.editorApi = { ...previousApi, getLightingBakeHistory: () => new Promise(r => { resolve = r; }) };
  const pending = store.getState().refreshLightingBakeTaskHistory();
  store.setState({ sceneSessionId: 'other-project-session' });
  resolve({ tasks: [{ taskId: 'old' }], totalStagingBytes: 10 });
  await pending;
  assert.equal(store.getState().lightingBakeTaskHistory, null);
});

test('关闭正在检查的管理器会释放checking，迟到结果不能阻止同场景重试', () => {
  const before = store.getState(), scene = before.scene, history = before.history;
  before.requestLightingBakePreflight();
  const cancelled = store.getState().lightingBakePreflightRequest;
  assert.equal(store.getState().lightingBakePreflight.phase, 'checking');
  store.getState().closeLightingManager();
  assert.equal(store.getState().lightingBakePreflightRequest, null);
  assert.equal(store.getState().lightingBakePreflight.phase, 'idle');
  store.getState().completeLightingBakePreflight(cancelled.id, { signature: getSceneLightingBakeSignature(scene), issues: [] });
  assert.equal(store.getState().lightingBakePreflight.phase, 'idle');
  store.getState().openLightingManager();
  store.getState().requestLightingBakePreflight();
  const retried = store.getState().lightingBakePreflightRequest;
  assert.ok(retried?.id && retried.id !== cancelled.id);
  store.getState().failLightingBakePreflight(cancelled.id, '旧检查失败');
  assert.equal(store.getState().lightingBakePreflightRequest, retried);
  store.getState().completeLightingBakePreflight(retried.id, { signature: getSceneLightingBakeSignature(scene), issues: [] });
  assert.equal(store.getState().lightingBakePreflight.phase, 'ready');
  store.getState().closeLightingManager();
  assert.equal(store.getState().lightingBakePreflight.phase, 'ready', '完成的报告可在同场景重新打开后查看');
  assert.equal(store.getState().scene, scene);
  assert.equal(store.getState().history, history);
});
