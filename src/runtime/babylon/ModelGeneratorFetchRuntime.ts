import {
  Matrix,
  Mesh,
  Scene,
  type AssetContainer,
  VertexData,
} from '@babylonjs/core';
import type { ModelGeneratorComponent, ModelGeneratorRule, ModelGeneratorTarget } from '../../editor/model/components';
import type { LocatorRuntimeEntry } from './SceneRuntime';
import { createModelGeneratorTargetSignature } from '../../editor/model/modelGenerator';
import type { FetchConfig } from '../../editor/model/SceneDocument';

/** fetch 响应中的单条货物记录 */
type ContainerInfo = {
  containerCode: string[];
  containerType: string;
  isEmpty: boolean;
  locType: string;
  row: string;
  column: number;
  layer: number;
  tier: number;
  stackingRow: number;
  stackingColumn: number;
  stackingLayer: number;
};

type CargoInstance = {
  cargoCode: string;
  targetSignature: string;
  locatorAssetId: string;
  column: number;
  layer: number;
};

type ThinInstanceBatch = {
  mesh: Mesh;
  sourceContainer: AssetContainer;
  instances: CargoInstance[];
};

/**
 * Fetch 模式模型生成器的 thinInstance 渲染运行时。
 * 负责 fetch 请求 → 规则匹配 → thinInstance 合批渲染。
 */
export class ModelGeneratorFetchRuntime {
  private batches = new Map<string, ThinInstanceBatch>();
  private disposed = false;

  private readonly scene: Scene;
  private readonly generatorEntityId: string;
  private readonly onPushLog: (message: string) => void;

  constructor(
    scene: Scene,
    generatorEntityId: string,
    onPushLog: (message: string) => void = () => undefined,
  ) {
    this.scene = scene;
    this.generatorEntityId = generatorEntityId;
    this.onPushLog = onPushLog;
  }

  /** 响应外部事件：fetch → 规则匹配 → 更新 thinInstance 批次 */
  async handleEvent(
    fetchConfig: FetchConfig,
    component: ModelGeneratorComponent,
    getLocatorByAssetId: (assetId: string) => LocatorRuntimeEntry | null,
  ): Promise<void> {
    if (this.disposed || !fetchConfig.url) return;

    try {
      const response = await fetch(fetchConfig.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': fetchConfig.apiKey,
        },
        body: JSON.stringify({ rows: [] }),
      });

      if (!response.ok) {
        this.onPushLog(`Fetch 请求失败：HTTP ${response.status}`);
        return;
      }

      const data: { records: ContainerInfo[] } = await response.json();
      if (!data?.records?.length) {
        this.clearAllBatches();
        return;
      }

      const nextInstances: CargoInstance[] = [];

      for (const record of data.records) {
        if (record.isEmpty) continue;

        const target = this.matchRule(component.rules, record.containerType) ?? component.defaultTarget;
        if (!target) continue;

        const targetSignature = createModelGeneratorTargetSignature(target);

        for (const binding of component.bindings) {
          const cargoCode = record.containerCode[0] ?? `${record.containerType}_${record.column}_${record.layer}`;
          nextInstances.push({
            cargoCode,
            targetSignature,
            locatorAssetId: binding.assetCode,
            column: record.column,
            layer: record.layer,
          });
        }
      }

