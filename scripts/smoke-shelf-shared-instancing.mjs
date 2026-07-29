import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  FreeCamera,
  LoadAssetContainerAsync,
  Matrix,
  MeshBuilder,
  NullEngine,
  Scene,
  SceneLoader,
  SelectionOutlineLayer,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';
import { createServer } from 'vite';

const FIXTURE_ROOT = path.join(process.cwd(), 'output', 'playwright', 'shelf-assets');
const GLB_PATH = path.join(FIXTURE_ROOT, 'Shelf.glb');
const SCRIPT_PATH = path.join(FIXTURE_ROOT, 'shelf.model.ts');
const META_PATH = path.join(FIXTURE_ROOT, 'meta.json');
const TARGET_SCENE_PATH = path.resolve(process.env.ZENDING_SCENE_SOURCE ?? path.join(process.cwd(), '..', '3d-projects', 'Untitled Scene.scene(1).json'));
const MODULE_LOAD_TIMEOUT_MS = 180_000;
const EXPECTED_DENSE_BATCH_COUNT_20X100 = 18;
const EXPECTED_DENSE_THIN_INSTANCE_COUNT_20X100 = 16_674;
const EXPECTED_DENSE_RENDERABLE_MESH_COUNT_20X100 = 18;

const STAGE_TIMEOUT_MS = 180_000;

/** 输出 smoke 阶段日志，包含中文阶段名和耗时，便于定位长时间无输出卡点。 */
function logStage(message) {
  console.log(`[ShelfSmoke] ${new Date().toISOString()} ${message}`);
}

/** 为异步阶段设置明确超时；同步密集阶段会在前后日志中报告实际耗时。 */
async function withStageTimeout(name, action, timeoutMs = STAGE_TIMEOUT_MS) {
  logStage(`开始：${name}`);
  const startedAt = performance.now();
  let timeoutId;
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`阶段超时：${name} 超过 ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    logStage(`结束：${name}，耗时 ${Math.round(performance.now() - startedAt)}ms`);
  }
}

/** 包裹同步阶段并输出耗时，避免 dense 创建卡住时没有前置定位日志。 */
function withSyncStage(name, action) {
  logStage(`开始：${name}`);
  const startedAt = performance.now();
  try {
    return action();
  } finally {
    logStage(`结束：${name}，耗时 ${Math.round(performance.now() - startedAt)}ms`);
  }
}


/** 在限定时间内通过 Vite SSR 加载 TypeScript 运行时模块。 */
async function loadSsrModuleWithTimeout(server, modulePath) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule(modulePath),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`加载模块超时：${modulePath}`)), MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** 从模型参数元数据读取默认参数值。 */
function createDefaultParameterValues(metadata) {
  return Object.fromEntries(
    (metadata.modelParameters?.parameters ?? []).map((parameter) => [parameter.key, parameter.defaultValue]),
  );
}

/** 从目标场景读取当前真实 20x100 双深 Shelf 参数，避免专项 smoke 使用与现场无关的尺寸组合。 */
async function readTargetSceneDenseShelfValues(metadata) {
  const document = JSON.parse(await fs.readFile(TARGET_SCENE_PATH, 'utf8'));
  const scene = document?.scene;
  assert.ok(scene?.entityIds && scene?.entities, `目标场景缺少 SceneDocument：${TARGET_SCENE_PATH}`);
  const candidates = [];
  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    const modelAsset = entity?.components?.modelAsset;
    const source = String(modelAsset?.sourcePath ?? modelAsset?.sourceUrl ?? '').replace(/\\/g, '/');
    const values = modelAsset?.parameterValues;
    if (!/\/Models\/Shelf\/Shelf\.glb$/i.test(source) || !values) continue;
    if (Number(values.layerCount) !== 20 || Number(values.columnCount) !== 100 || values.doubleDeepEnabled !== true) continue;
    candidates.push(values);
  }
  assert.ok(candidates.length > 0, `目标场景未找到 20x100 双深 Shelf：${TARGET_SCENE_PATH}`);
  const signatures = new Map(candidates.map((values) => [JSON.stringify(values, Object.keys(values).sort()), values]));
  assert.equal(signatures.size, 1, '目标场景中的 20x100 双深 Shelf 参数组合必须唯一');
  return { ...createDefaultParameterValues(metadata), ...signatures.values().next().value };
}

/** 把实例参数写入脚本 metadata，复刻 SceneRuntime 的脚本注入边界。 */
function syncScriptMetadata(contentRoot, metadata, values, assetCode) {
  const scripts = (metadata.parameterScripts ?? []).map((script) => {
    const clonedScript = JSON.parse(JSON.stringify(script));
    const scriptValues = clonedScript.values && typeof clonedScript.values === 'object'
      ? { ...clonedScript.values }
      : {};
    for (const [key, value] of Object.entries(values)) {
      const previous = scriptValues[key] && typeof scriptValues[key] === 'object' ? scriptValues[key] : {};
      scriptValues[key] = { ...previous, value };
    }
    clonedScript.values = scriptValues;
    return clonedScript;
  });

  contentRoot.metadata = {
    ...(contentRoot.metadata ?? {}),
    assetCode,
    modelAsset: { assetCode },
    scripts,
  };
}

/** 判断 Mesh 自身及其到 contentRoot 的祖先链均处于启用状态。 */
function isEnabledWithinContentRoot(mesh, contentRoot) {
  let current = mesh;
  while (current && current !== contentRoot) {
    if (current.isEnabled?.(false) === false) return false;
    current = current.parent;
  }
  return current === contentRoot;
}

/** 收集实例根节点下真正可见且具有真实顶点的活动 Mesh。 */
function collectRenderableMeshes(contentRoot) {
  return contentRoot.getChildMeshes(false).filter((mesh) => (
    !mesh.isDisposed()
    && mesh.getTotalVertices() > 0
    && mesh.isVisible !== false
    && Number(mesh.visibility ?? 1) > 0
    && isEnabledWithinContentRoot(mesh, contentRoot)
  ));
}

/** 收集高密度 Shelf 批次 Mesh，验证 thin-instance 路径是否启用。 */
function collectDenseBatchMeshes(contentRoot) {
  return contentRoot.getChildMeshes(false).filter((mesh) => (
    !mesh.isDisposed() && mesh.metadata?.denseShelfBatch === true
  ));
}

/** 计算 Shelf 在实体根米空间中的整体包围盒，确保 thin-instance 空间展开能被断言覆盖。 */
function collectShelfMeterBounds(contentRoot) {
  const entityRoot = contentRoot.parent;
  const entityRootWorld = entityRoot?.computeWorldMatrix?.(true) ?? entityRoot?.getWorldMatrix?.();
  const inverseEntityRootWorld = entityRootWorld?.clone?.();
  assert.ok(inverseEntityRootWorld?.invert, 'Shelf 空间断言需要可逆实体根世界矩阵');
  inverseEntityRootWorld.invert();

  let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  const meshes = collectRenderableMeshes(contentRoot);
  for (const mesh of meshes) {
    mesh.computeWorldMatrix?.(true);
    if (mesh.metadata?.denseShelfBatch === true) {
      mesh.thinInstanceRefreshBoundingInfo?.(true);
    } else {
      mesh.refreshBoundingInfo?.(true, true);
    }
    const corners = mesh.getBoundingInfo?.().boundingBox?.vectorsWorld ?? [];
    for (const corner of corners) {
      const meterPoint = Vector3.TransformCoordinates(corner, inverseEntityRootWorld);
      minimum = Vector3.Minimize(minimum, meterPoint);
      maximum = Vector3.Maximize(maximum, meterPoint);
    }
  }
  assert.ok(Number.isFinite(minimum.x) && Number.isFinite(maximum.x), 'Shelf 空间断言必须收集到有效包围盒');
  const size = maximum.subtract(minimum);
  return { minimum, maximum, size };
}

/** 断言当前支持的 20x100 双深 dense 不只是实例数正确，三个正交空间轴也必须真实展开。 */
function assertDenseShelfSpaceExpanded({ denseBounds, baselineBounds, values }) {
  const columnSpacing = Number(values.cellWidth);
  const layerSpacing = Number(values.cellHeight);
  const deepSpacing = Number(values.cellDepth) + Number(values.deepSlotGap);
  const minimumColumnGrowth = columnSpacing * Math.max(1, Number(values.columnCount) - 1) * 0.8;
  const minimumLayerGrowth = layerSpacing * Math.max(1, Number(values.layerCount) - 1) * 0.8;
  assert.ok(denseBounds.size.x > baselineBounds.size.x + minimumColumnGrowth, `${values.columnCount}列必须沿 X 轴展开，当前 X=${denseBounds.size.x.toFixed(3)}，基线 X=${baselineBounds.size.x.toFixed(3)}`);
  assert.ok(denseBounds.size.y > baselineBounds.size.y + minimumLayerGrowth, `${values.layerCount}层必须沿 Y 轴展开，当前 Y=${denseBounds.size.y.toFixed(3)}，基线 Y=${baselineBounds.size.y.toFixed(3)}`);
  assert.ok(denseBounds.size.z > baselineBounds.size.z + deepSpacing * 0.45, `双深必须沿 Z 轴展开，当前 Z=${denseBounds.size.z.toFixed(3)}，基线 Z=${baselineBounds.size.z.toFixed(3)}`);
}
/** 直接从当前连续缓冲读取 thinInstance，避免 Babylon 公共矩阵缓存返回更新前快照。 */
function readThinInstanceFinalWorldMatrix(batch, thinInstanceIndex) {
  const matrixOffset = thinInstanceIndex * 16;
  if (!batch?.matrixBuffer || matrixOffset + 16 > batch.matrixBuffer.length) return null;
  batch.mesh.computeWorldMatrix(true);
  return Matrix.FromArray(batch.matrixBuffer, matrixOffset).multiply(batch.mesh.getWorldMatrix());
}

/** 从指定 Geometry 源的完整空间分片缓冲读取逻辑实体最终世界矩阵。 */
function readModelArraySourceFinalWorldMatrix(modelArrayBatch, entityId, sourceIndex = 0) {
  const entityIndex = modelArrayBatch?.getEntityIds().indexOf(entityId) ?? -1;
  const source = modelArrayBatch?.sources?.[sourceIndex];
  if (entityIndex < 0 || !source) return null;
  for (const batch of source.batches) {
    const entityIndexes = batch.sourceEntityIndexBuffer ?? batch.entityIndexBuffer;
    const matrices = batch.sourceMatrixBuffer ?? batch.matrixBuffer;
    if (!entityIndexes || !matrices) continue;
    for (let instanceIndex = 0; instanceIndex < entityIndexes.length; instanceIndex += 1) {
      if (entityIndexes[instanceIndex] !== entityIndex) continue;
      batch.mesh.computeWorldMatrix(true);
      return Matrix.FromArray(matrices, instanceIndex * 16).multiply(batch.mesh.getWorldMatrix());
    }
  }
  return null;
}

/** 跨空间分片查找当前可见逻辑实体，验证 Babylon picking 索引映射。 */
function findVisibleModelArrayEntity(runtime, modelArrayBatch, entityId, sourceIndex = null) {
  const sources = sourceIndex === null
    ? modelArrayBatch?.sources ?? []
    : [modelArrayBatch?.sources?.[sourceIndex]].filter(Boolean);
  for (const source of sources) {
    for (const batch of source.batches) {
      for (let thinInstanceIndex = 0; thinInstanceIndex < batch.mesh.thinInstanceCount; thinInstanceIndex += 1) {
        if (runtime.readEntityIdFromMesh(batch.mesh, thinInstanceIndex) !== entityId) continue;
        return { batch, thinInstanceIndex };
      }
    }
  }
  return null;
}

/** 只按 Babylon 已提交的真实 thinInstanceCount 汇总；metadata 仅用于交叉核对。 */
function countDenseThinInstances(meshes, label = '高密度 Shelf') {
  assert.ok(meshes.length > 0, `${label} 必须包含 dense batch`);
  return meshes.reduce((sum, mesh, index) => {
    const actual = Number(mesh.thinInstanceCount);
    assert.ok(Number.isInteger(actual) && actual > 0, `${label} 第 ${index + 1} 个 dense batch 没有真实 thin instance`);
    const metadataCount = Number(mesh.metadata?.denseShelfThinInstanceCount);
    assert.equal(metadataCount, actual, `${label} 第 ${index + 1} 个 dense batch metadata 与真实数量不一致`);
    return sum + actual;
  }, 0);
}

/** 读取脚本写到参数根节点的高密度统计。 */
function readDenseMetadata(contentRoot) {
  return contentRoot.metadata?.shelfDenseBatch ?? null;
}

/** 收集 Shelf 参数脚本生成的运行态层列根节点。 */
function collectGeneratedRoots(contentRoot) {
  const scene = contentRoot.getScene();
  return scene.transformNodes.filter((node) => (
    node.isDescendantOf?.(contentRoot) && node.metadata?.generatedByParametricRuntime === true
  ));
}

/** 为一个共享模型实例创建实体根、参数脚本运行时和独立拾取 metadata。 */
async function createShelfRuntime({
  id,
  x,
  sharedInstantiation,
  metadata,
  scriptText,
  values,
  ExternalModelScriptRuntime,
  scene,
}) {
  const root = new TransformNode(`${id}_root`, scene);
  root.position.x = x;
  const contentRoot = new TransformNode(`${id}_contentRoot`, scene);
  contentRoot.parent = root;
  contentRoot.scaling.setAll(0.001);
  for (const rootNode of sharedInstantiation.entries.rootNodes) {
    rootNode.parent = contentRoot;
  }

  const modelAsset = {
    sourcePath: GLB_PATH,
    sourceUrl: 'editor-asset://Assets/Models/Shelf/Shelf.glb',
    assetCode: id,
    lengthUnit: 'millimeter',
    unitScaleToMeters: 0.001,
    scriptAssets: [{
      path: SCRIPT_PATH,
      sourceUrl: `data:text/plain;base64,${Buffer.from(scriptText).toString('base64')}`,
      name: 'shelf.model.ts',
    }],
    parameterScriptMetadata: metadata.parameterScripts,
    animationScriptMetadata: metadata.animationScripts,
    parameterConfig: metadata.modelParameters,
    parameterValues: values,
  };

  syncScriptMetadata(contentRoot, metadata, values, id);
  const runtime = new ExternalModelScriptRuntime(contentRoot, modelAsset);
  runtime.updateAssetCode(id);
  runtime.updateParameterValues(values);
  await runtime.start();
  runtime.update();

  for (const mesh of contentRoot.getChildMeshes(false)) {
    mesh.metadata = { ...(mesh.metadata ?? {}), editorEntityId: id };
  }

  return { id, root, contentRoot, runtime, sharedInstantiation, metadata, values };
}

/** 更新单个 Shelf 脚本实例参数，并保持 metadata 与注入属性一致。 */
function updateShelfRuntime(entry, values) {
  syncScriptMetadata(entry.contentRoot, entry.metadata, values, entry.id);
  entry.runtime.updateParameterValues(values);
  entry.runtime.update();
  entry.values = values;
  for (const mesh of entry.contentRoot.getChildMeshes(false)) {
    mesh.metadata = { ...(mesh.metadata ?? {}), editorEntityId: entry.id };
  }
}

/** 释放单个 Shelf 运行实例，顺序与 SceneRuntime 保持一致。 */
function disposeShelfRuntime(entry) {
  entry.runtime.dispose();
  entry.sharedInstantiation.dispose();
  entry.contentRoot.dispose();
  entry.root.dispose();
}

/** 创建 SceneRuntime 集成验证使用的最小 Shelf 实体。 */
function createSceneRuntimeShelfEntity(id, x, modelAsset, options = {}) {
  return {
    id,
    name: id,
    parentId: null,
    childrenIds: [],
    visible: options.visible ?? true,
    locked: options.locked ?? false,
    components: {
      transform: {
        position: { x, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      modelAsset: { ...modelAsset, assetCode: id },
      ...(options.modelArray ? { modelArray: options.modelArray } : {}),
      ...(options.modelArrayInstance ? { modelArrayInstance: options.modelArrayInstance } : {}),
    },
  };
}

/** 创建 SceneRuntime.sync 所需的最小场景文档。 */
function createSceneRuntimeDocument(entities, selectedEntityId = null) {
  return {
    id: 'scene_shelf_instancing_smoke',
    name: 'Shelf Instancing Smoke',
    entityIds: entities.map((entity) => entity.id),
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
    selectedEntityId,
    mqttConfig: {},
    sceneSettings: {},
  };
}

/** 等待真实 Shelf 脚本完成，并返回实体当前启用的可渲染 Mesh。 */
async function waitForSceneRuntimeEntityMeshes(scene, runtime, entityId) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const meshes = scene.meshes.filter((mesh) => (
      mesh.metadata?.editorEntityId === entityId
      && !mesh.isDisposed()
      && mesh.isEnabled(false)
      && mesh.getTotalVertices() > 0
    ));
    if (runtime.getModelMeasurement(entityId).status === 'ready' && meshes.length > 0) return meshes;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${entityId} SceneRuntime 加载可渲染 Mesh 超时`);
}

