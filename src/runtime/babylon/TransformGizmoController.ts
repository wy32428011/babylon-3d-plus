import {
  AbstractMesh,
  GizmoManager,
  GizmoCoordinatesMode,
  Matrix,
  Node,
  Quaternion,
  Scene,
  TransformNode,
  UtilityLayerRenderer,
  Vector3,
  type DragEvent,
  type DragStartEndEvent,
  type IPositionGizmo,
  type IRotationGizmo,
  type IScaleGizmo,
  type Observable,
} from '@babylonjs/core';
import type { TransformComponent } from '../../editor/model/components';
import {
  normalizeSkyboxSphereScale,
  sanitizeSceneEnvironmentTransform,
  type SceneEnvironmentTransform,
} from '../../editor/model/SceneDocument';
import type { Vector3Data } from '../../editor/model/math';
import {
  calculateModelArraySignedCopyCount,
  MODEL_ARRAY_MIN_SPAN_METERS,
} from '../../editor/model/modelArray';
import type { TransformSnapSettings, TransformSpace, TransformTool } from '../../editor/store/editorStore';

export type TransformGizmoAxis = 'x' | 'y' | 'z';

export type EntityArrayDragContext = {
  entityId: string;
  axis: TransformGizmoAxis;
  space: TransformSpace;
  positiveDirection: Vector3Data;
};

export type EntityArrayDragUpdate = EntityArrayDragContext & {
  direction: Vector3Data;
  copyCount: number;
  spanMeters: number;
};

type DragCallbacks = {
  previewTransform: (entityId: string, transform: TransformComponent) => void;
  commitTransform: (entityId: string, before: TransformComponent, after: TransformComponent) => void;
  previewEnvironmentTransform: (transform: SceneEnvironmentTransform) => void;
  commitEnvironmentTransform: (
    before: SceneEnvironmentTransform,
    after: SceneEnvironmentTransform,
  ) => void;
  beginEntityArrayDrag: (context: EntityArrayDragContext) => { spanMeters: number } | null;
  previewEntityArrayDrag: (update: EntityArrayDragUpdate) => void;
  completeEntityArrayDrag: (update: EntityArrayDragUpdate) => void;
  cancelEntityArrayDrag: () => void;
  beginGroupTranslation?: (folderId: string) => boolean;
  previewGroupTranslation?: (folderId: string, delta: Vector3Data) => void;
  commitGroupTranslation?: (folderId: string, delta: Vector3Data) => void;
  cancelGroupTranslation?: (folderId: string) => void;
  beginGroupRotation?: (folderId: string) => boolean;
  previewGroupRotation?: (folderId: string, deltaMatrix: number[]) => void;
  commitGroupRotation?: (folderId: string, deltaMatrix: number[]) => void;
  cancelGroupRotation?: (folderId: string) => void;
};

type DragObservableGroup = {
  onDragStartObservable: Observable<DragStartEndEvent>;
  onDragObservable: Observable<DragEvent>;
  onDragEndObservable: Observable<DragStartEndEvent>;
};

type DragObserverBinding = {
  remove: () => void;
};

type GizmoTarget = AbstractMesh | TransformNode;
type PositionAxisGizmo = IPositionGizmo['xGizmo'];

export type TransformGizmoTargetOptions = {
  uniformScaleOnly?: boolean;
};

type EntityArrayDragSession = {
  context: EntityArrayDragContext;
  sourceTarget: GizmoTarget;
  proxyTarget: TransformNode;
  startPosition: Vector3;
  positiveDirection: Vector3;
  projectedDistanceMeters: number;
  spanMeters: number;
  signedCopyCount: number;
};

const CANVAS_SELECTION_BLOCK_MS = 120;
const DEGREES_TO_RADIANS = Math.PI / 180;

const LOCAL_AXIS_VECTORS: Record<TransformGizmoAxis, Vector3> = {
  x: new Vector3(1, 0, 0),
  y: new Vector3(0, 1, 0),
  z: new Vector3(0, 0, 1),
};

function transformFromTarget(target: GizmoTarget): TransformComponent {
  return {
    position: { x: target.position.x, y: target.position.y, z: target.position.z },
    rotation: { x: target.rotation.x, y: target.rotation.y, z: target.rotation.z },
    scale: { x: target.scaling.x, y: target.scaling.y, z: target.scaling.z },
  };
}

