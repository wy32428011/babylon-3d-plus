import {
  AbstractMesh,
  GizmoManager,
  GizmoCoordinatesMode,
  Node,
  Scene,
  TransformNode,
  UtilityLayerRenderer,
  type DragEvent,
  type DragStartEndEvent,
  type IPositionGizmo,
  type IRotationGizmo,
  type IScaleGizmo,
  type Observable,
} from '@babylonjs/core';
import type { TransformComponent } from '../../editor/model/components';
import type { TransformSnapSettings, TransformSpace, TransformTool } from '../../editor/store/editorStore';

type DragCallbacks = {
  previewTransform: (entityId: string, transform: TransformComponent) => void;
  commitTransform: (entityId: string, before: TransformComponent, after: TransformComponent) => void;
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

const CANVAS_SELECTION_BLOCK_MS = 120;
const DEGREES_TO_RADIANS = Math.PI / 180;

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

export class TransformGizmoController {
  private readonly utilityLayer: UtilityLayerRenderer;
  private readonly gizmoManager: GizmoManager;
  private readonly dragObserverBindings: DragObserverBinding[] = [];
  private attachedTarget: GizmoTarget | null = null;
  private attachedEntityId: string | null = null;
  private dragStartTransform: TransformComponent | null = null;
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
    this.gizmoManager.positionGizmoEnabled = tool === 'translate';
    this.gizmoManager.rotationGizmoEnabled = tool === 'rotate';
    this.gizmoManager.scaleGizmoEnabled = tool === 'scale';
  }

  /** 将 Gizmo 轴向切换为世界坐标或对象局部坐标。 */
  setTransformSpace(space: TransformSpace): void {
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

    if (positionGizmo) positionGizmo.snapDistance = positionStep;
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

    this.commitActiveDrag();
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

  /** 记录拖拽开始时的 Transform 快照，后续 Undo/Redo 使用这一份 before。 */
  beginDragSnapshot(): void {
    if (!this.attachedTarget) return;

    this.blockCanvasSelectionBriefly();
    this.dragStartTransform = this.readFiniteTransform(this.attachedTarget);
  }

  /** 拖拽过程中预览 Transform，但不写入命令历史。 */
  previewAttachedTransform(): void {
    if (!this.attachedTarget || !this.attachedEntityId) return;

    const transform = transformFromTarget(this.attachedTarget);
    if (!isFiniteTransform(transform)) return;

    this.callbacks.previewTransform(this.attachedEntityId, transform);
  }

  /** 拖拽结束时提交一条完整 Transform 命令。 */
  commitActiveDrag(): void {
    if (!this.attachedTarget || !this.attachedEntityId || !this.dragStartTransform) return;

    const after = transformFromTarget(this.attachedTarget);
    if (!isFiniteTransform(after)) return;

    this.blockCanvasSelectionBriefly();
    this.callbacks.commitTransform(this.attachedEntityId, this.dragStartTransform, after);
    this.dragStartTransform = after;
  }

  /** 释放 Gizmo、UtilityLayer 和所有拖拽观察者。 */
  dispose(): void {
    this.commitActiveDrag();

    this.removeDragObservers();

    this.gizmoManager.attachToNode(null);
    this.gizmoManager.dispose();
    this.utilityLayer.dispose();
    this.attachedTarget = null;
    this.attachedEntityId = null;
    this.dragStartTransform = null;
  }

  /** 预创建三类 Gizmo，后续只切换 enabled 状态。 */
  private createManagedGizmos(): void {
    this.gizmoManager.positionGizmoEnabled = true;
    this.gizmoManager.rotationGizmoEnabled = true;
    this.gizmoManager.scaleGizmoEnabled = true;
  }

  /** 绑定三类 Gizmo 的拖拽生命周期事件。 */
  private bindGizmoDragObservables(): void {
    const { positionGizmo, rotationGizmo, scaleGizmo } = this.gizmoManager.gizmos;

    if (positionGizmo) this.bindDragObservableGroup(positionGizmo);
    if (rotationGizmo) this.bindDragObservableGroup(rotationGizmo);
    if (scaleGizmo) this.bindDragObservableGroup(scaleGizmo);
  }

  /** 给某一类 Gizmo 统一绑定开始、预览和结束事件。 */
  private bindDragObservableGroup(gizmo: IPositionGizmo | IRotationGizmo | IScaleGizmo): void {
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

  /** 记录观察者清理函数，避免 React StrictMode 下重复挂载泄漏。 */
  private addDragObserver<TEvent>(observable: Observable<TEvent>, callback: () => void): void {
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