/** 比较两个逻辑实体 ID 集合，避免断言失败时打印完整 Babylon 运行时对象。 */
function hasSameEntityIds(actualEntityIds, expectedEntityIds) {
  if (actualEntityIds.length !== expectedEntityIds.length) return false;
  const expected = new Set(expectedEntityIds);
  return actualEntityIds.every((entityId) => expected.has(entityId));
}

/** 等待阵列参数组收敛到目标签名、共享宿主和完整矩阵实体集合。 */
async function waitForSceneRuntimeModelArrayParameterVariant(
  runtime,
  entityId,
  { modelAsset, telemetryBinding = null, expectedEntityIds = [entityId] },
) {
  const expectedRenderSignature = runtime.createModelArrayRenderSignature(modelAsset, telemetryBinding);
  let lastState = '尚未创建参数变体';
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const variant = runtime.modelArrayParameterVariantByEntityId?.get(entityId);
    const mappedVariants = expectedEntityIds.map((expectedEntityId) => (
      runtime.modelArrayParameterVariantByEntityId?.get(expectedEntityId)
    ));
    const sharedVariant = mappedVariants[0];
    const batchEntityIds = variant?.model?.modelArrayBatch?.getEntityIds() ?? [];
    if (
      variant
      && sharedVariant === variant
      && mappedVariants.every((mappedVariant) => mappedVariant === variant)
      && runtime.modelArrayParameterVariants?.get(variant.key) === variant
      && variant.renderSignature === expectedRenderSignature
      && variant.model.measurementReady
      && !variant.model.externalScriptStarting
      && variant.model.modelArrayBatch
      && runtime.isModelArrayBatchCurrent(variant.model, expectedRenderSignature)
      && hasSameEntityIds(batchEntityIds, expectedEntityIds)
      && runtime.getModelMeasurement(entityId).status === 'ready'
    ) {
      return variant;
    }
    lastState = [
      `mapped=${mappedVariants.filter(Boolean).length}/${expectedEntityIds.length}`,
      `shared=${Boolean(variant && mappedVariants.every((mappedVariant) => mappedVariant === variant))}`,
      `signature=${variant?.renderSignature === expectedRenderSignature}`,
      `ready=${Boolean(variant?.model?.measurementReady && !variant.model.externalScriptStarting)}`,
      `batchEntities=${batchEntityIds.length}/${expectedEntityIds.length}`,
    ].join(', ');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${entityId} 阵列参数脚本宿主收敛超时：${lastState}`);
}

/** 收集源批次及参数变体批次当前真正提交的逻辑实体覆盖。 */
function collectSceneRuntimeModelArrayCoverage(runtime, sourceEntityId) {
  const entries = [];
  const sourceModel = runtime.models?.get(sourceEntityId);
  const sourceBatch = sourceModel?.modelArrayBatch;
  if (sourceBatch) {
    entries.push({ kind: 'base', batch: sourceBatch, sourceSignature: sourceModel.modelArraySourceSignature });
  }
  for (const variant of runtime.modelArrayParameterVariants?.values?.() ?? []) {
    if (variant.sourceEntityId === sourceEntityId && variant.model.modelArrayBatch) {
      entries.push({
        kind: 'variant',
        batch: variant.model.modelArrayBatch,
        sourceSignature: variant.model.modelArraySourceSignature,
      });
    }
  }

  const seenBatches = new Set();
  const entityCoverageCounts = new Map();
  const entitySourceSignatures = new Map();
  const batchSummaries = [];
  let activeBatchCount = 0;
  let renderableBatchCount = 0;
  let visibleThinInstanceCount = 0;
  for (const entry of entries) {
    if (seenBatches.has(entry.batch)) continue;
    seenBatches.add(entry.batch);
    const entityIds = [...entry.batch.getEntityIds()];
    const coveredEntityIndexes = new Set();
    let liveMeshCount = 0;
    let renderableMeshCount = 0;
    let sourceMatrixCount = 0;
    let committedMatrixCount = 0;
    for (const source of entry.batch.sources ?? []) {
      for (const batch of source.batches ?? []) {
        if (batch.mesh.isDisposed()) continue;
        liveMeshCount += 1;
        if (batch.mesh.isEnabled(false) && batch.mesh.thinInstanceCount > 0) {
          renderableMeshCount += 1;
          visibleThinInstanceCount += batch.mesh.thinInstanceCount;
        }
        const sourceEntityIndexes = batch.sourceEntityIndexBuffer;
        const renderedEntityIndexes = batch.entityIndexBuffer;
        sourceMatrixCount += sourceEntityIndexes?.length ?? 0;
        const renderedCount = Math.min(
          Math.max(0, Number(batch.mesh.thinInstanceCount) || 0),
          renderedEntityIndexes?.length ?? 0,
        );
        if (!renderedEntityIndexes || renderedCount <= 0 || !batch.mesh.isEnabled(false)) continue;
        committedMatrixCount += renderedCount;
        for (let index = 0; index < renderedCount; index += 1) {
          coveredEntityIndexes.add(renderedEntityIndexes[index]);
        }
      }
    }

    if (liveMeshCount > 0 && coveredEntityIndexes.size > 0) activeBatchCount += 1;
    if (renderableMeshCount > 0) renderableBatchCount += 1;
    for (const entityIndex of coveredEntityIndexes) {
      const entityId = entityIds[entityIndex];
      if (!entityId) continue;
      entityCoverageCounts.set(entityId, (entityCoverageCounts.get(entityId) ?? 0) + 1);
      const signatures = entitySourceSignatures.get(entityId) ?? new Set();
      signatures.add(entry.sourceSignature);
      entitySourceSignatures.set(entityId, signatures);
    }
    batchSummaries.push([
      entry.kind,
      `entities=${entityIds.length}`,
      `covered=${coveredEntityIndexes.size}`,
      `liveMeshes=${liveMeshCount}`,
      `renderableMeshes=${renderableMeshCount}`,
      `sourceMatrices=${sourceMatrixCount}`,
      `renderedMatrices=${committedMatrixCount}`,
    ].join(':'));
  }

  const activeHostMeshes = [];
  const activeMeshCollection = runtime.scene?.getActiveMeshes?.();
  const activeMeshes = new Set(
    (activeMeshCollection?.data ?? []).slice(0, activeMeshCollection?.length ?? 0),
  );
  const hostModels = [
    runtime.models?.get?.(sourceEntityId),
    ...[...(runtime.modelArrayParameterVariants?.values?.() ?? [])]
      .filter((variant) => variant.sourceEntityId === sourceEntityId)
      .map((variant) => variant.model),
  ].filter(Boolean);
  const seenHostModels = new Set();
  for (const model of hostModels) {
    if (seenHostModels.has(model)) continue;
    seenHostModels.add(model);
    for (const mesh of model.root?.getChildMeshes?.(false) ?? model.meshes ?? []) {
      if (mesh.isDisposed?.() || mesh.getTotalVertices?.() <= 0 || !activeMeshes.has(mesh)) continue;
      activeHostMeshes.push(`${mesh.name}|${mesh.uniqueId}|layer=${mesh.layerMask}`);
    }
  }

  return {
    entityCoverageCounts,
    entitySourceSignatures,
    activeBatchCount,
    renderableBatchCount,
    visibleThinInstanceCount,
    activeHostMeshes,
    batchSummaries,
  };
}

/** 每个采样帧都必须由至少一个可渲染批次无重叠地覆盖源模型和全部阵列副本。 */
function assertSceneRuntimeModelArrayCoverageFrame(
  runtime,
  sourceEntityId,
  expectedEntityIds,
  label,
  expectedRenderSignaturesByEntityId = null,
) {
  const coverage = collectSceneRuntimeModelArrayCoverage(runtime, sourceEntityId);
  const expected = new Set(expectedEntityIds);
  const coveredEntityIds = [...coverage.entityCoverageCounts.keys()];
  const missingEntityIds = expectedEntityIds.filter((entityId) => !coverage.entityCoverageCounts.has(entityId));
  const unexpectedEntityIds = coveredEntityIds.filter((entityId) => !expected.has(entityId));
  const duplicateEntityIds = coveredEntityIds.filter((entityId) => coverage.entityCoverageCounts.get(entityId) !== 1);
  const wrongSignatureEntityIds = expectedRenderSignaturesByEntityId
    ? expectedEntityIds.filter((entityId) => {
      const expectedSignatures = expectedRenderSignaturesByEntityId.get(entityId) ?? [];
      const actualSignatures = [...(coverage.entitySourceSignatures.get(entityId) ?? [])];
      return expectedSignatures.length === 0
        || actualSignatures.length !== 1
        || !expectedSignatures.some((signature) => actualSignatures[0].startsWith(
          `${signature}|representation:original-geometry|`,
        ));
    })
    : [];
  const summary = coverage.batchSummaries.join('; ') || 'none';

  assert.ok(coverage.activeBatchCount > 0, `${label}：活动阵列批次不得为 0，${summary}`);
  assert.ok(coverage.renderableBatchCount > 0, `${label}：可渲染阵列批次不得为 0，${summary}`);
  assert.ok(coverage.visibleThinInstanceCount > 0, `${label}：当前帧不得清空全部 thinInstance，${summary}`);
  assert.deepEqual(
    coverage.activeHostMeshes,
    [],
    `${label}：参数脚本宿主不得与权威阵列批次同时可见，${coverage.activeHostMeshes.join('; ') || 'none'}`,
  );
  assert.ok(
    missingEntityIds.length === 0,
    `${label}：缺失 ${missingEntityIds.length}/${expectedEntityIds.length} 个逻辑实体，示例=${missingEntityIds.slice(0, 5).join(',') || 'none'}，${summary}`,
  );
  assert.ok(
    unexpectedEntityIds.length === 0,
    `${label}：出现 ${unexpectedEntityIds.length} 个非目标逻辑实体，示例=${unexpectedEntityIds.slice(0, 5).join(',') || 'none'}，${summary}`,
  );
  assert.ok(
    duplicateEntityIds.length === 0,
    `${label}：${duplicateEntityIds.length} 个逻辑实体被旧/新批次重复覆盖，示例=${duplicateEntityIds.slice(0, 5).join(',') || 'none'}，${summary}`,
  );
  assert.ok(
    wrongSignatureEntityIds.length === 0,
    `${label}：${wrongSignatureEntityIds.length} 个逻辑实体由错误参数视觉批次承载，示例=${wrongSignatureEntityIds.slice(0, 5).join(',') || 'none'}，${summary}`,
  );
  return coverage;
}

/** 在真实渲染帧之间等待阵列换批收敛，并持续断言没有消失或重叠闪烁帧。 */
async function waitForSceneRuntimeModelArrayTransition({
  scene,
  runtime,
  sourceEntityId,
  expectedEntityIds,
  label,
  expectedRenderSignaturesByEntityId,
  isSettled,
}) {
  let minimumCoveredEntityCount = Number.POSITIVE_INFINITY;
  let maximumActiveBatchCount = 0;
  let sampleCount = 0;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const beforeRender = assertSceneRuntimeModelArrayCoverageFrame(
      runtime,
      sourceEntityId,
      expectedEntityIds,
      `${label} 第 ${attempt + 1} 帧渲染前`,
      expectedRenderSignaturesByEntityId,
    );
    minimumCoveredEntityCount = Math.min(minimumCoveredEntityCount, beforeRender.entityCoverageCounts.size);
    maximumActiveBatchCount = Math.max(maximumActiveBatchCount, beforeRender.activeBatchCount);
    sampleCount += 1;

    assert.doesNotThrow(() => scene.render(), `${label} 第 ${attempt + 1} 帧必须保持可渲染`);
    const afterRender = assertSceneRuntimeModelArrayCoverageFrame(
      runtime,
      sourceEntityId,
      expectedEntityIds,
      `${label} 第 ${attempt + 1} 帧渲染后`,
      expectedRenderSignaturesByEntityId,
    );
    minimumCoveredEntityCount = Math.min(minimumCoveredEntityCount, afterRender.entityCoverageCounts.size);
    maximumActiveBatchCount = Math.max(maximumActiveBatchCount, afterRender.activeBatchCount);
    sampleCount += 1;

    if (isSettled()) {
      return { frameCount: attempt + 1, sampleCount, minimumCoveredEntityCount, maximumActiveBatchCount };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${label} 在逐帧无闪烁观察期间未完成原子换批`);
}

