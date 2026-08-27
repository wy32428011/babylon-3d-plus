import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
  ssr: { noExternal: ['@linkiez/dxf-renew'] },
});

const {
  createEmptySceneDocument,
  createFolderEntity,
  createManualRoamSpawnEntity,
  createMeshEntity,
} = await viteServer.ssrLoadModule('/src/editor/model/SceneDocument.ts') as typeof import('../../src/editor/model/SceneDocument.ts');
const {
  findManualRoamSpawnEntity,
  hasManualRoamSpawnEntity,
  resolveManualRoamGroupRotationReference,
  resolveManualRoamSpawnPose,
} = await viteServer.ssrLoadModule('/src/editor/model/manualRoamSpawn.ts') as typeof import('../../src/editor/model/manualRoamSpawn.ts');
const {
  resolveHierarchyGroupTransformSelection,
} = await viteServer.ssrLoadModule('/src/editor/model/entityHierarchy.ts') as typeof import('../../src/editor/model/entityHierarchy.ts');
const {
  deserializeScene,
  serializeScene,
} = await viteServer.ssrLoadModule('/src/editor/project/SceneSerializer.ts') as typeof import('../../src/editor/project/SceneSerializer.ts');

after(async () => {
  await viteServer.close();
});

test('漫游出生点使用脚底世界坐标和实体 Y 轴朝向', () => {
  const scene = createEmptySceneDocument('漫游出生点');
  const spawn = createManualRoamSpawnEntity({ x: 12, y: 3.5, z: -8 });
  spawn.components.transform.rotation = { x: 0.4, y: Math.PI / 2, z: -0.7 };
  spawn.components.transform.scale = { x: 2, y: 3, z: 4 };
  scene.entityIds = [spawn.id];
  scene.entities = { [spawn.id]: spawn };

  assert.equal(findManualRoamSpawnEntity(scene)?.id, spawn.id);
  assert.equal(hasManualRoamSpawnEntity(scene), true);
  assert.deepEqual(resolveManualRoamSpawnPose(scene), {
    position: { x: 12, y: 3.5, z: -8 },
    yaw: Math.PI / 2,
  });
});

test('旧场景没有漫游出生点时保持空值，运行预览和 Viewer 不开放漫游功能', () => {
  const scene = createEmptySceneDocument('旧场景');

  assert.equal(findManualRoamSpawnEntity(scene), null);
  assert.equal(hasManualRoamSpawnEntity(scene), false);
  assert.equal(resolveManualRoamSpawnPose(scene), null);
  assert.equal(deserializeScene(serializeScene(scene)).entityIds.length, 0);
});

test('场景文件保存并重开后保留漫游出生点，且拒绝多个出生点', () => {
  const scene = createEmptySceneDocument('持久化出生点');
  const first = createManualRoamSpawnEntity({ x: 1, y: 2, z: 3 });
  first.components.transform.rotation.y = -Math.PI / 3;
  scene.entityIds = [first.id];
  scene.entities = { [first.id]: first };

  const restored = deserializeScene(serializeScene(scene));
  assert.deepEqual(resolveManualRoamSpawnPose(restored), {
    position: { x: 1, y: 2, z: 3 },
    yaw: -Math.PI / 3,
  });

  const duplicate = createManualRoamSpawnEntity({ x: 9, y: 0, z: 9 });
  scene.entityIds.push(duplicate.id);
  scene.entities[duplicate.id] = duplicate;
  assert.throws(() => deserializeScene(serializeScene(scene)), /场景文件格式不受支持/);
});