/** 将统一缩放的环境根节点转换为持久化 Transform。 */
function environmentTransformFromTarget(target: GizmoTarget): SceneEnvironmentTransform {
  return sanitizeSceneEnvironmentTransform({
    position: { x: target.position.x, y: target.position.y, z: target.position.z },
    rotation: { x: target.rotation.x, y: target.rotation.y, z: target.rotation.z },
    scale: target.scaling.x,
  });
}

/** 从普通 Transform 快照恢复环境统一缩放语义。 */
function environmentTransformFromComponent(transform: TransformComponent): SceneEnvironmentTransform {
  return sanitizeSceneEnvironmentTransform({
    position: { ...transform.position },
    rotation: { ...transform.rotation },
    scale: transform.scale.x,
  });
}

function isFiniteVector(vector: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function isFiniteTransform(transform: TransformComponent): boolean {
  return isFiniteVector(transform.position) && isFiniteVector(transform.rotation) && isFiniteVector(transform.scale);
}

function vector3Data(vector: Vector3): Vector3Data {
  return { x: vector.x, y: vector.y, z: vector.z };
}

function negateVector3Data(vector: Vector3Data): Vector3Data {
  return { x: -vector.x, y: -vector.y, z: -vector.z };
}

/** 从代理拖拽起点和终点生成可右乘到实体世界 Transform 的刚体增量矩阵。 */
function createRelativeTransformMatrixData(
  before: TransformComponent,
  after: TransformComponent,
): number[] | null {
  const beforeMatrix = Matrix.Compose(
    Vector3.One(),
    Quaternion.RotationYawPitchRoll(before.rotation.y, before.rotation.x, before.rotation.z),
    new Vector3(before.position.x, before.position.y, before.position.z),
  );
  const afterMatrix = Matrix.Compose(
    Vector3.One(),
    Quaternion.RotationYawPitchRoll(after.rotation.y, after.rotation.x, after.rotation.z),
    new Vector3(after.position.x, after.position.y, after.position.z),
  );
  const inverseBefore = beforeMatrix.clone();
  const determinant = inverseBefore.determinant();
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-12) return null;
  inverseBefore.invert();
  const deltaMatrix = inverseBefore.multiply(afterMatrix);
  return deltaMatrix.m.every(Number.isFinite) ? Array.from(deltaMatrix.m) : null;
}

export class TransformGizmoController {
  private readonly utilityLayer: UtilityLayerRenderer;
  private readonly gizmoManager: GizmoManager;
  private readonly dragObserverBindings: DragObserverBinding[] = [];
  private attachedTarget: GizmoTarget | null = null;
  private attachedEntityId: string | null = null;
  private attachedGroupId: string | null = null;
  private attachedEnvironment = false;
  private attachedUniformScaleOnly = false;
  private dragStartTransform: TransformComponent | null = null;
  private activeTransformDrag = false;
  private activeGroupTool: 'translate' | 'rotate' | null = null;
  private entityArrayDragSession: EntityArrayDragSession | null = null;
  private currentTool: TransformTool = 'translate';
  private transformSpace: TransformSpace = 'local';
  private positionSnapDistance = 0;
  private canvasSelectionBlockedUntil = 0;

  constructor(
    private readonly scene: Scene,
    private readonly callbacks: DragCallbacks,
  ) {
    this.utilityLayer = new UtilityLayerRenderer(scene);
    this.gizmoManager = new GizmoManager(scene, 1, this.utilityLayer);
    this.gizmoManager.usePointerToAttachGizmos = false;
    this.createManagedGizmos();
    this.disableGizmoCameraDetach();
    this.bindGizmoDragObservables();
    this.setTool('translate');
  }

  /**
   * 禁止 Gizmo 拖拽时 detach 相机控制。拖拽结束 PointerDragBehavior 会以旧签名重新
   * attachControl，触发 _panningMouseButton setter 篡改自定义按键映射（中键平移失效）。
   * Gizmo 上的指针事件已被 UtilityLayer 的 skipOnPointerObservable 隔离，无需 detach。
   */
  private disableGizmoCameraDetach(): void {
    const { positionGizmo, rotationGizmo, scaleGizmo } = this.gizmoManager.gizmos;
    const gizmos = [
      positionGizmo?.xGizmo,
      positionGizmo?.yGizmo,
      positionGizmo?.zGizmo,
      positionGizmo?.xPlaneGizmo,
      positionGizmo?.yPlaneGizmo,
      positionGizmo?.zPlaneGizmo,
      rotationGizmo?.xGizmo,
      rotationGizmo?.yGizmo,
      rotationGizmo?.zGizmo,
      scaleGizmo?.xGizmo,
      scaleGizmo?.yGizmo,
      scaleGizmo?.zGizmo,
      scaleGizmo?.uniformScaleGizmo,
    ];
    for (const gizmo of gizmos) {
      if (gizmo) gizmo.dragBehavior.detachCameraControls = false;
    }
  }

