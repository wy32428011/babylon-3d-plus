import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MeshBuilder, NullEngine, Scene } from '@babylonjs/core';
import { createServer } from 'vite';

const SSR_MODULE_LOAD_TIMEOUT_MS = 180_000;

async function loadModule(server, modulePath) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule(modulePath),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`模块加载超时：${modulePath}`)), SSR_MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function transform(x) {
  return {
    position: { x, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

function entity(id, x, overrides = {}) {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: { transform: transform(x) },
    ...overrides,
  };
}

function sceneOf(entities, selectedEntityId) {
  return {
    version: 1,
    name: 'Hierarchy Group Transform Smoke',
    entityIds: entities.map(({ id }) => id),
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
  const storeModule = await loadModule(server, '/src/editor/store/editorStore.ts');
  const runtimeModule = await loadModule(server, '/src/runtime/babylon/SceneRuntime.ts');
  const {
    resolveFolderGroupMoveSelection,
    resolveHierarchyGroupTransformSelection,
  } = hierarchyModule;
  const {
    commitFolderGroupTranslation,
    commitHierarchyGroupTranslation,
    commitHierarchyGroupRotation,
  } = commandModule;
  const {
    createCommandHistory,
    undoCommand,
  } = historyModule;
  const { useEditorStore } = storeModule;
  const { SceneRuntime } = runtimeModule;

  assert.equal(typeof commitHierarchyGroupTranslation, 'function');
  assert.equal(typeof commitHierarchyGroupRotation, 'function');

  const sceneViewSource = await readFile('src/editor/panels/SceneViewPanel.tsx', 'utf8');
  const attachSelectionStart = sceneViewSource.indexOf('  const attachCurrentSelectionGizmo = useCallback((');
  const attachSelectionEnd = sceneViewSource.indexOf('  /** 空群组、锁定成员或异步几何未就绪时只提示一次。 */', attachSelectionStart);
  assert.ok(
    attachSelectionStart >= 0 && attachSelectionEnd > attachSelectionStart,
    '必须能定位 Scene View 当前选区 Gizmo 绑定逻辑',
  );
  const attachSelectionBlock = sceneViewSource.slice(attachSelectionStart, attachSelectionEnd);
  assert.match(
    attachSelectionBlock,
    /if \(groupSelection\.status !== 'unavailable'\) \{\s*runtime\.clearFolderGroupGizmoTarget\(\);\s*gizmo\.attachToTarget\(null, null\);\s*return;\s*\}/,
    'blocked/empty 群组选区必须清空 Gizmo 并提前返回，不能回退为主选实体的单体 Gizmo',
  );

  const first = entity('first', 1);
  const second = entity('second', 5);
  const scene = sceneOf([first, second], second.id);
  const selectionIds = [first.id, second.id];
  const selection = resolveHierarchyGroupTransformSelection(scene, selectionIds);
  assert.equal(selection.status, 'ready');

  const translated = commitHierarchyGroupTranslation(
    scene,
    createCommandHistory(),
    selectionIds,
    {
      sourceSceneDocument: scene,
      groupId: selection.groupId,
      entityIds: selection.entityIds,
      beforePositions: selection.beforePositions,
      delta: { x: 3, y: -2, z: 4 },
    },
  );
  assert.equal(translated.committed, true);
  assert.deepEqual(translated.scene.entities[first.id].components.transform.position, { x: 4, y: -2, z: 4 });
  assert.deepEqual(translated.scene.entities[second.id].components.transform.position, { x: 8, y: -2, z: 4 });
  assert.equal(translated.history.undoStack.length, 1, '整组移动必须只产生一条历史');
  const undone = undoCommand(translated.scene, translated.history);
  assert.deepEqual(undone.scene.entities[first.id].components.transform.position, { x: 1, y: 0, z: 0 });
  assert.deepEqual(undone.scene.entities[second.id].components.transform.position, { x: 5, y: 0, z: 0 });

  const afterTransforms = Object.fromEntries(selection.entityIds.map((entityId) => {
    const before = selection.beforeTransforms[entityId];
    return [entityId, {
      position: { x: -before.position.x, y: 0, z: 0 },
      rotation: { x: 0, y: Math.PI, z: 0 },
      scale: { ...before.scale },
    }];
  }));
  const rotated = commitHierarchyGroupRotation(
    scene,
    createCommandHistory(),
    selectionIds,
    {
      sourceSceneDocument: scene,
      groupId: selection.groupId,
      entityIds: selection.entityIds,
      beforeTransforms: selection.beforeTransforms,
      afterTransforms,
    },
  );
  assert.equal(rotated.committed, true);
  assert.equal(rotated.history.undoStack.length, 1, '整组旋转必须只产生一条历史');
  assert.deepEqual(rotated.scene.entities[first.id].components.transform.scale, { x: 1, y: 1, z: 1 });
  assert.deepEqual(rotated.scene.entities[second.id].components.transform.scale, { x: 1, y: 1, z: 1 });

  const staleSelection = commitHierarchyGroupTranslation(
    scene,
    createCommandHistory(),
    [first.id],
    {
      sourceSceneDocument: scene,
      groupId: selection.groupId,
      entityIds: selection.entityIds,
      beforePositions: selection.beforePositions,
      delta: { x: 1, y: 0, z: 0 },
    },
  );
  assert.equal(staleSelection.committed, false);
  assert.match(staleSelection.message, /选区|群组/);

  const legacyFolder = entity('legacy-folder', 0, {
    isFolder: true,
    childrenIds: ['legacy-model', 'legacy-binding'],
  });
  const legacyModel = entity('legacy-model', 2, { parentId: legacyFolder.id });
  const legacyBinding = entity('legacy-binding', 4, {
    parentId: legacyFolder.id,
    components: {
      transform: transform(4),
      locator: { builtInBinding: {} },
    },
  });
  const legacyScene = sceneOf([legacyFolder, legacyModel, legacyBinding], legacyFolder.id);
  const legacySelection = resolveFolderGroupMoveSelection(legacyScene, [legacyFolder.id]);
  assert.equal(legacySelection.status, 'ready');
  assert.deepEqual(
    legacySelection.entityIds,
    [legacyModel.id],
    '兼容文件夹 API 也必须排除由宿主模型驱动的内置绑定 Locator',
  );
  const legacyCommitted = commitFolderGroupTranslation(
    legacyScene,
    createCommandHistory(),
    [legacyFolder.id],
    {
      sourceSceneDocument: legacyScene,
      folderId: legacyFolder.id,
      entityIds: legacySelection.entityIds,
      beforePositions: legacySelection.beforePositions,
      delta: { x: 1, y: 0, z: 0 },
    },
  );
  assert.equal(legacyCommitted.committed, true, '兼容文件夹提交 API 必须继续可用');
  assert.deepEqual(
    legacyCommitted.scene.entities[legacyBinding.id].components.transform.position,
    legacyBinding.components.transform.position,
    '内置绑定 Locator 不得被组合 Transform 单独写回',
  );

  useEditorStore.setState({
    scene,
    history: createCommandHistory(),
    hierarchySelectionIds: [first.id],
    transformTool: 'scale',
    transformSpace: 'local',
    groupTransformModeRestore: null,
  });
  useEditorStore.getState().selectHierarchyEntities(selectionIds, 'missing-primary');
  let state = useEditorStore.getState();
  assert.equal(state.scene.selectedEntityId, second.id, '无效主选必须回退到最近加入的有效选中实体');
  assert.equal(state.transformTool, 'translate', '多选时缩放工具必须临时回退移动');
  assert.equal(state.transformSpace, 'global', '多选时必须临时使用世界坐标');

  state.selectEntity(first.id);
  state = useEditorStore.getState();
  assert.equal(state.transformTool, 'scale', '恢复单选后必须恢复进入群组前的工具');
  assert.equal(state.transformSpace, 'local', '恢复单选后必须恢复进入群组前的坐标空间');

  state.selectHierarchyEntities(selectionIds, second.id);
  useEditorStore.getState().createMesh('cube');
  state = useEditorStore.getState();
  assert.equal(state.hierarchySelectionIds.length, 1, '创建实体后必须切换到新实体单选');
  assert.equal(state.scene.selectedEntityId, state.hierarchySelectionIds[0]);
  assert.equal(state.transformTool, 'scale', '从群组创建并单选新实体后必须恢复原工具');
  assert.equal(state.transformSpace, 'local', '从群组创建并单选新实体后必须恢复原坐标空间');
  assert.equal(state.groupTransformModeRestore, null, '离开群组选区后不得残留工具恢复快照');

  useEditorStore.setState({
    scene,
    history: createCommandHistory(),
    hierarchySelectionIds: [first.id],
    transformTool: 'scale',
    transformSpace: 'local',
    groupTransformModeRestore: null,
  });
  useEditorStore.getState().selectHierarchyEntities(selectionIds, second.id);
  useEditorStore.getState().deleteSelectedEntity();
  state = useEditorStore.getState();
  assert.deepEqual(state.hierarchySelectionIds, [], '删除完整群组选区后必须清空选区');
  assert.equal(state.transformTool, 'scale', '删除群组选区后必须恢复原工具');
  assert.equal(state.transformSpace, 'local', '删除群组选区后必须恢复原坐标空间');
  assert.equal(state.groupTransformModeRestore, null);

  const engine = new NullEngine({ renderWidth: 320, renderHeight: 240 });
  const babylonScene = new Scene(engine);
  const runtime = new SceneRuntime(babylonScene);
  try {
    runtime.setHierarchySelectionIds(scene, selectionIds);
    assert.deepEqual(
      [...runtime.resolveSelectedEntityIds(scene)],
      selectionIds,
      '运行时高亮必须使用完整 Hierarchy 多选，而不是只使用主选实体',
    );

    const firstMesh = MeshBuilder.CreateBox('group-ready-first', { size: 2 }, babylonScene);
    firstMesh.position.x = 0;
    firstMesh.computeWorldMatrix(true);
    runtime.meshes.set(first.id, firstMesh);

    const missingRuntimeTarget = entity('missing-runtime-target', 9, {
      components: {
        transform: transform(9),
        autoPatrol: {},
      },
    });
    runtime.syncedEntities.set(missingRuntimeTarget.id, missingRuntimeTarget);
    const unavailableTarget = runtime.getFolderGroupGizmoTarget(
      'missing-runtime-target-group',
      [first.id, missingRuntimeTarget.id],
      'rotate',
    );
    assert.ok(unavailableTarget, '运行时目标缺失时仍需保留可自动恢复的组合代理');
    assert.equal(
      unavailableTarget.isEnabled(),
      false,
      '即使包围盒已就绪，只要任一运行时写入目标缺失也不得显示组合 Gizmo',
    );
    assert.equal(
      runtime.isEntityGroupTransformReady([first.id, missingRuntimeTarget.id], 'rotate'),
      false,
    );
    runtime.syncedEntities.delete(missingRuntimeTarget.id);

    const pendingTarget = runtime.getFolderGroupGizmoTarget('pending-group', [first.id, second.id]);
    assert.ok(pendingTarget, '几何加载期间必须保留可自动恢复的组合代理');
    assert.equal(
      pendingTarget.getClassName(),
      'Mesh',
      '组合代理必须使用无几何 Mesh，确保 Babylon RotationGizmo 对代理可见',
    );
    assert.equal(pendingTarget.isEnabled(), false, '任一成员未加载时不得显示组合 Gizmo');
    assert.equal(runtime.isEntityGroupTransformReady([first.id, second.id], 'translate'), false);

    const secondMesh = MeshBuilder.CreateBox('group-ready-second', { size: 2 }, babylonScene);
    secondMesh.position.x = 6;
    secondMesh.computeWorldMatrix(true);
    runtime.meshes.set(second.id, secondMesh);
    runtime.refreshGroupTransformPreviewTargets();

    assert.equal(pendingTarget.isEnabled(), true, '全部成员就绪后组合 Gizmo 必须自动恢复显示');
    assert.equal(runtime.isEntityGroupTransformReady([first.id, second.id], 'translate'), true);
    assert.equal(runtime.isEntityGroupTransformReady([first.id, second.id], 'rotate'), true);
    assert.ok(Math.abs(pendingTarget.position.x - 3) < 1e-6, '组合轴心必须位于完整世界包围盒中心');
  } finally {
    runtime.dispose();
    babylonScene.dispose();
    engine.dispose();
  }

  console.log('Hierarchy group transform smoke passed.');
} finally {
  await server?.close();
}