      await this.syncBatches(nextInstances, getLocatorByAssetId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onPushLog(`Fetch 处理异常：${message}`);
    }
  }

  /** 按规则顺序匹配 containerType */
  private matchRule(rules: ModelGeneratorRule[], containerType: string): ModelGeneratorTarget | null {
    for (const rule of rules) {
      if (!rule.attributeName.trim()) continue;
      if (rule.attributeValue.trim() !== containerType.trim()) continue;
      const target = rule.target;
      if (target) return target;
    }
    return null;
  }

  /** 同步 thinInstance 批次：按 targetSignature 分组，增删改矩阵 */
  private async syncBatches(
    instances: CargoInstance[],
    getLocatorByAssetId: (assetId: string) => LocatorRuntimeEntry | null,
  ): Promise<void> {
    const groups = new Map<string, CargoInstance[]>();
    for (const instance of instances) {
      const list = groups.get(instance.targetSignature);
      if (list) list.push(instance);
      else groups.set(instance.targetSignature, [instance]);
    }

    for (const signature of [...this.batches.keys()]) {
      if (!groups.has(signature)) {
        this.disposeBatch(signature);
      }
    }

    for (const [signature, group] of groups) {
      const existing = this.batches.get(signature);
      if (existing) {
        this.updateBatchMatrices(existing, group, getLocatorByAssetId);
      } else {
        await this.createBatch(signature, group, getLocatorByAssetId);
      }
    }
  }

  /** 创建新的 thinInstance batch */
  private async createBatch(
    signature: string,
    instances: CargoInstance[],
    getLocatorByAssetId: (assetId: string) => LocatorRuntimeEntry | null,
  ): Promise<void> {
    // 使用第一个 locator box 作为临时模板（后续从 target model 加载真实几何）
    const firstLocator = getLocatorByAssetId(instances[0].locatorAssetId);
    if (!firstLocator || firstLocator.boxes.length === 0) return;

    try {
      const sourceMesh = firstLocator.boxes[0];
      const vertexData = VertexData.ExtractFromMesh(sourceMesh, true, true);
      if (!vertexData) return;

      const batchMesh = new Mesh(`fetch_batch_${this.generatorEntityId}_${signature.slice(0, 8)}`, this.scene);
      vertexData.applyToMesh(batchMesh);
      batchMesh.material = sourceMesh.material;
      batchMesh.doNotSerialize = true;
      batchMesh.parent = firstLocator.root;

      const batch: ThinInstanceBatch = {
        mesh: batchMesh,
        sourceContainer: null as unknown as AssetContainer,
        instances: [...instances],
      };
      this.batches.set(signature, batch);
      this.updateBatchMatrices(batch, instances, getLocatorByAssetId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onPushLog(`创建 thinInstance batch 失败：${message}`);
    }
  }

  /** 获取 locator box 的世界矩阵，根据 column/layer 索引 */
  private getLocatorBoxWorldMatrix(
    locator: LocatorRuntimeEntry,
    column: number,
    layer: number,
    columns: number,
  ): Matrix | null {
    const boxIndex = layer * columns + column;
    const box = locator.boxes[boxIndex];
    if (!box) return null;
    box.computeWorldMatrix(true);
    return box.getWorldMatrix();
  }

  /** 更新 thinInstance 矩阵 buffer */
  private updateBatchMatrices(
    batch: ThinInstanceBatch,
    instances: CargoInstance[],
    getLocatorByAssetId: (assetId: string) => LocatorRuntimeEntry | null,
  ): void {
    batch.instances = instances;

    if (instances.length === 0) {
      batch.mesh.setEnabled(false);
      return;
    }

    batch.mesh.setEnabled(true);
    const matrices = new Float32Array(instances.length * 16);

    for (let index = 0; index < instances.length; index += 1) {
      const instance = instances[index];
      const locator = getLocatorByAssetId(instance.locatorAssetId);
      if (!locator) {
        Matrix.Identity().copyToArray(matrices, index * 16);
        continue;
      }

      const columns = locator.boxes.length > 0
        ? Math.max(1, locator.boxes.length / Math.max(1, Math.ceil(locator.boxes.length / locator.boxes.length)))
        : 1;

      // 尝试从 locator 的 component 获取实际 columns
      const worldMatrix = this.getLocatorBoxWorldMatrix(locator, instance.column, instance.layer, Math.max(1, columns));
      if (worldMatrix) {
        worldMatrix.copyToArray(matrices, index * 16);
      } else {
        // 回退：使用 locator root + 简单偏移
        locator.root.computeWorldMatrix(true);
        const rootWorld = locator.root.getWorldMatrix();
        const offset = Matrix.Translation(instance.column * 1.0, instance.layer * 1.0, 0);
        rootWorld.multiply(offset).copyToArray(matrices, index * 16);
      }
    }

    batch.mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
    batch.mesh.thinInstanceEnablePicking = true;
    batch.mesh.thinInstanceRefreshBoundingInfo?.(true);
  }

  private clearAllBatches(): void {
    for (const signature of [...this.batches.keys()]) {
      this.disposeBatch(signature);
    }
  }

  private disposeBatch(signature: string): void {
    const batch = this.batches.get(signature);
    if (!batch) return;
    batch.mesh.dispose();
    try { batch.sourceContainer?.dispose?.(); } catch { /* empty */ }
    this.batches.delete(signature);
  }

  dispose(): void {
    this.disposed = true;
    this.clearAllBatches();
  }
}
