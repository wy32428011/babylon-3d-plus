import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.effect-configuration-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const deadline = setTimeout(() => { console.error('特效 V2 配置集成验证超时'); process.exit(1); }, 120000);
let store, originalState;
after(async () => {
  clearTimeout(deadline);
  if (store && originalState) store.setState(originalState, true);
  if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules') || !path.basename(temporaryRoot).startsWith('.effect-configuration-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});

// 单入口使用真实 Store 和 Serializer；同一次构建共享模块实例与撤销历史。
const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument, createMeshEntity, createPoiEffectEntity } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { VISIBLE_POI_EFFECT_DEFINITIONS, createDefaultPoiEffectComponent } from '../../src/editor/model/poiEffect.ts';",
  "export { getEffectParameterDefinitions } from '../../src/editor/model/effectParameterRegistry.ts';",
  "export { createDefaultEffectConfiguration, sanitizeEffectConfiguration, validateEffectConfiguration } from '../../src/editor/model/effectConfigurationValidation.ts';",
].join('\n'));
await build({ configFile: false, publicDir: false, logLevel: 'silent', ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: entry, outDir: path.join(temporaryRoot, 'ssr'), rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } } });
const { useEditorStore, createEmptySceneDocument, createMeshEntity, createPoiEffectEntity, createCommandHistory,
  serializeScene, deserializeScene, VISIBLE_POI_EFFECT_DEFINITIONS, createDefaultPoiEffectComponent,
  getEffectParameterDefinitions, createDefaultEffectConfiguration, sanitizeEffectConfiguration, validateEffectConfiguration,
} = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
store = useEditorStore; originalState = store.getState();
beforeEach(() => { store.setState(originalState, true); store.setState({ scene: createEmptySceneDocument('特效 V2 配置验收'),
  history: createCommandHistory(), runtimeMode: 'edit', hierarchySelectionIds: [], entityClipboard: null, logs: [] }); });

function append(scene, entities) { for (const entity of entities) { scene.entityIds.push(entity.id); scene.entities[entity.id] = entity; } }
function selectedEffect() { const state = store.getState(); return state.scene.entities[state.scene.selectedEntityId].components.poiEffect; }
function rows(key) {
  if (key === 'structureGroups') return [{ nodePath: 'Floor1', order: 1, distance: 2.5, axis: 'y', fixed: false, offset: { x: .5, y: 1, z: -.5 } }, { nodePath: 'Floor2', order: 2, distance: 3, axis: 'x', fixed: true }];
  if (key === 'gradientStops') return [{ position: 0, color: '#125abc' }, { position: .5, color: '#abcdef' }, { position: 1, color: '#ff5511' }];
  if (key === 'regions') return [{ id: 'A-001', name: '分区 A', value: 0, points: [{ x: -2, y: .3, z: -2 }, { x: 2, y: .3, z: -2 }, { x: 2, y: .3, z: 2 }, { x: -2, y: .3, z: 2 }] }];
  if (key === 'levels' || key === 'colorStops') return [{ value: 0, color: '#125abc' }, { value: 100, color: '#ff5511' }];
  if (key === 'segments') return [{ label: '接收', threshold: .2 }, { label: '完成', threshold: 1 }];
  if (key === 'routePoints') return [{ x: -2, y: .2, z: 0 }, { x: 2, y: .2, z: 0 }, { x: 2, y: .2, z: 3 }];
  throw new Error(`请为新的 rows 属性 ${key} 增加真实样本。`);
}
function parameter(definition) {
  if (definition.type === 'number') { const step = definition.step ?? Math.min(.25, ((definition.max ?? 100) - (definition.min ?? -100)) / 4);
    return definition.default + step <= (definition.max ?? Infinity) ? definition.default + step : Math.max(definition.min ?? -Infinity, definition.default - step); }
  if (definition.type === 'boolean') return !definition.default;
  if (definition.type === 'select') return (definition.options.find(option => option.value !== definition.default) ?? definition.options[0]).value;
  if (definition.type === 'color') return '#125abc';
  if (definition.type === 'string') return 'fixture-node';
  if (definition.type === 'vector') return { x: 1.25, y: 2.5, z: 3.75 };
  if (definition.type === 'rows') return rows(definition.key);
  throw new Error(`未覆盖参数类型 ${definition.type}`);
}
function configured(component, targetId, index = 3) {
  const configuration = createDefaultEffectConfiguration(component);
  configuration.target = { mode: 'entity', entityId: targetId, model: { name: '仅用于匹配的 RGV 模板', sourceUrl: 'https://fixture.invalid/templates/rgv.glb',
    sourcePath: 'C:/fixture-metadata-only/rgv.glb', deviceType: 'rgv', identity: { sourceKey: 'fixture-platform', kind: 'model', resourceId: '9000000001', modelPath: 'rgv/rgv.glb' } },
    sourceId: 'factory-a', deviceType: 'rgv', assetCode: '000317', selection: 'single', maxTargets: 7, anchor: 'node', nodePath: 'Fixture/Device', offset: { x: 1.25, y: -.5, z: 2.75 } };
  configuration.data = { mode: ['none', 'inherit', 'mqtt', 'http'][index % 4], sourceId: 'factory-a', deviceType: 'rgv', assetCode: '000317', expectedIntervalMs: 750,
    staleAfterMs: 5500, missing: ['pause', 'hide', 'hold'][index % 3], http: { mode: index % 2 ? 'data-source' : 'mqtt-latest', dataSourceId: '42', namespace: 'fixture-space', pollIntervalMs: 1500, timeoutMs: 9500 },
    mappings: [{ field: 'runningState', target: 'enabled', scale: 1, offset: 0, values: [{ value: 'running', output: true }, { value: 'offline', output: false }] },
      { field: 'speed', target: 'speed', scale: .001, offset: .25, values: [] }],
    dataset: { enabled: ['heatmap', 'region-level', 'data-bars'].includes(component.effectKind), rowsPath: 'data.rows', idPath: 'id', xPath: 'position.x', yPath: 'position.y', zPath: 'position.z', valuePath: 'count', labelPath: 'name', unitScale: .001, coordinateSpace: 'world' },
    trigger: { enabled: true, field: 'runningState', operator: 'eq', value: 'running', debounceMs: 350 } };
  configuration.parameters = Object.fromEntries(getEffectParameterDefinitions(component.effectKind).map(definition => {
    const value = parameter(definition); assert.equal(definition.validate?.(value) ?? null, null, `${component.effectKind}.${definition.key}`); return [definition.key, value];
  }));
  validateEffectConfiguration(configuration, component.effectKind);
  assert.deepEqual(sanitizeEffectConfiguration(configuration, component), configuration, `${component.effectKind} 全部字段必须可原样保存`);
  return configuration;
}

