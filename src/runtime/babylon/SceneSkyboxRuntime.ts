import { refreshSceneLightingMaterialDrawCaches } from './refreshDetachedInstanceSourceMaterials.ts';
import { Material } from '@babylonjs/core/Materials/material.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import type { CubeTexture } from '@babylonjs/core/Materials/Textures/cubeTexture.js';
import { Camera } from '@babylonjs/core/Cameras/camera.js';
import { Matrix } from '@babylonjs/core/Maths/math.vector.js';
import type { Observer } from '@babylonjs/core/Misc/observable.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import '@babylonjs/core/Helpers/sceneHelpers.js';
import type { TransformComponent } from '../../editor/model/components';
import type { SceneSkyboxSettings } from '../../editor/model/SceneDocument';
import { normalizeSkyboxEnvironmentResource, skyboxEnvironmentMatchesSource,
  type SkyboxEnvironmentResource, type SkyboxPreparationStage } from '../../../electron/shared/sceneSkyboxContract.ts';
import { loadSkyboxEnvironment, type SkyboxEnvironmentLoadStage } from './skyboxEnvironmentResource.ts';
import { SandboxEnvironmentRuntime, type SandboxEnvironmentOptions } from './SandboxEnvironmentRuntime';

export type SceneSkyboxRuntimeTarget = {
  entityId: string | null;
  skybox: SceneSkyboxSettings;
  transform: TransformComponent;
  visible: boolean;
  pickable?: boolean;
  selected?: boolean;
};
export type SkyboxEnvironmentPrepared = (entityId: string | null, source: SceneSkyboxSettings, environment: SkyboxEnvironmentResource) => void;
export type SkyboxEnvironmentResolver = (source: SceneSkyboxSettings, signal: AbortSignal,
  progress: (stage: SkyboxPreparationStage) => void) => Promise<SkyboxEnvironmentResource>;

type ActiveSkybox = {
  entityKey: string;
  signature: string | null;
  texture: CubeTexture | null;
  environment: SkyboxEnvironmentResource | null;
  mesh: Mesh | null;
  material: PBRMaterial | null;
};
type PendingSkybox = { token: number; entityKey: string; signature: string; controller: AbortController };
export type SkyboxReadiness = { phase: 'idle' | 'loading' | 'ready' | 'error'; message: string | null; sourceUrl: string | null };
export type SkyboxLightingOverrides = { visible: boolean; intensity: number; source?: 'scene' | 'sandbox'; rotationDegrees?: number };
type LoadStage = SkyboxEnvironmentLoadStage | 'preparing';
const DEFAULT_ENVIRONMENT_INTENSITY = 1;
const LEGACY_SKYBOX_ENTITY_KEY = '__legacy_scene_skybox';
const BACKDROP_SIZE = 1000;

export function createSceneSkyboxSignature(skybox: SceneSkyboxSettings): string {
  if (skybox.environment && skyboxEnvironmentMatchesSource(skybox, skybox.environment)) {
    const resource = normalizeSkyboxEnvironmentResource(skybox.environment);
    return ['env', resource.sha256, resource.recipeKey, resource.faceSize].join('|');
  }
  // 旧工程先由编辑器适配器准备；此身份只用于等待去重，不把原图交给运行时纹理加载器。
  const content = /^[a-f\d]{64}$/i.test(skybox.assetRevision ?? '')
    ? `sha256:${skybox.assetRevision!.toLowerCase()}` : `${skybox.sourceUrl}|${skybox.assetRevision ?? ''}`;
  return ['unprepared', skybox.format, content, skybox.resolution].join('|');
}
function getEntityKey(target: SceneSkyboxRuntimeTarget): string { return target.entityId ?? LEGACY_SKYBOX_ENTITY_KEY; }

