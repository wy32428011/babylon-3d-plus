import {
  ArcRotateCamera,
  Camera,
  Mesh,
  PBRMaterial,
  type AbstractMesh,
  type Engine,
  type Material,
  type Scene,
} from '@babylonjs/core';
import { EngineInstrumentation } from '@babylonjs/core/Instrumentation/engineInstrumentation';
import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation';
import type { SceneRuntimePerformanceMetrics } from './SceneRuntime';

const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;
const MAX_HISTORY_SAMPLES = 60;
const GPU_NANOSECONDS_TO_MILLISECONDS = 0.000001;
const MAX_GPU_WORKLOAD_ENTRIES = 12;

export type EditModeThinInstancePlanPerformanceMetrics = {
  planCount: number;
  lastDurationMs: number;
  maxDurationMs: number;
  entityCount: number;
  groupCount: number;
  thinInstanceEntityCount: number;
};

export type ScenePerformanceCameraSnapshot = {
  alpha: number;
  beta: number;
  radius: number;
  target: { x: number; y: number; z: number };
  fovRadians: number;
  fovMode: 'vertical-fixed' | 'horizontal-fixed';
  aspectRatio: number;
  projection: 'perspective' | 'orthographic';
  minZ: number;
  maxZ: number;
};

export type SceneFocusPerformanceMetrics = {
  requestedEntityCount: number;
  resolvedEntityCount: number;
  geometryReadyEntityCount: number;
  missingEntityCount: number;
  notReadyEntityCount: number;
  missingEntityIds: string[];
  notReadyEntityIds: string[];
  geometryReady: boolean;
  center: { x: number; y: number; z: number };
  sizeMeters: { x: number; y: number; z: number };
  radiusMeters: number;
  focusedAt: string;
};

export type ScenePerformanceMaterialWorkload = {
  className: string;
  alpha: number;
  transparencyMode: number | null;
  alphaBlending: boolean;
  alphaTesting: boolean;
  backFaceCulling: boolean;
  separateCullingPass: boolean;
  depthWriteDisabled: boolean;
  forceDepthWrite: boolean;
  textureCount: number;
  alphaTextureCount: number;
  pbrFeatures: string[];
};

export type ScenePerformanceGpuWorkload = {
  meshName: string;
  materialName: string | null;
  material: ScenePerformanceMaterialWorkload | null;
  sourceEntityId: string | null;
  verticesPerInstance: number;
  trianglesPerInstance: number;
  thinInstances: number;
  instanceMultiplier: number;
  estimatedVertexInvocations: number;
  estimatedTriangleInvocations: number;
  frustumVisibleThinInstances: number;
  estimatedFrustumVisibleVertexInvocations: number;
  estimatedFrustumVisibleTriangleInvocations: number;
  boundsSizeMeters: { x: number; y: number; z: number };
};

export type ScenePerformanceGpuSourceWorkload = {
  sourceEntityId: string;
  meshCount: number;
  thinInstances: number;
  estimatedVertexInvocations: number;
  estimatedTriangleInvocations: number;
  alphaBlendedVertexInvocations: number;
  alphaTestedVertexInvocations: number;
  doubleSidedVertexInvocations: number;
  depthWriteDisabledVertexInvocations: number;
  pbrVertexInvocations: number;
};

export type ScenePerformanceGpuMaterialTotals = {
  alphaBlendedVertexInvocations: number;
  alphaTestedVertexInvocations: number;
  doubleSidedVertexInvocations: number;
  depthWriteDisabledVertexInvocations: number;
  pbrVertexInvocations: number;
};

