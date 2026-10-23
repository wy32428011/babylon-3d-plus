import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.lighting-manager-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
let store;
let originalState;
after(async () => {
  if (store && originalState) store.setState(originalState, true);
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules')
    || !path.basename(temporaryRoot).startsWith('.lighting-manager-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});

const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
].join('\n'));
await build({
  configFile: false, publicDir: false, logLevel: 'silent',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: entry, outDir: path.join(temporaryRoot, 'ssr'), rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } },
});
const { useEditorStore, createEmptySceneDocument, createCommandHistory, serializeScene, deserializeScene }
  = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
store = useEditorStore;
originalState = store.getState();
beforeEach(() => {
  store.setState(originalState, true);
  store.setState({ scene: createEmptySceneDocument('集中光照管理验收'), history: createCommandHistory(),
    sceneSessionId: 'manager-test-session', runtimeMode: 'edit', hierarchySelectionIds: [], logs: [] });
});

const addMesh = () => { store.getState().createMesh('cube'); return store.getState().scene.selectedEntityId; };
// 保留原业务回归的配置组合，统一发送到当前正式草稿合同。
const makeDraft = (patch = {}) => {
  const state = store.getState(), current = state.scene.sceneSettings.lighting;
  const { lightingBake, shadows, policy, ...rest } = patch;
  const shadowValues = { ...shadows }; delete shadowValues.mode;
  return { baseScene: state.scene, sceneSessionId: state.sceneSessionId,
    lighting: { ...current, ...(lightingBake ? { bake: lightingBake } : {}),
      ...(shadows ? { shadows: { ...current.shadows, ...shadowValues } } : {}), ...(policy ? { policy } : {}) }, ...rest };
};
const autoPolicy = () => ({ version: 1, defaults: {}, rules: [] });

test('集中窗口的打开、跨对象定位、预览和关闭均不写场景或撤销历史', () => {
  const id = addMesh(), before = serializeScene(store.getState().scene), undoCount = store.getState().history.undoStack.length;
  store.getState().openLightingManager();
  assert.equal(store.getState().lightingManagerOpen, true);
  assert.equal(store.getState().lightingManagerTab, 'overview');
  store.getState().openLightingManager({ tab: 'objects', entityIds: [id], nodeKey: '$mesh' });
  assert.equal(store.getState().lightingManagerTab, 'objects');
  assert.deepEqual(store.getState().lightingManagerFocus.entityIds, [id]);
  store.getState().refreshLightingManagerPreview();
  assert.equal(store.getState().lightingManagerPreviewRequest > 0, true);
  store.getState().closeLightingManager();
  assert.equal(store.getState().lightingManagerOpen, false);
  assert.equal(serializeScene(store.getState().scene), before);
  assert.equal(store.getState().history.undoStack.length, undoCount);
});

test('全局参数、场景规则与两个实体例外作为一次事务应用，可一次撤销重做及保存重开', () => {
  const first = addMesh(), second = addMesh(), state = store.getState();
  const before = serializeScene(state.scene), undoCount = state.history.undoStack.length;
  const policy = { ...autoPolicy(), rules: [{ id: 'all-dynamic', name: '设备默认', enabled: true,
    target: { kind: 'all' }, values: { mobility: 'dynamic', castShadows: false } }] };
  const result = store.getState().applyLightingManagementDraft(makeDraft({
    lightingBake: { ...state.scene.sceneSettings.lighting.bake, quality: 'high' },
    shadows: { ...state.scene.sceneSettings.lighting.shadows, mode: 'hybrid' }, policy,
    entityLighting: { [first]: { mobility: 'auto', castShadows: true, receiveShadows: false, bakeIndirect: true,
      nodeOverrides: {}, inheritPolicy: ['mobility', 'castShadows', 'bakeIndirect'] },
    [second]: { mobility: 'static', castShadows: true, receiveShadows: true, bakeIndirect: true, nodeOverrides: {} } },
  }));
  assert.equal(result.ok, true);
  assert.equal(store.getState().history.undoStack.length, undoCount + 1);
  assert.equal(store.getState().scene.sceneSettings.lighting.policy.rules[0].id, 'all-dynamic');
  const after = serializeScene(store.getState().scene);
  const restored = deserializeScene(after);
  assert.deepEqual(restored.sceneSettings.lighting.policy, policy);
  assert.deepEqual(restored.entities[first].components.lighting.inheritPolicy, ['mobility', 'castShadows', 'bakeIndirect']);
  store.getState().undo(); assert.equal(serializeScene(store.getState().scene), before);
  store.getState().redo(); assert.equal(serializeScene(store.getState().scene), after);
});