/** 统一管理原生无限远天空与环境照明；原图准备由编辑器注入，Viewer 没有转换回退。 */
export class SceneSkyboxRuntime {
  private lightingOverrides: SkyboxLightingOverrides | null = null;
  private readonly sandboxEnvironment: SandboxEnvironmentRuntime;
  private environmentResolver: SkyboxEnvironmentResolver | null = null;
  private onEnvironmentPrepared: SkyboxEnvironmentPrepared | undefined;
  private readinessListener: ((state: SkyboxReadiness) => void) | undefined;
  private active: ActiveSkybox | null = null;
  private pending: PendingSkybox | null = null;
  private desired: SceneSkyboxRuntimeTarget | null = null;
  private loadToken = 0;
  private loadError: string | null = null;
  private failedTarget: { entityKey: string; signature: string } | null = null;
  private receivedBytes = 0;
  private totalBytes: number | null = null;
  private loadStage: LoadStage | null = null;
  private preparationStage: SkyboxPreparationStage | null = null;
  private loadTimings: Partial<Record<LoadStage, number>> = {};
  private readonly cameraObserver: Observer<Camera> | null;
  private backdropProjection: Matrix | null = null;
  private backdropProjectionApplied = false;

  constructor(private readonly scene: Scene,
    private readonly pushLog: (message: string) => void = () => undefined,
    private readonly onReadinessChanged: (state: SkyboxReadiness) => void = () => undefined,
    environmentOptions: Pick<SandboxEnvironmentOptions, 'loadTexture'> = {}) {
    this.sandboxEnvironment = new SandboxEnvironmentRuntime(scene, { ...environmentOptions, pushLog: this.pushLog,
      onChanged: () => { this.applyEnvironment(false); this.publishReadiness(this.getReadiness()); } });
    this.cameraObserver = scene.onBeforeCameraRenderObservable?.add(() => {
      this.restoreBackgroundProjection(); this.updateBackdropSize();
    }) ?? null;
  }

  setEnvironmentResolver(resolver: SkyboxEnvironmentResolver, onPrepared?: SkyboxEnvironmentPrepared,
    onReadiness?: (state: SkyboxReadiness) => void): void {
    this.environmentResolver = resolver; this.onEnvironmentPrepared = onPrepared; this.readinessListener = onReadiness;
  }
  private publishReadiness(state: SkyboxReadiness): void {
    this.onReadinessChanged(state);
    this.readinessListener?.(state);
  }

  setLightingOverrides(value: SkyboxLightingOverrides | null): void {
    const neededBefore = this.requiresSkybox();
    const sourceChanged = (this.lightingOverrides?.source ?? 'scene') !== (value?.source ?? 'scene');
    const lightingChanged = this.lightingOverrides?.intensity !== value?.intensity;
    this.lightingOverrides = value;
    this.sandboxEnvironment.sync(value?.source === 'sandbox', value?.rotationDegrees ?? 0);
    if (this.active && this.desired) this.applyTarget(this.active, this.desired, false);
    if ((sourceChanged || lightingChanged) && (sourceChanged || value?.source === 'sandbox' || (this.active && this.desired))) this.applyEnvironment(true);
    if (this.desired && neededBefore !== this.requiresSkybox()) this.sync(this.desired);
  }

  sync(target: SceneSkyboxRuntimeTarget | null): void {
    this.desired = target;
    if (!target) {
      this.cancelPending(); this.disposeActive(true); this.loadError = null; this.failedTarget = null;
      this.publishReadiness(this.getReadiness()); return;
    }
    const entityKey = getEntityKey(target);
    if (this.active?.entityKey !== entityKey) {
      this.cancelPending(); this.disposeActive(true); this.active = this.createActiveSkybox(entityKey);
    }
    if (!this.active) return;
    this.applyTarget(this.active, target);
    if (!this.requiresSkybox()) {
      this.cancelPending(); this.publishReadiness(this.getReadiness()); return;
    }
    const signature = createSceneSkyboxSignature(target.skybox);
    if (this.active.texture && (this.active.signature === signature
      || (target.skybox.environment?.sha256 === this.active.environment?.sha256 && target.skybox.environment?.faceSize === target.skybox.resolution))) {
      this.active.signature = signature;
      const hadError = this.loadError !== null;
      this.loadError = null; this.failedTarget = null;
      if (this.pending && (this.pending.entityKey !== entityKey || this.pending.signature !== signature)) {
        this.cancelPending(); this.publishReadiness(this.getReadiness());
      }
      if (hadError) this.publishReadiness(this.getReadiness());
      else this.readinessListener?.(this.getReadiness());
      return;
    }
    if (this.pending?.entityKey === entityKey && this.pending.signature === signature) return;
    if (this.failedTarget?.entityKey === entityKey && this.failedTarget.signature === signature) return;
    this.cancelPending(); this.startLoad(target, entityKey, signature);
  }