  /** 切换当前可见的 Babylon Transform Gizmo 类型。 */
  setTool(tool: TransformTool): void {
    const resolvedTool = this.attachedGroupId && tool === 'scale' ? 'translate' : tool;
    if (this.currentTool !== resolvedTool) this.cancelActiveDrag();
    this.currentTool = resolvedTool;
    this.gizmoManager.positionGizmoEnabled = resolvedTool === 'translate';
    this.gizmoManager.rotationGizmoEnabled = resolvedTool === 'rotate';
    this.gizmoManager.scaleGizmoEnabled = resolvedTool === 'scale';
    this.updateScaleGizmoHandles();
  }

  /** 将 Gizmo 轴向切换为世界坐标或对象局部坐标。 */
  setTransformSpace(space: TransformSpace): void {
    if (this.attachedGroupId && space !== 'global') this.cancelActiveDrag();
    const resolvedSpace = this.attachedGroupId ? 'global' : space;
    if (this.transformSpace !== resolvedSpace) this.cancelActiveDrag();
    this.transformSpace = resolvedSpace;
    const mode = resolvedSpace === 'global' ? GizmoCoordinatesMode.World : GizmoCoordinatesMode.Local;
    const { positionGizmo, rotationGizmo, scaleGizmo } = this.gizmoManager.gizmos;

    if (positionGizmo) positionGizmo.coordinatesMode = mode;
    if (rotationGizmo) rotationGizmo.coordinatesMode = mode;
    if (scaleGizmo) scaleGizmo.coordinatesMode = mode;
  }

  /** 应用位置、旋转、缩放三类 Gizmo 吸附步长。 */
  setSnapSettings(settings: TransformSnapSettings): void {
    const { positionGizmo, rotationGizmo, scaleGizmo } = this.gizmoManager.gizmos;
    const positionStep = settings.enabled ? settings.position : 0;
    const rotationStep = settings.enabled ? settings.rotationDegrees * DEGREES_TO_RADIANS : 0;
    const scaleStep = settings.enabled ? settings.scale : 0;
    this.positionSnapDistance = positionStep;

    if (positionGizmo && !this.entityArrayDragSession) positionGizmo.snapDistance = positionStep;
    if (rotationGizmo) rotationGizmo.snapDistance = rotationStep;
    if (scaleGizmo) {
      scaleGizmo.snapDistance = scaleStep;
      scaleGizmo.incrementalSnap = true;
    }
  }

  /** 将 Gizmo 绑定到指定实体的运行时节点，天空盒可只开放统一缩放手柄。 */
  attachToTarget(
    target: GizmoTarget | null,
    entityId: string | null,
    options: TransformGizmoTargetOptions = {},
  ): void {
    const nextEntityId = target ? entityId : null;
    const nextUniformScaleOnly = Boolean(target && options.uniformScaleOnly);
    if (
      this.attachedTarget === target
      && this.attachedEntityId === nextEntityId
      && this.attachedGroupId === null
      && this.attachedUniformScaleOnly === nextUniformScaleOnly
    ) return;

    this.cancelActiveDrag();
    this.attachedTarget = target;
    this.attachedEntityId = nextEntityId;
    this.attachedGroupId = null;
    this.attachedEnvironment = false;
    this.attachedUniformScaleOnly = nextUniformScaleOnly;
    this.updateScaleGizmoHandles();
    this.attachGizmo(target);
    this.dragStartTransform = target ? this.readFiniteTransform(target) : null;
  }