test('没有更改的完整草稿不会增加撤销或创建空规则配置', () => {
  addMesh(); const state = store.getState(), before = serializeScene(state.scene), count = state.history.undoStack.length;
  const result = state.applyLightingManagementDraft(makeDraft({ lightingBake: state.scene.sceneSettings.lighting.bake,
    shadows: state.scene.sceneSettings.lighting.shadows, policy: autoPolicy(), entityLighting: {} }));
  assert.equal(result.ok, true);
  assert.equal(store.getState().history.undoStack.length, count);
  assert.equal(serializeScene(store.getState().scene), before);
});

test('过时草稿或场景会话不会覆盖更新后的文档', () => {
  addMesh(); const draft = makeDraft({ policy: { ...autoPolicy(), defaults: { castShadows: false } } });
  store.getState().renameScene('已更新名称');
  const before = serializeScene(store.getState().scene);
  const result = store.getState().applyLightingManagementDraft(draft);
  assert.equal(result.ok, false); assert.match(result.message, /更新|变化|重新/);
  assert.equal(serializeScene(store.getState().scene), before);
  const wrongSession = store.getState().applyLightingManagementDraft({ ...makeDraft(), sceneSessionId: 'old-session' });
  assert.equal(wrongSession.ok, false);
});

test('任务、运行预览及锁定对象阻止原子应用，不产生部分更新', () => {
  const id = addMesh();
  for (const condition of ['baking', 'preview', 'locked']) {
    const scene = store.getState().scene;
    store.setState({ runtimeMode: condition === 'preview' ? 'preview' : 'edit', lightingBakeRequest: condition === 'baking' ? { id: 'baking' } : null,
      scene: { ...scene, entities: { ...scene.entities, [id]: { ...scene.entities[id], locked: condition === 'locked' } } } });
    const before = serializeScene(store.getState().scene), count = store.getState().history.undoStack.length;
    const result = store.getState().applyLightingManagementDraft(makeDraft({ policy: { ...autoPolicy(), defaults: { castShadows: false } },
      entityLighting: { [id]: { mobility: 'dynamic', castShadows: false, receiveShadows: true, bakeIndirect: true, nodeOverrides: {} } } }));
    assert.equal(result.ok, false, condition);
    assert.equal(serializeScene(store.getState().scene), before, condition);
    assert.equal(store.getState().history.undoStack.length, count, condition);
  }
});

test('恢复继承只移除选中对象的旧例外，保留其他配置和烘焙资产', () => {
  const first = addMesh(), second = addMesh();
  store.getState().updateEntityLightingSettings([first, second], { mobility: 'static', receiveShadows: false });
  const scene = store.getState().scene, secondSettings = scene.entities[second].components.lighting;
  const result = store.getState().applyLightingManagementDraft(makeDraft({ entityLighting: { [first]: null } }));
  assert.equal(result.ok, true);
  assert.equal(store.getState().scene.entities[first].components.lighting, undefined);
  assert.deepEqual(store.getState().scene.entities[second].components.lighting, secondSettings);
  assert.equal(store.getState().scene.sceneSettings.lighting.result, scene.sceneSettings.lighting.result);
  store.getState().undo();
  assert.deepEqual(store.getState().scene.entities[first].components.lighting, scene.entities[first].components.lighting);
});