test('重复摆放漫游出生点只移动并选中已有实体', async () => {
  const globalWithWindow = globalThis as typeof globalThis & { window?: Record<string, unknown> };
  globalWithWindow.window ??= {};
  const { useEditorStore } = await viteServer.ssrLoadModule('/src/editor/store/editorStore.ts') as typeof import('../../src/editor/store/editorStore.ts');
  const initialScene = createEmptySceneDocument('唯一出生点');
  assert.equal(useEditorStore.getState().loadSceneFromContent(serializeScene(initialScene), 'spawn-test'), true);

  useEditorStore.getState().createManualRoamSpawn({ x: 1, y: 0, z: 2 });
  const firstState = useEditorStore.getState();
  const firstSpawn = findManualRoamSpawnEntity(firstState.scene);
  assert.ok(firstSpawn);

  useEditorStore.getState().createManualRoamSpawn({ x: 7, y: 1.25, z: -4 });
  const secondState = useEditorStore.getState();
  const spawnIds = secondState.scene.entityIds.filter((entityId) => (
    Boolean(secondState.scene.entities[entityId]?.components.manualRoamSpawn)
  ));

  assert.deepEqual(spawnIds, [firstSpawn.id]);
  assert.equal(secondState.scene.selectedEntityId, firstSpawn.id);
  assert.deepEqual(secondState.scene.entities[firstSpawn.id].components.transform.position, {
    x: 7,
    y: 1.25,
    z: -4,
  });

  useEditorStore.getState().selectEntity(null);
  useEditorStore.getState().createManualRoamSpawn();
  assert.equal(useEditorStore.getState().scene.selectedEntityId, firstSpawn.id);
});

test('重复摆放产生可撤销的位置修改，重做后恢复新初始位置', async () => {
  const globalWithWindow = globalThis as typeof globalThis & { window?: Record<string, unknown> };
  globalWithWindow.window ??= {};
  const { useEditorStore } = await viteServer.ssrLoadModule('/src/editor/store/editorStore.ts') as typeof import('../../src/editor/store/editorStore.ts');
  const initialScene = createEmptySceneDocument('可撤销出生点');
  assert.equal(useEditorStore.getState().loadSceneFromContent(serializeScene(initialScene), 'spawn-undo-test'), true);

  useEditorStore.getState().createManualRoamSpawn({ x: 1, y: 0, z: 2 });
  const spawnId = findManualRoamSpawnEntity(useEditorStore.getState().scene)?.id;
  assert.ok(spawnId);
  useEditorStore.getState().createManualRoamSpawn({ x: 9, y: 2, z: -6 });
  assert.deepEqual(useEditorStore.getState().scene.entities[spawnId].components.transform.position, {
    x: 9,
    y: 2,
    z: -6,
  });

  useEditorStore.getState().undo();
  assert.deepEqual(useEditorStore.getState().scene.entities[spawnId].components.transform.position, {
    x: 1,
    y: 0,
    z: 2,
  });

  useEditorStore.getState().redo();
  assert.deepEqual(useEditorStore.getState().scene.entities[spawnId].components.transform.position, {
    x: 9,
    y: 2,
    z: -6,
  });
});

test('出生点 Transform 仅允许平移和 Y 轴旋转', async () => {
  const globalWithWindow = globalThis as typeof globalThis & { window?: Record<string, unknown> };
  globalWithWindow.window ??= {};
  const { useEditorStore } = await viteServer.ssrLoadModule('/src/editor/store/editorStore.ts') as typeof import('../../src/editor/store/editorStore.ts');
  const initialScene = createEmptySceneDocument('出生点变换约束');
  assert.equal(useEditorStore.getState().loadSceneFromContent(serializeScene(initialScene), 'spawn-transform-test'), true);

  useEditorStore.getState().createManualRoamSpawn({ x: 0, y: 0, z: 0 });
  const spawnId = findManualRoamSpawnEntity(useEditorStore.getState().scene)?.id;
  assert.ok(spawnId);
  useEditorStore.getState().updateSelectedTransform('rotation', 'x', 0.75);
  useEditorStore.getState().updateSelectedTransform('rotation', 'y', Math.PI / 3);
  useEditorStore.getState().updateSelectedTransform('rotation', 'z', -0.5);
  useEditorStore.getState().updateSelectedTransform('scale', 'x', 3);

  const transform = useEditorStore.getState().scene.entities[spawnId].components.transform;
  assert.deepEqual(transform.rotation, { x: 0, y: Math.PI / 3, z: 0 });
  assert.deepEqual(transform.scale, { x: 1, y: 1, z: 1 });
});