  /** 将移动或旋转 Gizmo 绑定到文件夹整组的不可见中心代理。 */
  attachToGroupTarget(target: TransformNode | null, folderId: string | null): void {
    const nextGroupId = target ? folderId : null;
    if (
      this.attachedTarget === target
      && this.attachedGroupId === nextGroupId
      && this.attachedEntityId === null
    ) return;

    this.cancelActiveDrag();
    this.attachedTarget = target;
    this.attachedEntityId = null;
    this.attachedGroupId = nextGroupId;
    this.attachedEnvironment = false;
    this.attachedUniformScaleOnly = false;
    this.updateScaleGizmoHandles();
    this.currentTool = this.currentTool === 'rotate' ? 'rotate' : 'translate';
    this.gizmoManager.positionGizmoEnabled = this.currentTool === 'translate';
    this.gizmoManager.rotationGizmoEnabled = this.currentTool === 'rotate';
    this.gizmoManager.scaleGizmoEnabled = false;
    this.transformSpace = 'global';
    const { positionGizmo, rotationGizmo } = this.gizmoManager.gizmos;
    if (positionGizmo) positionGizmo.coordinatesMode = GizmoCoordinatesMode.World;
    if (rotationGizmo) rotationGizmo.coordinatesMode = GizmoCoordinatesMode.World;
    this.attachGizmo(target);
    this.dragStartTransform = target ? this.readFiniteTransform(target) : null;
  }

  /** 将 Gizmo 临时绑定到全局环境根节点，拖动不进入实体选择或 Shift 阵列流程。 */
  attachToEnvironmentTarget(target: TransformNode | null): void {
    if (
      this.attachedTarget === target
      && this.attachedEnvironment === Boolean(target)
      && this.attachedEntityId === null
      && this.attachedGroupId === null
    ) return;

    this.cancelActiveDrag();
    this.attachedTarget = target;
    this.attachedEntityId = null;
    this.attachedGroupId = null;
    this.attachedEnvironment = Boolean(target);
    this.attachedUniformScaleOnly = false;
    this.updateScaleGizmoHandles();
    this.attachGizmo(target);
    this.dragStartTransform = target ? this.readFiniteTransform(target) : null;
  }

  /** 返回指针是否正在 hover 或拖拽 Gizmo，供 Scene 点击选择逻辑避让。 */
  isPointerUsingGizmo(): boolean {
    return Date.now() < this.canvasSelectionBlockedUntil
      || this.isGizmoActive(this.gizmoManager.gizmos.positionGizmo)
      || this.isGizmoActive(this.gizmoManager.gizmos.rotationGizmo)
      || this.isGizmoActive(this.gizmoManager.gizmos.scaleGizmo);
  }

  /** 取消当前 Gizmo 指针会话；普通 Transform 回滚，Shift 阵列只清理代理和临时预览。 */
  cancelActiveDrag(): void {
    if (this.entityArrayDragSession) {
      this.cancelActiveEntityArrayDrag();
      return;
    }

    this.cancelActiveTransformDrag();
  }

  /** 仅取消文件夹组拖动，普通实体 Transform 与 Shift 阵列会话保持不变。 */
  cancelActiveGroupDrag(): void {
    if (!this.attachedGroupId) return;
    this.cancelActiveDrag();
  }

  /** 主动取消尚未结束的 Shift 阵列拖拽，不打开参数弹框。 */
  cancelActiveEntityArrayDrag(): void {
    const session = this.entityArrayDragSession;
    if (!session) return;

    this.entityArrayDragSession = null;
    this.gizmoManager.gizmos.positionGizmo?.releaseDrag();
    this.restoreSourceAfterEntityArrayDrag(session);
    this.callbacks.cancelEntityArrayDrag();
    this.blockCanvasSelectionBriefly();
  }

  /** 记录拖拽开始时的 Transform 快照，后续 Undo/Redo 使用这一份 before。 */
  beginDragSnapshot(): void {
    if (!this.attachedTarget) return;
    this.activeGroupTool = null;
    if (this.attachedGroupId) {
      const groupTool = this.currentTool === 'rotate' ? 'rotate' : 'translate';
      const started = groupTool === 'rotate'
        ? this.callbacks.beginGroupRotation?.(this.attachedGroupId)
        : this.callbacks.beginGroupTranslation?.(this.attachedGroupId);
      if (started !== true) {
        this.activeTransformDrag = false;
        this.releaseAllGizmoDrags();
        return;
      }
      this.activeGroupTool = groupTool;
    }

    this.blockCanvasSelectionBriefly();
    this.dragStartTransform = this.readFiniteTransform(this.attachedTarget);
    this.activeTransformDrag = this.dragStartTransform !== null;
  }

