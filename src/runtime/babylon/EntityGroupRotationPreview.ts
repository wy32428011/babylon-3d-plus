import { Matrix, Quaternion, Vector3 } from '@babylonjs/core';
import type { TransformComponent } from '../../editor/model/components';

/** 普通运行时节点或灯光的稳定 Transform 写入目标。 */
export type EntityGroupRotationTransformTarget = {
  kind: 'transform';
  identity: object;
  setTransform: (transform: TransformComponent) => void;
};

/** thinInstance 批次只暴露逻辑实体旋转预览所需的最小接口。 */
export type EntityGroupRotationBatch = {
  beginEntityRotationPreview: (entityIds: ReadonlySet<string>) => boolean;
  updateEntityRotationPreview: (deltaMatrix: readonly number[]) => boolean;
  endEntityRotationPreview: (restore: boolean) => void;
};

export type EntityGroupRotationBatchTarget = {
  kind: 'batch';
  batch: EntityGroupRotationBatch;
};

export type EntityGroupRotationTarget =
  | EntityGroupRotationTransformTarget
  | EntityGroupRotationBatchTarget;

export type EntityGroupRotationTargetResolver = (
  entityId: string,
) => EntityGroupRotationTarget | null;

type ActiveTransformBinding = {
  identity: object;
  setTransform: (transform: TransformComponent) => void;
};

type ActiveBatchBinding = {
  entityIds: Set<string>;
};

const MATRIX_ELEMENT_COUNT = 16;
const UNIT_SCALE_EPSILON = 1e-6;

/**
 * 文件夹整组旋转的轻量运行时会话。
 * 所有成员始终从文档 Transform 基线乘同一世界增量矩阵，不累计上一帧结果，也不修改场景文档。
 */
export class EntityGroupRotationPreview {
  private readonly entityIds: string[];
  private readonly activeTransformBindings = new Map<string, ActiveTransformBinding>();
  private readonly activeBatchBindings = new Map<EntityGroupRotationBatch, ActiveBatchBinding>();
  private deltaMatrixData = Array.from(Matrix.Identity().m);
  private afterTransforms: Record<string, TransformComponent>;
  private ended = false;

  constructor(
    entityIds: readonly string[],
    private readonly baselineTransforms: Readonly<Record<string, TransformComponent>>,
    private readonly resolveTarget: EntityGroupRotationTargetResolver,
  ) {
    this.entityIds = [...new Set(entityIds)].filter((entityId) => (
      isFiniteTransform(this.baselineTransforms[entityId])
    ));
    this.afterTransforms = cloneTransformRecord(this.entityIds, this.baselineTransforms);
  }

  /** 应用相对拖拽起点的绝对世界增量矩阵；连续调用不会累计上一帧结果。 */
  update(deltaMatrixData: readonly number[]): boolean {
    if (this.ended || !isFiniteMatrixData(deltaMatrixData)) return false;
    const deltaMatrix = Matrix.FromArray(Array.from(deltaMatrixData));
    const afterTransforms = createRotatedTransforms(this.entityIds, this.baselineTransforms, deltaMatrix);
    if (!afterTransforms) return false;

    this.deltaMatrixData = Array.from(deltaMatrix.m);
    this.afterTransforms = afterTransforms;
    return this.reconcileTargets();
  }

  /** 重新解析目标，供异步模型加载完成或 thinInstance 批次重建后接回当前旋转。 */
  refresh(): boolean {
    if (this.ended) return false;
    return this.reconcileTargets();
  }

  /** 返回全部成员的最终 Transform，包括当前尚未加载到运行时的实体。 */
  getTransforms(): Record<string, TransformComponent> {
    return cloneTransformRecord(this.entityIds, this.afterTransforms);
  }

  /** 取消预览并精确恢复所有已接入目标的运行时基线。 */
  cancel(): void {
    this.end(true);
  }

  /** 保留当前运行时画面，等待场景文档权威状态同步接管。 */
  finish(): void {
    this.end(false);
  }

