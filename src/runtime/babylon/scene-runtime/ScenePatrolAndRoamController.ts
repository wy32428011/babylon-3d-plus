import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { TransformComponent } from '../../../editor/model/components';
import { EditorAutoPatrolRuntime } from '../EditorAutoPatrolRuntime';
import { EditorManualRoamSpawnRuntime } from '../EditorManualRoamSpawnRuntime';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import type { ScenePoiAndEffectsController } from './ScenePoiAndEffectsController';
import type { SceneDocumentController } from './SceneDocumentController';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly effects: Pick<ScenePoiAndEffectsController, 'clickEventBindingRuntime'>;
  readonly document: Pick<SceneDocumentController, 'isEntityTransformEditable'>;
};


/** ScenePatrolAndRoamController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class ScenePatrolAndRoamController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  public autoPatrolMarkerRuntime!: EditorAutoPatrolRuntime;
  public manualRoamSpawnRuntime!: EditorManualRoamSpawnRuntime;

  /** 发布 Viewer 在首次同步前永久禁用巡检原点、节点和路径辅助对象。 */
  disableEditorAutoPatrolMarkers(): void {
    this.autoPatrolMarkerRuntime.disable();
  }

  /** 发布 Viewer 在首次同步前禁用手动漫游初始人物标记。 */
  disableEditorManualRoamSpawnMarkers(): void {
    this.manualRoamSpawnRuntime.disable();
  }

  /** 发布 Viewer 在首次同步前禁用点击事件绑定标记。 */
  disableEditorClickEventBindingMarkers(): void {
    this.dependencies.effects.clickEventBindingRuntime.disable();
  }

  /** 同步路线与节点子选区；节点 ID 是编辑器 transient 状态，不写入场景文档。 */
  setAutoPatrolSelection(routeId: string | null, waypointId: string | null): void {
    this.autoPatrolMarkerRuntime.setSelection(routeId, waypointId);
  }

  /** 同步播放目标高亮。 */
  setAutoPatrolPlaybackTarget(routeId: string | null, waypointIndex: number | null): void {
    this.autoPatrolMarkerRuntime.setPlaybackTarget(routeId, waypointIndex);
  }

  getAutoPatrolWaypointGizmoTarget(entityId: string, waypointId: string): TransformNode | null {
    if (!this.dependencies.document.isEntityTransformEditable(entityId)) return null;
    return this.autoPatrolMarkerRuntime.getWaypointGizmoTarget(entityId, waypointId);
  }

  previewAutoPatrolWaypointTransform(entityId: string, waypointId: string, transform: TransformComponent): void {
    this.autoPatrolMarkerRuntime.previewWaypointTransform(entityId, waypointId, transform);
  }
  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeAutoPatrolMarkerRuntime(): void {
    this.autoPatrolMarkerRuntime = new EditorAutoPatrolRuntime(this.context.scene);
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeManualRoamSpawnRuntime(): void {
    this.manualRoamSpawnRuntime = new EditorManualRoamSpawnRuntime(this.context.scene, this.context.pushLog);
  }

}