  /** 拖拽过程中预览 Transform，但不写入命令历史。 */
  previewAttachedTransform(): void {
    if (!this.activeTransformDrag || !this.attachedTarget || !this.dragStartTransform) return;

    const transform = this.readFiniteTransform(this.attachedTarget);
    if (!transform) return;
    if (this.attachedUniformScaleOnly) {
      this.attachedTarget.scaling.copyFromFloats(transform.scale.x, transform.scale.y, transform.scale.z);
    }
    if (this.attachedGroupId) {
      if (this.activeGroupTool === 'rotate') {
        const deltaMatrix = createRelativeTransformMatrixData(this.dragStartTransform, transform);
        if (deltaMatrix) this.callbacks.previewGroupRotation?.(this.attachedGroupId, deltaMatrix);
      } else {
        this.callbacks.previewGroupTranslation?.(
          this.attachedGroupId,
          {
            x: transform.position.x - this.dragStartTransform.position.x,
            y: transform.position.y - this.dragStartTransform.position.y,
            z: transform.position.z - this.dragStartTransform.position.z,
          },
        );
      }
      return;
    }
    if (this.attachedEnvironment) {
      const environmentTransform = environmentTransformFromTarget(this.attachedTarget);
      this.attachedTarget.scaling.copyFromFloats(
        environmentTransform.scale,
        environmentTransform.scale,
        environmentTransform.scale,
      );
      this.callbacks.previewEnvironmentTransform(environmentTransform);
      return;
    }
    if (this.attachedEntityId) this.callbacks.previewTransform(this.attachedEntityId, transform);
  }

  /** 拖拽结束时提交一条完整 Transform 命令。 */
  commitActiveDrag(): void {
    if (this.entityArrayDragSession || !this.activeTransformDrag) return;
    this.activeTransformDrag = false;
    const activeGroupTool = this.activeGroupTool;
    this.activeGroupTool = null;
    if (
      !this.attachedTarget
      || (!this.attachedEntityId && !this.attachedGroupId && !this.attachedEnvironment)
      || !this.dragStartTransform
    ) return;

    const after = this.readFiniteTransform(this.attachedTarget);
    if (!after) return;
    if (this.attachedUniformScaleOnly) {
      this.attachedTarget.scaling.copyFromFloats(after.scale.x, after.scale.y, after.scale.z);
    }

    this.blockCanvasSelectionBriefly();
    if (this.attachedGroupId) {
      if (activeGroupTool === 'rotate') {
        const deltaMatrix = createRelativeTransformMatrixData(this.dragStartTransform, after);
        if (deltaMatrix) this.callbacks.commitGroupRotation?.(this.attachedGroupId, deltaMatrix);
      } else {
        this.callbacks.commitGroupTranslation?.(
          this.attachedGroupId,
          {
            x: after.position.x - this.dragStartTransform.position.x,
            y: after.position.y - this.dragStartTransform.position.y,
            z: after.position.z - this.dragStartTransform.position.z,
          },
        );
      }
    } else if (this.attachedEnvironment) {
      this.callbacks.commitEnvironmentTransform(
        environmentTransformFromComponent(this.dragStartTransform),
        environmentTransformFromTarget(this.attachedTarget),
      );
    } else if (this.attachedEntityId) {
      this.callbacks.commitTransform(this.attachedEntityId, this.dragStartTransform, after);
    }
    this.dragStartTransform = after;
  }

  /** 释放 Gizmo、UtilityLayer 和所有拖拽观察者。 */
  dispose(): void {
    this.cancelActiveDrag();
    this.removeDragObservers();

    this.gizmoManager.attachToNode(null);
    this.gizmoManager.dispose();
    this.utilityLayer.dispose();
    this.attachedTarget = null;
    this.attachedEntityId = null;
    this.attachedGroupId = null;
    this.attachedEnvironment = false;
    this.attachedUniformScaleOnly = false;
    this.dragStartTransform = null;
    this.activeTransformDrag = false;
  }

  /** 预创建三类 Gizmo，后续只切换 enabled 状态。 */
  private createManagedGizmos(): void {
    this.gizmoManager.positionGizmoEnabled = true;
    this.gizmoManager.rotationGizmoEnabled = true;
    this.gizmoManager.scaleGizmoEnabled = true;
  }