export type ScenePerformanceSnapshot = {
  sampledAt: string;
  fps: number;
  frameTimeMs: number;
  renderTimeMs: number;
  activeMeshesEvaluationMs: number;
  gpuFrameTimeMs: number | null;
  shaderCompilationMs: number;
  drawCalls: number;
  activeMeshes: number;
  totalMeshes: number;
  totalVertices: number;
  thinInstances: number;
  activeThinInstances: number;
  estimatedActiveVertexInvocations: number;
  estimatedActiveTriangleInvocations: number;
  frustumVisibleThinInstances: number;
  estimatedFrustumVisibleVertexInvocations: number;
  estimatedFrustumVisibleTriangleInvocations: number;
  topActiveGpuWorkloads: ScenePerformanceGpuWorkload[];
  gpuWorkloadsBySource: ScenePerformanceGpuSourceWorkload[];
  gpuMaterialTotals: ScenePerformanceGpuMaterialTotals;
  camera: ScenePerformanceCameraSnapshot | null;
  focus: SceneFocusPerformanceMetrics | null;
  longTaskCount: number;
  longTaskDurationMs: number;
  runtime: SceneRuntimePerformanceMetrics;
  editThinInstancePlan: EditModeThinInstancePlanPerformanceMetrics;
};

export type ScenePerformanceSummary = {
  sampleCount: number;
  averageFps: number;
  minimumFps: number;
  p95FrameTimeMs: number;
  maximumGpuFrameTimeMs: number | null;
  maximumDrawCalls: number;
  maximumActiveMeshes: number;
  maximumActiveThinInstances: number;
  maximumEstimatedActiveVertexInvocations: number;
  maximumEstimatedActiveTriangleInvocations: number;
  maximumFrustumVisibleThinInstances: number;
  maximumEstimatedFrustumVisibleVertexInvocations: number;
  maximumEstimatedFrustumVisibleTriangleInvocations: number;
  longTaskCount: number;
  longTaskDurationMs: number;
};

type ScenePerformanceMonitorOptions = {
  getRuntimeMetrics: () => SceneRuntimePerformanceMetrics;
  getEditThinInstancePlanMetrics: () => EditModeThinInstancePlanPerformanceMetrics;
  getSceneFocusMetrics?: () => SceneFocusPerformanceMetrics | null;
};

