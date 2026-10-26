import { ModelEntranceRuntime } from '../ModelEntranceRuntime';
import { normalizeSceneModelEntranceSettings, type SceneModelEntranceSettings } from '../../../editor/model/sceneModelEntrance';
import { ENVIRONMENT_EFFECT_TARGET_ID } from '../../../editor/model/environmentBuildingEffect';
import { AlarmManagerRuntime, type AlarmActivation } from '../AlarmManagerRuntime';
import { ChartMarkerPresentation, getChartMarkerStyle, getChartMarkerText } from '../ChartMarkerPresentation';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Quaternion } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { EditorClickEventBindingRuntime } from '../EditorClickEventBindingRuntime';
import { PoiEffectRuntime } from '../effects/PoiEffectRuntime';
import type { EffectRuntimeTarget } from '../../../editor/model/effectConfiguration';
import { describeGeneratedEffectTarget } from '../GeneratedEffectTargets';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import type { SceneTelemetryController } from './SceneTelemetryController';
import type { GeneratedModelOutputController } from './GeneratedModelOutputController';
import type { SceneLocatorFetchController } from './SceneLocatorFetchController';
import type { EnvironmentAndSkyboxController } from './EnvironmentAndSkyboxController';
import type { SceneDocumentController } from './SceneDocumentController';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { ParameterVariantHostPool } from './ParameterVariantHostPool';
import type { SceneTriangleAndReadinessController } from './SceneTriangleAndReadinessController';
import type { SceneWorldBoundsController } from './SceneWorldBoundsController';
import { type DataPlatformScreenOverlayItem } from './sceneRuntimeTypes';
import { awaitLightingTaskStep } from '../lightingBakeTask';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly telemetry: Pick<SceneTelemetryController, 'telemetryPreviewActive'>;
  readonly outputs: Pick<GeneratedModelOutputController, 'generatedOutputOwners'>;
  readonly fetch: Pick<SceneLocatorFetchController, 'locatorFetchRuntimes'>;
  readonly environment: Pick<EnvironmentAndSkyboxController, 'environmentRuntime' | 'lightingRuntime'>;
  readonly document: Pick<SceneDocumentController, 'syncedEntities' | 'isEntityVisible'>;
  readonly assets: Pick<ModelAssetRuntimeController, 'models'>;
  readonly presentation: Pick<SceneMeshPresentationController, 'meshes'>;
  readonly variants: Pick<ParameterVariantHostPool, 'modelArrayParameterVariants'>;
  readonly readiness: Pick<SceneTriangleAndReadinessController, 'loadDiagnostics'>;
  readonly bounds: Pick<SceneWorldBoundsController, 'getEntityWorldBounds'>;
};


