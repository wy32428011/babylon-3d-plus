import { AssetContainer } from '@babylonjs/core/assetContainer.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { LocatorComponent, ModelGeneratorTarget } from '../../../editor/model/components';
import { sanitizeFetchSyncIntervalSeconds, type FetchConfig } from '../../../editor/model/SceneDocument';
import { LocatorFetchRuntime, type FetchContainerRecord } from '../LocatorFetchRuntime';
import { readUtf8ResponseText } from '../../../shared/text/strictUtf8';
import { createRuntimeModelAssetFromTarget, sanitizeModelAssetTemplate } from '../../../editor/model/modelGenerator';
import { buildCompositionNodeTree, readCompositionNodeArraySourceId, readCompositionNodeMeshRenderer } from '../composition/compositionCargoBuilder';
import { getCompositionLibraryEntry } from '../composition/compositionCargoCache';
import { sanitizeBabylonName } from '../runtimeValueUtils';
import { getMeshesWorldBottomCenter } from '../runtimeNodeGeometry';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import { runSceneRuntimeCleanup } from './sceneRuntimeCleanup';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import type { GeneratedModelOutputController } from './GeneratedModelOutputController';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { SceneDocumentController } from './SceneDocumentController';
import type { SceneLocatorController } from './SceneLocatorController';
import type { SceneTelemetryController } from './SceneTelemetryController';
import type { SceneTriangleAndReadinessController } from './SceneTriangleAndReadinessController';
import { COMPOSITION_ARRAY_MAX_INSTANCES, COMPOSITION_FETCH_MAX_PARTS, type LocatorRuntimeEntry } from './sceneRuntimeTypes';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly assets: Pick<ModelAssetRuntimeController, 'splitAssetUrl' | 'resolveVersionedRuntimeAssetUrl' | 'loadAssetContainer'>;
  readonly outputs: Pick<GeneratedModelOutputController, 'createModelGeneratorMesh' | 'modelGenerators' | 'defaultCargoGeneratorId'>;
  readonly presentation: Pick<SceneMeshPresentationController, 'readColor'>;
  readonly document: Pick<SceneDocumentController, 'disposed' | 'syncedEntities'>;
  readonly locators: Pick<SceneLocatorController, 'locators' | 'getLocatorBoxWorldMatrix'>;
  readonly telemetry: Pick<SceneTelemetryController, 'specializedTelemetryRuntime'>;
  readonly readiness: Pick<SceneTriangleAndReadinessController, 'invalidateModelStatistics'>;
};


