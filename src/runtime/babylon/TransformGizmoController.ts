import {
  AbstractMesh,
  GizmoManager,
  GizmoCoordinatesMode,
  Node,
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
  beginEntityArrayDrag: (context: EntityArrayDragContext) => { spanMeters: number } | null;
  previewEntityArrayDrag: (update: EntityArrayDragUpdate) => void;
  completeEntityArrayDrag: (update: EntityArrayDragUpdate) => void;
  cancelEntityArrayDrag: () => void;
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

export class TransformGizmoController {
  private readonly utilityLayer: UtilityLayerRenderer;
  private readonly gizmoManager: GizmoManager;
  private readonly dragObserverBindings: DragObserverBinding[] = [];
  private attachedTarget: GizmoTarget | null = null;
  private attachedEntityId: string | null = null;
  private dragStartTransform: TransformComponent | null = null;
  private activeTransformDrag = false;
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
    this.bindGizmoDragObservables();
    this.setTool('translate');
  }

  /** 切换当前可见的 Babylon Transform Gizmo 类型。 */
  setTool(tool: TransformTool): void {
    if (this.currentTool !== tool) this.cancelActiveDrag();
    this.currentTool = tool;
    this.gizmoManager.positionGizmoEnabled = tool === 'translate';
    this.gizmoManager.rotationGizmoEnabled = tool === 'rotate';
    this.gizmoManager.scaleGizmoEnabled = tool === 'scale';
  }

  /** 将 Gizmo 轴向切换为世界坐标或对象局部坐标。 */
  setTransformSpace(space: TransformSpace): void {
    if (this.transformSpace !== space) this.cancelActiveDrag();
    this.transformSpace = space;
    const mode = space === 'global' ? GizmoCoordinatesMode.World : GizmoCoordinatesMode.Local;
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

  /** 将 Gizmo 绑定到指定实体的运行时节点，拖拽提交始终回写该实体。 */
  attachToTarget(target: GizmoTarget | null, entityId: string | null): void {
    const nextEntityId = target ? entityId : null;
    if (this.attachedTarget === target && this.attachedEntityId === nextEntityId) return;

    this.cancelActiveDrag();
    this.attachedTarget = target;
    this.attachedEntityId = nextEntityId;
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

    this.blockCanvasSelectionBriefly();
    this.dragStartTransform = this.readFiniteTransform(this.attachedTarget);
    this.activeTransformDrag = this.dragStartTransform !== null;
  }

  /** 拖拽过程中预览 Transform，但不写入命令历史。 */
  previewAttachedTransform(): void {
    if (!this.activeTransformDrag || !this.attachedTarget || !this.attachedEntityId) return;

    const transform = transformFromTarget(this.attachedTarget);
    if (!isFiniteTransform(transform)) return;

    this.callbacks.previewTransform(this.attachedEntityId, transform);
  }

  /** 拖拽结束时提交一条完整 Transform 命令。 */
  commitActiveDrag(): void {
    if (this.entityArrayDragSession || !this.activeTransformDrag) return;
    this.activeTransformDrag = false;
    if (!this.attachedTarget || !this.attachedEntityId || !this.dragStartTransform) return;

    const after = transformFromTarget(this.attachedTarget);
    if (!isFiniteTransform(after)) return;

    this.blockCanvasSelectionBriefly();
    this.callbacks.commitTransform(this.attachedEntityId, this.dragStartTransform, after);
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
      if (!shiftKey || this.currentTool !== 'translate') {
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
    const before = this.dragStartTransform;
    this.activeTransformDrag = false;
    this.releaseAllGizmoDrags();

    if (!target || target.isDisposed() || !entityId || !before) return;
    target.position.copyFromFloats(before.position.x, before.position.y, before.position.z);
    target.rotationQuaternion = null;
    target.rotation.copyFromFloats(before.rotation.x, before.rotation.y, before.rotation.z);
    target.scaling.copyFromFloats(before.scale.x, before.scale.y, before.scale.z);
    target.computeWorldMatrix(true);
    this.callbacks.previewTransform(entityId, before);
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

  /** 从目标节点读取有限数值 Transform，避免 NaN/Infinity 写入编辑状态。 */
  private readFiniteTransform(target: GizmoTarget): TransformComponent | null {
    const transform = transformFromTarget(target);
    return isFiniteTransform(transform) ? transform : null;
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
