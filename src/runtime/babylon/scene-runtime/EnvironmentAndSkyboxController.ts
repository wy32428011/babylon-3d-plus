import { captureLightingInputWithMetrics } from '../lightingCaptureMetrics';
import { encodeLightingBakeTransport } from '../../../../electron/shared/sceneLightingBakeBinary';
import type { LightingDraftPreview } from '../../../editor/store/lightingManagementState';
import type { LightingBakePreflight } from '../../../../electron/shared/sceneLightingBakePreflight';
import { awaitLightingTaskStep } from '../lightingBakeTask';
import { SceneLightingRuntime } from '../SceneLightingRuntime';
import { appendGeneratedLightingSources, collectLightingRuntimeSources, type LightingBatchOwner, type LightingSourceOwner } from '../lightingClassificationRuntime';
import { getSceneLightingBakeSignature, type SceneLightingBakeSnapshot, type LightingClassificationEntry } from '../../../../electron/shared/sceneLightingBakeContract';
import { SceneAppearanceRuntime } from '../SceneAppearanceRuntime';
import { SceneLightRigRuntime } from '../SceneLightRigRuntime';
import { getSceneLightingConfig, getSceneAppearanceConfig } from '../../../../electron/shared/sceneLightingConfig.ts';
import { ENVIRONMENT_EFFECT_TARGET_ID } from '../../../editor/model/environmentBuildingEffect';
import { AssetContainer } from '@babylonjs/core/assetContainer.js';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { ISceneLoaderProgressEvent } from '@babylonjs/core';
import type { Entity } from '../../../editor/model/Entity';
import { createSceneSkyboxSettingsFromEntity, getSceneSkyboxEntity, getSceneSkyboxSettings, type SceneDocument, type SceneEnvironmentSettings } from '../../../editor/model/SceneDocument';
import { SceneSkyboxRuntime } from '../SceneSkyboxRuntime';
import { SceneShadowRuntime } from '../SceneShadowRuntime';
import { SceneEnvironmentRuntime, type SceneEnvironmentApplyOptions } from '../SceneEnvironmentRuntime';
import { waitForSceneRenderReady } from '../sceneRenderReadiness';
import type { EnvironmentApplyResult, EnvironmentWorldBounds } from '../../../editor/model/environmentRuntime';
import { AssetLoadScheduler } from '../AssetLoadScheduler';
import { EnvironmentAssetContainerCache } from '../environmentAssetContainerCache';
import { EntityArrayThinInstanceBatch } from '../EntityArrayThinInstanceBatch';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import type { ScenePickingAndSelectionController } from './ScenePickingAndSelectionController';
import type { SceneDocumentController } from './SceneDocumentController';
import type { SceneTriangleAndReadinessController } from './SceneTriangleAndReadinessController';
import type { GeneratedModelOutputController } from './GeneratedModelOutputController';
import type { ScenePoiAndEffectsController } from './ScenePoiAndEffectsController';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import type { SceneTelemetryController } from './SceneTelemetryController';
import type { ParameterVariantHostPool } from './ParameterVariantHostPool';
import type { ModelArrayRuntimeController } from './ModelArrayRuntimeController';
import { type ModelRuntimeEntry, readRuntimeTimestampMs } from './sceneRuntimeTypes';
import type { SceneLoadTraceScope } from '../SceneLoadDiagnostics.ts';
import type { ProjectOpenSpanToken, ProjectOpenSpanOutcome, ProjectOpenTraceCode } from '../../../../electron/shared/projectOpenTrace.ts';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly selection: Pick<ScenePickingAndSelectionController, 'resolveSelectedEntityIds' | 'readEntityIdFromMesh' | 'rebuildModelSelectionOutline'>;
  readonly document: Pick<SceneDocumentController, 'isEntityVisible' | 'isEntityScenePickable' | 'shadowDocument'>;
  readonly readiness: Pick<SceneTriangleAndReadinessController, 'modelStatisticsEnvironmentSourceUrl' | 'invalidateModelStatistics' | 'activeModelLoadProgress' | 'beginModelLoadProgressUnit' | 'loadDiagnostics' | 'updateModelLoadProgressUnit' | 'settleModelLoadProgressUnit' | 'notifyModelLoadProgressChanged'>;
  readonly outputs: Pick<GeneratedModelOutputController, 'defaultCargoGeneratorId' | 'spawnedDeviceModels' | 'generatedOutputOwners'>;
  readonly effects: Pick<ScenePoiAndEffectsController, 'poiEffectRuntime' | 'modelEntranceIncludesEnvironment' | 'modelEntranceRuntime' | 'cancelModelEntrance'>;
  readonly presentation: Pick<SceneMeshPresentationController, 'lights' | 'meshes'>;
  readonly assets: Pick<ModelAssetRuntimeController, 'models'>;
  readonly telemetry: Pick<SceneTelemetryController, 'motionStaticBatchRuntime' | 'specializedTelemetryRuntime'>;
  readonly variants: Pick<ParameterVariantHostPool, 'modelArrayParameterVariants'>;
  readonly arrays: Pick<ModelArrayRuntimeController, 'modelArrayBatchByMeshUniqueId'>;
};


