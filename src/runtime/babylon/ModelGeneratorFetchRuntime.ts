import {
  CreateBox,
  CreatePlane,
  CreateSphere,
  Matrix,
  Mesh,
  Scene,
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
  target: ModelGeneratorTarget;
  locatorAssetId: string;
  column: number;
  layer: number;
};

type GetLocatorByAssetId = (assetId: string) => LocatorRuntimeEntry | null;
type GetLocatorBoxWorldMatrix = (locator: LocatorRuntimeEntry, column: number, layer: number) => Matrix | null;
type LoadModelTemplate = (target: ModelGeneratorTarget) => Promise<{ meshes: Mesh[]; dispose: () => void } | null>;

type ThinInstanceBatch = {
  mesh: Mesh;
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
    getLocatorByAssetId: GetLocatorByAssetId,
    getLocatorBoxWorldMatrix: GetLocatorBoxWorldMatrix,
    loadModelTemplate: LoadModelTemplate,
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

      const data: { records: ContainerInfo[] } = (await response.json())?.data;
      if (!data?.records?.length) {
        this.clearAllBatches();
        return;
      }

      const nextInstances: CargoInstance[] = [];

      for (const record of data.records) {
        // if (record.isEmpty) continue; // TODO: 测试原因 暂时忽略

        const target = this.matchRule(component.rules, record.containerType) ?? component.defaultTarget;
        if (!target) continue;

        const targetSignature = createModelGeneratorTargetSignature(target);

        for (const binding of component.bindings) {
          const cargoCode = record.containerCode[0] ?? `${record.containerType}_${record.column}_${record.layer}`;
          nextInstances.push({
            cargoCode,
            targetSignature,
            target,
            locatorAssetId: binding.assetCode,
            column: record.column,
            layer: record.layer,
          });
        }
      }

      await this.syncBatches(nextInstances, getLocatorByAssetId, getLocatorBoxWorldMatrix, loadModelTemplate);
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
    getLocatorByAssetId: GetLocatorByAssetId,
    getLocatorBoxWorldMatrix: GetLocatorBoxWorldMatrix,
    loadModelTemplate: LoadModelTemplate,
  ): Promise<void> {
    const groups = new Map<string, CargoInstance[]>();
    for (const instance of instances) {
      const list = groups.get(instance.targetSignature);
      if (list) list.push(instance);
      else groups.set(instance.targetSignature, [instance]);
    }

    // TODO: 应该根据入参的排号进行 有目标的清理，每次的请求并不是全量的更新
    for (const signature of [...this.batches.keys()]) {
      if (!groups.has(signature)) {
        this.disposeBatch(signature);
      }
    }

    for (const [signature, group] of groups) {
      const existing = this.batches.get(signature);
      if (existing) {
        this.updateBatchMatrices(existing, group, getLocatorByAssetId, getLocatorBoxWorldMatrix);
      } else {
        await this.createBatch(signature, group, getLocatorByAssetId, getLocatorBoxWorldMatrix, loadModelTemplate);
      }
    }
  }

  /** 创建新的 thinInstance batch：通过 loadModelTemplate 走完整资产加载管线获取模板几何。 */
  private async createBatch(
    signature: string,
    instances: CargoInstance[],
    getLocatorByAssetId: GetLocatorByAssetId,
    getLocatorBoxWorldMatrix: GetLocatorBoxWorldMatrix,
    loadModelTemplate: LoadModelTemplate,
  ): Promise<void> {
    const target = instances[0].target;

    const template = await this.loadTemplateMesh(target, loadModelTemplate);
    if (!template) {
      this.onPushLog(`创建 thinInstance batch 失败：无法获取目标模型几何 (${target.kind})`);
      return;
    }

    try {
      // 顶点抽取时烘焙各 mesh 的世界矩阵（含单位换算 scaleNode 与 GLB 节点 TRS），
      // thinInstance 矩阵只负责把模型放到库位上
      const vertexData = this.extractMergedVertexData(template.meshes);
      if (!vertexData) {
        template.dispose();
        this.onPushLog(`创建 thinInstance batch 失败：目标模型无顶点数据 (${target.kind})`);
        return;
      }

      const material = template.meshes.find((mesh) => mesh.getTotalVertices() > 0 && mesh.material)?.material ?? null;
      const clonedMaterial = material ? material.clone(`${material.name}_fetch_batch`) : null;

      template.dispose();

      const batchMesh = new Mesh(`fetch_batch_${this.generatorEntityId}_${signature.slice(0, 8)}`, this.scene);
      vertexData.applyToMesh(batchMesh);
      batchMesh.material = clonedMaterial;
      batchMesh.doNotSerialize = true;
      // thinInstance 矩阵是世界矩阵，Babylon 渲染时会再乘 mesh 自身世界矩阵，
      // 因此 batchMesh 必须保持单位变换，不能挂到 locator.root 下（否则双重变换）

      const batch: ThinInstanceBatch = {
        mesh: batchMesh,
        instances: [...instances],
      };
      this.batches.set(signature, batch);
      this.updateBatchMatrices(batch, instances, getLocatorByAssetId, getLocatorBoxWorldMatrix);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onPushLog(`创建 thinInstance batch 失败：${message}`);
    }
  }

  /** 根据 target 类型加载模板 mesh：model target 走资产加载管线，mesh target 创建内置几何体。 */
  private async loadTemplateMesh(
    target: ModelGeneratorTarget,
    loadModelTemplate: LoadModelTemplate,
  ): Promise<{ meshes: Mesh[]; dispose: () => void } | null> {
    if (target.kind === 'model') {
      return loadModelTemplate(target);
    }

    const meshOpts = { updatable: false };
    let mesh: Mesh;
    switch (target.meshKind) {
      case 'cube':
        mesh = CreateBox('fetch_batch_source', { size: 1, ...meshOpts }, this.scene);
        break;
      case 'sphere':
        mesh = CreateSphere('fetch_batch_source', { diameter: 1, ...meshOpts }, this.scene);
        break;
      case 'plane':
        mesh = CreatePlane('fetch_batch_source', { size: 1, ...meshOpts }, this.scene);
        break;
      default:
        return null;
    }
    mesh.doNotSerialize = true;
    return { meshes: [mesh], dispose: () => mesh.dispose() };
  }

  /** 抽取所有有几何的 mesh 的顶点数据，烘焙各自世界矩阵后合并；无几何返回 null */
  private extractMergedVertexData(meshes: Mesh[]): VertexData | null {
    const vertexDatas: VertexData[] = [];
    for (const mesh of meshes) {
      if (mesh.getTotalVertices() === 0) continue;
      mesh.computeWorldMatrix(true);
      const vertexData = VertexData.ExtractFromMesh(mesh, true, true);
      vertexData.transform(mesh.getWorldMatrix());
      vertexDatas.push(vertexData);
    }
    if (vertexDatas.length === 0) return null;
    if (vertexDatas.length === 1) return vertexDatas[0];
    return vertexDatas[0].merge(vertexDatas.slice(1), true);
  }

  /** 更新 thinInstance 矩阵 buffer */
  private updateBatchMatrices(
    batch: ThinInstanceBatch,
    instances: CargoInstance[],
    getLocatorByAssetId: GetLocatorByAssetId,
    getLocatorBoxWorldMatrix: GetLocatorBoxWorldMatrix,
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

      const worldMatrix = getLocatorBoxWorldMatrix(locator, instance.column, instance.layer);
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
    this.batches.delete(signature);
  }

  dispose(): void {
    this.disposed = true;
    this.clearAllBatches();
  }
}