/** SceneLocatorFetchController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class SceneLocatorFetchController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  /** fetch 数据驱动的定位线框渲染运行时，按定位线框实体组织。 */
  public readonly locatorFetchRuntimes = new Map<string, LocatorFetchRuntime>();
  /** fetch 请求代际戳与每排最新请求序号：响应仅在仍是该排最新请求时应用，防止乱序覆盖。 */
  public fetchRequestGeneration = 0;
  public readonly latestFetchRequestByRow = new Map<number, number>();
  /** 运行预览开始时捕获的 fetch 配置，供事件驱动的单排同步复用。 */
  public fetchConfigSnapshot: FetchConfig | null = null;
  /** 定时全量同步定时器；由 handleFetchDriveEvent 启动，endTelemetryPreview 停止。 */
  public fetchSyncTimer: ReturnType<typeof setInterval> | null = null;
  /** 在途 fetch 操作计数（覆盖请求与响应应用两段）：非 0 时定时 tick 跳过本轮。 */
  public fetchInFlightOperations = 0;
  /** 定时同步失败提示去重标志；成功响应或重新启表后复位。 */
  public fetchSyncFailureReported = false;
  /** 已放货到 fetch 驱动定位线框、等待单排同步响应后再销毁的 MQTT 货箱（按排号分组）。 */
  public readonly fetchKeptCargoByRow = new Map<number, Set<string>>();
  private readonly pendingRequests = new Set<AbortController>();
  private operationGeneration = 0;
  private disposed = false;

  /** 停止生产新请求，并隔离旧预览的响应和 finally；批次在货物驱动停止后另行清理。 */
  stopPreviewRequests(): void {
    this.stopFetchSyncTimer();
    this.operationGeneration += 1;
    this.latestFetchRequestByRow.clear();
    this.fetchConfigSnapshot = null;
    this.fetchInFlightOperations = 0;
    this.fetchSyncFailureReported = false;
    for (const controller of this.pendingRequests) controller.abort();
    this.pendingRequests.clear();
  }

  /** 退出预览只释放库存批次；定位线框和可重用的 Fetch 运行时留给下一次预览。 */
  resetPreview(): void {
    this.stopPreviewRequests();
    this.fetchKeptCargoByRow.clear();
    for (const [entityId, runtime] of this.locatorFetchRuntimes) {
      runSceneRuntimeCleanup(this.context, `Fetch 批次 ${entityId}`, () => runtime.clearAllBatches());
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPreviewRequests();
    this.fetchKeptCargoByRow.clear();
    for (const entityId of [...this.locatorFetchRuntimes.keys()]) {
      runSceneRuntimeCleanup(this.context, `Fetch 运行时 ${entityId}`, () => this.disposeLocatorFetchRuntime(entityId));
    }
  }

  /** 为 fetch thinInstance 加载模型模板：走完整资产加载管线并应用单位换算。 */
  public async loadModelTemplateForFetch(target: ModelGeneratorTarget): Promise<{ meshes: Mesh[]; dispose: () => void } | null> {
    if (target.kind === 'composition') return this.loadCompositionTemplateForFetch(target);
    if (target.kind !== 'model') return null;

    const modelAsset = createRuntimeModelAssetFromTarget(target, 'FETCH_TMPL');
    if (!modelAsset) return null;

    try {
      const { rootUrl, fileName } = this.dependencies.assets.splitAssetUrl(
        this.dependencies.assets.resolveVersionedRuntimeAssetUrl(modelAsset.sourceUrl, modelAsset.assetRevision),
      );

      const container = await this.dependencies.assets.loadAssetContainer(rootUrl, fileName);
      container.addAllToScene();

      // GLB 的 meshes[0] 通常是无几何的 __root__ 节点，须过滤出真正有顶点的 mesh
      const meshes = container.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0);
      if (meshes.length === 0) {
        container.dispose();
        return null;
      }

      let scaleNode: TransformNode | null = null;
      const unitScale = modelAsset.unitScaleToMeters;
      if (unitScale !== 1) {
        scaleNode = new TransformNode('_fetch_tmpl_scale', this.context.scene);
        scaleNode.scaling = new Vector3(unitScale, unitScale, unitScale);
        for (const rootNode of container.rootNodes) {
          rootNode.parent = scaleNode;
        }
      }

      // 与 normalizeModelContentOrigin 同语义：把内容包围盒底部中心平移到原点，
      // getLocatorBoxWorldMatrix 的格口矩阵平移即底面中心，实例落位后货物底部贴合格口。
      const anchorNode = new TransformNode('_fetch_tmpl_anchor', this.context.scene);
      if (scaleNode) scaleNode.parent = anchorNode;
      else {
        for (const rootNode of container.rootNodes) {
          rootNode.parent = anchorNode;
        }
      }
      const bottomCenter = getMeshesWorldBottomCenter(meshes);
      if (bottomCenter) anchorNode.position = bottomCenter.scale(-1);

      return {
        meshes,
        dispose: () => {
          container.dispose();
          anchorNode.dispose();
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`Fetch 模板模型加载失败：${message}`]);
      return null;
    }
  }

  /**
   * 为 fetch thinInstance 加载组合模板：成员模型独占容器加载并应用单位换算，
   * 阵列实例按成员相对矩阵展开为克隆网格，整树包围盒底部中心锚定到原点。
   */
  public async loadCompositionTemplateForFetch(
    target: Extract<ModelGeneratorTarget, { kind: 'composition' }>,
  ): Promise<{ meshes: Mesh[]; dispose: () => void } | null> {
    try {
      const entry = await getCompositionLibraryEntry(target.libraryId, target.revision);
      const tree = buildCompositionNodeTree(entry.definition, this.context.scene, '_fetch_tmpl_comp');
      const containers: AssetContainer[] = [];
      const meshes: Mesh[] = [];

      const arrayInstanceIdsBySource = new Map<string, string[]>();
      for (const node of entry.definition.nodes) {
        if (node.visible === false) continue;
        const sourceId = readCompositionNodeArraySourceId(node);
        if (!sourceId) continue;
        const list = arrayInstanceIdsBySource.get(sourceId);
        if (list) list.push(node.id);
        else arrayInstanceIdsBySource.set(sourceId, [node.id]);
      }

      try {
        for (const node of entry.definition.nodes) {
          if (node.visible === false) continue;
          const memberRoot = tree.nodes.get(node.id);
          if (!memberRoot) continue;
          if (readCompositionNodeArraySourceId(node)) continue;

          const memberName = `_fetch_tmpl_comp_${sanitizeBabylonName(node.id)}`;
          const meshRenderer = readCompositionNodeMeshRenderer(node);
          if (meshRenderer) {
            const mesh = this.dependencies.outputs.createModelGeneratorMesh(memberName, meshRenderer.meshKind);
            const material = new StandardMaterial(`${memberName}_material`, this.context.scene);
            material.diffuseColor = this.dependencies.presentation.readColor(meshRenderer.materialColor);
            mesh.material = material;
            mesh.parent = memberRoot;
            meshes.push(mesh);
            continue;
          }

          const template = sanitizeModelAssetTemplate(node.components.modelAsset);
          if (!template) continue;
          const { rootUrl, fileName } = this.dependencies.assets.splitAssetUrl(
            this.dependencies.assets.resolveVersionedRuntimeAssetUrl(template.sourceUrl, template.assetRevision),
          );
          const container = await this.dependencies.assets.loadAssetContainer(rootUrl, fileName);
          containers.push(container);
          container.addAllToScene();

          const scaleNode = new TransformNode(`${memberName}_scale`, this.context.scene);
          scaleNode.scaling = new Vector3(template.unitScaleToMeters, template.unitScaleToMeters, template.unitScaleToMeters);
          scaleNode.parent = memberRoot;
          for (const rootNode of container.rootNodes) {
            rootNode.parent = scaleNode;
          }

          // GLB 的 meshes[0] 通常是无几何的 __root__ 节点，须过滤出真正有顶点的 mesh
          const memberMeshes = container.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0);
          const instanceNodeIds = arrayInstanceIdsBySource.get(node.id) ?? [];
          if (instanceNodeIds.length === 0) {
            meshes.push(...memberMeshes);
            continue;
          }

          const replicaNodeIds = [node.id, ...instanceNodeIds];
          if (replicaNodeIds.length > COMPOSITION_ARRAY_MAX_INSTANCES) {
            throw new Error(`组合阵列实例数 ${replicaNodeIds.length} 超过 ${COMPOSITION_ARRAY_MAX_INSTANCES} 上限。`);
          }
          if (meshes.length + memberMeshes.length * replicaNodeIds.length > COMPOSITION_FETCH_MAX_PARTS) {
            throw new Error(`组合模板展开后 Mesh 数量超过 ${COMPOSITION_FETCH_MAX_PARTS} 上限。`);
          }

          tree.root.computeWorldMatrix(true);
          const inverseSourceWorld = memberRoot.getWorldMatrix().clone();
          inverseSourceWorld.invert();
          meshes.push(...memberMeshes);
          for (const replicaNodeId of instanceNodeIds) {
            const replicaRoot = tree.nodes.get(replicaNodeId);
            if (!replicaRoot) throw new Error('组合阵列实例节点缺失。');
            for (const sourceMesh of memberMeshes) {
              sourceMesh.computeWorldMatrix(true);
              const local = sourceMesh.getWorldMatrix().multiply(inverseSourceWorld);
              const scale = new Vector3();
              const rotation = new Quaternion();
              const translation = new Vector3();
              if (!local.decompose(scale, rotation, translation)) {
                throw new Error('组合阵列实例矩阵无法分解为 TRS。');
              }
              const clone = sourceMesh.clone(`${sourceMesh.name}_replica_${sanitizeBabylonName(replicaNodeId)}`, null, true);
              if (!clone) throw new Error('组合阵列实例克隆失败。');
              clone.parent = replicaRoot;
              clone.position.copyFrom(translation);
              clone.rotationQuaternion = null;
              clone.rotation.copyFrom(rotation.toEulerAngles());
              clone.scaling.copyFrom(scale);
              meshes.push(clone);
            }
          }
        }

        if (meshes.length === 0) throw new Error(`组合“${entry.name}”没有可渲染成员。`);

        // 与单模型模板同语义：整树包围盒底部中心平移到原点，getLocatorBoxWorldMatrix 格口矩阵平移即底面中心。
        const anchorNode = new TransformNode('_fetch_tmpl_comp_anchor', this.context.scene);
        tree.root.parent = anchorNode;
        const bottomCenter = getMeshesWorldBottomCenter(meshes);
        if (bottomCenter) anchorNode.position = bottomCenter.scale(-1);

        return {
          meshes,
          dispose: () => {
            for (const container of containers) container.dispose();
            anchorNode.dispose();
          },
        };
      } catch (error) {
        for (const container of containers) container.dispose();
        tree.dispose();
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`Fetch 组合模板加载失败：${message}`]);
      return null;
    }
  }

  /** 进入运行预览时执行一次全量库存同步，并按配置启动定时全量同步；无 fetch 驱动定位线框时直接返回。 */
  async handleFetchDriveEvent(fetchConfig: FetchConfig): Promise<void> {
    if (this.disposed || this.dependencies.document.disposed) return;
    this.fetchConfigSnapshot = fetchConfig;
    const targets = this.collectFetchDriveLocators();
    if (targets.length === 0) {
      this.stopFetchSyncTimer();
      return;
    }

    this.startFetchSyncTimer(fetchConfig);
    await this.runFetchFullSync(fetchConfig, targets);
  }

  /** 全量库存同步体：一次全量请求 + 按排代际校验分发；初始化与定时 tick 共用。 */
  public async runFetchFullSync(
    fetchConfig: FetchConfig,
    targets: Array<{ entityId: string; locatorEntry: LocatorRuntimeEntry; locatorComponent: LocatorComponent }>,
    options: { quietFailure?: boolean } = {},
  ): Promise<void> {
    if (this.disposed || this.dependencies.document.disposed) return;
    const release = this.beginFetchOperation();
    try {
      const generation = ++this.fetchRequestGeneration;
      for (const target of targets) {
        this.latestFetchRequestByRow.set(target.locatorComponent.rowNumber, generation);
      }

      const records = await this.fetchInventoryRecords(fetchConfig, [], options.quietFailure === true);
      if (records === null) return;

      for (const target of targets) {
        // 全量响应到达时该排可能已有更新的单排请求，跳过避免旧数据覆盖新状态
        if (this.latestFetchRequestByRow.get(target.locatorComponent.rowNumber) !== generation) continue;
        this.applyFetchRecordsToLocator(records, target);
      }
    } finally {
      release();
    }
  }

  /** 堆垛机放货/取货完成后同步单排库存；同排多台定位线框共享一次请求。 */
  handleFetchRowSync(rowNumber: number): void {
    if (this.disposed || this.dependencies.document.disposed) return;
    const fetchConfig = this.fetchConfigSnapshot;
    if (!fetchConfig?.url) return;
    const targets = this.collectFetchDriveLocators()
      .filter((target) => target.locatorComponent.rowNumber === rowNumber);
    if (targets.length === 0) return;

    const generation = ++this.fetchRequestGeneration;
    this.latestFetchRequestByRow.set(rowNumber, generation);

    void (async () => {
      const release = this.beginFetchOperation();
      try {
        const records = await this.fetchInventoryRecords(fetchConfig, [String(rowNumber)]);
        if (records === null) return;
        if (this.latestFetchRequestByRow.get(rowNumber) !== generation) return;
        for (const target of targets) {
          this.applyFetchRecordsToLocator(records, target);
          // 响应应用后再解除格口抑制：此时 records 已反映取/放结果，解除不会闪出旧货物
          this.locatorFetchRuntimes.get(target.entityId)?.clearSuppressedCells();
        }
        this.disposeFetchKeptCargoForRow(rowNumber);
      } finally {
        release();
      }
    })();
  }

  /** 统一发 fetch 库存请求：dataflow 接口忽略 rows 始终全量返回，按排过滤在客户端完成；失败时记日志并返回 null。 */
  public async fetchInventoryRecords(fetchConfig: FetchConfig, rows: string[], quietFailure = false): Promise<FetchContainerRecord[] | null> {
    if (!fetchConfig.url || this.disposed || this.dependencies.document.disposed) return null;
    const controller = new AbortController();
    this.pendingRequests.add(controller);
    const isCurrent = () => !controller.signal.aborted && !this.disposed && !this.dependencies.document.disposed;

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
      if (fetchConfig.apiKey) headers['X-API-Key'] = fetchConfig.apiKey;

      const response = await fetch(fetchConfig.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ rows }),
        signal: controller.signal,
      });
      if (!isCurrent()) return null;

      if (!response.ok) {
        this.reportFetchFailure(`Fetch 请求失败：HTTP ${response.status}`, quietFailure);
        return null;
      }

      // dataflow 响应结构：data.records 为结果分组数组，货物记录在每组的 result 里
      const text = await readUtf8ResponseText(response, 'Fetch 响应');
      if (!isCurrent()) return null;
      const payload = JSON.parse(text) as {
        data?: { records?: Array<{ result?: FetchContainerRecord[] }> };
      };
      const groups = payload.data?.records;
      if (!Array.isArray(groups)) {
        this.reportFetchFailure('Fetch 响应缺少 data.records。', quietFailure);
        return null;
      }
      const records: FetchContainerRecord[] = [];
      for (const group of groups) {
        if (Array.isArray(group?.result)) records.push(...group.result);
      }
      // 任一请求成功即视为链路恢复，允许下一轮定时失败重新提示
      this.fetchSyncFailureReported = false;
      return records;
    } catch (error) {
      if (!isCurrent()) return null;
      const message = error instanceof Error ? error.message : String(error);
      this.reportFetchFailure(`Fetch 处理异常：${message}`, quietFailure);
      return null;
    } finally {
      this.pendingRequests.delete(controller);
    }
  }

  /** 标记一次 fetch 操作在途；返回的释放函数必须放在 finally 中调用，保证计数成对。 */
  public beginFetchOperation(): () => void {
    const generation = this.operationGeneration;
    this.fetchInFlightOperations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // 退出后立即重进预览时，旧请求的 finally 不得扣减新会话的在途数。
      if (generation === this.operationGeneration) this.fetchInFlightOperations -= 1;
    };
  }

  /** fetch 失败提示：定时路径只提示一次，成功响应或重新启表后复位，避免每分钟刷屏。 */
  public reportFetchFailure(message: string, quiet: boolean): void {
    if (!quiet) {
      Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [message]);
      return;
    }
    if (this.fetchSyncFailureReported) return;
    this.fetchSyncFailureReported = true;
    Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`${message}（定时同步将持续重试，后续相同失败不再提示）`]);
  }

  /** 按 syncIntervalSeconds 启动（或重启）定时全量同步；0 表示关闭定时、仅在预览开始时同步一次。 */
  public startFetchSyncTimer(fetchConfig: FetchConfig): void {
    this.stopFetchSyncTimer();
    if (this.disposed || this.dependencies.document.disposed) return;
    this.fetchSyncFailureReported = false;
    const intervalSeconds = sanitizeFetchSyncIntervalSeconds(fetchConfig.syncIntervalSeconds);
    if (intervalSeconds <= 0) return;
    this.fetchSyncTimer = setInterval(() => { void this.runScheduledFetchSync(); }, intervalSeconds * 1000);
  }

  /** 停止定时全量同步；幂等。 */
  public stopFetchSyncTimer(): void {
    if (this.fetchSyncTimer === null) return;
    clearInterval(this.fetchSyncTimer);
    this.fetchSyncTimer = null;
  }

  /** 定时 tick：在途请求（尤其单排同步）未结束时跳过本轮，避免抢走代际戳致抑制解除与保留货清算丢失。 */
  public async runScheduledFetchSync(): Promise<void> {
    if (this.dependencies.document.disposed || this.fetchSyncTimer === null) return;
    const fetchConfig = this.fetchConfigSnapshot;
    if (!fetchConfig?.url) return;
    if (this.fetchInFlightOperations > 0) return;
    const targets = this.collectFetchDriveLocators();
    if (targets.length === 0) return;
    await this.runFetchFullSync(fetchConfig, targets, { quietFailure: true });
  }

  /** 收集当前启用了 fetch 数据驱动的定位线框及其运行时快照。 */
  public collectFetchDriveLocators(): Array<{
    entityId: string;
    locatorEntry: LocatorRuntimeEntry;
    locatorComponent: LocatorComponent;
  }> {
    const targets: Array<{ entityId: string; locatorEntry: LocatorRuntimeEntry; locatorComponent: LocatorComponent }> = [];
    for (const [entityId, locatorEntry] of this.dependencies.locators.locators) {
      const locatorComponent = this.dependencies.document.syncedEntities.get(entityId)?.components.locator;
      if (!locatorComponent?.fetchDrive?.enabled) continue;
      targets.push({ entityId, locatorEntry, locatorComponent });
    }
    return targets;
  }

  /** 把（可能未按排过滤的）库存记录分发到单条定位线框的 fetch 渲染运行时。 */
  public applyFetchRecordsToLocator(
    records: FetchContainerRecord[],
    target: { entityId: string; locatorEntry: LocatorRuntimeEntry; locatorComponent: LocatorComponent },
  ): void {
    const fetchRuntime = this.locatorFetchRuntimes.get(target.entityId);
    if (!fetchRuntime) return;

    const boundGeneratorId = target.locatorComponent.fetchDrive?.cargoGeneratorId;
    const generatorId = boundGeneratorId && this.dependencies.outputs.modelGenerators.has(boundGeneratorId)
      ? boundGeneratorId
      : this.dependencies.outputs.defaultCargoGeneratorId ?? undefined;
    const generatorComponent = generatorId
      ? this.dependencies.outputs.modelGenerators.get(generatorId)?.component ?? null
      : null;

    // 该排仍有等待单排同步清算的保留货箱时服务端尚未确认放货结果，"本排无该格记录"不可信，抑制保持
    const releaseAbsentSuppressedCells = (this.fetchKeptCargoByRow.get(target.locatorComponent.rowNumber)?.size ?? 0) === 0;
    void fetchRuntime.applyRecords(
      records,
      target.locatorEntry,
      target.locatorComponent,
      generatorComponent,
      (locator, column, layer) => this.dependencies.locators.getLocatorBoxWorldMatrix(locator, column, layer),
      (modelTarget) => this.loadModelTemplateForFetch(modelTarget),
      { releaseAbsentSuppressedCells, generatorId: generatorId ?? null },
    );
  }

  /** 定位线框启用 fetch 驱动时返回其排号，否则返回 null（MQTT 落位语义保持不变）。 */
  public resolveFetchDriveRowForLocator(locator: LocatorRuntimeEntry): number | null {
    const component = this.dependencies.document.syncedEntities.get(locator.entityId)?.components.locator;
    return component?.fetchDrive?.enabled ? locator.rowNumber : null;
  }

  /** 设备取货/放货期间抑制 locator 某格口的 fetch 渲染，货物改由设备侧渲染；未启用 fetch 返回 null。 */
  public suppressFetchCellForLocator(locator: LocatorRuntimeEntry, column: number, layer: number): number | null {
    const rowNumber = this.resolveFetchDriveRowForLocator(locator);
    if (rowNumber === null) return null;
    const fetchRuntime = this.locatorFetchRuntimes.get(locator.entityId);
    if (!fetchRuntime) return null;
    fetchRuntime.suppressCell(column, layer);
    return rowNumber;
  }

  /**
   * 放货到启用「留存货物」的内置货格：持久抑制该格 fetch 渲染并返回排号。
   * 与 suppressFetchCellForLocator 的瞬态抑制不同，持久抑制在单排同步/全量同步后仍保留，直到设备取货时显式释放。
   */
  public retainFetchCellForLocator(locator: LocatorRuntimeEntry, column: number, layer: number): number | null {
    const rowNumber = this.resolveFetchDriveRowForLocator(locator);
    if (rowNumber === null) return null;
    this.locatorFetchRuntimes.get(locator.entityId)?.retainCell(column, layer);
    return rowNumber;
  }

  /** 处置取货完成：解除该格持久抑制，渲染权交还 fetch。 */
  public releaseRetainedFetchCellForLocator(locator: LocatorRuntimeEntry, column: number, layer: number): void {
    this.locatorFetchRuntimes.get(locator.entityId)?.releaseRetainedCell(column, layer);
  }

  /** 放货到 fetch 驱动定位线框后保留 MQTT 货箱，等待单排同步响应时销毁，避免网络延迟造成视觉空窗；返回是否为首次登记。 */
  public keepCargoForFetchRowSync(rowNumber: number | null, assetCode: string, cargoKey: string): boolean {
    if (rowNumber === null) return false;
    const key = JSON.stringify([assetCode, cargoKey]);
    let keys = this.fetchKeptCargoByRow.get(rowNumber);
    if (!keys) {
      keys = new Set();
      this.fetchKeptCargoByRow.set(rowNumber, keys);
    }
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  }

  /** 单排同步响应应用后销毁该排保留的 MQTT 货箱，渲染权完全交给 fetch 批次。 */
  public disposeFetchKeptCargoForRow(rowNumber: number): void {
    const keys = this.fetchKeptCargoByRow.get(rowNumber);
    if (!keys) return;
    this.fetchKeptCargoByRow.delete(rowNumber);
    for (const key of keys) {
      this.dependencies.telemetry.specializedTelemetryRuntime.disposeStackerCargoByKey(key);
      this.dependencies.telemetry.specializedTelemetryRuntime.disposeShuttleCargoByKey(key);
    }
  }

  /** 释放指定定位线框的 fetch 渲染运行时。 */
  public disposeLocatorFetchRuntime(entityId: string): void {
    const fetchRuntime = this.locatorFetchRuntimes.get(entityId);
    if (!fetchRuntime) return;
    this.locatorFetchRuntimes.delete(entityId);
    try {
      fetchRuntime.dispose();
    } finally {
      this.dependencies.readiness.invalidateModelStatistics();
    }
  }
}