  /** 绑定位置单轴阵列手势，以及其余 Gizmo 的普通拖拽生命周期。 */
  private bindGizmoDragObservables(): void {
    const { positionGizmo, rotationGizmo, scaleGizmo } = this.gizmoManager.gizmos;

    if (positionGizmo) {
      this.bindPositionAxisDrag(positionGizmo.xGizmo, 'x');
      this.bindPositionAxisDrag(positionGizmo.yGizmo, 'y');
      this.bindPositionAxisDrag(positionGizmo.zGizmo, 'z');
      this.bindDragObservableGroup(positionGizmo.xPlaneGizmo.dragBehavior);
      this.bindDragObservableGroup(positionGizmo.yPlaneGizmo.dragBehavior);
      this.bindDragObservableGroup(positionGizmo.zPlaneGizmo.dragBehavior);
    }
    if (rotationGizmo) this.bindDragObservableGroup(rotationGizmo);
    if (scaleGizmo) this.bindDragObservableGroup(scaleGizmo);
  }

  /** 给单个位置轴绑定 Shift 阵列与普通移动两套互斥行为。 */
  private bindPositionAxisDrag(gizmo: PositionAxisGizmo, axis: TransformGizmoAxis): void {
    const observables: DragObservableGroup = gizmo.dragBehavior;

    this.addDragObserver(observables.onDragStartObservable, (event) => {
      const shiftKey = event.pointerInfo?.event.shiftKey === true;
      if (this.attachedEnvironment || this.attachedGroupId || !shiftKey || this.currentTool !== 'translate') {
        this.beginDragSnapshot();
        return;
      }

      this.beginEntityArrayDrag(axis, event);
    });
    this.addDragObserver(observables.onDragObservable, (event) => {
      if (this.entityArrayDragSession) {
        this.previewActiveEntityArrayDrag(event);
        return;
      }
      this.previewAttachedTransform();
    });
    this.addDragObserver(observables.onDragEndObservable, () => {
      if (this.entityArrayDragSession) {
        this.completeActiveEntityArrayDrag();
        return;
      }
      this.commitActiveDrag();
    });
  }

  /** 给非阵列 Gizmo 统一绑定开始、预览和结束事件。 */
  private bindDragObservableGroup(gizmo: IRotationGizmo | IScaleGizmo | DragObservableGroup): void {
    const observables: DragObservableGroup = gizmo;

    this.addDragObserver(observables.onDragStartObservable, () => {
      this.beginDragSnapshot();
    });
    this.addDragObserver(observables.onDragObservable, () => {
      this.previewAttachedTransform();
    });
    this.addDragObserver(observables.onDragEndObservable, () => {
      this.commitActiveDrag();
    });
  }

  /** 初始化 Shift 阵列会话，并在第一帧移动前把 Gizmo 改绑到代理节点。 */
  private beginEntityArrayDrag(axis: TransformGizmoAxis, event: DragStartEndEvent): void {
    if (!this.attachedTarget || !this.attachedEntityId) return;

    const positiveDirection = this.getWorldAxisDirection(this.attachedTarget, axis);
    if (!positiveDirection) {
      this.gizmoManager.gizmos.positionGizmo?.releaseDrag();
      return;
    }

    const context: EntityArrayDragContext = {
      entityId: this.attachedEntityId,
      axis,
      space: this.transformSpace,
      positiveDirection: vector3Data(positiveDirection),
    };
    const geometry = this.callbacks.beginEntityArrayDrag(context);
    if (!geometry || !Number.isFinite(geometry.spanMeters) || geometry.spanMeters <= MODEL_ARRAY_MIN_SPAN_METERS) {
      this.gizmoManager.gizmos.positionGizmo?.releaseDrag();
      return;
    }

    const proxyTarget = this.createEntityArrayProxy(this.attachedTarget);
    this.entityArrayDragSession = {
      context,
      sourceTarget: this.attachedTarget,
      proxyTarget,
      startPosition: proxyTarget.position.clone(),
      positiveDirection,
      projectedDistanceMeters: 0,
      spanMeters: geometry.spanMeters,
      signedCopyCount: 0,
    };
    const positionGizmo = this.gizmoManager.gizmos.positionGizmo;
    if (positionGizmo) positionGizmo.snapDistance = 0;
    this.attachGizmo(proxyTarget);
    this.dragStartTransform = null;
    this.activeTransformDrag = false;
    this.blockCanvasSelectionBriefly();

    // pointerInfo 只在拖拽开始事件中可靠携带 Shift；会话建立后以鼠标松开为结束边界。
    void event;
  }