test('61 类可见特效的 V2 字段支持 Store、撤销重做、保存重开和参数副本隔离', async () => {
  assert.equal(VISIBLE_POI_EFFECT_DEFINITIONS.length, 61);
  const target = createMeshEntity('cube'); target.name = '仅用于特效绑定的测试建筑';
  const scene = createEmptySceneDocument('全部 61 类可见特效 V2'); append(scene, [target]); store.setState({ scene });
  const expected = new Map(); let parameterCount = 0;
  for (const [index, definition] of VISIBLE_POI_EFFECT_DEFINITIONS.entries()) {
    store.getState().createPoiEffect(definition.kind, { x: index % 8, y: .2, z: Math.floor(index / 8) });
    const id = store.getState().scene.selectedEntityId, before = structuredClone(selectedEffect());
    const configuration = configured(before, target.id, index); parameterCount += Object.keys(configuration.parameters).length;
    const requested = { ...before, configuration };
    store.getState().updateSelectedPoiEffect(requested, `验证 ${definition.kind} V2 配置`);
    assert.deepEqual(selectedEffect().configuration, configuration, definition.kind);
    const after = structuredClone(selectedEffect()); expected.set(id, after);
    configuration.data.assetCode = 'changed'; configuration.target.offset.x = 999; configuration.parameters = {};
    assert.deepEqual(selectedEffect(), after, `${definition.kind} Store 必须克隆输入`);
    store.getState().undo(); assert.deepEqual(selectedEffect(), before, `${definition.kind} undo`);
    store.getState().redo(); assert.deepEqual(selectedEffect(), after, `${definition.kind} redo`);
  }
  const content = serializeScene(store.getState().scene), reopened = deserializeScene(content);
  for (const [id, effect] of expected) assert.deepEqual(reopened.entities[id].components.poiEffect, effect, effect.effectKind);
  assert.equal(store.getState().loadSceneFromContent(content, '特效 V2 重开'), true);
  for (const [id, effect] of expected) assert.deepEqual(store.getState().scene.entities[id].components.poiEffect, effect);
  assert.equal(store.getState().hasUnsavedChanges(), false);
  const output = path.resolve('output/effect-configuration'); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'scene.scene.json'), content, 'utf8');
  await writeFile(path.join(output, 'store-result.json'), JSON.stringify({ ok: true, effectCount: expected.size, parameterCount,
    kinds: [...expected.values()].map(effect => effect.effectKind), checks: ['all-v2-fields', 'undo-redo', 'clone-input', 'serialize-deserialize', 'store-reopen'] }, null, 2));
});