/** 判断两个米制尺寸是否存在可观察差异。 */
function hasMeasurementDifference(left, right, tolerance = 1e-4) {
  if (!left || !right) return false;
  return ['x', 'y', 'z'].some((axis) => Math.abs(left[axis] - right[axis]) > tolerance);
}

/** 等待选中 Shelf 参数更新后产生更多可渲染实例 Mesh。 */
async function waitForSceneRuntimeRenderableMeshGrowth(scene, entityId, previousCount) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const meshes = scene.meshes.filter((mesh) => (
      mesh.metadata?.editorEntityId === entityId && !mesh.isDisposed() && mesh.getTotalVertices() > 0
    ));
    if (meshes.length > previousCount) return meshes;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${entityId} 保持选中修改层列参数后未生成更多实例 Mesh`);
}

/** 描述 Mesh 类型和实例来源，便于定位 SelectionOutlineLayer 的实例/非实例路径差异。 */
function describeMeshSelectionState(mesh) {
  return [
    mesh.name,
    `ctor=${mesh.constructor?.name ?? 'unknown'}`,
    `isAnInstance=${mesh.isAnInstance === true}`,
    `hasInstances=${mesh.hasInstances === true}`,
    `source=${mesh.sourceMesh?.name ?? 'none'}`,
    `selection=${mesh.instancedBuffers?.instanceSelectionId ?? 'missing'}`,
  ].join('|');
}

/** 只要求真实 InstancedMesh 写入实例选择 ID；普通 Mesh 会走 SelectionOutlineLayer 的非实例描边路径。 */
function assertInstancedMeshesHaveSelectionId(meshes, message) {
  const missingSelectionIds = meshes
    .filter((mesh) => mesh.isAnInstance === true)
    .filter((mesh) => Number(mesh.instancedBuffers?.instanceSelectionId) <= 0)
    .map(describeMeshSelectionState);
  assert.deepEqual(missingSelectionIds, [], message);
}

/** 断言选中实例涉及的 sourceMesh.instances 均具备公开 instancedBuffers 容器。 */
function assertSourceInstanceBuffersComplete(meshes, message) {
  const sourceMeshes = new Set(meshes.filter((mesh) => mesh.isAnInstance).map((mesh) => mesh.sourceMesh));
  const missing = [];
  for (const sourceMesh of sourceMeshes) {
    for (const instance of sourceMesh.instances) {
      if (!instance.instancedBuffers) {
        missing.push(`${sourceMesh.name}->${instance.name}`);
      }
    }
  }
  assert.deepEqual(missing, [], message);
}

/**
 * 压测共享矩阵实例在选择描边注册后新增/重建时的空缓冲恢复。
 * 复刻截图中的 instanceSelectionId 渲染异常，但不依赖私有 Babylon 字段。
 */
function runSelectionBufferMatrixStress({
  prepareInstancedMeshesForSelectionOutline,
  repairInstancedMeshBufferContainers,
}) {
  const stressEngine = new NullEngine();
  const stressScene = new Scene(stressEngine);
  const camera = new FreeCamera('SelectionMatrixStressCamera', new Vector3(0, 0, -10), stressScene);
  camera.setTarget(Vector3.Zero());
  stressScene.activeCamera = camera;
  const source = MeshBuilder.CreateBox('SelectionMatrixStressSource', { size: 1 }, stressScene);
  const instances = Array.from({ length: 256 }, (_, index) => source.createInstance(`SelectionMatrixStress_${index}`));
  const selectionLayer = new SelectionOutlineLayer('SelectionMatrixStressLayer', stressScene);

  try {
    prepareInstancedMeshesForSelectionOutline([instances[0]]);
    selectionLayer.addSelection([instances[0]]);

    for (let index = 1; index < instances.length; index += 1) {
      if (index % 7 === 0) {
        // 模拟参数脚本 clone/重建期间公开容器短暂为空；source 此时已经注册 instanceSelectionId。
        instances[index].instancedBuffers = null;
      }
    }
    repairInstancedMeshBufferContainers(instances.slice(1));
    assert.doesNotThrow(() => stressScene.render(), '新增矩阵实例不得因 instanceSelectionId 空缓冲中断渲染循环');

    selectionLayer.clearSelection();
    instances[128].instancedBuffers = null;
    prepareInstancedMeshesForSelectionOutline([instances[128]]);
    selectionLayer.addSelection([instances[128]]);
    assert.doesNotThrow(() => stressScene.render(), '重建选择描边后矩阵实例必须继续可渲染');
    assert.ok(instances.every((instance) => instance.isAnInstance), '压力样例必须保持 Babylon InstancedMesh 矩阵渲染');
    assert.ok(instances.every((instance) => instance.instancedBuffers), '同源全部实例都必须恢复公开缓冲容器');

    return instances.length;
  } finally {
    selectionLayer.dispose();
    source.dispose(false, false);
    stressScene.dispose();
    stressEngine.dispose();
  }
}

/** 通过真实 SceneRuntime.sync 验证共享加载、选择、锁定和删除生命周期。 */
async function runSceneRuntimeIntegration({ SceneRuntime, glbBytes, scriptText, metadata, values }) {
  const integrationEngine = new NullEngine();
  const integrationScene = new Scene(integrationEngine);
  const originalLoadAssetContainerAsync = SceneLoader.LoadAssetContainerAsync;
  let loadCount = 0;
  let sourceDisposeCount = 0;
  SceneLoader.LoadAssetContainerAsync = async () => {
    loadCount += 1;
    const container = await LoadAssetContainerAsync(glbBytes, integrationScene, {
      pluginExtension: '.glb',
      name: 'SceneRuntime-Shelf.glb',
    });
    const originalDispose = container.dispose.bind(container);
    let sourceDisposed = false;
    container.dispose = () => {
      if (!sourceDisposed) {
        sourceDisposed = true;
        sourceDisposeCount += 1;
      }
      originalDispose();
    };
    return container;
  };

  const camera = new FreeCamera('SceneRuntimeShelfArrayCamera', new Vector3(0, 5, -20), integrationScene);
  camera.setTarget(Vector3.Zero());
  integrationScene.activeCamera = camera;
  const runtime = new SceneRuntime(integrationScene);
  try {
    const modelAsset = {
      sourcePath: GLB_PATH,
      sourceUrl: 'smoke://Assets/Models/Shelf/Shelf.glb',
      assetCode: 'SHELF',
      lengthUnit: 'millimeter',
      unitScaleToMeters: 0.001,
      scriptAssets: [{
        path: SCRIPT_PATH,
        sourceUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(scriptText)}`,
        name: 'shelf.model.ts',
      }],
      parameterScriptMetadata: metadata.parameterScripts ?? [],
      animationScriptMetadata: metadata.animationScripts ?? [],
      parameterConfig: metadata.modelParameters,
      parameterValues: { ...values },
    };
    const left = createSceneRuntimeShelfEntity('RUNTIME-SHELF-LEFT', 0, modelAsset);
    const right = createSceneRuntimeShelfEntity('RUNTIME-SHELF-RIGHT', 10, modelAsset);
    runtime.sync(createSceneRuntimeDocument([left, right], left.id));
    const [leftMeshes, rightMeshes] = await Promise.all([
      waitForSceneRuntimeEntityMeshes(integrationScene, runtime, left.id),
      waitForSceneRuntimeEntityMeshes(integrationScene, runtime, right.id),
    ]);

    assert.equal(loadCount, 1, 'SceneRuntime 两个 Shelf 必须只加载一次源容器');
    assert.ok(leftMeshes.length > 0 && leftMeshes.every((mesh) => mesh.isAnInstance), 'SceneRuntime 左 Shelf 必须使用实例 Mesh');
    assert.ok(rightMeshes.length > 0 && rightMeshes.every((mesh) => mesh.isAnInstance), 'SceneRuntime 右 Shelf 必须使用实例 Mesh');
    assertInstancedMeshesHaveSelectionId(leftMeshes, 'SceneRuntime 选中 Shelf 的 InstancedMesh 必须具有实例选择 ID');
    assert.ok(rightMeshes.every((mesh) => Number(mesh.instancedBuffers?.instanceSelectionId ?? 0) === 0), 'SceneRuntime 未选 Shelf 不得继承选择 ID');

    assert.equal(
      runtime.updateEntityArrayPreview(left.id, { x: 1, y: 0, z: 0 }, 3, 0.2),
      true,
      '已选中 Shelf 必须能够创建阵列预览',
    );
    const previewClones = [...(runtime.entityArrayPreview?.clones ?? [])];
    const previewMeshes = [...(runtime.entityArrayPreview?.matrixPreview?.meshes ?? [])];
    assert.equal(previewClones.length, 0, 'Shelf 阵列预览不得按副本递归克隆完整节点树');
    assert.equal(previewMeshes.length, leftMeshes.length, 'Shelf 每个可渲染源 Mesh 只应创建一个矩阵批次');
    assert.ok(previewMeshes.every((mesh) => !mesh.isAnInstance && mesh.thinInstanceCount === 3), 'Shelf 矩阵批次必须按请求数量写入 thinInstance');
    assert.equal(
      previewMeshes.reduce((total, mesh) => total + mesh.thinInstanceCount, 0),
      leftMeshes.length * 3,
      'Shelf 预览节点数量必须与副本数解耦，仅矩阵实例数随副本数增长',
    );
    assert.ok(previewMeshes.every((mesh) => !mesh.isPickable && mesh.metadata === null), 'Shelf 矩阵批次不得参与拾取或保留实体 metadata');
    assert.doesNotThrow(() => integrationScene.render(), '已选中 Shelf 创建矩阵阵列预览后必须保持可渲染');

    assert.equal(
      runtime.updateEntityArrayPreview(left.id, { x: 1, y: 0, z: 0 }, 1000, 0.2),
      true,
      'Shelf 最大阵列数量必须继续复用固定矩阵批次',
    );
    assert.deepEqual(runtime.entityArrayPreview?.matrixPreview?.meshes, previewMeshes, '1000 个副本不得增加 Shelf 批次 Mesh 数量');
    assert.ok(previewMeshes.every((mesh) => mesh.thinInstanceCount === 1000), 'Shelf 每个批次必须写入 1000 个矩阵实例');
    assert.equal(
      previewMeshes.reduce((total, mesh) => total + mesh.thinInstanceCount, 0),
      leftMeshes.length * 1000,
      'Shelf 最大阵列只增加矩阵数量，不增加场景 Mesh 节点数量',
    );
    assert.doesNotThrow(() => integrationScene.render(), 'Shelf 1000 副本矩阵预览必须保持可渲染');

    assert.equal(
      runtime.updateEntityArrayPreview(left.id, { x: -1, y: 0, z: 0 }, 1, 0.5),
      true,
      '更新 Shelf 阵列方向、数量和间距必须复用矩阵批次',
    );
    assert.deepEqual(
      runtime.entityArrayPreview?.matrixPreview?.meshes,
      previewMeshes,
      '减少 Shelf 阵列数量不得重建矩阵批次 Mesh',
    );
    assert.ok(previewMeshes.every((mesh) => mesh.thinInstanceCount === 1), '减少 Shelf 阵列数量必须收缩有效矩阵实例数');
    assert.doesNotThrow(() => integrationScene.render(), '更新 Shelf 矩阵阵列预览后仍必须保持可渲染');
    runtime.clearEntityArrayPreview();
    assert.equal(runtime.entityArrayPreview, null, '取消 Shelf 阵列预览必须释放矩阵批次');
    assert.ok(previewMeshes.every((mesh) => mesh.isDisposed()), '取消 Shelf 阵列预览必须释放全部矩阵批次 Mesh');

    let persistentEntities = Array.from({ length: 1000 }, (_, index) => (
      createSceneRuntimeShelfEntity(`shelf-array-${index + 1}`, (index + 1) * 2, modelAsset, {
        modelArrayInstance: { sourceEntityId: left.id },
      })
    ));
    const meshCountBeforePersistentArray = integrationScene.meshes.length;
    runtime.sync(createSceneRuntimeDocument([left, right, ...persistentEntities], left.id));
    const persistentBatch = runtime.models.get(left.id)?.modelArrayBatch;
    const persistentMeshes = [...(persistentBatch?.meshes ?? [])];
    const persistentPrimaryBatches = persistentBatch?.sources.map((source) => source.batches[0]) ?? [];
    const persistentPrimaryMeshes = persistentPrimaryBatches.map((batch) => batch.mesh);
    assert.equal(loadCount, 1, '正式 Shelf 阵列不得触发任何额外模型加载');
    assert.equal(runtime.models.size, 2, '1000 个 Shelf 阵列实体不得创建逐副本 ModelRuntimeEntry');
    assert.equal(runtime.modelArrayInstanceEntities.size, 1000, 'SceneRuntime 必须保留 1000 个独立 Shelf 逻辑实体');
    assert.ok(
      persistentPrimaryMeshes.length > 0 && persistentPrimaryMeshes.length < leftMeshes.length,
      '正式 Shelf 阵列必须把同材质静态叶 Mesh 合并成更少的 Geometry 源',
    );
    assert.equal(
      persistentBatch.sources.reduce((total, source) => (
        total + source.batches[0].mesh.getTotalVertices() * source.sourceMeshes.length
      ), 0),
      leftMeshes.reduce((total, mesh) => total + mesh.getTotalVertices(), 0),
      'Geometry 顶点乘保留的叶矩阵数必须完整覆盖 Shelf 原始视觉数据',
    );
    const suspendedSourceMeshCount = runtime.models.get(left.id)?.modelArraySuspendedMeshes.size ?? 0;
    assert.equal(
      integrationScene.meshes.length,
      meshCountBeforePersistentArray - suspendedSourceMeshCount + persistentMeshes.length,
      '正式 Shelf 阵列必须用固定批次替换源宿主 Mesh，不能重复保留两套场景节点',
    );
    assert.ok(
      leftMeshes.every((mesh) => !integrationScene.meshes.includes(mesh)),
      '源 Shelf 的脚本宿主 Mesh 必须移出 scene.meshes，避免每帧重复遍历',
    );
    assert.equal(runtime.models.get(left.id)?.root.isEnabled(), false, '源 Shelf 脚本宿主根节点必须暂停渲染');
    assert.ok(persistentMeshes.every((mesh) => !mesh.isAnInstance), '正式 Shelf 阵列不得退回 InstancedMesh 节点');
    for (const source of persistentBatch.sources) {
      const sourceMatrixCount = source.sourceMeshes.reduce((total, sourceMesh) => (
        total + (sourceMesh.thinInstanceCount > 0 ? sourceMesh.thinInstanceCount : 1)
      ), 0);
      const completeInstanceCount = source.batches.reduce(
        (total, batch) => total + (batch.sourceEntityIndexBuffer?.length ?? 0),
        0,
      );
      const visibleInstanceCount = source.batches.reduce(
        (total, batch) => total + batch.mesh.thinInstanceCount,
        0,
      );
      assert.equal(
        completeInstanceCount,
        sourceMatrixCount * 1001,
        '每个 Geometry 源的完整空间分片缓冲必须覆盖源实体和 1000 个逻辑副本',
      );
      assert.ok(visibleInstanceCount <= completeInstanceCount, '视锥压缩后的 GPU 实例前缀不得超过完整源缓冲');
      const verticesPerInstance = Math.max(1, source.batchSource.getTotalVertices());
      const maximumPartitionInstances = Math.max(128, Math.min(65_536, Math.floor(32_000_000 / verticesPerInstance)));
      assert.ok(
        source.batches
          .filter((batch) => batch.sourceEntityIndexBuffer)
          .every((batch) => batch.sourceEntityIndexBuffer.length <= maximumPartitionInstances),
        `正式 Shelf 空间分片必须遵守当前顶点预算动态上限 ${maximumPartitionInstances}`,
      );
    }
    assert.ok(
      persistentMeshes.every((mesh) => mesh.metadata?.modelArraySourceEntityId === left.id),
      '全部正式 Shelf 矩阵分片必须记录源模型',
    );
    assert.ok(
      persistentMeshes.filter((mesh) => mesh.thinInstanceCount > 0).every((mesh) => mesh.isPickable),
      '当前视锥内的正式 Shelf 矩阵分片必须支持实例拾取',
    );
    assert.ok(persistentBatch.hasEntityId(left.id), '完整空间分片缓冲必须保留源实体逻辑映射');
    assert.ok(readModelArraySourceFinalWorldMatrix(persistentBatch, left.id), '完整空间分片缓冲必须能读取源实体矩阵');
    assert.ok(persistentBatch.hasEntityId(persistentEntities[0].id), '完整空间分片缓冲必须保留具体逻辑实体');
    assert.doesNotThrow(() => integrationScene.render(), '正式 Shelf 1000 阵列必须保持可渲染');
    assert.ok(
      persistentBatch.getEntityIds().some((entityId) => findVisibleModelArrayEntity(runtime, persistentBatch, entityId)),
      '当前视锥内至少一个 Shelf 实体必须保留 Babylon picking 索引映射',
    );

    let persistentMatrixUpdateCount = 0;
    const originalPersistentMatrixUpdate = persistentBatch.updateEntityTransforms.bind(persistentBatch);
    persistentBatch.updateEntityTransforms = (...args) => {
      persistentMatrixUpdateCount += 1;
      return originalPersistentMatrixUpdate(...args);
    };
    runtime.sync(createSceneRuntimeDocument([left, right, ...persistentEntities], persistentEntities[10].id));
    assert.equal(persistentMatrixUpdateCount, 0, '仅切换选择不得重新组合 1000 个 Shelf 矩阵');

    const persistentSourceBuffers = new Map();
    persistentBatch.sources.forEach((source, sourceIndex) => {
      for (const batch of source.batches) {
        persistentSourceBuffers.set(`${sourceIndex}:${batch.orientation}:${batch.partitionIndex}`, batch.sourceMatrixBuffer);
      }
    });
    const firstPersistentX = readModelArraySourceFinalWorldMatrix(persistentBatch, persistentEntities[0].id)?.getTranslation().x;
    const lastPersistentX = readModelArraySourceFinalWorldMatrix(persistentBatch, persistentEntities[999].id)?.getTranslation().x;
    persistentEntities = [
      createSceneRuntimeShelfEntity(persistentEntities[0].id, 7, modelAsset, {
        modelArrayInstance: { sourceEntityId: left.id },
      }),
      ...persistentEntities.slice(1),
    ];
    runtime.sync(createSceneRuntimeDocument([left, right, ...persistentEntities], persistentEntities[0].id));
    assert.equal(runtime.models.get(left.id)?.modelArrayBatch, persistentBatch, '移动单个 Shelf 实体必须复用正式矩阵批次');
    assert.equal(persistentMatrixUpdateCount, 1, '移动一个 Shelf 实体只允许触发一次整批矩阵刷新');
    persistentBatch.sources.forEach((source, sourceIndex) => {
      for (const batch of source.batches) {
        assert.equal(
          batch.sourceMatrixBuffer,
          persistentSourceBuffers.get(`${sourceIndex}:${batch.orientation}:${batch.partitionIndex}`),
          '移动 Shelf 实体必须按 Geometry 源和空间分片复用原 Float32Array',
        );
      }
    });
    const updatedFirstPersistentX = readModelArraySourceFinalWorldMatrix(persistentBatch, persistentEntities[0].id)?.getTranslation().x;
    const updatedLastPersistentX = readModelArraySourceFinalWorldMatrix(persistentBatch, persistentEntities[999].id)?.getTranslation().x;
    assert.ok(
      Math.abs((updatedFirstPersistentX ?? Number.NaN) - ((firstPersistentX ?? Number.NaN) + 5)) <= 1e-6,
      '移动单个 Shelf 实体必须只让自己的最终世界矩阵平移 5m',
    );
    assert.ok(
      Math.abs((updatedLastPersistentX ?? Number.NaN) - lastPersistentX) <= 1e-6,
      '移动单个 Shelf 实体不得影响最后一个实例',
    );

    const baseMeasurement = runtime.getModelMeasurement(persistentEntities[2].id).sizeMeters;
    const firstVariantAsset = {
      ...modelAsset,
      parameterValues: {
        ...values,
        layerCount: values.layerCount + 1,
        columnCount: values.columnCount + 2,
      },
    };
    const secondVariantAsset = {
      ...modelAsset,
      parameterValues: {
        ...values,
        layerCount: values.layerCount + 2,
        columnCount: values.columnCount + 1,
      },
    };
    persistentEntities = persistentEntities.map((entity, index) => {
      if (index > 1) return entity;
      return createSceneRuntimeShelfEntity(
        entity.id,
        entity.components.transform.position.x,
        index === 0 ? firstVariantAsset : secondVariantAsset,
        { modelArrayInstance: { sourceEntityId: left.id } },
      );
    });
    runtime.sync(createSceneRuntimeDocument([left, right, ...persistentEntities], persistentEntities[0].id));
    const [firstParameterVariant, secondParameterVariant] = await Promise.all([
      waitForSceneRuntimeModelArrayParameterVariant(runtime, persistentEntities[0].id, {
        modelAsset: persistentEntities[0].components.modelAsset,
      }),
      waitForSceneRuntimeModelArrayParameterVariant(runtime, persistentEntities[1].id, {
        modelAsset: persistentEntities[1].components.modelAsset,
      }),
    ]);
    assert.notEqual(firstParameterVariant, secondParameterVariant, '不同参数值的阵列模型必须使用不同脚本宿主');
    assert.equal(runtime.modelArrayParameterVariants.size, 2, '两个不同参数组合只应创建两个脚本宿主');
    assert.equal(
      runtime.models.get(left.id)?.modelArrayBatch?.getEntityIds().length,
      999,
      '修改两个阵列实体参数后，基础批次必须保留源实体和其余 998 个模型',
    );
    assert.deepEqual(
      firstParameterVariant.model.modelArrayBatch.getEntityIds(),
      [persistentEntities[0].id],
      '第一个参数变体批次必须只映射第一个逻辑模型',
    );
    assert.deepEqual(
      secondParameterVariant.model.modelArrayBatch.getEntityIds(),
      [persistentEntities[1].id],
      '第二个参数变体批次必须只映射第二个逻辑模型',
    );
    const firstVisibleParameterVariant = findVisibleModelArrayEntity(
      runtime,
      firstParameterVariant.model.modelArrayBatch,
      persistentEntities[0].id,
    );
    assert.ok(firstVisibleParameterVariant, '参数变体当前视锥内必须保留可拾取 thinInstance');
    assert.equal(
      runtime.readEntityIdFromMesh(firstVisibleParameterVariant.batch.mesh, firstVisibleParameterVariant.thinInstanceIndex),
      persistentEntities[0].id,
      '参数变体 thinInstance 拾取必须映射回自己的逻辑模型',
    );
    assert.ok(
      firstParameterVariant.model.meshes.every((mesh) => (
        mesh.layerMask === 0
        && mesh.isPickable === false
        && !integrationScene.meshes.includes(mesh)
      )),
      '参数脚本宿主必须移出场景且不可拾取，只显示 thinInstance 批次',
    );
    assert.equal(firstParameterVariant.model.root.isEnabled(), false, '参数脚本宿主根节点必须暂停渲染');
    assert.ok(
      firstParameterVariant.model.modelArrayBatch.meshes.every((mesh) => mesh.layerMask !== 0),
      '参数脚本输出的正式批次不得继承隐藏宿主的 layerMask=0',
    );
    assert.ok(
      firstParameterVariant.model.modelArrayBatch.sources.every((source) => source.batches.some((batch) => (
        batch.sourceEntityIndexBuffer?.length ?? 0
      ) > 0)),
      '参数脚本输出的每个 Geometry 源都必须保留完整逻辑矩阵缓冲',
    );
    assert.ok(
      firstParameterVariant.model.modelArrayBatch.meshes.some((mesh) => mesh.thinInstanceCount > 0),
      '参数脚本输出当前视锥内至少必须存在一个可见 thinInstance 批次',
    );
    assert.ok(
      hasMeasurementDifference(runtime.getModelMeasurement(persistentEntities[0].id).sizeMeters, baseMeasurement),
      '第一个阵列模型修改层列参数后必须产生独立尺寸变化',
    );
    assert.ok(
      hasMeasurementDifference(runtime.getModelMeasurement(persistentEntities[1].id).sizeMeters, baseMeasurement),
      '第二个阵列模型修改层列参数后必须产生独立尺寸变化',
    );
    assert.equal(loadCount, 1, '阵列参数变体必须复用已加载源容器，不得按模型重复加载 GLB');

    const firstVariantModel = firstParameterVariant.model;
    const adjustedFirstVariantAsset = {
      ...firstVariantAsset,
      parameterValues: {
        ...firstVariantAsset.parameterValues,
        columnCount: firstVariantAsset.parameterValues.columnCount + 1,
      },
    };
    persistentEntities = persistentEntities.map((entity, index) => (
      index === 0
        ? createSceneRuntimeShelfEntity(
          entity.id,
          entity.components.transform.position.x,
          adjustedFirstVariantAsset,
          { modelArrayInstance: { sourceEntityId: left.id } },
        )
        : entity
    ));
    runtime.sync(createSceneRuntimeDocument([left, right, ...persistentEntities], persistentEntities[0].id));
    const adjustedFirstVariant = await waitForSceneRuntimeModelArrayParameterVariant(runtime, persistentEntities[0].id, {
      modelAsset: persistentEntities[0].components.modelAsset,
    });
    assert.equal(adjustedFirstVariant, firstParameterVariant, '单个阵列模型连续调参必须复用同一个脚本宿主');
    assert.equal(adjustedFirstVariant.model, firstVariantModel, '连续调参不得重新创建模型运行时或重复加载资源');
    assert.equal(loadCount, 1, '连续调参不得增加 GLB 加载次数');

    const sharedVariantEntities = persistentEntities.map((entity, index) => (
      index <= 1
        ? createSceneRuntimeShelfEntity(
          entity.id,
          entity.components.transform.position.x,
          firstVariantAsset,
          { modelArrayInstance: { sourceEntityId: left.id } },
        )
        : entity
    ));
    persistentEntities = sharedVariantEntities;
    runtime.sync(createSceneRuntimeDocument([left, right, ...persistentEntities], persistentEntities[1].id));
    const sharedVariantEntityIds = [persistentEntities[0].id, persistentEntities[1].id];
    const [sharedFirstVariant, sharedSecondVariant] = await Promise.all([
      waitForSceneRuntimeModelArrayParameterVariant(runtime, persistentEntities[0].id, {
        modelAsset: persistentEntities[0].components.modelAsset,
        expectedEntityIds: sharedVariantEntityIds,
      }),
      waitForSceneRuntimeModelArrayParameterVariant(runtime, persistentEntities[1].id, {
        modelAsset: persistentEntities[1].components.modelAsset,
        expectedEntityIds: sharedVariantEntityIds,
      }),
    ]);
    assert.ok(sharedFirstVariant === sharedSecondVariant, '相同参数值的两个阵列模型必须合并复用一个脚本宿主');
    assert.equal(runtime.modelArrayParameterVariants.size, 1, '参数组合合并后必须释放不再使用的脚本宿主');
    assert.deepEqual(
      sharedFirstVariant.model.modelArrayBatch.getEntityIds(),
      [persistentEntities[0].id, persistentEntities[1].id],
      '相同参数组必须一次提交两个逻辑模型的 thinInstance 矩阵',
    );
    const sharedSecondVisible = findVisibleModelArrayEntity(
      runtime,
      sharedFirstVariant.model.modelArrayBatch,
      persistentEntities[1].id,
    );
    assert.ok(sharedSecondVisible, '合并参数组中的第二个逻辑模型必须在当前视锥保留可拾取 thinInstance');
    assert.equal(
      runtime.readEntityIdFromMesh(sharedSecondVisible.batch.mesh, sharedSecondVisible.thinInstanceIndex),
      persistentEntities[1].id,
      '合并参数组 thinInstance 必须映射到第二个逻辑模型',
    );

    persistentEntities = persistentEntities.map((entity, index) => (
      index <= 1
        ? createSceneRuntimeShelfEntity(
          entity.id,
          entity.components.transform.position.x,
          modelAsset,
          { modelArrayInstance: { sourceEntityId: left.id } },
        )
        : entity
    ));
    runtime.sync(createSceneRuntimeDocument([left, right, ...persistentEntities], persistentEntities[0].id));
    assert.equal(runtime.modelArrayParameterVariants.size, 0, '恢复默认参数后必须释放全部额外脚本宿主');
    assert.equal(
      runtime.models.get(left.id)?.modelArrayBatch?.getEntityIds().length,
      1001,
      '恢复默认参数后源实体和全部 1000 个逻辑模型必须重新合并到基础 thinInstance 批次',
    );

    const lockedRight = createSceneRuntimeShelfEntity(right.id, 10, modelAsset, { locked: true });
    runtime.sync(createSceneRuntimeDocument([left, lockedRight], left.id));
    assert.ok(persistentMeshes.every((mesh) => mesh.isDisposed()), '移除 Shelf 逻辑阵列项必须释放正式矩阵批次');
    assert.ok(rightMeshes.every((mesh) => mesh.isPickable === false), '锁定 Shelf 必须禁用全部实例拾取');
    assert.ok(leftMeshes.every((mesh) => mesh.isPickable === true), '未锁定 Shelf 必须保持实例拾取');

    runtime.sync(createSceneRuntimeDocument([lockedRight], lockedRight.id));
    assert.ok(leftMeshes.every((mesh) => mesh.isDisposed()), '删除左 Shelf 必须释放其全部实例');
    assert.equal(sourceDisposeCount, 0, '删除一个 SceneRuntime Shelf 不得释放共享源');

    runtime.sync(createSceneRuntimeDocument([]));
    assert.ok(rightMeshes.every((mesh) => mesh.isDisposed()), '删除最后一个 Shelf 必须释放其全部实例');
    assert.equal(sourceDisposeCount, 1, '删除最后一个 SceneRuntime Shelf 必须释放共享源一次');
    return {
      loadCount,
      sourceDisposeCount,
      meshesPerShelf: leftMeshes.length,
      arrayPreviewMeshes: previewMeshes.length,
      arrayPreviewThinInstancesAtMax: leftMeshes.length * 1000,
      persistentArrayMeshes: persistentMeshes.length,
      persistentArrayThinInstances: leftMeshes.length * 1000,
      independentParameterVariants: true,
    };
  } finally {
    runtime.dispose();
    SceneLoader.LoadAssetContainerAsync = originalLoadAssetContainerAsync;
    integrationScene.dispose();
    integrationEngine.dispose();
  }
}


