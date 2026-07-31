import {
  AbstractMesh,
  AssetContainer,
  Color3,
  LinesMesh,
  Material,
  Matrix,
  Mesh,
  MeshBuilder,
  Scene,
  TransformNode,
  Vector3,
} from '@babylonjs/core';

import {
  sanitizeSceneEnvironment,
  type SceneEnvironmentSettings,
  type SceneEnvironmentTransform,
} from '../../editor/model/SceneDocument';
import type {
  EnvironmentApplyResult,
  EnvironmentModelStatistics,
  EnvironmentRuntimeSnapshot,
  EnvironmentWorldBounds,
} from '../../editor/model/environmentRuntime';
import { resolveRuntimeAssetUrl } from '../assets/editorAssetUrl';
import {
  calculateEnvironmentOriginLeftOffset,
  calculateEnvironmentSceneBaseOffset,
  ENVIRONMENT_FALLBACK_LEFT_OFFSET_METERS,
} from './environmentPlacement';
import {
  getMeshWorldBounds,
  mergeWorldBounds,
  type RuntimeWorldBounds,
} from './runtimeNodeGeometry';

export type SceneEnvironmentApplyOptions = {
  requestId: string | null;
  autoAlign: boolean;
};

export type SceneEnvironmentRuntimeOptions = {
  loadAssetContainer: (
    rootUrl: string,
    fileName: string,
    signal?: AbortSignal,
  ) => Promise<AssetContainer>;
  resolveAssetUrl?: (sourceUrl: string) => string;
  onSnapshot?: (snapshot: EnvironmentRuntimeSnapshot) => void;
  pushLog?: (message: string) => void;
};

type EnvironmentMaterialBaseline = {
  material: Material;
  alpha: number;
  transparencyMode: number | null;
  disableDepthWrite: boolean;
  forceDepthWrite: boolean;
  needDepthPrePass: boolean;
};

type EnvironmentRuntimeEntry = {
  sourceUrl: string;
  unitScaleToMeters: number;
  settings: SceneEnvironmentSettings;
  root: TransformNode;
  contentRoot: TransformNode;
  container: AssetContainer;
  renderMeshes: AbstractMesh[];
  transformNodes: TransformNode[];
  materialBaselines: EnvironmentMaterialBaseline[];
  legacyOffset: { x: number; y: number; z: number };
  statistics: EnvironmentModelStatistics;
  bounds: EnvironmentWorldBounds | null;
};

type PendingEnvironmentLoad = {
  key: string;
  sequence: number;
  abortController: AbortController;
  promise: Promise<EnvironmentApplyResult>;
};

const ENVIRONMENT_ADJUSTMENT_BOUNDS_COLOR = '#37C9FF';

function vectorData(vector: Vector3) {
  return { x: vector.x, y: vector.y, z: vector.z };
}