  hasEntity(entityId: string): boolean { return this.active?.entityKey === entityId; }
  getMesh(entityId: string): Mesh | null { return this.hasEntity(entityId) ? this.active?.mesh ?? null : null; }
  getReadiness(): SkyboxReadiness {
    const environment = this.sandboxEnvironment.getReadiness();
    if (!this.requiresSkybox()) return environment;
    if (environment.phase === 'error') return environment;
    if (this.loadError && this.desired) return { phase: 'error', message: this.loadError, sourceUrl: this.readSourceUrl() };
    if (environment.phase === 'loading') return environment;
    return { phase: this.pending ? 'loading' : this.active?.texture ? 'ready' : environment.phase,
      message: null, sourceUrl: this.readSourceUrl() };
  }
  retry(): void {
    this.sandboxEnvironment.retry();
    if (!this.loadError || this.pending || !this.desired || !this.requiresSkybox()) return;
    this.startLoad(this.desired, getEntityKey(this.desired), createSceneSkyboxSignature(this.desired.skybox));
  }
  getLoadDiagnostics() {
    return { receivedBytes: this.receivedBytes, totalBytes: this.totalBytes, stage: this.pending || this.loadError ? this.loadStage : null,
      timings: { ...this.loadTimings }, preparationStage: this.preparationStage, decoded: null };
  }
  dispose(): void {
    this.desired = null; this.cancelPending();
    if (this.cameraObserver) this.scene.onBeforeCameraRenderObservable.remove(this.cameraObserver);
    if (this.scene.environmentTexture === this.sandboxEnvironment.getTexture()) this.updateEnvironmentTexture(null);
    this.sandboxEnvironment.dispose(); this.disposeActive(true);
  }
  private requiresSkybox(): boolean {
    return Boolean(this.desired?.visible && ((this.lightingOverrides?.visible ?? true) || this.lightingOverrides?.source !== 'sandbox'));
  }
  private readSourceUrl(): string | null { return this.desired?.skybox.environment?.sourceUrl ?? this.desired?.skybox.sourceUrl ?? null; }
  private createActiveSkybox(entityKey: string): ActiveSkybox {
    return { entityKey, signature: null, texture: null, environment: null, mesh: null, material: null };
  }

  private startLoad(target: SceneSkyboxRuntimeTarget, entityKey: string, signature: string): void {
    const token = ++this.loadToken, controller = new AbortController();
    this.loadError = null; this.failedTarget = null; this.loadStage = null; this.preparationStage = null;
    this.loadTimings = {}; this.receivedBytes = 0; this.totalBytes = null;
    this.pending = { token, entityKey, signature, controller };
    this.publishReadiness(this.getReadiness());
    let environment: SkyboxEnvironmentResource;
    const load = (resource: SkyboxEnvironmentResource) => {
      controller.signal.throwIfAborted();
      environment = normalizeSkyboxEnvironmentResource(resource);
      if (!skyboxEnvironmentMatchesSource(target.skybox, environment)) throw new Error('天空 ENV 与当前源版本或分辨率不一致。');
      this.preparationStage = null;
      return loadSkyboxEnvironment(this.scene.getEngine(), environment, controller.signal,
        (received, total) => { if (!controller.signal.aborted && token === this.loadToken) { this.receivedBytes = received; this.totalBytes = total; } },
        (stage, duration) => {
          if (controller.signal.aborted || token !== this.loadToken) return;
          this.loadStage = stage;
          if (duration !== null) this.loadTimings[stage] = duration;
          this.publishReadiness(this.getReadiness());
        });
    };
    try {
      let loading: Promise<CubeTexture>;
      if (this.environmentResolver) {
        this.loadStage = 'preparing';
        const started = performance.now();
        loading = this.environmentResolver(target.skybox, controller.signal, stage => {
          if (controller.signal.aborted || token !== this.loadToken) return;
          this.preparationStage = stage; this.publishReadiness(this.getReadiness());
        }).then(resource => { this.loadTimings.preparing = performance.now() - started; return load(resource); });
      } else {
        if (!target.skybox.environment) throw new Error('天空缺少预过滤 ENV 产物，请在新版编辑器中准备资源并重新发布。');
        loading = load(target.skybox.environment);
      }
      void loading.then(texture => this.commitLoadedSkybox(token, entityKey, signature, texture, environment))
        .catch(error => { if (!controller.signal.aborted && token === this.loadToken) this.handleLoadError(token, entityKey, signature, error); });
    } catch (error) { this.handleLoadError(token, entityKey, signature, error); }
  }