test('复制整个分组同时携带其场景规则，新分组规则与实体作为一次粘贴撤销', () => {
  store.getState().createFolder();
  const folderId = store.getState().scene.selectedEntityId;
  const meshId = addMesh();
  const current = store.getState().scene;
  // 测试夹具将普通实体放入已创建的真实分组，不把继承值写到实体上。
  store.setState({ scene: { ...current, entities: { ...current.entities,
    [folderId]: { ...current.entities[folderId], childrenIds: [meshId] },
    [meshId]: { ...current.entities[meshId], parentId: folderId } } } });
  const policy = { ...autoPolicy(), rules: [{ id: 'building-group', name: '建筑分组', enabled: true,
    target: { kind: 'group', folderId }, values: { castShadows: false } }] };
  assert.equal(store.getState().applyLightingManagementDraft(makeDraft({ policy })).ok, true);
  store.getState().selectEntity(folderId); store.getState().copySelectedEntities();
  const beforePaste = serializeScene(store.getState().scene);
  const oldIds = new Set(store.getState().scene.entityIds);
  store.getState().pasteEntityClipboard(null);
  const after = store.getState().scene;
  const newFolder = after.entityIds.map(id => after.entities[id]).find(entity => !oldIds.has(entity.id) && entity.isFolder);
  assert.ok(newFolder);
  const copiedRule = after.sceneSettings.lighting.policy.rules.find(rule => rule.target.kind === 'group' && rule.target.folderId === newFolder.id);
  assert.ok(copiedRule, '分组副本必须保留原有集中规则');
  assert.notEqual(copiedRule.id, 'building-group');
  assert.deepEqual(copiedRule.values, { castShadows: false });
  assert.equal(after.entities[newFolder.childrenIds[0]].components.lighting, undefined);
  store.getState().undo(); assert.equal(serializeScene(store.getState().scene), beforePaste);
});

test('不完整规则不能被静默丢弃后当作成功应用', () => {
  addMesh(); const before = serializeScene(store.getState().scene);
  const result = store.getState().applyLightingManagementDraft(makeDraft({ policy: {
    ...autoPolicy(), rules: [{ id: 'missing-resource', enabled: true, target: { kind: 'resource', model: {} }, values: { castShadows: false } }],
  } }));
  assert.equal(result.ok, false);
  assert.match(result.message, /规则|资源|完整/);
  assert.equal(serializeScene(store.getState().scene), before);
});

test('已有静态部件遇到动态祖先时仍可恢复继承或改阴影，只有新显式静态才被拒绝', () => {
  const id = addMesh(), scene = store.getState().scene;
  const legacy = { mobility: 'auto', castShadows: true, receiveShadows: true, bakeIndirect: true,
    nodeOverrides: { part: { mobility: 'static', castShadows: true } } };
  const original = { ...scene, entities: { ...scene.entities, [id]: { ...scene.entities[id],
    components: { ...scene.entities[id].components, lighting: legacy } } } };
  const classification = [{ key: id + '/part', entityId: id, nodeKey: 'part', name: '部件', mobility: 'dynamic',
    parentDynamic: true, reason: '动态祖先', castShadows: true, receiveShadows: true, bakeIndirect: true }];
  for (const patch of [{ inheritPolicy: ['mobility'] }, { castShadows: false }]) {
    store.setState({ scene: original, lightingClassification: classification, history: createCommandHistory() });
    const settings = structuredClone(legacy);
    Object.assign(settings.nodeOverrides.part, patch);
    const result = store.getState().applyLightingManagementDraft(makeDraft({ entityLighting: { [id]: settings } }));
    assert.equal(result.ok, true, JSON.stringify(patch));
  }
  const inherited = structuredClone(legacy);
  inherited.nodeOverrides.part.inheritPolicy = ['mobility'];
  const inheritedScene = { ...original, entities: { ...original.entities, [id]: { ...original.entities[id],
    components: { ...original.entities[id].components, lighting: inherited } } } };
  store.setState({ scene: inheritedScene, lightingClassification: classification });
  assert.equal(store.getState().applyLightingManagementDraft(makeDraft({ entityLighting: { [id]: legacy } })).ok, false);
});