/** 将性能计数器的最近一秒均值转换为稳定 HUD 数值。 */
function readCounterValue(counter: { current: number; lastSecAverage: number }): number {
  const value = counter.lastSecAverage > 0 ? counter.lastSecAverage : counter.current;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 只在展示边界做有限数值归一化，保留内部原始采样精度。 */
function normalizeMetric(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 计算一段采样历史的稳定摘要，供复制报告和 smoke 复用。 */
export function summarizeScenePerformance(
  snapshots: readonly ScenePerformanceSnapshot[],
): ScenePerformanceSummary {
  if (snapshots.length === 0) {
    return {
      sampleCount: 0,
      averageFps: 0,
      minimumFps: 0,
      p95FrameTimeMs: 0,
      maximumGpuFrameTimeMs: null,
      maximumDrawCalls: 0,
      maximumActiveMeshes: 0,
      maximumActiveThinInstances: 0,
      maximumEstimatedActiveVertexInvocations: 0,
      maximumEstimatedActiveTriangleInvocations: 0,
      maximumFrustumVisibleThinInstances: 0,
      maximumEstimatedFrustumVisibleVertexInvocations: 0,
      maximumEstimatedFrustumVisibleTriangleInvocations: 0,
      longTaskCount: 0,
      longTaskDurationMs: 0,
    };
  }

  const sortedFrameTimes = snapshots.map((snapshot) => snapshot.frameTimeMs).sort((left, right) => left - right);
  const p95Index = Math.min(sortedFrameTimes.length - 1, Math.ceil(sortedFrameTimes.length * 0.95) - 1);
  const gpuFrameTimes = snapshots
    .map((snapshot) => snapshot.gpuFrameTimeMs)
    .filter((value): value is number => value !== null);

  return {
    sampleCount: snapshots.length,
    averageFps: snapshots.reduce((total, snapshot) => total + snapshot.fps, 0) / snapshots.length,
    minimumFps: Math.min(...snapshots.map((snapshot) => snapshot.fps)),
    p95FrameTimeMs: sortedFrameTimes[p95Index] ?? 0,
    maximumGpuFrameTimeMs: gpuFrameTimes.length > 0 ? Math.max(...gpuFrameTimes) : null,
    maximumDrawCalls: Math.max(...snapshots.map((snapshot) => snapshot.drawCalls)),
    maximumActiveMeshes: Math.max(...snapshots.map((snapshot) => snapshot.activeMeshes)),
    maximumActiveThinInstances: Math.max(...snapshots.map((snapshot) => snapshot.activeThinInstances ?? 0)),
    maximumEstimatedActiveVertexInvocations: Math.max(
      ...snapshots.map((snapshot) => snapshot.estimatedActiveVertexInvocations ?? 0),
    ),
    maximumEstimatedActiveTriangleInvocations: Math.max(
      ...snapshots.map((snapshot) => snapshot.estimatedActiveTriangleInvocations ?? 0),
    ),
    maximumFrustumVisibleThinInstances: Math.max(
      ...snapshots.map((snapshot) => snapshot.frustumVisibleThinInstances ?? 0),
    ),
    maximumEstimatedFrustumVisibleVertexInvocations: Math.max(
      ...snapshots.map((snapshot) => snapshot.estimatedFrustumVisibleVertexInvocations ?? 0),
    ),
    maximumEstimatedFrustumVisibleTriangleInvocations: Math.max(
      ...snapshots.map((snapshot) => snapshot.estimatedFrustumVisibleTriangleInvocations ?? 0),
    ),
    longTaskCount: snapshots.reduce((total, snapshot) => total + snapshot.longTaskCount, 0),
    longTaskDurationMs: snapshots.reduce((total, snapshot) => total + snapshot.longTaskDurationMs, 0),
  };
}

type ActiveGpuWorkloadSummary = {
  activeThinInstances: number;
  estimatedActiveVertexInvocations: number;
  estimatedActiveTriangleInvocations: number;
  frustumVisibleThinInstances: number;
  estimatedFrustumVisibleVertexInvocations: number;
  estimatedFrustumVisibleTriangleInvocations: number;
  topActiveGpuWorkloads: ScenePerformanceGpuWorkload[];
  gpuWorkloadsBySource: ScenePerformanceGpuSourceWorkload[];
  gpuMaterialTotals: ScenePerformanceGpuMaterialTotals;
};

function createEmptyGpuMaterialTotals(): ScenePerformanceGpuMaterialTotals {
  return {
    alphaBlendedVertexInvocations: 0,
    alphaTestedVertexInvocations: 0,
    doubleSidedVertexInvocations: 0,
    depthWriteDisabledVertexInvocations: 0,
    pbrVertexInvocations: 0,
  };
}

/** 读取实际参与当前 Mesh 绘制的材质状态，避免只凭材质名称推断透明或双面成本。 */
function collectMaterialWorkload(material: Material | null, mesh: AbstractMesh): ScenePerformanceMaterialWorkload | null {
  if (!material) return null;

  const activeTextures = material.getActiveTextures();
  const pbrFeatures: string[] = [];
  if (material instanceof PBRMaterial) {
    if (material.unlit) pbrFeatures.push('unlit');
    if (material.albedoTexture) pbrFeatures.push('albedoTexture');
    if (material.metallicTexture) pbrFeatures.push('metallicTexture');
    if (material.ambientTexture) pbrFeatures.push('ambientTexture');
    if (material.opacityTexture) pbrFeatures.push('opacityTexture');
    if (material.reflectionTexture) pbrFeatures.push('reflectionTexture');
    if (material.emissiveTexture) pbrFeatures.push('emissiveTexture');
    if (material.bumpTexture) pbrFeatures.push('bumpTexture');
    if (material.lightmapTexture) pbrFeatures.push('lightmapTexture');
    if (material.clearCoat.isEnabled) pbrFeatures.push('clearCoat');
    if (material.sheen.isEnabled) pbrFeatures.push('sheen');
    if (material.anisotropy.isEnabled) pbrFeatures.push('anisotropy');
    if (material.iridescence.isEnabled) pbrFeatures.push('iridescence');
    if (material.subSurface.isRefractionEnabled) pbrFeatures.push('refraction');
    if (material.subSurface.isTranslucencyEnabled) pbrFeatures.push('translucency');
    if (material.useParallax) pbrFeatures.push('parallax');
    if (material.useParallaxOcclusion) pbrFeatures.push('parallaxOcclusion');
  }

  return {
    className: material.getClassName(),
    alpha: normalizeMetric(material.alpha),
    transparencyMode: material.transparencyMode,
    alphaBlending: material.needAlphaBlendingForMesh(mesh),
    alphaTesting: material.needAlphaTestingForMesh(mesh),
    backFaceCulling: material.backFaceCulling,
    separateCullingPass: material.separateCullingPass,
    depthWriteDisabled: material.disableDepthWrite,
    forceDepthWrite: material.forceDepthWrite,
    textureCount: activeTextures.length,
    alphaTextureCount: activeTextures.filter((texture) => texture.hasAlpha).length,
    pbrFeatures,
  };
}

function accumulateMaterialTotals(
  totals: ScenePerformanceGpuMaterialTotals,
  material: ScenePerformanceMaterialWorkload | null,
  vertexInvocations: number,
): void {
  if (!material) return;
  if (material.alphaBlending) totals.alphaBlendedVertexInvocations += vertexInvocations;
  if (material.alphaTesting) totals.alphaTestedVertexInvocations += vertexInvocations;
  if (!material.backFaceCulling) totals.doubleSidedVertexInvocations += vertexInvocations;
  if (material.depthWriteDisabled) totals.depthWriteDisabledVertexInvocations += vertexInvocations;
  if (material.className.includes('PBR')) totals.pbrVertexInvocations += vertexInvocations;
}

/** 按实际 Active Mesh 估算 GPU 顶点/三角形调用量，识别 thinInstance 批次过大或缺少空间裁剪。 */
function collectActiveGpuWorkload(scene: Scene): ActiveGpuWorkloadSummary {
  const activeMeshes = scene.getActiveMeshes();
  const workloads: ScenePerformanceGpuWorkload[] = [];
  let activeThinInstances = 0;
  let estimatedActiveVertexInvocations = 0;
  let estimatedActiveTriangleInvocations = 0;
  let frustumVisibleThinInstances = 0;
  let estimatedFrustumVisibleVertexInvocations = 0;
  let estimatedFrustumVisibleTriangleInvocations = 0;
  const gpuMaterialTotals = createEmptyGpuMaterialTotals();

  for (let index = 0; index < activeMeshes.length; index += 1) {
    const mesh = activeMeshes.data[index] as AbstractMesh | undefined;
    if (!mesh || mesh.isDisposed()) continue;
    const verticesPerInstance = Math.max(0, mesh.getTotalVertices());
    const indicesPerInstance = Math.max(0, mesh.getTotalIndices());
    const thinInstances = mesh instanceof Mesh ? Math.max(0, mesh.thinInstanceCount) : 0;
    const instanceMultiplier = thinInstances > 0 ? thinInstances : 1;
    const trianglesPerInstance = Math.floor((indicesPerInstance > 0 ? indicesPerInstance : verticesPerInstance) / 3);
    const estimatedVertexInvocations = verticesPerInstance * instanceMultiplier;
    const estimatedTriangleInvocations = trianglesPerInstance * instanceMultiplier;
    const material = collectMaterialWorkload(mesh.material, mesh);
    accumulateMaterialTotals(gpuMaterialTotals, material, estimatedVertexInvocations);
    // 正式批次已在提交矩阵前执行逐实例保守视锥裁剪，因此当前 GPU 实例数就是视锥可见数。
    const frustumVisibleInstanceMultiplier = instanceMultiplier;
    const meshEstimatedFrustumVisibleVertexInvocations = verticesPerInstance * frustumVisibleInstanceMultiplier;
    const meshEstimatedFrustumVisibleTriangleInvocations = trianglesPerInstance * frustumVisibleInstanceMultiplier;
    activeThinInstances += thinInstances;
    estimatedActiveVertexInvocations += estimatedVertexInvocations;
    estimatedActiveTriangleInvocations += estimatedTriangleInvocations;
    frustumVisibleThinInstances += thinInstances > 0 ? frustumVisibleInstanceMultiplier : 0;
    estimatedFrustumVisibleVertexInvocations += meshEstimatedFrustumVisibleVertexInvocations;
    estimatedFrustumVisibleTriangleInvocations += meshEstimatedFrustumVisibleTriangleInvocations;

    if (estimatedVertexInvocations <= 0) continue;
    const bounds = mesh.getBoundingInfo().boundingBox;
    const metadata = mesh.metadata as Record<string, unknown> | null | undefined;
    const sourceEntityId = readMetadataString(metadata, 'modelArraySourceEntityId')
      ?? readMetadataString(metadata, 'editorEntityId');
    workloads.push({
      meshName: mesh.name,
      materialName: mesh.material?.name ?? null,
      material,
      sourceEntityId,
      verticesPerInstance,
      trianglesPerInstance,
      thinInstances,
      instanceMultiplier,
      estimatedVertexInvocations,
      estimatedTriangleInvocations,
      frustumVisibleThinInstances: thinInstances > 0 ? frustumVisibleInstanceMultiplier : 0,
      estimatedFrustumVisibleVertexInvocations: meshEstimatedFrustumVisibleVertexInvocations,
      estimatedFrustumVisibleTriangleInvocations: meshEstimatedFrustumVisibleTriangleInvocations,
      boundsSizeMeters: {
        x: normalizeMetric(bounds.maximumWorld.x - bounds.minimumWorld.x),
        y: normalizeMetric(bounds.maximumWorld.y - bounds.minimumWorld.y),
        z: normalizeMetric(bounds.maximumWorld.z - bounds.minimumWorld.z),
      },
    });
  }

  const sourceWorkloads = new Map<string, ScenePerformanceGpuSourceWorkload>();
  for (const workload of workloads) {
    if (!workload.sourceEntityId) continue;
    const source = sourceWorkloads.get(workload.sourceEntityId) ?? {
      sourceEntityId: workload.sourceEntityId,
      meshCount: 0,
      thinInstances: 0,
      estimatedVertexInvocations: 0,
      estimatedTriangleInvocations: 0,
      alphaBlendedVertexInvocations: 0,
      alphaTestedVertexInvocations: 0,
      doubleSidedVertexInvocations: 0,
      depthWriteDisabledVertexInvocations: 0,
      pbrVertexInvocations: 0,
    };
    source.meshCount += 1;
    source.thinInstances += workload.thinInstances;
    source.estimatedVertexInvocations += workload.estimatedVertexInvocations;
    source.estimatedTriangleInvocations += workload.estimatedTriangleInvocations;
    if (workload.material?.alphaBlending) {
      source.alphaBlendedVertexInvocations += workload.estimatedVertexInvocations;
    }
    if (workload.material?.alphaTesting) {
      source.alphaTestedVertexInvocations += workload.estimatedVertexInvocations;
    }
    if (workload.material && !workload.material.backFaceCulling) {
      source.doubleSidedVertexInvocations += workload.estimatedVertexInvocations;
    }
    if (workload.material?.depthWriteDisabled) {
      source.depthWriteDisabledVertexInvocations += workload.estimatedVertexInvocations;
    }
    if (workload.material?.className.includes('PBR')) {
      source.pbrVertexInvocations += workload.estimatedVertexInvocations;
    }
    sourceWorkloads.set(workload.sourceEntityId, source);
  }

  workloads.sort((left, right) => right.estimatedVertexInvocations - left.estimatedVertexInvocations);
  return {
    activeThinInstances,
    estimatedActiveVertexInvocations,
    estimatedActiveTriangleInvocations,
    frustumVisibleThinInstances,
    estimatedFrustumVisibleVertexInvocations,
    estimatedFrustumVisibleTriangleInvocations,
    topActiveGpuWorkloads: workloads.slice(0, MAX_GPU_WORKLOAD_ENTRIES),
    gpuWorkloadsBySource: [...sourceWorkloads.values()].sort(
      (left, right) => right.estimatedVertexInvocations - left.estimatedVertexInvocations,
    ),
    gpuMaterialTotals,
  };
}


function readMetadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function collectCameraSnapshot(engine: Engine, scene: Scene): ScenePerformanceCameraSnapshot | null {
  const camera = scene.activeCamera;
  if (!(camera instanceof ArcRotateCamera)) return null;

  const target = camera.getTarget();
  const renderWidth = Math.max(1, engine.getRenderWidth());
  const renderHeight = Math.max(1, engine.getRenderHeight());
  return {
    alpha: camera.alpha,
    beta: camera.beta,
    radius: camera.radius,
    target: { x: target.x, y: target.y, z: target.z },
    fovRadians: camera.fov,
    fovMode: camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED ? 'horizontal-fixed' : 'vertical-fixed',
    aspectRatio: renderWidth / renderHeight,
    projection: camera.mode === Camera.ORTHOGRAPHIC_CAMERA ? 'orthographic' : 'perspective',
    minZ: camera.minZ,
    maxZ: camera.maxZ,
  };
}

/**
 * 低频采集 Babylon CPU/GPU 指标和浏览器 Long Task。
 * Instrumentation 每帧只写 Babylon 自带 PerfCounter，React 状态最多每秒更新一次。
 */
export class ScenePerformanceMonitor {
  private readonly sceneInstrumentation: SceneInstrumentation;
  private readonly engineInstrumentation: EngineInstrumentation;
  private readonly history: ScenePerformanceSnapshot[] = [];
  private readonly glInfo: { vendor: string; renderer: string; version: string };
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private longTaskObserver: PerformanceObserver | null = null;
  private pendingLongTaskCount = 0;
  private pendingLongTaskDurationMs = 0;
  private gpuFrameTimeCaptureEnabled = false;
  private disposed = false;

  constructor(
    private readonly engine: Engine,
    private readonly scene: Scene,
    private readonly options: ScenePerformanceMonitorOptions,
  ) {
    this.sceneInstrumentation = new SceneInstrumentation(scene);
    this.sceneInstrumentation.captureFrameTime = true;
    this.sceneInstrumentation.captureRenderTime = true;
    this.sceneInstrumentation.captureActiveMeshesEvaluationTime = true;

    this.engineInstrumentation = new EngineInstrumentation(engine);
    this.engineInstrumentation.captureShaderCompilationTime = true;
    try {
      this.engineInstrumentation.captureGPUFrameTime = true;
      this.gpuFrameTimeCaptureEnabled = this.engineInstrumentation.captureGPUFrameTime;
    } catch (error) {
      console.warn('Scene View GPU frame time 采集不可用，HUD 将继续显示 CPU 与场景指标。', error);
    }

    try {
      this.glInfo = engine.getGlInfo();
    } catch {
      this.glInfo = engine.getInfo();
    }
    this.observeLongTasks();
  }

  /** 启动低频采样；重复调用会替换旧订阅，不会叠加 interval。 */
  start(
    onSample: (snapshot: ScenePerformanceSnapshot) => void,
    intervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  ): void {
    if (this.disposed) return;
    if (this.sampleTimer) clearInterval(this.sampleTimer);

    const emitSample = (): void => {
      if (this.disposed) return;
      onSample(this.sample());
    };
    emitSample();
    this.sampleTimer = setInterval(emitSample, Math.max(250, intervalMs));
  }

  /** 返回最近一次实时快照并把它加入有界历史。 */
  sample(): ScenePerformanceSnapshot {
    const gpuFrameTimeNanoseconds = readCounterValue(this.engineInstrumentation.gpuFrameTimeCounter);
    const activeGpuWorkload = collectActiveGpuWorkload(this.scene);
    const snapshot: ScenePerformanceSnapshot = {
      sampledAt: new Date().toISOString(),
      fps: normalizeMetric(this.engine.getFps()),
      frameTimeMs: readCounterValue(this.sceneInstrumentation.frameTimeCounter),
      renderTimeMs: readCounterValue(this.sceneInstrumentation.renderTimeCounter),
      activeMeshesEvaluationMs: readCounterValue(this.sceneInstrumentation.activeMeshesEvaluationTimeCounter),
      gpuFrameTimeMs: this.gpuFrameTimeCaptureEnabled && gpuFrameTimeNanoseconds > 0
        ? gpuFrameTimeNanoseconds * GPU_NANOSECONDS_TO_MILLISECONDS
        : null,
      shaderCompilationMs: readCounterValue(this.engineInstrumentation.shaderCompilationTimeCounter),
      drawCalls: Math.round(readCounterValue(this.sceneInstrumentation.drawCallsCounter)),
      activeMeshes: this.scene.getActiveMeshes().length,
      totalMeshes: this.scene.meshes.length,
      totalVertices: this.scene.getTotalVertices(),
      thinInstances: this.scene.meshes.reduce(
        (total, mesh) => total + (mesh instanceof Mesh ? Math.max(0, mesh.thinInstanceCount) : 0),
        0,
      ),
      ...activeGpuWorkload,
      camera: collectCameraSnapshot(this.engine, this.scene),
      focus: this.options.getSceneFocusMetrics?.() ?? null,
      longTaskCount: this.pendingLongTaskCount,
      longTaskDurationMs: this.pendingLongTaskDurationMs,
      runtime: this.options.getRuntimeMetrics(),
      editThinInstancePlan: this.options.getEditThinInstancePlanMetrics(),
    };

    this.pendingLongTaskCount = 0;
    this.pendingLongTaskDurationMs = 0;
    this.history.push(snapshot);
    if (this.history.length > MAX_HISTORY_SAMPLES) this.history.shift();
    return snapshot;
  }

  /** 生成包含 renderer、最近一分钟采样和摘要的 JSON 报告。 */
  createReport(): string {
    return JSON.stringify({
      generatedAt: new Date().toISOString(),
      renderer: this.glInfo,
      summary: summarizeScenePerformance(this.history),
      samples: this.history,
    }, null, 2);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    this.longTaskObserver?.disconnect();
    this.longTaskObserver = null;
    if (this.gpuFrameTimeCaptureEnabled) {
      try {
        this.engineInstrumentation.captureGPUFrameTime = false;
      } catch {
        // Engine 正在释放时只需继续清理 instrumentation observer。
      }
    }
    this.engineInstrumentation.dispose();
    this.sceneInstrumentation.dispose();
    this.history.length = 0;
  }

  /** PerformanceObserver 不可用时静默降级；Babylon 指标仍然完整采集。 */
  private observeLongTasks(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;

    this.longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.pendingLongTaskCount += 1;
        this.pendingLongTaskDurationMs += entry.duration;
      }
    });
    try {
      this.longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      this.longTaskObserver.disconnect();
      this.longTaskObserver = null;
    }
  }
}
