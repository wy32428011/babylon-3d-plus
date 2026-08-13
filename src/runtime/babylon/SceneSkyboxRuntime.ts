import {
  Color3,
  EXRCubeTexture,
  HDRCubeTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  Texture,
  Vector3,
} from '@babylonjs/core';
import type { TransformComponent } from '../../editor/model/components';
import { normalizeSkyboxSphereScale, SKYBOX_SPHERE_DIAMETER_METERS, type SceneSkyboxSettings } from '../../editor/model/SceneDocument';
import { resolveRuntimeAssetUrl } from '../assets/editorAssetUrl';
import {
  clearSceneSelectionHighlight,
  createSceneSelectionHighlightLayer,
  setSceneSelectionHighlightGroups,
  type SceneSelectionHighlightLayer,
} from './sceneSelectionHighlight';

type SkyboxTexture = HDRCubeTexture | EXRCubeTexture;

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
  texture: SkyboxTexture;
};

const DEFAULT_ENVIRONMENT_INTENSITY = 1;
const LEGACY_SKYBOX_ENTITY_KEY = '__legacy_scene_skybox';
const SKYBOX_PLACEHOLDER_COLOR = Color3.FromHexString('#263d4d');

export function createSceneSkyboxSignature(skybox: SceneSkyboxSettings): string {
  return [skybox.format, skybox.sourceUrl, skybox.assetRevision ?? '', skybox.resolution].join('|');
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
  private readonly selectionHighlightLayer: SceneSelectionHighlightLayer;

  constructor(
    private readonly scene: Scene,
    private readonly pushLog: (message: string) => void = () => undefined,
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
      // 用户在新纹理尚未完成解码时切回当前有效资源，立即释放无效任务，避免继续占用 CPU/GPU。
      if (this.pending && (this.pending.entityKey !== entityKey || this.pending.signature !== signature)) {
        this.cancelPending();
      }
      return;
    }
    if (this.pending?.entityKey === entityKey && this.pending.signature === signature) return;

    this.cancelPending();
    this.startLoad(target, entityKey, signature);
  }

  hasEntity(entityId: string): boolean {
    return this.active?.entityKey === entityId;
  }

  getMesh(entityId: string): Mesh | null {
    return this.hasEntity(entityId) ? this.active?.mesh ?? null : null;
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
        segments: 48,
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
    let texture: SkyboxTexture;
    const onLoad = () => this.commitLoadedSkybox(token, entityKey, signature, texture);
    const onError = (message?: string, exception?: unknown) => {
      this.handleLoadError(token, entityKey, signature, texture, message, exception);
    };

    try {
      texture = target.skybox.format === 'exr'
        ? new EXRCubeTexture(url, this.scene, target.skybox.resolution, false, true, false, true, onLoad, onError)
        : new HDRCubeTexture(url, this.scene, target.skybox.resolution, false, true, false, true, onLoad, onError);
      texture.name = `SceneSkyboxTexture:${signature}`;
      texture.isBlocking = false;
      this.pending = { token, entityKey, signature, texture };
      this.pushLog(`正在加载球形天空盒：${target.skybox.format.toUpperCase()}，${target.skybox.resolution} × ${target.skybox.resolution}。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushLog(`球形天空盒加载启动失败，已保留原有效果：${message}`);
    }
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
      this.applyTarget(active, desired);
      if (previousTexture && previousTexture !== texture) previousTexture.dispose();
      this.pushLog(`球形天空盒已加载：${desired.skybox.format.toUpperCase()}，${desired.skybox.resolution} × ${desired.skybox.resolution}。`);
    } catch (error) {
      if (this.pending?.token === token) this.pending = null;
      texture.dispose();
      const message = error instanceof Error ? error.message : String(error);
      this.pushLog(`球形天空盒材质创建失败，已保留原有效果：${message}`);
    }
  }

  private handleLoadError(
    token: number,
    entityKey: string,
    signature: string,
    texture: SkyboxTexture,
    message?: string,
    exception?: unknown,
  ): void {
    if (
      token !== this.loadToken
      || this.pending?.token !== token
      || this.pending.entityKey !== entityKey
      || this.pending.signature !== signature
    ) {
      if (this.pending?.token === token) this.pending = null;
      texture.dispose();
      return;
    }
    this.pending = null;
    texture.dispose();
    const detail = message?.trim()
      || (exception instanceof Error ? exception.message : exception ? String(exception) : '')
      || 'Babylon 未返回底层错误详情，文件可能损坏或编码不受支持。';
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
    if (active.texture) active.texture.rotationY = rotationY;
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
    this.pending.texture.dispose();
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
