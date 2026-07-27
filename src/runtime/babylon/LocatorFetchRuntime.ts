import {
  CreateBox,
  CreatePlane,
  CreateSphere,
  Matrix,
  Mesh,
  Scene,
  VertexData,
} from '@babylonjs/core';
import type { LocatorComponent, ModelGeneratorComponent, ModelGeneratorRule, ModelGeneratorTarget } from '../../editor/model/components';
import type { LocatorRuntimeEntry } from './SceneRuntime';
import { createMeshModelGeneratorTarget, createModelGeneratorTargetSignature } from '../../editor/model/modelGenerator';

/** fetch 响应中的单条货物记录 */
export type FetchContainerRecord = {
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
  column: number;
  layer: number;
};

type GetLocatorBoxWorldMatrix = (locator: LocatorRuntimeEntry, column: number, layer: number) => Matrix | null;
type LoadModelTemplate = (target: ModelGeneratorTarget) => Promise<{ meshes: Mesh[]; dispose: () => void } | null>;

type ThinInstanceBatch = {
  mesh: Mesh;
  instances: CargoInstance[];
};

/**
 * 定位线框 fetch 数据驱动的 thinInstance 渲染运行时。
 * 每个实例只服务一条定位线框：HTTP 请求编排由 SceneRuntime 负责，本类只接收本排 records
 * 并完成规则匹配与 thinInstance 合批渲染。
 */
export class LocatorFetchRuntime {
  private batches = new Map<string, ThinInstanceBatch>();
  private disposed = false;
  private missingGeneratorReported = false;

  private readonly scene: Scene;
  private readonly locatorEntityId: string;
  private readonly onPushLog: (message: string) => void;

  constructor(
    scene: Scene,
    locatorEntityId: string,
    onPushLog: (message: string) => void = () => undefined,
  ) {
    this.scene = scene;
    this.locatorEntityId = locatorEntityId;
    this.onPushLog = onPushLog;
  }

  /** 应用本排库存记录：防御性按排号过滤 → 规则匹配 → 全量重建 thinInstance 批次。 */
  async applyRecords(
    records: FetchContainerRecord[],
    locatorEntry: LocatorRuntimeEntry,
    locatorComponent: LocatorComponent,
    generatorComponent: ModelGeneratorComponent | null,
    getLocatorBoxWorldMatrix: GetLocatorBoxWorldMatrix,
    loadModelTemplate: LoadModelTemplate,
  ): Promise<void> {
    if (this.disposed) return;

    const rowKey = String(locatorComponent.rowNumber).trim();
    const ownRecords = records.filter((record) => String(record.row ?? '').trim() === rowKey);

    if (!generatorComponent) this.reportMissingGeneratorOnce(locatorComponent);
    const fallbackTarget = generatorComponent ? null : createMeshModelGeneratorTarget('cube', '内置立方体');

    const nextInstances: CargoInstance[] = [];
    for (const record of ownRecords) {
      const target = generatorComponent
        ? this.matchRule(generatorComponent.rules, record) ?? generatorComponent.defaultTarget
        : fallbackTarget;
      if (!target) continue;

      nextInstances.push({
        cargoCode: record.containerCode?.[0] ?? `${record.containerType}_${record.column}_${record.layer}`,
        targetSignature: createModelGeneratorTargetSignature(target),
        target,
        column: record.column,
        layer: record.layer,
      });
    }

    await this.syncBatches(nextInstances, locatorEntry, getLocatorBoxWorldMatrix, loadModelTemplate);
  }

  /** 按规则顺序匹配记录字段；属性名留空默认比较 containerType。 */
  private matchRule(rules: ModelGeneratorRule[], record: FetchContainerRecord): ModelGeneratorTarget | null {
    for (const rule of rules) {
      const attributeName = rule.attributeName.trim();
      const rawValue = attributeName
        ? (record as unknown as Record<string, unknown>)[attributeName]
        : record.containerType;
      const recordValue = String(rawValue ?? record.containerType ?? '').trim();
      if (!recordValue) continue;
      if (rule.attributeValue.trim() !== recordValue) continue;
      const target = rule.target;
      if (target) return target;
    }
    return null;
  }

  /** 未绑定货箱生成器时一次性提示，库存货物回退内置立方体。 */
  private reportMissingGeneratorOnce(locatorComponent: LocatorComponent): void {
    if (this.missingGeneratorReported) return;
    this.missingGeneratorReported = true;
    this.onPushLog(`定位线框 ${locatorComponent.assetId} 未绑定货箱生成器，库存货物回退内置立方体。`);
  }

  /** 同步 thinInstance 批次：按 targetSignature 分组，本批 records 即本排全量，缺失分组整体销毁。 */
  private async syncBatches(
    instances: CargoInstance[],
    locatorEntry: LocatorRuntimeEntry,
    getLocatorBoxWorldMatrix: GetLocatorBoxWorldMatrix,
    loadModelTemplate: LoadModelTemplate,
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
        this.updateBatchMatrices(existing, group, locatorEntry, getLocatorBoxWorldMatrix);
      } else {
        await this.createBatch(signature, group, locatorEntry, getLocatorBoxWorldMatrix, loadModelTemplate);
      }
    }
  }

  /** 创建新的 thinInstance batch：通过 loadModelTemplate 走完整资产加载管线获取模板几何。 */
  private async createBatch(
    signature: string,
    instances: CargoInstance[],
    locatorEntry: LocatorRuntimeEntry,
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

      const batchMesh = new Mesh(`fetch_batch_${this.locatorEntityId}_${signature.slice(0, 8)}`, this.scene);
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
      this.updateBatchMatrices(batch, instances, locatorEntry, getLocatorBoxWorldMatrix);
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

  /** 更新 thinInstance 矩阵 buffer；格口越界的记录直接跳过，不做位置兜底。 */
  private updateBatchMatrices(
    batch: ThinInstanceBatch,
    instances: CargoInstance[],
    locatorEntry: LocatorRuntimeEntry,
    getLocatorBoxWorldMatrix: GetLocatorBoxWorldMatrix,
  ): void {
    batch.instances = instances;

    const matrices: Matrix[] = [];
    for (const instance of instances) {
      const worldMatrix = getLocatorBoxWorldMatrix(locatorEntry, instance.column, instance.layer);
      if (worldMatrix) matrices.push(worldMatrix);
    }

    if (matrices.length === 0) {
      batch.mesh.setEnabled(false);
      return;
    }

    batch.mesh.setEnabled(true);
    const buffer = new Float32Array(matrices.length * 16);
    for (let index = 0; index < matrices.length; index += 1) {
      matrices[index].copyToArray(buffer, index * 16);
    }

    batch.mesh.thinInstanceSetBuffer('matrix', buffer, 16, true);
    batch.mesh.thinInstanceEnablePicking = true;
    batch.mesh.thinInstanceRefreshBoundingInfo?.(true);
  }

  /** 清空全部 thinInstance batch；退出运行预览回编辑态时调用，runtime 本身保留复用 */
  clearAllBatches(): void {
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
