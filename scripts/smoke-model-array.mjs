import assert from 'node:assert/strict';
import {
  Color3,
  MeshBuilder,
  NullEngine,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { createServer } from 'vite';

const SSR_MODULE_LOAD_TIMEOUT_MS = 60_000;
const SOURCE_ENTITY_ID = 'model-array-source';

/** 在限定时间内加载 SceneRuntime，避免 Vite SSR 异常时 smoke 无限等待。 */
async function loadSceneRuntimeModule(server) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts'),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Vite SSR 模型阵列模块加载超时（${SSR_MODULE_LOAD_TIMEOUT_MS}ms）。`));
        }, SSR_MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** 比较 Babylon 浮点结果。 */
function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= 1e-6, `${message}: ${actual} !== ${expected}`);
}

/** 比较节点位置。 */
function assertPosition(node, expected, message) {
  assertClose(node.position.x, expected.x, `${message} X`);
  assertClose(node.position.y, expected.y, `${message} Y`);
  assertClose(node.position.z, expected.z, `${message} Z`);
}

/** 读取当前临时克隆池；该 smoke 有意验证 SceneRuntime 的内部编辑态隔离契约。 */
function readPreviewClones(runtime) {
  return runtime.modelArrayPreview?.clones ?? [];
}

let server;
let engine;
let scene;
let runtime;
let gizmoController;
let editorStore;
let editorStoreSnapshot;

