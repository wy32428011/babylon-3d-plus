import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.digital-twin-effects-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const deadline = setTimeout(() => {
  console.error('数字孪生特效集成验证超时');
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
    || !path.basename(temporaryRoot).startsWith('.digital-twin-effects-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});

// 单入口预构建使所有断言共享一个 Store，避免动态 SSR 加载停滞。
const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument, createModelEntity, createFolderEntity, createPoiEffectEntity } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { POI_EFFECT_KINDS, createDefaultPoiEffectComponent } from '../../src/editor/model/poiEffect.ts';",
  "export { DIGITAL_TWIN_EFFECT_DEFINITIONS, collectDigitalTwinEffectTargetIds } from '../../src/editor/model/digitalTwinEffect.ts';",
  "export { createEditModeModelThinInstancePlan, createPersistedModelThinInstanceScene } from '../../src/editor/model/editModeModelThinInstances.ts';",
  "export { createPoiEffectLibraryItems } from '../../src/editor/assets/projectLibrary.ts';",
  "export { encodeBuiltInAssetDragPayload, decodeBuiltInAssetDragPayload } from '../../src/editor/assets/AssetDatabase.ts';",
].join('\n'));
await build({
  configFile: false, publicDir: false, logLevel: 'silent',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: entry, outDir: path.join(temporaryRoot, 'ssr'),
    rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } },
});
const {
  useEditorStore, createEmptySceneDocument, createModelEntity, createFolderEntity, createPoiEffectEntity, createCommandHistory, serializeScene, deserializeScene,
  POI_EFFECT_KINDS, DIGITAL_TWIN_EFFECT_DEFINITIONS, createDefaultPoiEffectComponent, createPoiEffectLibraryItems,
  encodeBuiltInAssetDragPayload, decodeBuiltInAssetDragPayload, collectDigitalTwinEffectTargetIds,
  createEditModeModelThinInstancePlan, createPersistedModelThinInstanceScene,
} = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
store = useEditorStore;
originalState = store.getState();
beforeEach(() => {
  store.setState(originalState, true);
  store.setState({ scene: createEmptySceneDocument('数字孪生特效验收'), history: createCommandHistory(),
    runtimeMode: 'edit', hierarchySelectionIds: [], entityClipboard: null, logs: [] });
});

test('新版特效的创建、撤销、拖拽协议和完整序列化', async () => {
  for (const definition of DIGITAL_TWIN_EFFECT_DEFINITIONS) {
    const card = createPoiEffectLibraryItems().find(x => x.builtIn?.effectKind === definition.kind);
    assert.ok(card, definition.kind);
    const payload = decodeBuiltInAssetDragPayload(encodeBuiltInAssetDragPayload(card.builtIn));
    store.getState().createPoiEffect(payload.effectKind, { x: 3, y: 1, z: 2 });
    const id = store.getState().scene.selectedEntityId;
    const component = store.getState().scene.entities[id].components.poiEffect;
    const requested = { ...component, speed: 0, visual: { ...component.visual, targetEntityId: 'future-model', opacity: 0, progress: 0, loop: false } };
    store.getState().updateSelectedPoiEffect(requested);
    requested.visual.points[0].x = 999;
    assert.notEqual(store.getState().scene.entities[id].components.poiEffect.visual.points[0].x, 999);
    store.getState().undo();
    assert.deepEqual(store.getState().scene.entities[id].components.poiEffect, component);
    store.getState().redo();
  }
  const before = store.getState().scene;
  const serialized = serializeScene(before);
  const after = deserializeScene(serialized);
  for (const id of before.entityIds) assert.deepEqual(after.entities[id].components.poiEffect, before.entities[id].components.poiEffect);
  await mkdir('output/digital-twin-effects', { recursive: true });
  await writeFile('output/digital-twin-effects/scene.scene.json', serialized);
});

test('复制数组相互独立，无效导入不静默丢弃用户路径', () => {
  store.getState().createPoiEffect('flow-path');
  const originalId = store.getState().scene.selectedEntityId;
  store.getState().copySelectedEntities();
  store.getState().pasteEntityClipboard();
  const copyId = store.getState().scene.selectedEntityId;
  assert.notEqual(copyId, originalId);
  const copy = structuredClone(store.getState().scene.entities[copyId].components.poiEffect);
  copy.visual.points[0].x = -10;
  store.getState().updateSelectedPoiEffect(copy);
  assert.notEqual(store.getState().scene.entities[originalId].components.poiEffect.visual.points[0].x, -10);
  const broken = JSON.parse(serializeScene(store.getState().scene));
  broken.scene.entities[copyId].components.poiEffect.visual.points = [{x:0,y:0,z:0}];
  assert.throws(() => deserializeScene(JSON.stringify(broken)));
});

test('旧特效场景仍可读写，新库不再提供移除的旧卡片', () => {
  for (const kind of ['radar-scan','locator-beam','fire','smoke','moving-double-arrow','pipeline-flow-arrows']) store.getState().createPoiEffect(kind);
  const saved = serializeScene(store.getState().scene);
  assert.equal(deserializeScene(saved).entityIds.length, 6);
  assert.equal(createPoiEffectLibraryItems().some(card => card.builtIn.effectKind === 'fire'), false);
});

function appendEntities(scene, entities) {
  for (const entity of entities) { scene.entityIds.push(entity.id); scene.entities[entity.id] = entity; }
}

