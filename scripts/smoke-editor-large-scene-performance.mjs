import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FreeCamera,
  Matrix,
  Mesh,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  Scene,
  SelectionOutlineLayer,
  TransformNode,
  Vector3,
  VertexData,
} from '@babylonjs/core';
import { createServer } from 'vite';

const LARGE_PLAN_COUNTS = [10_000, 50_000];
const BATCH_ENTITY_COUNT = 10_000;
const BATCH_SOURCE_VERTEX_COUNT = 31_998;
const BATCH_EXPECTED_MAX_INSTANCES_PER_PARTITION = Math.floor(32_000_000 / BATCH_SOURCE_VERTEX_COUNT);
const EDITOR_LAYOUT_PATH = 'src/editor/layout/EditorLayout.tsx';
const SCENE_VIEW_PANEL_PATH = 'src/editor/panels/SceneViewPanel.tsx';
const TOOLBAR_PATH = 'src/editor/ui/Toolbar.tsx';
const PERFORMANCE_MONITOR_PATH = 'src/runtime/babylon/ScenePerformanceMonitor.ts';
const ENTITY_ARRAY_BATCH_PATH = 'src/runtime/babylon/EntityArrayThinInstanceBatch.ts';
const SCENE_RUNTIME_PATH = 'src/runtime/babylon/SceneRuntime.ts';