try {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    // dxf-renew 的 ESM 发布物省略了相对导入扩展名，交给 Vite 转换后再加载 SceneRuntime。
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });

  const { SceneRuntime } = await loadSceneRuntimeModule(server);
  const { TransformGizmoController } = await server.ssrLoadModule(
    '/src/runtime/babylon/TransformGizmoController.ts',
  );
  const { useEditorStore } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
  const { createEmptySceneDocument, createFolderEntity, createModelEntity } = await server.ssrLoadModule(
    '/src/editor/model/SceneDocument.ts',
  );
  editorStore = useEditorStore;
  editorStoreSnapshot = useEditorStore.getState();
  engine = new NullEngine();
  scene = new Scene(engine);
  runtime = new SceneRuntime(scene);

  const root = new TransformNode('source-root', scene);
  root.position.copyFromFloats(10, 2, -5);
  root.rotation.y = Math.PI / 2;
  root.scaling.copyFromFloats(2, 3, 4);
  root.metadata = { editorEntityId: SOURCE_ENTITY_ID, keepSource: true };

  const contentRoot = new TransformNode('source-content', scene);
  contentRoot.parent = root;
  contentRoot.metadata = { editorEntityId: SOURCE_ENTITY_ID };

  const sourceMesh = MeshBuilder.CreateBox(
    'source-box',
    { width: 2, height: 4, depth: 6 },
    scene,
  );
  sourceMesh.parent = contentRoot;
  sourceMesh.isPickable = true;
  sourceMesh.metadata = { editorEntityId: SOURCE_ENTITY_ID, keepSource: true };
  const sourceMaterial = new StandardMaterial('source-material', scene);
  sourceMaterial.diffuseColor = new Color3(0.2, 0.5, 0.8);
  sourceMesh.material = sourceMaterial;
  const sourceGeometry = sourceMesh.geometry;

  root.computeWorldMatrix(true);
  contentRoot.computeWorldMatrix(true);
  sourceMesh.computeWorldMatrix(true);

  // 这些方法只依赖普通模型条目的根节点、内容根、加载句柄与测量就绪标记。
  runtime.models.set(SOURCE_ENTITY_ID, {
    root,
    contentRoot,
    assetHandle: {},
    measurementReady: true,
  });

  const worldXGeometry = runtime.getModelArrayGeometry(SOURCE_ENTITY_ID, { x: 1, y: 0, z: 0 });
  assert.ok(worldXGeometry, '旋转、非均匀缩放模型必须能测量世界 X 投影跨度');
  assertClose(worldXGeometry.spanMeters, 24, '世界 X 应投影到缩放后的模型 Z 尺寸');

  const localXDirection = root.getDirection(Vector3.Right()).normalize();
  const localXGeometry = runtime.getModelArrayGeometry(SOURCE_ENTITY_ID, localXDirection);
  assert.ok(localXGeometry, '必须能沿模型局部 X 的世界方向测量跨度');
  assertClose(localXGeometry.spanMeters, 4, '局部 X 跨度必须包含非均匀缩放');
  assert.equal(
    runtime.getModelArrayGeometry(SOURCE_ENTITY_ID, { x: 0, y: 0, z: 0 }),
    null,
    '零方向必须被拒绝',
  );

  assert.equal(
    runtime.updateModelArrayPreview(SOURCE_ENTITY_ID, { x: 1, y: 0, z: 0 }, 3, 0),
    true,
    '必须创建零间距临时阵列',
  );
  const firstPool = [...readPreviewClones(runtime)];
  assert.equal(firstPool.length, 3, '临时克隆数量应等于新增副本数');
  assertPosition(firstPool[0], { x: 34, y: 2, z: -5 }, '零间距第一个副本');
  assertPosition(firstPool[1], { x: 58, y: 2, z: -5 }, '零间距第二个副本');
  assertPosition(firstPool[2], { x: 82, y: 2, z: -5 }, '零间距第三个副本');

  for (const clone of firstPool) {
    const cloneNodes = [clone, ...clone.getDescendants(false)];
    assert.ok(cloneNodes.every((node) => node.metadata === null), '临时克隆不得保留实体 metadata');
    assert.ok(clone.getChildMeshes(false).every((mesh) => !mesh.isPickable), '临时克隆不得参与拾取');
  }
  const firstCloneMesh = firstPool[0].getChildMeshes(false)[0];
  assert.equal(firstCloneMesh.geometry, sourceGeometry, '临时克隆应共享源模型几何');
  assert.equal(firstCloneMesh.material, sourceMaterial, '临时克隆应共享源模型材质');

  assert.equal(
    runtime.updateModelArrayPreview(SOURCE_ENTITY_ID, { x: 1, y: 0, z: 0 }, 1, 2),
    true,
    '修改数量和间距必须更新预览',
  );
  const reducedPool = [...readPreviewClones(runtime)];
  assert.equal(reducedPool.length, 1, '减少数量时必须回收多余克隆');
  assert.equal(reducedPool[0], firstPool[0], '减少数量时必须复用保留的克隆');
  assert.equal(firstPool[1].isDisposed(), true, '回收的克隆必须释放');
  assert.equal(firstPool[2].isDisposed(), true, '回收的克隆必须释放');
  assertPosition(reducedPool[0], { x: 36, y: 2, z: -5 }, '2 米净间距第一个副本');

  assert.equal(
    runtime.updateModelArrayPreview(SOURCE_ENTITY_ID, { x: -1, y: 0, z: 0 }, 2, 2),
    true,
    '负方向必须复用克隆池并更新排列',
  );
  const negativePool = [...readPreviewClones(runtime)];
  assert.equal(negativePool.length, 2, '增加数量时必须补足克隆池');
  assert.equal(negativePool[0], reducedPool[0], '方向变化不应重建仍可复用的克隆');
  assertPosition(negativePool[0], { x: -16, y: 2, z: -5 }, '负方向第一个副本');
  assertPosition(negativePool[1], { x: -42, y: 2, z: -5 }, '负方向第二个副本');

  runtime.clearModelArrayPreview();
  assert.equal(readPreviewClones(runtime).length, 0, '清理后不得保留临时克隆');
  assert.ok(negativePool.every((clone) => clone.isDisposed()), '清理必须释放全部临时克隆');
  assert.equal(root.isDisposed(), false, '清理不得释放源模型根节点');
  assert.equal(sourceMesh.isDisposed(), false, '清理不得释放源模型网格');
  assert.equal(sourceMesh.geometry, sourceGeometry, '清理不得释放源模型共享几何');
  assert.equal(sourceMesh.material, sourceMaterial, '清理不得释放源模型共享材质');
  assert.equal(sourceMesh.isPickable, true, '清理不得修改源模型拾取能力');
  assert.deepEqual(
    sourceMesh.metadata,
    { editorEntityId: SOURCE_ENTITY_ID, keepSource: true },
    '清理不得修改源模型 metadata',
  );

  const gizmoEvents = {
    previews: [],
    completions: [],
    cancellations: 0,
    transformPreviews: [],
    transformCommits: [],
  };
  gizmoController = new TransformGizmoController(scene, {
    previewTransform: (entityId, transform) => gizmoEvents.transformPreviews.push({ entityId, transform }),
    commitTransform: (entityId, before, after) => gizmoEvents.transformCommits.push({ entityId, before, after }),
    beginModelArrayDrag: (context) => runtime.getModelArrayGeometry(context.entityId, context.positiveDirection),
    previewModelArrayDrag: (update) => gizmoEvents.previews.push(update),
    completeModelArrayDrag: (update) => gizmoEvents.completions.push(update),
    cancelModelArrayDrag: () => { gizmoEvents.cancellations += 1; },
  });
  gizmoController.setSnapSettings({
    enabled: true,
    position: 0.5,
    rotationDegrees: 15,
    scale: 0.1,
  });
  gizmoController.attachToTarget(root, SOURCE_ENTITY_ID);

  const xAxisDrag = gizmoController.gizmoManager.gizmos.positionGizmo.xGizmo.dragBehavior;
  const localPositiveX = root.getDirection(Vector3.Right()).normalize();
  const sourcePositionBeforeArray = root.position.clone();
  xAxisDrag.onDragStartObservable.notifyObservers({ pointerInfo: { event: { shiftKey: true } } });
  assert.ok(gizmoController.modelArrayDragSession, 'Shift 开始后必须建立代理拖拽会话');
  assert.notEqual(
    gizmoController.modelArrayDragSession.proxyTarget,
    root,
    'Shift 阵列必须把 Gizmo 绑定到独立代理节点',
  );
  assertClose(
    gizmoController.gizmoManager.gizmos.positionGizmo.snapDistance,
    0,
    'Shift 阵列期间必须临时关闭位置吸附',
  );
  xAxisDrag.onDragObservable.notifyObservers({ delta: localPositiveX.scale(2.1) });
  xAxisDrag.onDragEndObservable.notifyObservers({});
  assert.equal(gizmoEvents.previews.at(-1)?.copyCount, 1, '局部轴半跨度以上拖动必须预览一个副本');
  assert.equal(gizmoEvents.completions.at(-1)?.copyCount, 1, '鼠标松开必须完成当前副本数量');
  assert.equal(gizmoEvents.transformCommits.length, 0, 'Shift 阵列不得提交 Transform 历史');
  assert.ok(root.position.equalsWithEpsilon(sourcePositionBeforeArray), 'Shift 阵列不得移动源模型');
  assertClose(
    gizmoController.gizmoManager.gizmos.positionGizmo.snapDistance,
    0.5,
    'Shift 阵列结束后必须恢复位置吸附',
  );

  xAxisDrag.onDragStartObservable.notifyObservers({ pointerInfo: { event: { shiftKey: true } } });
  xAxisDrag.onDragObservable.notifyObservers({ delta: localPositiveX.scale(-6.1) });
  xAxisDrag.onDragEndObservable.notifyObservers({});
  const negativeCompletion = gizmoEvents.completions.at(-1);
  assert.equal(negativeCompletion.copyCount, 2, '负方向拖动必须使用绝对副本数量');
  assert.ok(
    Vector3.Dot(
      new Vector3(
        negativeCompletion.direction.x,
        negativeCompletion.direction.y,
        negativeCompletion.direction.z,
      ),
      localPositiveX,
    ) < 0,
    '负方向拖动必须回传反向世界单位向量',
  );

  const completedBeforeCancel = gizmoEvents.completions.length;
  xAxisDrag.onDragStartObservable.notifyObservers({ pointerInfo: { event: { shiftKey: true } } });
  xAxisDrag.onDragObservable.notifyObservers({ delta: localPositiveX.scale(5) });
  gizmoController.cancelActiveDrag();
  assert.equal(gizmoEvents.cancellations, 1, '主动取消必须通知上层清理预览');
  assert.equal(gizmoEvents.completions.length, completedBeforeCancel, '主动取消不得误提交阵列');
  assert.ok(root.position.equalsWithEpsilon(sourcePositionBeforeArray), '取消阵列后源模型必须保持原位');

  xAxisDrag.onDragStartObservable.notifyObservers({ pointerInfo: { event: { shiftKey: false } } });
  root.position.x += 1;
  xAxisDrag.onDragObservable.notifyObservers({ delta: new Vector3(1, 0, 0) });
  xAxisDrag.onDragEndObservable.notifyObservers({});
  assert.equal(gizmoEvents.transformPreviews.length, 1, '普通 Gizmo 拖动必须继续预览 Transform');
  assert.equal(gizmoEvents.transformCommits.length, 1, '普通 Gizmo 拖动必须继续提交一次 Transform');

  const positionBeforeTransformCancel = root.position.clone();
  const commitsBeforeTransformCancel = gizmoEvents.transformCommits.length;
  xAxisDrag.onDragStartObservable.notifyObservers({ pointerInfo: { event: { shiftKey: false } } });
  root.position.z += 3;
  xAxisDrag.onDragObservable.notifyObservers({ delta: new Vector3(0, 0, 3) });
  gizmoController.cancelActiveDrag();
  assert.ok(
    root.position.equalsWithEpsilon(positionBeforeTransformCancel),
    'pointercancel/失焦路径必须回滚普通 Transform',
  );
  assert.equal(
    gizmoEvents.transformCommits.length,
    commitsBeforeTransformCancel,
    '取消普通 Transform 不得提交历史',
  );

  const positionBeforeDispose = root.position.clone();
  const commitsBeforeDispose = gizmoEvents.transformCommits.length;
  xAxisDrag.onDragStartObservable.notifyObservers({ pointerInfo: { event: { shiftKey: false } } });
  root.position.y += 2;
  xAxisDrag.onDragObservable.notifyObservers({ delta: new Vector3(0, 2, 0) });
  gizmoController.dispose();
  gizmoController = null;
  assert.ok(root.position.equalsWithEpsilon(positionBeforeDispose), '控制器销毁必须回滚普通 Transform');
  assert.equal(gizmoEvents.transformCommits.length, commitsBeforeDispose, '控制器销毁不得误提交 Transform');

  const arrayFolder = createFolderEntity('Array Folder');
  const arraySource = createModelEntity(
    'fixture.glb',
    'fixture.glb',
    'Source Model',
    { lengthUnit: 'meter', unitScaleToMeters: 1 },
    { x: 5, y: 1, z: 2 },
  );
  arraySource.parentId = arrayFolder.id;
  arraySource.components.modelAsset.assetCode = 'DEV009';
  arrayFolder.childrenIds = [arraySource.id];
  const conflictEntity = createModelEntity(
    'conflict.glb',
    'conflict.glb',
    'DEV010',
    { lengthUnit: 'meter', unitScaleToMeters: 1 },
  );
  conflictEntity.components.modelAsset.assetCode = 'OTHER';
  const storeScene = createEmptySceneDocument('Model Array Store Smoke');
  storeScene.entityIds = [arrayFolder.id, arraySource.id, conflictEntity.id];
  storeScene.entities = {
    [arrayFolder.id]: arrayFolder,
    [arraySource.id]: arraySource,
    [conflictEntity.id]: conflictEntity,
  };
  storeScene.selectedEntityId = arraySource.id;
  useEditorStore.setState({
    scene: storeScene,
    runtimeMode: 'edit',
    history: { undoStack: [], redoStack: [] },
    hierarchySelectionIds: [arraySource.id],
    entityArrayRequest: null,
  });

  const conflictResult = useEditorStore.getState().commitResolvedEntityArray({
    sourceIds: [arraySource.id],
    copyCount: 2,
    directionVector: { x: -1, y: 0, z: 0 },
    selectionSpanMeters: 2,
    spacingMeters: 0.5,
    assetNumberRule: '',
  });
  assert.equal(conflictResult.ok, false, '确认时必须再次原子阻止名称冲突');
  assert.match(conflictResult.error, /DEV010/, '冲突错误必须包含具体占用值');
  assert.equal(useEditorStore.getState().history.undoStack.length, 0, '冲突提交不得写入历史');

  const conflictFreeScene = useEditorStore.getState().scene;
  const { [conflictEntity.id]: _removedConflict, ...conflictFreeEntities } = conflictFreeScene.entities;
  useEditorStore.setState({
    scene: {
      ...conflictFreeScene,
      entityIds: conflictFreeScene.entityIds.filter((entityId) => entityId !== conflictEntity.id),
      entities: conflictFreeEntities,
    },
  });

  const commitResult = useEditorStore.getState().commitResolvedEntityArray({
    sourceIds: [arraySource.id],
    copyCount: 2,
    directionVector: { x: -1, y: 0, z: 0 },
    selectionSpanMeters: 2,
    spacingMeters: 0.5,
    assetNumberRule: '',
  });
  assert.equal(commitResult.ok, true, '无冲突时必须正式提交模型阵列');
  const duplicatedIds = commitResult.duplicatedIds;
  assert.equal(duplicatedIds.length, 2, '正式提交必须返回全部副本 ID');

  let committedState = useEditorStore.getState();
  const committedCopies = duplicatedIds.map((entityId) => committedState.scene.entities[entityId]);
  assert.deepEqual(committedCopies.map((entity) => entity.name), ['DEV010', 'DEV011']);
  assert.deepEqual(
    committedCopies.map((entity) => entity.components.modelAsset.assetCode),
    ['DEV010', 'DEV011'],
    '副本名称和资产编号必须同步递增',
  );
  assert.deepEqual(
    committedCopies.map((entity) => entity.components.transform.position),
    [
      { x: 2.5, y: 1, z: 2 },
      { x: 0, y: 1, z: 2 },
    ],
    '正式副本必须按跨度加净间距排列',
  );
  assert.ok(committedCopies.every((entity) => entity.parentId === arrayFolder.id), '副本必须保留父文件夹');
  assert.deepEqual(
    committedState.scene.entities[arrayFolder.id].childrenIds,
    [arraySource.id, ...duplicatedIds],
    '父文件夹必须登记全部新副本',
  );
  assert.equal(committedState.scene.selectedEntityId, arraySource.id, '确认后必须保持源模型选中');
  assert.equal(committedState.history.undoStack.length, 1, '整组阵列必须只写入一条撤销历史');

  committedState.undo();
  let undoneState = useEditorStore.getState();
  assert.ok(duplicatedIds.every((entityId) => !undoneState.scene.entities[entityId]), '撤销必须删除整组副本');
  assert.deepEqual(undoneState.scene.entities[arrayFolder.id].childrenIds, [arraySource.id]);

  undoneState.redo();
  const redoneState = useEditorStore.getState();
  assert.ok(duplicatedIds.every((entityId) => redoneState.scene.entities[entityId]), '重做必须恢复相同副本 ID');
  assert.deepEqual(
    duplicatedIds.map((entityId) => redoneState.scene.entities[entityId].name),
    ['DEV010', 'DEV011'],
    '重做必须恢复相同名称和编号',
  );

  console.log(JSON.stringify({
    ok: true,
    modelArray: {
      rotatedNonUniformWorldSpan: worldXGeometry.spanMeters,
      rotatedNonUniformLocalSpan: localXGeometry.spanMeters,
      zeroSpacingPreview: true,
      spacingAndDirectionUpdate: true,
      clonePoolReuse: true,
      pickingAndMetadataIsolated: true,
      sourceResourcesPreserved: true,
      shiftGizmoProxyKeepsSourceStable: true,
      negativeAxisAndCancelLifecycle: true,
      normalTransformDragPreserved: true,
      pointerCancelAndDisposeDoNotCommit: true,
      atomicConflictAndUndoRedo: true,
    },
  }, null, 2));
} finally {
  // synthetic 模型条目没有完整 ModelRuntimeEntry 字段，先从私有映射移除，再释放真实 Runtime 资源。
  gizmoController?.dispose();
  if (editorStore && editorStoreSnapshot) editorStore.setState(editorStoreSnapshot, true);
  runtime?.models?.delete(SOURCE_ENTITY_ID);
  runtime?.dispose();
  scene?.dispose();
  engine?.dispose();
  await server?.close();
}
