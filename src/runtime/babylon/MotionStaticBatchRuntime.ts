import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { CubeTexture } from '@babylonjs/core/Materials/Textures/cubeTexture.js';
import { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture.js';
import { GetMergedStore } from '@babylonjs/core/Misc/decorators.functions.js';
import type { AbstractMesh, Geometry, Material, Node, Observer, Scene, TransformNode } from '@babylonjs/core';
import { getSceneLightingConfig } from '../../../electron/shared/sceneLightingConfig.ts';
import type { SceneDocument } from '../../editor/model/SceneDocument';
import type { TransformComponent } from '../../editor/model/components';
import { EntityArrayThinInstanceBatch } from './EntityArrayThinInstanceBatch.ts';
import type { EntityArrayThinInstanceTransform } from './EntityArrayThinInstanceBatch.ts';
import type { ModelRuntimeEntry } from './SceneRuntime';
import { canObserveLightingBufferUploads, subscribeLightingBufferUploads, subscribeLightingGeometryUpdates } from './lightingGeometryUpdates.ts';

type MotionTargets = { moving: Node[]; fixed: Node[]; known: boolean };
export const MOTION_STATIC_MUTATION_EVENT_FLAG = '__motionStaticMutationEvent';
export type MotionStaticBatchOptions = {
  getDocument: () => SceneDocument | null;
  getModels: () => Iterable<[string, ModelRuntimeEntry]>;
  getMotionTargets: (model: ModelRuntimeEntry) => MotionTargets;
  isEntityVisible: (entityId: string) => boolean;
  isEntityPickable: (entityId: string) => boolean;
  onBatchAdded: (batch: EntityArrayThinInstanceBatch) => void;
  onBatchRemoved: (batch: EntityArrayThinInstanceBatch) => void;
  onChanged: () => void;
  /** 宿主明确核对场景级回调的所有权；缺省时只接受没有其他运动回调的场景。 */
  isSceneSafe?: () => boolean;
  /** 只有宿主明确管理其renderList的纹理才允许与合批共存；不改变未知RTT的功能。 */
  isRenderTargetControlled?: (texture: BaseTexture) => boolean;
};
type Part = { entityId: string; model: ModelRuntimeEntry; mesh: Mesh; geometry: Geometry;
  material: Material; localNodes: Array<{ node: TransformNode; parent: Node | null; value: string }>;
  geometryCurrent: () => boolean;
  presentation: string; materialWatch: () => string; materialState: string;
  worldUpdateId?: number; transform?: TransformComponent };
type BatchGroup = { batch: EntityArrayThinInstanceBatch; parts: Part[]; frameKey: string };
type MaterialCapture = { ok: true; schema: Record<string, unknown>; read: () => string; state: string; textureIdentities: number[] }
  | { ok: false; error: unknown };
type GeometryHook = { subscription: ReturnType<typeof subscribeLightingGeometryUpdates>;
  uploads: ReturnType<typeof subscribeLightingBufferUploads>; models: Set<ModelRuntimeEntry> };
const INSTANCE_ATTRIBUTES = new Set(['world0', 'world1', 'world2', 'world3', 'instanceSelectionId']);
// 本机Texture.serialize的图像导出、重连ID和debug标签；这些字段不参与当前GPU绘制。
const TEXTURE_EXPORT_FIELDS = ['base64String', 'internalTextureUniqueId', 'internalTextureLabel'] as const;
// primary serializer的手工字段/别名必须对应实际live状态，不能把有渲染意义的字段当导出元数据忽略。
const TEXTURE_LIVE_FIELDS: Readonly<Record<string, string>> = {
  invertY: 'invertY', samplingMode: 'samplingMode', noMipmap: 'noMipmap',
  _creationFlags: '_creationFlags', _useSRGBBuffer: '_useSRGBBuffer',
  files: '_files', forcedExtension: '_forcedExtension', extensions: '_extensions',
  textureMatrix: '_textureMatrix', textureMatrixRefraction: '_textureMatrixRefraction',
  size: '_size', useInGammaSpace: 'gammaSpace', generateHarmonics: '_generateHarmonics',
};
const PRESENTATION_FIELDS = ['visibility', 'layerMask', 'renderingGroupId', 'alphaIndex', 'receiveShadows',
  'hasVertexAlpha', 'useVertexColors', 'applyFog', 'overrideRenderingFillMode', 'sideOrientation',
  'overrideMaterialSideOrientation', 'isUnIndexed', 'cullingStrategy', 'billboardMode', 'infiniteDistance',
  'renderOutline', 'outlineWidth', 'outlineColor', 'renderOverlay', 'overlayAlpha', 'overlayColor'];

/** 保留每台设备原层级和运动网格，只接管已被实际驱动确认的相同固定叶片。 */
export class MotionStaticBatchRuntime {
  private readonly groups: BatchGroup[] = [];
  /** 仅从主相机候选中逻辑抑制；源对象始终保留在scene.meshes及原业务层级中。 */
  private readonly suspendedMeshes = new Set<AbstractMesh>();
  private readonly retiredCarriers = new WeakSet<AbstractMesh>();
  private readonly sourceCandidateProvider: Scene['getActiveMeshCandidates'];
  private readonly candidateProvider: Scene['getActiveMeshCandidates'];
  private readonly sourceFreezeActiveMeshes: Scene['freezeActiveMeshes'];
  private readonly sourceUnfreezeActiveMeshes: Scene['unfreezeActiveMeshes'];
  private readonly freezeActiveMeshesEntry: Scene['freezeActiveMeshes'];
  private readonly unfreezeActiveMeshesEntry: Scene['unfreezeActiveMeshes'];
  private candidateProviderRejected = false;
  private freezeEntryRejected = false;
  private pendingFreezes = 0;
  private bufferUploadsRejected = false;
  private collectingCandidates = false;
  private optOut = new WeakSet<ModelRuntimeEntry>();
  private readonly hooks = new Map<Geometry, GeometryHook>();
  private readonly identities = new WeakMap<ModelRuntimeEntry, number>();
  private readonly textureIdentities = new WeakMap<object, number>();
  private readonly mutations = new Map<ModelRuntimeEntry, { depth: number; parts: Part[] }>();
  private nextIdentity = 0;
  private nextTextureIdentity = 0;
  private layoutKey = '';
  private disposed = false;
  private suspended = false;
  private sceneSessionId: string | null = null;
  private rebuilding = false;
  private deferredLayout = false;
  private fallbackCount = 0;
  private fallbackReason = '';
  private candidateParts = 0;
  private readonly observer: Observer<Scene>;
  private readonly beforeAnimationsObserver: Observer<Scene>;
  private readonly beforeTargetsObserver: Observer<Scene>;

  constructor(private readonly scene: Scene, private readonly options: MotionStaticBatchOptions) {
    this.sourceCandidateProvider = scene.getActiveMeshCandidates;
    this.candidateProvider = () => this.collectCandidates();
    scene.getActiveMeshCandidates = this.candidateProvider;
    this.sourceFreezeActiveMeshes = scene.freezeActiveMeshes;
    this.sourceUnfreezeActiveMeshes = scene.unfreezeActiveMeshes;
    const delegateFreeze = this.delegateFreeze.bind(this);
    const sourceUnfreeze = this.sourceUnfreezeActiveMeshes;
    this.freezeActiveMeshesEntry = function (this: Scene, ...args) {
      return delegateFreeze(this, args);
    };
    this.unfreezeActiveMeshesEntry = function (this: Scene, ...args) {
      // 仅响应用户调用；尚未ready的classic freeze不会被native unfreeze取消，pending须等原回调结算。
      return sourceUnfreeze.apply(this, args);
    };
    scene.freezeActiveMeshes = this.freezeActiveMeshesEntry;
    scene.unfreezeActiveMeshes = this.unfreezeActiveMeshesEntry;
    this.observer = scene.onBeforeActiveMeshesEvaluationObservable.add(() => this.beforeActive());
    // customRenderFunction/frameGraph可能绕过普通候选流程，须在Scene.render的分支选择前归还原件。
    this.beforeAnimationsObserver = scene.onBeforeAnimationsObservable.add(() => this.guardRenderPipeline());
    // early脚本可在beforeRender新增RTT；主相机provider晚于第一遍RTT，不能只靠候选校验。
    this.beforeTargetsObserver = scene.onBeforeRenderTargetsRenderObservable.add(() => this.beforeActive());
  }

  sync(): void {
    if (this.disposed || this.rebuilding) return;
    this.rebuilding = true;
    try {
      const document = this.options.getDocument();
      if (!document || this.suspended || document.sceneSettings.lighting?.result
        || Reflect.get(document.sceneSettings, 'lightingBakeResult') || getSceneLightingConfig(document).result || !this.sceneSafe()) {
        this.clear(); this.layoutKey = ''; return;
      }
      const models = [...this.options.getModels()];
      // 模型逐个异步初始化时，完整几何签名/批次构建会随ready变化反复重做；等待本轮全部正常宿主结束。
      // 失败宿主由eligibleModel继续排除，既不能冒充ready候选，也不能阻塞其余模型的源绘制/接管。
      if (models.some(([, model]) => !model.readinessError && !model.externalScriptRuntime?.getInitializationError?.()
        && (!model.measurementReady || model.externalScriptStarting))) {
        this.clear(); this.layoutKey = ''; this.candidateParts = 0; return;
      }
      const key = JSON.stringify(models.map(([id, model]) => {
        let identity = this.identities.get(model);
        if (!identity) { identity = ++this.nextIdentity; this.identities.set(model, identity); }
        return [id, identity, model.measurementReady, model.externalScriptStarting, model.readinessError,
          model.parameterSignature, model.assetRevision, model.externalScriptSignature, this.optOut.has(model),
          model.meshes.map(mesh => mesh.uniqueId)];
      }));
      if (key === this.layoutKey) { this.updateGroups(); return; }
      const previouslyBatched = this.groups.length > 0;
      this.clear(false); this.layoutKey = key; this.candidateParts = 0;
      const candidates = new Map<string, Part[]>();
      // 只在本次layout收集内共享实际Material对象；下一次build必须重新捕获，失败也不为每个part重复serialize。
      const materialCaptures = new Map<Material, MaterialCapture>();
      for (const [entityId, model] of models) {
        if (!this.eligibleModel(model)) continue;
        const motion = this.options.getMotionTargets(model);
        if (!motion.known) continue;
        for (const mesh of new Set([...model.meshes, ...model.contentRoot.getChildMeshes(false)])) {
          if (!(mesh instanceof Mesh) || !eligibleMesh(mesh) || under(mesh, motion.moving)
            || (motion.fixed.length > 0 && !under(mesh, motion.fixed))) continue;
          try {
            if (!worldTransform(mesh)) continue;
            const material = mesh.material!;
            let captured = materialCaptures.get(material);
            if (!captured) {
              try {
                const serialized = serializeMaterialWithoutTextureMutation(material);
                const { name: _name, id: _id, uniqueId: _uniqueId, ...schema } = serialized;
                const watched = createMaterialWatch(material, schema, texture => this.textureIdentity(texture));
                captured = { ok: true, schema, read: watched.read, state: watched.read(), textureIdentities: watched.textureIdentities };
              } catch (error) { captured = { ok: false, error }; }
              materialCaptures.set(material, captured);
            }
            if (!captured.ok) throw captured.error;
            const localNodes: Part['localNodes'] = [];
            for (let node: Node | null = mesh; node && node !== model.root; node = node.parent) {
              if (!('position' in node) || node.animations.length) throw new Error('固定部件含未知变换节点。');
              const transform = node as TransformNode;
              localNodes.push({ node: transform, parent: node.parent, value: localSignature(transform) });
            }
            if (!mesh.isDescendantOf(model.root)) continue;
            const presentation = presentationSignature(mesh);
            // glTF内嵌图片的name/url可重复；序列化相同仍须共享实际像素来源，不能借用代表资产的纹理。
            const groupKey = JSON.stringify([nodePath(mesh, model.contentRoot), geometrySignature(mesh), captured.schema, captured.textureIdentities, presentation]);
            const part: Part = { entityId, model, mesh, geometry: mesh.geometry!, material, geometryCurrent: watchGeometryBuffers(mesh),
              localNodes, presentation, materialWatch: captured.read, materialState: captured.state };
            this.candidateParts += 1;
            const group = candidates.get(groupKey) ?? []; group.push(part); candidates.set(groupKey, group);
          } catch (error) { this.fallbackReason = String(error); }
        }
      }
      for (const parts of candidates.values()) {
        if (parts.length < 2) continue;
        const representative = parts[0].mesh;
        const batch = EntityArrayThinInstanceBatch.create(parts[0].entityId, [representative], {
          interactive: true, mergeStaticMeshesByMaterial: false,
          sourceRootWorldMatrix: representative.computeWorldMatrix(true).clone(),
          namePrefix: '__motionStatic', metadata: { motionStaticBatch: true },
        });
        if (!batch) continue;
        const group = { batch, parts, frameKey: '' };
        if (!this.updateGroup(group, false)) { batch.dispose(); continue; }
        this.groups.push(group);
        this.options.onBatchAdded(batch);
        for (const part of parts) {
          this.installGeometryHook(part);
          this.suspendedMeshes.add(part.mesh);
        }
      }
      if (previouslyBatched || this.groups.length) this.options.onChanged();
    } catch (error) {
      this.fallbackReason = String(error); this.clear(); this.layoutKey = '';
    } finally { this.rebuilding = false; }
  }

  /** 外置脚本/参数即将改写模型时先退出接管；当前模型对象不再重新参与优化。 */
  markModelDirty(model: ModelRuntimeEntry): void {
    if (this.disposed || this.optOut.has(model)) return;
    this.optOut.add(model); this.fallbackCount += 1;
    this.clear(); this.layoutKey = '';
  }

  /** 原对象始终可查；bracket只记录事务和嵌套，不制造add/remove或改写源flags。 */
  beginModelMutation(model: ModelRuntimeEntry): void {
    if (this.disposed) return;
    const active = this.mutations.get(model);
    if (active) { active.depth += 1; return; }
    const parts = this.groups.flatMap(group => group.parts.filter(part => part.model === model));
    if (!parts.length) return;
    this.mutations.set(model, { depth: 1, parts });
  }

  /** 必须放在调用者 finally；无变化的遥测更新保留批次，实际外观变化才永久回退。 */
  endModelMutation(model: ModelRuntimeEntry): void {
    const active = this.mutations.get(model);
    if (!active || --active.depth > 0) return;
    this.mutations.delete(model);
    if (this.disposed) return;
    try {
      const materialStates = new Map<Part['materialWatch'], string>();
      if (active.parts.some(part => !this.partCurrent(part, materialStates))) { this.markModelDirty(model); return; }
    } catch (error) { this.fallbackReason = String(error); this.markModelDirty(model); }
  }

  /** 烘焙捕获开始后保持原始源布局，直到本场景会话释放。 */
  setSuspended(value: boolean): void {
    if (!value || this.suspended || this.disposed) return;
    this.suspended = true; this.clear(); this.layoutKey = '';
  }

  /** SceneRuntime 可跨打开复用；只有显式的新场景会话才解除本会话的捕获挂起。 */
  beginSceneSession(sessionId: string): void {
    if (this.disposed || sessionId === this.sceneSessionId) return;
    this.sceneSessionId = sessionId; this.clear(); this.suspended = false; this.layoutKey = '';
    this.candidateProviderRejected = this.scene.getActiveMeshCandidates !== this.candidateProvider;
    this.freezeEntryRejected = this.scene.freezeActiveMeshes !== this.freezeActiveMeshesEntry
      || this.scene.unfreezeActiveMeshes !== this.unfreezeActiveMeshesEntry;
    this.optOut = new WeakSet(); this.mutations.clear(); this.candidateParts = 0;
  }

  getBatchesForEntity(entityId: string): readonly EntityArrayThinInstanceBatch[] {
    return this.groups.filter(group => group.parts.some(part => part.entityId === entityId)).map(group => group.batch);
  }
  getBatchForMesh(mesh: AbstractMesh): EntityArrayThinInstanceBatch | null {
    return this.groups.find(group => group.batch.meshes.includes(mesh as Mesh))?.batch ?? null;
  }
  /** 光照策略必须使用每台设备自己的资源身份和节点路径，不能沿用代表几何的宿主身份。 */
  getSourceMeshForEntity(batch: EntityArrayThinInstanceBatch, entityId: string): AbstractMesh | null {
    return this.groups.find(group => group.batch === batch)?.parts.find(part => part.entityId === entityId)?.mesh ?? null;
  }
  isSuspended(mesh: AbstractMesh): boolean { return this.suspendedMeshes.has(mesh); }
  /** 返回全部逻辑抑制原件，包括当前隐藏/不可见的实体；宿主用它排除重复shadow caster。 */
  getSuppressedMeshes(): readonly AbstractMesh[] { return [...this.suspendedMeshes]; }
  /** 保留宿主旧接口；候选过滤不再产生临时Mesh事件。 */
  isTemporaryMeshEvent(_mesh: AbstractMesh): boolean { return false; }
  getDiagnostics() {
    return { groups: this.groups.length, batchMeshes: this.groups.reduce((sum, group) => sum + group.batch.meshes.length, 0),
      suspendedMeshes: this.suspendedMeshes.size, fallbackCount: this.fallbackCount,
      candidateParts: this.candidateParts, fallbackReason: this.fallbackReason, suspended: this.suspended, disposed: this.disposed,
      candidateProviderOwned: this.scene.getActiveMeshCandidates === this.candidateProvider, candidateProviderRejected: this.candidateProviderRejected,
      freezeEntryOwned: this.scene.freezeActiveMeshes === this.freezeActiveMeshesEntry
        && this.scene.unfreezeActiveMeshes === this.unfreezeActiveMeshesEntry,
      freezeEntryRejected: this.freezeEntryRejected, pendingFreezes: this.pendingFreezes, bufferUploadsRejected: this.bufferUploadsRejected };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.scene.onBeforeActiveMeshesEvaluationObservable.remove(this.observer);
    this.scene.onBeforeAnimationsObservable.remove(this.beforeAnimationsObserver);
    this.scene.onBeforeRenderTargetsRenderObservable.remove(this.beforeTargetsObserver);
    this.clear(); this.mutations.clear();
    if (this.scene.getActiveMeshCandidates === this.candidateProvider) this.scene.getActiveMeshCandidates = this.sourceCandidateProvider;
    if (this.scene.freezeActiveMeshes === this.freezeActiveMeshesEntry) this.scene.freezeActiveMeshes = this.sourceFreezeActiveMeshes;
    if (this.scene.unfreezeActiveMeshes === this.unfreezeActiveMeshesEntry) this.scene.unfreezeActiveMeshes = this.sourceUnfreezeActiveMeshes;
  }

  private delegateFreeze(receiver: Scene, args: Parameters<Scene['freezeActiveMeshes']>): Scene {
    if (receiver !== this.scene || this.disposed) return this.sourceFreezeActiveMeshes.apply(receiver, args);
    // FrameGraph始终不接管，保留其独有的retry/缺省错误日志实现。
    if (receiver.frameGraph) { this.clear(); this.layoutKey = ''; return this.sourceFreezeActiveMeshes.apply(receiver, args); }
    // freezeActiveMeshes会异步evaluate再冻结；先设pending再归还原件，onChanged重入也不得创建载体。
    this.pendingFreezes++;
    let settled = false;
    const settle = () => { if (!settled) { settled = true; this.pendingFreezes--; } };
    const [skipEvaluate, onSuccess, onError, freezeMeshes, keepFrustum] = args;
    const delegated: Parameters<Scene['freezeActiveMeshes']> = [skipEvaluate,
      function (this: unknown, ...callbackArgs) { settle(); return onSuccess?.apply(this, callbackArgs); },
      function (this: unknown, ...callbackArgs) { settle(); return onError?.apply(this, callbackArgs); },
      freezeMeshes, keepFrustum];
    try { this.clear(); this.layoutKey = ''; return this.sourceFreezeActiveMeshes.apply(receiver, delegated); }
    catch (error) { settle(); throw error; }
  }

  private sceneSafe(): boolean {
    if (this.scene.getActiveMeshCandidates !== this.candidateProvider) this.candidateProviderRejected = true;
    if (this.scene.freezeActiveMeshes !== this.freezeActiveMeshesEntry
      || this.scene.unfreezeActiveMeshes !== this.unfreezeActiveMeshesEntry) this.freezeEntryRejected = true;
    if ([...this.hooks.values()].some(hook => !hook.uploads.isCurrent())) this.bufferUploadsRejected = true;
    if (this.candidateProviderRejected || this.freezeEntryRejected || this.bufferUploadsRejected || this.pendingFreezes > 0
      || this.scene.frameGraph || this.scene._activeMeshesFrozen || this.scene.customRenderFunction) return false;
    const targets = [...this.scene.customRenderTargets, ...this.scene.cameras.flatMap(camera => camera.customRenderTargets ?? [])];
    if (targets.some(texture => this.options.isRenderTargetControlled?.(texture) !== true)) return false;
    const environment = this.scene.environmentTexture;
    if (environment?.isRenderTarget && this.options.isRenderTargetControlled?.(environment) !== true) return false;
    for (const light of this.scene.lights) for (const generator of light.getShadowGenerators()?.values() ?? []) {
      const renderingGenerator = generator as typeof generator & { getShadowMapForRendering?: () => BaseTexture | null };
      if ([generator.getShadowMap(), renderingGenerator.getShadowMapForRendering?.()].some(texture => texture
        && this.options.isRenderTargetControlled?.(texture) !== true)) return false;
    }
    // primitive/环境辅助mesh同样参与Scene的材质RTT gather，不能只检查业务model列表。
    for (const mesh of this.scene.meshes) {
      if (mesh.material?.getActiveTextures().some(texture => texture.isRenderTarget
        && this.options.isRenderTargetControlled?.(texture) !== true)) return false;
    }
    return this.options.isSceneSafe?.() ?? false;
  }

  private guardRenderPipeline(): void {
    if (this.disposed) return;
    try {
      if (!this.sceneSafe()) { this.clear(); this.layoutKey = ''; }
    } catch (error) { this.fallbackReason = String(error); this.clear(); this.layoutKey = ''; }
  }

  private collectCandidates(): ReturnType<Scene['getActiveMeshCandidates']> {
    // 保留原provider的this和调用次数；原返回可能就是scene.meshes，先快照有效前缀再做会dispose载体的核对。
    const original = this.sourceCandidateProvider.call(this.scene);
    if (this.collectingCandidates) return original;
    this.collectingCandidates = true;
    try {
      const entries = original.data.slice(0, original.length);
      if (!this.disposed) this.beforeActive();
      if (this.groups.length) {
        const candidates = new Set(entries);
        if (this.groups.some(group => group.parts.some(part => !candidates.has(part.mesh))
          || group.batch.meshes.some(mesh => !candidates.has(mesh)))) {
          // 自定义候选只含部分业务源或不接受新增carrier时，不能擅自扩展其可见集合。
          this.candidateProviderRejected = true; this.fallbackReason = '原候选provider不包含完整源与载体，保留原始绘制。';
          this.clear(); this.layoutKey = '';
        }
      }
      const data = entries.filter(mesh => !this.suspendedMeshes.has(mesh) && !this.retiredCarriers.has(mesh));
      return data.length === original.length && entries.length === original.length ? original : { data, length: data.length };
    } catch (error) {
      this.fallbackReason = String(error); this.clear(); this.layoutKey = '';
      const data = original.data.slice(0, original.length).filter(mesh => !this.retiredCarriers.has(mesh));
      return { data, length: data.length };
    } finally { this.collectingCandidates = false; }
  }
  private eligibleModel(model: ModelRuntimeEntry): boolean {
    if (this.optOut.has(model) || !model.measurementReady || model.externalScriptStarting || model.readinessError
      || model.root.isDisposed() || model.contentRoot.isDisposed() || model.telemetryProxySource || model.modelArrayBatch
      || model.assetHandle?.animationGroups?.length || model.externalScriptRuntime?.getInitializationError?.()) return false;
    const asset = model.resolvedModelAsset ?? model.entitySnapshot?.components.modelAsset;
    const configs = model.externalScriptRuntime?.getDataDrivenConfigs?.() ?? [];
    if ((asset?.animationScriptMetadata?.length && !registeredParameterRuntime(asset, configs))
      || (model.externalScriptRuntime && (asset?.scriptAssets?.length ?? 1) > configs.length)) return false;
    return !model.meshes.some(mesh => mesh.skeleton || mesh.morphTargetManager?.numTargets || mesh.animations.length);
  }
  private textureIdentity(texture: BaseTexture): number {
    const pixels = texture.getInternalTexture() ?? texture;
    let identity = this.textureIdentities.get(pixels);
    if (!identity) { identity = ++this.nextTextureIdentity; this.textureIdentities.set(pixels, identity); }
    return identity;
  }
  private beforeActive(): void {
    if (this.disposed) return;
    try {
      const document = this.options.getDocument();
      if (!document || this.suspended || document.sceneSettings.lighting?.result
        || Reflect.get(document.sceneSettings, 'lightingBakeResult') || getSceneLightingConfig(document).result || !this.sceneSafe()) {
        this.clear(); this.layoutKey = ''; return;
      }
      const invalid = new Set<ModelRuntimeEntry>();
      const currentModels = new Set([...this.options.getModels()].map(([, model]) => model));
      // 仅本次遍历共享reader结果；下一RTT/provider/mutation边界必须建立新Map，保留同帧变更可见性。
      const materialStates = new Map<Part['materialWatch'], string>();
      for (const group of this.groups) for (const part of group.parts) {
        if (!currentModels.has(part.model) || !this.partCurrent(part, materialStates)) invalid.add(part.model);
      }
      for (const model of invalid) this.markModelDirty(model);
      // 新载体只能由宿主在 telemetry 后、lighting 分类前的 sync 创建。
      this.updateGroups(false);
    } catch (error) { this.fallbackReason = String(error); this.clear(); this.layoutKey = ''; }
  }
  private partCurrent(part: Part, materialStates?: Map<Part['materialWatch'], string>): boolean {
    const motion = this.options.getMotionTargets(part.model);
    return this.eligibleModel(part.model) && motion.known && !under(part.mesh, motion.moving)
      && eligibleMesh(part.mesh) && part.mesh.geometry === part.geometry
      && part.geometryCurrent()
      && this.hooks.get(part.geometry)?.subscription.isCurrent() === true
      && this.hooks.get(part.geometry)?.uploads.isCurrent() === true
      && part.mesh.material === part.material && part.presentation === presentationSignature(part.mesh)
      && part.materialState === this.readMaterialState(part.materialWatch, materialStates) && part.localNodes.every(local => local.node.parent === local.parent
        && local.value === localSignature(local.node));
  }
  private readMaterialState(read: Part['materialWatch'], states?: Map<Part['materialWatch'], string>): string {
    const cached = states?.get(read);
    if (cached !== undefined) return cached;
    const state = read(); states?.set(read, state); return state;
  }
  private updateGroups(allowNewCarriers = true): void {
    for (const group of this.groups) if (!this.updateGroup(group, true, allowNewCarriers)) {
      if (!this.deferredLayout) for (const part of group.parts) this.optOut.add(part.model);
      this.clear(); this.layoutKey = ''; break;
    }
    this.deferredLayout = false;
  }
  private updateGroup(group: BatchGroup, notifyAdded = true, allowNewCarriers = true): boolean {
    const rows: EntityArrayThinInstanceTransform[] = [];
    for (const part of group.parts) {
      if (!this.options.isEntityVisible(part.entityId) || !part.mesh.isEnabled() || !part.mesh.isVisible) continue;
      const world = currentWorld(part.mesh);
      const transform = part.worldUpdateId === world.updateFlag ? part.transform : worldTransform(part.mesh, world);
      if (!transform) return false;
      part.worldUpdateId = world.updateFlag; part.transform = transform;
      rows.push({ entityId: part.entityId, transform, pickable: this.options.isEntityPickable(part.entityId) && part.mesh.isPickable });
    }
    const key = JSON.stringify(rows);
    if (key === group.frameKey) return true;
    if (!allowNewCarriers) {
      const orientations = new Set(group.batch.meshes.map(mesh => mesh.scaling.x < 0 ? -1 : 1));
      const addsOrientation = rows.some(row => !orientations.has(row.transform.scale.x * row.transform.scale.y * row.transform.scale.z < 0 ? -1 : 1));
      // 现有阵列从128行起允许空间分片；晚到的变化无法证明只改原分片时，恢复源并留给下一次 pre-light sync。
      if (addsOrientation || Math.max(rows.length, group.batch.getEntityIds().length) >= 128) {
        this.deferredLayout = true; return false;
      }
    }
    const beforeMeshes = new Set(group.batch.meshes);
    if (!group.batch.updateEntityTransforms(currentWorld(group.parts[0].mesh).clone(), rows)) return false;
    group.frameKey = key;
    // 正负 determinant 或空间分片变化可能创建载体，宿主映射必须同帧刷新。
    if (notifyAdded && (group.batch.meshes.length !== beforeMeshes.size
      || group.batch.meshes.some(mesh => !beforeMeshes.has(mesh)))) this.options.onBatchAdded(group.batch);
    return true;
  }
  private installGeometryHook(part: Part): void {
    let hook = this.hooks.get(part.geometry);
    if (!hook) {
      const models = new Set<ModelRuntimeEntry>();
      const subscription = subscribeLightingGeometryUpdates(part.geometry, (_geometry, kind) => {
        if (kind && INSTANCE_ATTRIBUTES.has(kind)) return;
        for (const model of [...models]) this.markModelDirty(model);
      });
      const buffers = part.mesh.getVerticesDataKinds().map(kind => part.mesh.getVertexBuffer(kind)!.getBuffer()!);
      const index = part.geometry.getIndexBuffer(); if (index) buffers.push(index);
      let uploads: ReturnType<typeof subscribeLightingBufferUploads>;
      try {
        uploads = subscribeLightingBufferUploads(this.scene.getEngine(), buffers, () => {
          for (const model of [...models]) this.markModelDirty(model);
        });
      } catch (error) { subscription.release(); throw error; }
      hook = { subscription, uploads, models }; this.hooks.set(part.geometry, hook);
      if (!uploads.isCurrent()) throw new Error('无法完整观察源几何的公开buffer上传入口。');
    }
    hook.models.add(part.model);
  }
  private clear(notify = true): void {
    const changed = this.groups.length > 0 || this.suspendedMeshes.size > 0;
    // 先解除逻辑抑制再删除载体，源集合和对象从未改变。
    this.suspendedMeshes.clear();
    for (const hook of this.hooks.values()) {
      if (!hook.uploads.isCurrent()) this.bufferUploadsRejected = true;
      hook.subscription.release();
      hook.uploads.release();
      // 上传通知已快照多个共享buffer订阅；首个clear后，后续已命中的hook仍需知道所有受影响宿主。
    }
    this.hooks.clear();
    for (const group of this.groups.splice(0)) {
      for (const mesh of group.batch.meshes) this.retiredCarriers.add(mesh);
      try { this.options.onBatchRemoved(group.batch); } catch (error) { this.fallbackReason = String(error); }
      finally { group.batch.dispose(); }
    }
    if (changed && notify) {
      try { this.options.onChanged(); } catch (error) { this.fallbackReason = String(error); }
    }
  }
}

function under(node: Node, ancestors: readonly Node[]): boolean {
  for (let current: Node | null = node; current; current = current.parent) if (ancestors.includes(current)) return true;
  return false;
}
function nodePath(node: Node, root: Node): string {
  const path: Array<[string, number]> = [];
  for (let current: Node | null = node; current && current !== root; current = current.parent) {
    const siblings = current.parent?.getChildren().filter(child => child.name === current!.name) ?? [current];
    path.push([current.name, siblings.indexOf(current)]);
  }
  return JSON.stringify(path.reverse());
}
function observed(mesh: Mesh): boolean {
  return mesh.onBeforeRenderObservable.hasObservers() || mesh.onAfterRenderObservable.hasObservers()
    || mesh.onBeforeDrawObservable.hasObservers() || mesh.onBetweenPassObservable.hasObservers();
}
function eligibleMesh(mesh: Mesh): boolean {
  const material = mesh.material;
  return !mesh.isDisposed() && Boolean(mesh.geometry) && mesh.getTotalVertices() > 0 && !mesh.getChildren().length
    && observableGeometry(mesh)
    && mesh.thinInstanceCount === 0 && mesh.instances.length === 0 && !mesh.skeleton && !mesh.morphTargetManager?.numTargets
    && !mesh.bakedVertexAnimationManager && !mesh.animations.length && !observed(mesh) && !mesh.actionManager
    && !mesh.edgesRenderer && !mesh.forcedInstanceCount
    && !mesh.getScene().lights.some(light => light.includedOnlyMeshes.includes(mesh) || light.excludedMeshes.includes(mesh))
    && mesh.billboardMode === 0 && !mesh.infiniteDistance && mesh.subMeshes.length === 1
    && mesh.subMeshes[0].verticesStart === 0 && mesh.subMeshes[0].verticesCount === mesh.getTotalVertices()
    && mesh.subMeshes[0].indexStart === 0 && mesh.subMeshes[0].indexCount === mesh.getTotalIndices()
    && Boolean(material && (Object.getPrototypeOf(material) === StandardMaterial.prototype || Object.getPrototypeOf(material) === PBRMaterial.prototype)
      && !material.needAlphaBlendingForMesh(mesh) && !material.needAlphaTestingForMesh(mesh)
      && material.alpha === 1 && !material.onBindObservable.hasObservers() && !material.onUnBindObservable.hasObservers()
      && !material.onEffectCreatedObservable.hasObservers()
      && !Reflect.get(material, 'customShaderNameResolve'));
}

/** 保持原updatable属性；仅在公开上传可被完整观察时接管，实际写入前恢复源绘制。 */
function observableGeometry(mesh: Mesh): boolean {
  const geometry = mesh.geometry;
  if (!geometry || !canObserveLightingBufferUploads(mesh.getScene().getEngine())) return false;
  return mesh.getVerticesDataKinds().every(kind => {
    const buffer = mesh.getVertexBuffer(kind);
    return !!buffer?.getBuffer() && !buffer.getIsInstanced();
  });
}

/** 静态缓冲仍可整体替换；同时核对CPU VertexBuffer与实际GPU Buffer身份，覆盖无通知的替换路径。 */
function watchGeometryBuffers(mesh: Mesh): () => boolean {
  const geometry = mesh.geometry!, index = geometry.getIndexBuffer();
  const buffers = mesh.getVerticesDataKinds().map(kind => {
    const buffer = mesh.getVertexBuffer(kind)!;
    return { kind, buffer, data: buffer.getBuffer(), layout: [buffer.byteStride, buffer.byteOffset, buffer.type, buffer.normalized, buffer.getSize()].join('/') };
  });
  return () => geometry.getIndexBuffer() === index && mesh.getVerticesDataKinds().length === buffers.length
    && buffers.every(item => {
      const buffer = mesh.getVertexBuffer(item.kind);
      return buffer === item.buffer && buffer.getBuffer() === item.data
        && [buffer.byteStride, buffer.byteOffset, buffer.type, buffer.normalized, buffer.getSize()].join('/') === item.layout;
    });
}

/** 工厂旧包将参数运行类登记在animationScripts；只接受同脚本的参数登记与已实际加载的dataDriven证据。 */
function registeredParameterRuntime(asset: NonNullable<ModelRuntimeEntry['resolvedModelAsset']>, configs: readonly unknown[]): boolean {
  const scripts = new Set((asset.scriptAssets ?? []).map(script => script.name.trim().toLowerCase()).filter(Boolean));
  if (!scripts.size || configs.length < scripts.size || configs.some(config => !config || typeof config !== 'object'
    || !Reflect.get(config, 'device') || typeof Reflect.get(config, 'device') !== 'object'
    || typeof Reflect.get(Reflect.get(config, 'device') as object, 'devType') !== 'string')) return false;
  const parameters = (asset.parameterScriptMetadata ?? []).map(readScriptRegistration);
  return (asset.animationScriptMetadata ?? []).every(value => {
    const runtime = readScriptRegistration(value);
    if (!runtime || !scripts.has(runtime.file)) return false;
    return parameters.some(parameter => parameter?.file === runtime.file
      && (parameter.className === runtime.className || (parameter.className === 'ParametricModelParamsComponent'
        && runtime.className === 'ParametricModelRuntimeComponent')));
  });
}
function readScriptRegistration(value: unknown): { file: string; className: string } | null {
  if (!value || typeof value !== 'object') return null;
  const file: unknown = Reflect.get(value, 'scriptFilename'), className: unknown = Reflect.get(value, 'className');
  return typeof file === 'string' && file.trim() && typeof className === 'string' && className.trim()
    ? { file: file.trim().toLowerCase(), className: className.trim() } : null;
}
function presentationSignature(mesh: Mesh): string {
  return JSON.stringify(PRESENTATION_FIELDS.map(key => snapshotValue(Reflect.get(mesh, key))));
}
function localSignature(node: TransformNode): string {
  return JSON.stringify([node.position.asArray(), node.rotation.asArray(), node.rotationQuaternion?.asArray(),
    node.scaling.asArray(), node.getPivotMatrix().asArray(), node.billboardMode, node.infiniteDistance, node.animations.length]);
}
function currentWorld(mesh: Mesh): Matrix {
  const ancestors: TransformNode[] = [];
  for (let current: Node | null = mesh; current; current = current.parent) {
    if ('computeWorldMatrix' in current && 'position' in current) ancestors.push(current as TransformNode);
  }
  // 源 Mesh 不进入主相机候选，必须先推进祖先；同帧重复检查保持 Babylon 的同步矩阵缓存。
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const node = ancestors[index]; node.computeWorldMatrix(!node.isSynchronized());
  }
  return mesh.getWorldMatrix();
}
function worldTransform(mesh: Mesh, world = currentWorld(mesh)): TransformComponent | null {
  const scale = new Vector3(), rotation = new Quaternion(), position = new Vector3();
  if (!world.m.every(Number.isFinite) || !world.decompose(scale, rotation, position)) return null;
  // 旧独立Mesh与thin实例的法线shader路径不同；非均匀缩放未经同像素证明时保留原路径，不扩大既有GD失败范围。
  if (mesh.nonUniformScaling || scale.isNonUniformWithinEpsilon(1e-6)) return null;
  const euler = rotation.toEulerAngles();
  const roundTrip = Matrix.Compose(scale, Quaternion.RotationYawPitchRoll(euler.y, euler.x, euler.z), position);
  if (world.m.some((value, index) => Math.abs(value - roundTrip.m[index]) > 1e-5 * Math.max(1, Math.abs(value)))) return null;
  return { position: { x: position.x, y: position.y, z: position.z }, rotation: { x: euler.x, y: euler.y, z: euler.z },
    scale: { x: scale.x, y: scale.y, z: scale.z } };
}
function geometrySignature(mesh: Mesh): unknown {
  return [mesh.getVerticesDataKinds().sort().map(kind => {
    const buffer = mesh.getVertexBuffer(kind), data = mesh.getVerticesData(kind);
    if (!buffer || !data || !Array.from(data).every(Number.isFinite) || buffer.getIsInstanced()) throw new Error('不支持的顶点数据。');
    return [kind, buffer.getSize(), buffer.type, buffer.normalized, Array.from(data)];
  }), Array.from(mesh.getIndices() ?? [])];
}

