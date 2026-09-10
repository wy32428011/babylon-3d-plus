import {
  Color3,
  EXRCubeTexture,
  EnvCubeTexture,
  HDRCubeTexture,
  HDRFiltering,
  Material,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  Texture,
  Vector3,
} from '@babylonjs/core';
import type { TransformComponent } from '../../editor/model/components';
import {
  normalizeSkyboxSphereScale,
  SKYBOX_SPHERE_DIAMETER_METERS,
  SKYBOX_SPHERE_SEGMENTS,
  type SceneSkyboxSettings,
} from '../../editor/model/SceneDocument';
import { resolveRuntimeAssetUrl } from '../assets/editorAssetUrl';
import { loadSkyboxTexture, type SkyboxLoadStage } from './skyboxTextureLoad';
import { prepareSkyboxData, type SkyboxDecodeMetrics } from './skyboxDecodedData';
import { PreparedSkyboxTexture } from './PreparedSkyboxTexture';
import { waitForSkyboxPrefilter } from './skyboxPrefilter';
import type { CubeMapInfo } from '@babylonjs/core/Misc/HighDynamicRange/panoramaToCubemap.js';
import {
  clearSceneSelectionHighlight,
  createSceneSelectionHighlightLayer,
  setSceneSelectionHighlightGroups,
  type SceneSelectionHighlightLayer,
} from './sceneSelectionHighlight';

type SkyboxTexture = EnvCubeTexture;

export type SceneSkyboxRuntimeTarget = {
  entityId: string | null;
  skybox: SceneSkyboxSettings;
  transform: TransformComponent;
  visible: boolean;
  pickable: boolean;
  selected: boolean;
};

type ActiveSkybox = {
  entityKey: string;
  signature: string | null;
  texture: SkyboxTexture | null;
  mesh: Mesh;
  material: PBRMaterial;
};

type PendingSkybox = {
  token: number;
  entityKey: string;
  signature: string;
  controller: AbortController;
};

export type SkyboxReadiness = { phase: 'idle' | 'loading' | 'ready' | 'error'; message: string | null; sourceUrl: string | null };

const DEFAULT_ENVIRONMENT_INTENSITY = 1;
const LEGACY_SKYBOX_ENTITY_KEY = '__legacy_scene_skybox';
const SKYBOX_PLACEHOLDER_COLOR = Color3.FromHexString('#263d4d');

export function createSceneSkyboxSignature(skybox: SceneSkyboxSettings): string {
  // 完整内容哈希可跨 SOURCE/共享缓存路径复用；弱修订仍按 URL 隔离。
  const content = /^[a-f\d]{64}$/i.test(skybox.assetRevision ?? '')
    ? `sha256:${skybox.assetRevision!.toLowerCase()}` : `${skybox.sourceUrl}|${skybox.assetRevision ?? ''}`;
  return [skybox.format, content, skybox.resolution].join('|');
}