/** 验证阵列源模型从默认参数切到非默认值再恢复时，每个渲染帧都保持完整且唯一覆盖。 */
async function runSceneRuntimeSourceParameterTransitionIntegration({ SceneRuntime, glbBytes, scriptText, metadata }) {
  const integrationEngine = new NullEngine();
  const integrationScene = new Scene(integrationEngine);
  const originalLoadAssetContainerAsync = SceneLoader.LoadAssetContainerAsync;
  let loadCount = 0;
  let sourceDisposeCount = 0;
  SceneLoader.LoadAssetContainerAsync = async () => {
    loadCount += 1;
    const container = await LoadAssetContainerAsync(glbBytes, integrationScene, {
      pluginExtension: '.glb',
      name: 'SceneRuntime-Shelf-Source-Parameter-Transition.glb',
    });
    const originalDispose = container.dispose.bind(container);
    let sourceDisposed = false;
    container.dispose = () => {
      if (!sourceDisposed) {
        sourceDisposed = true;
        sourceDisposeCount += 1;
      }
      originalDispose();
    };
    return container;
  };

  const copyCount = 24;
  const camera = new FreeCamera(
    'SceneRuntimeShelfSourceParameterTransitionCamera',
    new Vector3(copyCount, 8, -80),
    integrationScene,
  );
  camera.setTarget(new Vector3(copyCount, 2, 0));
  integrationScene.activeCamera = camera;
  const runtime = new SceneRuntime(integrationScene);
  let result;
  try {
    const defaultValues = createDefaultParameterValues(metadata);
    const modelAsset = {
      sourcePath: GLB_PATH,
      sourceUrl: 'smoke://Assets/Models/Shelf/Shelf.glb',
      assetCode: 'SHELF-SOURCE-PARAMETER-TRANSITION',
      lengthUnit: 'millimeter',
      unitScaleToMeters: 0.001,
      scriptAssets: [{
        path: SCRIPT_PATH,
        sourceUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(scriptText)}`,
        name: 'shelf.model.ts',
      }],
      parameterScriptMetadata: metadata.parameterScripts ?? [],
      animationScriptMetadata: metadata.animationScripts ?? [],
      parameterConfig: metadata.modelParameters,
      parameterValues: { ...defaultValues },
    };
    const source = createSceneRuntimeShelfEntity('RUNTIME-SHELF-SOURCE-PARAMETER', 0, modelAsset);
    const instances = Array.from({ length: copyCount }, (_, index) => createSceneRuntimeShelfEntity(
      `source-parameter-array-${index + 1}`,
      (index + 1) * 2,
      modelAsset,
      { modelArrayInstance: { sourceEntityId: source.id } },
    ));
    const expectedEntityIds = [source.id, ...instances.map((entity) => entity.id)];

    runtime.sync(createSceneRuntimeDocument([source], source.id));
    await waitForSceneRuntimeEntityMeshes(integrationScene, runtime, source.id);
    runtime.sync(createSceneRuntimeDocument([source, ...instances], source.id));
    const sourceModel = runtime.models.get(source.id);
    const initialBatch = sourceModel?.modelArrayBatch;
    assert.ok(sourceModel && initialBatch, '默认参数 Shelf 阵列必须先创建完整基础批次');
    const initialBatchMeshes = [...initialBatch.meshes];
    const defaultRenderSignature = runtime.createModelArrayRenderSignature(
      source.components.modelAsset,
      source.components.telemetryBinding,
    );
    const defaultExpectedRenderSignatures = new Map(
      expectedEntityIds.map((entityId) => [entityId, [defaultRenderSignature]]),
    );
    assert.ok(runtime.isModelArrayBatchCurrent(sourceModel, defaultRenderSignature), '默认参数基础批次必须使用默认渲染签名');
    assert.ok(hasSameEntityIds(initialBatch.getEntityIds(), expectedEntityIds), '默认参数基础批次必须覆盖源模型和全部阵列副本');
    assertSceneRuntimeModelArrayCoverageFrame(
      runtime,
      source.id,
      expectedEntityIds,
      '默认参数初始帧',
      defaultExpectedRenderSignatures,
    );

    const changedModelAsset = {
      ...modelAsset,
      parameterValues: {
        ...defaultValues,
        layerCount: 2,
        columnCount: 3,
        doubleDeepEnabled: true,
      },
    };
    const changedSource = createSceneRuntimeShelfEntity(source.id, 0, changedModelAsset);
    const changedRenderSignature = runtime.createModelArrayRenderSignature(
      changedSource.components.modelAsset,
      changedSource.components.telemetryBinding,
    );
    const transitionExpectedRenderSignatures = new Map([
      [source.id, [defaultRenderSignature, changedRenderSignature]],
      ...instances.map((entity) => [entity.id, [defaultRenderSignature]]),
    ]);
    runtime.sync(createSceneRuntimeDocument([changedSource, ...instances], changedSource.id));
    assert.ok(
      runtime.models.get(source.id)?.modelArrayBatch === initialBatch,
      '源模型从默认值改为非默认值时，新参数副本宿主 ready 前必须保留旧完整批次',
    );
    assert.ok(initialBatchMeshes.every((mesh) => !mesh.isDisposed()), '异步参数变体 ready 前不得提前释放旧完整批次 Mesh');
    assertSceneRuntimeModelArrayCoverageFrame(
      runtime,
      source.id,
      expectedEntityIds,
      '默认值切到非默认值的同步帧',
      transitionExpectedRenderSignatures,
    );

    const defaultToChanged = await waitForSceneRuntimeModelArrayTransition({
      scene: integrationScene,
      runtime,
      sourceEntityId: source.id,
      expectedEntityIds,
      label: '源模型默认值切到非默认值',
      expectedRenderSignaturesByEntityId: transitionExpectedRenderSignatures,
      isSettled: () => {
        const currentSourceModel = runtime.models.get(source.id);
        const currentSourceBatch = currentSourceModel?.modelArrayBatch;
        const copyVariant = runtime.modelArrayParameterVariantByEntityId?.get(instances[0].id);
        return Boolean(
          currentSourceModel
          && currentSourceBatch
          && currentSourceBatch !== initialBatch
          && runtime.isModelArrayBatchCurrent(currentSourceModel, changedRenderSignature)
          && hasSameEntityIds(currentSourceBatch.getEntityIds(), [source.id])
          && copyVariant
          && copyVariant.renderSignature === defaultRenderSignature
          && copyVariant.model.modelArrayBatch
          && runtime.isModelArrayBatchCurrent(copyVariant.model, defaultRenderSignature)
          && hasSameEntityIds(copyVariant.model.modelArrayBatch.getEntityIds(), instances.map((entity) => entity.id))
          && instances.every((entity) => runtime.modelArrayParameterVariantByEntityId?.get(entity.id) === copyVariant)
          && runtime.modelArrayParameterVariants.size === 1
        );
      },
    });
    assert.ok(initialBatchMeshes.every((mesh) => mesh.isDisposed()), '新源批次和默认参数变体均 ready 后必须释放旧完整批次');

    const changedSourceBatch = runtime.models.get(source.id)?.modelArrayBatch;
    const defaultVariant = runtime.modelArrayParameterVariantByEntityId?.get(instances[0].id);
    const defaultVariantBatch = defaultVariant?.model.modelArrayBatch;
    assert.ok(changedSourceBatch && defaultVariantBatch, '非默认源模型收敛后必须同时保留源批次和默认副本变体批次');
    const changedSourceBatchMeshes = [...changedSourceBatch.meshes];
    const defaultVariantBatchMeshes = [...defaultVariantBatch.meshes];

    runtime.sync(createSceneRuntimeDocument([source, ...instances], source.id));
    const changedToDefault = await waitForSceneRuntimeModelArrayTransition({
      scene: integrationScene,
      runtime,
      sourceEntityId: source.id,
      expectedEntityIds,
      label: '源模型非默认值恢复默认值',
      expectedRenderSignaturesByEntityId: transitionExpectedRenderSignatures,
      isSettled: () => {
        const currentSourceModel = runtime.models.get(source.id);
        const currentSourceBatch = currentSourceModel?.modelArrayBatch;
        return Boolean(
          currentSourceModel
          && currentSourceBatch
          && currentSourceBatch !== changedSourceBatch
          && runtime.isModelArrayBatchCurrent(currentSourceModel, defaultRenderSignature)
          && hasSameEntityIds(currentSourceBatch.getEntityIds(), expectedEntityIds)
          && runtime.modelArrayParameterVariants.size === 0
          && instances.every((entity) => !runtime.modelArrayParameterVariantByEntityId?.has(entity.id))
        );
      },
    });
    assert.ok(changedSourceBatchMeshes.every((mesh) => mesh.isDisposed()), '恢复默认值后必须释放非默认源批次');
    assert.ok(defaultVariantBatchMeshes.every((mesh) => mesh.isDisposed()), '恢复默认值后必须释放旧默认参数变体批次');
    assert.equal(loadCount, 1, '源参数往返切换必须复用同一 Shelf 源容器，不得重复加载 GLB');

    result = {
      copyCount,
      logicalEntityCount: expectedEntityIds.length,
      loadCount,
      defaultToChanged,
      changedToDefault,
      minimumCoveredEntityCount: Math.min(
        defaultToChanged.minimumCoveredEntityCount,
        changedToDefault.minimumCoveredEntityCount,
      ),
    };
  } finally {
    runtime.dispose();
    SceneLoader.LoadAssetContainerAsync = originalLoadAssetContainerAsync;
    integrationScene.dispose();
    integrationEngine.dispose();
  }

  assert.equal(sourceDisposeCount, 1, '源参数逐帧验证结束后必须且只能释放一次共享 Shelf 源容器');
  return { ...result, sourceDisposeCount };
}

/** 验证现场最大参数 Shelf 在第 21 个副本处不会因内部 dense thinInstance 展开而整批消失。 */
async function runDenseSceneRuntimeArrayIntegration({ SceneRuntime, glbBytes, scriptText, metadata, values }) {
  const integrationEngine = new NullEngine();
  const integrationScene = new Scene(integrationEngine);
  const originalLoadAssetContainerAsync = SceneLoader.LoadAssetContainerAsync;
  SceneLoader.LoadAssetContainerAsync = async () => LoadAssetContainerAsync(glbBytes, integrationScene, {
    pluginExtension: '.glb',
    name: 'SceneRuntime-Dense-Shelf.glb',
  });

  const camera = new FreeCamera('SceneRuntimeDenseShelfArrayCamera', new Vector3(1_300, 250, -3_000), integrationScene);
  camera.setTarget(new Vector3(1_300, 50, 0));
  integrationScene.activeCamera = camera;
  const runtime = new SceneRuntime(integrationScene);
  try {
    const modelAsset = {
      sourcePath: GLB_PATH,
      sourceUrl: 'smoke://Assets/Models/Shelf/Shelf.glb',
      assetCode: 'SHELF-DENSE-ARRAY',
      lengthUnit: 'millimeter',
      unitScaleToMeters: 0.001,
      scriptAssets: [{
        path: SCRIPT_PATH,
        sourceUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(scriptText)}`,
        name: 'shelf.model.ts',
      }],
      parameterScriptMetadata: metadata.parameterScripts ?? [],
      animationScriptMetadata: metadata.animationScripts ?? [],
      parameterConfig: metadata.modelParameters,
      parameterValues: { ...values },
    };
    const source = createSceneRuntimeShelfEntity('RUNTIME-SHELF-DENSE-SOURCE', 0, modelAsset);
    runtime.sync(createSceneRuntimeDocument([source], source.id));
    const sourceMeshes = await waitForSceneRuntimeEntityMeshes(integrationScene, runtime, source.id);
    const denseSourceMeshes = sourceMeshes.filter((mesh) => mesh.metadata?.denseShelfBatch === true);
    const denseSourceThinInstanceCount = denseSourceMeshes.reduce(
      (total, mesh) => total + mesh.thinInstanceCount,
      0,
    );
    const matrixSourceCount = sourceMeshes.reduce(
      (total, mesh) => total + (mesh.thinInstanceCount > 0 ? mesh.thinInstanceCount : 1),
      0,
    );
    assert.equal(denseSourceMeshes.length, EXPECTED_DENSE_RENDERABLE_MESH_COUNT_20X100, 'SceneRuntime 最大参数 Shelf 必须保留 18 个 dense batch');
    assert.equal(denseSourceThinInstanceCount, EXPECTED_DENSE_THIN_INSTANCE_COUNT_20X100, 'SceneRuntime 最大参数 Shelf 必须保留 16674 个内部实例');

    assert.equal(
      runtime.updateEntityArrayPreview(source.id, { x: 1, y: 0, z: 0 }, 20, 0.2),
      true,
      '20 个最大参数 Shelf 副本必须创建临时矩阵预览',
    );
    const previewAt20 = runtime.entityArrayPreview?.matrixPreview;
    assert.ok(previewAt20, '20 个最大参数 Shelf 副本必须保留矩阵预览批次');
    const previewMeshesAt20 = [...previewAt20.meshes];
    assert.equal(
      previewMeshesAt20.reduce((total, mesh) => total + mesh.thinInstanceCount, 0),
      matrixSourceCount * 20,
      '20 个 Shelf 预览必须完整展开内部 dense 矩阵',
    );
    assert.equal(
      runtime.updateEntityArrayPreview(source.id, { x: 1, y: 0, z: 0 }, 21, 0.2),
      true,
      '第 21 个最大参数 Shelf 副本不得触发预览批次失败',
    );
    assert.ok(runtime.entityArrayPreview?.matrixPreview === previewAt20, '第 21 个 Shelf 预览必须复用已有批次');
    assert.equal(
      previewMeshesAt20.reduce((total, mesh) => total + mesh.thinInstanceCount, 0),
      matrixSourceCount * 21,
      '第 21 个 Shelf 预览必须完整提交且不得清空前 20 个副本',
    );
    assert.ok(previewMeshesAt20.some((mesh) => mesh.isEnabled(false) && mesh.thinInstanceCount > 0), '第 21 个 Shelf 预览后至少一个批次必须保持可见');
    assert.doesNotThrow(() => integrationScene.render(), '第 21 个最大参数 Shelf 预览必须保持可渲染');
    runtime.clearEntityArrayPreview();

    let instances = Array.from({ length: 20 }, (_, index) => createSceneRuntimeShelfEntity(
      `dense-shelf-array-${index + 1}`,
      (index + 1) * 120,
      modelAsset,
      { modelArrayInstance: { sourceEntityId: source.id } },
    ));
    runtime.sync(createSceneRuntimeDocument([source, ...instances], source.id));
    const batchAt20 = runtime.models.get(source.id)?.modelArrayBatch;
    assert.ok(batchAt20, '20 个正式 Shelf 副本必须创建矩阵批次');
    assert.equal(batchAt20.getEntityIds().length, 21, '20 个正式副本加源 Shelf 必须保留 21 个逻辑实体');
    const completeAt20 = batchAt20.sources.reduce((total, matrixSource) => total + matrixSource.batches.reduce(
      (sourceTotal, batch) => sourceTotal + (batch.sourceEntityIndexBuffer?.length ?? 0),
      0,
    ), 0);
    assert.equal(completeAt20, matrixSourceCount * 21, '20 个正式副本必须完整展开内部 dense 矩阵');

    instances = [
      ...instances,
      createSceneRuntimeShelfEntity('dense-shelf-array-21', 21 * 120, modelAsset, {
        modelArrayInstance: { sourceEntityId: source.id },
      }),
    ];
    runtime.sync(createSceneRuntimeDocument([source, ...instances], instances.at(-1).id));
    const batchAt21 = runtime.models.get(source.id)?.modelArrayBatch;
    assert.ok(batchAt21 === batchAt20, '增加第 21 个正式 Shelf 副本必须复用已有矩阵批次');
    assert.equal(batchAt21.getEntityIds().length, 22, '第 21 个副本提交后必须保留源和全部 21 个逻辑副本');
    const completeAt21 = batchAt21.sources.reduce((total, matrixSource) => total + matrixSource.batches.reduce(
      (sourceTotal, batch) => sourceTotal + (batch.sourceEntityIndexBuffer?.length ?? 0),
      0,
    ), 0);
    assert.equal(completeAt21, matrixSourceCount * 22, '第 21 个正式副本不得清空或截断任何 dense 矩阵');
    assert.ok(batchAt21.meshes.some((mesh) => mesh.isEnabled(false) && mesh.thinInstanceCount > 0), '第 21 个正式副本提交后至少一个分片必须保持可见');
    assert.doesNotThrow(() => integrationScene.render(), '第 21 个最大参数 Shelf 正式阵列必须保持可渲染');

    return {
      sourceDenseMeshes: denseSourceMeshes.length,
      sourceDenseThinInstanceCount: denseSourceThinInstanceCount,
      matrixSourceCount,
      previewCopies: 21,
      previewThinInstances: matrixSourceCount * 21,
      formalCopies: 21,
      formalLogicalEntities: batchAt21.getEntityIds().length,
      formalThinInstances: completeAt21,
      formalBatchMeshes: batchAt21.meshes.length,
    };
  } finally {
    runtime.dispose();
    SceneLoader.LoadAssetContainerAsync = originalLoadAssetContainerAsync;
    integrationScene.dispose();
    integrationEngine.dispose();
  }
}