function createAbortError(): Error {
  const error = new Error('环境模型加载请求已被后续操作取消。');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function splitAssetUrl(sourceUrl: string): { rootUrl: string; fileName: string } {
  const lastSlashIndex = sourceUrl.lastIndexOf('/');
  if (lastSlashIndex < 0) return { rootUrl: '', fileName: sourceUrl };
  return {
    rootUrl: sourceUrl.slice(0, lastSlashIndex + 1),
    fileName: sourceUrl.slice(lastSlashIndex + 1),
  };
}

function createLoadKey(environment: SceneEnvironmentSettings, autoAlign: boolean): string {
  return JSON.stringify({ environment, autoAlign });
}

function cloneTransform(transform: SceneEnvironmentTransform): SceneEnvironmentTransform {
  return {
    position: { ...transform.position },
    rotation: { ...transform.rotation },
    scale: transform.scale,
  };
}

function areEnvironmentTransformsEqual(
  left: SceneEnvironmentTransform,
  right: SceneEnvironmentTransform,
): boolean {
  return left.position.x === right.position.x
    && left.position.y === right.position.y
    && left.position.z === right.position.z
    && left.rotation.x === right.rotation.x
    && left.rotation.y === right.rotation.y
    && left.rotation.z === right.rotation.z
    && left.scale === right.scale;
}

/** 独立管理场景级环境模型，封装加载事务、摆放、显示样式和资源释放。 */
export class SceneEnvironmentRuntime {
  private current: EnvironmentRuntimeEntry | null = null;
  private pending: PendingEnvironmentLoad | null = null;
  private loadSequence = 0;
  private adjustmentActive = false;
  private adjustmentBounds: LinesMesh | null = null;
  private snapshot: EnvironmentRuntimeSnapshot = {
    phase: 'idle',
    requestId: null,
    sourceUrl: null,
    message: null,
    bounds: null,
    statistics: null,
  };

  constructor(
    private readonly scene: Scene,
    private readonly options: SceneEnvironmentRuntimeOptions,
  ) {}

  /** 返回当前已提交环境根节点；旧版摆放不开放 Gizmo。 */
  getGizmoTarget(): TransformNode | null {
    if (!this.current || this.current.settings.placementMode !== 'scene-base') return null;
    return this.current.root;
  }

  getSnapshot(): EnvironmentRuntimeSnapshot {
    return this.snapshot;
  }

  getWorldBounds(): EnvironmentWorldBounds | null {
    return this.current?.bounds ?? null;
  }

  /** 设置编辑态调整提示；调整期间保持世界矩阵可更新，结束后重新冻结静态节点。 */
  setAdjustmentActive(active: boolean): void {
    const nextActive = Boolean(
      active
      && this.getGizmoTarget()
      && this.current?.settings.visible
      && this.current.settings.opacity > 0,
    );
    if (this.adjustmentActive === nextActive) return;
    this.adjustmentActive = nextActive;
    if (nextActive) this.unfreezeEntry(this.current);
    else this.freezeEntry(this.current);
    this.refreshAdjustmentBounds();
  }

  /** 同步持久化场景配置；资源变化走事务加载，纯 Transform/显示变化原地更新。 */
  sync(environment: SceneEnvironmentSettings | null): void {
    if (!environment) {
      this.clear();
      return;
    }

    void this.apply(environment, { requestId: null, autoAlign: false }).catch((error) => {
      if (isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.options.pushLog?.(`环境模型加载失败：${message}`);
    });
  }

  /**
   * 预加载候选环境并在成功后原子替换当前环境。
   * 同源配置只更新 Transform、显隐和透明度，不重复解析 GLB。
   */
  apply(
    environment: SceneEnvironmentSettings,
    applyOptions: SceneEnvironmentApplyOptions,
  ): Promise<EnvironmentApplyResult> {
    const normalized = sanitizeSceneEnvironment(environment);
    if (!normalized) return Promise.reject(new Error('环境模型配置无效。'));

    if (
      this.current
      && !applyOptions.autoAlign
      && this.current.sourceUrl === normalized.activeVariantUrl
      && this.current.unitScaleToMeters === normalized.unitScaleToMeters
    ) {
      // 持久化场景重新成为权威状态时，必须取消尚未提交的候选环境。
      this.cancelPendingLoad();
      if (createLoadKey(this.current.settings, false) === createLoadKey(normalized, false)) {
        const snapshot = this.createReadySnapshot(this.current, applyOptions.requestId);
        this.emitSnapshot(snapshot);
        return Promise.resolve({ environment: normalized, snapshot });
      }
      const result = this.applyCurrentSettings(normalized, applyOptions.requestId);
      return Promise.resolve(result);
    }

    const key = createLoadKey(normalized, applyOptions.autoAlign);
    if (this.pending?.key === key) {
      return this.pending.promise.then((result) => ({
        environment: result.environment,
        snapshot: { ...result.snapshot, requestId: applyOptions.requestId },
      }));
    }

    this.cancelPendingLoad();
    const sequence = ++this.loadSequence;
    const abortController = new AbortController();
    this.emitSnapshot({
      ...this.snapshot,
      phase: 'loading',
      requestId: applyOptions.requestId,
      sourceUrl: normalized.activeVariantUrl,
      message: '环境模型正在加载...',
    });

    const promise = this.loadAndSwap(normalized, applyOptions, sequence, abortController.signal)
      .catch((error) => {
        if (sequence !== this.loadSequence || isAbortError(error)) throw createAbortError();
        const message = error instanceof Error ? error.message : String(error);
        this.emitSnapshot({
          phase: 'error',
          requestId: applyOptions.requestId,
          sourceUrl: normalized.activeVariantUrl,
          message,
          bounds: this.current?.bounds ?? null,
          statistics: this.current?.statistics ?? null,
        });
        throw error;
      })
      .finally(() => {
        if (this.pending?.sequence === sequence) this.pending = null;
      });

    this.pending = { key, sequence, abortController, promise };
    return promise;
  }

  clear(): void {
    this.cancelPendingLoad();
    this.disposeEntry(this.current);
    this.current = null;
    this.adjustmentActive = false;
    this.disposeAdjustmentBounds();
    this.emitSnapshot({
      phase: 'idle',
      requestId: null,
      sourceUrl: null,
      message: null,
      bounds: null,
      statistics: null,
    });
  }

  dispose(): void {
    this.clear();
  }

  private async loadAndSwap(
    environment: SceneEnvironmentSettings,
    applyOptions: SceneEnvironmentApplyOptions,
    sequence: number,
    signal: AbortSignal,
  ): Promise<EnvironmentApplyResult> {
    const runtimeUrl = (this.options.resolveAssetUrl ?? resolveRuntimeAssetUrl)(environment.activeVariantUrl);
    const { rootUrl, fileName } = splitAssetUrl(runtimeUrl);
    const container = await this.options.loadAssetContainer(rootUrl, fileName, signal);
    let candidate: EnvironmentRuntimeEntry | null = null;

    try {
      if (sequence !== this.loadSequence) throw createAbortError();
      candidate = this.createCandidateEntry(container, environment, sequence);
      const resolvedEnvironment = this.resolveCandidatePlacement(candidate, environment, applyOptions.autoAlign);
      candidate.settings = resolvedEnvironment;
      this.applyEntryPresentation(candidate, resolvedEnvironment);
      candidate.bounds = this.collectEntryBounds(candidate);
      candidate.statistics = this.collectStatistics(candidate, resolvedEnvironment.fileSizeBytes ?? null);
      this.freezeEntry(candidate);

      if (sequence !== this.loadSequence) throw createAbortError();
      const previous = this.current;
      this.current = candidate;
      candidate = null;
      this.disposeEntry(previous);
      this.applyEntryEnabledState(this.current);
      this.refreshAdjustmentBounds();

      const snapshot = this.createReadySnapshot(this.current, applyOptions.requestId);
      this.emitSnapshot(snapshot);
      return {
        environment: resolvedEnvironment,
        snapshot,
      };
    } catch (error) {
      if (candidate) this.disposeEntry(candidate);
      else container.dispose();
      throw error;
    }
  }

  private createCandidateEntry(
    container: AssetContainer,
    environment: SceneEnvironmentSettings,
    sequence: number,
  ): EnvironmentRuntimeEntry {
    const root = new TransformNode(`EnvironmentRoot_${sequence}`, this.scene);
    const contentRoot = new TransformNode(`EnvironmentContentRoot_${sequence}`, this.scene);

    try {
      root.setEnabled(false);
      contentRoot.parent = root;
      contentRoot.scaling.copyFromFloats(
        environment.unitScaleToMeters,
        environment.unitScaleToMeters,
        environment.unitScaleToMeters,
      );

      const excludedAssets = new Set<object>([
        ...container.cameras,
        ...container.lights,
        ...container.animationGroups,
      ]);
      container.addToScene((asset) => !excludedAssets.has(asset));
      for (const animationGroup of container.animationGroups) animationGroup.stop();

      const allImportedNodes = new Set<TransformNode>([
        ...container.meshes,
        ...container.transformNodes,
      ]);
      for (const node of allImportedNodes) {
        if (!node.parent || !allImportedNodes.has(node.parent as TransformNode)) node.parent = contentRoot;
      }

      const renderMeshes = container.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
      for (const mesh of container.meshes) mesh.isPickable = false;
      const transformNodes = [...new Set<TransformNode>([root, contentRoot, ...allImportedNodes])];
      const materialBaselines = container.materials.map((material) => ({
        material,
        alpha: material.alpha,
        transparencyMode: material.transparencyMode,
        disableDepthWrite: material.disableDepthWrite,
        forceDepthWrite: material.forceDepthWrite,
        needDepthPrePass: material.needDepthPrePass,
      }));

      return {
        sourceUrl: environment.activeVariantUrl,
        unitScaleToMeters: environment.unitScaleToMeters,
        settings: environment,
        root,
        contentRoot,
        container,
        renderMeshes,
        transformNodes,
        materialBaselines,
        legacyOffset: { x: 0, y: 0, z: 0 },
        statistics: this.collectStatisticsFromAssets(container, renderMeshes, environment.fileSizeBytes ?? null),
        bounds: null,
      };
    } catch (error) {
      if (!root.isDisposed()) root.dispose(false, false);
      throw error;
    }
  }

  private resolveCandidatePlacement(
    entry: EnvironmentRuntimeEntry,
    environment: SceneEnvironmentSettings,
    autoAlign: boolean,
  ): SceneEnvironmentSettings {
    this.applyRootTransform(entry.root, {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: 1,
    });
    const neutralBounds = this.collectRuntimeBounds(entry.renderMeshes);
    const legacyOffset = neutralBounds
      ? calculateEnvironmentOriginLeftOffset(neutralBounds.minimum, neutralBounds.maximum)
      : null;
    const fallback = legacyOffset ?? { x: -ENVIRONMENT_FALLBACK_LEFT_OFFSET_METERS, y: 0, z: 0 };
    entry.legacyOffset = { ...fallback };

    if (environment.placementMode === 'legacy-left') {
      const transform: SceneEnvironmentTransform = {
        position: {
          x: fallback.x + environment.transform.position.x,
          y: fallback.y + environment.transform.position.y,
          z: fallback.z + environment.transform.position.z,
        },
        rotation: { ...environment.transform.rotation },
        scale: environment.transform.scale,
      };
      this.applyRootTransform(entry.root, transform);
      return environment;
    }

    if (!autoAlign) {
      this.applyRootTransform(entry.root, environment.transform);
      return environment;
    }

    const offset = neutralBounds
      ? calculateEnvironmentSceneBaseOffset(neutralBounds.minimum, neutralBounds.maximum)
      : null;
    const transform: SceneEnvironmentTransform = {
      position: offset ?? { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: 1,
    };
    this.applyRootTransform(entry.root, transform);
    return sanitizeSceneEnvironment({
      ...environment,
      placementMode: 'scene-base',
      transform,
    }) ?? { ...environment, placementMode: 'scene-base', transform: cloneTransform(transform) };
  }

  private applyCurrentSettings(
    environment: SceneEnvironmentSettings,
    requestId: string | null,
  ): EnvironmentApplyResult {
    const current = this.current;
    if (!current) throw new Error('当前环境模型尚未加载。');
    const transformChanged = current.settings.placementMode !== environment.placementMode
      || !areEnvironmentTransformsEqual(current.settings.transform, environment.transform);

    if (transformChanged) {
      this.unfreezeEntry(current);
      const runtimeTransform = environment.placementMode === 'legacy-left'
        ? {
            ...environment.transform,
            position: {
              x: current.legacyOffset.x + environment.transform.position.x,
              y: current.legacyOffset.y + environment.transform.position.y,
              z: current.legacyOffset.z + environment.transform.position.z,
            },
          }
        : environment.transform;
      this.applyRootTransform(current.root, runtimeTransform);
    }

    this.applyEntryPresentation(current, environment);
    if (transformChanged) current.bounds = this.collectEntryBounds(current);
    const fileSizeBytes = environment.fileSizeBytes ?? null;
    if (current.statistics.fileSizeBytes !== fileSizeBytes) {
      current.statistics = { ...current.statistics, fileSizeBytes };
    }
    if (transformChanged && !this.adjustmentActive) this.freezeEntry(current);
    this.refreshAdjustmentBounds();
    const snapshot = this.createReadySnapshot(current, requestId);
    this.emitSnapshot(snapshot);
    return { environment, snapshot };
  }

  private applyRootTransform(root: TransformNode, transform: SceneEnvironmentTransform): void {
    root.unfreezeWorldMatrix();
    root.position.copyFromFloats(transform.position.x, transform.position.y, transform.position.z);
    root.rotationQuaternion = null;
    root.rotation.copyFromFloats(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    root.scaling.copyFromFloats(transform.scale, transform.scale, transform.scale);
    root.computeWorldMatrix(true);
  }

  private applyEntryPresentation(entry: EnvironmentRuntimeEntry, environment: SceneEnvironmentSettings): void {
    const ghostMode = environment.opacity < 1;
    for (const baseline of entry.materialBaselines) {
      baseline.material.unfreeze();
      baseline.material.alpha = baseline.alpha * environment.opacity;
      baseline.material.transparencyMode = ghostMode
        ? Material.MATERIAL_ALPHABLEND
        : baseline.transparencyMode;
      baseline.material.disableDepthWrite = ghostMode ? true : baseline.disableDepthWrite;
      baseline.material.forceDepthWrite = ghostMode ? false : baseline.forceDepthWrite;
      baseline.material.needDepthPrePass = ghostMode ? false : baseline.needDepthPrePass;
      baseline.material.freeze();
    }
    entry.settings = environment;
    this.applyEntryEnabledState(entry);
  }

  private applyEntryEnabledState(entry: EnvironmentRuntimeEntry): void {
    entry.root.setEnabled(entry.settings.visible && entry.settings.opacity > 0);
  }

  private collectEntryBounds(entry: EnvironmentRuntimeEntry): EnvironmentWorldBounds | null {
    const bounds = this.collectRuntimeBounds(entry.renderMeshes);
    if (!bounds) return null;
    const center = bounds.minimum.add(bounds.maximum).scale(0.5);
    const size = bounds.maximum.subtract(bounds.minimum);
    return {
      minimum: vectorData(bounds.minimum),
      maximum: vectorData(bounds.maximum),
      center: vectorData(center),
      sizeMeters: vectorData(size),
      radiusMeters: size.length() / 2,
    };
  }

  private collectRuntimeBounds(meshes: AbstractMesh[]): RuntimeWorldBounds | null {
    let mergedBounds: RuntimeWorldBounds | null = null;
    for (const mesh of meshes) {
      const bounds = getMeshWorldBounds(mesh);
      if (!bounds) continue;
      mergedBounds = mergedBounds ? mergeWorldBounds(mergedBounds, bounds) : bounds;
    }
    return mergedBounds;
  }

  private collectStatistics(
    entry: EnvironmentRuntimeEntry,
    fileSizeBytes: number | null,
  ): EnvironmentModelStatistics {
    return this.collectStatisticsFromAssets(entry.container, entry.renderMeshes, fileSizeBytes);
  }

  private collectStatisticsFromAssets(
    container: AssetContainer,
    meshes: AbstractMesh[],
    fileSizeBytes: number | null,
  ): EnvironmentModelStatistics {
    let primitiveCount = 0;
    let vertexCount = 0;
    let triangleCount = 0;
    for (const mesh of meshes) {
      const instanceMultiplier = mesh instanceof Mesh && mesh.thinInstanceCount > 0
        ? mesh.thinInstanceCount
        : 1;
      primitiveCount += Math.max(1, mesh.subMeshes?.length ?? 0) * instanceMultiplier;
      vertexCount += mesh.getTotalVertices() * instanceMultiplier;
      const indexCount = mesh.getTotalIndices();
      triangleCount += Math.floor((indexCount > 0 ? indexCount : mesh.getTotalVertices()) / 3) * instanceMultiplier;
    }

    return {
      meshCount: meshes.length,
      primitiveCount,
      vertexCount,
      triangleCount,
      materialCount: container.materials.length + container.multiMaterials.length,
      textureCount: container.textures.length,
      fileSizeBytes,
    };
  }

  private createReadySnapshot(
    entry: EnvironmentRuntimeEntry,
    requestId: string | null,
  ): EnvironmentRuntimeSnapshot {
    return {
      phase: 'ready',
      requestId,
      sourceUrl: entry.sourceUrl,
      message: null,
      bounds: entry.bounds,
      statistics: entry.statistics,
    };
  }

  private emitSnapshot(snapshot: EnvironmentRuntimeSnapshot): void {
    this.snapshot = snapshot;
    this.options.onSnapshot?.(snapshot);
  }

  private freezeEntry(entry: EnvironmentRuntimeEntry | null): void {
    if (!entry || this.adjustmentActive) return;
    for (const node of entry.transformNodes) {
      if (node.isDisposed()) continue;
      node.computeWorldMatrix(true);
      node.freezeWorldMatrix();
    }
  }

  private unfreezeEntry(entry: EnvironmentRuntimeEntry | null): void {
    if (!entry) return;
    for (const node of entry.transformNodes) {
      if (!node.isDisposed()) node.unfreezeWorldMatrix();
    }
  }

  private refreshAdjustmentBounds(): void {
    this.disposeAdjustmentBounds();
    const bounds = this.current?.bounds;
    if (!this.adjustmentActive || !bounds || !this.current?.root.isEnabled()) return;

    const min = bounds.minimum;
    const max = bounds.maximum;
    const inverseRootMatrix = Matrix.Invert(this.current.root.getWorldMatrix());
    const corners = [
      new Vector3(min.x, min.y, min.z),
      new Vector3(max.x, min.y, min.z),
      new Vector3(max.x, max.y, min.z),
      new Vector3(min.x, max.y, min.z),
      new Vector3(min.x, min.y, max.z),
      new Vector3(max.x, min.y, max.z),
      new Vector3(max.x, max.y, max.z),
      new Vector3(min.x, max.y, max.z),
    ].map((corner) => Vector3.TransformCoordinates(corner, inverseRootMatrix));
    const edgePairs = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const lines = edgePairs.map(([from, to]) => [corners[from], corners[to]]);
    const lineMesh = MeshBuilder.CreateLineSystem('__environmentAdjustmentBounds', { lines }, this.scene);
    lineMesh.color = Color3.FromHexString(ENVIRONMENT_ADJUSTMENT_BOUNDS_COLOR);
    lineMesh.alpha = 0.9;
    lineMesh.isPickable = false;
    lineMesh.alwaysSelectAsActiveMesh = true;
    lineMesh.renderingGroupId = 2;
    lineMesh.parent = this.current.root;
    this.adjustmentBounds = lineMesh;
  }

  private disposeAdjustmentBounds(): void {
    this.adjustmentBounds?.dispose();
    this.adjustmentBounds = null;
  }

  private cancelPendingLoad(): void {
    if (!this.pending) return;
    this.loadSequence += 1;
    this.pending.abortController.abort();
    this.pending = null;
  }

  private disposeEntry(entry: EnvironmentRuntimeEntry | null): void {
    if (!entry) return;
    entry.container.dispose();
    if (!entry.root.isDisposed()) entry.root.dispose(false, false);
  }
}