  private reconcileTargets(): boolean {
    const desiredTransformTargets = new Map<string, EntityGroupRotationTransformTarget>();
    const desiredBatchEntityIds = new Map<EntityGroupRotationBatch, Set<string>>();

    for (const entityId of this.entityIds) {
      const target = this.resolveTarget(entityId);
      if (!target) continue;
      if (target.kind === 'transform') {
        desiredTransformTargets.set(entityId, target);
        continue;
      }

      const batchEntityIds = desiredBatchEntityIds.get(target.batch) ?? new Set<string>();
      batchEntityIds.add(entityId);
      desiredBatchEntityIds.set(target.batch, batchEntityIds);
    }

    this.reconcileTransformTargets(desiredTransformTargets);
    this.reconcileBatchTargets(desiredBatchEntityIds);
    return desiredTransformTargets.size > 0 || this.activeBatchBindings.size > 0;
  }

  private reconcileTransformTargets(
    desiredTargets: ReadonlyMap<string, EntityGroupRotationTransformTarget>,
  ): void {
    for (const [entityId, active] of this.activeTransformBindings) {
      const desired = desiredTargets.get(entityId);
      if (desired?.identity === active.identity) continue;
      active.setTransform(cloneTransform(this.baselineTransforms[entityId]));
      this.activeTransformBindings.delete(entityId);
    }

    for (const [entityId, target] of desiredTargets) {
      const active = this.activeTransformBindings.get(entityId);
      if (!active) {
        this.activeTransformBindings.set(entityId, {
          identity: target.identity,
          setTransform: target.setTransform,
        });
      } else {
        active.setTransform = target.setTransform;
      }
      target.setTransform(cloneTransform(this.afterTransforms[entityId]));
    }
  }

  private reconcileBatchTargets(
    desiredTargets: ReadonlyMap<EntityGroupRotationBatch, ReadonlySet<string>>,
  ): void {
    for (const [batch, active] of this.activeBatchBindings) {
      const desiredEntityIds = desiredTargets.get(batch);
      if (desiredEntityIds && areSetsEqual(active.entityIds, desiredEntityIds)) continue;
      batch.endEntityRotationPreview(true);
      this.activeBatchBindings.delete(batch);
    }

    for (const [batch, entityIds] of desiredTargets) {
      let active = this.activeBatchBindings.get(batch);
      if (!active) {
        const resolvedEntityIds = new Set(entityIds);
        if (!batch.beginEntityRotationPreview(resolvedEntityIds)) continue;
        active = { entityIds: resolvedEntityIds };
        this.activeBatchBindings.set(batch, active);
      }
      if (batch.updateEntityRotationPreview(this.deltaMatrixData)) continue;

      // 批次可能因异步模型就绪或内部重建而主动结束旧预览；重新捕获完整矩阵基线。
      batch.endEntityRotationPreview(true);
      this.activeBatchBindings.delete(batch);
      const refreshedEntityIds = new Set(entityIds);
      if (!batch.beginEntityRotationPreview(refreshedEntityIds)) continue;
      this.activeBatchBindings.set(batch, { entityIds: refreshedEntityIds });
      batch.updateEntityRotationPreview(this.deltaMatrixData);
    }
  }

  private end(restore: boolean): void {
    if (this.ended) return;
    this.ended = true;

    if (restore) {
      for (const [entityId, active] of this.activeTransformBindings) {
        active.setTransform(cloneTransform(this.baselineTransforms[entityId]));
      }
    }
    this.activeTransformBindings.clear();

    for (const batch of this.activeBatchBindings.keys()) {
      batch.endEntityRotationPreview(restore);
    }
    this.activeBatchBindings.clear();
  }
}

/**
 * 把 Inspector 的参考旋转绝对值转换为绕当前群组中心的世界刚体增量。
 * EntityGroupRotationPreview 会把该增量左乘到每个成员的基线旋转。
 */