test('含出生点的群组提交不会写入 X/Z 倾斜，且 Inspector 仅接受 Y 轴旋转', async () => {
  const globalWithWindow = globalThis as typeof globalThis & { window?: Record<string, unknown> };
  globalWithWindow.window ??= {};
  const { useEditorStore } = await viteServer.ssrLoadModule('/src/editor/store/editorStore.ts') as typeof import('../../src/editor/store/editorStore.ts');
  const initialScene = createEmptySceneDocument('出生点群组旋转约束');
  const spawn = createManualRoamSpawnEntity({ x: 0, y: 0, z: 0 });
  const mesh = createMeshEntity('cube', { x: 2, y: 0, z: 0 });
  initialScene.entityIds = [spawn.id, mesh.id];
  initialScene.entities = {
    [spawn.id]: spawn,
    [mesh.id]: mesh,
  };
  assert.equal(useEditorStore.getState().loadSceneFromContent(serializeScene(initialScene), 'spawn-group-rotation-test'), true);
  useEditorStore.getState().selectHierarchyEntities([spawn.id, mesh.id], mesh.id);

  const selectedState = useEditorStore.getState();
  const selection = resolveHierarchyGroupTransformSelection(
    selectedState.scene,
    selectedState.hierarchySelectionIds,
  );
  assert.equal(selection.status, 'ready');
  if (selection.status !== 'ready') return;

  const afterTransforms = structuredClone(selection.beforeTransforms);
  afterTransforms[spawn.id].rotation = { x: 0.45, y: Math.PI / 4, z: -0.35 };
  afterTransforms[mesh.id].rotation = { x: 0.2, y: Math.PI / 6, z: 0.3 };
  assert.equal(useEditorStore.getState().commitHierarchyGroupRotation({
    sourceSceneDocument: selectedState.scene,
    groupId: selection.groupId,
    entityIds: selection.entityIds,
    beforeTransforms: selection.beforeTransforms,
    afterTransforms,
  }), true);

  const committedState = useEditorStore.getState();
  assert.deepEqual(committedState.scene.entities[spawn.id].components.transform.rotation, {
    x: 0,
    y: Math.PI / 4,
    z: 0,
  });
  assert.deepEqual(committedState.scene.entities[mesh.id].components.transform.rotation, {
    x: 0.2,
    y: Math.PI / 6,
    z: 0.3,
  });

  useEditorStore.getState().requestSelectedGroupTransform('rotation', 'y', 0.5);
  assert.equal(useEditorStore.getState().groupInspectorTransformRequest?.axis, 'y');
  useEditorStore.getState().requestSelectedGroupTransform('rotation', 'x', 0.5);
  assert.equal(useEditorStore.getState().groupInspectorTransformRequest, null);

  useEditorStore.getState().undo();
  assert.deepEqual(useEditorStore.getState().scene.entities[spawn.id].components.transform.rotation, {
    x: 0,
    y: 0,
    z: 0,
  });
  useEditorStore.getState().redo();
  assert.deepEqual(useEditorStore.getState().scene.entities[spawn.id].components.transform.rotation, {
    x: 0,
    y: Math.PI / 4,
    z: 0,
  });
});

test('含出生点的单文件夹旋转入口同样强制移除 X/Z 倾斜', async () => {
  const globalWithWindow = globalThis as typeof globalThis & { window?: Record<string, unknown> };
  globalWithWindow.window ??= {};
  const { useEditorStore } = await viteServer.ssrLoadModule('/src/editor/store/editorStore.ts') as typeof import('../../src/editor/store/editorStore.ts');
  const initialScene = createEmptySceneDocument('出生点文件夹旋转约束');
  const folder = createFolderEntity('漫游出生点');
  const spawn = createManualRoamSpawnEntity({ x: 0, y: 0, z: 0 });
  const mesh = createMeshEntity('cube', { x: 2, y: 0, z: 0 });
  folder.childrenIds = [spawn.id, mesh.id];
  spawn.parentId = folder.id;
  mesh.parentId = folder.id;
  initialScene.entityIds = [folder.id, spawn.id, mesh.id];
  initialScene.entities = {
    [folder.id]: folder,
    [spawn.id]: spawn,
    [mesh.id]: mesh,
  };
  assert.equal(useEditorStore.getState().loadSceneFromContent(serializeScene(initialScene), 'spawn-folder-rotation-test'), true);
  useEditorStore.getState().selectHierarchyEntities([folder.id], folder.id);

  const selectedState = useEditorStore.getState();
  const selection = resolveHierarchyGroupTransformSelection(
    selectedState.scene,
    selectedState.hierarchySelectionIds,
  );
  assert.equal(selection.status, 'ready');
  if (selection.status !== 'ready') return;

  const afterTransforms = structuredClone(selection.beforeTransforms);
  afterTransforms[spawn.id].rotation = { x: 0.4, y: Math.PI / 5, z: -0.3 };
  afterTransforms[mesh.id].rotation = { x: 0.1, y: Math.PI / 7, z: 0.2 };
  assert.equal(useEditorStore.getState().commitFolderGroupRotation({
    sourceSceneDocument: selectedState.scene,
    folderId: folder.id,
    entityIds: selection.entityIds,
    beforeTransforms: selection.beforeTransforms,
    afterTransforms,
  }), true);

  const committedState = useEditorStore.getState();
  assert.deepEqual(committedState.scene.entities[spawn.id].components.transform.rotation, {
    x: 0,
    y: Math.PI / 5,
    z: 0,
  });
  assert.deepEqual(committedState.scene.entities[mesh.id].components.transform.rotation, {
    x: 0.1,
    y: Math.PI / 7,
    z: 0.2,
  });
});

