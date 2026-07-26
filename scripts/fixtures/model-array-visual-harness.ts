import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Matrix,
  Scene,
  Vector3,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';
import { SceneRuntime } from '../../src/runtime/babylon/SceneRuntime';

const canvas = document.querySelector('#renderCanvas') as HTMLCanvasElement;
const status = document.querySelector('#status') as HTMLElement;
const contactSheet = document.querySelector('#contactSheet') as HTMLElement;
const READY_TIMEOUT_MS = 120_000;

type Values = Record<string, unknown>;
type VectorData = { x: number; y: number; z: number };
type TransformData = { position: VectorData; rotation: VectorData; scale: VectorData };
type VisualSpec = {
  packageName: string;
  modelName: string;
  glbPath: string;
  glbUrl: string;
  scriptName: string;
  scriptPath: string;
  scriptUrl: string;
  assetRevision: string;
  lengthUnit: string;
  unitScaleToMeters: number;
  parameterScriptMetadata: unknown[];
  animationScriptMetadata: unknown[];
  parameterConfig: any;
  dataDrivenConfig?: unknown;
  defaults: Values;
  changedCandidates: Array<{ key: string; values: Values }>;
};

type CaptureKind = 'direct' | 'array' | 'group';
type CaptureView = 'compare' | 'overview' | 'detail';
type ParameterSet = 'default' | 'changed';
type ComparisonTarget = 'source' | 'positive' | 'negative';
type CameraPreset = { alpha: number; beta: number; radius: number; target: VectorData; minZ: number; maxZ: number };

type HarnessState = {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
  runtime: SceneRuntime;
  spec: VisualSpec;
  changed: { key: string; values: Values };
  defaultMetrics: ReturnType<typeof hostMetrics>;
  referenceMetrics: Map<ParameterSet, ReturnType<typeof hostMetrics>>;
  texturesWarmed: boolean;
  logs: string[];
};

let current: HarnessState | null = null;
const DIRECT_ID = 'visual-direct';
const SOURCE_ID = 'visual-array-source';
const INSTANCE_IDS = ['visual-array-a', 'visual-array-b', 'visual-array-c'];
const DIRECT_CAPTURE_LAYER = 0x1;
const ARRAY_CAPTURE_LAYER = 0x2;

function setStatus(value: unknown): void {
  status.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function vector(x = 0, y = 0, z = 0): VectorData {
  return { x, y, z };
}

function transform(position = vector(), rotation = vector(), scale = vector(1, 1, 1)): TransformData {
  return { position, rotation, scale };
}

function unitScaleToMeters(lengthUnit: string): number {
  if (lengthUnit === 'millimeter') return 0.001;
  if (lengthUnit === 'centimeter') return 0.01;
  return 1;
}

function makeAsset(spec: VisualSpec, values: Values, assetCode: string): any {
  return {
    sourcePath: spec.glbPath,
    sourceUrl: spec.glbUrl,
    assetRevision: spec.assetRevision,
    assetCode,
    lengthUnit: spec.lengthUnit,
    unitScaleToMeters: spec.unitScaleToMeters ?? unitScaleToMeters(spec.lengthUnit),
    scriptAssets: [{ path: spec.scriptPath, sourceUrl: spec.scriptUrl, name: spec.scriptName }],
    parameterScriptMetadata: spec.parameterScriptMetadata,
    animationScriptMetadata: spec.animationScriptMetadata,
    parameterConfig: spec.parameterConfig,
    parameterValues: { ...values },
    dataDrivenConfig: spec.dataDrivenConfig,
  };
}

function createEntity(
  id: string,
  spec: VisualSpec,
  values: Values,
  entityTransform: TransformData,
  visible: boolean,
  sourceEntityId?: string,
): any {
  return {
    id,
    name: id,
    visible,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: entityTransform,
      modelAsset: makeAsset(spec, values, id),
      ...(sourceEntityId ? { modelArrayInstance: { sourceEntityId } } : {}),
    },
  };
}

function createDocument(entities: any[]): any {
  return {
    id: 'model-array-visual-harness',
    name: 'model-array-visual-harness',
    entityIds: entities.map((entity) => entity.id),
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
    selectedEntityId: null,
    mqttConfig: {},
    sceneSettings: {},
  };
}

function isRenderableGeometry(mesh: any, ignoreAncestorDisable = false): boolean {
  return !mesh?.isDisposed?.()
    && mesh.getTotalVertices?.() > 0
    && mesh.isVisible !== false
    && Number(mesh.visibility ?? 1) > 0
    && mesh.isEnabled?.(!ignoreAncestorDisable) !== false;
}

function emptyBounds(): any {
  return {
    min: { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY },
    max: { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY },
  };
}

