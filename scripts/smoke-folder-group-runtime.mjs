import assert from 'node:assert/strict';
import { FreeCamera, Matrix, MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { createServer } from 'vite';

const SSR_MODULE_LOAD_TIMEOUT_MS = 180_000;

async function loadModule(server, modulePath) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule(modulePath),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Vite SSR 文件夹组运行时模块加载超时：${modulePath}`)), SSR_MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function assertVector(actual, expected, message) {
  assert.ok(actual, message);
  assert.ok(Math.abs(actual.x - expected.x) <= 1e-6, `${message} x`);
  assert.ok(Math.abs(actual.y - expected.y) <= 1e-6, `${message} y`);
  assert.ok(Math.abs(actual.z - expected.z) <= 1e-6, `${message} z`);
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

  const { TransformGizmoController } = await loadModule(server, '/src/runtime/babylon/TransformGizmoController.ts');
  const { EntityGroupTranslationPreview } = await loadModule(
    server,
    '/src/runtime/babylon/EntityGroupTranslationPreview.ts',
  );
  const { EntityArrayThinInstanceBatch } = await loadModule(
    server,
    '/src/runtime/babylon/EntityArrayThinInstanceBatch.ts',
  );
  const { SceneRuntime } = await loadModule(server, '/src/runtime/babylon/SceneRuntime.ts');
  const { createEmptySceneDocument, createFolderEntity, createLocatorEntity } = await loadModule(
    server,
    '/src/editor/model/SceneDocument.ts',
  );
  assert.equal(
    typeof TransformGizmoController.prototype.attachToGroupTarget,
    'function',
    'TransformGizmoController 必须支持文件夹组代理 attachment',
  );
  assert.equal(
    typeof TransformGizmoController.prototype.cancelActiveGroupDrag,
    'function',
    '文档同步必须能只取消文件夹组拖动而不打断普通实体拖动',
  );
  const gizmoEngine = new NullEngine({ renderWidth: 64, renderHeight: 64 });
  const gizmoScene = new Scene(gizmoEngine);
  const gizmoCamera = new FreeCamera('gizmo-camera', new Vector3(0, 5, -10), gizmoScene);
  gizmoScene.activeCamera = gizmoCamera;
  const proxy = new TransformNode('folder-group-proxy', gizmoScene);
  proxy.position.copyFromFloats(2, 3, 4);
  const events = [];
  const entityEvents = [];
  const controller = new TransformGizmoController(gizmoScene, {
    previewTransform: (entityId, transform) => entityEvents.push({ type: 'preview', entityId, transform }),
    commitTransform: (entityId, before, after) => entityEvents.push({ type: 'commit', entityId, before, after }),
    beginEntityArrayDrag: () => null,
    previewEntityArrayDrag: () => undefined,
    completeEntityArrayDrag: () => undefined,
    cancelEntityArrayDrag: () => undefined,
    beginGroupTranslation: (folderId) => {
      events.push({ type: 'begin', folderId });
      return true;
    },
    previewGroupTranslation: (folderId, delta) => events.push({ type: 'preview', folderId, delta }),
    commitGroupTranslation: (folderId, delta) => events.push({ type: 'commit', folderId, delta }),
    cancelGroupTranslation: (folderId) => events.push({ type: 'cancel', folderId }),
  });
  controller.attachToGroupTarget(proxy, 'folder-a');
  controller.beginDragSnapshot();
  proxy.position.copyFromFloats(7, 1, 8);
  controller.previewAttachedTransform();
  controller.commitActiveDrag();
  assert.deepEqual(events[0], { type: 'begin', folderId: 'folder-a' });
  assert.deepEqual(events[1], { type: 'preview', folderId: 'folder-a', delta: { x: 5, y: -2, z: 4 } });
  assert.deepEqual(events[2], { type: 'commit', folderId: 'folder-a', delta: { x: 5, y: -2, z: 4 } });

  controller.attachToGroupTarget(proxy, 'folder-a');
  controller.beginDragSnapshot();
  proxy.position.copyFromFloats(9, 2, 9);
  controller.previewAttachedTransform();
  controller.cancelActiveGroupDrag();
  assertVector(proxy.position, { x: 7, y: 1, z: 8 }, '取消 Gizmo 拖动必须恢复组代理基线');
  assert.equal(events.at(-1).type, 'cancel');

  controller.beginDragSnapshot();
  proxy.position.copyFromFloats(12, 4, 10);
  controller.previewAttachedTransform();
  controller.setTool('rotate');
  assertVector(proxy.position, { x: 7, y: 1, z: 8 }, '组拖动期间请求旋转工具必须取消并恢复代理');
  assert.equal(events.at(-1).type, 'cancel', '组拖动期间请求旋转工具必须取消运行时预览');

  controller.beginDragSnapshot();
  proxy.position.copyFromFloats(6, 5, 11);
  controller.previewAttachedTransform();
  controller.setTransformSpace('local');
  assertVector(proxy.position, { x: 7, y: 1, z: 8 }, '组拖动期间请求局部坐标必须取消并恢复代理');
  assert.equal(events.at(-1).type, 'cancel', '组拖动期间请求局部坐标必须取消运行时预览');

  const entityTarget = new TransformNode('single-entity-target', gizmoScene);
  entityTarget.position.copyFromFloats(1, 2, 3);
  controller.attachToTarget(entityTarget, 'entity-a');
  controller.beginDragSnapshot();
  entityTarget.position.copyFromFloats(6, 4, 8);
  controller.previewAttachedTransform();
  controller.cancelActiveGroupDrag();
  assertVector(entityTarget.position, { x: 6, y: 4, z: 8 }, '组专用取消不得恢复普通实体拖动');
  controller.commitActiveDrag();
  assert.deepEqual(entityEvents.map((event) => event.type), ['preview', 'commit']);
  assert.deepEqual(entityEvents.at(-1), {
    type: 'commit',
    entityId: 'entity-a',
    before: {
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    after: {
      position: { x: 6, y: 4, z: 8 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
  }, '普通实体拖动必须在文档同步后继续形成一次提交');
  entityTarget.dispose(false, false);
  controller.dispose();
  gizmoScene.dispose();
  gizmoEngine.dispose();

  assert.equal(
    typeof EntityGroupTranslationPreview,
    'function',
    '必须提供轻量、可取消的文件夹组平移预览会话',
  );
  const previewEngine = new NullEngine({ renderWidth: 64, renderHeight: 64 });
  const previewScene = new Scene(previewEngine);
  const nodeTarget = new TransformNode('group-node-target', previewScene);
  nodeTarget.position.copyFromFloats(1, 2, 3);
  const batchEvents = [];
  let batchAvailable = false;
  let batchSessionActive = false;
  const batchTarget = {
    beginEntityTranslationPreview: (entityIds) => {
      batchEvents.push({ type: 'begin', entityIds: [...entityIds] });
      batchSessionActive = true;
      return true;
    },
    updateEntityTranslationPreview: (delta) => {
      batchEvents.push({ type: 'update', delta: { ...delta } });
      return batchSessionActive;
    },
    endEntityTranslationPreview: (restore) => {
      batchEvents.push({ type: 'end', restore });
      batchSessionActive = false;
    },
  };
  const createPreview = () => new EntityGroupTranslationPreview(
    ['node-a', 'batch-b', 'unloaded-c'],
    {
      'node-a': { x: 1, y: 2, z: 3 },
      'batch-b': { x: 10, y: 20, z: 30 },
      'unloaded-c': { x: -1, y: -2, z: -3 },
    },
    (entityId) => {
      if (entityId === 'node-a') {
        return {
          kind: 'position',
          identity: nodeTarget,
          setPosition: (position) => {
            nodeTarget.position.copyFromFloats(position.x, position.y, position.z);
            nodeTarget.computeWorldMatrix(true);
          },
        };
      }
      if (entityId === 'batch-b' && batchAvailable) return { kind: 'batch', batch: batchTarget };
      return null;
    },
  );

  const previewSession = createPreview();
  assert.equal(previewSession.update({ x: 2, y: -1, z: 4 }), true);
  assertVector(nodeTarget.position, { x: 3, y: 1, z: 7 }, '普通节点必须按基线应用绝对 delta');
  assert.equal(batchEvents.length, 0, '尚未加载的批次不得伪造预览');

  batchAvailable = true;
  assert.equal(previewSession.refresh(), true, '异步出现的批次必须能重新接入当前会话');
  assert.deepEqual(batchEvents[0], { type: 'begin', entityIds: ['batch-b'] });
  assert.deepEqual(batchEvents[1], { type: 'update', delta: { x: 2, y: -1, z: 4 } });

  batchSessionActive = false;
  assert.equal(previewSession.refresh(), true, '批次内部重建后必须重新捕获矩阵基线');
  assert.equal(
    batchEvents.filter((event) => event.type === 'begin').length,
    2,
    '批次预览会话失效时必须自动重新 begin',
  );
  assert.deepEqual(batchEvents.at(-1), { type: 'update', delta: { x: 2, y: -1, z: 4 } });

  assert.equal(previewSession.update({ x: 5, y: 3, z: -2 }), true);
  assertVector(nodeTarget.position, { x: 6, y: 5, z: 1 }, '连续预览不得累加上一帧 delta');
  assert.deepEqual(batchEvents.at(-1), { type: 'update', delta: { x: 5, y: 3, z: -2 } });
  previewSession.cancel();
  assertVector(nodeTarget.position, { x: 1, y: 2, z: 3 }, '取消会话必须精确恢复普通节点基线');
  assert.deepEqual(batchEvents.at(-1), { type: 'end', restore: true });

  batchEvents.length = 0;
  const retainedSession = createPreview();
  retainedSession.update({ x: -2, y: 1, z: 6 });
  retainedSession.finish();
  assertVector(nodeTarget.position, { x: -1, y: 3, z: 9 }, '完成会话必须保留当前运行时位置等待文档同步');
  assert.deepEqual(batchEvents.at(-1), { type: 'end', restore: false });
  previewScene.dispose();
  previewEngine.dispose();

  const mirroredEngine = new NullEngine({ renderWidth: 64, renderHeight: 64 });
  const mirroredScene = new Scene(mirroredEngine);
  const mirroredSource = MeshBuilder.CreateBox('mirrored-group-source', { size: 1 }, mirroredScene);
  const mirroredBatch = EntityArrayThinInstanceBatch.create(
    'mirrored-group-source',
    [mirroredSource],
    { interactive: true },
  );
  assert.ok(mirroredBatch, '必须创建负 determinant 文件夹组预览批次');
  try {
    const mirroredEntityId = 'mirrored-entity';
    assert.equal(mirroredBatch.updateEntityTransforms(Matrix.Identity(), [{
      entityId: mirroredEntityId,
      transform: {
        position: { x: 10, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: -1, y: 1, z: 1 },
      },
      pickable: true,
    }]), true);

    const readWorldTranslation = () => {
      const entityIndex = mirroredBatch.getEntityIds().indexOf(mirroredEntityId);
      for (const batch of mirroredBatch.batches) {
        const sourceEntityIndexes = batch.sourceEntityIndexBuffer;
        const sourceMatrices = batch.sourceMatrixBuffer;
        if (!sourceEntityIndexes || !sourceMatrices) continue;
        for (let sourceIndex = 0; sourceIndex < sourceEntityIndexes.length; sourceIndex += 1) {
          if (sourceEntityIndexes[sourceIndex] !== entityIndex) continue;
          const instanceMatrix = Matrix.FromArray(sourceMatrices, sourceIndex * 16);
          batch.mesh.computeWorldMatrix(true);
          return instanceMatrix.multiply(batch.mesh.getWorldMatrix()).getTranslation();
        }
      }
      return null;
    };

    assertVector(readWorldTranslation(), { x: 10, y: 2, z: 3 }, '负缩放实例基线世界位置必须正确');
    assert.equal(mirroredBatch.beginEntityTranslationPreview(new Set([mirroredEntityId])), true);
    assert.equal(mirroredBatch.updateEntityTranslationPreview({ x: 5, y: -1, z: 4 }), true);
    assertVector(
      readWorldTranslation(),
      { x: 15, y: 1, z: 7 },
      '负缩放 thinInstance 必须应用同方向世界位移',
    );
    mirroredBatch.endEntityTranslationPreview(true);
    assertVector(readWorldTranslation(), { x: 10, y: 2, z: 3 }, '取消负缩放预览必须恢复世界位置');
  } finally {
    mirroredBatch.dispose();
    mirroredSource.dispose(false, false);
    mirroredScene.dispose();
    mirroredEngine.dispose();
  }

  const cullingEngine = new NullEngine({ renderWidth: 640, renderHeight: 480 });
  const cullingScene = new Scene(cullingEngine);
  const cullingCamera = new FreeCamera('group-culling-camera', new Vector3(0, 0, -10), cullingScene);
  cullingCamera.setTarget(Vector3.Zero());
  cullingCamera.minZ = 0.1;
  cullingCamera.maxZ = 2_000;
  cullingScene.activeCamera = cullingCamera;

  const enteringSource = MeshBuilder.CreateBox('group-culling-enter-source', { size: 1 }, cullingScene);
  const enteringBatch = EntityArrayThinInstanceBatch.create(
    'group-culling-enter-source',
    [enteringSource],
    { interactive: true },
  );
  assert.ok(enteringBatch, '必须创建视锥进入预览批次');
  try {
    assert.equal(enteringBatch.updateEntityTransforms(Matrix.Identity(), [{
      entityId: 'entering-entity',
      transform: {
        position: { x: 1_000, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      pickable: true,
    }]), true);
    cullingScene.render();
    assert.equal(enteringBatch.meshes[0].thinInstanceCount, 0, '回归前提：远处实例初始应被视锥剔除');
    assert.equal(enteringBatch.beginEntityTranslationPreview(new Set(['entering-entity'])), true);
    assert.equal(enteringBatch.updateEntityTranslationPreview({ x: -1_000, y: 0, z: 0 }), true);
    cullingScene.render();
    const enteringBounds = enteringBatch.meshes[0].getBoundingInfo().boundingBox;
    assert.equal(enteringBatch.meshes[0].thinInstanceCount, 1, '移入视锥的实例必须重新提交到 GPU');
    assert.ok(
      enteringBounds.minimumWorld.x <= 0.5 && enteringBounds.maximumWorld.x >= -0.5,
      '移入视锥后 Mesh 包围盒必须覆盖新世界位置',
    );
    assert.equal(
      enteringBatch.meshes[0].isInFrustum(cullingScene.frustumPlanes),
      true,
      '移入视锥后 Mesh 必须重新成为 active mesh 候选',
    );
  } finally {
    enteringBatch.dispose();
    enteringSource.dispose(false, false);
  }

  const cancelSource = MeshBuilder.CreateBox('group-culling-cancel-source', { size: 1 }, cullingScene);
  const cancelBatch = EntityArrayThinInstanceBatch.create(
    'group-culling-cancel-source',
    [cancelSource],
    { interactive: true },
  );
  assert.ok(cancelBatch, '必须创建视锥取消恢复批次');
  try {
    assert.equal(cancelBatch.updateEntityTransforms(Matrix.Identity(), [{
      entityId: 'cancel-entity',
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      pickable: true,
    }]), true);
    cullingScene.render();
    assert.equal(cancelBatch.meshes[0].thinInstanceCount, 1, '回归前提：原点实例初始可见');
    assert.equal(cancelBatch.beginEntityTranslationPreview(new Set(['cancel-entity'])), true);
    assert.equal(cancelBatch.updateEntityTranslationPreview({ x: 1_000, y: 0, z: 0 }), true);
    cullingScene.render();
    assert.equal(cancelBatch.meshes[0].thinInstanceCount, 0, '移出视锥后实例必须被剔除');
    cancelBatch.endEntityTranslationPreview(true);
    cullingScene.render();
    const restoredBounds = cancelBatch.meshes[0].getBoundingInfo().boundingBox;
    assert.equal(cancelBatch.meshes[0].thinInstanceCount, 1, '取消预览必须恢复原点实例');
    assert.ok(
      restoredBounds.minimumWorld.x <= 0.5 && restoredBounds.maximumWorld.x >= -0.5,
      '取消预览后 Mesh 包围盒必须恢复到基线世界位置',
    );
    assert.equal(
      cancelBatch.meshes[0].isInFrustum(cullingScene.frustumPlanes),
      true,
      '取消预览后 Mesh 必须恢复 active mesh 候选状态',
    );
  } finally {
    cancelBatch.dispose();
    cancelSource.dispose(false, false);
    cullingScene.dispose();
    cullingEngine.dispose();
  }

  const locatorEngine = new NullEngine({ renderWidth: 320, renderHeight: 240 });
  const locatorScene = new Scene(locatorEngine);
  const locatorRuntime = new SceneRuntime(locatorScene);
  try {
    const locatorFolder = createFolderEntity('定位框组');
    const locatorEntity = createLocatorEntity({ x: 0, y: 0, z: 0 });
    locatorFolder.childrenIds = [locatorEntity.id];
    locatorEntity.parentId = locatorFolder.id;
    locatorEntity.components.locator = {
      ...locatorEntity.components.locator,
      length: 2,
      width: 1,
      height: 1,
      columns: 3,
      layers: 1,
      columnGap: 1,
    };
    const locatorDocument = createEmptySceneDocument();
    locatorDocument.entityIds = [locatorFolder.id, locatorEntity.id];
    locatorDocument.entities = {
      [locatorFolder.id]: locatorFolder,
      [locatorEntity.id]: locatorEntity,
    };
    locatorDocument.selectedEntityId = locatorFolder.id;
    locatorRuntime.sync(locatorDocument);

    const locatorTarget = locatorRuntime.getFolderGroupGizmoTarget(locatorFolder.id, [locatorEntity.id]);
    assert.ok(locatorTarget, '多格定位框必须提供文件夹组 Gizmo 代理');
    assertVector(locatorTarget.position, { x: 3, y: 0.5, z: 0 }, '组代理中心必须覆盖定位框全部格口');

    const locatorEntry = locatorRuntime.locators.get(locatorEntity.id);
    assert.ok(locatorEntry?.boxes[2], '回归前提：必须创建三个定位格口');
    assert.equal(
      locatorRuntime.beginFolderGroupTranslation(
        [locatorEntity.id],
        { [locatorEntity.id]: { x: 0, y: 0, z: 0 } },
      ),
      true,
    );
    assert.equal(locatorRuntime.updateFolderGroupTranslation({ x: 5, y: 0, z: 0 }), true);
    locatorRuntime.flushGroupTranslationPreview();
    locatorTarget.position.copyFromFloats(8, 0.5, 0);
    locatorEntry.boxes[2].position.x = 12;
    locatorEntry.boxes[2].computeWorldMatrix(true);
    locatorRuntime.refreshGroupTranslationPreviewTargets();
    assertVector(locatorTarget.position, { x: 8, y: 0.5, z: 0 }, '活动拖动期间异步几何不得改变代理起点');
    locatorRuntime.cancelFolderGroupTranslation();
    assertVector(locatorTarget.position, { x: 6, y: 0.5, z: 0 }, '取消后必须按最新几何重新校正组代理中心');
  } finally {
    locatorRuntime.dispose();
    locatorScene.dispose();
    locatorEngine.dispose();
  }

  console.log(JSON.stringify({
    ok: true,
    gizmoEvents: events.map((event) => event.type),
  }, null, 2));
} finally {
  await server?.close();
}