/** ScenePoiAndEffectsController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class ScenePoiAndEffectsController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  public readonly chartMarkerPresentation = new ChartMarkerPresentation();
  public alarmRuntime!: AlarmManagerRuntime;
  public modelEntranceRuntime!: ModelEntranceRuntime;
  public modelEntranceVisible = true;
  public modelEntranceIncludesEnvironment = false;
  get onAlarmActivated(): ((event: AlarmActivation) => void) | undefined { return this.context.onAlarmActivated; }
  set onAlarmActivated(callback: ((event: AlarmActivation) => void) | undefined) { this.context.onAlarmActivated = callback; }
  isAlarmActive(managerId: string, targetId: string): boolean { return this.alarmRuntime.isActive(managerId, targetId); }
  public readonly alarmManagerIds = new Set<string>();
  public readonly dataPlatformScreenTextures = new Map<string, { url: string; texture: Texture }>();
  public clickEventBindingRuntime!: EditorClickEventBindingRuntime;
  public readonly effectPoseNodes = new Map<string, TransformNode>();
  public poiEffectRuntime!: PoiEffectRuntime;
  public openingCameraOwned = false;

  /** 运行态目录按绑定器节流读取；普通编辑实体仍由绑定器从文档解析。 */
  public getRuntimeEffectTargets(): readonly EffectRuntimeTarget[] {
    if (!this.dependencies.telemetry.telemetryPreviewActive) return [];
    const targets: EffectRuntimeTarget[] = [];
    for (const owner of this.dependencies.outputs.generatedOutputOwners.values()) {
      const target = describeGeneratedEffectTarget(owner);
      if (target) targets.push(target);
    }
    for (const runtime of this.dependencies.fetch.locatorFetchRuntimes.values()) targets.push(...runtime.getEffectTargets());
    return targets;
  }

  public resolveGeneratedEffectTargetNode(id: string): TransformNode | null {
    if (!this.dependencies.telemetry.telemetryPreviewActive) return null;
    const owner = this.dependencies.outputs.generatedOutputOwners.get(id);
    if (owner) {
      if (describeGeneratedEffectTarget(owner)?.state !== 'ready' || owner.output?.kind !== 'model') return null;
      return owner.output.model.root;
    }
    if (!id.startsWith('runtime-fetch:')) return null;
    for (const runtime of this.dependencies.fetch.locatorFetchRuntimes.values()) {
      const node = runtime.resolveEffectTargetNode(id);
      if (node) return node;
    }
    return null;
  }

  /** 开场占用镜头时暂停相机跟随，设备和遥测继续更新。 */
  setOpeningCameraOwned(owned: boolean): void {
    this.openingCameraOwned = owned;
  }

  /** 收集就绪的环境和业务模型；阵列按来源批次处理，不拆实例、不包含编辑标记。 */
  async prepareModelEntrance(settings: SceneModelEntranceSettings, signal?: AbortSignal): Promise<void> {
    const config = normalizeSceneModelEntranceSettings(settings);
    // 只对显式入口等待真实GI提交；否则会克隆隐藏源而让可见代理跳过动画。
    if (config.enabled) {
      const ready = this.dependencies.environment.lightingRuntime.whenReady();
      if (signal) await awaitLightingTaskStep(ready, signal); else await ready;
      signal?.throwIfAborted();
    }
    const visibleMeshes = (id: string, meshes: readonly AbstractMesh[]) => config.enabled
      ? this.dependencies.environment.lightingRuntime.getSelectionMeshes(id, meshes) : [...meshes];
    const targets: Array<{ id: string; node: TransformNode | AbstractMesh; meshes: AbstractMesh[] }> = [];
    const selected = new Set(config.targetEntityIds);
    const environment = this.dependencies.environment.environmentRuntime.getBuildingEffectTarget();
    this.modelEntranceIncludesEnvironment = Boolean(environment && !environment.isDisposed() && environment.isEnabled()
      && this.dependencies.environment.environmentRuntime.getSnapshot().phase === 'ready'
      && (config.scope === 'all' || selected.has(ENVIRONMENT_EFFECT_TARGET_ID)));
    if (environment && this.modelEntranceIncludesEnvironment) {
      targets.push({ id: ENVIRONMENT_EFFECT_TARGET_ID, node: environment,
        meshes: visibleMeshes(ENVIRONMENT_EFFECT_TARGET_ID, environment.getChildMeshes(false)).filter(mesh => !mesh.isDisposed() && mesh.getTotalVertices() > 0) });
    }
    for (const [id, entity] of this.dependencies.document.syncedEntities) {
      if (entity.components.modelArrayInstance || !this.dependencies.document.isEntityVisible(id)
        || (config.scope === 'selected' && !selected.has(id))) continue;
      const model = entity.components.modelAsset ? this.dependencies.assets.models.get(id) : null;
      const mesh = entity.components.meshRenderer ? this.dependencies.presentation.meshes.get(id) : null;
      const node = model?.root ?? mesh;
      if (!node) continue;
      const meshes = model ? [...model.meshes, ...(model.modelArrayBatch?.meshes ?? [])] : [mesh!];
      if (model) for (const variant of this.dependencies.variants.modelArrayParameterVariants.values()) {
        if (variant.sourceEntityId === id) meshes.push(...variant.model.meshes, ...(variant.model.modelArrayBatch?.meshes ?? []));
      }
      targets.push({ id, node, meshes: [...new Set(visibleMeshes(id, meshes))].filter(candidate => !candidate.isDisposed() && candidate.getTotalVertices() > 0) });
    }
    if (config.enabled && !targets.length) throw new Error('没有可播放入场的就绪模型，请检查作用范围和模型可见性。');
    await this.dependencies.readiness.loadDiagnostics.measureAsync('entrancePrepare', () => this.modelEntranceRuntime.prepare(config, targets, signal));
    const unsupported = this.modelEntranceRuntime.getSnapshot().unsupportedMeshCount;
    if (unsupported) Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`模型入场：${unsupported} 个网格材质不支持入场覆盖，保留原外观。`]);
  }

  startModelEntrance(): void { this.modelEntranceRuntime.start(); }
  cancelModelEntrance(): void { this.modelEntranceIncludesEnvironment = false; this.modelEntranceRuntime.cancel(); }
  setModelEntranceVisible(visible: boolean): void { this.modelEntranceVisible = visible; }
  isModelEntranceReady(): boolean { return this.context.scene.isReady(); }
  getModelEntranceSnapshot() { return this.modelEntranceRuntime.getSnapshot(); }

  /** 返回需要在 Babylon 画布上方挂载 iframe 的大屏平面。 */
  getDataPlatformScreenOverlayItems(): DataPlatformScreenOverlayItem[] {
    const items: DataPlatformScreenOverlayItem[] = [];
    for (const [entityId, entity] of this.dependencies.document.syncedEntities.entries()) {
      const screen = entity.components.dataPlatformScreen;
      const mesh = this.dependencies.presentation.meshes.get(entityId);
      if (!mesh) continue;
      const marker = entity.components.chartMarker;
      const markerStyle = marker ? getChartMarkerStyle(marker) : undefined;
      const visible = this.dependencies.document.isEntityVisible(entityId);
      if (marker) this.chartMarkerPresentation.update(mesh, marker, visible);
      if (!visible) continue;
      if (!entity.components.chartMarker && (!screen || screen.renderMode !== 'iframe' || !screen.screenUrl)) continue;
      items.push({
        entityId,
        name: markerStyle?.contentType === 'screen' ? marker?.screenName || entity.name : entity.name,
        chartMarker: Boolean(entity.components.chartMarker),
        markerStyle,
        markerText: markerStyle ? getChartMarkerText(markerStyle, this.dependencies.document.syncedEntities.get(markerStyle.dataSourceEntityId), this.dependencies.telemetry.telemetryPreviewActive) : undefined,
        mesh,
        ...(markerStyle?.contentType === 'video' ? { screenUrl: markerStyle.videoUrl || undefined } : {}),
        ...(screen && (!markerStyle || markerStyle.contentType === 'screen') ? {
          projectId: screen.projectId,
          screenId: screen.screenId,
          screenUrl: screen.renderMode === 'iframe' ? screen.screenUrl : undefined,
          thumbnailUrl: screen.thumbnailUrl,
          renderMode: screen.renderMode,
        } : {}),
      });
    }
    if (this.dependencies.telemetry.telemetryPreviewActive) items.push(...this.alarmRuntime.getOverlayItems());
    return items;
  }
  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeModelEntranceRuntime(): void {
    this.modelEntranceRuntime = new ModelEntranceRuntime(this.context.scene);
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializePoiEffectRuntime(): void {
    this.poiEffectRuntime = new PoiEffectRuntime(this.context.scene, id => {
      if (id === ENVIRONMENT_EFFECT_TARGET_ID) return this.dependencies.environment.environmentRuntime?.getBuildingEffectTarget() ?? null;
      const generated = this.resolveGeneratedEffectTargetNode(id);
      if (generated) return generated;
      // 直接解析已加载实体，不扫描场景；异步模型就绪后运行时自动补绑定。
      if (!this.dependencies.document.isEntityVisible(id)) return null;
      const model = this.dependencies.assets.models.get(id);
      // 薄实例合批共享几何，不能将一个实例的效果施加到整批。
      if (model?.modelArrayBatch || this.dependencies.document.syncedEntities.get(id)?.components.modelArrayInstance) {
        const bounds = this.dependencies.bounds.getEntityWorldBounds(id);
        if (!bounds) return null;
        let node = this.effectPoseNodes.get(id);
        if (!node) { node = new TransformNode(id + '_effectPose', this.context.scene); this.effectPoseNodes.set(id, node); }
        const entity = this.dependencies.document.syncedEntities.get(id);
        if (model) { model.root.computeWorldMatrix(true); node.position.copyFrom(model.root.getAbsolutePosition()); node.rotationQuaternion ??= Quaternion.Identity(); model.root.getWorldMatrix().decompose(node.scaling, node.rotationQuaternion); }
        else if (entity) { const pose = entity.components.transform; node.position.copyFromFloats(pose.position.x,pose.position.y,pose.position.z); node.rotation.copyFromFloats(pose.rotation.x,pose.rotation.y,pose.rotation.z); node.scaling.copyFromFloats(pose.scale.x,pose.scale.y,pose.scale.z); }
        node.metadata = { effectBounds: bounds };
        return node;
      }
      return this.dependencies.presentation.meshes.get(id) ?? model?.root ?? null;
    }, () => this.dependencies.telemetry.telemetryPreviewActive && !this.openingCameraOwned, false, { getRuntimeTargets: () => this.getRuntimeEffectTargets() });
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeClickEventBindingRuntime(): void {
    this.clickEventBindingRuntime = new EditorClickEventBindingRuntime(this.context.scene);
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeAlarmRuntime(): void {
    this.alarmRuntime = new AlarmManagerRuntime(this.context.scene, {
      node: id => this.dependencies.presentation.meshes.get(id) ?? this.dependencies.assets.models.get(id)?.root ?? null,
      meshes: id => this.dependencies.assets.models.get(id)?.meshes ?? (this.dependencies.presentation.meshes.has(id) ? [this.dependencies.presentation.meshes.get(id)!] : []),
      bounds: id => this.dependencies.bounds.getEntityWorldBounds(id), visible: id => this.dependencies.document.isEntityVisible(id),
      activate: event => this.onAlarmActivated?.call(this.context.callbackReceiver, event), report: message => Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [message]),
    });
  }

}