/** 从一次序列化的实际字段生成直接读属性的轻量监视，避免逐帧 serialize 大材质。 */
function createMaterialWatch(material: Material, schema: Record<string, unknown>, textureIdentity: (texture: BaseTexture) => number): {
  read: () => string; textureIdentities: number[];
} {
  const readers: Array<() => unknown> = [];
  const identities = new WeakMap<object, number>();
  const nestedTextures: Array<{ read: () => unknown; texture: BaseTexture; content: object }> = [];
  let nextIdentity = 0;
  const visit = (read: () => unknown, shape: Record<string, unknown>, topLevel = false) => {
    const original = read();
    const decoratedFields = new Set<string>();
    if (original instanceof BaseTexture) {
      if ((shape as unknown) === original) throw new Error('材质序列化快照引用了实际运行时对象，不能清理导出字段。');
      // 递归实际纹理也须进入group身份与指针监视，不能只删导出字段却漏掉嵌套irradiance的GPU内容。
      nestedTextures.push({ read, texture: original, content: original.getInternalTexture() ?? original });
      for (const field of TEXTURE_EXPORT_FIELDS) delete shape[field];
    }
    if (original && typeof original === 'object' && 'getClassName' in original) {
      const decorated = GetMergedStore(original) as Record<string, { type: number }>;
      for (const [property, descriptor] of Object.entries(decorated)) {
        if (topLevel && ['name', 'id', 'uniqueId'].includes(property)) continue;
        decoratedFields.add(property);
        readers.push(() => {
          const target = read();
          const value: unknown = target && typeof target === 'object' ? Reflect.get(target, property) : null;
          if (value && typeof value === 'object' && [1, 3, 7, 9].includes(descriptor.type)) {
            let identity = identities.get(value);
            if (!identity) { identity = ++nextIdentity; identities.set(value, identity); }
            return identity;
          }
          return snapshotValue(value);
        });
      }
    }
    for (const [key, value] of Object.entries(shape)) {
      if (['tags', 'plugins', 'customType'].includes(key)) continue;
      const current = read();
      if (!current || typeof current !== 'object') continue;
      const mapped = original instanceof BaseTexture ? TEXTURE_LIVE_FIELDS[key] : undefined;
      const field = (mapped ? [mapped] : [key, key + 'Color', '_' + key]).find(candidate => candidate in current);
      if (!field) {
        if (value === undefined || value === null) continue;
        throw new Error('无法监视材质字段：' + key);
      }
      const child = () => { const target = read(); return target && typeof target === 'object' ? Reflect.get(target, field) : null; };
      // Cube的serializeAsMatrix返回Float32Array；须直接读取实际Matrix/向量快照，不能把数字下标当live属性。
      if (value && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value)) visit(child, value as Record<string, unknown>);
      // 仅去掉同一实际属性的重复leaf；不同公开getter别名仍独立监视，递归对象也不省略。
      else if (!decoratedFields.has(field)) readers.push(() => snapshotValue(child()));
    }
  };
  visit(() => material, schema, true);
  const knownPlugins: Record<string, string> = { DetailMapConfiguration: 'detailMap', PBRBRDFConfiguration: 'brdf',
    PBRClearCoatConfiguration: 'clearCoat', PBRAnisotropicConfiguration: 'anisotropy',
    PBRIridescenceConfiguration: 'iridescence', PBRSheenConfiguration: 'sheen', PBRSubSurfaceConfiguration: 'subSurface' };
  for (const [name, shape] of Object.entries((schema.plugins ?? {}) as Record<string, unknown>)) {
    const property = knownPlugins[name];
    if (!property) throw new Error('未知材质插件：' + name);
    visit(() => Reflect.get(material, property), shape as Record<string, unknown>);
  }
  const textures = material.getActiveTextures();
  const textureContents = textures.map(texture => texture.getInternalTexture() ?? texture);
  const allTextures = [...new Set([...textures, ...nestedTextures.map(value => value.texture)])];
  if (allTextures.some(texture => ![Texture.prototype, CubeTexture.prototype].includes(Object.getPrototypeOf(texture))
    || !texture.isReady() || texture.animations?.length)) throw new Error('纹理尚未就绪或存在未知动态纹理。');
  const read = () => {
    const current = material.getActiveTextures();
    if (current.length !== textures.length || current.some((texture, index) => texture !== textures[index])) return 'textures-changed';
    // updateURL可保持wrapper/name/url不变而换buffer；新InternalTexture必须立即归还原件。
    if (current.some((texture, index) => (texture.getInternalTexture() ?? texture) !== textureContents[index])) return 'texture-content-changed';
    if (nestedTextures.some(value => value.read() !== value.texture
      || (value.texture.getInternalTexture() ?? value.texture) !== value.content)) return 'nested-texture-content-changed';
    const manager: unknown = Reflect.get(material, 'pluginManager');
    const plugins: unknown = manager && typeof manager === 'object' ? Reflect.get(manager, '_plugins') : null;
    return JSON.stringify([readers.map(read => read()), current.map(texture => [texture.name,
      texture.getTextureMatrix().asArray(), texture.isReady()]), Array.isArray(plugins) ? plugins.length : 0]);
  };
  return { read, textureIdentities: allTextures.map(textureIdentity) };
}
function serializeMaterialWithoutTextureMutation(material: Material): Record<string, unknown> {
  const textures: Array<{ texture: BaseTexture; name: string; hasUrl: boolean; url: unknown }> = [];
  const visited = new Set<BaseTexture>();
  const collect = (texture: BaseTexture): void => {
    if (visited.has(texture)) return;
    visited.add(texture);
    textures.push({ texture, name: texture.name, hasUrl: 'url' in texture, url: Reflect.get(texture, 'url') as unknown });
    // 与primary SerializationHelper的Texture descriptor一致，覆盖Cube递归序列化的irradiance等真实纹理关系。
    const descriptors = GetMergedStore(texture) as Record<string, { type: number }>;
    for (const [property, descriptor] of Object.entries(descriptors)) {
      if (descriptor.type !== 1) continue;
      const nested: unknown = Reflect.get(texture, property);
      if (nested instanceof BaseTexture) collect(nested);
    }
  };
  for (const texture of material.getActiveTextures()) collect(texture);
  try { return material.serialize() as Record<string, unknown>; }
  finally {
    // Texture.serialize会清空某些data URL；仅取比较快照，不能改写业务脚本查询的源字段。
    for (const { texture, name, hasUrl, url } of textures) {
      texture.name = name;
      if (hasUrl) Reflect.set(texture, 'url', url);
    }
  }
}
function snapshotValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'asArray' in value && typeof value.asArray === 'function') return value.asArray();
  if (Array.isArray(value)) return value.map(snapshotValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== 'function'));
  return value;
}
