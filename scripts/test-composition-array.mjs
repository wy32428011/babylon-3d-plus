import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';

const project = new URL('../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.includes('?') && specifier.startsWith('.')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
    if (specifier.startsWith('@babylonjs/') && specifier.split('/').length > 2 && !specifier.endsWith('.js')) return next(specifier + '.js', context);
    if (specifier.startsWith('lodash/') && !specifier.endsWith('.js')) return next(specifier + '.js', context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(project.href)) {
      const candidate = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(project.href) && (/\.(png|jpe?g|webp|gif|svg|glb|gltf|bin)(\?.*)?$/i.test(url) || url.includes('?url'))) return {
      format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)};`,
    };
    if (url.startsWith(project.href) && url.endsWith('.ts') && !url.includes('/node_modules/')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return next(url, context);
  },
});
try {
  const { useEditorStore: store } = await import('../src/editor/store/editorStore.ts');
  const { createEmptySceneDocument, createFolderEntity, createMeshEntity, createModelEntity, createLocatorEntity } = await import('../src/editor/model/SceneDocument.ts');
  const { serializeScene, deserializeScene } = await import('../src/editor/project/SceneSerializer.ts');
  const root = createFolderEntity('组合01');
  root.composition = { schemaVersion: 1, instanceId: 'original-instance', libraryId: 'library', revision: 'fixed' };
  const nested = createFolderEntity('嵌套');
  const host = createModelEntity('C:/fixture/model.glb', 'editor-asset://local/C%3A%2Ffixture%2Fmodel.glb', '宿主', { lengthUnit: 'meter', unitScaleToMeters: 1 });
  host.components.modelAsset.parameterConfig = { schema: 'babylon-editor.model-parameters', version: 1,
    parameters: [{ key: 'length', label: '长度', type: 'number', defaultValue: 1 }], bindings: [] };
  host.components.modelAsset.parameterValues = { length: 7 };
  const mesh = createMeshEntity('plane');
  mesh.compositionNodeId = 'mesh-node';
  const instance = structuredClone(host);
  instance.id = 'internal-array';
  instance.name = '阵列成员';
  instance.components.modelArrayInstance = { sourceEntityId: host.id };
  const external = structuredClone(host);
  external.id = 'external-model';
  external.name = '组外源';
  const borrowed = structuredClone(instance);
  borrowed.id = 'borrowed';
  borrowed.name = '借用模型';
  borrowed.components.modelArrayInstance = { sourceEntityId: external.id };
  host.components.telemetryBinding = { enabled: true, sourceId: 'mqtt-source', deviceType: 'rgv', expectedIntervalMs: 1000,
    staleAfterMs: 5000, columnBindings: { '1': [mesh.id, external.id] } };
  mesh.components.chartMarker = { geometryBasis: 'upright', dataSourceEntityId: host.id, clickEvents: [{ type: 'left-click', actions: [
    { type: 'focus', targetEntityId: host.id }, { type: 'select', targetEntityId: external.id } ] }] };
  const slot = createLocatorEntity();
  slot.components.locator.builtInBinding = { hostEntityId: host.id, rowIndex: 0, originOffset: { x: 0, y: 0, z: 0 } };
  slot.parentId = null;
  const nodes = [root, nested, host, mesh, instance, borrowed, slot, external];
  root.childrenIds = [nested.id, mesh.id];
  nested.parentId = root.id;
  mesh.parentId = root.id;
  nested.childrenIds = [host.id, instance.id, borrowed.id];
  for (const node of [host, instance, borrowed]) node.parentId = nested.id;
  const scene = { ...createEmptySceneDocument('阵列'), entityIds: nodes.map(node => node.id), entities: Object.fromEntries(nodes.map(node => [node.id, node])), selectedEntityId: root.id };
  const reset = () => store.setState({ scene, runtimeMode: 'edit', history: { undoStack: [], redoStack: [] }, hierarchySelectionIds: [root.id], entityArrayRequest: null, logs: [], entityClipboard: { id: 'untouched', entries: [] } });
  const input = { sourceIds: [root.id], copyCount: 2, directionVector: { x: 1, y: 0, z: 0 }, spacingMeters: 1, selectionSpanMeters: 4, assetNumberRule: '' };
  reset();
  const result = store.getState().commitResolvedEntityArray(input);
  assert.equal(result.ok, true, result.error);
  let state = store.getState();
  assert.equal(result.createdCount, 14);
  assert.equal(state.history.undoStack.length, 1);
  assert.equal(state.entityClipboard.id, 'untouched');
  assert.deepEqual(state.hierarchySelectionIds, [root.id]);
  const copies = Object.values(state.scene.entities).filter(node => node.composition && node.id !== root.id);
  assert.deepEqual(copies.map(node => node.name), ['组合02', '组合03']);
  const allAssetCodes = [];
  for (const [index, copy] of copies.entries()) {
    assert.notEqual(copy.composition.instanceId, root.composition.instanceId);
    assert.equal(copy.composition.revision, 'fixed');
    const folder = state.scene.entities[copy.childrenIds[0]];
    assert.equal(folder.childrenIds.length, 3);
    const [newHost, newInstance, newBorrowed] = folder.childrenIds.map(id => state.scene.entities[id]);
    assert.equal(newInstance.components.modelArrayInstance.sourceEntityId, newHost.id);
    assert.equal(newBorrowed.components.modelArrayInstance, undefined);
    assert.deepEqual(newHost.components.modelAsset.parameterValues, { length: 7 });
    assert.notEqual(newHost.components.modelAsset.parameterValues, host.components.modelAsset.parameterValues);
    assert.equal(newHost.components.transform.position.x, host.components.transform.position.x + (index + 1) * 5);
    const newMesh = state.scene.entities[copy.childrenIds[1]];
    assert.equal(newMesh.components.chartMarker.dataSourceEntityId, newHost.id);
    assert.equal(newMesh.components.chartMarker.clickEvents[0].actions[0].targetEntityId, newHost.id);
    assert.equal(newMesh.components.chartMarker.clickEvents[0].actions[1].targetEntityId, external.id);
    assert.deepEqual(newHost.components.telemetryBinding.columnBindings['1'], [newMesh.id, external.id]);
    const newSlot = Object.values(state.scene.entities).find(node => node.components.locator?.builtInBinding?.hostEntityId === newHost.id);
    assert.equal(newSlot.components.locator.assetId, newHost.components.modelAsset.assetCode);
    allAssetCodes.push(newHost.components.modelAsset.assetCode, newInstance.components.modelAsset.assetCode, newBorrowed.components.modelAsset.assetCode);
  }
  assert.equal(new Set(allAssetCodes).size, 6);
  const reopened = deserializeScene(serializeScene(state.scene));
  assert.deepEqual(reopened.entities[copies[0].id].childrenIds, copies[0].childrenIds);
  for (const copy of copies) {
    const folder = reopened.entities[copy.childrenIds[0]];
    const borrowedCopy = reopened.entities[folder.childrenIds[2]];
    assert.equal(borrowedCopy.components.modelArrayInstance, undefined, '保存重开不能将独立组合成员重新关联到组外渲染源');
  }
  const { captureComposition, planCompositionUpgrade, transformComposition } = await import('../src/editor/composition/composition.ts');
  const definition = captureComposition(reopened, [copies[0].id], '更新库版本').definition;
  const upgraded = planCompositionUpgrade(reopened, copies[0].id, definition, { ...copies[0].composition, revision: 'next' }).scene;
  assert.deepEqual(upgraded.entities[copies[1].id], reopened.entities[copies[1].id]);
  assert.equal(upgraded.entities[copies[0].id].composition.revision, 'next');
  const moved = transformComposition(reopened, copies[0].id, { ...copies[0].components.transform, position: { x: 40, y: 0, z: 0 } });
  assert.deepEqual(moved.entities[copies[1].id], reopened.entities[copies[1].id]);
  const { createEditModeModelThinInstancePlan } = await import('../src/editor/model/editModeModelThinInstances.ts');
  const ordinaryA = createModelEntity(host.components.modelAsset.sourcePath, host.components.modelAsset.sourceUrl, '普通A');
  const ordinaryB = createModelEntity(host.components.modelAsset.sourcePath, host.components.modelAsset.sourceUrl, '普通B');
  const ordinaryScene = { ...createEmptySceneDocument('普通模型合批'), entityIds: [ordinaryA.id, ordinaryB.id], entities: { [ordinaryA.id]: ordinaryA, [ordinaryB.id]: ordinaryB } };
  assert.equal(createEditModeModelThinInstancePlan(ordinaryScene).thinInstanceEntityCount, 1);
  store.getState().undo();
  assert.equal(store.getState().scene.entityIds.length, nodes.length);
  store.getState().redo();
  assert.equal(store.getState().scene.entityIds.length, nodes.length + 14);
  store.setState({ scene: reopened, hierarchySelectionIds: [root.id] });
  store.getState().selectEntity(root.id);
  store.getState().deleteSelectedEntity();
  assert.equal(store.getState().scene.entities[root.id], undefined);
  assert.deepEqual(store.getState().scene.entities[copies[0].id], reopened.entities[copies[0].id]);
  assert.deepEqual(store.getState().scene.entities[copies[1].id], reopened.entities[copies[1].id]);
  store.getState().selectEntity(copies[0].id);
  store.getState().deleteSelectedEntity();
  assert.equal(store.getState().scene.entities[copies[0].id], undefined);
  assert.deepEqual(store.getState().scene.entities[copies[1].id], reopened.entities[copies[1].id]);
  const { getCompositionArrayInfo } = await import('../src/editor/model/modelArray.ts');
  assert.equal(getCompositionArrayInfo(scene, [root.id], 2).createdEntityCount, 14);
  assert.match(getCompositionArrayInfo(scene, [root.id, mesh.id], 1).error, /单个|混选/);
  assert.match(getCompositionArrayInfo(scene, [root.id], 1001).error, /1-1000/);
  const oversized = structuredClone(scene);
  for (let index = 0; index < 6; index++) {
    const node = { ...structuredClone(mesh), id: 'extra' + index, parentId: root.id };
    oversized.entities[node.id] = node;
    oversized.entities[root.id].childrenIds.push(node.id);
  }
  assert.match(getCompositionArrayInfo(oversized, [root.id], 1000).error, /10000|10,000/);
  reset();
  host.components.modelArray = { items: [{ id: 'legacy-item', name: '旧阵列', assetCode: 'legacy-code', offset: { x: 30, y: 0, z: 0 } }] };
  assert.match(getCompositionArrayInfo(scene, [root.id], 2).error, /旧版.*保存.*重新打开/);
  assert.equal(store.getState().commitResolvedEntityArray(input).ok, false);
  assert.equal(store.getState().history.undoStack.length, 0);
  delete host.components.modelArray;
  reset();
  host.locked = true;
  assert.equal(store.getState().commitResolvedEntityArray(input).ok, false);
  assert.equal(store.getState().history.undoStack.length, 0);
  host.locked = false;
  nested.childrenIds.push('missing');
  assert.match(getCompositionArrayInfo(scene, [root.id], 1).error, /失效|结构/);
  nested.childrenIds.pop();
  reset();
  store.getState().requestEntityArray(2, 'x', 1, '');
  assert.deepEqual(store.getState().entityArrayRequest.sourceIds, [root.id]);

  // 净间距保留符号：跨度 4 时分别形成正步长、零步长和反向步长。
  for (const { spacing, offsets } of [
    { spacing: -1, offsets: [3, 6] },
    { spacing: -4, offsets: [0, 0] },
    { spacing: -6, offsets: [-2, -4] },
  ]) {
    for (const sourceKind of ['ordinary', 'composition']) {
      const ordinary = createModelEntity(host.components.modelAsset.sourcePath, host.components.modelAsset.sourceUrl, '普通01');
      ordinary.components.transform.position.x = 10;
      const sourceScene = sourceKind === 'composition' ? scene : {
        ...createEmptySceneDocument('负间距普通模型'),
        entityIds: [ordinary.id], entities: { [ordinary.id]: ordinary }, selectedEntityId: ordinary.id,
      };
      const sourceId = sourceKind === 'composition' ? root.id : ordinary.id;
      store.setState({ scene: sourceScene, runtimeMode: 'edit', history: { undoStack: [], redoStack: [] }, hierarchySelectionIds: [sourceId], entityArrayRequest: null });
      store.getState().requestEntityArray(2, 'x', spacing, '');
      assert.equal(store.getState().entityArrayRequest?.spacingMeters, spacing, `${sourceKind}: 请求必须保留负净间距`);
      const requestId = store.getState().entityArrayRequest.id;
      store.getState().resolveEntityArrayRequest(requestId, 4);
      const committed = store.getState();
      assert.equal(committed.history.undoStack.length, 1, `${sourceKind}: 负净间距应原子提交`);
      const createdIds = committed.scene.entityIds.filter(id => !sourceScene.entities[id]);
      const copyRoots = createdIds.map(id => committed.scene.entities[id]).filter(node => sourceKind === 'composition' ? node.composition : node.components.modelArrayInstance);
      assert.equal(copyRoots.length, 2);
      assert.deepEqual(copyRoots.map(copy => copy.components.transform.position.x), offsets.map(offset => sourceScene.entities[sourceId].components.transform.position.x + offset));
      const roundTripped = deserializeScene(serializeScene(committed.scene));
      for (const id of createdIds) {
        assert.deepEqual(roundTripped.entities[id].components.transform, committed.scene.entities[id].components.transform, `${sourceKind}: 保存重开保留有符号偏移`);
      }
      if (sourceKind === 'composition') {
        for (const [index, copy] of copyRoots.entries()) {
          const copiedNested = committed.scene.entities[copy.childrenIds[0]];
          const copiedHost = committed.scene.entities[copiedNested.childrenIds[0]];
          assert.equal(copiedHost.components.transform.position.x, host.components.transform.position.x + offsets[index]);
        }
      }
      store.getState().undo();
      assert.deepEqual(store.getState().scene.entityIds, sourceScene.entityIds, `${sourceKind}: 撤销清除全部副本`);
      store.getState().redo();
      for (const id of createdIds) assert.deepEqual(store.getState().scene.entities[id].components.transform, committed.scene.entities[id].components.transform);
    }
  }
  console.log('组合阵列数据验证通过：结构、绑定、隔离、历史、限制、保存重开及请求入口。');
} finally {
  hooks.deregister();
}
