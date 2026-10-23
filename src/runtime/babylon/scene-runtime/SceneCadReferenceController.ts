
import { LinesMesh } from '@babylonjs/core/Meshes/linesMesh.js';

import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Entity } from '../../../editor/model/Entity';
import type { CadReferenceComponent } from '../../../editor/model/components';
import { CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET, CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES, consumeCadReferenceParseResult, type CadReferenceParseResult } from '../../../editor/cad/cadReferenceCore';
import { createCadReferenceDxfWorkerTask, shouldParseCadReferenceDxfInWorker } from '../../../editor/cad/cadReferenceWorkerClient';
import { publishCadReferenceLoadStatus, forgetCadReferenceLoadStatus, registerCadReferenceLoadCancellation } from '../../../editor/cad/cadReferenceLoadStatus';
import { CAD_REFERENCE_MAX_BATCH_POINTS, CAD_REFERENCE_MAX_BATCH_POLYLINES } from '../../../editor/cad/cadReferenceGeometryPolicy';
import { mergeCadReferenceRenderLayers } from '../../../editor/cad/cadReferenceRenderLayers';
import { decodeCadDxfBytes } from '../../../editor/cad/cadTextEncoding';
import { waitForSceneRenderReady } from '../sceneRenderReadiness';
import { sanitizeBabylonName } from '../runtimeValueUtils';
import { resolveRuntimeAssetUrl } from '../../assets/editorAssetUrl';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import type { SceneTransformPreviewController } from './SceneTransformPreviewController';
import type { SceneDocumentController } from './SceneDocumentController';
import { type CadReferenceRuntimeEntry } from './sceneRuntimeTypes';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly presentation: Pick<SceneMeshPresentationController, 'applyTransform' | 'readColor'>;
  readonly assets: Pick<ModelAssetRuntimeController, 'modelLoadSequence'>;
  readonly transforms: Pick<SceneTransformPreviewController, 'clearEntityArrayPreviewIfSource' | 'refreshGroupTransformPreviewTargets'>;
  readonly document: Pick<SceneDocumentController, 'isEntityVisible'>;
};