test('复制目标和特效仅重映射内部实体引用，保留外部模型身份与前导零资产编号', () => {
  for (const effectOnly of [false, true]) {
    const scene = createEmptySceneDocument('V2 引用复制'), target = createMeshEntity('cube'), effect = createPoiEffectEntity('target-follow');
    effect.components.poiEffect.configuration = configured(effect.components.poiEffect, target.id);
    Object.assign(effect.components.poiEffect.configuration.target, {generatorId:target.id,instanceSource:'generated',instanceKey:'containerCode',followSelection:'manual'});
    effect.components.poiEffect.configuration.data.inheritFrom='carrier';
    effect.components.poiEffect.visual.targetEntityId = target.id;
    // 外部业务字符串故意与内部实体 ID 重号，不能通过递归替换字符串误改。
    effect.components.poiEffect.configuration.target.model.identity.resourceId = target.id;
    effect.components.poiEffect.configuration.data.sourceId = target.id;
    append(scene, [target, effect]); store.setState({ scene, history: createCommandHistory(), hierarchySelectionIds: [], entityClipboard: null });
    const ids = effectOnly ? [effect.id] : [target.id, effect.id];
    store.getState().selectHierarchyEntities(ids, effect.id); store.getState().copySelectedEntities(); store.getState().pasteEntityClipboard();
    const after = store.getState().scene, copies = after.entityIds.filter(id => !scene.entities[id]).map(id => after.entities[id]);
    const effectCopy = copies.find(entity => entity.components.poiEffect), targetCopy = copies.find(entity => entity.components.meshRenderer);
    assert.ok(effectCopy); const configuration = effectCopy.components.poiEffect.configuration;
    assert.equal(configuration.target.entityId, targetCopy?.id ?? target.id);
    assert.equal(configuration.target.generatorId, targetCopy?.id ?? target.id);
    assert.equal(configuration.target.instanceSource,'generated');
    assert.equal(configuration.target.instanceKey,'containerCode');
    assert.equal(configuration.target.followSelection,'manual');
    assert.equal(configuration.data.inheritFrom,'carrier');
    assert.equal(effectCopy.components.poiEffect.visual.targetEntityId, targetCopy?.id ?? target.id);
    assert.deepEqual(configuration.target.model, effect.components.poiEffect.configuration.target.model);
    assert.equal(configuration.data.sourceId, target.id); assert.equal(configuration.data.assetCode, '000317'); assert.equal(configuration.target.assetCode, '000317');
    assert.notEqual(configuration, effect.components.poiEffect.configuration);
    assert.notEqual(configuration.data.mappings, effect.components.poiEffect.configuration.data.mappings);
    const roundtrip = deserializeScene(serializeScene(after)); assert.deepEqual(roundtrip.entities[effectCopy.id].components.poiEffect, effectCopy.components.poiEffect);
    store.getState().undo(); assert.equal(store.getState().scene.entities[effectCopy.id], undefined);
    store.getState().redo(); assert.deepEqual(store.getState().scene.entities[effectCopy.id].components.poiEffect, effectCopy.components.poiEffect);
  }
});

test('旧无 configuration 场景读写不自动注入 V2，保留原有特效结构', () => {
  for (const definition of VISIBLE_POI_EFFECT_DEFINITIONS) {
    store.getState().createPoiEffect(definition.kind);
    assert.equal(Object.hasOwn(selectedEffect(), 'configuration'), false);
  }
  const before = store.getState().scene, content = serializeScene(before), reopened = deserializeScene(content);
  for (const id of before.entityIds) { assert.deepEqual(reopened.entities[id].components.poiEffect, before.entities[id].components.poiEffect); assert.equal(Object.hasOwn(reopened.entities[id].components.poiEffect, 'configuration'), false); }
});