function expandBounds(bounds: any, box: any, matrix: Matrix): void {
  for (const x of [box.minimum.x, box.maximum.x]) {
    for (const y of [box.minimum.y, box.maximum.y]) {
      for (const z of [box.minimum.z, box.maximum.z]) {
        const point = Vector3.TransformCoordinates(new Vector3(x, y, z), matrix);
        bounds.min.x = Math.min(bounds.min.x, point.x);
        bounds.min.y = Math.min(bounds.min.y, point.y);
        bounds.min.z = Math.min(bounds.min.z, point.z);
        bounds.max.x = Math.max(bounds.max.x, point.x);
        bounds.max.y = Math.max(bounds.max.y, point.y);
        bounds.max.z = Math.max(bounds.max.z, point.z);
      }
    }
  }
}

function finishBounds(bounds: any): any | null {
  if (!Number.isFinite(bounds.min.x)) return null;
  return {
    min: bounds.min,
    max: bounds.max,
    center: {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: (bounds.min.y + bounds.max.y) / 2,
      z: (bounds.min.z + bounds.max.z) / 2,
    },
    size: {
      x: bounds.max.x - bounds.min.x,
      y: bounds.max.y - bounds.min.y,
      z: bounds.max.z - bounds.min.z,
    },
  };
}

function calculateBounds(meshes: any[], relativeRoot: any = null): any | null {
  const bounds = emptyBounds();
  let inverseRoot: Matrix | null = null;
  if (relativeRoot) {
    relativeRoot.computeWorldMatrix(true);
    inverseRoot = relativeRoot.getWorldMatrix().clone();
    inverseRoot.invert();
  }
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    if (Number(mesh.thinInstanceCount) > 0) mesh.thinInstanceRefreshBoundingInfo?.(true);
    const box = (mesh.rawBoundingInfo ?? mesh.getBoundingInfo()).boundingBox;
    const meshWorld = mesh.getWorldMatrix().clone();
    if (Number(mesh.thinInstanceCount) > 0) {
      const matrices = mesh.thinInstanceGetWorldMatrices().slice(0, mesh.thinInstanceCount);
      for (const instance of matrices) {
        const world = instance.multiply(meshWorld);
        expandBounds(bounds, box, inverseRoot ? world.multiply(inverseRoot) : world);
      }
    } else {
      expandBounds(bounds, box, inverseRoot ? meshWorld.multiply(inverseRoot) : meshWorld);
    }
  }
  return finishBounds(bounds);
}