function createVersionedRuntimeUrl(skybox: SceneSkyboxSettings): string {
  const runtimeUrl = resolveRuntimeAssetUrl(skybox.sourceUrl);
  const hashIndex = runtimeUrl.indexOf('#');
  const urlWithoutHash = hashIndex >= 0 ? runtimeUrl.slice(0, hashIndex) : runtimeUrl;
  const hash = hashIndex >= 0 ? runtimeUrl.slice(hashIndex) : '';
  const query = [
    ...(skybox.assetRevision ? [`assetRevision=${encodeURIComponent(skybox.assetRevision)}`] : []),
    `skyboxResolution=${skybox.resolution}`,
  ].join('&');
  return `${urlWithoutHash}${urlWithoutHash.includes('?') ? '&' : '?'}${query}${hash}`;
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function getEntityKey(target: SceneSkyboxRuntimeTarget): string {
  return target.entityId ?? LEGACY_SKYBOX_ENTITY_KEY;
}

/** 管理可移动球形 HDR/EXR 天空盒、异步纹理替换和 PBR 环境照明。 */
export class SceneSkyboxRuntime {
  private active: ActiveSkybox | null = null;
  private pending: PendingSkybox | null = null;
  private desired: SceneSkyboxRuntimeTarget | null = null;
  private loadToken = 0;
  private loadError: string | null = null;
  private failedTarget: { entityKey: string; signature: string } | null = null;
  private loadStage: SkyboxLoadStage | null = null;
  private loadTimings: Partial<Record<SkyboxLoadStage, number>> = {};
  private decodedDataMetrics: SkyboxDecodeMetrics | null = null;
  private readonly selectionHighlightLayer: SceneSelectionHighlightLayer;

  constructor(
    private readonly scene: Scene,
    private readonly pushLog: (message: string) => void = () => undefined,
    private readonly onReadinessChanged: (state: SkyboxReadiness) => void = () => undefined,
  ) {
    this.selectionHighlightLayer = createSceneSelectionHighlightLayer(
      scene,
      'EditorSkyboxSelectionHighlightLayer',
      this.pushLog,
    );
  }

  sync(target: SceneSkyboxRuntimeTarget | null): void {
    this.desired = target;
    if (!target) {
      this.cancelPending();
      this.disposeActive(true);
      this.loadError = null;
      this.failedTarget = null;
      this.onReadinessChanged(this.getReadiness());
      return;
    }

    const entityKey = getEntityKey(target);
    if (this.active?.entityKey !== entityKey) {
      this.cancelPending();
      this.disposeActive(true);
      this.active = this.createActiveSkybox(entityKey, target.entityId);
    }
    if (!this.active) return;

    this.applyTarget(this.active, target);
    const signature = createSceneSkyboxSignature(target.skybox);
    if (this.active.signature === signature && this.active.texture) {
      const hadError = this.loadError !== null;
      this.loadError = null;
      this.failedTarget = null;
      // 用户在新纹理尚未完成解码时切回当前有效资源，立即释放无效任务，避免继续占用 CPU/GPU。
      if (this.pending && (this.pending.entityKey !== entityKey || this.pending.signature !== signature)) {
        this.cancelPending();
        this.onReadinessChanged(this.getReadiness());
      }
      if (hadError) this.onReadinessChanged(this.getReadiness());
      return;
    }
    if (this.pending?.entityKey === entityKey && this.pending.signature === signature) return;
    if (this.failedTarget?.entityKey === entityKey && this.failedTarget.signature === signature) return;

    this.cancelPending();
    this.startLoad(target, entityKey, signature);
  }

  hasEntity(entityId: string): boolean {
    return this.active?.entityKey === entityId;
  }

  getMesh(entityId: string): Mesh | null {
    return this.hasEntity(entityId) ? this.active?.mesh ?? null : null;
  }

  getReadiness(): SkyboxReadiness {
    if (!this.desired) return { phase: 'idle', message: null, sourceUrl: null };
    return { phase: this.pending ? 'loading' : this.loadError ? 'error' : this.active?.texture ? 'ready' : 'idle',
      message: this.loadError, sourceUrl: this.desired.skybox.sourceUrl };
  }

  retry(): void {
    if (!this.loadError || this.pending || !this.desired) return;
    this.startLoad(this.desired, getEntityKey(this.desired), createSceneSkyboxSignature(this.desired.skybox));
  }

  getLoadDiagnostics() {
    return { stage: this.pending || this.loadError ? this.loadStage : null, timings: { ...this.loadTimings }, decoded: this.decodedDataMetrics };
  }

  dispose(): void {
    this.desired = null;
    this.cancelPending();
    this.disposeActive(true);
    this.selectionHighlightLayer.dispose();
  }

  private createActiveSkybox(entityKey: string, entityId: string | null): ActiveSkybox {
    const mesh = MeshBuilder.CreateSphere(
      entityId ? `${entityId}_skyboxSphere` : 'LegacySceneSkyboxSphere',
      {
        diameter: SKYBOX_SPHERE_DIAMETER_METERS,
        segments: SKYBOX_SPHERE_SEGMENTS,
        sideOrientation: Mesh.DOUBLESIDE,
      },
      this.scene,
    );
    const material = new PBRMaterial(
      entityId ? `${entityId}_skyboxMaterial` : 'LegacySceneSkyboxMaterial',
      this.scene,
    );
    material.backFaceCulling = false;
    material.disableLighting = true;
    material.twoSidedLighting = true;
    material.microSurface = 1;
    material.albedoColor = SKYBOX_PLACEHOLDER_COLOR;
    material.emissiveColor = SKYBOX_PLACEHOLDER_COLOR.scale(0.35);
    mesh.material = material;
    mesh.metadata = { ...(mesh.metadata ?? {}), ...(entityId ? { editorEntityId: entityId } : {}), editorSkyboxSphere: true };
    mesh.isPickable = Boolean(entityId);
    mesh.renderOutline = false;
    return { entityKey, signature: null, texture: null, mesh, material };
  }

  private startLoad(target: SceneSkyboxRuntimeTarget, entityKey: string, signature: string): void {
    const token = ++this.loadToken;
    const url = createVersionedRuntimeUrl(target.skybox);
    const controller = new AbortController();
    const engine = this.scene.getEngine();
    this.loadError = null;
    this.failedTarget = null;
    this.loadStage = null;
    this.loadTimings = {};
    this.decodedDataMetrics = null;
    let preparedData: CubeMapInfo | null = null;
    this.pending = { token, entityKey, signature, controller };
    this.onReadinessChanged(this.getReadiness());
    this.pushLog(`正在加载球形天空盒：${target.skybox.format.toUpperCase()}，${target.skybox.resolution} × ${target.skybox.resolution}。`);
    void loadSkyboxTexture<SkyboxTexture>(url, controller.signal, {
      transformBlob: async (blob, signal) => {
        preparedData = await prepareSkyboxData(blob, target.skybox.format, target.skybox.resolution, signal, {
          onMetrics: metrics => {
            if (!signal.aborted && token === this.loadToken) this.decodedDataMetrics = metrics;
          },
        });
        // 预解码子类不再读取原始 EXR，极小的 Blob 仅用于驱动 Babylon 的原有上传回调。
        return preparedData ? new Blob([new Uint8Array(1)]) : blob;
      },
      onStage: (stage, durationMs) => {
        if (controller.signal.aborted || token !== this.loadToken) return;
        this.loadStage = stage;
        if (durationMs !== null) this.loadTimings[stage] = durationMs;
        this.onReadinessChanged(this.getReadiness());
      },
      create: (blobUrl, onLoad, onError) => {
        // 传入 Engine，避免 Babylon 在提前 dispose 时遗留纹理及预过滤 pending token。
        const texture = preparedData
          ? new PreparedSkyboxTexture(blobUrl, engine, target.skybox.resolution, preparedData, target.skybox.format, onLoad, onError)
          : target.skybox.format === 'exr'
          ? new EXRCubeTexture(blobUrl, engine, target.skybox.resolution, false, true, false, false, onLoad, onError)
          : new HDRCubeTexture(blobUrl, engine, target.skybox.resolution, false, true, false, false, onLoad, onError);
        texture.name = `SceneSkyboxTexture:${signature}`;
        texture.isBlocking = false;
        return texture;
      },
      prepare: async texture => {
        // 保持原来的 4096 采样预过滤质量，在可捕获异常的任务内执行。
        if (engine._features.allowTexturePrefiltering) {
          await waitForSkyboxPrefilter(engine, () => new HDRFiltering(engine).prefilter(texture));
        }
      },
    }).then(texture => this.commitLoadedSkybox(token, entityKey, signature, texture))
      .catch(error => {
        if (controller.signal.aborted || token !== this.loadToken) return;
        this.handleLoadError(token, entityKey, signature, error);
      });
  }

  private commitLoadedSkybox(
    token: number,
    entityKey: string,
    signature: string,
    texture: SkyboxTexture,
  ): void {
    const desired = this.desired;
    const active = this.active;
    if (
      !desired
      || !active
      || token !== this.loadToken
      || this.pending?.token !== token
      || active.entityKey !== entityKey
      || getEntityKey(desired) !== entityKey
      || createSceneSkyboxSignature(desired.skybox) !== signature
    ) {
      if (this.pending?.token === token) this.pending = null;
      texture.dispose();
      return;
    }

    try {
      const previousTexture = active.texture;
      this.installReflectionTexture(active, texture);
      active.texture = texture;
      active.signature = signature;
      this.pending = null;
      this.loadError = null;
      this.applyTarget(active, desired);
      if (previousTexture && previousTexture !== texture) previousTexture.dispose();
      this.onReadinessChanged(this.getReadiness());
      this.pushLog(`球形天空盒已加载：${desired.skybox.format.toUpperCase()}，${desired.skybox.resolution} × ${desired.skybox.resolution}。`);
    } catch (error) {
      if (this.pending?.token === token) this.pending = null;
      texture.dispose();
      const message = error instanceof Error ? error.message : String(error);
      this.loadError = message;
      this.failedTarget = { entityKey, signature };
      this.onReadinessChanged(this.getReadiness());
      this.pushLog(`球形天空盒材质创建失败，已保留原有效果：${message}`);
    }
  }

  private handleLoadError(
    token: number,
    entityKey: string,
    signature: string,
    exception: unknown,
  ): void {
    if (
      token !== this.loadToken
      || this.pending?.token !== token
      || this.pending.entityKey !== entityKey
      || this.pending.signature !== signature
    ) {
      if (this.pending?.token === token) this.pending = null;
      return;
    }
    this.pending = null;
    const detail = (exception instanceof Error ? exception.message : exception ? String(exception) : '')
      || 'Babylon 未返回底层错误详情，文件可能损坏或编码不受支持。';
    this.loadError = detail;
    this.failedTarget = { entityKey, signature };
    this.onReadinessChanged(this.getReadiness());
    this.pushLog(`球形天空盒加载失败，已保留原有效果：${detail}`);
  }

  private installReflectionTexture(active: ActiveSkybox, texture: SkyboxTexture): void {
    const previousReflection = active.material.reflectionTexture;
    const reflectionTexture = texture.clone();
    reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;
    reflectionTexture.level = 1;
    active.material.reflectionTexture = reflectionTexture;
    active.material.albedoColor = Color3.Black();
    active.material.emissiveColor = Color3.Black();
    if (previousReflection && previousReflection !== reflectionTexture) previousReflection.dispose();
  }

  private applyTarget(active: ActiveSkybox, target: SceneSkyboxRuntimeTarget): void {
    const transform = target.transform;
    active.mesh.position = new Vector3(transform.position.x, transform.position.y, transform.position.z);
    active.mesh.rotationQuaternion = null;
    active.mesh.rotation = new Vector3(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    const scale = normalizeSkyboxSphereScale(transform.scale);
    active.mesh.scaling = new Vector3(scale.x, scale.y, scale.z);
    active.mesh.setEnabled(target.visible);
    active.mesh.isPickable = target.visible && target.pickable && Boolean(target.entityId);
    this.syncSelectionHighlight(active.mesh, target.visible && target.selected);

    const rotationY = degreesToRadians(target.skybox.rotationDegrees);
    if (active.texture && active.texture.rotationY !== rotationY) {
      active.texture.rotationY = rotationY;
      // Engine 纹理没有所属 Scene，旋转后显式刷新接收环境照明的材质。
      this.scene.markAllMaterialsAsDirty(Material.TextureDirtyFlag);
    }
    const reflectionTexture = active.material.reflectionTexture as SkyboxTexture | null;
    if (reflectionTexture) reflectionTexture.rotationY = rotationY;

    if (active.texture && target.visible) {
      this.scene.environmentTexture = active.texture;
      this.scene.environmentIntensity = target.skybox.intensity;
    } else if (this.scene.environmentTexture === active.texture) {
      this.scene.environmentTexture = null;
      this.scene.environmentIntensity = DEFAULT_ENVIRONMENT_INTENSITY;
    }
  }

  private cancelPending(): void {
    this.loadToken += 1;
    if (!this.pending) return;
    this.pending.controller.abort();
    this.pending = null;
  }

  private disposeActive(resetScene: boolean): void {
    const active = this.active;
    if (!active) {
      if (resetScene) {
        this.scene.environmentTexture = null;
        this.scene.environmentIntensity = DEFAULT_ENVIRONMENT_INTENSITY;
      }
      return;
    }

    this.active = null;
    if (resetScene && this.scene.environmentTexture === active.texture) {
      this.scene.environmentTexture = null;
      this.scene.environmentIntensity = DEFAULT_ENVIRONMENT_INTENSITY;
    }
    this.clearSelectionHighlight();
    active.mesh.dispose(false, true);
    active.texture?.dispose();
  }

  /** 天空盒与普通模型共享同一深红光晕主题，但使用独立选择层避免污染模型分组。 */
  private syncSelectionHighlight(mesh: Mesh, selected: boolean): void {
    if (!selected || mesh.isDisposed() || mesh.getTotalVertices() <= 0) {
      this.clearSelectionHighlight();
      return;
    }

    setSceneSelectionHighlightGroups(this.selectionHighlightLayer, [[mesh]]);
  }

  private clearSelectionHighlight(): void {
    clearSceneSelectionHighlight(this.selectionHighlightLayer, this.scene);
  }
}