  /** 根据累计世界位移更新离散副本数量、代理位置和 Babylon 临时克隆。 */
  private previewActiveEntityArrayDrag(event: DragEvent): void {
    const session = this.entityArrayDragSession;
    if (!session) return;

    const projectedDelta = Vector3.Dot(event.delta, session.positiveDirection);
    if (Number.isFinite(projectedDelta)) session.projectedDistanceMeters += projectedDelta;
    const signedCopyCount = calculateModelArraySignedCopyCount(
      session.projectedDistanceMeters,
      session.spanMeters,
    );

    session.proxyTarget.position.copyFrom(session.startPosition).addInPlace(
      session.positiveDirection.scale(signedCopyCount * session.spanMeters),
    );
    session.proxyTarget.computeWorldMatrix(true);

    if (signedCopyCount === session.signedCopyCount) return;
    session.signedCopyCount = signedCopyCount;
    this.callbacks.previewEntityArrayDrag(this.createEntityArrayDragUpdate(session));
  }

  /** 鼠标松开后恢复源 Gizmo；有有效副本时交由 SceneView 打开参数弹框。 */
  private completeActiveEntityArrayDrag(): void {
    const session = this.entityArrayDragSession;
    if (!session) return;

    this.entityArrayDragSession = null;
    const update = this.createEntityArrayDragUpdate(session);
    this.restoreSourceAfterEntityArrayDrag(session);
    this.blockCanvasSelectionBriefly();

    if (update.copyCount > 0) this.callbacks.completeEntityArrayDrag(update);
    else this.callbacks.cancelEntityArrayDrag();
  }

  /** 取消普通 Transform 拖动并恢复 before 快照，不写入命令历史。 */
  private cancelActiveTransformDrag(): void {
    if (!this.activeTransformDrag) return;

    const target = this.attachedTarget;
    const entityId = this.attachedEntityId;
    const environmentAttached = this.attachedEnvironment;
    const activeGroupTool = this.activeGroupTool;
    const before = this.dragStartTransform;
    this.activeTransformDrag = false;
    this.activeGroupTool = null;
    this.releaseAllGizmoDrags();

    if (!target || target.isDisposed() || !before) return;
    target.position.copyFromFloats(before.position.x, before.position.y, before.position.z);
    target.rotationQuaternion = null;
    target.rotation.copyFromFloats(before.rotation.x, before.rotation.y, before.rotation.z);
    target.scaling.copyFromFloats(before.scale.x, before.scale.y, before.scale.z);
    target.computeWorldMatrix(true);
    if (this.attachedGroupId) {
      if (activeGroupTool === 'rotate') this.callbacks.cancelGroupRotation?.(this.attachedGroupId);
      else this.callbacks.cancelGroupTranslation?.(this.attachedGroupId);
    } else if (environmentAttached) {
      this.callbacks.previewEnvironmentTransform(environmentTransformFromComponent(before));
    } else if (entityId) {
      this.callbacks.previewTransform(entityId, before);
    }
    this.dragStartTransform = this.readFiniteTransform(target);
    this.blockCanvasSelectionBriefly();
  }

  /** 释放三类 Gizmo 当前指针拖动；观察者会因活动标记已清除而不提交历史。 */
  private releaseAllGizmoDrags(): void {
    const { positionGizmo, rotationGizmo, scaleGizmo } = this.gizmoManager.gizmos;
    positionGizmo?.releaseDrag();
    rotationGizmo?.releaseDrag();
    scaleGizmo?.releaseDrag();
  }

  /** 将代理节点释放并把 Gizmo 恢复到原始源实体根节点。 */
  private restoreSourceAfterEntityArrayDrag(session: EntityArrayDragSession): void {
    const positionGizmo = this.gizmoManager.gizmos.positionGizmo;
    if (positionGizmo) positionGizmo.snapDistance = this.positionSnapDistance;
    this.attachGizmo(session.sourceTarget);
    session.proxyTarget.dispose(false, false);
    this.dragStartTransform = this.readFiniteTransform(session.sourceTarget);
  }