let server;
const engine = new NullEngine();
const scene = new Scene(engine);

try {
  const [glbBytes, scriptText, metadata] = await withStageTimeout('读取 Shelf GLB、脚本和 meta', () => Promise.all([
    fs.readFile(GLB_PATH).then((value) => new Uint8Array(value)),
    fs.readFile(SCRIPT_PATH, 'utf8'),
    fs.readFile(META_PATH, 'utf8').then(JSON.parse),
  ]));

  server = await withStageTimeout('创建 Vite SSR 服务器', () => createServer({
    configFile: false,
    root: process.cwd(),
    resolve: {
      alias: {
        '@linkiez/dxf-renew': path.join(process.cwd(), 'scripts', 'smoke-stubs', 'dxf-renew.mjs'),
      },
    },
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  }));
  const [
    { SharedModelAssetCache, isShelfInstancingCandidate },
    { ExternalModelScriptRuntime },
    { prepareInstancedMeshesForSelectionOutline, repairInstancedMeshBufferContainers },
  ] = await withStageTimeout('加载共享缓存、脚本运行时和实例缓冲保护模块', () => Promise.all([
    loadSsrModuleWithTimeout(server, '/src/runtime/babylon/SharedModelAssetCache.ts'),
    loadSsrModuleWithTimeout(server, '/src/runtime/babylon/ExternalModelScriptRuntime.ts'),
    loadSsrModuleWithTimeout(server, '/src/runtime/babylon/instancedSelectionBuffers.ts'),
  ]));
  const { SceneRuntime } = await withStageTimeout('加载 SceneRuntime 模块', () => loadSsrModuleWithTimeout(server, '/src/runtime/babylon/SceneRuntime.ts'));

  const defaults = createDefaultParameterValues(metadata);
  const targetSceneDenseValues = await withStageTimeout('读取目标场景 20x100 双深 Shelf 参数', () => readTargetSceneDenseShelfValues(metadata));
  const layerParameter = metadata.modelParameters?.parameters?.find((parameter) => parameter.key === 'layerCount');
  const columnParameter = metadata.modelParameters?.parameters?.find((parameter) => parameter.key === 'columnCount');
  assert.equal((layerParameter?.configuration?.max ?? layerParameter?.max), 20, 'meta.json layerCount 必须保持当前支持上限 20');
  assert.equal((columnParameter?.configuration?.max ?? columnParameter?.max), 100, 'meta.json columnCount 必须支持到 100');
  const values = {
    ...defaults,
    layerCount: 2,
    columnCount: 2,
    doubleDeepEnabled: true,
    cellWidth: 1.2,
    cellHeight: 5,
    supportLegHeight: 1,
    cellDepth: 1.5,
    postWidth: 0.1,
    deepSlotGap: 0.3,
    deepSlotLift: 0.15,
  };
  const candidateAsset = {
    sourcePath: GLB_PATH,
    sourceUrl: 'editor-asset://Assets/Models/Shelf/Shelf.glb',
    assetCode: 'SHELF-CANDIDATE',
    lengthUnit: 'millimeter',
    unitScaleToMeters: 0.001,
    scriptAssets: [{ path: SCRIPT_PATH, sourceUrl: 'data:text/plain,', name: 'shelf.model.ts' }],
  };
  assert.equal(isShelfInstancingCandidate(candidateAsset), true, 'Shelf 必须进入共享实例路径');
  assert.equal(isShelfInstancingCandidate({
    ...candidateAsset,
    sourcePath: 'F:/3d-models/models/Stacker/Stacker.glb',
    sourceUrl: 'editor-asset://Assets/Models/Stacker/Stacker.glb',
    scriptAssets: [{ path: 'stacker.model.ts', sourceUrl: 'data:text/plain,', name: 'stacker.model.ts' }],
  }), false, 'Stacker 不得误入 Shelf 共享实例路径');

  const selectionBufferStressInstances = withSyncStage('矩阵实例选择缓冲压力回归', () => runSelectionBufferMatrixStress({
    prepareInstancedMeshesForSelectionOutline,
    repairInstancedMeshBufferContainers,
  }));

  const cache = new SharedModelAssetCache();
  let loadCount = 0;
  let sourceDisposeCount = 0;
  const loader = async () => {
    loadCount += 1;
    const container = await LoadAssetContainerAsync(glbBytes, scene, { pluginExtension: '.glb', name: GLB_PATH });
    const originalDispose = container.dispose.bind(container);
    let sourceDisposed = false;
    container.dispose = () => {
      if (!sourceDisposed) {
        sourceDisposed = true;
        sourceDisposeCount += 1;
      }
      originalDispose();
    };
    return container;
  };
  const cacheKey = JSON.stringify({ sourceUrl: candidateAsset.sourceUrl, assetRevision: 'shelf-instancing-smoke' });
  const [leftInstantiation, rightInstantiation] = await withStageTimeout('共享缓存实例化两个低密度 Shelf', () => Promise.all([
    cache.instantiate(cacheKey, loader, (sourceName) => sourceName),
    cache.instantiate(cacheKey, loader, (sourceName) => sourceName),
  ]));
  assert.equal(loadCount, 1, '两个同源 Shelf 必须只加载一次 AssetContainer');

  const left = await withStageTimeout('创建左侧低密度 Shelf 运行时', () => createShelfRuntime({
    id: 'SHELF-LEFT',
    x: 0,
    sharedInstantiation: leftInstantiation,
    metadata,
    scriptText,
    values,
    ExternalModelScriptRuntime,
    scene,
  }));
  const right = await withStageTimeout('创建右侧低密度 Shelf 运行时', () => createShelfRuntime({
    id: 'SHELF-RIGHT',
    x: 10,
    sharedInstantiation: rightInstantiation,
    metadata,
    scriptText,
    values,
    ExternalModelScriptRuntime,
    scene,
  }));

  const leftMeshes = withSyncStage('收集低密度 Shelf Mesh', () => collectRenderableMeshes(left.contentRoot));
  const rightMeshes = withSyncStage('收集右侧低密度 Shelf Mesh', () => collectRenderableMeshes(right.contentRoot));
  assert.ok(leftMeshes.length > 18, '参数化 Shelf 必须生成额外层列 Mesh');
  assert.equal(leftMeshes.length, rightMeshes.length, '同参数 Shelf 的实例 Mesh 数量必须一致');
  assert.ok(leftMeshes.every((mesh) => mesh.isAnInstance), '左 Shelf 所有有效 Mesh 必须保持 InstancedMesh');
  assert.ok(rightMeshes.every((mesh) => mesh.isAnInstance), '右 Shelf 所有有效 Mesh 必须保持 InstancedMesh');
  assert.ok(leftMeshes.every((mesh) => mesh.metadata?.editorEntityId === left.id), '左 Shelf 拾取 metadata 必须独立');
  assert.ok(rightMeshes.every((mesh) => mesh.metadata?.editorEntityId === right.id), '右 Shelf 拾取 metadata 必须独立');

  const generatedRoots = collectGeneratedRoots(left.contentRoot);
  assert.ok(generatedRoots.length > 0, 'Shelf 参数脚本必须生成层列根节点');
  for (const generatedRoot of generatedRoots) {
    const generatedMeshes = generatedRoot.getChildMeshes(false).filter((mesh) => mesh.getTotalVertices() > 0);
    assert.ok(generatedMeshes.length > 0, `生成节点 ${generatedRoot.name} 必须包含有效 Mesh`);
    assert.ok(generatedMeshes.every((mesh) => mesh.isAnInstance), `生成节点 ${generatedRoot.name} 不得回退普通 Mesh clone`);
  }

  const leftSourceIds = new Set(leftMeshes.map((mesh) => mesh.sourceMesh?.uniqueId));
  assert.ok(rightMeshes.every((mesh) => leftSourceIds.has(mesh.sourceMesh?.uniqueId)), '两个 Shelf 必须共享同一组源 Mesh');
  const rightAbsoluteBefore = rightMeshes[0].getAbsolutePosition().clone();
  left.root.position.x = 5;
  left.root.computeWorldMatrix(true);
  right.root.computeWorldMatrix(true);
  assert.ok(rightMeshes[0].getAbsolutePosition().equalsWithEpsilon(rightAbsoluteBefore), '移动左 Shelf 不得改变右 Shelf Transform');

  logStage('开始：低密度选择隔离验证');
  const selectionLayer = new SelectionOutlineLayer('ShelfSharedInstancingSmokeSelection', scene);
  selectionLayer.addSelection(leftMeshes);
  assertInstancedMeshesHaveSelectionId(leftMeshes, '选中 Shelf 必须写入实例选择 ID');
  assert.ok(rightMeshes.every((mesh) => Number(mesh.instancedBuffers?.instanceSelectionId ?? 0) === 0), '未选 Shelf 不得继承同源选择 ID');
  assertSourceInstanceBuffersComplete(leftMeshes, '首次选中后同源全部实例必须具备 instancedBuffers 容器');

  updateShelfRuntime(left, {
    ...values,
    layerCount: Number(values.layerCount) + 1,
    columnCount: Number(values.columnCount) + 1,
  });
  const updatedSelectedLeftMeshes = collectRenderableMeshes(left.contentRoot);
  assert.ok(updatedSelectedLeftMeshes.length > leftMeshes.length, '左 Shelf 保持选中修改层列后必须生成更多 Mesh');
  assert.ok(updatedSelectedLeftMeshes.every((mesh) => mesh.isAnInstance), '左 Shelf 保持选中修改层列后新增 Mesh 必须仍为实例');
  selectionLayer.clearSelection();
  prepareInstancedMeshesForSelectionOutline(updatedSelectedLeftMeshes);
  selectionLayer.addSelection(updatedSelectedLeftMeshes);
  assertInstancedMeshesHaveSelectionId(updatedSelectedLeftMeshes, '保持选中修改 layerCount/columnCount 后重建描边必须继续写入实例选择 ID');
  assert.ok(rightMeshes.every((mesh) => Number(mesh.instancedBuffers?.instanceSelectionId ?? 0) === 0), '保持选中改参不得污染未选 Shelf 选择 ID');
  assertSourceInstanceBuffersComplete(updatedSelectedLeftMeshes, '重建描边后同源全部实例必须具备 instancedBuffers 容器');
  selectionLayer.clearSelection();
  selectionLayer.dispose();
  logStage('结束：低密度选择隔离验证');

  disposeShelfRuntime(left);
  assert.equal(sourceDisposeCount, 0, '释放一个 Shelf 时不得释放共享源容器');
  assert.ok(collectRenderableMeshes(right.contentRoot).every((mesh) => !mesh.isDisposed()), '释放左 Shelf 后右 Shelf 必须保持有效');

  updateShelfRuntime(right, { ...values, columnCount: 3 });
  const updatedRightMeshes = collectRenderableMeshes(right.contentRoot);
  assert.ok(updatedRightMeshes.length > rightMeshes.length, '右 Shelf 参数更新后必须生成更多列 Mesh');
  assert.ok(updatedRightMeshes.every((mesh) => mesh.isAnInstance), '参数更新后新增 Mesh 必须继续使用实例');

  const denseBaselineInstantiation = await withStageTimeout('共享缓存实例化高密度空间基线 Shelf', () => cache.instantiate(cacheKey, loader, (sourceName) => sourceName));
  const denseBaseline = await withStageTimeout('创建 1x1 单深空间基线 Shelf 运行时', () => createShelfRuntime({
    id: 'SHELF-DENSE-BASELINE-1X1',
    x: 25,
    sharedInstantiation: denseBaselineInstantiation,
    metadata,
    scriptText,
    values: {
      ...values,
      layerCount: 1,
      columnCount: 1,
      doubleDeepEnabled: false,
    },
    ExternalModelScriptRuntime,
    scene,
  }));
  const denseBaselineBounds = withSyncStage('收集 1x1 单深空间基线包围盒', () => collectShelfMeterBounds(denseBaseline.contentRoot));
  disposeShelfRuntime(denseBaseline);

  const denseInstantiation = await withStageTimeout('共享缓存实例化 20x100 高密度 Shelf', () => cache.instantiate(cacheKey, loader, (sourceName) => sourceName));
  const dense = await withStageTimeout('创建 20x100 双深高密度 Shelf 运行时', () => createShelfRuntime({
    id: 'SHELF-DENSE-20X100',
    x: 25,
    sharedInstantiation: denseInstantiation,
    metadata,
    scriptText,
    values: targetSceneDenseValues,
    ExternalModelScriptRuntime,
    scene,
  }));
  const denseBatches = withSyncStage('收集高密度 dense batch Mesh', () => collectDenseBatchMeshes(dense.contentRoot));
  const denseThinInstances = withSyncStage('统计高密度 thin instance 数', () => countDenseThinInstances(denseBatches));
  const denseRenderableMeshes = withSyncStage('收集高密度可渲染 Mesh', () => collectRenderableMeshes(dense.contentRoot));
  const denseMetadata = readDenseMetadata(dense.contentRoot);
  assert.equal(dense.values.layerCount, 20, '目标场景高密度 Shelf layerCount 必须保持当前支持上限 20');
  assert.equal(dense.values.columnCount, 100, '目标场景高密度 Shelf columnCount 必须保持 100');
  assert.equal(denseBatches.length, EXPECTED_DENSE_BATCH_COUNT_20X100, '20x100 双深 Shelf 必须生成完整的 18 个 dense batch');
  assert.equal(
    denseThinInstances,
    EXPECTED_DENSE_THIN_INSTANCE_COUNT_20X100,
    '目标场景 20x100 双深 Shelf 必须提交完整的 16674 个真实 thin instance',
  );
  assert.equal(
    denseRenderableMeshes.length,
    EXPECTED_DENSE_RENDERABLE_MESH_COUNT_20X100,
    '20x100 双深 Shelf 可渲染 dense batch Mesh 数必须保持 18',
  );
  assert.equal(denseMetadata?.enabled, true, '参数根 metadata 必须标记高密度模式已启用');
  assert.equal(denseMetadata?.batchCount, denseBatches.length, '高密度 metadata batchCount 必须与真实批次数一致');
  assert.equal(denseMetadata?.thinInstanceCount, denseThinInstances, '高密度 metadata thinInstanceCount 必须与真实统计一致');
  const denseBounds = withSyncStage('收集 20x100 双深高密度空间包围盒', () => collectShelfMeterBounds(dense.contentRoot));
  withSyncStage('断言 20x100 双深高密度空间展开', () => assertDenseShelfSpaceExpanded({
    denseBounds,
    baselineBounds: denseBaselineBounds,
    values: dense.values,
  }));
  logStage('开始：高密度选择隔离验证');
  const denseSelectionLayer = new SelectionOutlineLayer('ShelfDenseSmokeSelection', scene);
  denseSelectionLayer.addSelection(denseBatches);
  assert.ok(rightMeshes.every((mesh) => Number(mesh.instancedBuffers?.instanceSelectionId ?? 0) === 0), '选择高密度 Shelf 不得污染另一个同源低密度 Shelf');
  denseSelectionLayer.clearSelection();
  denseSelectionLayer.dispose();
  logStage('结束：高密度选择隔离验证');
  withSyncStage('高密度 Shelf 更新参数重建', () => updateShelfRuntime(dense, { ...dense.values, layerCount: 19, columnCount: 100 }));
  const rebuiltDenseBatches = collectDenseBatchMeshes(dense.contentRoot);
  assert.ok(rebuiltDenseBatches.length > 0, '高密度 Shelf 参数更新后必须重新生成 dense batch');
  assert.ok(countDenseThinInstances(rebuiltDenseBatches) < denseThinInstances, '高密度 Shelf 更新层数后 thin instance 数量必须随参数变化');
  disposeShelfRuntime(dense);
  assert.equal(sourceDisposeCount, 0, '释放高密度 Shelf 后右侧低密度 Shelf 仍持有共享源，源容器不得提前释放');

  disposeShelfRuntime(right);
  assert.equal(sourceDisposeCount, 1, '最后一个 Shelf 释放后必须释放共享源容器一次');
  cache.dispose();
  assert.equal(sourceDisposeCount, 1, '缓存重复释放不得重复销毁共享源容器');

  const denseSceneRuntimeArray = await withStageTimeout('20x100 双深 Shelf 第 21 个阵列副本验证', () => runDenseSceneRuntimeArrayIntegration({
    SceneRuntime,
    glbBytes,
    scriptText,
    metadata,
    values: targetSceneDenseValues,
  }));
  const sourceParameterTransition = await withStageTimeout('SceneRuntime 源参数逐帧无闪烁验证', () => (
    runSceneRuntimeSourceParameterTransitionIntegration({
      SceneRuntime,
      glbBytes,
      scriptText,
      metadata,
    })
  ));
  const sceneRuntime = await withStageTimeout('SceneRuntime 集成验证', () => runSceneRuntimeIntegration({
    SceneRuntime,
    glbBytes,
    scriptText,
    metadata,
    values,
  }));
  console.log(JSON.stringify({
    loadCount,
    sourceDisposeCount,
    initialRenderableMeshesPerShelf: leftMeshes.length,
    updatedRenderableMeshes: updatedRightMeshes.length,
    denseBatchCount: denseBatches.length,
    denseThinInstances,
    denseRenderableMeshes: denseRenderableMeshes.length,
    targetScenePath: TARGET_SCENE_PATH,
    targetSceneDenseValues,
    generatedRoots: generatedRoots.length,
    selectionBufferStressInstances,
    sceneRuntime,
    denseSceneRuntimeArray,
    sourceParameterTransition,
  }, null, 2));
} finally {
  await server?.close();
  scene.dispose();
  engine.dispose();
}





