import assert from 'node:assert/strict';
import { createServer } from 'vite';

const SSR_MODULE_LOAD_TIMEOUT_MS = 60_000;
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

  // 文件夹复制：包含全部直属实体，父子同时选中不重复，模型生成器按唯一约束跳过。
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
  assert.equal(state.entityClipboard.entries[0].children.length, 2, '文件夹剪贴板必须包含两个可复制直属实体');
  assert.match(state.logs[0].message, /1 个文件夹、2 个对象/, '复制日志必须包含文件夹和对象数量');
  assert.match(state.logs[0].message, /已跳过模型生成器/, '复制日志必须说明模型生成器被跳过');

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

  console.log(JSON.stringify({
    ok: true,
    hierarchyClipboard: {
      folderTreeCopied: true,
      emptyFolderCopied: true,
      duplicateChildSelectionRemoved: true,
      mixedRootsPasteAtSceneRoot: true,
      modelGeneratorSkipped: true,
      entityOnlyTargetFolderPreserved: true,
      undoRedoAtomic: true,
    },
  }, null, 2));
} finally {
  if (editorStore && editorStoreSnapshot) editorStore.setState(editorStoreSnapshot, true);
  await server?.close();
}