function createEffectTargetFixture() {
  const target = createModelEntity('C:/models/building.glb', 'editor-asset://local/building.glb', '建筑模型');
  const effect = createPoiEffectEntity('model-outline');
  effect.components.poiEffect.visual.targetEntityId = target.id;
  return { target, effect };
}

test('组内与跨根复制模型和特效重映射目标，仅复制特效保留原目标', () => {
  for (const grouping of ['folder', 'multiple-roots', 'effect-only']) {
    const scene = createEmptySceneDocument('特效绑定复制');
    const { target, effect } = createEffectTargetFixture();
    const folder = createFolderEntity('建筑特效组');
    if (grouping === 'folder') {
      folder.childrenIds = [target.id, effect.id]; target.parentId = effect.parentId = folder.id;
      appendEntities(scene, [folder]);
    }
    appendEntities(scene, [target, effect]);
    store.setState({ scene, history: createCommandHistory(), hierarchySelectionIds: [], entityClipboard: null });
    const selected = grouping === 'folder' ? [folder.id] : grouping === 'effect-only' ? [effect.id] : [target.id, effect.id];
    store.getState().selectHierarchyEntities(selected, selected[0]);
    store.getState().copySelectedEntities(); store.getState().pasteEntityClipboard();
    const after = store.getState().scene;
    const copies = after.entityIds.filter(id => !scene.entities[id]).map(id => after.entities[id]);
    const effectCopy = copies.find(entity => entity.components.poiEffect);
    const targetCopy = copies.find(entity => entity.components.modelAsset);
    assert.ok(effectCopy, grouping);
    assert.equal(effectCopy.components.poiEffect.visual.targetEntityId, targetCopy?.id ?? target.id, grouping);
    assert.equal(after.entities[effect.id].components.poiEffect.visual.targetEntityId, target.id);
    const restored = deserializeScene(serializeScene(after));
    assert.equal(restored.entities[effectCopy.id].components.poiEffect.visual.targetEntityId, targetCopy?.id ?? target.id);
    store.getState().undo();
    assert.equal(store.getState().scene.entities[effectCopy.id], undefined);
    store.getState().redo();
    assert.equal(store.getState().scene.entities[effectCopy.id].components.poiEffect.visual.targetEntityId, targetCopy?.id ?? target.id);
  }
});

test('新绑定目标不成为薄实例源或副本，其他同模板模型保持合批', () => {
  const scene = createEmptySceneDocument('独立模型特效');
  const { target, effect } = createEffectTargetFixture();
  const second = createModelEntity('C:/models/building.glb', 'editor-asset://local/building.glb', '普通建筑 2');
  const third = createModelEntity('C:/models/building.glb', 'editor-asset://local/building.glb', '普通建筑 3');
  appendEntities(scene, [target, second, third, effect]);
  const plan = createEditModeModelThinInstancePlan(scene);
  assert.equal(plan.entities[target.id].components.modelArrayInstance, undefined);
  const instances = [second, third].map(entity => plan.entities[entity.id].components.modelArrayInstance).filter(Boolean);
  assert.equal(instances.length, 1);
  assert.notEqual(instances[0].sourceEntityId, target.id);
  assert.equal(scene.entities[second.id].components.modelArrayInstance, undefined);
  const restored = deserializeScene(serializeScene(scene));
  assert.equal(restored.entities[target.id].components.modelArrayInstance, undefined);
  assert.ok([second, third].some(entity => restored.entities[entity.id].components.modelArrayInstance));
});

test('旧合批的目标源、目标副本和链式伙伴均恢复独立，配置输入不被修改', () => {
  for (const targetIndex of [0, 1]) {
    const scene = createEmptySceneDocument('旧合批特效目标');
    const members = Array.from({ length: 3 }, (_, index) => createModelEntity('C:/models/building.glb', 'editor-asset://local/building.glb', '既有批次 ' + index));
    members[1].components.modelArrayInstance = { sourceEntityId: members[0].id };
    members[2].components.modelArrayInstance = { sourceEntityId: members[1].id };
    const effect = createPoiEffectEntity('motion-trail');
    effect.components.poiEffect.enabled = false;
    effect.components.poiEffect.visual.targetEntityId = members[targetIndex].id;
    const unrelated = [0, 1].map(index => createModelEntity('C:/models/other.glb', 'editor-asset://local/other.glb', '无关模型 ' + index));
    appendEntities(scene, [...members, effect, ...unrelated]);
    const independentIds = collectDigitalTwinEffectTargetIds(scene);
    for (const member of members) assert.ok(independentIds.has(member.id), member.id);
    for (const other of unrelated) assert.equal(independentIds.has(other.id), false);
    const saved = createPersistedModelThinInstanceScene(scene);
    for (const member of members) assert.equal(saved.entities[member.id].components.modelArrayInstance, undefined);
    assert.ok(scene.entities[members[1].id].components.modelArrayInstance);
    assert.ok(unrelated.some(entity => saved.entities[entity.id].components.modelArrayInstance));
    const reopened = deserializeScene(serializeScene(scene));
    for (const member of members) assert.equal(reopened.entities[member.id].components.modelArrayInstance, undefined);
    assert.equal(reopened.entities[effect.id].components.poiEffect.visual.targetEntityId, members[targetIndex].id);
  }
});
