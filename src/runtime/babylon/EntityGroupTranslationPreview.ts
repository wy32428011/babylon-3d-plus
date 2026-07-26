import type { Vector3Data } from '../../editor/model/math';

/** 普通运行时节点或灯光的稳定位置写入目标。 */
export type EntityGroupTranslationPositionTarget = {
  kind: 'position';
  identity: object;
  setPosition: (position: Vector3Data) => void;
};

/** thinInstance 批次只暴露逻辑实体平移预览所需的最小接口。 */
export type EntityGroupTranslationBatch = {
  beginEntityTranslationPreview: (entityIds: ReadonlySet<string>) => boolean;
  updateEntityTranslationPreview: (delta: Vector3Data) => boolean;
  endEntityTranslationPreview: (restore: boolean) => void;
};

export type EntityGroupTranslationBatchTarget = {
  kind: 'batch';
  batch: EntityGroupTranslationBatch;
};

export type EntityGroupTranslationTarget =
  | EntityGroupTranslationPositionTarget
  | EntityGroupTranslationBatchTarget;

export type EntityGroupTranslationTargetResolver = (
  entityId: string,
) => EntityGroupTranslationTarget | null;

type ActivePositionBinding = {
  identity: object;
  setPosition: (position: Vector3Data) => void;
};

type ActiveBatchBinding = {
  entityIds: Set<string>;
};

/**
 * 文件夹整组平移的轻量运行时会话。
 * 普通目标始终从文档位置基线重算，批次目标委托其可逆矩阵预览接口；不修改场景文档。
 */
export class EntityGroupTranslationPreview {
  private readonly entityIds: string[];
  private readonly activePositionBindings = new Map<string, ActivePositionBinding>();
  private readonly activeBatchBindings = new Map<EntityGroupTranslationBatch, ActiveBatchBinding>();
  private delta: Vector3Data = { x: 0, y: 0, z: 0 };
  private ended = false;

  constructor(
    entityIds: readonly string[],
    private readonly baselinePositions: Readonly<Record<string, Vector3Data>>,
    private readonly resolveTarget: EntityGroupTranslationTargetResolver,
  ) {
    this.entityIds = [...new Set(entityIds)].filter((entityId) => (
      isFiniteVector3Data(this.baselinePositions[entityId])
    ));
  }

  /** 应用相对会话起点的绝对世界位移；连续调用不会累计上一帧结果。 */
  update(delta: Vector3Data): boolean {
    if (this.ended || !isFiniteVector3Data(delta)) return false;
    this.delta = cloneVector3Data(delta);
    return this.reconcileTargets();
  }

  /** 重新解析目标，供异步模型加载完成或 thinInstance 批次重建后接回当前位移。 */
  refresh(): boolean {
    if (this.ended) return false;
    return this.reconcileTargets();
  }

  /** 取消预览并精确恢复所有已接入目标的运行时基线。 */
  cancel(): void {
    this.end(true);
  }

  /** 保留当前运行时画面，等待场景文档权威状态同步接管。 */
  finish(): void {
    this.end(false);
  }

  getDelta(): Vector3Data {
    return cloneVector3Data(this.delta);
  }

  private reconcileTargets(): boolean {
    const desiredPositionTargets = new Map<string, EntityGroupTranslationPositionTarget>();
    const desiredBatchEntityIds = new Map<EntityGroupTranslationBatch, Set<string>>();

    for (const entityId of this.entityIds) {
      const target = this.resolveTarget(entityId);
      if (!target) continue;
      if (target.kind === 'position') {
        desiredPositionTargets.set(entityId, target);
        continue;
      }

      const batchEntityIds = desiredBatchEntityIds.get(target.batch) ?? new Set<string>();
      batchEntityIds.add(entityId);
      desiredBatchEntityIds.set(target.batch, batchEntityIds);
    }

    this.reconcilePositionTargets(desiredPositionTargets);
    this.reconcileBatchTargets(desiredBatchEntityIds);
    return desiredPositionTargets.size > 0 || this.activeBatchBindings.size > 0;
  }

  private reconcilePositionTargets(
    desiredTargets: ReadonlyMap<string, EntityGroupTranslationPositionTarget>,
  ): void {
    for (const [entityId, active] of this.activePositionBindings) {
      const desired = desiredTargets.get(entityId);
      if (desired?.identity === active.identity) continue;
      active.setPosition(cloneVector3Data(this.baselinePositions[entityId]));
      this.activePositionBindings.delete(entityId);
    }

    for (const [entityId, target] of desiredTargets) {
      const active = this.activePositionBindings.get(entityId);
      if (!active) {
        this.activePositionBindings.set(entityId, {
          identity: target.identity,
          setPosition: target.setPosition,
        });
      } else {
        active.setPosition = target.setPosition;
      }
      target.setPosition(addVector3Data(this.baselinePositions[entityId], this.delta));
    }
  }

  private reconcileBatchTargets(
    desiredTargets: ReadonlyMap<EntityGroupTranslationBatch, ReadonlySet<string>>,
  ): void {
    for (const [batch, active] of this.activeBatchBindings) {
      const desiredEntityIds = desiredTargets.get(batch);
      if (desiredEntityIds && areSetsEqual(active.entityIds, desiredEntityIds)) continue;
      batch.endEntityTranslationPreview(true);
      this.activeBatchBindings.delete(batch);
    }

    for (const [batch, entityIds] of desiredTargets) {
      let active = this.activeBatchBindings.get(batch);
      if (!active) {
        const resolvedEntityIds = new Set(entityIds);
        if (!batch.beginEntityTranslationPreview(resolvedEntityIds)) continue;
        active = { entityIds: resolvedEntityIds };
        this.activeBatchBindings.set(batch, active);
      }
      if (batch.updateEntityTranslationPreview(this.delta)) continue;

      // 批次可能因异步模型就绪或内部重建而主动结束旧预览；重新捕获新矩阵基线。
      batch.endEntityTranslationPreview(true);
      this.activeBatchBindings.delete(batch);
      const refreshedEntityIds = new Set(entityIds);
      if (!batch.beginEntityTranslationPreview(refreshedEntityIds)) continue;
      this.activeBatchBindings.set(batch, { entityIds: refreshedEntityIds });
      batch.updateEntityTranslationPreview(this.delta);
    }
  }

  private end(restore: boolean): void {
    if (this.ended) return;
    this.ended = true;

    if (restore) {
      for (const [entityId, active] of this.activePositionBindings) {
        active.setPosition(cloneVector3Data(this.baselinePositions[entityId]));
      }
    }
    this.activePositionBindings.clear();

    for (const batch of this.activeBatchBindings.keys()) {
      batch.endEntityTranslationPreview(restore);
    }
    this.activeBatchBindings.clear();
  }
}

function isFiniteVector3Data(value: Vector3Data | undefined): value is Vector3Data {
  return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z));
}

function cloneVector3Data(value: Vector3Data): Vector3Data {
  return { x: value.x, y: value.y, z: value.z };
}

function addVector3Data(left: Vector3Data, right: Vector3Data): Vector3Data {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  };
}

function areSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}