function materialSignature(material: any): string {
  if (!material) return 'none';
  const textures = typeof material.getActiveTextures === 'function'
    ? material.getActiveTextures().map((texture: any) => {
      const raw = String(texture?.url || texture?.name || '');
      return raw.replace(/^data:[^#]+(#image\d+)$/u, 'data:$1').replace(/_\d{10,}$/u, '_runtime');
    }).sort()
    : [];
  const color = (value: any) => value && ['r', 'g', 'b'].every((key) => Number.isFinite(Number(value[key])))
    ? [value.r, value.g, value.b].map((item) => Number(item).toFixed(5)).join(',')
    : null;
  return JSON.stringify({
    className: material.getClassName?.() ?? material.constructor?.name ?? 'Material',
    backFaceCulling: material.backFaceCulling !== false,
    albedo: color(material.albedoColor),
    diffuse: color(material.diffuseColor),
    emissive: color(material.emissiveColor),
    textures,
  });
}

function hostMetrics(model: any): any {
  const meshes = (model?.meshes ?? []).filter((mesh: any) => isRenderableGeometry(mesh, model?.modelArrayBatch !== null));
  let vertices = 0;
  let indices = 0;
  const materials = new Set<string>();
  for (const mesh of meshes) {
    const count = Number(mesh.thinInstanceCount) > 0 ? Number(mesh.thinInstanceCount) : 1;
    vertices += mesh.getTotalVertices() * count;
    indices += mesh.getTotalIndices() * count;
    materials.add(materialSignature(mesh.material));
  }
  return {
    meshCount: meshes.length,
    vertices,
    indices,
    materials: [...materials].sort(),
    bounds: calculateBounds(meshes),
    localBounds: calculateBounds(meshes, model?.root ?? null),
    scriptInstanceCount: model?.externalScriptRuntime?.instances?.length ?? 0,
  };
}

function transformDebug(node: any): any {
  return node ? {
    name: String(node.name ?? ''),
    position: { x: Number(node.position?.x ?? 0), y: Number(node.position?.y ?? 0), z: Number(node.position?.z ?? 0) },
    scaling: { x: Number(node.scaling?.x ?? 1), y: Number(node.scaling?.y ?? 1), z: Number(node.scaling?.z ?? 1) },
    enabledSelf: node.isEnabled?.(false) !== false,
    enabledWithAncestors: node.isEnabled?.(true) !== false,
  } : null;
}

function modelDebug(model: any): any {
  const runtime = model?.externalScriptRuntime as any;
  const instances = runtime?.instances ?? [];
  return {
    root: transformDebug(model?.root),
    contentRoot: transformDebug(model?.contentRoot),
    suspendedMeshCount: model?.modelArraySuspendedMeshes?.size ?? 0,
    instances: instances.map((instance: any) => ({
      className: instance?.constructor?.name ?? '',
      lastSignature: String(instance?.lastSignature ?? ''),
      node: transformDebug(instance?.node),
      nodeSnapshot: instance?.snapshots?.get?.(instance?.node)
        ? {
            position: instance.snapshots.get(instance.node).position,
            scaling: instance.snapshots.get(instance.node).scaling,
            enabled: instance.snapshots.get(instance.node).enabled,
          }
        : null,
      generatedNodeCount: instance?.generatedNodes?.length ?? 0,
    })),
  };
}

function boundsTolerance(bounds: any): number {
  const maximum = Math.max(bounds?.size?.x ?? 0, bounds?.size?.y ?? 0, bounds?.size?.z ?? 0);
  return Math.max(0.0001, maximum * 0.00001);
}

function boundsSizeDelta(left: any, right: any): number {
  if (!left || !right) return Number.POSITIVE_INFINITY;
  return Math.max(...['x', 'y', 'z'].map((axis) => Math.abs(left.size[axis] - right.size[axis])));
}

function meaningfulChange(left: any, right: any): boolean {
  return left.vertices !== right.vertices
    || left.indices !== right.indices
    || JSON.stringify(left.materials) !== JSON.stringify(right.materials)
    || boundsSizeDelta(left.localBounds, right.localBounds) > boundsTolerance(left.localBounds);
}

function compactBounds(mesh: any, raw = false): any | null {
  const info = raw ? mesh?.rawBoundingInfo : mesh?.getBoundingInfo?.();
  const box = info?.boundingBox;
  if (!box) return null;
  const minimum = raw ? box.minimum : box.minimumWorld;
  const maximum = raw ? box.maximum : box.maximumWorld;
  return {
    min: { x: minimum.x, y: minimum.y, z: minimum.z },
    max: { x: maximum.x, y: maximum.y, z: maximum.z },
  };
}

function meshDebugState(mesh: any, scene: Scene): any {
  return {
    name: String(mesh?.name ?? ''),
    className: mesh?.getClassName?.() ?? mesh?.constructor?.name ?? '',
    uniqueId: Number(mesh?.uniqueId ?? -1),
    parentName: String(mesh?.parent?.name ?? ''),
    vertices: Number(mesh?.getTotalVertices?.() ?? 0),
    indices: Number(mesh?.getTotalIndices?.() ?? 0),
    subMeshCount: Number(mesh?.subMeshes?.length ?? 0),
    thinInstanceCount: Number(mesh?.thinInstanceCount ?? 0),
    isVisible: mesh?.isVisible !== false,
    visibility: Number(mesh?.visibility ?? 1),
    enabledSelf: mesh?.isEnabled?.(false) !== false,
    enabledWithAncestors: mesh?.isEnabled?.(true) !== false,
    sceneIncluded: scene.meshes.includes(mesh),
    isActive: Array.from(scene.getActiveMeshes().data ?? []).includes(mesh),
    layerMask: Number(mesh?.layerMask ?? 0),
    material: materialSignature(mesh?.material),
    bounds: compactBounds(mesh),
    rawBounds: compactBounds(mesh, true),
  };
}

function modelArrayBatchMetrics(runtime: any): any {
  const batch = runtime.resolveModelArrayBatchForEntityId(SOURCE_ID);
  if (!batch) return null;
  const scene = runtime.scene as Scene;
  return {
    entityIds: batch.getEntityIds(),
    sourceCount: batch.sources?.length ?? 0,
    meshCount: batch.meshes?.length ?? 0,
    thinInstanceCount: (batch.meshes ?? []).reduce((sum: number, mesh: any) => sum + Number(mesh.thinInstanceCount || 0), 0),
    sources: (batch.sources ?? []).map((source: any) => ({
      meshIndex: source.meshIndex,
      rootLocalGeometryBaked: source.rootLocalGeometryBaked === true,
      sourceMesh: meshDebugState(source.sourceMesh, scene),
      sourceMeshes: (source.sourceMeshes ?? []).map((mesh: any) => meshDebugState(mesh, scene)),
      batches: (source.batches ?? []).map((entry: any) => ({
        ...meshDebugState(entry.mesh, scene),
        requestedVisible: entry.requestedVisible === true,
        requestedPickable: entry.requestedPickable === true,
        sourceMatrixCount: entry.sourceEntityIndexBuffer?.length ?? 0,
        visibleSourceIndexCount: entry.visibleSourceIndexCount ?? 0,
        lastFrustumContainment: entry.lastFrustumContainment ?? null,
      })),
    })),
  };
}

async function waitForDirectReady(state: HarnessState): Promise<void> {
  const deadline = performance.now() + READY_TIMEOUT_MS;
  while (performance.now() < deadline) {
    state.scene.render();
    const direct = state.runtime.models.get(DIRECT_ID);
    if (
      direct?.measurementReady
      && direct.externalScriptStarting === false
      && (direct.externalScriptRuntime?.instances?.length ?? 0) > 0
      && !direct.modelArrayBatch
      && direct.modelArraySuspendedMeshes.size === 0
    ) {
      if (!state.texturesWarmed) {
        await waitForTextures(state.scene, 5_000);
        state.texturesWarmed = true;
      }
      for (let index = 0; index < 4; index += 1) {
        state.scene.render();
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`${state.spec.packageName} 等待阵列前 direct/script 就绪超时`);
}

async function waitForReady(state: HarnessState, requireBatch = true): Promise<void> {
  const deadline = performance.now() + READY_TIMEOUT_MS;
  while (performance.now() < deadline) {
    state.scene.render();
    const direct = state.runtime.models.get(DIRECT_ID);
    const source = state.runtime.models.get(SOURCE_ID);
    const batch = state.runtime.resolveModelArrayBatchForEntityId(SOURCE_ID);
    const batchReady = requireBatch
      ? Boolean(batch)
      : !source?.modelArrayBatch && (source?.modelArraySuspendedMeshes?.size ?? 0) === 0;
    const ready = direct?.measurementReady
      && source?.measurementReady
      && direct.externalScriptStarting === false
      && source.externalScriptStarting === false
      && direct.externalScriptRuntime?.instances?.length > 0
      && source.externalScriptRuntime?.instances?.length > 0
      && batchReady;
    if (ready) {
      if (!state.texturesWarmed) {
        await waitForTextures(state.scene, 5_000);
        state.texturesWarmed = true;
      }
      for (let index = 0; index < 4; index += 1) {
        state.scene.render();
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`${state.spec.packageName} 等待 direct/array/script 就绪超时`);
}

async function waitForTextures(scene: Scene, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const textures = new Set<any>();
    for (const mesh of scene.meshes) {
      if (!isRenderableGeometry(mesh)) continue;
      for (const texture of mesh.material?.getActiveTextures?.() ?? []) {
        if (!texture.isDisposed?.()) textures.add(texture);
      }
    }
    if ([...textures].every((texture) => texture.isReady?.() !== false)) return;
    scene.render();
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function layoutFor(
  metrics: any,
  kind: CaptureKind,
  view: CaptureView,
  comparisonTarget: ComparisonTarget = 'source',
): Record<string, { visible: boolean; transform: TransformData }> {
  const size = metrics?.localBounds?.size ?? { x: 1, y: 1, z: 1 };
  const span = Math.max(0.8, size.x, size.y, size.z);
  if (view === 'compare') {
    const sourceTransform = transform();
    const positiveTransform = transform(
      vector(span * 1.65, 0, 0),
      vector(0, Math.PI / 7, 0),
      vector(1.12, 0.88, 1.05),
    );
    const negativeTransform = transform(
      vector(span * 0.25, 0, -span * 1.8),
      vector(0, Math.PI / 6, 0),
      vector(-1, 1, 1),
    );
    const targetTransform = comparisonTarget === 'positive'
      ? positiveTransform
      : comparisonTarget === 'negative'
        ? negativeTransform
        : sourceTransform;
    return {
      // direct 与被比较的阵列实体使用完全相同的 Transform；截图仅由 camera layerMask 隔离。
      [DIRECT_ID]: { visible: true, transform: targetTransform },
      [SOURCE_ID]: { visible: comparisonTarget === 'source', transform: sourceTransform },
      [INSTANCE_IDS[0]]: { visible: comparisonTarget === 'positive', transform: positiveTransform },
      [INSTANCE_IDS[1]]: { visible: false, transform: transform(vector(0, 0, span * 2)) },
      [INSTANCE_IDS[2]]: { visible: comparisonTarget === 'negative', transform: negativeTransform },
    };
  }

  const directPosition = vector(-span * 2.1, 0, 0);
  const sourcePosition = vector(-span * 0.2, 0, 0);
  const detail = view === 'detail';
  return {
    [DIRECT_ID]: { visible: true, transform: transform(directPosition) },
    [SOURCE_ID]: { visible: true, transform: transform(sourcePosition) },
    [INSTANCE_IDS[0]]: {
      visible: true,
      transform: transform(vector(span * 1.65, 0, 0), vector(0, Math.PI / 7, 0), vector(1.12, 0.88, 1.05)),
    },
    [INSTANCE_IDS[1]]: {
      visible: !detail,
      transform: transform(vector(span * 0.25, span * 0.12, span * 1.8), vector(0, Math.PI / 2, 0), vector(1.2, 0.8, 1.1)),
    },
    [INSTANCE_IDS[2]]: {
      visible: !detail,
      transform: transform(vector(span * 0.25, 0, -span * 1.8), vector(0, Math.PI / 6, 0), vector(-1, 1, 1)),
    },
  };
}

function entitiesFor(
  state: HarnessState,
  values: Values,
  kind: CaptureKind,
  view: CaptureView,
  referenceMetrics: any,
  comparisonTarget: ComparisonTarget = 'source',
  variantValues: Values = values,
): any[] {
  const layout = layoutFor(referenceMetrics, kind, view, comparisonTarget);
  return [
    createEntity(DIRECT_ID, state.spec, values, layout[DIRECT_ID].transform, layout[DIRECT_ID].visible),
    createEntity(SOURCE_ID, state.spec, values, layout[SOURCE_ID].transform, layout[SOURCE_ID].visible),
    ...INSTANCE_IDS.map((id, index) => createEntity(
      id,
      state.spec,
      index === 1 ? variantValues : values,
      layout[id].transform,
      layout[id].visible,
      SOURCE_ID,
    )),
  ];
}

function visibleSceneBounds(scene: Scene): any | null {
  const cameraLayerMask = scene.activeCamera?.layerMask ?? 0x0fffffff;
  const meshes = scene.meshes.filter((mesh: any) => (
    isRenderableGeometry(mesh) && (mesh.layerMask & cameraLayerMask) !== 0
  ));
  return calculateBounds(meshes);
}

function applyCaptureLayers(state: HarnessState, kind: CaptureKind): void {
  for (const mesh of state.runtime.models.get(DIRECT_ID)?.meshes ?? []) {
    if (!mesh.isDisposed()) mesh.layerMask = DIRECT_CAPTURE_LAYER;
  }
  const runtime = state.runtime as any;
  const batches = [
    state.runtime.models.get(SOURCE_ID)?.modelArrayBatch,
    ...[...runtime.modelArrayParameterVariants.values()].map((variant: any) => variant.model?.modelArrayBatch),
  ].filter(Boolean);
  for (const batch of batches) {
    for (const mesh of batch.meshes ?? []) {
      if (!mesh.isDisposed()) mesh.layerMask = ARRAY_CAPTURE_LAYER;
    }
  }
  state.camera.layerMask = kind === 'direct'
    ? DIRECT_CAPTURE_LAYER
    : kind === 'array'
      ? ARRAY_CAPTURE_LAYER
      : DIRECT_CAPTURE_LAYER | ARRAY_CAPTURE_LAYER;
}

function applyCameraPreset(camera: ArcRotateCamera, preset: CameraPreset): void {
  camera.setTarget(new Vector3(preset.target.x, preset.target.y, preset.target.z));
  camera.alpha = preset.alpha;
  camera.beta = preset.beta;
  camera.radius = preset.radius;
  camera.minZ = preset.minZ;
  camera.maxZ = preset.maxZ;
}

function frameVisible(state: HarnessState, view: CaptureView): CameraPreset {
  state.scene.render();
  const bounds = visibleSceneBounds(state.scene);
  if (!bounds) throw new Error(`${state.spec.packageName} 当前截图没有可渲染包围盒`);
  const size = bounds.size;
  const diagonal = Math.max(0.2, Math.hypot(size.x, size.y, size.z));
  const target = new Vector3(bounds.center.x, bounds.center.y, bounds.center.z);
  const alpha = view === 'detail' ? Math.PI * 0.49 : Math.PI * 0.72;
  const beta = view === 'detail' ? Math.PI * 0.43 : Math.PI * 0.31;
  const fovFit = diagonal / Math.max(0.25, 2 * Math.tan(state.camera.fov / 2));
  const margin = view === 'detail' ? 0.58 : 1.32;
  const radius = Math.max(0.5, fovFit * margin);
  const preset: CameraPreset = {
    alpha,
    beta,
    radius,
    target: { x: target.x, y: target.y, z: target.z },
    minZ: Math.max(0.001, radius / 10_000),
    maxZ: Math.max(1_000, radius * 30),
  };
  applyCameraPreset(state.camera, preset);
  state.scene.render();
  return preset;
}

async function syncCapture(
  state: HarnessState,
  parameterSet: ParameterSet,
  kind: CaptureKind,
  view: CaptureView,
  preset?: CameraPreset,
  comparisonTarget: ComparisonTarget = 'source',
): Promise<any> {
  const values = parameterSet === 'default' ? state.spec.defaults : state.changed.values;
  const variantValues = parameterSet === 'changed' ? state.spec.defaults : values;
  const reference = state.referenceMetrics.get(parameterSet) ?? state.defaultMetrics;
  state.runtime.sync(createDocument(entitiesFor(
    state,
    values,
    kind,
    view,
    reference,
    comparisonTarget,
    variantValues,
  )));
  await waitForReady(state);
  const directMetrics = hostMetrics(state.runtime.models.get(DIRECT_ID));
  if (kind === 'direct' && view === 'compare') state.referenceMetrics.set(parameterSet, directMetrics);
  applyCaptureLayers(state, kind);
  state.scene.render();
  const cameraPreset = preset ?? frameVisible(state, view);
  if (preset) {
    applyCameraPreset(state.camera, preset);
    state.scene.render();
  }
  return {
    packageName: state.spec.packageName,
    parameterSet,
    kind,
    view,
    comparisonTarget,
    changedKey: state.changed.key,
    cameraPreset,
    directMetrics,
    sourceMetrics: hostMetrics(state.runtime.models.get(SOURCE_ID)),
    directModelDebug: modelDebug(state.runtime.models.get(DIRECT_ID)),
    sourceModelDebug: modelDebug(state.runtime.models.get(SOURCE_ID)),
    batchMetrics: modelArrayBatchMetrics(state.runtime),
    parameterVariantCount: (state.runtime as any).modelArrayParameterVariants.size,
    parameterVariantEntityIds: [...(state.runtime as any).modelArrayParameterVariantByEntityId.keys()],
    sceneMeshCount: state.scene.meshes.length,
    sceneActiveMeshes: state.scene.getActiveMeshes().length,
    logs: [...state.logs],
  };
}

async function selectChangedCandidate(state: HarnessState): Promise<{ key: string; values: Values }> {
  // 先只加载一个 direct 模型，确保 direct/parameter 两阶段发生在任何阵列实体创建之前。
  state.runtime.sync(createDocument([
    createEntity(DIRECT_ID, state.spec, state.spec.defaults, transform(), true),
  ]));
  await waitForDirectReady(state);
  const baseline = hostMetrics(state.runtime.models.get(DIRECT_ID));
  if (!baseline.localBounds || baseline.vertices <= 0) throw new Error(`${state.spec.packageName} 默认参数没有可渲染几何`);

  for (const candidate of state.spec.changedCandidates) {
    state.runtime.sync(createDocument([
      createEntity(DIRECT_ID, state.spec, candidate.values, transform(), true),
    ]));
    await waitForDirectReady(state);
    const metrics = hostMetrics(state.runtime.models.get(DIRECT_ID));
    if (meaningfulChange(baseline, metrics)) {
      state.defaultMetrics = baseline;
      state.referenceMetrics.set('default', baseline);
      state.referenceMetrics.set('changed', metrics);
      return candidate;
    }
  }
  throw new Error(`${state.spec.packageName} 所有数值参数都没有产生可检测的几何或材质变化`);
}

async function initialize(spec: VisualSpec): Promise<any> {
  await disposeCurrent();
  contactSheet.classList.remove('active');
  contactSheet.innerHTML = '';
  canvas.style.display = 'block';
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
    antialias: true,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
  }, true);
  engine.setHardwareScalingLevel(1);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.035, 0.047, 0.064, 1);
  scene.ambientColor = new Color3(0.24, 0.26, 0.3);
  const camera = new ArcRotateCamera('visual-camera', Math.PI * 0.72, Math.PI * 0.31, 8, Vector3.Zero(), scene);
  camera.fov = 0.62;
  camera.inertia = 0;
  camera.lowerRadiusLimit = 0.01;
  camera.upperRadiusLimit = 1_000_000;
  camera.attachControl(canvas, false);
  scene.activeCamera = camera;
  const hemi = new HemisphericLight('visual-hemi', new Vector3(0.2, 1, 0.25), scene);
  hemi.intensity = 1.05;
  hemi.groundColor = new Color3(0.12, 0.14, 0.18);
  const key = new DirectionalLight('visual-key', new Vector3(-0.55, -1, 0.4), scene);
  key.position = new Vector3(8, 14, -10);
  key.intensity = 1.15;
  const fill = new DirectionalLight('visual-fill', new Vector3(0.5, -0.35, -0.6), scene);
  fill.position = new Vector3(-8, 8, 10);
  fill.intensity = 0.45;
  const logs: string[] = [];
  const runtime = new SceneRuntime(scene, (message) => logs.push(message));
  const state = {
    engine,
    scene,
    camera,
    runtime,
    spec,
    changed: { key: '', values: {} },
    defaultMetrics: null as any,
    referenceMetrics: new Map(),
    texturesWarmed: false,
    logs,
  } satisfies HarnessState;
  current = state;
  engine.runRenderLoop(() => scene.render());
  const changed = await selectChangedCandidate(state);
  state.changed = changed;
  await syncCapture(state, 'default', 'direct', 'compare');
  setStatus({ ready: true, packageName: spec.packageName, changedKey: changed.key });
  return {
    packageName: spec.packageName,
    changedKey: changed.key,
    lifecycle: { direct: true, parameter: true },
    defaultMetrics: state.defaultMetrics,
    changedMetrics: state.referenceMetrics.get('changed'),
    logs,
  };
}

async function prepareCapture(request: {
  parameterSet: ParameterSet;
  kind: CaptureKind;
  view: CaptureView;
  cameraPreset?: CameraPreset;
  comparisonTarget?: ComparisonTarget;
}): Promise<any> {
  if (!current) throw new Error('可视化 harness 尚未初始化');
  const result = await syncCapture(
    current,
    request.parameterSet,
    request.kind,
    request.view,
    request.cameraPreset,
    request.comparisonTarget ?? 'source',
  );
  setStatus(result);
  return result;
}

async function verifyRestore(): Promise<any> {
  if (!current) throw new Error('可视化 harness 尚未初始化');
  current.runtime.sync(createDocument([
    createEntity(DIRECT_ID, current.spec, current.spec.defaults, transform(), true),
    createEntity(SOURCE_ID, current.spec, current.spec.defaults, transform(), true),
  ]));
  await waitForReady(current, false);
  const sourceModel = current.runtime.models.get(SOURCE_ID);
  const restored = hostMetrics(sourceModel);
  const baseline = current.defaultMetrics;
  const sizeDelta = boundsSizeDelta(restored.localBounds, baseline.localBounds);
  const batchDisposed = !sourceModel?.modelArrayBatch;
  const hostRestored = (sourceModel?.modelArraySuspendedMeshes?.size ?? 0) === 0;
  return {
    pass: batchDisposed
      && hostRestored
      && restored.meshCount === baseline.meshCount
      && restored.vertices === baseline.vertices
      && restored.indices === baseline.indices
      && JSON.stringify(restored.materials) === JSON.stringify(baseline.materials)
      && sizeDelta <= boundsTolerance(baseline.localBounds)
      && restored.scriptInstanceCount > 0,
    batchDisposed,
    hostRestored,
    sizeDelta,
    tolerance: boundsTolerance(baseline.localBounds),
    baseline,
    restored,
  };
}

async function disposeCurrent(): Promise<void> {
  if (!current) return;
  current.engine.stopRenderLoop();
  current.runtime.dispose();
  current.scene.dispose();
  current.engine.dispose();
  current = null;
}

async function renderContactSheet(payload: any): Promise<void> {
  await disposeCurrent();
  canvas.style.display = 'none';
  document.documentElement.style.overflow = 'auto';
  document.body.style.overflow = 'auto';
  contactSheet.classList.add('active');
  const title = document.createElement('h1');
  title.className = 'sheet-title';
  title.textContent = `${Number(payload.packageCount ?? payload.cards?.length ?? 0)} 个模型展示与阵列验收总览 · ${payload.generatedAt}`;
  const grid = document.createElement('section');
  grid.className = 'sheet-grid';
  for (const card of payload.cards) {
    const article = document.createElement('article');
    article.className = 'sheet-card';
    const heading = document.createElement('h2');
    heading.textContent = `${card.packageName} · ${card.status}`;
    const images = document.createElement('div');
    images.className = 'sheet-images';
    for (const image of [card.defaultImageUrl, card.changedImageUrl]) {
      if (image) {
        const img = document.createElement('img');
        img.src = image;
        images.appendChild(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.style.aspectRatio = '3 / 2';
        placeholder.style.background = '#091019';
        placeholder.style.borderRadius = '5px';
        images.appendChild(placeholder);
      }
    }
    const statuses = document.createElement('div');
    statuses.className = 'sheet-status';
    for (const [key, label] of [
      ['direct', 'direct'],
      ['parameter', 'parameter'],
      ['array', 'array'],
      ['parameterAfterArray', 'param-array'],
      ['restore', 'restore'],
    ]) {
      const span = document.createElement('span');
      span.className = card.lifecycle?.[key] ? 'pass' : 'fail';
      span.textContent = `${label}:${card.lifecycle?.[key] ? 'PASS' : 'FAIL'}`;
      statuses.appendChild(span);
    }
    article.append(heading, images, statuses);
    if (card.error) {
      const error = document.createElement('div');
      error.className = 'sheet-error';
      error.textContent = card.error;
      article.appendChild(error);
    }
    grid.appendChild(article);
  }
  contactSheet.replaceChildren(title, grid);
  await Promise.all([...contactSheet.querySelectorAll('img')].map((img) => (
    (img as HTMLImageElement).decode().catch(() => undefined)
  )));

  // Electron 隐藏窗口高度会被桌面工作区裁剪；直接绘制固定尺寸 Canvas，保证 16 卡联系表完整输出。
  const sheetWidth = 1600;
  const padding = 28;
  const titleHeight = 34;
  const titleGap = 20;
  const columnCount = 4;
  const cardGap = 18;
  const cardHeight = 246;
  const rowCount = Math.max(1, Math.ceil(payload.cards.length / columnCount));
  const sheetHeight = padding * 2 + titleHeight + titleGap + rowCount * cardHeight + Math.max(0, rowCount - 1) * cardGap;
  const sheetCanvas = document.createElement('canvas');
  sheetCanvas.width = sheetWidth;
  sheetCanvas.height = sheetHeight;
  const context = sheetCanvas.getContext('2d');
  if (!context) throw new Error('无法创建联系表 Canvas 2D 上下文');
  context.fillStyle = '#101722';
  context.fillRect(0, 0, sheetWidth, sheetHeight);
  context.fillStyle = '#e7edf5';
  context.font = '700 28px "Microsoft YaHei", sans-serif';
  context.textBaseline = 'top';
  context.fillText(title.textContent ?? '', padding, padding);

  const cardWidth = (sheetWidth - padding * 2 - cardGap * (columnCount - 1)) / columnCount;
  const cardPadding = 12;
  const imageGap = 8;
  const innerWidth = cardWidth - cardPadding * 2;
  const imageWidth = (innerWidth - imageGap) / 2;
  const imageHeight = imageWidth * 2 / 3;
  const articles = [...contactSheet.querySelectorAll<HTMLElement>('.sheet-card')];
  payload.cards.forEach((card: any, index: number) => {
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    const x = padding + column * (cardWidth + cardGap);
    const y = padding + titleHeight + titleGap + row * (cardHeight + cardGap);
    context.beginPath();
    context.roundRect(x, y, cardWidth, cardHeight, 10);
    context.fillStyle = '#172231';
    context.fill();
    context.strokeStyle = '#31425a';
    context.lineWidth = 1;
    context.stroke();

    context.fillStyle = '#e7edf5';
    context.font = '700 17px "Microsoft YaHei", sans-serif';
    context.textBaseline = 'top';
    context.fillText(`${card.packageName} · ${card.status}`, x + cardPadding, y + cardPadding);
    const imageY = y + cardPadding + 30;
    const images = [...(articles[index]?.querySelectorAll<HTMLImageElement>('img') ?? [])];
    for (let imageIndex = 0; imageIndex < 2; imageIndex += 1) {
      const imageX = x + cardPadding + imageIndex * (imageWidth + imageGap);
      context.fillStyle = '#091019';
      context.fillRect(imageX, imageY, imageWidth, imageHeight);
      const image = images[imageIndex];
      if (image?.naturalWidth && image.naturalHeight) {
        context.drawImage(image, imageX, imageY, imageWidth, imageHeight);
      }
    }

    const statusY = imageY + imageHeight + 9;
    const statusGap = 4;
    const statusWidth = (innerWidth - statusGap * 4) / 5;
    const statusHeight = 25;
    const lifecycleEntries = [
      ['direct', 'direct'],
      ['parameter', 'parameter'],
      ['array', 'array'],
      ['parameterAfterArray', 'param-array'],
      ['restore', 'restore'],
    ];
    lifecycleEntries.forEach(([key, label], statusIndex) => {
      const statusX = x + cardPadding + statusIndex * (statusWidth + statusGap);
      const pass = card.lifecycle?.[key] === true;
      context.fillStyle = pass ? '#165c3c' : '#7b2631';
      context.beginPath();
      context.roundRect(statusX, statusY, statusWidth, statusHeight, 4);
      context.fill();
      context.fillStyle = '#e7edf5';
      context.font = '10px "Microsoft YaHei", sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(`${label}:${pass ? 'PASS' : 'FAIL'}`, statusX + statusWidth / 2, statusY + statusHeight / 2);
    });
    context.textAlign = 'left';
    context.textBaseline = 'top';
    if (card.error) {
      context.fillStyle = '#ffb2ba';
      context.font = '11px "Microsoft YaHei", sans-serif';
      context.fillText(String(card.error).replace(/\s+/g, ' ').slice(0, 96), x + cardPadding, statusY + statusHeight + 9, innerWidth);
    }
  });

  return {
    width: sheetWidth,
    height: sheetHeight,
    pngBase64: sheetCanvas.toDataURL('image/png').split(',', 2)[1] ?? '',
  };
}

(window as any).modelArrayVisualHarness = {
  ready: true,
  initialize,
  prepareCapture,
  verifyRestore,
  dispose: disposeCurrent,
  renderContactSheet,
};
setStatus('ready');