/** 创建同一静态模板下的独立逻辑模型，保持真实 SceneDocument 不可变引用语义。 */
function createLargeStaticModelScene(entityCount) {
  const entityIds = new Array(entityCount);
  const entities = {};
  for (let index = 0; index < entityCount; index += 1) {
    const entityId = `PERF-MODEL-${String(index + 1).padStart(6, '0')}`;
    entityIds[index] = entityId;
    entities[entityId] = {
      id: entityId,
      name: entityId,
      parentId: null,
      childrenIds: [],
      visible: true,
      locked: false,
      components: {
        transform: {
          position: { x: index % 500, y: 0, z: Math.floor(index / 500) },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        modelAsset: {
          sourcePath: 'F:/fixtures/Performance/Performance.glb',
          sourceUrl: 'smoke://Assets/Models/Performance/Performance.glb',
          assetRevision: 'large-scene-performance',
          assetCode: entityId,
          lengthUnit: 'meter',
          unitScaleToMeters: 1,
        },
      },
    };
  }
  return { entityIds, entities };
}

/** 创建约 32k 顶点的无索引静态源，使动态 GPU 顶点预算把 10k 实例稳定拆成 10 个空间分片。 */
function createPartitionBudgetSourceMesh(scene) {
  const mesh = new Mesh('large-selection-source', scene);
  const positions = new Float32Array(BATCH_SOURCE_VERTEX_COUNT * 3);
  const normals = new Float32Array(BATCH_SOURCE_VERTEX_COUNT * 3);
  for (let vertex = 0; vertex < BATCH_SOURCE_VERTEX_COUNT; vertex += 3) {
    const offset = vertex * 3;
    positions.set([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0], offset);
    normals.set([0, 0, 1, 0, 0, 1, 0, 0, 1], offset);
  }
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.normals = normals;
  vertexData.applyToMesh(mesh, false);
  return mesh;
}

/** 只断言数量级和引用复用，不使用易受 CI 环境影响的硬毫秒阈值。 */
function verifyEditModePlan(createEditModeModelThinInstancePlan, entityCount) {
  const scene = createLargeStaticModelScene(entityCount);
  const startedAt = performance.now();
  const plan = createEditModeModelThinInstancePlan(scene);
  const firstDurationMs = performance.now() - startedAt;

  assert.equal(plan.groupCount, 1, `${entityCount} 个同模板模型必须形成一个分组`);
  assert.equal(plan.sourceEntityIds.length, 1, `${entityCount} 个同模板模型只能保留一个源`);
  assert.equal(plan.thinInstanceEntityCount, entityCount - 1, `${entityCount} 个逻辑模型必须只保留一个真实源`);
  assert.equal(Object.keys(plan.entities).length, entityCount, '编辑态覆盖不得丢失逻辑实体');

  const secondStartedAt = performance.now();
  const repeatedPlan = createEditModeModelThinInstancePlan(scene, plan);
  const repeatedDurationMs = performance.now() - secondStartedAt;
  assert.equal(repeatedPlan.entities, plan.entities, '未变化场景必须复用完整派生 entities 引用');
  assert.equal(
    repeatedPlan.entities[scene.entityIds.at(-1)],
    plan.entities[scene.entityIds.at(-1)],
    '未变化逻辑实体必须复用派生对象',
  );

  return {
    entityCount,
    groupCount: plan.groupCount,
    thinInstanceEntityCount: plan.thinInstanceEntityCount,
    firstDurationMs,
    repeatedDurationMs,
  };
}

/** 验证单模型参数预览只替换目标派生实体，并保持跨参数值的稳定合批拓扑。 */
function verifyModelParameterPreviewPlan(
  createEditModeModelThinInstancePlan,
  patchEditModeModelThinInstancePlanForModelParameters,
  resolveModelParameterOnlySceneChangeEntityId,
) {
  const entityCount = 10_000;
  const scene = createLargeStaticModelScene(entityCount);
  const initialPlan = createEditModeModelThinInstancePlan(scene);
  const targetEntityId = scene.entityIds.at(-1);
  const targetEntity = scene.entities[targetEntityId];
  const nextTargetEntity = {
    ...targetEntity,
    components: {
      ...targetEntity.components,
      modelAsset: {
        ...targetEntity.components.modelAsset,
        parameterValues: { width: 2 },
      },
    },
  };
  const nextScene = {
    ...scene,
    entities: { ...scene.entities, [targetEntityId]: nextTargetEntity },
  };

  const sharedMqttConfig = {};
  const sharedSceneSettings = {};
  const sharedFetchConfig = {};
  const previousDocument = {
    ...scene,
    id: 'parameter-preview-performance',
    name: 'Parameter Preview Performance',
    selectedEntityId: targetEntityId,
    mqttConfig: sharedMqttConfig,
    sceneSettings: sharedSceneSettings,
    fetchConfig: sharedFetchConfig,
  };
  const nextDocument = { ...previousDocument, entities: nextScene.entities };
  assert.equal(
    resolveModelParameterOnlySceneChangeEntityId(previousDocument, nextDocument),
    targetEntityId,
    '参数变化识别必须命中当前选中模型',
  );
  const transformChangedEntity = {
    ...nextTargetEntity,
    components: {
      ...nextTargetEntity.components,
      transform: { ...nextTargetEntity.components.transform, position: { x: 1, y: 0, z: 0 } },
    },
  };
  assert.equal(
    resolveModelParameterOnlySceneChangeEntityId(previousDocument, {
      ...nextDocument,
      entities: { ...nextDocument.entities, [targetEntityId]: transformChangedEntity },
    }),
    null,
    '参数与 Transform 同时变化时必须回退完整同步',
  );

  let previewEntityReadCount = 0;
  const guardedPreviewScene = {
    entityIds: new Proxy(nextScene.entityIds, {
      get() { throw new Error('参数预览增量计划不得读取或迭代完整 entityIds'); },
    }),
    entities: new Proxy(nextScene.entities, {
      get(target, property, receiver) {
        if (typeof property === 'string' && property !== targetEntityId) {
          throw new Error(`参数预览增量计划不得读取无关实体：${property}`);
        }
        if (property === targetEntityId) previewEntityReadCount += 1;
        return Reflect.get(target, property, receiver);
      },
      ownKeys() { throw new Error('参数预览增量计划不得枚举完整 entities'); },
    }),
  };
  const startedAt = performance.now();
  const previewPlan = patchEditModeModelThinInstancePlanForModelParameters(
    guardedPreviewScene,
    initialPlan,
    targetEntityId,
  );
  const durationMs = performance.now() - startedAt;

  assert.equal(previewEntityReadCount, 1, '参数预览增量计划只能读取目标实体一次');
  assert.equal(previewPlan.groupCount, 1, '参数预览不得拆散同一结构模板的编辑态分组');
  assert.equal(previewPlan.thinInstanceEntityCount, entityCount - 1, '参数预览不得把目标退化为独立真实模型');
  assert.equal(
    previewPlan.entities[targetEntityId].components.modelArrayInstance?.sourceEntityId,
    initialPlan.sourceEntityIds[0],
    '参数预览必须保留目标原有矩阵源，由 SceneRuntime 参数变体承载视觉差异',
  );
  assert.equal(
    previewPlan.entities[scene.entityIds[1]],
    initialPlan.entities[scene.entityIds[1]],
    '参数预览必须复用所有无关派生实体引用',
  );

  const rebuiltPlan = createEditModeModelThinInstancePlan(nextScene, previewPlan);
  assert.equal(rebuiltPlan.groupCount, 1, '完整重算也必须按结构模板合并不同参数值');
  assert.equal(rebuiltPlan.thinInstanceEntityCount, entityCount - 1, '完整重算不得因参数值不同改变合批拓扑');

  return { entityCount, durationMs, stableSourceEntityId: initialPlan.sourceEntityIds[0] };
}

/** 验证高顶点 10k thinInstance 的动态空间分片、拾取映射和单选差量更新。 */
function verifyThinInstanceSelectionDelta(EntityArrayThinInstanceBatch) {
  const engine = new NullEngine({ renderWidth: 64, renderHeight: 64 });
  const scene = new Scene(engine);
  const sourceMesh = createPartitionBudgetSourceMesh(scene);
  const batch = EntityArrayThinInstanceBatch.create('large-selection-source', [sourceMesh], { interactive: true });
  assert.ok(batch, '必须创建 10k 逻辑模型的矩阵批次');
  let selectionLayer = null;

  try {
    const instances = Array.from({ length: BATCH_ENTITY_COUNT }, (_, index) => ({
      entityId: `BATCH-${String(index + 1).padStart(5, '0')}`,
      transform: {
        position: { x: index % 200, y: 0, z: Math.floor(index / 200) },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      pickable: true,
    }));
    const updateStartedAt = performance.now();
    assert.equal(batch.updateEntityTransforms(Matrix.Identity(), instances), true, '10k 逻辑模型矩阵必须一次提交成功');
    const transformUpdateDurationMs = performance.now() - updateStartedAt;
    const activeBatches = batch.batches.filter((entry) => entry.mesh.thinInstanceCount > 0);
    const totalThinInstanceCount = activeBatches.reduce((total, entry) => total + entry.mesh.thinInstanceCount, 0);
    assert.equal(
      activeBatches.length,
      Math.ceil(BATCH_ENTITY_COUNT / BATCH_EXPECTED_MAX_INSTANCES_PER_PARTITION),
      '高顶点 10k 实例必须按动态 GPU 顶点预算拆成固定数量空间分片',
    );
    assert.ok(
      activeBatches.every((entry) => entry.mesh.thinInstanceCount <= BATCH_EXPECTED_MAX_INSTANCES_PER_PARTITION),
      '单个空间分片不得超过动态 GPU 顶点预算',
    );
    assert.equal(totalThinInstanceCount, BATCH_ENTITY_COUNT, '空间分片不得减少任何逻辑实例');
    const partitionBoundsSizes = activeBatches.map((entry) => {
      const bounds = entry.mesh.getBoundingInfo().boundingBox;
      return {
        x: bounds.maximumWorld.x - bounds.minimumWorld.x,
        z: bounds.maximumWorld.z - bounds.minimumWorld.z,
      };
    });
    const maxPartitionBoundsXMeters = Math.max(...partitionBoundsSizes.map((bounds) => bounds.x));
    const maxPartitionBoundsZMeters = Math.max(...partitionBoundsSizes.map((bounds) => bounds.z));
    assert.ok(
      maxPartitionBoundsXMeters < 100,
      `平衡空间分片 X 包围盒必须显著小于完整 200 米场景跨度，实际 ${maxPartitionBoundsXMeters}`,
    );
    assert.ok(
      maxPartitionBoundsZMeters < 30,
      `平衡空间分片 Z 包围盒必须显著小于完整 50 米场景跨度，实际 ${maxPartitionBoundsZMeters}`,
    );

    batch.setSelectionMask(new Set([instances[0].entityId]), 1);
    const firstEntityBatch = activeBatches.find((entry) => (entry.entityInstanceRangeStarts?.[0] ?? -1) >= 0);
    assert.ok(firstEntityBatch, '首个逻辑实体必须存在于某个空间分片');
    const firstEntityStart = firstEntityBatch.entityInstanceRangeStarts[0];
    assert.equal(batch.getEntityIdForThinInstance(firstEntityBatch.mesh, firstEntityStart), instances[0].entityId);
    const initialSelectionBuffers = new Map(activeBatches.map((entry) => [entry, entry.selectionBuffer]));
    assert.ok([...initialSelectionBuffers.values()].every((buffer) => buffer instanceof Float32Array), '每个活动分片必须注册选择缓冲');
    assert.equal(firstEntityBatch.selectionBuffer[firstEntityStart], 1, '首个逻辑模型必须写入选择 ID');

    selectionLayer = new SelectionOutlineLayer('large-selection-outline', scene);
    selectionLayer.addSelection(activeBatches.map((entry) => entry.mesh));
    assert.ok(
      activeBatches.every((entry) => (
        entry.mesh._userThinInstanceBuffersStorage.data.instanceSelectionId.every((value) => value === 1)
      )),
      '回归前提：Babylon SelectionOutlineLayer 必须先把每个活动分片覆盖为整批选中',
    );
    batch.setSelectionMask(new Set([instances[0].entityId]), 1);
    assert.ok(
      activeBatches.every((entry) => (
        entry.mesh._userThinInstanceBuffersStorage.data.instanceSelectionId === entry.selectionBuffer
      )),
      '逻辑选区未变化时也必须重新绑定批次权威选择数组',
    );
    assert.equal(
      activeBatches.reduce(
        (count, entry) => count + entry.mesh._userThinInstanceBuffersStorage.data.instanceSelectionId
          .subarray(0, entry.mesh.thinInstanceCount)
          .reduce((total, value) => total + (value === 1 ? 1 : 0), 0),
        0,
      ),
      1,
      '选择一个逻辑实体时，实际绑定到 Mesh 的缓冲只能高亮该实体',
    );

    const originalEntityIds = batch.entityIds;
    batch.entityIds = new Proxy(originalEntityIds, {
      get(target, property, receiver) {
        if (property === 'length' || property === Symbol.iterator || /^\d+$/.test(String(property))) {
          throw new Error('差量选择不得读取完整 entityIds');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const selectionStartedAt = performance.now();
    assert.doesNotThrow(
      () => batch.setSelectionMask(new Set([instances.at(-1).entityId]), 1),
      '跨空间分片切换单选必须只访问前后目标区间',
    );
    const selectionUpdateDurationMs = performance.now() - selectionStartedAt;
    batch.entityIds = originalEntityIds;

    const lastEntityIndex = instances.length - 1;
    const lastEntityBatch = activeBatches.find((entry) => (
      (entry.entityInstanceRangeStarts?.[lastEntityIndex] ?? -1) >= 0
    ));
    assert.ok(lastEntityBatch, '最后一个逻辑实体必须存在于某个空间分片');
    const lastEntityStart = lastEntityBatch.entityInstanceRangeStarts[lastEntityIndex];
    assert.equal(batch.getEntityIdForThinInstance(lastEntityBatch.mesh, lastEntityStart), instances.at(-1).entityId);
    assert.ok(
      activeBatches.every((entry) => entry.selectionBuffer === initialSelectionBuffers.get(entry)),
      '同布局选择切换必须复用每个分片的 Float32Array',
    );
    assert.equal(firstEntityBatch.selectionBuffer[firstEntityStart], 0, '旧分片选区必须差量清零');
    assert.equal(lastEntityBatch.selectionBuffer[lastEntityStart], 1, '新分片选区必须只写入目标实例');
    assert.ok(
      activeBatches.every((entry) => (
        entry.mesh._userThinInstanceBuffersStorage.data.instanceSelectionId === entry.selectionBuffer
      )),
      '跨分片切换单选后，Mesh 实际缓冲必须继续引用批次权威数组',
    );
    assert.equal(
      activeBatches.reduce(
        (count, entry) => count + entry.selectionBuffer.reduce((total, value) => total + (value === 1 ? 1 : 0), 0),
        0,
      ),
      1,
      '所有空间分片合计只能保留一个选中逻辑模型',
    );

    batch.setSelectionMask(new Set([instances.at(-1).entityId]), 7);
    assert.equal(lastEntityBatch.selectionBuffer[lastEntityStart], 7, 'SelectionOutline ID 变化必须更新当前目标区间');
    batch.setSelectionMask(new Set(), 0);
    assert.ok(
      activeBatches.every((entry) => entry.selectionBuffer.every((value) => value === 0)),
      '清空选择必须只清理之前选中的分片区间',
    );

    const batchCountBeforeRepeatedUpdate = batch.batches.length;
    const activeBatchObjects = [...activeBatches];
    const matrixBuffers = new Map(activeBatches.map((entry) => [entry, entry.matrixBuffer]));
    const entityIndexBuffers = new Map(activeBatches.map((entry) => [entry, entry.entityIndexBuffer]));
    const repeatedUpdateStartedAt = performance.now();
    assert.equal(
      batch.updateEntityTransforms(Matrix.Identity(), instances),
      true,
      '相同 10k 空间布局的第二次矩阵提交必须成功',
    );
    const repeatedTransformUpdateDurationMs = performance.now() - repeatedUpdateStartedAt;
    const repeatedActiveBatches = batch.batches.filter((entry) => entry.mesh.thinInstanceCount > 0);
    assert.equal(batch.batches.length, batchCountBeforeRepeatedUpdate, '相同空间布局不得继续创建新批次 Mesh');
    assert.deepEqual(repeatedActiveBatches, activeBatchObjects, '相同空间布局必须复用原有分片 Mesh');
    assert.equal(
      repeatedActiveBatches.reduce((total, entry) => total + entry.mesh.thinInstanceCount, 0),
      BATCH_ENTITY_COUNT,
      '重复更新后所有空间分片的实例总数仍必须等于 10k',
    );
    assert.ok(
      repeatedActiveBatches.every((entry) => entry.matrixBuffer === matrixBuffers.get(entry)),
      '相同空间布局必须复用每个分片的矩阵 Float32Array',
    );
    assert.ok(
      repeatedActiveBatches.every((entry) => entry.entityIndexBuffer === entityIndexBuffers.get(entry)),
      '相同空间布局必须复用每个分片的实体索引 Uint32Array',
    );
    batch.setSelectionMask(new Set([instances[0].entityId]), 9);
    assert.ok(
      repeatedActiveBatches.every((entry) => entry.selectionBuffer === initialSelectionBuffers.get(entry)),
      '重复 Transform 后必须继续复用每个分片的选择 Float32Array',
    );

    const groupCamera = new FreeCamera(
      'large-group-preview-camera',
      new Vector3(100, 50, -500),
      scene,
    );
    groupCamera.setTarget(new Vector3(100, 0, 25));
    groupCamera.fov = 1.5;
    groupCamera.minZ = 0.1;
    groupCamera.maxZ = 5_000;
    scene.activeCamera = groupCamera;
    scene.render();

    const readEntityTranslation = (entityId) => {
      const entityIndex = batch.getEntityIds().indexOf(entityId);
      for (const entry of batch.batches) {
        const sourceEntityIndexes = entry.sourceEntityIndexBuffer;
        const sourceMatrices = entry.sourceMatrixBuffer;
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
    };
    const groupBaselineFirst = readEntityTranslation(instances[0].entityId);
    const groupBaselineLast = readEntityTranslation(instances.at(-1).entityId);
    const groupBatchObjects = [...batch.batches];
    const groupMatrixBuffers = new Map(batch.batches.map((entry) => [entry, entry.matrixBuffer]));
    const groupSourceMatrixBuffers = new Map(batch.batches.map((entry) => [entry, entry.sourceMatrixBuffer]));
    const groupSelectionBuffers = new Map(batch.batches.map((entry) => [entry, entry.selectionBuffer]));
    const groupEntityIndexBuffers = new Map(batch.batches.map((entry) => [entry, entry.entityIndexBuffer]));
    const groupSourceEntityIndexBuffers = new Map(batch.batches.map((entry) => [entry, entry.sourceEntityIndexBuffer]));
    const groupVisibleSourceIndexBuffers = new Map(batch.batches.map((entry) => [entry, entry.visibleSourceIndexBuffer]));
    const groupRangeStartBuffers = new Map(batch.batches.map((entry) => [entry, entry.entityInstanceRangeStarts]));
    const groupRangeCountBuffers = new Map(batch.batches.map((entry) => [entry, entry.entityInstanceRangeCounts]));
    const groupGeometries = new Map(batch.batches.map((entry) => [entry, entry.mesh.geometry]));
    const groupEntityIds = new Set(instances.map((instance) => instance.entityId));
    const groupPreviewStartedAt = performance.now();
    assert.equal(batch.beginEntityTranslationPreview(groupEntityIds), true, '10k 逻辑模型必须建立单次组移动矩阵基线');
    assert.ok(
      batch.translationPreviewSession.batches.every((entry) => entry.sourceInstanceIndexSet instanceof Set),
      '10k 预览必须在会话开始时缓存目标 source index 集合，拖动帧不得重复构建',
    );
    assert.equal(
      batch.updateEntityTranslationPreview({ x: 7, y: -3, z: 11 }),
      true,
      '10k 逻辑模型必须按同一绝对 delta 完成运行时预览',
    );
    const groupTranslationPreviewDurationMs = performance.now() - groupPreviewStartedAt;
    assert.deepEqual(
      readEntityTranslation(instances[0].entityId),
      { x: groupBaselineFirst.x + 7, y: groupBaselineFirst.y - 3, z: groupBaselineFirst.z + 11 },
      '10k 组移动必须更新首个逻辑实体',
    );
    assert.deepEqual(
      readEntityTranslation(instances.at(-1).entityId),
      { x: groupBaselineLast.x + 7, y: groupBaselineLast.y - 3, z: groupBaselineLast.z + 11 },
      '10k 组移动必须更新最后一个逻辑实体',
    );
    assert.deepEqual(batch.batches, groupBatchObjects, '10k 组移动不得创建或替换空间批次');
    assert.ok(batch.batches.every((entry) => entry.matrixBuffer === groupMatrixBuffers.get(entry)), '10k 组移动必须复用矩阵缓冲');
    assert.ok(batch.batches.every((entry) => entry.sourceMatrixBuffer === groupSourceMatrixBuffers.get(entry)), '10k 组移动必须复用完整源矩阵缓冲');
    assert.ok(batch.batches.every((entry) => entry.selectionBuffer === groupSelectionBuffers.get(entry)), '10k 组移动必须复用选择缓冲');
    assert.ok(batch.batches.every((entry) => entry.entityIndexBuffer === groupEntityIndexBuffers.get(entry)), '10k 组移动必须复用实体索引缓冲');
    assert.ok(batch.batches.every((entry) => entry.sourceEntityIndexBuffer === groupSourceEntityIndexBuffers.get(entry)), '10k 组移动必须复用完整实体索引缓冲');
    assert.ok(batch.batches.every((entry) => entry.visibleSourceIndexBuffer === groupVisibleSourceIndexBuffers.get(entry)), '10k 组移动必须复用可见索引缓冲');
    assert.ok(batch.batches.every((entry) => entry.entityInstanceRangeStarts === groupRangeStartBuffers.get(entry)), '10k 稳定可见布局不得重建范围起点缓冲');
    assert.ok(batch.batches.every((entry) => entry.entityInstanceRangeCounts === groupRangeCountBuffers.get(entry)), '10k 稳定可见布局不得重建范围计数缓冲');
    assert.ok(batch.batches.every((entry) => entry.mesh.geometry === groupGeometries.get(entry)), '10k 组移动不得替换原 Geometry');
    assert.equal(
      batch.updateEntityTranslationPreview({ x: 8, y: -2, z: 10 }),
      true,
      '10k 第二帧组移动必须继续按绝对 delta 更新',
    );
    assert.ok(batch.batches.every((entry) => entry.entityInstanceRangeStarts === groupRangeStartBuffers.get(entry)), '10k 连续拖动帧必须持续复用范围起点缓冲');
    assert.ok(batch.batches.every((entry) => entry.entityInstanceRangeCounts === groupRangeCountBuffers.get(entry)), '10k 连续拖动帧必须持续复用范围计数缓冲');
    batch.endEntityTranslationPreview(true);
    assert.deepEqual(readEntityTranslation(instances[0].entityId), groupBaselineFirst, '取消 10k 预览必须恢复首实体基线');
    assert.deepEqual(readEntityTranslation(instances.at(-1).entityId), groupBaselineLast, '取消 10k 预览必须恢复末实体基线');

    return {
      entityCount: BATCH_ENTITY_COUNT,
      batchMeshCount: activeBatches.length,
      thinInstanceCount: totalThinInstanceCount,
      maxPartitionThinInstances: Math.max(...activeBatches.map((entry) => entry.mesh.thinInstanceCount)),
      maxPartitionBoundsXMeters,
      maxPartitionBoundsZMeters,
      transformUpdateDurationMs,
      repeatedTransformUpdateDurationMs,
      selectionUpdateDurationMs,
      matrixBufferReused: true,
      entityIndexBufferReused: true,
      selectionBufferReused: true,
      groupTranslationPreviewEntityCount: BATCH_ENTITY_COUNT,
      groupTranslationPreviewDurationMs,
      groupTranslationBuffersReused: true,
      groupTranslationGeometryPreserved: true,
    };
  } finally {
    selectionLayer?.dispose();
    batch.dispose();
    scene.dispose();
    engine.dispose();
  }
}

/** 验证相机移动时只提交视锥内实例，并完整保留逻辑实体、拾取和选择映射。 */
function verifyThinInstanceFrustumCompaction(EntityArrayThinInstanceBatch) {
  const engine = new NullEngine({ renderWidth: 640, renderHeight: 480 });
  const scene = new Scene(engine);
  const camera = new FreeCamera('frustum-camera', new Vector3(0, 0, -10), scene);
  camera.setTarget(Vector3.Zero());
  camera.minZ = 0.1;
  camera.maxZ = 2_000;
  scene.activeCamera = camera;
  const sourceMesh = MeshBuilder.CreateBox('frustum-source', { size: 1 }, scene);
  const batch = EntityArrayThinInstanceBatch.create('frustum-source', [sourceMesh], { interactive: true });
  assert.ok(batch, '必须创建相机视锥压缩批次');

  try {
    const instances = [
      ...Array.from({ length: 10 }, (_, index) => ({
        entityId: `NEAR-${index}`,
        transform: {
          position: { x: (index % 5) - 2, y: Math.floor(index / 5) - 0.5, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        pickable: true,
      })),
      ...Array.from({ length: 90 }, (_, index) => ({
        entityId: `FAR-${index}`,
        transform: {
          position: { x: 1_000 + (index % 10), y: Math.floor(index / 10), z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        pickable: true,
      })),
    ];
    assert.equal(batch.updateEntityTransforms(Matrix.Identity(), instances), true);
    scene.render();
    const firstMesh = batch.meshes[0];
    const nearVisibleCount = firstMesh.thinInstanceCount;
    assert.equal(nearVisibleCount, 10, '默认相机只能向 GPU 提交近处 10 个实例');
    const nearIds = Array.from({ length: nearVisibleCount }, (_, index) => (
      batch.getEntityIdForThinInstance(firstMesh, index)
    ));
    assert.ok(nearIds.every((entityId) => entityId?.startsWith('NEAR-')), '近处视锥映射不得混入远处实体');

    batch.setSelectionMask(new Set(['NEAR-0']), 3);
    assert.ok(firstMesh.thinInstanceCount > 0);
    assert.ok(batch.batches[0].selectionBuffer.includes(3), '可见选中实体必须保留 SelectionOutline ID');

    const renderMatrixBufferBeforeExpansion = batch.batches[0].matrixBuffer;
    const matrixUploadInstanceCounts = [];
    const originalThinInstanceBufferUpdated = firstMesh.thinInstanceBufferUpdated;
    firstMesh.thinInstanceBufferUpdated = function recordMatrixUploadInstanceCount(kind) {
      if (kind === 'matrix') matrixUploadInstanceCounts.push(this.thinInstanceCount);
      return originalThinInstanceBufferUpdated.call(this, kind);
    };
    try {
      camera.position.x = 1_004;
      camera.setTarget(new Vector3(1_004, 0, 0));
      scene.render();
    } finally {
      firstMesh.thinInstanceBufferUpdated = originalThinInstanceBufferUpdated;
    }
    const farVisibleCount = firstMesh.thinInstanceCount;
    assert.ok(farVisibleCount > nearVisibleCount && farVisibleCount <= 90, '相机移到远处分组后必须扩容并只提交远处可见实例');
    assert.strictEqual(
      batch.batches[0].matrixBuffer,
      renderMatrixBufferBeforeExpansion,
      '视锥可见数量扩容必须复用已有完整容量矩阵缓冲',
    );
    assert.equal(
      matrixUploadInstanceCounts.at(-1),
      farVisibleCount,
      '复用矩阵缓冲扩容时，必须先更新 thinInstanceCount 再通知 Babylon 上传全部可见矩阵',
    );
    const farIds = Array.from({ length: farVisibleCount }, (_, index) => (
      batch.getEntityIdForThinInstance(firstMesh, index)
    ));
    assert.ok(farIds.every((entityId) => entityId?.startsWith('FAR-')), '远处视锥映射不得混入近处实体');
    assert.ok(batch.batches[0].selectionBuffer.every((value) => value === 0), '离开视锥的选中实体不得污染可见选择缓冲');

    camera.position.x = 0;
    camera.setTarget(Vector3.Zero());
    scene.render();
    assert.equal(firstMesh.thinInstanceCount, 10, '返回近处相机后必须从完整源矩阵恢复 10 个实例');
    assert.ok(batch.batches[0].selectionBuffer.includes(3), '选中实体重新进入视锥后必须恢复 SelectionOutline ID');

    // 长条模型的包围球会错误覆盖视锥；OBB 必须在不误裁中心实体的前提下剔除右侧实体。
    const elongatedSource = MeshBuilder.CreateBox(
      'frustum-elongated-source',
      { width: 1, height: 100, depth: 1 },
      scene,
    );
    const elongatedBatch = EntityArrayThinInstanceBatch.create(
      'frustum-elongated-source',
      [elongatedSource],
      { interactive: true },
    );
    assert.ok(elongatedBatch, '必须创建长条模型 OBB 裁剪批次');
    try {
      assert.equal(elongatedBatch.updateEntityTransforms(Matrix.Identity(), [
        {
          entityId: 'ELONGATED-VISIBLE',
          transform: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
          },
          pickable: true,
        },
        {
          entityId: 'ELONGATED-OUTSIDE',
          transform: {
            position: { x: 20, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
          },
          pickable: true,
        },
      ]), true);
      scene.render();
      assert.equal(elongatedBatch.meshes[0].thinInstanceCount, 1, '长条模型 OBB 必须剔除包围球假相交的视锥外实例');
      assert.equal(
        elongatedBatch.getEntityIdForThinInstance(elongatedBatch.meshes[0], 0),
        'ELONGATED-VISIBLE',
        'OBB 裁剪不得误删真实可见的长条实例',
      );
    } finally {
      elongatedBatch.dispose();
      elongatedSource.dispose(false, false);
    }

    return {
      sourceInstanceCount: instances.length,
      nearVisibleCount,
      farVisibleCount,
      cameraRecullingPreservesSelection: true,
      elongatedSphereFalsePositiveRemoved: true,
    };
  } finally {
    batch.dispose();
    scene.dispose();
    engine.dispose();
  }
}


/** 验证极远景、中景和近景始终提交参数化后的原模型 Geometry，不创建任何替代载体。 */
function verifyOriginalGeometryAtAllDistances(EntityArrayThinInstanceBatch) {
  const engine = new NullEngine({ renderWidth: 640, renderHeight: 480 });
  const scene = new Scene(engine);
  const camera = new FreeCamera('original-geometry-camera', new Vector3(0, 0, -2_000), scene);
  camera.setTarget(Vector3.Zero());
  camera.minZ = 0.1;
  camera.maxZ = 5_000;
  scene.activeCamera = camera;

  const root = new TransformNode('original-parameter-root', scene);
  const mainPart = MeshBuilder.CreateBox('original-main-part', { width: 2, height: 2, depth: 2 }, scene);
  mainPart.parent = root;
  mainPart.position.x = -1;
  const generatedPart = MeshBuilder.CreateBox(
    'original-parameter-script-part',
    { width: 1, height: 3, depth: 1.5 },
    scene,
  );
  generatedPart.parent = root;
  generatedPart.position.x = 2;
  root.computeWorldMatrix(true);
  mainPart.computeWorldMatrix(true);
  generatedPart.computeWorldMatrix(true);
  const sourceGeometry = mainPart.geometry;
  const sourceMeshes = new Set([mainPart, generatedPart]);
  const batch = EntityArrayThinInstanceBatch.create('original-source', [mainPart, generatedPart], {
    interactive: true,
    sourceRootWorldMatrix: root.getWorldMatrix().clone(),
  });
  assert.ok(batch, '必须为参数化模型创建原 Geometry 矩阵批次');
  let selectionLayer = null;

  try {
    const instances = Array.from({ length: 100 }, (_, index) => ({
      entityId: `ORIGINAL-${String(index).padStart(3, '0')}`,
      transform: {
        position: { x: (index % 10) * 2 - 9, y: Math.floor(index / 10) * 2 - 9, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      pickable: true,
    }));
    assert.equal(batch.updateEntityTransforms(Matrix.Identity(), instances), true);

    const assertOriginalRepresentation = (phase) => {
      scene.render();
      assert.equal(batch.getEntityIds().length, instances.length, `${phase} 必须保留全部原模型逻辑实体`);
      assert.ok(
        batch.batches.every((entry) => sourceMeshes.has(entry.sourceMesh)),
        `${phase} 每个批次都必须绑定真实参数化源 Mesh`,
      );
      assert.ok(
        batch.meshes.every((mesh) => (
          !/screenSpaceProxy|proxy_(?:solid|frame)/i.test(mesh.name)
          && mesh.metadata?.modelArrayScreenSpaceProxy !== true
        )),
        `${phase} 不得创建 box、框架或其它替代 Geometry 载体`,
      );
      const representedEntityIds = new Set();
      for (const entry of batch.batches) {
        const sourceEntityIndexes = entry.sourceEntityIndexBuffer;
        if (!sourceEntityIndexes) continue;
        for (const entityIndex of sourceEntityIndexes) {
          const entityId = batch.getEntityIds()[entityIndex];
          if (entityId) representedEntityIds.add(entityId);
        }
      }
      assert.equal(representedEntityIds.size, instances.length, `${phase} 原模型批次不得漏掉逻辑实体`);
      assert.ok(
        instances.every((instance) => representedEntityIds.has(instance.entityId)),
        `${phase} 所有逻辑实体都必须保留原模型矩阵`,
      );
    };

    assertOriginalRepresentation('极远景');
    camera.position.z = -100;
    camera.setTarget(Vector3.Zero());
    assertOriginalRepresentation('中景');
    camera.position.z = -35;
    camera.setTarget(Vector3.Zero());
    assertOriginalRepresentation('近景');

    const selectedEntityId = instances[37].entityId;
    batch.setSelectionMask(new Set([selectedEntityId]), 9);
    const selectedActiveMeshes = batch.meshes.filter((mesh) => mesh.thinInstanceCount > 0);
    selectionLayer = new SelectionOutlineLayer('original-selection-outline', scene);
    selectionLayer.addSelection(selectedActiveMeshes);
    batch.setSelectionMask(new Set([selectedEntityId]), 9);
    const selectedEntries = batch.batches.flatMap((entry) => (
      Array.from({ length: entry.mesh.thinInstanceCount }, (_, thinInstanceIndex) => ({
        entry,
        thinInstanceIndex,
        selectionId: entry.selectionBuffer?.[thinInstanceIndex] ?? 0,
      }))
    )).filter(({ selectionId }) => selectionId === 9);
    assert.ok(selectedEntries.length > 0, '选中实体的全部原模型部件必须写入 SelectionOutline ID');
    assert.ok(
      selectedEntries.every(({ entry, thinInstanceIndex }) => (
        batch.getEntityIdForThinInstance(entry.mesh, thinInstanceIndex) === selectedEntityId
      )),
      '共享原 Geometry 时只能高亮目标逻辑实体，不能高亮同类型全部模型',
    );

    const readEntitySourceZ = (entityId) => batch.batches.flatMap((entry) => {
      const entityIndexes = entry.sourceEntityIndexBuffer;
      const matrices = entry.sourceMatrixBuffer;
      if (!entityIndexes || !matrices) return [];
      const values = [];
      for (let sourceIndex = 0; sourceIndex < entityIndexes.length; sourceIndex += 1) {
        if (batch.getEntityIds()[entityIndexes[sourceIndex]] !== entityId) continue;
        values.push(matrices[sourceIndex * 16 + 14]);
      }
      return values;
    });
    const movedEntityId = instances[0].entityId;
    const sourceZBefore = readEntitySourceZ(movedEntityId);
    const movedInstances = instances.map((instance, index) => (
      index === 0
        ? {
          ...instance,
          transform: {
            ...instance.transform,
            position: { ...instance.transform.position, z: 25 },
          },
        }
        : instance
    ));
    assert.equal(batch.updateEntityTransforms(Matrix.Identity(), movedInstances), true, 'Transform 更新后原模型矩阵必须刷新');
    const sourceZAfter = readEntitySourceZ(movedEntityId);
    assert.equal(sourceZBefore.length, 2, '移动前必须保留参数化模型两个真实部件');
    assert.equal(sourceZAfter.length, 2, '移动后必须继续保留参数化模型两个真实部件');
    assert.ok(sourceZAfter.every((value, index) => Math.abs(value - sourceZBefore[index] - 25) < 1e-6));
    assert.equal(mainPart.geometry, sourceGeometry, '矩阵批次不得销毁或替换参数脚本源 Geometry');
    assert.equal(mainPart.isDisposed(), false, '参数脚本源 Mesh 必须继续保留以支持后续重建');
    assertOriginalRepresentation('Transform 更新后');

    return {
      entityCount: instances.length,
      proxyEntityCount: 0,
      detailedEntityCount: instances.length,
      farUsesOriginalGeometry: true,
      mediumUsesOriginalGeometry: true,
      nearUsesOriginalGeometry: true,
      singleEntitySelectionOnly: true,
      parameterPartsPreserved: true,
      sourceGeometryPreserved: true,
    };
  } finally {
    selectionLayer?.dispose();
    batch.dispose();
    scene.dispose();
    engine.dispose();
  }
}

/** 验证有索引静态 Geometry 可按材质安全合并，无索引 Geometry 保持独立且具备完整绘制语义。 */
function verifyStaticMaterialMerge(EntityArrayThinInstanceBatch) {
  const engine = new NullEngine({ renderWidth: 64, renderHeight: 64 });
  const scene = new Scene(engine);
  const camera = new FreeCamera('static-merge-camera', new Vector3(0, 3, -30), scene);
  camera.setTarget(new Vector3(9, 2, -4));
  scene.activeCamera = camera;
  const root = new TransformNode('static-merge-root', scene);
  root.position.set(3, 2, -4);
  root.rotation.set(0.2, -0.35, 0.1);

  function createTriangle(name, x, material, { mirrored = false, indexed = true } = {}) {
    const mesh = new Mesh(name, scene);
    const vertexData = new VertexData();
    vertexData.positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    vertexData.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
    vertexData.tangents = [
      Math.SQRT1_2, Math.SQRT1_2, 0, 1,
      Math.SQRT1_2, Math.SQRT1_2, 0, 1,
      Math.SQRT1_2, Math.SQRT1_2, 0, 1,
    ];
    vertexData.uvs = [0, 0, 1, 0, 0, 1];
    if (indexed) vertexData.indices = [0, 1, 2];
    vertexData.applyToMesh(mesh, false);
    mesh.parent = root;
    mesh.position.x = x;
    mesh.scaling.set(mirrored ? -2 : 2, 1.5, 0.5);
    mesh.material = material;
    return mesh;
  }

  const opaqueA = new PBRMaterial('shared_chain_0', scene);
  opaqueA.albedoColor.set(0.2, 0.4, 0.6);
  opaqueA.metallic = 0.25;
  opaqueA.roughness = 0.7;
  const opaqueB = opaqueA.clone('shared_chain_1');
  const distinctOpaque = opaqueA.clone('shared_chain_2');
  distinctOpaque.baseWeight = 0.5;
  const transparentA = new PBRMaterial('transparent_chain_0', scene);
  transparentA.alpha = 0.5;
  const transparentB = transparentA.clone('transparent_chain_1');
  const sourceMeshes = [
    createTriangle('opaque-a', 0, opaqueA),
    createTriangle('opaque-b', 2, opaqueB, { mirrored: true }),
    createTriangle('opaque-distinct', 4, distinctOpaque),
    createTriangle('transparent-a', 6, transparentA),
    createTriangle('transparent-b', 8, transparentB),
    createTriangle('unindexed-a', 10, opaqueA, { indexed: false }),
    createTriangle('unindexed-b', 12, opaqueB, { indexed: false }),
  ];
  root.computeWorldMatrix(true);
  const sourceVertexCount = sourceMeshes.reduce((total, mesh) => total + mesh.getTotalVertices(), 0);
  const sourceIndexCount = sourceMeshes.reduce((total, mesh) => total + mesh.getTotalIndices(), 0);
  const batch = EntityArrayThinInstanceBatch.create('static-merge-source', sourceMeshes, {
    interactive: true,
    mergeStaticMeshesByMaterial: true,
    sourceRootWorldMatrix: root.getWorldMatrix().clone(),
  });
  assert.ok(batch, '静态材质合并批次必须创建成功');

  try {
    assert.equal(batch.meshes.length, 6, '两个等价有索引不透明材质应合并，视觉属性不同、透明和无索引 Mesh 必须保持独立');
    assert.equal(
      batch.meshes.reduce((total, mesh) => total + mesh.getTotalVertices(), 0),
      sourceVertexCount,
      '材质合并不得减少任何顶点',
    );
    assert.equal(
      batch.meshes.reduce((total, mesh) => total + mesh.getTotalIndices(), 0),
      sourceIndexCount,
      '材质合并不得减少任何索引',
    );
    const mergedOpaque = batch.meshes.find((mesh) => (
      mesh.material?.alpha === 1
      && mesh.getTotalVertices() === 6
      && mesh.getTotalIndices() === 6
    ));
    assert.ok(mergedOpaque, '必须生成包含两个有索引三角形的单一不透明载体');
    assert.equal(mergedOpaque.isUnIndexed, false, '有索引合并载体不得误标记为无索引绘制');
    assert.equal(mergedOpaque.subMeshes.length, 1, '有索引合并载体必须具备全局 SubMesh');
    const normals = mergedOpaque.getVerticesData('normal');
    assert.ok(normals && normals.length === 18, '合并载体必须保留全部法线');
    for (let offset = 0; offset < normals.length; offset += 3) {
      const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
      assert.ok(Math.abs(length - 1) <= 1e-5, '非均匀缩放后的法线必须保持单位长度');
    }
    const tangents = mergedOpaque.getVerticesData('tangent');
    assert.ok(tangents && tangents.length === 24, '合并载体必须保留全部切线和 handedness');
    const tangentRows = Array.from({ length: tangents.length / 4 }, (_, index) => tangents.slice(index * 4, index * 4 + 4));
    assert.ok(
      tangentRows.some(([x, y, , w]) => Math.abs(x - 0.8) <= 1e-5 && Math.abs(y - 0.6) <= 1e-5 && w === 1),
      '非均匀正缩放必须按线性模型矩阵变换切线',
    );
    assert.ok(
      tangentRows.some(([x, y, , w]) => Math.abs(x + 0.8) <= 1e-5 && Math.abs(y - 0.6) <= 1e-5 && w === -1),
      '镜像缩放必须同时变换切线方向并翻转 handedness',
    );

    const unindexedMeshes = batch.meshes.filter((mesh) => mesh.getTotalIndices() === 0);
    assert.equal(unindexedMeshes.length, 2, '不同 Geometry 的无索引网格不得跨 Geometry 合并');
    assert.ok(
      unindexedMeshes.every((mesh) => (
        mesh.isUnIndexed === true
        && mesh.subMeshes.length === 1
        && mesh.subMeshes[0].verticesStart === 0
        && mesh.subMeshes[0].verticesCount === mesh.getTotalVertices()
      )),
      '无索引批次必须保留 isUnIndexed 和覆盖全部顶点的 SubMesh',
    );

    const instances = [
      {
        entityId: 'static-merge-source',
        transform: {
          position: { x: 3, y: 2, z: -4 },
          rotation: { x: 0.2, y: -0.35, z: 0.1 },
          scale: { x: 1, y: 1, z: 1 },
        },
        pickable: true,
      },
      {
        entityId: 'static-merge-copy',
        transform: {
          position: { x: 13, y: 2, z: -4 },
          rotation: { x: 0.2, y: -0.35, z: 0.1 },
          scale: { x: 1, y: 1, z: 1 },
        },
        pickable: true,
      },
    ];
    assert.equal(batch.updateEntityTransforms(root.getWorldMatrix().clone(), instances), true);
    assert.ok(batch.meshes.every((mesh) => mesh.thinInstanceCount === 2), '每个合并载体必须只提交两个逻辑实体矩阵');
    assert.equal(batch.getEntityIdForThinInstance(mergedOpaque, 0), 'static-merge-source');
    assert.equal(batch.getEntityIdForThinInstance(mergedOpaque, 1), 'static-merge-copy');
    assert.doesNotThrow(() => scene.render(), '有索引合并与无索引独立批次必须能够共同渲染');

    return {
      sourceMeshCount: sourceMeshes.length,
      batchMeshCount: batch.meshes.length,
      sourceVertexCount,
      batchVertexCount: batch.meshes.reduce((total, mesh) => total + mesh.getTotalVertices(), 0),
      sourceIndexCount,
      batchIndexCount: batch.meshes.reduce((total, mesh) => total + mesh.getTotalIndices(), 0),
      mergedIndexedOpaqueMeshes: 2,
      preservedUnindexedMeshes: unindexedMeshes.length,
      visuallyDistinctOpaqueFallbackMeshes: 1,
      transparentFallbackMeshes: 2,
    };
  } finally {
    batch.dispose();
    root.dispose();
    opaqueA.dispose();
    opaqueB.dispose();
    distinctOpaque.dispose();
    transparentA.dispose();
    transparentB.dispose();
    scene.dispose();
    engine.dispose();
  }
}

/** 验证脚本生成的同 Geometry 叶 Mesh 只保留一份顶点，同时逐叶矩阵和逻辑实体映射完整。 */
function verifyRepeatedStaticGeometryMatrixAggregation(EntityArrayThinInstanceBatch) {
  const engine = new NullEngine({ renderWidth: 64, renderHeight: 64 });
  const scene = new Scene(engine);
  const root = new TransformNode('repeated-geometry-root', scene);
  const source = MeshBuilder.CreateBox('repeated-geometry-source', { size: 1 }, scene);
  source.parent = root;
  const material = new PBRMaterial('repeated-geometry-material', scene);
  source.material = material;
  const leaves = [source];
  for (let index = 1; index < 4; index += 1) {
    const instance = source.createInstance(`repeated-geometry-leaf-${index}`);
    instance.parent = root;
    instance.position.x = index * 10;
    leaves.push(instance);
  }
  root.computeWorldMatrix(true);
  const batch = EntityArrayThinInstanceBatch.create('repeated-geometry-entity', leaves, {
    interactive: true,
    mergeStaticMeshesByMaterial: true,
    sourceRootWorldMatrix: root.getWorldMatrix().clone(),
  });
  assert.ok(batch, '重复 Geometry 矩阵聚合批次必须创建成功');

  try {
    assert.equal(batch.sources.length, 1, '四个同 Geometry 叶 Mesh 必须聚合为一个 Geometry 源');
    assert.equal(batch.sources[0].sourceMeshes.length, 4, '聚合源必须保留四个叶 Mesh 的相对矩阵');
    assert.equal(batch.meshes.length, 1, '小规模重复 Geometry 不得增加额外 Draw Call');
    assert.equal(batch.meshes[0].getTotalVertices(), source.getTotalVertices(), 'GPU 只应保留一份源 Geometry 顶点');

    const logicalEntities = [
      {
        entityId: 'REPEATED-A',
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        pickable: true,
      },
      {
        entityId: 'REPEATED-B',
        transform: {
          position: { x: 100, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        pickable: true,
      },
    ];
    assert.equal(batch.updateEntityTransforms(root.getWorldMatrix().clone(), logicalEntities), true);
    assert.equal(batch.meshes[0].thinInstanceCount, 8, '四个叶矩阵乘两个逻辑实体必须产生八个完整实例');
    const positions = batch.meshes[0].thinInstanceGetWorldMatrices()
      .slice(0, batch.meshes[0].thinInstanceCount)
      .map((matrix) => matrix.getTranslation().x);
    assert.deepEqual(positions, [0, 10, 20, 30, 100, 110, 120, 130], '叶矩阵与逻辑实体 Transform 必须正确组合');
    assert.deepEqual(
      Array.from({ length: 8 }, (_, index) => batch.getEntityIdForThinInstance(batch.meshes[0], index)),
      ['REPEATED-A', 'REPEATED-A', 'REPEATED-A', 'REPEATED-A', 'REPEATED-B', 'REPEATED-B', 'REPEATED-B', 'REPEATED-B'],
      '拾取映射必须把每个叶实例还原到所属逻辑模型',
    );
    return {
      sourceLeafCount: leaves.length,
      geometrySourceCount: batch.sources.length,
      logicalEntityCount: logicalEntities.length,
      thinInstanceCount: batch.meshes[0].thinInstanceCount,
      geometryStoredOnce: true,
    };
  } finally {
    batch.dispose();
    root.dispose();
    material.dispose();
    scene.dispose();
    engine.dispose();
  }
}

/** 构造性能摘要夹具，验证报告聚合字段不会因空 GPU 计数或 Long Task 丢失。 */
function verifyPerformanceSummary(summarizeScenePerformance) {
  const runtime = {
    fullSyncCount: 1,
    selectionSyncCount: 2,
    lastFullSyncDurationMs: 3,
    maxFullSyncDurationMs: 4,
    lastSelectionSyncDurationMs: 0.2,
    maxSelectionSyncDurationMs: 0.4,
    lastSelectionChangedEntityCount: 1,
  };
  const editThinInstancePlan = {
    planCount: 1,
    lastDurationMs: 5,
    maxDurationMs: 5,
    entityCount: 10_000,
    groupCount: 1,
    thinInstanceEntityCount: 9_999,
  };
  const snapshots = [
    { fps: 60, frameTimeMs: 16, gpuFrameTimeMs: 5, drawCalls: 100, activeMeshes: 80, longTaskCount: 0, longTaskDurationMs: 0 },
    { fps: 48, frameTimeMs: 22, gpuFrameTimeMs: null, drawCalls: 140, activeMeshes: 90, longTaskCount: 1, longTaskDurationMs: 55 },
    { fps: 55, frameTimeMs: 18, gpuFrameTimeMs: 7, drawCalls: 120, activeMeshes: 85, longTaskCount: 2, longTaskDurationMs: 80 },
  ].map((snapshot, index) => ({
    sampledAt: new Date(index * 1_000).toISOString(),
    renderTimeMs: snapshot.frameTimeMs - 2,
    activeMeshesEvaluationMs: 1,
    shaderCompilationMs: 0,
    totalMeshes: 100,
    totalVertices: 1_000,
    thinInstances: 10_000,
    activeThinInstances: 8_000 + index * 1_000,
    estimatedActiveVertexInvocations: 1_000_000 + index * 500_000,
    estimatedActiveTriangleInvocations: 500_000 + index * 250_000,
    frustumVisibleThinInstances: 4_000 + index * 500,
    estimatedFrustumVisibleVertexInvocations: 500_000 + index * 250_000,
    estimatedFrustumVisibleTriangleInvocations: 250_000 + index * 125_000,
    topActiveGpuWorkloads: [],
    runtime,
    editThinInstancePlan,
    ...snapshot,
  }));
  const summary = summarizeScenePerformance(snapshots);
  assert.equal(summary.sampleCount, 3);
  assert.equal(summary.minimumFps, 48);
  assert.equal(summary.p95FrameTimeMs, 22);
  assert.equal(summary.maximumGpuFrameTimeMs, 7);
  assert.equal(summary.maximumDrawCalls, 140);
  assert.equal(summary.maximumActiveThinInstances, 10_000);
  assert.equal(summary.maximumEstimatedActiveVertexInvocations, 2_000_000);
  assert.equal(summary.maximumEstimatedActiveTriangleInvocations, 1_000_000);
  assert.equal(summary.longTaskCount, 3);
  assert.equal(summary.longTaskDurationMs, 135);
  return summary;
}

/** 静态约束 React 调用链：选区 effect 不得重新依赖或调用完整 sync。 */
async function verifySceneViewWiring() {
  const [layoutSource, panelSource, toolbarSource, monitorSource, batchSource, runtimeSource] = await Promise.all([
    readFile(EDITOR_LAYOUT_PATH, 'utf8'),
    readFile(SCENE_VIEW_PANEL_PATH, 'utf8'),
    readFile(TOOLBAR_PATH, 'utf8'),
    readFile(PERFORMANCE_MONITOR_PATH, 'utf8'),
    readFile(ENTITY_ARRAY_BATCH_PATH, 'utf8'),
    readFile(SCENE_RUNTIME_PATH, 'utf8'),
  ]);
  const fullSyncStart = panelSource.indexOf('/** 参数值变化走单实体同步');
  const selectionSyncStart = panelSource.indexOf('/** Hierarchy 选区变化只刷新目标表现');
  assert.ok(fullSyncStart >= 0 && selectionSyncStart > fullSyncStart, 'SceneView 必须拆分内容与选择 effect');

  const fullSyncBlock = panelSource.slice(fullSyncStart, selectionSyncStart);
  const fullSyncDependencies = fullSyncBlock.slice(fullSyncBlock.lastIndexOf('}, ['));
  assert.match(
    fullSyncBlock,
    /runtime\.syncModelParameters\([\s\S]*?editRuntimeSceneDocument,[\s\S]*?modelParameterSyncEntityId,[\s\S]*?hierarchySelectionIds[\s\S]*?\)/,
    '参数 effect 必须调用单实体参数同步',
  );
  assert.match(fullSyncBlock, /runtime\.sync\(editRuntimeSceneDocument, useEditorStore\.getState\(\)\.hierarchySelectionIds\)/, '其它内容变化必须保留完整同步和完整多选');
  assert.match(fullSyncBlock, /gizmo\.cancelActiveGroupDrag\(\)/, '内容 effect 只能取消过期的选区群组拖动');
  assert.doesNotMatch(fullSyncBlock, /gizmo\.cancelActiveDrag\(\)/, '普通实体预览写入文档时不得被内容 effect 打断');
  assert.doesNotMatch(fullSyncDependencies, /selectedEntityId[,\]]/, '完整同步依赖不得包含纯选择字段');

  const selectionEffectStart = panelSource.indexOf('  useEffect(() => {', selectionSyncStart);
  const selectionSyncEnd = panelSource.indexOf('  useEffect(() => {', selectionEffectStart + 20);
  const selectionSyncBlock = panelSource.slice(selectionSyncStart, selectionSyncEnd);
  assert.match(selectionSyncBlock, /runtime\.syncSelection\(editRuntimeSceneDocument, hierarchySelectionIds\)/, '编辑态选区 effect 必须用完整多选调用专用同步');
  assert.match(selectionSyncBlock, /gizmo\.cancelActiveGroupDrag\(\)/, '选区 effect 只能主动取消选区群组预览');
  assert.doesNotMatch(selectionSyncBlock, /gizmo\.cancelActiveDrag\(\)/, '普通实体拖动不得因预览文档引用变化被选区 effect 打断');
  assert.doesNotMatch(selectionSyncBlock, /runtime\.sync\(/, '选区 effect 不得回退完整同步');
  const selectionSyncDependencies = selectionSyncBlock.slice(selectionSyncBlock.lastIndexOf('}, ['));
  assert.match(
    selectionSyncDependencies,
    /hierarchySelectionIds/,
    '纯 Hierarchy 多选范围变化必须显式取消拖动并重新绑定组 Gizmo',
  );
  assert.match(
    panelSource,
    /\}, \[sceneDocument\.entityIds, sceneDocument\.entities\]\);/,
    '编辑态 thinInstance 分组只能依赖实体表和顺序，不得依赖 selectedEntityId',
  );
  assert.match(panelSource, /ScenePerformanceMonitor/, 'SceneView 必须启用独立性能监控器');
  assert.match(panelSource, /复制最近一分钟报告/, 'HUD 必须提供可复制性能报告');
  assert.match(
    layoutSource,
    /const \[performanceHudVisible, setPerformanceHudVisible\] = useState\(true\);/,
    '编辑器必须默认显示性能 HUD 并在 Toolbar 与 Scene View 之间共享显隐状态',
  );
  assert.match(layoutSource, /performanceHudVisible=\{performanceHudVisible\}/, 'EditorLayout 必须向 Toolbar 传递显隐状态');
  assert.match(layoutSource, /onSetPerformanceHudVisible=\{setPerformanceHudVisible\}/, 'EditorLayout 必须接收 Toolbar 显隐操作');
  assert.match(layoutSource, /<SceneViewPanel performanceHudVisible=\{performanceHudVisible\} \/>/, 'Scene View 必须使用 Toolbar 控制的显隐状态');
  assert.match(toolbarSource, /aria-label="性能监控"/, 'Toolbar 必须提供性能监控显隐入口');
  assert.match(toolbarSource, /checked=\{props\.performanceHudVisible\}/, 'Toolbar 必须反映性能监控当前显隐状态');
  assert.match(toolbarSource, /props\.onSetPerformanceHudVisible\(event\.target\.checked\)/, 'Toolbar 必须切换性能监控显隐状态');
  assert.match(panelSource, /performanceSnapshot && props\.performanceHudVisible/, 'Scene View 必须按 Toolbar 状态显示或隐藏 HUD');
  assert.doesNotMatch(panelSource, /隐藏性能监控|显示性能监控/, '显隐入口不得继续留在 Scene View HUD 内');
  assert.match(monitorSource, /const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;/, 'React 性能 HUD 最多每秒更新一次');
  assert.match(monitorSource, /const MAX_HISTORY_SAMPLES = 60;/, '性能报告必须保持最近一分钟有界历史');
  assert.match(monitorSource, /estimatedActiveVertexInvocations/, '性能报告必须估算 Active Mesh 的 GPU 顶点调用量');
  assert.match(monitorSource, /frustumVisibleThinInstances/, '性能报告必须估算批次内真正进入视锥的 thinInstance 数量');
  assert.match(panelSource, /GPU vertex calls/, '展开 HUD 必须显示 GPU 顶点调用估算');
  assert.match(panelSource, /原模型 \/ 代理/, '展开 HUD 必须明确显示原模型与代理数量');
  assert.doesNotMatch(batchSource, /ScreenSpaceProxy|getScreenSpaceProxyMetrics/, '矩阵批次不得保留代理 API');
  assert.match(runtimeSource, /const modelArrayProxyEntityCount = 0;/, 'SceneRuntime 报告必须把代理实体数固定为 0');
  assert.match(
    runtimeSource,
    /const modelArrayDetailedEntityCount = modelArrayBatchEntityCount;/,
    'SceneRuntime 必须把全部矩阵实体计入原模型 Geometry',
  );
  assert.doesNotMatch(
    batchSource,
    /screenSpaceProxyPixelThreshold|screenSpaceFrameProxyPixelThreshold|createScreenSpaceProxy|MeshBuilder\.CreateBox/,
    '矩阵批次不得保留方块、框架或其它屏幕空间代理实现',
  );
  assert.doesNotMatch(
    runtimeSource,
    /shouldEnableEntityArrayScreenSpaceProxy|MODEL_ARRAY_SCREEN_SPACE_PROXY|screenSpaceProxyPixelThreshold/,
    'SceneRuntime 正式路径不得启用或传入任何屏幕空间代理参数',
  );

  const groupCallbacksStart = panelSource.indexOf('        beginGroupTranslation:');
  const groupCallbacksEnd = panelSource.indexOf('      });', groupCallbacksStart);
  assert.ok(groupCallbacksStart >= 0 && groupCallbacksEnd > groupCallbacksStart, 'SceneView 必须接入 Hierarchy 群组 Gizmo 生命周期');
  const groupCallbacksBlock = panelSource.slice(groupCallbacksStart, groupCallbacksEnd);
  assert.match(groupCallbacksBlock, /beginFolderGroupTranslation/, '组拖动开始必须只建立运行时会话');
  assert.match(groupCallbacksBlock, /updateFolderGroupTranslation/, '组拖动过程必须只更新运行时绝对 delta');
  assert.match(groupCallbacksBlock, /commitHierarchyGroupTranslation/, '组拖动结束必须调用通用 Store 原子提交');
  assert.doesNotMatch(groupCallbacksBlock, /runtime\.sync\(|createEditModeModelThinInstancePlan/, '拖动帧不得触发完整场景同步或 thinInstance 规划');
  assert.match(
    runtimeSource,
    /onBeforeActiveMeshesEvaluationObservable\.add\(\(\) => \{\s*this\.flushGroupTranslationPreview\(\)/,
    'SceneRuntime 必须把同帧拖动事件合并到 active-mesh 评估前的一次更新',
  );
  assert.match(batchSource, /beginEntityTranslationPreview/, 'thinInstance 批次必须提供可逆组平移预览入口');
  assert.match(batchSource, /sourceInstanceIndexSet: new Set\(sourceInstanceIndexes\)/, '10k 拖动帧必须复用会话级 source index 集合');
  const translationBoundsStart = batchSource.indexOf('  private refreshTranslationPreviewBatch(');
  const translationBoundsEnd = batchSource.indexOf('  private syncTranslationPreviewMeshBounds(', translationBoundsStart);
  const translationBoundsBlock = batchSource.slice(translationBoundsStart, translationBoundsEnd);
  assert.doesNotMatch(
    translationBoundsBlock,
    /Vector3\.(?:Minimize|Maximize)|this\.cullingCenter\.(?:add|subtract)\(/,
    '10k 拖动包围盒循环不得为每个实例分配临时 Vector3',
  );

  return {
    contentAndSelectionEffectsSeparated: true,
    modelParametersUseDedicatedRuntimePath: true,
    selectionUsesDedicatedRuntimePath: true,
    planIgnoresSelectionOnlyChanges: true,
    hudCanHideAndShowFromToolbar: true,
    hudSampleIntervalMs: 1_000,
    reportHistorySamples: 60,
    originalGeometryOnly: true,
    proxyEntityCountInvariant: 0,
    folderGroupDragAvoidsFullSync: true,
    folderGroupPreviewCoalescedPerFrame: true,
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
  });
  const [planModule, batchModule, performanceModule] = await Promise.all([
    server.ssrLoadModule('/src/editor/model/editModeModelThinInstances.ts'),
    server.ssrLoadModule('/src/runtime/babylon/EntityArrayThinInstanceBatch.ts'),
    server.ssrLoadModule('/src/runtime/babylon/ScenePerformanceMonitor.ts'),
  ]);

  const planResults = LARGE_PLAN_COUNTS.map((entityCount) => (
    verifyEditModePlan(planModule.createEditModeModelThinInstancePlan, entityCount)
  ));
  const modelParameterPreviewPlan = verifyModelParameterPreviewPlan(
    planModule.createEditModeModelThinInstancePlan,
    planModule.patchEditModeModelThinInstancePlanForModelParameters,
    planModule.resolveModelParameterOnlySceneChangeEntityId,
  );
  const batchResult = verifyThinInstanceSelectionDelta(batchModule.EntityArrayThinInstanceBatch);
  const frustumCompaction = verifyThinInstanceFrustumCompaction(batchModule.EntityArrayThinInstanceBatch);
  const originalGeometry = verifyOriginalGeometryAtAllDistances(batchModule.EntityArrayThinInstanceBatch);
  const staticMaterialMerge = verifyStaticMaterialMerge(batchModule.EntityArrayThinInstanceBatch);
  const repeatedStaticGeometry = verifyRepeatedStaticGeometryMatrixAggregation(
    batchModule.EntityArrayThinInstanceBatch,
  );
  const performanceSummary = verifyPerformanceSummary(performanceModule.summarizeScenePerformance);
  const wiring = await verifySceneViewWiring();

  console.log(JSON.stringify({
    ok: true,
    planResults,
    modelParameterPreviewPlan,
    batchResult,
    frustumCompaction,
    originalGeometry,
    staticMaterialMerge,
    repeatedStaticGeometry,
    performanceSummary,
    wiring,
    timingPolicy: 'observational-no-hard-ci-threshold',
  }, null, 2));
} finally {
  await server?.close();
}