  private commitLoadedSkybox(token: number, entityKey: string, signature: string, texture: CubeTexture, environment: SkyboxEnvironmentResource): void {
    const desired = this.desired, previous = this.active;
    if (!desired || !previous || token !== this.loadToken || this.pending?.token !== token
      || previous.entityKey !== entityKey || getEntityKey(desired) !== entityKey || createSceneSkyboxSignature(desired.skybox) !== signature) {
      if (this.pending?.token === token) this.pending = null;
      texture.dispose(); return;
    }
    const candidate: ActiveSkybox = { entityKey, signature, texture, environment, mesh: null, material: null };
    try {
      this.installReflectionTexture(candidate, texture);
      this.applyTarget(candidate, desired, false);
      this.active = candidate;
      this.applyEnvironment(true);
      this.onEnvironmentPrepared?.(desired.entityId, desired.skybox, environment);
      this.pending = null; this.loadError = null; this.failedTarget = null;
      previous.mesh?.dispose(false, true);
      if (previous.texture !== texture) previous.texture?.dispose();
      this.publishReadiness(this.getReadiness());
      this.pushLog(`原生无限远天空已加载：ENV，${environment.faceSize} × ${environment.faceSize}。`);
    } catch (error) {
      this.active = previous; candidate.mesh?.dispose(false, true); texture.dispose();
      this.applyEnvironment(false);
      this.handleLoadError(token, entityKey, signature, error);
    }
  }
  private handleLoadError(token: number, entityKey: string, signature: string, exception: unknown): void {
    if (token !== this.loadToken || this.pending?.token !== token || this.pending.entityKey !== entityKey || this.pending.signature !== signature) return;
    this.pending = null;
    const detail = (exception instanceof Error ? exception.message : exception ? String(exception) : '') || '天空 ENV 读取或上传失败。';
    this.loadError = detail; this.failedTarget = { entityKey, signature };
    this.publishReadiness(this.getReadiness());
    this.pushLog(`天空背景加载失败，已保留原有效果：${detail}`);
  }
  private installReflectionTexture(active: ActiveSkybox, texture: CubeTexture): void {
    const mesh = this.scene.createDefaultSkybox(texture, true, BACKDROP_SIZE, 0, false);
    if (!mesh || !(mesh.material instanceof PBRMaterial)) throw new Error('Babylon 原生天空盒创建失败。');
    mesh.name = 'SceneInfiniteSkybox';
    mesh.isPickable = false;
    // 旧排除器兼容标记保留，避免阴影/碰撞插件把背景纳入业务几何。
    mesh.metadata = { runtimeSkybox: true, editorSkyboxSphere: true };
    mesh.material.disableDepthWrite = true;
    mesh.onBeforeBindObservable.add(() => this.applyBackgroundProjection());
    mesh.onAfterRenderObservable.add(() => this.restoreBackgroundProjection());
    active.mesh = mesh; active.material = mesh.material;
  }
  private applyTarget(active: ActiveSkybox, target: SceneSkyboxRuntimeTarget, updateEnvironment = true): void {
    active.mesh?.setEnabled(target.visible && (this.lightingOverrides?.visible ?? true));
    const rotationY = target.skybox.rotationDegrees * Math.PI / 180;
    if (active.texture && active.texture.rotationY !== rotationY) {
      active.texture.rotationY = rotationY;
      this.scene.markAllMaterialsAsDirty(Material.TextureDirtyFlag);
      if (this.scene.environmentTexture === active.texture) refreshSceneLightingMaterialDrawCaches(this.scene);
    }
    const reflection = active.material?.reflectionTexture as CubeTexture | null;
    if (reflection) reflection.rotationY = rotationY;
    this.updateBackdropSize(active);
    if (updateEnvironment && this.lightingOverrides?.source !== 'sandbox') this.applyEnvironment(true);
  }
  private updateBackdropSize(active = this.active): void {
    const camera = this.scene.activeCamera;
    if (!active?.mesh || !camera) return;
    const ortho = camera.mode === Camera.ORTHOGRAPHIC_CAMERA
      ? Math.max(Math.abs(camera.orthoLeft ?? 0), Math.abs(camera.orthoRight ?? 0), Math.abs(camera.orthoTop ?? 0), Math.abs(camera.orthoBottom ?? 0)) * 4 : 0;
    const size = Math.max(BACKDROP_SIZE, Number.isFinite(camera.maxZ) ? camera.maxZ * 4 : 0, camera.minZ * 16, ortho);
    const scale = size / BACKDROP_SIZE;
    if (active.mesh.scaling.x !== scale) active.mesh.scaling.setAll(scale);
  }
  /** 无限远方向背景使用透视投影；只替换本次背景 draw 的矩阵，不改变正交业务相机。 */
  private applyBackgroundProjection(): void {
    const camera = this.scene.activeCamera;
    if (!camera || camera.mode !== Camera.ORTHOGRAPHIC_CAMERA) return;
    const originalMode = camera.mode;
    try {
      camera.mode = Camera.PERSPECTIVE_CAMERA;
      (this.backdropProjection ??= Matrix.Identity()).copyFrom(camera.getProjectionMatrix(true));
    } finally {
      camera.mode = originalMode;
      camera.getProjectionMatrix(true);
    }
    this.scene.setTransformMatrix(camera.getViewMatrix(), this.backdropProjection!);
    this.backdropProjectionApplied = true;
  }
  private restoreBackgroundProjection(): void {
    if (!this.backdropProjectionApplied) return;
    this.backdropProjectionApplied = false;
    this.scene.updateTransformMatrix(true);
  }
  private applyEnvironment(updateIntensity: boolean): void {
    const sandbox = this.lightingOverrides?.source === 'sandbox';
    const texture = sandbox ? this.sandboxEnvironment.getTexture() : this.desired?.visible ? this.active?.texture ?? null : null;
    const intensity = updateIntensity ? this.lightingOverrides?.intensity
      ?? (this.desired?.visible ? this.desired.skybox.intensity : DEFAULT_ENVIRONMENT_INTENSITY) : undefined;
    this.updateEnvironmentTexture(texture, intensity);
  }
  private updateEnvironmentTexture(texture: Scene['environmentTexture'], intensity?: number): void {
    const changed = this.scene.environmentTexture !== texture || (intensity !== undefined && this.scene.environmentIntensity !== intensity);
    this.scene.environmentTexture = texture;
    if (intensity !== undefined) this.scene.environmentIntensity = intensity;
    if (changed) refreshSceneLightingMaterialDrawCaches(this.scene);
  }
  private cancelPending(): void { this.loadToken++; this.pending?.controller.abort(); this.pending = null; }
  private disposeActive(resetScene: boolean): void {
    const active = this.active; this.active = null;
    if (resetScene && this.lightingOverrides?.source !== 'sandbox' && (!active || this.scene.environmentTexture === active.texture)) {
      this.updateEnvironmentTexture(null, this.lightingOverrides?.intensity ?? DEFAULT_ENVIRONMENT_INTENSITY);
    }
    active?.mesh?.dispose(false, true); active?.texture?.dispose();
  }
}