export function createEntityGroupRotationDeltaMatrix(
  center: { x: number; y: number; z: number },
  currentRotation: { x: number; y: number; z: number },
  targetRotation: { x: number; y: number; z: number },
): number[] | null {
  if (!isFiniteVector(center) || !isFiniteVector(currentRotation) || !isFiniteVector(targetRotation)) return null;

  const currentQuaternion = Quaternion.RotationYawPitchRoll(
    currentRotation.y,
    currentRotation.x,
    currentRotation.z,
  ).normalize();
  const targetQuaternion = Quaternion.RotationYawPitchRoll(
    targetRotation.y,
    targetRotation.x,
    targetRotation.z,
  ).normalize();
  const deltaQuaternion = targetQuaternion.multiply(currentQuaternion.conjugate()).normalize();
  const beforeMatrix = Matrix.Translation(center.x, center.y, center.z);
  const afterMatrix = Matrix.Compose(
    Vector3.One(),
    deltaQuaternion,
    new Vector3(center.x, center.y, center.z),
  );
  const inverseBefore = beforeMatrix.clone();
  const determinant = inverseBefore.determinant();
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-12) return null;
  inverseBefore.invert();
  const deltaMatrix = inverseBefore.multiply(afterMatrix);
  return deltaMatrix.m.every(Number.isFinite) ? Array.from(deltaMatrix.m) : null;
}

/** 将实体基线绕同一世界增量矩阵旋转；缩放保持原值。 */
function createRotatedTransforms(
  entityIds: readonly string[],
  baselineTransforms: Readonly<Record<string, TransformComponent>>,
  deltaMatrix: Matrix,
): Record<string, TransformComponent> | null {
  const deltaScale = new Vector3();
  const deltaRotation = new Quaternion();
  const deltaTranslation = new Vector3();
  if (!deltaMatrix.decompose(deltaScale, deltaRotation, deltaTranslation)) return null;
  if (
    Math.abs(deltaScale.x - 1) > UNIT_SCALE_EPSILON
    || Math.abs(deltaScale.y - 1) > UNIT_SCALE_EPSILON
    || Math.abs(deltaScale.z - 1) > UNIT_SCALE_EPSILON
  ) return null;
  deltaRotation.normalize();

  const result: Record<string, TransformComponent> = {};
  for (const entityId of entityIds) {
    const baseline = baselineTransforms[entityId];
    if (!isFiniteTransform(baseline)) return null;

    const position = Vector3.TransformCoordinates(
      new Vector3(baseline.position.x, baseline.position.y, baseline.position.z),
      deltaMatrix,
    );
    const baselineRotation = Quaternion.RotationYawPitchRoll(
      baseline.rotation.y,
      baseline.rotation.x,
      baseline.rotation.z,
    );
    const rotation = deltaRotation.multiply(baselineRotation).normalize().toEulerAngles();
    if (!isFiniteVector(position) || !isFiniteVector(rotation)) return null;

    result[entityId] = {
      position: { x: position.x, y: position.y, z: position.z },
      rotation: { x: rotation.x, y: rotation.y, z: rotation.z },
      scale: { ...baseline.scale },
    };
  }
  return result;
}

function isFiniteMatrixData(value: readonly number[]): boolean {
  return value.length === MATRIX_ELEMENT_COUNT && value.every(Number.isFinite);
}

function isFiniteTransform(value: TransformComponent | undefined): value is TransformComponent {
  return Boolean(
    value
    && isFiniteVector(value.position)
    && isFiniteVector(value.rotation)
    && isFiniteVector(value.scale),
  );
}

function isFiniteVector(value: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function cloneTransform(value: TransformComponent): TransformComponent {
  return {
    position: { ...value.position },
    rotation: { ...value.rotation },
    scale: { ...value.scale },
  };
}

function cloneTransformRecord(
  entityIds: readonly string[],
  transforms: Readonly<Record<string, TransformComponent>>,
): Record<string, TransformComponent> {
  return Object.fromEntries(entityIds.map((entityId) => [entityId, cloneTransform(transforms[entityId])]));
}

function areSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}