  /** 从阵列会话生成带正负方向和绝对副本数量的回调数据。 */
  private createEntityArrayDragUpdate(session: EntityArrayDragSession): EntityArrayDragUpdate {
    const copyCount = Math.abs(session.signedCopyCount);
    const direction = session.signedCopyCount < 0
      ? negateVector3Data(session.context.positiveDirection)
      : session.context.positiveDirection;

    return {
      ...session.context,
      direction,
      copyCount,
      spanMeters: session.spanMeters,
    };
  }

  /** 创建只承载 Gizmo 位姿的不可见代理，不挂接任何实体几何。 */
  private createEntityArrayProxy(source: GizmoTarget): TransformNode {
    const proxy = new TransformNode('__entityArrayGizmoProxy', this.scene);
    proxy.position.copyFrom(source.position);
    proxy.rotation.copyFrom(source.rotation);
    proxy.scaling.copyFrom(source.scaling);
    proxy.rotationQuaternion = source.rotationQuaternion?.clone() ?? null;
    proxy.computeWorldMatrix(true);
    return proxy;
  }

  /** 根据当前局部/世界坐标模式读取 Gizmo 正轴在世界空间中的单位方向。 */
  private getWorldAxisDirection(target: GizmoTarget, axis: TransformGizmoAxis): Vector3 | null {
    const localAxis = LOCAL_AXIS_VECTORS[axis];
    const direction = this.transformSpace === 'global'
      ? localAxis.clone()
      : target.getDirection(localAxis);
    const lengthSquared = direction.lengthSquared();
    if (!Number.isFinite(lengthSquared) || lengthSquared <= MODEL_ARRAY_MIN_SPAN_METERS ** 2) return null;
    return direction.normalize();
  }

  /** 记录观察者清理函数，避免 React StrictMode 下重复挂载泄漏。 */
  private addDragObserver<TEvent>(observable: Observable<TEvent>, callback: (event: TEvent) => void): void {
    const observer = observable.add(callback);
    this.dragObserverBindings.push({
      remove: () => {
        observable.remove(observer);
      },
    });
  }

  /** 移除当前已绑定的所有 Gizmo 事件观察者。 */
  private removeDragObservers(): void {
    for (const binding of this.dragObserverBindings.splice(0)) {
      binding.remove();
    }
  }

  /** 判断某个 Gizmo 当前是否处于 hover 或拖拽状态。 */
  private isGizmoActive(gizmo: IPositionGizmo | IRotationGizmo | IScaleGizmo | null | undefined): boolean {
    return Boolean(gizmo?.isHovered || gizmo?.isDragging);
  }

  /** 短暂屏蔽画布点击选择，避免 Gizmo 拖拽结束事件误触发空白清选。 */
  private blockCanvasSelectionBriefly(): void {
    this.canvasSelectionBlockedUntil = Date.now() + CANVAS_SELECTION_BLOCK_MS;
  }

  /** 从目标节点读取有限 Transform；天空盒在回调前统一并限制三轴缩放。 */
  private readFiniteTransform(target: GizmoTarget): TransformComponent | null {
    const transform = transformFromTarget(target);
    if (!isFiniteTransform(transform)) return null;
    if (!this.attachedUniformScaleOnly) return transform;
    return {
      ...transform,
      scale: normalizeSkyboxSphereScale(transform.scale),
    };
  }

  /** 环境和天空盒只允许统一缩放；普通实体保留三个轴向与统一缩放手柄。 */
  private updateScaleGizmoHandles(): void {
    const scaleGizmo = this.gizmoManager.gizmos.scaleGizmo;
    if (!scaleGizmo) return;

    const axisEnabled = !this.attachedEnvironment && !this.attachedUniformScaleOnly;
    scaleGizmo.xGizmo.isEnabled = axisEnabled;
    scaleGizmo.yGizmo.isEnabled = axisEnabled;
    scaleGizmo.zGizmo.isEnabled = axisEnabled;
    scaleGizmo.uniformScaleGizmo.isEnabled = true;
  }

  /** 根据目标类型选择 Babylon 推荐的 Gizmo 绑定 API。 */
  private attachGizmo(target: GizmoTarget | null): void {
    if (target instanceof AbstractMesh) {
      this.gizmoManager.attachToMesh(target);
      return;
    }

    this.gizmoManager.attachToNode(target as Node | null);
  }
}
