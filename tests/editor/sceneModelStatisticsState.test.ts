import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.scene-statistics-state-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} } as unknown as Window & typeof globalThis;
after(async () => {
  if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else globalThis.window = previousWindow;
  assert.equal(path.dirname(temporaryRoot), path.resolve('node_modules'));
  assert.ok(path.basename(temporaryRoot).startsWith('.scene-statistics-state-'));
  await rm(temporaryRoot, { recursive: true, force: true });
});
const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument } from '../../src/editor/model/SceneDocument.ts';",
  "export { serializeScene } from '../../src/editor/project/SceneSerializer.ts';",
].join('\n'));
await build({ configFile: false, publicDir: false, logLevel: 'error',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: entry, outDir: path.join(temporaryRoot, 'ssr'),
    rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } } });
const { useEditorStore: store, createEmptySceneDocument, serializeScene }
  = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
const original = store.getState();
after(() => store.setState(original, true));

test('只读统计更新不改变场景文档、持久化内容或撤销历史；重复快照不触发状态更新', () => {
  const scene = createEmptySceneDocument('统计状态验收');
  store.getState().loadSceneFromContent(serializeScene(scene), 'statistics.scene.json');
  const before = store.getState();
  const snapshot = { sceneId: scene.id, phase: 'ready', modelTriangleCount: 120, environmentTriangleCount: 1000 };
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  try {
    before.setSceneModelStatistics(snapshot, before.sceneSessionId);
    const afterStatistics = store.getState();
    assert.deepEqual(afterStatistics.sceneModelStatistics, snapshot);
    assert.equal(afterStatistics.scene, before.scene);
    assert.equal(afterStatistics.history, before.history);
    assert.equal(afterStatistics.persistedSceneContent, before.persistedSceneContent);
    assert.equal(serializeScene(afterStatistics.scene), serializeScene(before.scene));
    afterStatistics.setSceneModelStatistics({ ...snapshot }, before.sceneSessionId);
    assert.equal(notifications, 1);
  } finally { unsubscribe(); }
});

test('拒绝旧会话及其它场景的异步统计；重开相同ID场景时清除旧数值', () => {
  const scene = createEmptySceneDocument('同一场景重开');
  const content = serializeScene(scene);
  store.getState().loadSceneFromContent(content, 'same.scene.json');
  const previous = store.getState();
  const snapshot = { sceneId: scene.id, phase: 'ready', modelTriangleCount: 12, environmentTriangleCount: 0 };
  previous.setSceneModelStatistics(snapshot, previous.sceneSessionId);
  store.getState().loadSceneFromContent(content, 'same.scene.json');
  const current = store.getState();
  assert.notEqual(current.sceneSessionId, previous.sceneSessionId);
  assert.equal(current.sceneModelStatistics, null);
  current.setSceneModelStatistics(snapshot, previous.sceneSessionId);
  assert.equal(store.getState().sceneModelStatistics, null);
  current.setSceneModelStatistics({ ...snapshot, sceneId: 'other-scene' }, current.sceneSessionId);
  assert.equal(store.getState().sceneModelStatistics, null);
  current.setSceneModelStatistics(snapshot, current.sceneSessionId);
  assert.deepEqual(store.getState().sceneModelStatistics, snapshot);
});

test('预览模式仍接收统计，初始化与清空快照不产生编辑命令', () => {
  const state = store.getState();
  store.setState({ runtimeMode: 'preview' });
  const snapshot = { sceneId: state.scene.id, phase: 'loading', modelTriangleCount: 0, environmentTriangleCount: 0 };
  state.setSceneModelStatistics(snapshot, state.sceneSessionId);
  assert.equal(store.getState().sceneModelStatistics.phase, 'loading');
  state.setSceneModelStatistics(null, state.sceneSessionId);
  assert.equal(store.getState().sceneModelStatistics, null);
  assert.equal(store.getState().history, state.history);
});
