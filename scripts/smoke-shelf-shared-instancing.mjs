import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  FreeCamera,
  LoadAssetContainerAsync,
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
const MODULE_LOAD_TIMEOUT_MS = 180_000;

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

/** 收集实例根节点下具有真实顶点的活动 Mesh。 */
function collectRenderableMeshes(contentRoot) {
  return contentRoot.getChildMeshes(false).filter((mesh) => (
    !mesh.isDisposed() && mesh.isEnabled(false) && mesh.getTotalVertices() > 0
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

/** 断言 100x100 双深 dense 不只是实例数正确，三个正交空间轴也必须真实展开。 */
function assertDenseShelfSpaceExpanded({ denseBounds, baselineBounds, values }) {
  const columnSpacing = Number(values.cellWidth);
  const layerSpacing = Number(values.cellHeight);
  const deepSpacing = Number(values.cellDepth) + Number(values.deepSlotGap);
  assert.ok(denseBounds.size.x > baselineBounds.size.x + columnSpacing * 80, `100列必须沿 X 轴展开，当前 X=${denseBounds.size.x.toFixed(3)}，基线 X=${baselineBounds.size.x.toFixed(3)}`);
  assert.ok(denseBounds.size.y > baselineBounds.size.y + layerSpacing * 80, `100层必须沿 Y 轴展开，当前 Y=${denseBounds.size.y.toFixed(3)}，基线 Y=${baselineBounds.size.y.toFixed(3)}`);
  assert.ok(denseBounds.size.z > baselineBounds.size.z + deepSpacing * 0.45, `双深必须沿 Z 轴展开，当前 Z=${denseBounds.size.z.toFixed(3)}，基线 Z=${baselineBounds.size.z.toFixed(3)}`);
}
/** 汇总高密度批次的 thin instance 数量，兼容 Babylon 公开统计方法和脚本 metadata。 */
function countDenseThinInstances(meshes) {
  return meshes.reduce((sum, mesh) => (
    sum + (Number(mesh.thinInstanceCount) || Number(mesh.metadata?.denseShelfThinInstanceCount) || 0)
  ), 0);
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

/** 等待 SceneRuntime 为实体创建可渲染 Mesh；真实脚本 smoke 不依赖测量状态作为加载信号。 */
async function waitForSceneRuntimeEntityMeshes(scene, entityId) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const meshes = scene.meshes.filter((mesh) => (
      mesh.metadata?.editorEntityId === entityId && !mesh.isDisposed() && mesh.getTotalVertices() > 0
    ));
    if (meshes.length > 0) return meshes;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${entityId} SceneRuntime 加载可渲染 Mesh 超时`);
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
async function runSceneRuntimeIntegration({ SceneRuntime, glbBytes }) {
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

  const runtime = new SceneRuntime(integrationScene);
  try {
    const modelAsset = {
      sourcePath: GLB_PATH,
      sourceUrl: 'smoke://Assets/Models/Shelf/Shelf.glb',
      assetRevision: 'scene-runtime-integration',
      assetCode: 'SHELF',
      lengthUnit: 'millimeter',
      unitScaleToMeters: 0.001,
    };
    const left = createSceneRuntimeShelfEntity('RUNTIME-SHELF-LEFT', 0, modelAsset);
    const right = createSceneRuntimeShelfEntity('RUNTIME-SHELF-RIGHT', 10, modelAsset);
    runtime.sync(createSceneRuntimeDocument([left, right], left.id));
    const [leftMeshes, rightMeshes] = await Promise.all([
      waitForSceneRuntimeEntityMeshes(integrationScene, left.id),
      waitForSceneRuntimeEntityMeshes(integrationScene, right.id),
    ]);

    assert.equal(loadCount, 1, 'SceneRuntime 两个 Shelf 必须只加载一次源容器');
    assert.ok(leftMeshes.length > 0 && leftMeshes.every((mesh) => mesh.isAnInstance), 'SceneRuntime 左 Shelf 必须使用实例 Mesh');
    assert.ok(rightMeshes.length > 0 && rightMeshes.every((mesh) => mesh.isAnInstance), 'SceneRuntime 右 Shelf 必须使用实例 Mesh');
    assertInstancedMeshesHaveSelectionId(leftMeshes, 'SceneRuntime 选中 Shelf 的 InstancedMesh 必须具有实例选择 ID');
    assert.ok(rightMeshes.every((mesh) => Number(mesh.instancedBuffers?.instanceSelectionId ?? 0) === 0), 'SceneRuntime 未选 Shelf 不得继承选择 ID');

    const lockedRight = createSceneRuntimeShelfEntity(right.id, 10, modelAsset, { locked: true });
    runtime.sync(createSceneRuntimeDocument([left, lockedRight], left.id));
    assert.ok(rightMeshes.every((mesh) => mesh.isPickable === false), '锁定 Shelf 必须禁用全部实例拾取');
    assert.ok(leftMeshes.every((mesh) => mesh.isPickable === true), '未锁定 Shelf 必须保持实例拾取');

    runtime.sync(createSceneRuntimeDocument([lockedRight], lockedRight.id));
    assert.ok(leftMeshes.every((mesh) => mesh.isDisposed()), '删除左 Shelf 必须释放其全部实例');
    assert.equal(sourceDisposeCount, 0, '删除一个 SceneRuntime Shelf 不得释放共享源');

    runtime.sync(createSceneRuntimeDocument([]));
    assert.ok(rightMeshes.every((mesh) => mesh.isDisposed()), '删除最后一个 Shelf 必须释放其全部实例');
    assert.equal(sourceDisposeCount, 1, '删除最后一个 SceneRuntime Shelf 必须释放共享源一次');
    return { loadCount, sourceDisposeCount, meshesPerShelf: leftMeshes.length };
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
  const layerParameter = metadata.modelParameters?.parameters?.find((parameter) => parameter.key === 'layerCount');
  const columnParameter = metadata.modelParameters?.parameters?.find((parameter) => parameter.key === 'columnCount');
  assert.equal((layerParameter?.configuration?.max ?? layerParameter?.max), 100, 'meta.json layerCount 必须支持到 100');
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

  const denseInstantiation = await withStageTimeout('共享缓存实例化 100x100 高密度 Shelf', () => cache.instantiate(cacheKey, loader, (sourceName) => sourceName));
  const dense = await withStageTimeout('创建 100x100 双深高密度 Shelf 运行时', () => createShelfRuntime({
    id: 'SHELF-DENSE-100X100',
    x: 25,
    sharedInstantiation: denseInstantiation,
    metadata,
    scriptText,
    values: {
      ...values,
      layerCount: 100,
      columnCount: 100,
      doubleDeepEnabled: true,
    },
    ExternalModelScriptRuntime,
    scene,
  }));
  const denseBatches = withSyncStage('收集高密度 dense batch Mesh', () => collectDenseBatchMeshes(dense.contentRoot));
  const denseThinInstances = withSyncStage('统计高密度 thin instance 数', () => countDenseThinInstances(denseBatches));
  const denseRenderableMeshes = withSyncStage('收集高密度可渲染 Mesh', () => collectRenderableMeshes(dense.contentRoot));
  const denseMetadata = readDenseMetadata(dense.contentRoot);
  assert.equal(dense.values.layerCount, 100, '高密度 Shelf layerCount 不得被 clamp 到 20');
  assert.equal(dense.values.columnCount, 100, '高密度 Shelf columnCount 必须保持 100');
  assert.ok(denseBatches.length > 0, '100x100 Shelf 必须启用高密度 dense batch');
  assert.ok(denseThinInstances > 10000, '100x100 双深 Shelf thin instance 数必须覆盖全部网格重复结构');
  assert.ok(denseRenderableMeshes.length < 200, '100x100 Shelf 场景 Mesh 数必须保持批次级上界');
  assert.equal(denseMetadata?.enabled, true, '参数根 metadata 必须标记高密度模式已启用');
  assert.equal(denseMetadata?.thinInstanceCount, denseThinInstances, '高密度 metadata thinInstanceCount 必须与批次统计一致');
  const denseBounds = withSyncStage('收集 100x100 双深高密度空间包围盒', () => collectShelfMeterBounds(dense.contentRoot));
  withSyncStage('断言 100x100 双深高密度空间展开', () => assertDenseShelfSpaceExpanded({
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
  withSyncStage('高密度 Shelf 更新参数重建', () => updateShelfRuntime(dense, { ...dense.values, layerCount: 99, columnCount: 100 }));
  const rebuiltDenseBatches = collectDenseBatchMeshes(dense.contentRoot);
  assert.ok(rebuiltDenseBatches.length > 0, '高密度 Shelf 参数更新后必须重新生成 dense batch');
  assert.ok(countDenseThinInstances(rebuiltDenseBatches) < denseThinInstances, '高密度 Shelf 更新层数后 thin instance 数量必须随参数变化');
  disposeShelfRuntime(dense);
  assert.equal(sourceDisposeCount, 0, '释放高密度 Shelf 后右侧低密度 Shelf 仍持有共享源，源容器不得提前释放');

  disposeShelfRuntime(right);
  assert.equal(sourceDisposeCount, 1, '最后一个 Shelf 释放后必须释放共享源容器一次');
  cache.dispose();
  assert.equal(sourceDisposeCount, 1, '缓存重复释放不得重复销毁共享源容器');

  const sceneRuntime = await withStageTimeout('SceneRuntime 集成验证', () => runSceneRuntimeIntegration({ SceneRuntime, glbBytes }));
  console.log(JSON.stringify({
    loadCount,
    sourceDisposeCount,
    initialRenderableMeshesPerShelf: leftMeshes.length,
    updatedRenderableMeshes: updatedRightMeshes.length,
    denseBatchCount: denseBatches.length,
    denseThinInstances,
    denseRenderableMeshes: denseRenderableMeshes.length,
    generatedRoots: generatedRoots.length,
    selectionBufferStressInstances,
    sceneRuntime,
  }, null, 2));
} finally {
  await server?.close();
  scene.dispose();
  engine.dispose();
}