test('多对象和同类型全部绑定支持保存重开及撤销，复制只映射本批实体 ID', () => {
  for (const copyMode of ['effect-only', 'partial', 'all']) {
    const scene = createEmptySceneDocument('多模型绑定保存与复制');
    const first = createMeshEntity('cube'), second = createMeshEntity('cube'), external = createMeshEntity('cube');
    const effect = createPoiEffectEntity('model-outline');
    effect.components.poiEffect.configuration = configured(effect.components.poiEffect, first.id);
    const target = effect.components.poiEffect.configuration.target;
    target.entityIds = [first.id, second.id, external.id]; target.selection = 'all';
    target.model.identity.resourceId = first.id;
    effect.components.poiEffect.configuration.data.sourceId = first.id;
    append(scene, [first, second, external, effect]);
    store.setState({ scene, history: createCommandHistory(), hierarchySelectionIds: [], entityClipboard: null });
    const original = structuredClone(effect.components.poiEffect);
    assert.deepEqual(deserializeScene(serializeScene(scene)).entities[effect.id].components.poiEffect, original);
    const ids = copyMode === 'effect-only' ? [effect.id] : copyMode === 'partial' ? [first.id, effect.id] : [first.id, second.id, effect.id];
    store.getState().selectHierarchyEntities(ids, effect.id); store.getState().copySelectedEntities(); store.getState().pasteEntityClipboard();
    const after = store.getState().scene, copies = after.entityIds.filter(id => !scene.entities[id]).map(id => after.entities[id]);
    const copiedEffect = copies.find(entity => entity.components.poiEffect);
    assert.ok(copiedEffect);
    const copiedModels = copies.filter(entity => entity.components.meshRenderer);
    const expectedIds = [copiedModels[0]?.id ?? first.id, copiedModels[1]?.id ?? second.id, external.id];
    const configuration = copiedEffect.components.poiEffect.configuration;
    assert.deepEqual(configuration.target.entityIds, expectedIds, copyMode);
    assert.equal(configuration.target.entityId, expectedIds[0]);
    assert.notEqual(configuration.target.entityIds, target.entityIds, '复制后的列表不能共享引用');
    assert.deepEqual(configuration.target.model, target.model, '模型资源业务标识不能映射为新实体 ID');
    assert.equal(configuration.data.sourceId, first.id); assert.equal(configuration.target.assetCode, '000317');
    const content = serializeScene(after);
    assert.deepEqual(deserializeScene(content).entities[copiedEffect.id].components.poiEffect, copiedEffect.components.poiEffect);
    store.getState().undo(); assert.equal(store.getState().scene.entities[copiedEffect.id], undefined);
    store.getState().redo(); assert.deepEqual(store.getState().scene.entities[copiedEffect.id].components.poiEffect, copiedEffect.components.poiEffect);
    assert.deepEqual(store.getState().scene.entities[effect.id].components.poiEffect, original, '复制不能修改原特效');
    assert.equal(store.getState().loadSceneFromContent(content, '多对象绑定重开'), true);
    assert.deepEqual(store.getState().scene.entities[copiedEffect.id].components.poiEffect.configuration.target.entityIds, expectedIds);
  }
  for (const kind of ['model-outline', 'motion-trail']) {
    const effect = createPoiEffectEntity(kind), configuration = configured(effect.components.poiEffect, 'legacy-target');
    Object.assign(configuration.target, { mode: 'model', entityId: null, entityIds: [], selection: 'all', instanceSource: 'all' });
    effect.components.poiEffect.configuration = configuration;
    const scene = createEmptySceneDocument('同类型全部绑定'); append(scene, [effect]);
    assert.deepEqual(deserializeScene(serializeScene(scene)).entities[effect.id].components.poiEffect.configuration, configuration, kind);
  }
});

test('导入拒绝非法版本、原型键和特效专用 rows，不以归一化悄悄丢弃非法内容', () => {
  const scene = createEmptySceneDocument('拒绝非法 V2'), target = createMeshEntity('cube'), effect = createPoiEffectEntity('region-level');
  effect.components.poiEffect.configuration = configured(effect.components.poiEffect, target.id); append(scene, [target, effect]);
  const source = JSON.parse(serializeScene(scene));
  const mutations = [
    configuration => { configuration.version = 3; },
    configuration => { configuration.parameters.regions[0].points = [{ x: 0, y: 0, z: 0 }]; },
    configuration => { configuration.parameters.regions = [{ id: 'A', value: 0, points: [] }]; },
    configuration => { configuration.parameters.regions = [configuration.parameters.regions[0], structuredClone(configuration.parameters.regions[0])]; },
    configuration => { configuration.parameters.regions[0].value = null; },
    configuration => { configuration.parameters.colorStops = [{ value: 0, color: 'invalid' }]; },
    configuration => { Object.defineProperty(configuration.parameters, '__proto__', { enumerable: true, value: { polluted: true } }); },
    configuration => { configuration.data.mappings[0].values[0].prototype = 'bad'; },
  ];
  for (const mutation of mutations) { const document = structuredClone(source); mutation(document.scene.entities[effect.id].components.poiEffect.configuration); assert.throws(() => deserializeScene(JSON.stringify(document)), /场景/); }
  assert.equal({}.polluted, undefined);
});

test('锁定和运行预览不允许修改 V2 配置或撤销历史', () => {
  store.getState().createPoiEffect('target-follow'); const id = store.getState().scene.selectedEntityId;
  const requested = { ...selectedEffect(), configuration: configured(selectedEffect(), 'future-target') };
  store.getState().toggleEntityLocked(id);
  let scene = store.getState().scene, history = store.getState().history;
  store.getState().updateSelectedPoiEffect(requested); assert.equal(store.getState().scene, scene); assert.equal(store.getState().history, history);
  store.getState().toggleEntityLocked(id); store.setState({ runtimeMode: 'preview' });
  scene = store.getState().scene; history = store.getState().history;
  store.getState().updateSelectedPoiEffect(requested); assert.equal(store.getState().scene, scene); assert.equal(store.getState().history, history);
});
