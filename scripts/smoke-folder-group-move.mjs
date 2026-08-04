import assert from 'node:assert/strict';
import { Matrix, MeshBuilder, NullEngine, Scene } from '@babylonjs/core';
import { createServer } from 'vite';

const SSR_MODULE_LOAD_TIMEOUT_MS = 180_000;

async function loadModule(server, modulePath) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule(modulePath),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Vite SSR 文件夹整组移动模块加载超时：${modulePath}`));
        }, SSR_MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function transform(position) {
  return {
    position: { ...position },
    rotation: { x: 0.1, y: 0.2, z: 0.3 },
    scale: { x: 1, y: 2, z: 3 },
  };
}

function folder(id, name, parentId, childrenIds, overrides = {}) {
  return {
    id,
    name,
    isFolder: true,
    visible: true,
    locked: false,
    parentId,
    childrenIds,
    components: { transform: transform({ x: 0, y: 0, z: 0 }) },
    ...overrides,
  };
}

function entity(id, name, parentId, position, overrides = {}) {
  return {
    id,
    name,
    visible: true,
    locked: false,
    parentId,
    childrenIds: [],
    components: { transform: transform(position) },
    ...overrides,
  };
}

function sceneOf(entities, selectedEntityId) {
  return {
    version: 1,
    name: 'Folder Group Move Smoke',
    entityIds: entities.map((item) => item.id),
    entities: Object.fromEntries(entities.map((item) => [item.id, item])),
    selectedEntityId,
    mqttConfig: {},
    sceneSettings: {},
    fetchConfig: {},
  };
}

let server;
try {
  server = await createServer({
    appType: 'custom',
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });

  const hierarchyModule = await loadModule(server, '/src/editor/model/entityHierarchy.ts');
  const commandModule = await loadModule(server, '/src/editor/commands/entityCommands.ts');
  const historyModule = await loadModule(server, '/src/editor/commands/CommandHistory.ts');
  const batchModule = await loadModule(server, '/src/runtime/babylon/EntityArrayThinInstanceBatch.ts');

  const { resolveFolderGroupMoveSelection, resolveSingleSelectedFolderId } = hierarchyModule;
  const {
    translateEntityPositionsCommand,
    commitFolderGroupTranslation,
    commitFolderGroupRotation,
  } = commandModule;
  const { createCommandHistory, executeCommand, undoCommand, redoCommand } = historyModule;
  const { EntityArrayThinInstanceBatch } = batchModule;

  assert.equal(
    typeof resolveFolderGroupMoveSelection,
    'function',
    'entityHierarchy 必须导出文件夹整组移动选区解析器',
  );
  assert.equal(
    typeof resolveSingleSelectedFolderId,
    'function',
    'entityHierarchy 必须导出统一的单文件夹选区判定',
  );
  assert.equal(
    typeof translateEntityPositionsCommand,
    'function',
    'entityCommands 必须导出批量位置平移命令',
  );
  assert.equal(
    typeof commitFolderGroupTranslation,
    'function',
    'entityCommands 必须导出带会话校验的文件夹整组提交函数',
  );
  assert.equal(
    typeof commitFolderGroupRotation,
    'function',
    'entityCommands 必须导出带会话校验的文件夹整组旋转提交函数',
  );

  const root = folder('folder-root', '一级目录', null, ['model-visible', 'folder-child']);
  const visibleModel = entity('model-visible', '可见模型', root.id, { x: 1, y: 2, z: 3 });
  const childFolder = folder('folder-child', '二级目录', root.id, ['model-hidden']);
  const hiddenModel = entity(
    'model-hidden',
    '隐藏模型',
    childFolder.id,
    { x: -4, y: 5, z: 6 },
    { visible: false },
  );
  const scene = sceneOf([root, visibleModel, childFolder, hiddenModel], root.id);

  assert.equal(resolveSingleSelectedFolderId(scene, [root.id]), root.id);
  assert.equal(
    resolveSingleSelectedFolderId(scene, [root.id, visibleModel.id]),
    null,
    '多选状态不得被识别为文件夹组移动选区',
  );
  const resolution = resolveFolderGroupMoveSelection(scene, [root.id]);
  assert.equal(resolution.status, 'ready', '单选未锁定文件夹必须允许整组移动');
  assert.deepEqual(
    resolution.entityIds,
    [visibleModel.id, hiddenModel.id],
    '必须递归收集全部非文件夹后代，并包含隐藏对象',
  );
  assert.deepEqual(
    resolution.beforePositions,
    {
      [visibleModel.id]: { x: 1, y: 2, z: 3 },
      [hiddenModel.id]: { x: -4, y: 5, z: 6 },
    },
    '移动会话必须保存全部成员的独立位置基线',
  );
  assert.deepEqual(
    resolution.beforeTransforms,
    {
      [visibleModel.id]: visibleModel.components.transform,
      [hiddenModel.id]: hiddenModel.components.transform,
    },
    '群组旋转会话必须保存全部成员的完整 Transform 基线',
  );

  const lockedHiddenModel = { ...hiddenModel, locked: true };
  const lockedScene = sceneOf([root, visibleModel, childFolder, lockedHiddenModel], root.id);
  const lockedResolution = resolveFolderGroupMoveSelection(lockedScene, [root.id]);
  assert.equal(lockedResolution.status, 'blocked', '任一后代锁定时必须原子阻止整组移动');
  assert.deepEqual(lockedResolution.lockedEntityIds, [hiddenModel.id]);

  const lockedEmptyFolder = folder('folder-locked-empty', '锁定空目录', root.id, [], { locked: true });
  const rootWithLockedEmptyFolder = { ...root, childrenIds: [visibleModel.id, lockedEmptyFolder.id] };
  const lockedFolderScene = sceneOf([rootWithLockedEmptyFolder, visibleModel, lockedEmptyFolder], root.id);
  const lockedFolderResolution = resolveFolderGroupMoveSelection(lockedFolderScene, [root.id]);
  assert.equal(lockedFolderResolution.status, 'blocked', '锁定的空嵌套文件夹也必须原子阻止整组移动');
  assert.deepEqual(lockedFolderResolution.lockedEntityIds, [lockedEmptyFolder.id]);
  const lockedEmptyRoot = folder('folder-locked-root', '锁定空根目录', null, [], { locked: true });
  const lockedEmptyRootScene = sceneOf([lockedEmptyRoot], lockedEmptyRoot.id);
  const lockedEmptyRootResolution = resolveFolderGroupMoveSelection(lockedEmptyRootScene, [lockedEmptyRoot.id]);
  assert.equal(lockedEmptyRootResolution.status, 'blocked', '文件夹自身锁定必须优先于空文件夹状态');
  assert.deepEqual(lockedEmptyRootResolution.lockedEntityIds, [lockedEmptyRoot.id]);

  const delta = { x: 3, y: -1, z: 2 };
  const command = translateEntityPositionsCommand(
    resolution.entityIds,
    resolution.beforePositions,
    delta,
  );
  const executed = executeCommand(scene, createCommandHistory(), command);
  assert.equal(executed.history.undoStack.length, 1, '整组移动只能写入一条撤销历史');
  assert.deepEqual(
    executed.scene.entities[visibleModel.id].components.transform.position,
    { x: 4, y: 1, z: 5 },
  );
  assert.deepEqual(
    executed.scene.entities[hiddenModel.id].components.transform.position,
    { x: -1, y: 4, z: 8 },
  );
  assert.deepEqual(
    executed.scene.entities[visibleModel.id].components.transform.rotation,
    visibleModel.components.transform.rotation,
    '整组移动不得改变 rotation',
  );
  assert.deepEqual(
    executed.scene.entities[visibleModel.id].components.transform.scale,
    visibleModel.components.transform.scale,
    '整组移动不得改变 scale',
  );

  const undone = undoCommand(executed.scene, executed.history);
  assert.deepEqual(
    undone.scene.entities[visibleModel.id].components.transform.position,
    visibleModel.components.transform.position,
    'Undo 必须恢复全部成员位置',
  );
  assert.deepEqual(
    undone.scene.entities[hiddenModel.id].components.transform.position,
    hiddenModel.components.transform.position,
  );
  const redone = redoCommand(undone.scene, undone.history);
  assert.deepEqual(
    redone.scene.entities[visibleModel.id].components.transform.position,
    { x: 4, y: 1, z: 5 },
    'Redo 必须重新应用同一整组位移',
  );

  const commitInput = {
    sourceSceneDocument: scene,
    folderId: root.id,
    entityIds: resolution.entityIds,
    beforePositions: resolution.beforePositions,
    delta,
  };
  const committed = commitFolderGroupTranslation(
    scene,
    createCommandHistory(),
    [root.id],
    commitInput,
  );
  assert.equal(committed.committed, true, '有效文件夹移动会话必须提交成功');
  assert.equal(committed.history.undoStack.length, 1, '状态提交必须只产生一条历史');
  assert.deepEqual(
    committed.scene.entities[hiddenModel.id].components.transform.position,
    { x: -1, y: 4, z: 8 },
    '状态提交必须移动隐藏后代',
  );

  const afterRotationTransforms = {
    [visibleModel.id]: {
      ...visibleModel.components.transform,
      position: { x: 3, y: 2, z: -1 },
      rotation: { x: 0.1, y: 1.2, z: 0.3 },
    },
    [hiddenModel.id]: {
      ...hiddenModel.components.transform,
      position: { x: 6, y: 5, z: 4 },
      rotation: { x: 0.1, y: 1.2, z: 0.3 },
    },
  };
  const rotationBeforeTransforms = structuredClone(resolution.beforeTransforms);
  const rotated = commitFolderGroupRotation(
    scene,
    createCommandHistory(),
    [root.id],
    {
      sourceSceneDocument: scene,
      folderId: root.id,
      entityIds: resolution.entityIds,
      beforeTransforms: rotationBeforeTransforms,
      afterTransforms: afterRotationTransforms,
    },
  );
  assert.equal(rotated.committed, true, '群组旋转必须原子提交全部成员 Transform');
  assert.equal(rotated.history.undoStack.length, 1, '群组旋转只能写入一条撤销历史');
  assert.deepEqual(
    rotated.scene.entities[visibleModel.id].components.transform,
    afterRotationTransforms[visibleModel.id],
  );
  rotationBeforeTransforms[visibleModel.id].position.x = 999;
  assert.deepEqual(
    undoCommand(rotated.scene, rotated.history).scene.entities[visibleModel.id].components.transform,
    visibleModel.components.transform,
    'Undo 必须使用命令内部快照恢复群组旋转前的完整 Transform',
  );

  const blocked = commitFolderGroupTranslation(
    lockedScene,
    createCommandHistory(),
    [root.id],
    {
      ...commitInput,
      sourceSceneDocument: lockedScene,
    },
  );
  assert.equal(blocked.committed, false, '锁定后代必须阻止状态提交');
  assert.equal(blocked.history.undoStack.length, 0, '被阻止的提交不得污染历史');
  assert.match(blocked.message, /锁定/, '被阻止时必须返回锁定提示');

  const staleScene = { ...scene };
  const stale = commitFolderGroupTranslation(
    staleScene,
    createCommandHistory(),
    [root.id],
    commitInput,
  );
  assert.equal(stale.committed, false, '场景引用变化后必须拒绝过期移动会话');
  assert.match(stale.message, /场景已变化/);

  const overflowFolder = folder('folder-overflow', '极端数值目录', null, ['model-overflow']);
  const overflowModel = entity('model-overflow', '极端数值模型', overflowFolder.id, { x: 1e308, y: 0, z: 0 });
  const overflowScene = sceneOf([overflowFolder, overflowModel], overflowFolder.id);
  const overflowResolution = resolveFolderGroupMoveSelection(overflowScene, [overflowFolder.id]);
  assert.equal(overflowResolution.status, 'ready');
  const overflowCommit = commitFolderGroupTranslation(
    overflowScene,
    createCommandHistory(),
    [overflowFolder.id],
    {
      sourceSceneDocument: overflowScene,
      folderId: overflowFolder.id,
      entityIds: overflowResolution.entityIds,
      beforePositions: overflowResolution.beforePositions,
      delta: { x: 1e308, y: 0, z: 0 },
    },
  );
  assert.equal(overflowCommit.committed, false, '有限输入相加溢出时必须原子拒绝提交');
  assert.equal(overflowCommit.history.undoStack.length, 0, '溢出提交不得写入撤销历史');
  assert.equal(
    overflowCommit.scene.entities[overflowModel.id].components.transform.position.x,
    1e308,
    '溢出提交不得污染场景位置',
  );
  assert.match(overflowCommit.message, /数值|范围|无效/, '溢出提交必须返回明确数值错误');
  assert.throws(
    () => translateEntityPositionsCommand(
      overflowResolution.entityIds,
      overflowResolution.beforePositions,
      { x: 1e308, y: 0, z: 0 },
    ),
    /数值|范围|无效/,
    '低层批量命令也不得构造包含 Infinity 的位置写入',
  );

  const precisionFolder = folder('folder-precision', '精度边界目录', null, ['model-precision']);
  const precisionModel = entity('model-precision', '精度边界模型', precisionFolder.id, { x: 1e20, y: 0, z: 0 });
  const precisionScene = sceneOf([precisionFolder, precisionModel], precisionFolder.id);
  const precisionResolution = resolveFolderGroupMoveSelection(precisionScene, [precisionFolder.id]);
  assert.equal(precisionResolution.status, 'ready');
  const precisionCommit = commitFolderGroupTranslation(
    precisionScene,
    createCommandHistory(),
    [precisionFolder.id],
    {
      sourceSceneDocument: precisionScene,
      folderId: precisionFolder.id,
      entityIds: precisionResolution.entityIds,
      beforePositions: precisionResolution.beforePositions,
      delta: { x: 1, y: 0, z: 0 },
    },
  );
  assert.equal(precisionCommit.committed, false, '位移小于坐标可表示精度时不得制造空历史');
  assert.equal(precisionCommit.history.undoStack.length, 0, '未产生可表示位移时不得写入撤销历史');

  const { useEditorStore } = await loadModule(server, '/src/editor/store/editorStore.ts');
  const groupedFirst = entity('group-first', '群组对象 A', null, { x: 0, y: 0, z: 0 });
  const groupedSecond = entity('group-second', '群组对象 B', null, { x: 2, y: 0, z: 0 });
  const groupingScene = sceneOf([groupedFirst, groupedSecond], groupedFirst.id);
  useEditorStore.setState({
    scene: groupingScene,
    history: createCommandHistory(),
    hierarchySelectionIds: [groupedFirst.id, groupedSecond.id],
    runtimeMode: 'edit',
    transformTool: 'rotate',
    transformSpace: 'local',
  });
  useEditorStore.getState().groupSelectedEntities();
  const groupedStoreState = useEditorStore.getState();
  const groupedFolderId = groupedStoreState.scene.selectedEntityId;
  assert.equal(groupedStoreState.scene.entities[groupedFolderId]?.isFolder, true, '群组命令必须选中新文件夹');
  assert.equal(groupedStoreState.transformTool, 'translate', '命令选中文件夹后必须自动切换移动工具');
  assert.equal(groupedStoreState.transformSpace, 'global', '命令选中文件夹后必须自动切换世界坐标');
  groupedStoreState.setTransformTool('rotate');
  assert.equal(useEditorStore.getState().transformTool, 'rotate', '文件夹群组必须允许切换旋转工具');
  assert.equal(useEditorStore.getState().transformSpace, 'global', '文件夹旋转必须保持世界坐标');
  useEditorStore.getState().setTransformTool('scale');
  assert.equal(useEditorStore.getState().transformTool, 'translate', '文件夹群组仍不得启用缩放工具');

  groupedStoreState.undo();
  useEditorStore.setState({ transformTool: 'rotate', transformSpace: 'local' });
  useEditorStore.getState().redo();
  const redoneStoreState = useEditorStore.getState();
  assert.equal(
    redoneStoreState.scene.entities[redoneStoreState.scene.selectedEntityId]?.isFolder,
    true,
    'Redo 必须重新选中群组文件夹',
  );
  assert.equal(redoneStoreState.transformTool, 'translate', 'Redo 重新选中文件夹后必须恢复移动工具');
  assert.equal(redoneStoreState.transformSpace, 'global', 'Redo 重新选中文件夹后必须恢复世界坐标');

  useEditorStore.setState({
    scene: groupingScene,
    history: createCommandHistory(),
    hierarchySelectionIds: [groupedFirst.id],
    runtimeMode: 'edit',
    transformTool: 'rotate',
    transformSpace: 'local',
  });
  useEditorStore.getState().createFolder();
  const createdFolderState = useEditorStore.getState();
  assert.equal(
    createdFolderState.scene.entities[createdFolderState.scene.selectedEntityId]?.isFolder,
    true,
    '新建文件夹后必须选中新文件夹',
  );
  assert.equal(createdFolderState.transformTool, 'translate', '新建文件夹后必须自动切换移动工具');
  assert.equal(createdFolderState.transformSpace, 'global', '新建文件夹后必须自动切换世界坐标');

  createdFolderState.copySelectedEntities();
  useEditorStore.setState({ transformTool: 'rotate', transformSpace: 'local' });
  useEditorStore.getState().pasteEntityClipboard(null);
  const pastedFolderState = useEditorStore.getState();
  assert.equal(
    pastedFolderState.scene.entities[pastedFolderState.scene.selectedEntityId]?.isFolder,
    true,
    '粘贴单个文件夹后必须选中文件夹副本',
  );
  assert.equal(pastedFolderState.transformTool, 'translate', '粘贴文件夹后必须自动切换移动工具');
  assert.equal(pastedFolderState.transformSpace, 'global', '粘贴文件夹后必须自动切换世界坐标');

  assert.equal(
    typeof EntityArrayThinInstanceBatch.prototype.beginEntityTranslationPreview,
    'function',
    'thinInstance 批次必须支持开始逻辑实体平移预览',
  );
  assert.equal(
    typeof EntityArrayThinInstanceBatch.prototype.updateEntityTranslationPreview,
    'function',
    'thinInstance 批次必须支持按绝对 delta 更新预览',
  );
  assert.equal(
    typeof EntityArrayThinInstanceBatch.prototype.endEntityTranslationPreview,
    'function',
    'thinInstance 批次必须支持恢复或保留预览结果',
  );
  assert.equal(
    typeof EntityArrayThinInstanceBatch.prototype.beginEntityRotationPreview,
    'function',
    'thinInstance 批次必须支持开始逻辑实体旋转预览',
  );
  assert.equal(
    typeof EntityArrayThinInstanceBatch.prototype.updateEntityRotationPreview,
    'function',
    'thinInstance 批次必须支持按世界增量矩阵更新旋转预览',
  );
  assert.equal(
    typeof EntityArrayThinInstanceBatch.prototype.endEntityRotationPreview,
    'function',
    'thinInstance 批次必须支持取消或保留旋转预览',
  );

  const engine = new NullEngine({ renderWidth: 64, renderHeight: 64 });
  const babylonScene = new Scene(engine);
  const sourceMesh = MeshBuilder.CreateBox('folder-group-source', { size: 1 }, babylonScene);
  const batch = EntityArrayThinInstanceBatch.create('folder-group-source', [sourceMesh], { interactive: true });
  assert.ok(batch, '必须创建文件夹移动 thinInstance 批次');
  const instances = [
    { entityId: 'batch-a', transform: transform({ x: 0, y: 0, z: 0 }), pickable: true },
    { entityId: 'batch-b', transform: transform({ x: 10, y: 1, z: 2 }), pickable: true },
    { entityId: 'batch-c', transform: transform({ x: 20, y: 2, z: 4 }), pickable: true },
  ];
  assert.equal(batch.updateEntityTransforms(Matrix.Identity(), instances), true);
  batch.setSelectionMask(new Set(['batch-b']), 7);

  const batchObjectsBefore = [...batch.batches];
  const matrixBuffersBefore = new Map(batch.batches.map((item) => [item, item.matrixBuffer]));
  const selectionBuffersBefore = new Map(batch.batches.map((item) => [item, item.selectionBuffer]));
  const sourceBuffersBefore = new Map(batch.batches.map((item) => [item, item.sourceMatrixBuffer]));

  function readBatchTranslation(entityId) {
    const entityIndex = batch.entityIds.indexOf(entityId);
    for (const item of batch.batches) {
      const sourceEntityIndexes = item.sourceEntityIndexBuffer;
      const sourceMatrices = item.sourceMatrixBuffer;
      if (!sourceEntityIndexes || !sourceMatrices) continue;
      for (let sourceIndex = 0; sourceIndex < sourceEntityIndexes.length; sourceIndex += 1) {
        if (sourceEntityIndexes[sourceIndex] !== entityIndex) continue;
        const offset = sourceIndex * 16;
        return {
          x: sourceMatrices[offset + 12],
          y: sourceMatrices[offset + 13],
          z: sourceMatrices[offset + 14],
        };
      }
    }
    return null;
  }

  const batchBaseline = Object.fromEntries(instances.map((instance) => [
    instance.entityId,
    readBatchTranslation(instance.entityId),
  ]));
  assert.equal(batch.beginEntityTranslationPreview(new Set(['batch-b'])), true);
  assert.equal(batch.updateEntityTranslationPreview({ x: 5, y: -2, z: 3 }), true);
  assert.deepEqual(readBatchTranslation('batch-a'), batchBaseline['batch-a'], '未选实例 A 不得移动');
  assert.deepEqual(readBatchTranslation('batch-c'), batchBaseline['batch-c'], '未选实例 C 不得移动');
  assert.deepEqual(
    readBatchTranslation('batch-b'),
    {
      x: batchBaseline['batch-b'].x + 5,
      y: batchBaseline['batch-b'].y - 2,
      z: batchBaseline['batch-b'].z + 3,
    },
    '目标逻辑实体必须应用同一绝对世界位移',
  );
  assert.deepEqual(batch.batches, batchObjectsBefore, '预览不得创建或替换空间批次');
  assert.ok(batch.batches.every((item) => item.matrixBuffer === matrixBuffersBefore.get(item)), '必须复用 GPU 矩阵缓冲');
  assert.ok(batch.batches.every((item) => item.selectionBuffer === selectionBuffersBefore.get(item)), '必须复用选择缓冲');
  assert.ok(batch.batches.every((item) => item.sourceMatrixBuffer === sourceBuffersBefore.get(item)), '必须复用完整源矩阵缓冲');

  batch.endEntityTranslationPreview(true);
  assert.deepEqual(readBatchTranslation('batch-b'), batchBaseline['batch-b'], '取消预览必须恢复精确基线');
  batch.dispose();
  sourceMesh.dispose();
  babylonScene.dispose();
  engine.dispose();

  console.log(JSON.stringify({
    ok: true,
    recursiveEntityIds: resolution.entityIds,
    lockedEntityIds: lockedResolution.lockedEntityIds,
    undoEntries: executed.history.undoStack.length,
  }, null, 2));
} finally {
  await server?.close();
}
