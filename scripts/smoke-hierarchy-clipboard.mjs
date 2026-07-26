import assert from 'node:assert/strict';
import { createServer } from 'vite';

const SSR_MODULE_LOAD_TIMEOUT_MS = 180_000;
const PASTE_OFFSET_METERS = 0.35;

/** 在限定时间内加载模块，避免 Vite SSR 异常时 smoke 无限等待。 */
async function loadModule(server, modulePath) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule(modulePath),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Vite SSR Hierarchy 剪贴板模块加载超时：${modulePath}`));
        }, SSR_MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** 比较复制后的米制位置偏移。 */
function assertPositionOffset(actual, source, message) {
  assert.ok(Math.abs(actual.x - source.x - PASTE_OFFSET_METERS) <= 1e-9, `${message} X 偏移错误`);
  assert.ok(Math.abs(actual.y - source.y) <= 1e-9, `${message} Y 不应偏移`);
  assert.ok(Math.abs(actual.z - source.z - PASTE_OFFSET_METERS) <= 1e-9, `${message} Z 偏移错误`);
}

let server;
let editorStore;
let editorStoreSnapshot;

try {
  server = await createServer({
    appType: 'custom',
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    // editorStore 会间接加载 CAD 模块，沿用现有 smoke 的 ESM 转换配置。
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });

  const { useEditorStore } = await loadModule(server, '/src/editor/store/editorStore.ts');
  const {
    createEmptySceneDocument,
    createFolderEntity,
    createMeshEntity,
    createModelEntity,
    createModelGeneratorEntity,
  } = await loadModule(server, '/src/editor/model/SceneDocument.ts');
  const { deserializeScene, serializeScene } = await loadModule(server, '/src/editor/project/SceneSerializer.ts');
  const {
    createEntityHierarchyStateMap,
    isEntityEffectivelyLocked,
    isEntityEffectivelyVisible,
  } = await loadModule(server, '/src/editor/model/entityHierarchy.ts');
  editorStore = useEditorStore;
  editorStoreSnapshot = useEditorStore.getState();

  /** 创建带稳定名称和资产编号的导入模型夹具。 */
  function createImportedModel(name, sourceName, position, assetCode) {
    const entity = createModelEntity(
      `${sourceName}.glb`,
      `editor-asset://local/${sourceName}.glb`,
      name,
      { lengthUnit: 'meter', unitScaleToMeters: 1 },
      position,
    );
    entity.components.modelAsset.assetCode = assetCode;
    return entity;
  }

  /** 重置 Store 场景与非持久化编辑状态，隔离各 smoke 场景。 */
  function resetStore(scene, selectionIds, primaryEntityId = selectionIds[0] ?? null) {
    scene.selectedEntityId = primaryEntityId;
    useEditorStore.setState({
      scene,
      runtimeMode: 'edit',
      history: { undoStack: [], redoStack: [] },
      hierarchySelectionIds: selectionIds,
      entityClipboard: null,
      entityArrayRequest: null,
      selectedModelMeasurement: null,
      logs: [],
    });
  }

  /** 生成仅包含给定实体的场景，并保持 entityIds 顺序。 */
  function createFixtureScene(name, entities) {
    const scene = createEmptySceneDocument(name);
    scene.entityIds = entities.map((entity) => entity.id);
    scene.entities = Object.fromEntries(entities.map((entity) => [entity.id, entity]));
    return scene;
  }

  // 文件夹复制：包含完整子树，祖先和后代同时选中不重复，模型生成器按唯一约束跳过。
  const sourceFolder = createFolderEntity('输送线组');
  sourceFolder.locked = true;
  const sourceModel = createImportedModel('输送机模型', 'conveyor', { x: 1, y: 2, z: 3 }, 'CONVEYOR-001');
  sourceModel.visible = false;
  const sourceMesh = createMeshEntity('cube', { x: 4, y: 0, z: 6 });
  sourceMesh.name = '辅助方块';
  const sourceGenerator = createModelGeneratorEntity({ x: 8, y: 0, z: 9 });
  for (const child of [sourceModel, sourceMesh, sourceGenerator]) child.parentId = sourceFolder.id;
  sourceFolder.childrenIds = [sourceModel.id, sourceMesh.id, sourceGenerator.id];

  const folderScene = createFixtureScene(
    'Folder Clipboard Smoke',
    [sourceFolder, sourceModel, sourceMesh, sourceGenerator],
  );
  resetStore(folderScene, [sourceModel.id, sourceFolder.id], sourceFolder.id);

  useEditorStore.getState().copySelectedEntities();
  let state = useEditorStore.getState();
  assert.equal(state.entityClipboard.entries.length, 1, '父文件夹与子模型同时选中不得生成重复根条目');
  assert.equal(
    state.entityClipboard.entries[0].entities.filter((entity) => !entity.isFolder).length,
    2,
    '文件夹剪贴板必须包含两个可复制普通实体',
  );
  assert.match(state.logs[0].message, /1 个文件夹、2 个对象/, '复制日志必须包含文件夹和对象数量');
  assert.match(state.logs[0].message, /已跳过模型生成器/, '复制日志必须说明模型生成器被跳过');

  useEditorStore.getState().selectHierarchyEntities([], null);
  useEditorStore.getState().pasteEntityClipboard();
  state = useEditorStore.getState();
  assert.equal(state.history.undoStack.length, 1, '文件夹整体粘贴必须只写入一条撤销历史');
  assert.equal(state.hierarchySelectionIds.length, 1, '粘贴后只应选中新文件夹根节点');

  const duplicatedFolderId = state.hierarchySelectionIds[0];
  const duplicatedFolder = state.scene.entities[duplicatedFolderId];
  assert.equal(duplicatedFolder.isFolder, true, '粘贴选区必须是文件夹');
  assert.equal(duplicatedFolder.parentId, null, '复制文件夹必须粘贴为根级文件夹');
  assert.equal(duplicatedFolder.name, '输送线组 副本', '复制文件夹必须使用现有副本命名规则');
  assert.equal(duplicatedFolder.locked, true, '文件夹锁定状态必须保留');
  assert.equal(duplicatedFolder.childrenIds.length, 2, '新文件夹必须登记全部可复制子实体');
  assert.deepEqual(sourceFolder.childrenIds, [sourceModel.id, sourceMesh.id, sourceGenerator.id], '原文件夹内容不得改变');

  const duplicatedChildren = duplicatedFolder.childrenIds.map((entityId) => state.scene.entities[entityId]);
  assert.ok(duplicatedChildren.every((entity) => entity.parentId === duplicatedFolder.id), '所有子实体必须指向新文件夹');
  const duplicatedModel = duplicatedChildren.find((entity) => entity.components.modelAsset);
  const duplicatedMesh = duplicatedChildren.find((entity) => entity.components.meshRenderer);
  assert.ok(duplicatedModel, '导入模型必须随文件夹复制');
  assert.ok(duplicatedMesh, '内置 Mesh 必须随文件夹复制');
  assertPositionOffset(
    duplicatedModel.components.transform.position,
    sourceModel.components.transform.position,
    '导入模型',
  );
  assertPositionOffset(
    duplicatedMesh.components.transform.position,
    sourceMesh.components.transform.position,
    '内置 Mesh',
  );
  assert.equal(duplicatedModel.visible, false, '子模型显隐状态必须保留');
  assert.equal(duplicatedModel.components.modelAsset.sourceUrl, sourceModel.components.modelAsset.sourceUrl);
  assert.notEqual(
    duplicatedModel.components.modelAsset.assetCode,
    sourceModel.components.modelAsset.assetCode,
    '复制的导入模型必须生成新资产编号',
  );
  assert.notEqual(duplicatedModel.components, sourceModel.components, '复制模型不得共享组件对象');
  assert.equal(
    Object.values(state.scene.entities).filter((entity) => entity.components.modelGenerator).length,
    1,
    '文件夹复制不得产生第二个模型生成器',
  );

  useEditorStore.getState().undo();
  state = useEditorStore.getState();
  assert.equal(state.scene.entities[duplicatedFolderId], undefined, '撤销必须整体移除文件夹副本');
  assert.equal(state.history.undoStack.length, 0);
  assert.equal(state.history.redoStack.length, 1);

  useEditorStore.getState().redo();
  state = useEditorStore.getState();
  assert.equal(state.scene.entities[duplicatedFolderId]?.childrenIds.length, 2, '重做必须恢复同一个完整文件夹副本');
  assert.equal(state.history.undoStack.length, 1);

  // 空文件夹也必须可以复制和粘贴。
  const emptyFolder = createFolderEntity('空分组');
  const emptyScene = createFixtureScene('Empty Folder Clipboard Smoke', [emptyFolder]);
  resetStore(emptyScene, [emptyFolder.id]);
  useEditorStore.getState().copySelectedEntities();
  useEditorStore.getState().pasteEntityClipboard();
  state = useEditorStore.getState();
  const emptyFolderCopy = state.scene.entities[state.hierarchySelectionIds[0]];
  assert.equal(emptyFolderCopy.isFolder, true);
  assert.deepEqual(emptyFolderCopy.childrenIds, [], '空文件夹副本必须保持为空');
  assert.equal(emptyFolderCopy.name, '空分组 副本');

  // 多文件夹与独立实体混合复制时，全部剪贴板根条目统一粘贴到根层级。
  const firstFolder = createFolderEntity('第一组');
  const firstChild = createImportedModel('第一模型', 'first-model', { x: 0, y: 0, z: 0 }, 'FIRST-001');
  firstChild.parentId = firstFolder.id;
  firstFolder.childrenIds = [firstChild.id];
  const secondFolder = createFolderEntity('第二组');
  const secondChild = createMeshEntity('sphere', { x: 10, y: 0, z: 2 });
  secondChild.name = '第二模型';
  secondChild.parentId = secondFolder.id;
  secondFolder.childrenIds = [secondChild.id];
  const standaloneModel = createImportedModel('独立模型', 'standalone', { x: -2, y: 1, z: 5 }, 'STANDALONE-001');
  const mixedScene = createFixtureScene(
    'Mixed Folder Clipboard Smoke',
    [firstFolder, firstChild, secondFolder, secondChild, standaloneModel],
  );
  resetStore(mixedScene, [firstChild.id, firstFolder.id, secondFolder.id, standaloneModel.id], firstFolder.id);
  useEditorStore.getState().copySelectedEntities();
  assert.equal(useEditorStore.getState().entityClipboard.entries.length, 3, '混合选区应归一为两个文件夹和一个独立实体');
  useEditorStore.getState().selectHierarchyEntities([], null);
  useEditorStore.getState().pasteEntityClipboard();
  state = useEditorStore.getState();
  assert.equal(state.scene.entityIds.length, 10, '混合粘贴必须新增两个文件夹、两个子实体和一个独立实体');
  assert.equal(state.hierarchySelectionIds.length, 3, '混合粘贴只选择三个顶层副本');
  assert.ok(
    state.hierarchySelectionIds.every((entityId) => state.scene.entities[entityId].parentId === null),
    '包含文件夹的剪贴板必须把全部顶层副本粘贴到根层级',
  );
  const mixedFolderCopies = state.hierarchySelectionIds
    .map((entityId) => state.scene.entities[entityId])
    .filter((entity) => entity.isFolder);
  assert.deepEqual(mixedFolderCopies.map((folder) => folder.childrenIds.length), [1, 1]);
  assert.equal(
    Object.values(state.scene.entities).filter((entity) => entity.name === '第一模型 副本').length,
    1,
    '父文件夹与子模型同时选中时子模型只能复制一次',
  );

  // 仅复制普通实体时保留既有“粘贴到当前文件夹”行为。
  const targetFolder = createFolderEntity('目标文件夹');
  const looseModel = createImportedModel('待归档模型', 'loose-model', { x: 3, y: 0, z: -4 }, 'LOOSE-001');
  const entityOnlyScene = createFixtureScene('Entity Clipboard Target Smoke', [targetFolder, looseModel]);
  resetStore(entityOnlyScene, [looseModel.id]);
  useEditorStore.getState().copySelectedEntities();
  useEditorStore.getState().selectHierarchyEntities([targetFolder.id], targetFolder.id);
  useEditorStore.getState().pasteEntityClipboard();
  state = useEditorStore.getState();
  const pastedEntityId = state.hierarchySelectionIds[0];
  const pastedEntity = state.scene.entities[pastedEntityId];
  assert.equal(pastedEntity.isFolder, undefined, '普通实体粘贴不得创建额外文件夹');
  assert.equal(pastedEntity.parentId, targetFolder.id, '普通实体必须继续粘贴到当前文件夹');
  assert.deepEqual(state.scene.entities[targetFolder.id].childrenIds, [pastedEntityId]);
  assertPositionOffset(pastedEntity.components.transform.position, looseModel.components.transform.position, '普通实体');

  // 任意深度文件夹复制到目标文件夹：保留空目录、阵列引用与完整父子关系。
  const nestedRoot = createFolderEntity('一级目录');
  const nestedChild = createFolderEntity('二级目录');
  const nestedGrandchild = createFolderEntity('三级目录');
  const nestedEmpty = createFolderEntity('空子目录');
  const nestedSourceModel = createImportedModel('嵌套源模型', 'nested-source', { x: 2, y: 1, z: 4 }, 'NESTED-001');
  const nestedArrayInstance = createImportedModel('嵌套阵列实例', 'nested-source', { x: 6, y: 1, z: 8 }, 'NESTED-002');
  nestedArrayInstance.components.modelArrayInstance = { sourceEntityId: nestedSourceModel.id };
  nestedChild.parentId = nestedRoot.id;
  nestedGrandchild.parentId = nestedChild.id;
  nestedEmpty.parentId = nestedRoot.id;
  nestedSourceModel.parentId = nestedGrandchild.id;
  nestedArrayInstance.parentId = nestedGrandchild.id;
  nestedRoot.childrenIds = [nestedChild.id, nestedEmpty.id];
  nestedChild.childrenIds = [nestedGrandchild.id];
  nestedGrandchild.childrenIds = [nestedSourceModel.id, nestedArrayInstance.id];
  const nestedTarget = createFolderEntity('粘贴目标');
  const nestedScene = createFixtureScene('Nested Folder Clipboard Smoke', [
    nestedRoot,
    nestedChild,
    nestedGrandchild,
    nestedEmpty,
    nestedSourceModel,
    nestedArrayInstance,
    nestedTarget,
  ]);
  resetStore(nestedScene, [nestedSourceModel.id, nestedRoot.id], nestedRoot.id);
  useEditorStore.getState().copySelectedEntities();
  state = useEditorStore.getState();
  assert.equal(state.entityClipboard.entries.length, 1, '祖先与任意深度后代同时选中必须只保留祖先根条目');
  assert.equal(state.entityClipboard.entries[0].entities.filter((entity) => entity.isFolder).length, 4);
  assert.equal(state.entityClipboard.entries[0].entities.filter((entity) => !entity.isFolder).length, 2);
  useEditorStore.getState().selectHierarchyEntities([nestedTarget.id], nestedTarget.id);
  useEditorStore.getState().pasteEntityClipboard();
  state = useEditorStore.getState();
  const pastedNestedRootId = state.hierarchySelectionIds[0];
  const pastedNestedRoot = state.scene.entities[pastedNestedRootId];
  assert.equal(pastedNestedRoot.parentId, nestedTarget.id, '文件夹剪贴板必须允许粘贴到任意目标文件夹');
  assert.deepEqual(state.scene.entities[nestedTarget.id].childrenIds, [pastedNestedRootId]);
  const pastedNestedChild = state.scene.entities[pastedNestedRoot.childrenIds[0]];
  const pastedNestedEmpty = state.scene.entities[pastedNestedRoot.childrenIds[1]];
  const pastedNestedGrandchild = state.scene.entities[pastedNestedChild.childrenIds[0]];
  assert.equal(pastedNestedChild.parentId, pastedNestedRoot.id);
  assert.equal(pastedNestedGrandchild.parentId, pastedNestedChild.id);
  assert.deepEqual(pastedNestedEmpty.childrenIds, [], '空子文件夹必须保留');
  const pastedNestedModels = pastedNestedGrandchild.childrenIds.map((entityId) => state.scene.entities[entityId]);
  const pastedNestedSource = pastedNestedModels.find((entity) => !entity.components.modelArrayInstance);
  const pastedNestedInstance = pastedNestedModels.find((entity) => entity.components.modelArrayInstance);
  assert.ok(pastedNestedSource && pastedNestedInstance, '三级目录中的源模型与阵列实例必须完整复制');
  assert.equal(
    pastedNestedInstance.components.modelArrayInstance.sourceEntityId,
    pastedNestedSource.id,
    '跨子树复制后阵列实例必须引用新源实体',
  );
  assertPositionOffset(pastedNestedSource.components.transform.position, nestedSourceModel.components.transform.position, '嵌套源模型');
  assertPositionOffset(pastedNestedInstance.components.transform.position, nestedArrayInstance.components.transform.position, '嵌套阵列实例');

  const restoredNestedScene = deserializeScene(serializeScene(state.scene));
  assert.equal(restoredNestedScene.entities[pastedNestedRootId].parentId, nestedTarget.id, '多级文件夹必须可保存并重新加载');
  assert.equal(
    restoredNestedScene.entities[pastedNestedChild.id].childrenIds[0],
    pastedNestedGrandchild.id,
    '序列化往返必须保持深层父子顺序',
  );

  // 新建文件夹默认进入当前可编辑文件夹。
  const createParent = createFolderEntity('新建父目录');
  resetStore(createFixtureScene('Nested Folder Create Smoke', [createParent]), [createParent.id], createParent.id);
  useEditorStore.getState().createFolder();
  state = useEditorStore.getState();
  const createdNestedFolderId = state.hierarchySelectionIds[0];
  assert.equal(state.scene.entities[createdNestedFolderId].parentId, createParent.id);
  assert.deepEqual(state.scene.entities[createParent.id].childrenIds, [createdNestedFolderId]);

  // 文件夹拖拽携带完整子树，且禁止把祖先拖入自身后代形成循环。
  const movingRoot = createFolderEntity('移动根目录');
  const movingChild = createFolderEntity('移动子目录');
  const movingLeaf = createMeshEntity('cube', { x: 0, y: 0, z: 0 });
  const movingTarget = createFolderEntity('移动目标');
  movingChild.parentId = movingRoot.id;
  movingLeaf.parentId = movingChild.id;
  movingRoot.childrenIds = [movingChild.id];
  movingChild.childrenIds = [movingLeaf.id];
  const movingScene = createFixtureScene('Nested Folder Move Smoke', [movingRoot, movingChild, movingLeaf, movingTarget]);
  resetStore(movingScene, [movingRoot.id], movingRoot.id);
  useEditorStore.getState().moveEntitiesToFolder([movingRoot.id, movingLeaf.id], movingTarget.id);
  state = useEditorStore.getState();
  assert.equal(state.scene.entities[movingRoot.id].parentId, movingTarget.id);
  assert.deepEqual(state.scene.entities[movingTarget.id].childrenIds, [movingRoot.id]);
  assert.equal(state.scene.entities[movingLeaf.id].parentId, movingChild.id, '移动文件夹不得改写后代内部关系');
  const historyCountBeforeCycle = state.history.undoStack.length;
  useEditorStore.getState().moveEntitiesToFolder([movingTarget.id], movingChild.id);
  state = useEditorStore.getState();
  assert.equal(state.scene.entities[movingTarget.id].parentId, null, '循环拖拽必须被拒绝');
  assert.equal(state.history.undoStack.length, historyCountBeforeCycle, '被拒绝的循环拖拽不得写入历史');
  useEditorStore.getState().moveEntitiesToFolder([movingChild.id], null);
  state = useEditorStore.getState();
  assert.equal(state.scene.entities[movingChild.id].parentId, null, '子文件夹必须可拖回根层级');
  assert.deepEqual(state.scene.entities[movingRoot.id].childrenIds, []);
  assert.equal(state.scene.entities[movingLeaf.id].parentId, movingChild.id);

  // 同父级群组创建原地子目录，解组时按原顺序提升直属内容。
  const groupParent = createFolderEntity('群组父目录');
  const groupFirst = createMeshEntity('cube', { x: 0, y: 0, z: 0 });
  const groupSecond = createMeshEntity('sphere', { x: 1, y: 0, z: 0 });
  groupFirst.parentId = groupParent.id;
  groupSecond.parentId = groupParent.id;
  groupParent.childrenIds = [groupFirst.id, groupSecond.id];
  resetStore(createFixtureScene('Nested Group Smoke', [groupParent, groupFirst, groupSecond]), [groupFirst.id, groupSecond.id], groupFirst.id);
  useEditorStore.getState().groupSelectedEntities();
  state = useEditorStore.getState();
  const nestedGroupId = state.scene.selectedEntityId;
  assert.ok(nestedGroupId);
  assert.equal(state.scene.entities[nestedGroupId].parentId, groupParent.id);
  assert.deepEqual(state.scene.entities[groupParent.id].childrenIds, [nestedGroupId]);
  assert.deepEqual(state.scene.entities[nestedGroupId].childrenIds, [groupFirst.id, groupSecond.id]);
  useEditorStore.getState().selectHierarchyEntities([nestedGroupId], nestedGroupId);
  useEditorStore.getState().ungroupSelectedEntities();
  state = useEditorStore.getState();
  assert.equal(state.scene.entities[nestedGroupId], undefined, '解组必须只移除文件夹容器');
  assert.deepEqual(state.scene.entities[groupParent.id].childrenIds, [groupFirst.id, groupSecond.id]);
  assert.ok([groupFirst.id, groupSecond.id].every((entityId) => state.scene.entities[entityId].parentId === groupParent.id));

  // 删除嵌套文件夹保持非级联语义，直接内容提升到最近仍存在的父级。
  const deleteParent = createFolderEntity('删除父目录');
  const deleteFolder = createFolderEntity('待删除目录');
  const deleteSubfolder = createFolderEntity('保留子目录');
  const deleteDirectLeaf = createMeshEntity('cube', { x: 0, y: 0, z: 0 });
  const deleteDeepLeaf = createMeshEntity('sphere', { x: 0, y: 0, z: 0 });
  const deleteAfterLeaf = createMeshEntity('plane', { x: 0, y: 0, z: 0 });
  deleteFolder.parentId = deleteParent.id;
  deleteSubfolder.parentId = deleteFolder.id;
  deleteDirectLeaf.parentId = deleteFolder.id;
  deleteDeepLeaf.parentId = deleteSubfolder.id;
  deleteAfterLeaf.parentId = deleteParent.id;
  deleteParent.childrenIds = [deleteFolder.id, deleteAfterLeaf.id];
  deleteFolder.childrenIds = [deleteSubfolder.id, deleteDirectLeaf.id];
  deleteSubfolder.childrenIds = [deleteDeepLeaf.id];
  resetStore(
    createFixtureScene('Nested Delete Smoke', [
      deleteParent,
      deleteFolder,
      deleteSubfolder,
      deleteDirectLeaf,
      deleteDeepLeaf,
      deleteAfterLeaf,
    ]),
    [deleteFolder.id],
    deleteFolder.id,
  );
  useEditorStore.getState().deleteSelectedEntity();
  state = useEditorStore.getState();
  assert.equal(state.scene.entities[deleteFolder.id], undefined);
  assert.deepEqual(
    state.scene.entities[deleteParent.id].childrenIds,
    [deleteSubfolder.id, deleteDirectLeaf.id, deleteAfterLeaf.id],
    '删除文件夹必须在原位置展开直属内容',
  );
  assert.equal(state.scene.entities[deleteSubfolder.id].parentId, deleteParent.id);
  assert.equal(state.scene.entities[deleteDeepLeaf.id].parentId, deleteSubfolder.id, '后代子树不得被级联删除');

  // 任意深度祖先显隐/锁定继承，以及文件夹递归场景聚焦。
  const stateRoot = createFolderEntity('状态根目录');
  const stateChild = createFolderEntity('状态子目录');
  const stateLeaf = createMeshEntity('cube', { x: 0, y: 0, z: 0 });
  stateRoot.visible = false;
  stateChild.locked = true;
  stateChild.parentId = stateRoot.id;
  stateLeaf.parentId = stateChild.id;
  stateRoot.childrenIds = [stateChild.id];
  stateChild.childrenIds = [stateLeaf.id];
  const hierarchyStateScene = createFixtureScene('Nested State Smoke', [stateRoot, stateChild, stateLeaf]);
  assert.equal(isEntityEffectivelyVisible(hierarchyStateScene.entities, stateLeaf), false);
  assert.equal(isEntityEffectivelyLocked(hierarchyStateScene.entities, stateLeaf), true);
  const hierarchyStateMap = createEntityHierarchyStateMap(hierarchyStateScene.entityIds, hierarchyStateScene.entities);
  assert.deepEqual(hierarchyStateMap.get(stateLeaf.id), { visible: false, locked: true });
  resetStore(hierarchyStateScene, [stateRoot.id], stateRoot.id);
  useEditorStore.getState().requestSceneFocusForSelection();
  state = useEditorStore.getState();
  assert.deepEqual(state.sceneFocusRequest.entityIds, [stateLeaf.id], '文件夹聚焦必须递归展开全部普通后代');

  // 场景校验接受多级树，但拒绝自引用、循环、父子不对称和普通实体持有子项。
  const validHierarchyFile = JSON.parse(serializeScene(nestedScene));
  assert.doesNotThrow(() => deserializeScene(JSON.stringify(validHierarchyFile)));

  const selfCycleFile = structuredClone(validHierarchyFile);
  selfCycleFile.scene.entities[nestedRoot.id].parentId = nestedRoot.id;
  selfCycleFile.scene.entities[nestedRoot.id].childrenIds.push(nestedRoot.id);
  assert.throws(() => deserializeScene(JSON.stringify(selfCycleFile)), /场景文件格式不受支持/);

  const ancestorCycleFile = structuredClone(validHierarchyFile);
  ancestorCycleFile.scene.entities[nestedRoot.id].parentId = nestedGrandchild.id;
  ancestorCycleFile.scene.entities[nestedGrandchild.id].childrenIds.push(nestedRoot.id);
  assert.throws(() => deserializeScene(JSON.stringify(ancestorCycleFile)), /场景文件格式不受支持/);

  const mismatchedParentFile = structuredClone(validHierarchyFile);
  mismatchedParentFile.scene.entities[nestedRoot.id].childrenIds = [nestedEmpty.id];
  assert.throws(() => deserializeScene(JSON.stringify(mismatchedParentFile)), /场景文件格式不受支持/);

  const runtimeChildrenFile = structuredClone(validHierarchyFile);
  runtimeChildrenFile.scene.entities[nestedSourceModel.id].childrenIds = [nestedArrayInstance.id];
  assert.throws(() => deserializeScene(JSON.stringify(runtimeChildrenFile)), /场景文件格式不受支持/);

  console.log(JSON.stringify({
    ok: true,
    hierarchyClipboard: {
      folderTreeCopied: true,
      emptyFolderCopied: true,
      duplicateChildSelectionRemoved: true,
      mixedRootsPasteAtSceneRoot: true,
      modelGeneratorSkipped: true,
      entityOnlyTargetFolderPreserved: true,
      nestedFolderTreeCopied: true,
      nestedFolderTargetPaste: true,
      arraySourceRemapped: true,
      undoRedoAtomic: true,
    },
    hierarchyNesting: {
      createUnderSelection: true,
      folderMoveAndCycleGuard: true,
      sameParentGrouping: true,
      nestedUngroup: true,
      nonCascadingDelete: true,
      inheritedRuntimeState: true,
      recursiveFocus: true,
      serializerCycleGuard: true,
    },
  }, null, 2));
} finally {
  if (editorStore && editorStoreSnapshot) editorStore.setState(editorStoreSnapshot, true);
  await server?.close();
}