/** EnvironmentAndSkyboxController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class EnvironmentAndSkyboxController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  public readonly environmentLoadScheduler = new AssetLoadScheduler(1);
  public readonly environmentAssetCache = new EnvironmentAssetContainerCache();
  public appearanceRuntime!: SceneAppearanceRuntime;
  public lightRigRuntime!: SceneLightRigRuntime;
  public appearanceSignature = '';
  public skyboxLightingSignature = '';
  public allowDayNightCycle: boolean | null = null;
  public shadowRuntime!: SceneShadowRuntime;
  public lightingRuntime!: SceneLightingRuntime;
  /** 内部完整分类A/B诊断；不写入场景，不改变失效或业务输入。 */
  public lightingContextAssemblyMode: 'direct' | 'legacy' = 'direct';
  public lightingBakeRunning = false;
  public skyboxRuntime!: SceneSkyboxRuntime;
  public environmentRuntime!: SceneEnvironmentRuntime;
  /** 环境容器必须等加入场景并完成首帧渲染后，才能结算对应的统一进度单元。 */
  public readonly environmentLoadProgressUnits = new WeakMap<AssetContainer, number>();
  private readonly environmentTraceScopes = new WeakMap<AbortSignal, SceneLoadTraceScope | null>();
  private skyboxTrace: { token: ProjectOpenSpanToken; sourceUrl: string | null; scope: SceneLoadTraceScope | null } | null = null;
  private skyboxOperationScope: SceneLoadTraceScope | null = null;


  /** 同步球形天空盒实体；没有实体时兼容旧 sceneSettings.skybox。 */
  syncSkybox(document: SceneDocument): void {
    const entity = getSceneSkyboxEntity(document);
    if (entity?.components.skybox) {
      this.syncSkyboxEntity(entity, this.dependencies.selection.resolveSelectedEntityIds(document).has(entity.id));
      return;
    }

    const skybox = getSceneSkyboxSettings(document);
    if (!skybox) {
      this.syncSkyboxTarget(null);
      return;
    }
    this.syncSkyboxTarget({
      entityId: null,
      skybox,
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: skybox.rotationDegrees * Math.PI / 180, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      visible: true,
      pickable: false,
      selected: false,
    });
  }

  /** 将天空盒实体的 Transform、层级显隐、锁定与选中态同步到球体运行时。 */
  public syncSkyboxEntity(entity: Entity, selected: boolean): void {
    const skybox = createSceneSkyboxSettingsFromEntity(entity);
    if (!skybox) {
      this.syncSkyboxTarget(null);
      return;
    }
    this.syncSkyboxTarget({
      entityId: entity.id,
      skybox,
      transform: entity.components.transform,
      visible: this.dependencies.document.isEntityVisible(entity.id),
      pickable: this.dependencies.document.isEntityScenePickable(entity.id),
      selected,
    });
  }

  /** 同步场景级环境底座模型；环境不写入实体索引，也不能被场景点击选中。 */
  syncEnvironment(environment: SceneEnvironmentSettings | null): void {
    this.dependencies.readiness.modelStatisticsEnvironmentSourceUrl = environment?.activeVariantUrl ?? null;
    this.environmentRuntime.sync(environment);
    this.dependencies.readiness.invalidateModelStatistics();
  }

  /** 单独同步场景级默认模型生成器：该设置只改 sceneSettings，不触发实体全量同步，须由编辑器显式推送。 */
  syncDefaultCargoGenerator(defaultCargoGeneratorId: string | null): void {
    this.dependencies.outputs.defaultCargoGeneratorId = defaultCargoGeneratorId ?? null;
  }

  /** 纯外观独立于光照签名；改变曝光、雾、光晕不重建灯光。 */
  syncAppearance(document: SceneDocument): void {
    const appearance = getSceneAppearanceConfig(document), signature = JSON.stringify(appearance);
    if (signature === this.appearanceSignature) return;
    this.appearanceSignature = signature;
    this.appearanceRuntime.sync(appearance);
    this.dependencies.effects.poiEffectRuntime.setAppearance(appearance);
    this.syncSkyboxLighting(document);
  }

  public syncSkyboxLighting(document: SceneDocument): void {
    const appearance = getSceneAppearanceConfig(document), lighting = getSceneLightingConfig(document);
    const signature = JSON.stringify([appearance.skyboxVisible, lighting.environmentIntensity, lighting.environment]);
    if (signature === this.skyboxLightingSignature) return;
    this.skyboxLightingSignature = signature;
    this.skyboxRuntime.setLightingOverrides({ visible: appearance.skyboxVisible, intensity: lighting.environmentIntensity,
      source: lighting.environment?.source ?? 'scene', rotationDegrees: lighting.environment?.rotationDegrees ?? 0 });
  }

  /** 统一光照是唯一参数来源；旧扁平字段仅在阴影算法边界临时派生。 */
  syncLighting(document: SceneDocument): void {
    this.dependencies.document.shadowDocument = document;
    void this.syncLightingPresentation(document).catch(error => {
      Reflect.apply(this.context.pushLog, this.context.callbackReceiver, ['环境光照显示失败：' + (error instanceof Error ? error.message : String(error))]);
    });
    this.lightingRuntime.sync(document);
  }

  private syncLightingPresentation(document: SceneDocument): Promise<void> {
    const lighting = getSceneLightingConfig(document);
    this.lightRigRuntime.sync(lighting);
    if (this.allowDayNightCycle !== lighting.allowDayNightCycle) {
      this.allowDayNightCycle = lighting.allowDayNightCycle;
      this.dependencies.effects.poiEffectRuntime.setGlobalLightingControl(lighting.allowDayNightCycle);
    }
    this.shadowRuntime.setManagedLight(this.lightRigRuntime.mainLight);
    for (const [id, light] of this.dependencies.presentation.lights) {
      this.lightRigRuntime.syncEntityLight(id, light, this.dependencies.document.isEntityVisible(id));
      this.shadowRuntime.syncLight(id, light);
    }
    this.syncSkyboxLighting(document);
    this.shadowRuntime.applySettings({ ...lighting.shadows, mode: 'hybrid', catcherEnabled: false,
      sunAzimuthDegrees: lighting.main.azimuthDegrees, sunElevationDegrees: lighting.main.elevationDegrees,
      sunIntensity: lighting.main.intensity, fillIntensity: lighting.fill.intensity, iblIntensityMax: lighting.environmentIntensity });
    return this.environmentRuntime.syncLighting(lighting.shadows);
  }

  peekLightingClassificationForEntities(entityIds: readonly string[]) { return this.lightingRuntime.peekClassificationForEntities(entityIds); }

  getLightingClassification(): LightingClassificationEntry[] { return this.lightingRuntime.getClassification(); }
  setLightingPreview(debugVisible: boolean, beforeBake: boolean): void { this.lightingRuntime.setPreview(debugVisible, beforeBake); }
  focusLightingNode(entityId: string, nodeKey: string): void { this.lightingRuntime.focusNode(entityId, nodeKey); }
  getLightingBakeRuntimeError(): string | null {
    const error = this.lightingRuntime.getError();
    if (error) return error;
    const errors = this.shadowRuntime.getValidationErrors();
    return errors?.length ? errors.join('；') : null;
  }
  getLightingRuntimeDiagnostic() { return this.lightingRuntime.getDiagnostic(); }
  getHybridLightingMetrics() { return this.shadowRuntime.getHybridMetrics(); }
  waitForLightingReady(): Promise<void> { return this.lightingRuntime.whenReady(); }

  private draftPreviewGeneration = 0;

  async setLightingDraftPreview(preview: LightingDraftPreview | null): Promise<void> {
    const document = this.dependencies.document.shadowDocument;
    if (!document) return;
    if (preview && this.dependencies.effects.poiEffectRuntime.isDayNightCycleActive()) throw new Error('昼夜周期正在改变照明，请先暂停周期，再临时预览草稿。');
    const generation = ++this.draftPreviewGeneration;
    try {
      this.lightingRuntime.setTemporaryLightingPreview(preview ? preview.suppressIndirect : true, preview?.suppressIndirect ?? true);
      const source = preview ? { ...document, sceneSettings: { ...document.sceneSettings,
        lighting: { ...preview.lighting, allowDayNightCycle: document.sceneSettings.lighting.allowDayNightCycle },
        appearance: preview.appearance } } : document;
      this.appearanceSignature = ''; this.skyboxLightingSignature = '';
      const synchronization = this.syncLightingPresentation(source);
      this.syncAppearance(source);
      await synchronization;
      // 资源来源切换是异步的；原环境真正就绪后才重新启用原 GI。
      if (!preview) {
        const started = Date.now();
        while (generation === this.draftPreviewGeneration && this.skyboxRuntime.getReadiness().phase === 'loading') {
          if (Date.now() - started > 30_000) throw new Error('恢复原环境照明超时，请检查环境资源。');
          await new Promise(resolve => setTimeout(resolve, 16));
        }
        const readiness = this.skyboxRuntime.getReadiness();
        if (generation === this.draftPreviewGeneration && readiness.phase === 'error') throw new Error(readiness.message ?? '原环境照明恢复失败。');
      }
    } finally {
      // 同步抛错、异步失败和超时都必须归还正常验证，不能永久跳过 GI 失效。
      if (!preview && generation === this.draftPreviewGeneration) this.lightingRuntime.setTemporaryLightingPreview(false, false);
    }
  }

  private assertSkyboxReadyForBake(): void {
    const state = this.skyboxRuntime.getReadiness();
    if (state.phase === 'loading') throw new Error('天空 ENV 尚未完成准备，请等待资源就绪后再烘焙。');
    if (state.phase === 'error') throw new Error(`天空资源未就绪：${state.message ?? '请重新准备 ENV。'}`);
  }

  async preflightLightingBake(document: SceneDocument, signal?: AbortSignal): Promise<LightingBakePreflight> {
    this.assertSkyboxReadyForBake();
    if (this.lightingBakeRunning) throw new Error('请等待当前烘焙任务结束，再检查预算。');
    if (this.dependencies.readiness.activeModelLoadProgress.size || this.environmentRuntime.getSnapshot().phase === 'loading'
      || [...this.dependencies.assets.models.values()].some(model => model.externalScriptStarting || model.cancelLoad)) throw new Error('请等待全部模型与参数几何生成完成后再检查预算。');
    const api = typeof window !== 'undefined' ? window.editorApi : undefined;
    if (!api?.preflightLightingBake) throw new Error('烘焙前检查需要桌面编辑器。');
    await awaitLightingTaskStep(this.lightingRuntime.whenReady(), signal);
    // 环境提交可能晚于最后一个 mesh 事件；显式检查必须读取当前完整源目录。
    this.lightingRuntime.markDirty('bake-preflight');
    const input = await awaitLightingTaskStep(this.lightingRuntime.captureBakeInput(crypto.randomUUID(), signal), signal);
    signal?.throwIfAborted();
    return await awaitLightingTaskStep(api.preflightLightingBake(encodeLightingBakeTransport(input, { deduplicateTextureUrls: true })), signal);
  }

  /** 后台任务只读取稳定快照；结果仍匹配当前场景后才应用，文档提交由编辑器事务负责。 */
  async bakeLighting(document: SceneDocument, signal?: AbortSignal, progress?: (message: string, fraction?: number, phase?: string) => void): Promise<SceneLightingBakeSnapshot> {
    this.assertSkyboxReadyForBake();
    if (this.lightingBakeRunning) throw new Error('已有光照烘焙正在进行。');
    if (this.dependencies.effects.poiEffectRuntime.isDayNightCycleActive()) throw new Error('昼夜周期正在改变照明，请先停用昼夜组件或关闭允许昼夜周期，再烘焙间接光。');
    if (this.dependencies.readiness.activeModelLoadProgress.size || this.environmentRuntime.getSnapshot().phase === 'loading'
      || [...this.dependencies.assets.models.values()].some(model => model.externalScriptStarting || model.cancelLoad)) {
      throw new Error('请等待全部模型与参数几何生成完成后再烘焙。');
    }
    const api = typeof window !== 'undefined' ? window.editorApi : undefined;
    if (!api?.startLightingBake) throw new Error('材质烘焙需要在桌面编辑器中调用本机 Blender；Viewer 仅使用已生成资源。');
    const jobId = crypto.randomUUID();
    const signature = getSceneLightingBakeSignature(document);
    const check = () => {
      signal?.throwIfAborted();
      if (getSceneLightingBakeSignature(this.dependencies.document.shadowDocument ?? document) !== signature) throw new Error('烘焙期间静态场景已变化，候选结果未提交。');
    };
    const cancel = () => { void api.cancelLightingBake(jobId).catch(error => Reflect.apply(this.context.pushLog, this.context.callbackReceiver, ['取消后台烘焙失败：' + String(error)])); };
    const unsubscribe = api.onLightingBakeProgress(event => { if (event.jobId === jobId) progress?.(event.message, event.progress, event.phase); });
    signal?.addEventListener('abort', cancel, { once: true });
    this.lightingBakeRunning = true;
    let applied = false;
    try {
      check();
      await awaitLightingTaskStep(this.environmentRuntime.syncLighting(getSceneLightingConfig(document).shadows), signal);
      this.lightingRuntime.sync(document);
      await awaitLightingTaskStep(this.lightingRuntime.whenReady(), signal);
      this.dependencies.telemetry.motionStaticBatchRuntime.setSuspended(true);
      this.lightingRuntime.markDirty('bake-capture');
      const captured = await captureLightingInputWithMetrics(sample => this.lightingRuntime.captureBakeInput(jobId, signal, message => {
        sample(); progress?.(message, 0, 'preparing');
      }), signal);
      const input = { ...captured.value, captureMetrics: captured.metrics };
      check();
      const result = await awaitLightingTaskStep(api.startLightingBake(encodeLightingBakeTransport(input, { deduplicateTextureUrls: true })), signal);
      check();
      progress?.('光照已生成，正在应用材质并等待画面就绪…', 0.98, 'applying');
      await this.lightingRuntime.applySnapshot(result, signal, async () => {
        await waitForSceneRenderReady(this.context.scene, signal);
        check();
        const validationErrors = this.shadowRuntime.getHybridMetrics().validationErrors;
        if (validationErrors?.length) throw new Error(validationErrors.join('；'));
      });
      applied = true;
      return result;
    } finally {
      signal?.removeEventListener('abort', cancel); unsubscribe(); this.lightingBakeRunning = false;
      if (!applied) this.lightingRuntime.sync(this.dependencies.document.shadowDocument ?? document);
    }
  }

  /** 事务式加载候选环境；成功前保留当前有效环境。 */
  applyEnvironment(
    environment: SceneEnvironmentSettings,
    options: SceneEnvironmentApplyOptions,
  ): Promise<EnvironmentApplyResult> {
    this.dependencies.readiness.modelStatisticsEnvironmentSourceUrl = environment.activeVariantUrl;
    this.dependencies.readiness.invalidateModelStatistics();
    return this.environmentRuntime.apply(environment, options);
  }

  /** 返回环境根节点供临时 Gizmo 调整；旧版摆放环境不开放该入口。 */
  getEnvironmentGizmoTarget(): TransformNode | null {
    return this.environmentRuntime.getGizmoTarget();
  }

  /** 返回当前环境的世界包围盒，供聚焦与 Inspector 摘要使用。 */
  getEnvironmentWorldBounds(): EnvironmentWorldBounds | null {
    return this.environmentRuntime.getWorldBounds();
  }

  getOpeningEnvironmentSnapshot() {
    return this.environmentRuntime.getOpeningEnvironmentSnapshot();
  }

  /** 切换环境调整态的静态矩阵冻结与辅助包围框。 */
  setEnvironmentAdjustmentActive(active: boolean): void {
    this.environmentRuntime.setAdjustmentActive(active);
  }

  /**
   * 环境 GLB 使用独立并发窗口和会话级源缓存。
   * 避免 20 MB 厂区底座与设备模型抢同一条 4 路队列，同场景再次打开时不再重复 Draco/PNG 解析。
   */
  public async loadEnvironmentAssetContainer(
    rootUrl: string,
    fileName: string,
    loadSignal?: AbortSignal,
    onProgress?: (event: ISceneLoaderProgressEvent) => void,
  ): Promise<AssetContainer> {
    const traceScope = this.dependencies.readiness.loadDiagnostics.captureTrace();
    if (loadSignal) this.environmentTraceScopes.set(loadSignal, traceScope);
    const trace = this.dependencies.readiness.loadDiagnostics.createAssetTrace(traceScope);
    const loadSequence = this.dependencies.readiness.beginModelLoadProgressUnit(fileName);
    const queuedAt = readRuntimeTimestampMs();
    const diagnosticContext = { resource: fileName, resourceOrdinal: trace?.resourceOrdinal };
    const queueToken = this.dependencies.readiness.loadDiagnostics.beginTraceTask('environmentQueue', diagnosticContext, traceScope);
    try {
      const container = await this.environmentLoadScheduler.run(
        () => {
          queueToken?.end();
          this.dependencies.readiness.loadDiagnostics.record('environmentQueue', readRuntimeTimestampMs() - queuedAt);
          return this.environmentAssetCache.acquireWorkingContainer({
          cacheKey: `${rootUrl}${fileName}`,
          scene: this.context.scene,
          loadSource: () => this.dependencies.readiness.loadDiagnostics.measureAsync('environmentReadDecode', () => SceneLoader.LoadAssetContainerAsync(rootUrl, fileName, this.context.scene, (event) => {
            this.dependencies.readiness.updateModelLoadProgressUnit(loadSequence, event);
            onProgress?.(event);
          }), diagnosticContext, traceScope),
          onClone: (ms, failed) => this.dependencies.readiness.loadDiagnostics.record('environmentClone', ms, failed, fileName),
          trace,
        });
        },
        loadSignal,
      );
      this.environmentLoadProgressUnits.set(container, loadSequence);
      return container;
    } catch (error) {
      queueToken?.end(error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error',
        error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'operation-failed');
      this.dependencies.readiness.settleModelLoadProgressUnit(loadSequence);
      throw error;
    }
  }

  /** 等待环境材质/纹理就绪，并确认环境已实际进入一帧场景渲染。 */
  public waitForEnvironmentRenderReady(loadSignal?: AbortSignal): Promise<void> {
    const scope = loadSignal && this.environmentTraceScopes.has(loadSignal)
      ? this.environmentTraceScopes.get(loadSignal)! : this.dependencies.readiness.loadDiagnostics.captureTrace();
    return this.dependencies.readiness.loadDiagnostics.measureAsync('environmentRenderReady', () => waitForSceneRenderReady(this.context.scene, loadSignal), undefined, scope);
  }

  /** 成功、失败或取消都只结算一次环境加载单元。 */
  public settleEnvironmentAssetContainerLoad(container: AssetContainer): void {
    const loadSequence = this.environmentLoadProgressUnits.get(container);
    if (loadSequence === undefined) return;
    this.environmentLoadProgressUnits.delete(container);
    this.dependencies.readiness.settleModelLoadProgressUnit(loadSequence);
  }
  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeShadowRuntime(): void {
    this.shadowRuntime = new SceneShadowRuntime(this.context.scene);
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeAppearanceRuntime(): void {
    this.appearanceRuntime = new SceneAppearanceRuntime(this.context.scene);
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeLightRigRuntime(): void {
    this.lightRigRuntime = new SceneLightRigRuntime(this.context.scene);
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeSkyboxRuntime(): void {
    this.skyboxRuntime = new SceneSkyboxRuntime(this.context.scene, this.context.pushLog, state => {
      this.observeSkyboxTrace(state);
      this.dependencies.readiness.notifyModelLoadProgressChanged();
    });
  }

  private syncSkyboxTarget(target: Parameters<SceneSkyboxRuntime['sync']>[0]): void {
    this.skyboxOperationScope = this.dependencies.readiness.loadDiagnostics.captureTrace();
    this.skyboxRuntime.sync(target);
    // 同源在途复用会直接return，不产生readiness事件；本次消费者仍有真实等待边界。
    this.observeSkyboxTrace(this.skyboxRuntime.getReadiness());
  }

  endProjectOpenSkyboxTrace(outcome: ProjectOpenSpanOutcome, code?: ProjectOpenTraceCode): void {
    this.skyboxOperationScope = null;
    if (outcome === 'ok') return;
    this.skyboxTrace?.token.end(outcome, code); this.skyboxTrace = null;
  }

  private observeSkyboxTrace(state: ReturnType<SceneSkyboxRuntime['getReadiness']>): void {
    const scope = this.skyboxOperationScope;
    if (state.phase === 'loading') {
      if (this.skyboxTrace && (this.skyboxTrace.sourceUrl !== state.sourceUrl || (scope !== null && this.skyboxTrace.scope !== scope))) {
        this.skyboxTrace.token.end('stale', 'scene-stale'); this.skyboxTrace = null;
      }
      if (!this.skyboxTrace) {
        const token = this.dependencies.readiness.loadDiagnostics.beginTraceTask('skyboxReady', undefined, scope);
        if (token) this.skyboxTrace = { token, sourceUrl: state.sourceUrl, scope };
      }
    } else if (this.skyboxTrace) {
      this.skyboxTrace.token.end(state.phase === 'error' ? 'error' : state.phase === 'idle' ? 'skipped' : 'ok',
        state.phase === 'error' ? 'operation-failed' : state.phase === 'idle' ? 'not-applicable' : undefined);
      this.skyboxTrace = null;
    }
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeEnvironmentRuntime(): void {
    this.environmentRuntime = new SceneEnvironmentRuntime(this.context.scene, {
      withBuildingEffectMutation: mutate => {
        // 环境切换材质、阴影或透明度前释放入场覆盖，避免保留旧外观或旧材质引用。
        if (this.dependencies.effects.modelEntranceIncludesEnvironment && this.dependencies.effects.modelEntranceRuntime.isActive) this.dependencies.effects.cancelModelEntrance();
        this.dependencies.effects.poiEffectRuntime.withTargetMutation(ENVIRONMENT_EFFECT_TARGET_ID, mutate);
      },
      // 环境底座模型与场景模型并行加载，作为独立进度单元合并进同一份加载快照。
      loadAssetContainer: (rootUrl, fileName, signal) => {
        return this.loadEnvironmentAssetContainer(rootUrl, fileName, signal);
      },
      waitForRenderReady: (signal) => this.waitForEnvironmentRenderReady(signal),
      onAssetContainerSettled: (container) => this.settleEnvironmentAssetContainerLoad(container),
      onSnapshot: snapshot => {
        this.context.notifyEnvironmentSnapshot(snapshot);
        this.dependencies.readiness.invalidateModelStatistics();
        this.lightingRuntime?.markDirty('environment-snapshot');
      },
      pushLog: this.context.pushLog,
    });
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeLightingRuntime(): void {
    this.lightingRuntime = new SceneLightingRuntime(this.context.scene, {
      canDeferPreparationClassification: () => this.context.canDeferPreparationClassification?.() === true
        && this.dependencies.readiness.loadDiagnostics.hasPendingAssetWork(),
      getSources: () => {
        const document = this.dependencies.document.shadowDocument;
        if (!document) return [];
        const models: Array<[string, ModelRuntimeEntry]> = [...this.dependencies.assets.models];
        for (const variant of this.dependencies.variants.modelArrayParameterVariants.values()) models.push([variant.representativeEntityId, variant.model]);
        for (const entry of this.dependencies.outputs.spawnedDeviceModels) models.push(entry);
        const primitiveMeshes = new Map<string, AbstractMesh>(this.dependencies.presentation.meshes);
        const batches = new Set(this.dependencies.arrays.modelArrayBatchByMeshUniqueId.values());
        const sourceOwners = new Map<string, LightingSourceOwner>();
        const batchOwners = new Map<EntityArrayThinInstanceBatch, LightingBatchOwner>();
        appendGeneratedLightingSources(document, this.dependencies.outputs.generatedOutputOwners, { models, primitiveMeshes, batches, sourceOwners, batchOwners });
        return collectLightingRuntimeSources({ scene: this.context.scene, document, models, primitiveMeshes,
          environment: this.environmentRuntime.getLightingSurfaces(), environmentSource: this.environmentRuntime.getLightingSourceReference(),
          batches, sourceOwners, batchOwners,
          resolveBatchSource: (batch, id, source) => this.dependencies.telemetry.motionStaticBatchRuntime.getSourceMeshForEntity(batch, id) ?? source,
          isModelMeshRenderSuppressed: mesh => this.dependencies.telemetry.motionStaticBatchRuntime.isSuspended(mesh),
          getMotionTargets: model => this.dependencies.telemetry.specializedTelemetryRuntime.getLightingMotionNodes(model),
          readEntityId: mesh => this.dependencies.selection.readEntityIdFromMesh(mesh),
        }, { contextAssembly: this.lightingContextAssemblyMode });
      },
      setShadowRoles: (roles, settings) => this.shadowRuntime.setHybridMeshRoles(roles, settings),
      onBindingsChanged: () => this.dependencies.selection.rebuildModelSelectionOutline(),
      pushLog: this.context.pushLog,
    });
  }

}
