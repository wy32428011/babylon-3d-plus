import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  Matrix,
  MeshBuilder,
  NullEngine,
  Scene,
} from '@babylonjs/core';
import { createServer } from 'vite';

const LARGE_PLAN_COUNTS = [10_000, 50_000];
const BATCH_ENTITY_COUNT = 10_000;
const EDITOR_LAYOUT_PATH = 'src/editor/layout/EditorLayout.tsx';
const SCENE_VIEW_PANEL_PATH = 'src/editor/panels/SceneViewPanel.tsx';
const TOOLBAR_PATH = 'src/editor/ui/Toolbar.tsx';
const PERFORMANCE_MONITOR_PATH = 'src/runtime/babylon/ScenePerformanceMonitor.ts';

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

/** 验证 10k thinInstance 的单选切换只读取目标区间，不重新扫描全部 entityIds。 */
function verifyThinInstanceSelectionDelta(EntityArrayThinInstanceBatch) {
  const engine = new NullEngine({ renderWidth: 64, renderHeight: 64 });
  const scene = new Scene(engine);
  const sourceMesh = MeshBuilder.CreateBox('large-selection-source', { size: 1 }, scene);
  const batch = EntityArrayThinInstanceBatch.create('large-selection-source', [sourceMesh], { interactive: true });
  assert.ok(batch, '必须创建 10k 逻辑模型的矩阵批次');

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
    assert.equal(batch.meshes.length, 1, '单源 Mesh 不得因 10k 逻辑模型增加批次 Mesh 数');
    assert.equal(batch.meshes[0].thinInstanceCount, BATCH_ENTITY_COUNT, '批次实例数必须等于 10k');

    batch.setSelectionMask(new Set([instances[0].entityId]), 1);
    const internalBatch = batch.batches[0];
    assert.ok(internalBatch.entityInstanceRangeStarts instanceof Int32Array, '选择区间起点必须使用有界 TypedArray');
    assert.ok(internalBatch.entityInstanceRangeCounts instanceof Uint32Array, '选择区间数量必须使用有界 TypedArray');
    assert.equal(batch.entityIndexById.size, BATCH_ENTITY_COUNT, '实体 ID 到索引只应保留一份共享 Map');
    const firstSelectionBuffer = internalBatch.selectionBuffer;
    assert.ok(firstSelectionBuffer, '首次选择必须注册实例选择缓冲');
    assert.equal(firstSelectionBuffer[0], 1, '首个逻辑模型必须写入选择 ID');

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
      '切换单选必须只访问前后目标区间',
    );
    const selectionUpdateDurationMs = performance.now() - selectionStartedAt;
    batch.entityIds = originalEntityIds;

    assert.equal(internalBatch.selectionBuffer, firstSelectionBuffer, '同数量批次必须复用选择 Float32Array');
    assert.equal(firstSelectionBuffer[0], 0, '旧选区必须差量清零');
    assert.equal(firstSelectionBuffer.at(-1), 1, '新选区必须只写入目标实例');
    assert.equal(
      firstSelectionBuffer.reduce((count, value) => count + (value === 1 ? 1 : 0), 0),
      1,
      '单选缓冲中只能保留一个选中逻辑模型',
    );

    batch.setSelectionMask(new Set([instances.at(-1).entityId]), 7);
    assert.equal(firstSelectionBuffer.at(-1), 7, 'SelectionOutline ID 变化必须更新当前目标区间');
    batch.setSelectionMask(new Set(), 0);
    assert.ok(firstSelectionBuffer.every((value) => value === 0), '清空选择必须只清理之前选中的区间');

    return {
      entityCount: BATCH_ENTITY_COUNT,
      batchMeshCount: batch.meshes.length,
      thinInstanceCount: batch.meshes[0].thinInstanceCount,
      transformUpdateDurationMs,
      selectionUpdateDurationMs,
      selectionBufferReused: true,
    };
  } finally {
    batch.dispose();
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
  assert.equal(summary.longTaskCount, 3);
  assert.equal(summary.longTaskDurationMs, 135);
  return summary;
}

/** 静态约束 React 调用链：选区 effect 不得重新依赖或调用完整 sync。 */
async function verifySceneViewWiring() {
  const [layoutSource, panelSource, toolbarSource, monitorSource] = await Promise.all([
    readFile(EDITOR_LAYOUT_PATH, 'utf8'),
    readFile(SCENE_VIEW_PANEL_PATH, 'utf8'),
    readFile(TOOLBAR_PATH, 'utf8'),
    readFile(PERFORMANCE_MONITOR_PATH, 'utf8'),
  ]);
  const fullSyncStart = panelSource.indexOf('/** 文档内容变化才进入完整 SceneRuntime 同步');
  const selectionSyncStart = panelSource.indexOf('/** 单选/文件夹选区变化只刷新目标表现');
  assert.ok(fullSyncStart >= 0 && selectionSyncStart > fullSyncStart, 'SceneView 必须拆分内容与选择 effect');

  const fullSyncBlock = panelSource.slice(fullSyncStart, selectionSyncStart);
  const fullSyncDependencies = fullSyncBlock.slice(fullSyncBlock.lastIndexOf('}, ['));
  assert.match(fullSyncBlock, /runtime\.sync\(editRuntimeSceneDocument\)/, '内容 effect 必须保留完整同步');
  assert.doesNotMatch(fullSyncDependencies, /selectedEntityId[,\]]/, '完整同步依赖不得包含纯选择字段');

  const selectionEffectStart = panelSource.indexOf('  useEffect(() => {', selectionSyncStart);
  const selectionSyncEnd = panelSource.indexOf('  useEffect(() => {', selectionEffectStart + 20);
  const selectionSyncBlock = panelSource.slice(selectionSyncStart, selectionSyncEnd);
  assert.match(selectionSyncBlock, /runtime\.syncSelection\(editRuntimeSceneDocument\)/, '选区 effect 必须调用专用同步');
  assert.doesNotMatch(selectionSyncBlock, /runtime\.sync\(/, '选区 effect 不得回退完整同步');
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

  return {
    contentAndSelectionEffectsSeparated: true,
    selectionUsesDedicatedRuntimePath: true,
    planIgnoresSelectionOnlyChanges: true,
    hudCanHideAndShowFromToolbar: true,
    hudSampleIntervalMs: 1_000,
    reportHistorySamples: 60,
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
  const batchResult = verifyThinInstanceSelectionDelta(batchModule.EntityArrayThinInstanceBatch);
  const performanceSummary = verifyPerformanceSummary(performanceModule.summarizeScenePerformance);
  const wiring = await verifySceneViewWiring();

  console.log(JSON.stringify({
    ok: true,
    planResults,
    batchResult,
    performanceSummary,
    wiring,
    timingPolicy: 'observational-no-hard-ci-threshold',
  }, null, 2));
} finally {
  await server?.close();
}