/** SceneCadReferenceController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class SceneCadReferenceController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  public readonly cadReferences = new Map<string, CadReferenceRuntimeEntry>();

  /** 同步 CAD/DXF 网格参考层，线稿不可拾取，只作为建模布局底图。 */
  public syncCadReferenceEntity(entity: Entity): void {
    const reference = entity.components.cadReference;
    if (!reference) return;
    const existing = this.cadReferences.get(entity.id);
    if (existing && (existing.sourceUrl !== reference.sourceUrl || existing.unitScaleToMeters !== reference.unitScaleToMeters)) {
      this.disposeCadReference(entity.id, existing);
    }
    const current = this.cadReferences.get(entity.id);
    if (current) {
      this.dependencies.presentation.applyTransform(current.root, entity.components.transform);
      this.applyCadReferenceStyle(current, reference);
      this.applyCadReferenceInteractivity(current, entity.id);
      return;
    }
    const root = new TransformNode(entity.id + '_cadReferenceRoot', this.context.scene);
    this.dependencies.presentation.applyTransform(root, entity.components.transform);
    const pending: CadReferenceRuntimeEntry = {
      sourceUrl: reference.sourceUrl, unitScaleToMeters: reference.unitScaleToMeters,
      root, lineMeshes: [], highlighted: false, loadToken: ++this.dependencies.assets.modelLoadSequence,
      lineColor: reference.lineColor, opacity: reference.opacity, geometryReady: false,
      cancelLoad: null, abortController: new AbortController(), unregisterCancellation: () => undefined,
    };
    this.cadReferences.set(entity.id, pending);
    pending.unregisterCancellation = registerCadReferenceLoadCancellation(entity.id, () => {
      if (!this.isActiveCadReferenceLoad(entity.id, pending)) return;
      this.stopCadReferenceLoad(pending);
      publishCadReferenceLoadStatus({ entityId: entity.id, sourceUrl: reference.sourceUrl, state: 'canceled', percent: 0, detail: 'CAD 加载已取消。' });
    });
    this.applyCadReferenceInteractivity(pending, entity.id);
    publishCadReferenceLoadStatus({ entityId: entity.id, sourceUrl: reference.sourceUrl, state: 'loading', percent: 0, detail: '正在加载 CAD 参考图...' });
    void this.loadCadReferenceGeometry(entity.id, pending, reference).catch(error => {
      if (!this.isActiveCadReferenceLoad(entity.id, pending) || pending.abortController.signal.aborted) return;
      const detail = 'CAD 参考图加载失败：' + (error instanceof Error ? error.message : String(error));
      Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [detail]);
      this.stopCadReferenceLoad(pending);
      publishCadReferenceLoadStatus({ entityId: entity.id, sourceUrl: reference.sourceUrl, state: 'error', percent: 100, detail });
    });
  }

  /** 新导入复用缓存；重开同时检查元数据和响应长度，旧场景未知大小走安全后台路径。 */
  public async loadCadReferenceGeometry(entityId: string, pending: CadReferenceRuntimeEntry, reference: CadReferenceComponent): Promise<void> {
    const signal = pending.abortController.signal;
    let geometry = consumeCadReferenceParseResult(reference.sourceUrl, reference.unitScaleToMeters);
    if (!geometry) {
      const useWorker = shouldParseCadReferenceDxfInWorker(reference.sourceFileSizeBytes, { importMode: reference.importMode, preferSafeUnknownSize: true })
        || reference.polylineCount >= CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET.maxPolylines * 0.5
        || reference.pointCount >= CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET.maxPoints * 0.5;
      const parseInWorker = async (): Promise<CadReferenceParseResult> => {
        const task = createCadReferenceDxfWorkerTask(resolveRuntimeAssetUrl(reference.sourceUrl), progress => {
          if (!this.isActiveCadReferenceLoad(entityId, pending)) return;
          publishCadReferenceLoadStatus({ entityId, sourceUrl: reference.sourceUrl, state: 'loading', ...progress });
        }, reference.unitScaleToMeters, { signal });
        pending.cancelLoad = task.cancel;
        return task.promise;
      };
      if (useWorker) geometry = await parseInWorker();
      else {
        const response = await fetch(resolveRuntimeAssetUrl(reference.sourceUrl), { signal });
        if (!response.ok) throw new Error('读取 CAD 文件失败：HTTP ' + response.status);
        const headerSize = Number(response.headers.get('content-length') ?? 0);
        if (!Number.isFinite(headerSize) || headerSize <= 0 || headerSize >= CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES) {
          await response.body?.cancel();
          geometry = await parseInWorker();
        } else {
          const content = decodeCadDxfBytes(new Uint8Array(await response.arrayBuffer()));
          const { parseCadReferenceDxf } = await import('../../../editor/cad/cadReferenceParser');
          if (!this.isActiveCadReferenceLoad(entityId, pending) || signal.aborted) return;
          geometry = parseCadReferenceDxf(content, { unitScaleToMeters: reference.unitScaleToMeters });
        }
      }
    }
    if (!this.isActiveCadReferenceLoad(entityId, pending) || signal.aborted) return;
    pending.cancelLoad = null;
    await this.applyCadReferenceGeometry(entityId, pending, geometry);
  }

  /** 停止后台和构建任务，保留终止记录，避免其它实体编辑自动重试大图。 */
  public stopCadReferenceLoad(cadReference: CadReferenceRuntimeEntry): void {
    cadReference.unregisterCancellation();
    cadReference.abortController.abort();
    cadReference.cancelLoad?.();
    cadReference.cancelLoad = null;
    for (const lineMesh of cadReference.lineMeshes) lineMesh.dispose();
    cadReference.lineMeshes.length = 0;
    cadReference.geometryReady = false;
  }

  /** 释放 CAD 参考图的所有线稿 Mesh 与根节点。 */
  public disposeCadReference(entityId: string, cadReference: CadReferenceRuntimeEntry): void {
    this.dependencies.transforms.clearEntityArrayPreviewIfSource(entityId);
    this.stopCadReferenceLoad(cadReference);
    cadReference.root.dispose();
    this.cadReferences.delete(entityId);
    forgetCadReferenceLoadStatus(entityId);
  }

  /** 根据解析后的紧凑 CAD 几何分批创建 Babylon 线稿，避免大图纸制造海量 Vector3 临时对象。 */
  public async applyCadReferenceGeometry(
    entityId: string,
    cadReference: CadReferenceRuntimeEntry,
    geometry: CadReferenceParseResult,
  ): Promise<void> {
    const maxBatchPointCount = CAD_REFERENCE_MAX_BATCH_POINTS;
    const maxBatchPolylineCount = CAD_REFERENCE_MAX_BATCH_POLYLINES;
    const renderLayers = mergeCadReferenceRenderLayers(geometry.layers);
    let completedBatches = 0;

    for (const layer of renderLayers) {
      if (!this.isActiveCadReferenceLoad(entityId, cadReference)) return;
      if (layer.isChunk) {
        this.createCadReferenceLineBatch(entityId, cadReference, layer.name, completedBatches,
          layer.positions, layer.polylinePointCounts, layer.instanceMatrices);
        completedBatches += 1;
        publishCadReferenceLoadStatus({ entityId, sourceUrl: cadReference.sourceUrl, state: 'rendering',
          percent: 90 + completedBatches / renderLayers.length * 8,
          detail: '正在创建 CAD 线稿 ' + completedBatches + '/' + renderLayers.length + ' 批...' });
        await this.waitForCadReferenceRenderFrame(cadReference.abortController.signal);
        continue;
      }
      let polylineIndex = 0;
      let pointOffset = 0;
      let batchIndex = 0;

      while (polylineIndex < layer.polylinePointCounts.length) {
        const currentPointCount = layer.polylinePointCounts[polylineIndex];
        if (currentPointCount > maxBatchPointCount) {
          let remainingPointCount = currentPointCount;
          let chunkPointOffset = pointOffset;
          while (remainingPointCount > 1) {
            if (!this.isActiveCadReferenceLoad(entityId, cadReference)) return;
            const chunkPointCount = Math.min(maxBatchPointCount, remainingPointCount);
            this.createCadReferenceLineBatch(
              entityId,
              cadReference,
              layer.name,
              batchIndex,
              layer.positions.subarray(chunkPointOffset * 3, (chunkPointOffset + chunkPointCount) * 3),
              new Uint32Array([chunkPointCount]),
              layer.instanceMatrices,
            );
            batchIndex += 1;
            await this.waitForCadReferenceRenderFrame(cadReference.abortController.signal);

            if (chunkPointCount === remainingPointCount) break;
            chunkPointOffset += chunkPointCount - 1;
            remainingPointCount -= chunkPointCount - 1;
          }

          pointOffset += currentPointCount;
          polylineIndex += 1;
          continue;
        }

        const batchPointOffset = pointOffset;
        const batchPolylineIndex = polylineIndex;
        let batchPointCount = 0;
        let batchPolylineCount = 0;

        while (polylineIndex < layer.polylinePointCounts.length) {
          const polylinePointCount = layer.polylinePointCounts[polylineIndex];
          if (polylinePointCount > maxBatchPointCount) break;
          const exceedsBatchBudget = batchPolylineCount > 0 && (
            batchPolylineCount >= maxBatchPolylineCount
            || batchPointCount + polylinePointCount > maxBatchPointCount
          );
          if (exceedsBatchBudget) break;

          batchPointCount += polylinePointCount;
          batchPolylineCount += 1;
          pointOffset += polylinePointCount;
          polylineIndex += 1;
        }

        if (batchPolylineCount === 0) continue;
        if (!this.isActiveCadReferenceLoad(entityId, cadReference)) return;
        this.createCadReferenceLineBatch(
          entityId,
          cadReference,
          layer.name,
          batchIndex,
          layer.positions.subarray(batchPointOffset * 3, (batchPointOffset + batchPointCount) * 3),
          layer.polylinePointCounts.subarray(batchPolylineIndex, batchPolylineIndex + batchPolylineCount),
          layer.instanceMatrices,
        );
        batchIndex += 1;
        await this.waitForCadReferenceRenderFrame(cadReference.abortController.signal);
      }
    }

    if (!this.isActiveCadReferenceLoad(entityId, cadReference)) return;
    if (cadReference.lineMeshes.length === 0) throw new Error('DXF 中没有可显示的线稿图元。');
    this.applyCadReferenceLineMeshStyle(cadReference);
    this.applyCadReferenceInteractivity(cadReference, entityId);
    this.dependencies.transforms.refreshGroupTransformPreviewTargets();
    publishCadReferenceLoadStatus({ entityId, sourceUrl: cadReference.sourceUrl, state: 'rendering', percent: 99, detail: '正在等待 CAD 首帧显示...' });
    await waitForSceneRenderReady(this.context.scene, cadReference.abortController.signal);
    if (!this.isActiveCadReferenceLoad(entityId, cadReference)) return;
    cadReference.geometryReady = true;
    publishCadReferenceLoadStatus({ entityId, sourceUrl: cadReference.sourceUrl, state: 'ready', percent: 100, detail: 'CAD 参考图已显示。' });
  }

  /** 判断当前 CAD 分批任务是否仍属于场景中的有效加载记录。 */
  public isActiveCadReferenceLoad(entityId: string, cadReference: CadReferenceRuntimeEntry): boolean {
    const activeEntry = this.cadReferences.get(entityId);
    return activeEntry === cadReference && activeEntry.loadToken === cadReference.loadToken;
  }

  /** 从紧凑点数组直接创建单个受控大小的 CAD LinesMesh，避免二次对象化和通用 Builder 拷贝。 */
  public createCadReferenceLineBatch(
    entityId: string,
    cadReference: CadReferenceRuntimeEntry,
    layerName: string,
    batchIndex: number,
    positions: Float32Array,
    polylinePointCounts: Uint32Array,
    instanceMatrices?: Float32Array,
  ): LinesMesh {
    let segmentCount = 0;
    for (const pointCount of polylinePointCounts) {
      segmentCount += Math.max(0, pointCount - 1);
    }

    const indices = new Uint16Array(segmentCount * 2);
    let vertexOffset = 0;
    let indexOffset = 0;
    for (const pointCount of polylinePointCounts) {
      for (let pointIndex = 1; pointIndex < pointCount; pointIndex += 1) {
        indices[indexOffset] = vertexOffset + pointIndex - 1;
        indices[indexOffset + 1] = vertexOffset + pointIndex;
        indexOffset += 2;
      }
      vertexOffset += pointCount;
    }

    const lineMesh = new LinesMesh(
      `${entityId}_cadLayer_${sanitizeBabylonName(layerName)}_${batchIndex}`,
      this.context.scene,
      null,
      null,
      undefined,
      false,
      true,
    );
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.applyToMesh(lineMesh, false);
    if (instanceMatrices && instanceMatrices.length >= 16) {
      lineMesh.thinInstanceSetBuffer('matrix', instanceMatrices, 16, true);
      lineMesh.thinInstanceRefreshBoundingInfo(true);
    }
    lineMesh.parent = cadReference.root;
    lineMesh.isPickable = false;
    lineMesh.metadata = { ...(lineMesh.metadata ?? {}), cadReferenceLayer: layerName };
    cadReference.lineMeshes.push(lineMesh);
    return lineMesh;
  }

  /** 在 CAD 批次之间让出一帧，使编辑器输入、进度和重绘保持响应。 */
  public waitForCadReferenceRenderFrame(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let frame = 0;
      let timeout: ReturnType<typeof setTimeout>;
      let settled = false;
      const finish = (canceled = false): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        clearTimeout(timeout);
        if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
        if (canceled) { const error = new Error('CAD 构建已取消。'); error.name = 'AbortError'; reject(error); }
        else resolve();
      };
      const abort = (): void => finish(true);
      signal.addEventListener('abort', abort, { once: true });
      // 后台标签页可能暂停 RAF；取消及构建调度都不能无限等待。
      timeout = setTimeout(() => finish(), 100);
      if (signal.aborted) abort();
      else if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(() => finish());
      else { clearTimeout(timeout); timeout = setTimeout(() => finish(), 0); }
    });
  }

  /** CAD 参考图永远不参与鼠标拾取，只响应 Hierarchy 显隐。 */
  public applyCadReferenceInteractivity(cadReference: CadReferenceRuntimeEntry, entityId: string): void {
    const visible = this.dependencies.document.isEntityVisible(entityId);
    cadReference.root.setEnabled(visible);

    for (const lineMesh of cadReference.lineMeshes) {
      lineMesh.isPickable = false;
    }
  }

  /** 根据组件显示参数刷新 CAD 参考图线稿颜色和透明度。 */
  public applyCadReferenceStyle(
    cadReference: CadReferenceRuntimeEntry,
    cadReferenceComponent: CadReferenceComponent,
  ): void {
    cadReference.lineColor = cadReferenceComponent.lineColor;
    cadReference.opacity = cadReferenceComponent.opacity;
    this.applyCadReferenceLineMeshStyle(cadReference);
  }

  /** 把 CAD 参考图运行时记录里的最新样式应用到所有线稿 Mesh。 */
  public applyCadReferenceLineMeshStyle(cadReference: CadReferenceRuntimeEntry): void {
    const color = this.dependencies.presentation.readColor(cadReference.lineColor);
    const alpha = Math.min(1, Math.max(0, cadReference.opacity));

    for (const lineMesh of cadReference.lineMeshes) {
      lineMesh.color = color;
      lineMesh.alpha = alpha;
    }
  }
}
