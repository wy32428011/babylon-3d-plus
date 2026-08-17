import {
  CreateBox,
  CreatePlane,
  CreateSphere,
  Material,
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
  meshes: Mesh[];
  materials: Material[];
  instances: CargoInstance[];
};

type ApplyRecordsContext = {
  records: FetchContainerRecord[];
  locatorEntry: LocatorRuntimeEntry;
  locatorComponent: LocatorComponent;
  generatorComponent: ModelGeneratorComponent | null;
  getLocatorBoxWorldMatrix: GetLocatorBoxWorldMatrix;
  loadModelTemplate: LoadModelTemplate;
};

/** fetch 渲染格口键，用于设备接管渲染期间的格口抑制。 */
export function createFetchCellKey(column: number, layer: number): string {
  return `${column}-${layer}`;
}

/**
 * 定位线框 fetch 数据驱动的 thinInstance 渲染运行时。
 * 每个实例只服务一条定位线框：HTTP 请求编排由 SceneRuntime 负责，本类只接收本排 records
 * 并完成规则匹配与 thinInstance 合批渲染。
 */
export class LocatorFetchRuntime {
  private batches = new Map<string, ThinInstanceBatch>();
  /** 设备取货/放货期间接管渲染的格口；对应 thinInstance 暂时跳过。 */
  private suppressedCellKeys = new Set<string>();
  private lastApplyContext: ApplyRecordsContext | null = null;
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

    this.lastApplyContext = {
      records,
      locatorEntry,
      locatorComponent,
      generatorComponent,
      getLocatorBoxWorldMatrix,
      loadModelTemplate,
    };

    const rowKey = String(locatorComponent.rowNumber).trim();
    const ownRecords = records.filter(
      (record) => String(record.row ?? '').trim() === rowKey
        && !this.suppressedCellKeys.has(createFetchCellKey(record.column, record.layer)),
    );

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
      // 逐 mesh 抽取顶点并烘焙各自世界矩阵（含单位换算、锚定偏移与 GLB 节点 TRS），
      // 不跨 mesh 合并：属性集不一致会错位顶点，多材质模型必须保留各自材质。
      const parts = this.extractTemplateParts(template.meshes);
      if (parts.length === 0) {
        template.dispose();
        this.onPushLog(`创建 thinInstance batch 失败：目标模型无顶点数据 (${target.kind})`);
        return;
      }

      const meshes: Mesh[] = [];
      const materials: Material[] = [];
      for (const [index, part] of parts.entries()) {
        const batchMesh = new Mesh(`fetch_batch_${this.locatorEntityId}_${signature.slice(0, 8)}_${index}`, this.scene);
        part.vertexData.applyToMesh(batchMesh);
        // GLB 模板带 z=-1 镜像（sideOrientation=CW）：烘焙时 VertexData.transform 已翻转索引绕向，
        // 复制源 sideOrientation 正好与烘焙翻转抵消；缺了这步批次渲染内外面颠倒
        batchMesh.sideOrientation = part.sideOrientation;
        if (part.material) {
          const clonedMaterial = part.material.clone(`${part.material.name}_fetch_batch_${index}`);
          if (clonedMaterial) {
            batchMesh.material = clonedMaterial;
            materials.push(clonedMaterial);
          }
        }
        batchMesh.doNotSerialize = true;
        // thinInstance 矩阵是世界矩阵，Babylon 渲染时会再乘 mesh 自身世界矩阵，
        // 因此 batchMesh 必须保持单位变换，不能挂到 locator.root 下（否则双重变换）
        meshes.push(batchMesh);
      }
      template.dispose();

      const batch: ThinInstanceBatch = {
        meshes,
        materials,
        instances: [...instances],
      };
      this.batches.set(signature, batch);
      this.updateBatchMatrices(batch, instances, locatorEntry, getLocatorBoxWorldMatrix);
    } catch (error) {
      template.dispose();
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
        mesh.position.y = 0.5;
        break;
      case 'sphere':
        mesh = CreateSphere('fetch_batch_source', { diameter: 1, ...meshOpts }, this.scene);
        mesh.position.y = 0.5;
        break;
      case 'plane':
        mesh = CreatePlane('fetch_batch_source', { size: 1, ...meshOpts }, this.scene);
        break;
      default:
        return null;
    }
    mesh.doNotSerialize = true;
    // 内置几何体中心在原点：position 抬半高后由抽取步骤烘焙，底部中心同样锚定到原点
    return { meshes: [mesh], dispose: () => mesh.dispose() };
  }

  /** 逐 mesh 抽取顶点数据（烘焙各自世界矩阵）、材质与 sideOrientation；无几何的 mesh 跳过。 */
  private extractTemplateParts(
    meshes: Mesh[],
  ): Array<{ vertexData: VertexData; material: Material | null; sideOrientation: number }> {
    const parts: Array<{ vertexData: VertexData; material: Material | null; sideOrientation: number }> = [];
    for (const mesh of meshes) {
      if (mesh.getTotalVertices() === 0) continue;
      mesh.computeWorldMatrix(true);
      const vertexData = VertexData.ExtractFromMesh(mesh, true, true);
      vertexData.transform(mesh.getWorldMatrix());
      parts.push({ vertexData, material: mesh.material ?? null, sideOrientation: mesh.sideOrientation });
    }
    return parts;
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

    const enabled = matrices.length > 0;
    const buffer = new Float32Array(matrices.length * 16);
    for (let index = 0; index < matrices.length; index += 1) {
      matrices[index].copyToArray(buffer, index * 16);
    }
    for (const mesh of batch.meshes) {
      mesh.setEnabled(enabled);
      if (!enabled) continue;
      mesh.thinInstanceSetBuffer('matrix', buffer, 16, true);
      mesh.thinInstanceEnablePicking = true;
      mesh.thinInstanceRefreshBoundingInfo?.(true);
    }
  }

  /** 清空全部 thinInstance batch；退出运行预览回编辑态时调用，runtime 本身保留复用 */
  clearAllBatches(): void {
    this.suppressedCellKeys.clear();
    this.lastApplyContext = null;
    for (const signature of [...this.batches.keys()]) {
      this.disposeBatch(signature);
    }
  }

  /** 抑制某格口的 fetch 渲染：设备（如 stacker）接管该格口货物期间调用，幂等。 */
  suppressCell(column: number, layer: number): void {
    const key = createFetchCellKey(column, layer);
    if (this.suppressedCellKeys.has(key)) return;
    this.suppressedCellKeys.add(key);
    this.replayLastRecords();
  }

  /** 解除全部格口抑制：fetch 单排同步响应应用后调用，渲染权重回 fetch 数据。 */
  clearSuppressedCells(): void {
    if (this.suppressedCellKeys.size === 0) return;
    this.suppressedCellKeys.clear();
    this.replayLastRecords();
  }

  /** 抑制集合变化后按上次 records 重建批次，避免等待下一次数据到达。 */
  private replayLastRecords(): void {
    const context = this.lastApplyContext;
    if (!context || this.disposed) return;
    void this.applyRecords(
      context.records,
      context.locatorEntry,
      context.locatorComponent,
      context.generatorComponent,
      context.getLocatorBoxWorldMatrix,
      context.loadModelTemplate,
    );
  }

  private disposeBatch(signature: string): void {
    const batch = this.batches.get(signature);
    if (!batch) return;
    for (const mesh of batch.meshes) mesh.dispose();
    for (const material of batch.materials) material.dispose();
    this.batches.delete(signature);
  }

  dispose(): void {
    this.disposed = true;
    this.clearAllBatches();
  }
}