test('含出生点群组的 Inspector Y 轴旋转不受倾斜参考实体影响', async () => {
  const scene = createEmptySceneDocument('出生点群组水平旋转');
  const tiltedMesh = createMeshEntity('cube', { x: -2, y: 0, z: 0 });
  tiltedMesh.components.transform.rotation = { x: 0.45, y: -0.3, z: -0.35 };
  const spawn = createManualRoamSpawnEntity({ x: 2, y: 1.25, z: 0 });
  spawn.components.transform.rotation.y = 0.2;
  scene.entityIds = [tiltedMesh.id, spawn.id];
  scene.entities = {
    [tiltedMesh.id]: tiltedMesh,
    [spawn.id]: spawn,
  };

  const currentRotation = resolveManualRoamGroupRotationReference(scene, scene.entityIds);
  assert.deepEqual(currentRotation, { x: 0, y: 0.2, z: 0 });

  const { EntityGroupRotationPreview, createEntityGroupRotationDeltaMatrix } = await viteServer.ssrLoadModule(
    '/src/runtime/babylon/EntityGroupRotationPreview.ts',
  ) as typeof import('../../src/runtime/babylon/EntityGroupRotationPreview.ts');
  const deltaMatrix = createEntityGroupRotationDeltaMatrix(
    { x: 0, y: 0, z: 0 },
    currentRotation,
    { x: 0, y: Math.PI / 2, z: 0 },
  );
  assert.ok(deltaMatrix);

  const preview = new EntityGroupRotationPreview(
    scene.entityIds,
    {
      [tiltedMesh.id]: structuredClone(tiltedMesh.components.transform),
      [spawn.id]: structuredClone(spawn.components.transform),
    },
    () => null,
  );
  preview.update(deltaMatrix);
  const after = preview.getTransforms()[spawn.id];
  assert.ok(Math.abs(after.position.y - spawn.components.transform.position.y) <= 1e-6);
  assert.ok(Math.abs(after.rotation.x) <= 1e-6);
  assert.ok(Math.abs(after.rotation.z) <= 1e-6);
});

test('出生点不能通过复制粘贴或阵列产生重复实体', async () => {
  const globalWithWindow = globalThis as typeof globalThis & { window?: Record<string, unknown> };
  globalWithWindow.window ??= {};
  const { useEditorStore } = await viteServer.ssrLoadModule('/src/editor/store/editorStore.ts') as typeof import('../../src/editor/store/editorStore.ts');
  const initialScene = createEmptySceneDocument('出生点唯一性操作');
  assert.equal(useEditorStore.getState().loadSceneFromContent(serializeScene(initialScene), 'spawn-unique-test'), true);

  useEditorStore.getState().createManualRoamSpawn({ x: 2, y: 0, z: 4 });
  const spawnId = findManualRoamSpawnEntity(useEditorStore.getState().scene)?.id;
  assert.ok(spawnId);
  useEditorStore.getState().copySelectedEntities();
  useEditorStore.getState().pasteEntityClipboard();

  const arrayResult = useEditorStore.getState().commitResolvedEntityArray({
    sourceIds: [spawnId],
    copyCount: 1,
    directionVector: { x: 1, y: 0, z: 0 },
    selectionSpanMeters: 1,
    spacingMeters: 1,
    assetNumberRule: '',
  });
  assert.equal(arrayResult.ok, false);

  const state = useEditorStore.getState();
  assert.deepEqual(
    state.scene.entityIds.filter((entityId) => Boolean(state.scene.entities[entityId]?.components.manualRoamSpawn)),
    [spawnId],
  );
});
