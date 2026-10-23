import type { Entity } from '../../model/Entity';
import { resolveLightTransformTool } from '../../model/lightEditor';
import { collectEntitySubtreeIds, getTopLevelHierarchyEntityIds, isEntityEffectivelyLocked, isHierarchyGroupTransformSelection } from '../../model/entityHierarchy';
import { type SceneDocument } from '../../model/SceneDocument';
import type { TransformSnapSettings, SelectedModelMeasurement, SelectedGroupSpatialInfo, EditorState } from './editorStoreTypes';

export const DEFAULT_SNAP_SETTINGS: TransformSnapSettings = {
  enabled: false,
  position: 0.5,
  rotationDegrees: 15,
  scale: 0.1,
};

/** 比较两份模型测量快照，避免相同运行时结果触发无意义的 React 重渲染。 */
export function areSelectedModelMeasurementsEqual(
  left: SelectedModelMeasurement | null,
  right: SelectedModelMeasurement | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.entityId !== right.entityId || left.status !== right.status) return false;
  if (left.status !== 'ready' || right.status !== 'ready') return true;

  return Math.abs(left.sizeMeters.x - right.sizeMeters.x) <= 1e-6
    && Math.abs(left.sizeMeters.y - right.sizeMeters.y) <= 1e-6
    && Math.abs(left.sizeMeters.z - right.sizeMeters.z) <= 1e-6;
}

/** 比较群组空间快照，避免相同包围盒结果触发 Inspector 重渲染。 */
export function areSelectedGroupSpatialInfosEqual(
  left: SelectedGroupSpatialInfo | null,
  right: SelectedGroupSpatialInfo | null,
): boolean {
  if (left === right) return true;
  if (
    !left
    || !right
    || left.groupId !== right.groupId
    || left.status !== right.status
    || left.memberCount !== right.memberCount
  ) return false;
  if (
    Math.abs(left.rotation.x - right.rotation.x) > 1e-6
    || Math.abs(left.rotation.y - right.rotation.y) > 1e-6
    || Math.abs(left.rotation.z - right.rotation.z) > 1e-6
  ) return false;
  if (left.status !== 'ready' || right.status !== 'ready') return true;

  return Math.abs(left.center.x - right.center.x) <= 1e-6
    && Math.abs(left.center.y - right.center.y) <= 1e-6
    && Math.abs(left.center.z - right.center.z) <= 1e-6
    && Math.abs(left.sizeMeters.x - right.sizeMeters.x) <= 1e-6
    && Math.abs(left.sizeMeters.y - right.sizeMeters.y) <= 1e-6
    && Math.abs(left.sizeMeters.z - right.sizeMeters.z) <= 1e-6;
}

export function getSelectedEntity(state: EditorState) {
  const selectedId = state.scene.selectedEntityId;
  if (!selectedId) return null;
  return state.scene.entities[selectedId] ?? null;
}

/** 判断普通实体是否允许编辑，文件夹不参与 Transform 类编辑。 */
export function isRuntimeEntityEditable(scene: SceneDocument, entity: Entity | null | undefined): entity is Entity {
  return Boolean(entity && !entity.isFolder && !isEntityEffectivelyLocked(scene.entities, entity));
}

/** 过滤 Hierarchy 多选 ID，避免 UI 状态引用已经不存在的实体。 */
export function sanitizeHierarchySelection(scene: SceneDocument, entityIds: string[]): string[] {
  return [...new Set(entityIds)].filter((entityId) => Boolean(scene.entities[entityId]));
}

/** 群组选区临时强制世界坐标移动/旋转，恢复单选时还原进入群组前的用户工具偏好。 */
export function resolveSelectionTransformMode(
  state: Pick<EditorState, 'transformTool' | 'transformSpace' | 'groupTransformModeRestore'>,
  scene: SceneDocument,
  hierarchySelectionIds: readonly string[],
): Pick<EditorState, 'transformTool' | 'transformSpace' | 'groupTransformModeRestore'> {
  if (isHierarchyGroupTransformSelection(scene, hierarchySelectionIds)) {
    return {
      transformTool: state.transformTool === 'rotate' ? 'rotate' : 'translate',
      transformSpace: 'global',
      groupTransformModeRestore: state.groupTransformModeRestore ?? {
        tool: state.transformTool,
        space: state.transformSpace,
      },
    };
  }

  const requestedTool = state.groupTransformModeRestore?.tool ?? state.transformTool;
  const requestedSpace = state.groupTransformModeRestore?.space ?? state.transformSpace;
  const selectedEntity = scene.selectedEntityId ? scene.entities[scene.selectedEntityId] : null;
  const lightKind = selectedEntity?.components.light?.lightKind;
  const transformTool = (selectedEntity?.components.autoPatrol || selectedEntity?.components.manualRoamSpawn)
    && requestedTool === 'scale'
    ? 'translate'
    : lightKind
      ? resolveLightTransformTool(lightKind, requestedTool)
      : requestedTool;
  return {
    transformTool,
    transformSpace: requestedSpace,
    groupTransformModeRestore: null,
  };
}

/** 返回当前仍有效的巡检节点子选区。 */
export function sanitizeSelectedAutoPatrolWaypointId(
  scene: SceneDocument,
  waypointId: string | null,
): string | null {
  if (!waypointId || !scene.selectedEntityId) return null;
  const waypoints = scene.entities[scene.selectedEntityId]?.components.autoPatrol?.waypoints;
  return waypoints?.some((waypoint) => waypoint.id === waypointId) ? waypointId : null;
}

/** 返回当前 Hierarchy 主选区，兼容只有 Scene 单选但没有多选数组的情况。 */
export function getActiveHierarchySelectionIds(state: EditorState): string[] {
  if (state.hierarchySelectionIds.length > 0) {
    return sanitizeHierarchySelection(state.scene, state.hierarchySelectionIds);
  }

  return state.scene.selectedEntityId && state.scene.entities[state.scene.selectedEntityId]
    ? [state.scene.selectedEntityId]
    : [];
}

/** 过滤可被当前批量命令改写的实体，继承锁定的对象会被保护。 */
export function getUnlockedSelectionIds(state: EditorState, entityIds = getActiveHierarchySelectionIds(state)): string[] {
  return entityIds.filter((entityId) => {
    const entity = state.scene.entities[entityId];
    return Boolean(entity && !isEntityEffectivelyLocked(state.scene.entities, entity));
  });
}

/** 过滤批量复制、阵列和群组可处理的普通运行时实体。 */
export function getSelectedRuntimeEntityIds(state: EditorState): string[] {
  return getUnlockedSelectionIds(state).filter((entityId) => {
    const entity = state.scene.entities[entityId];
    return Boolean(entity && !entity.isFolder);
  });
}

/** 按右键目标推导粘贴父文件夹：文件夹内粘贴，对象则贴到同级。 */
export function resolvePasteParentId(scene: SceneDocument, targetFolderId: string | null | undefined): string | null {
  if (!targetFolderId) return null;
  const targetFolder = scene.entities[targetFolderId];
  return targetFolder?.isFolder ? targetFolder.id : null;
}

/** 从选区展开 Scene View 聚焦目标，文件夹会递归解析全部普通后代。 */
export function resolveSceneFocusEntityIds(scene: SceneDocument, entityIds: string[]): string[] {
  const resolvedIds: string[] = [];

  for (const entityId of getTopLevelHierarchyEntityIds(scene.entities, entityIds)) {
    const entity = scene.entities[entityId];
    if (!entity) continue;
    if (!entity.isFolder) {
      resolvedIds.push(entityId);
      continue;
    }

    for (const descendantId of collectEntitySubtreeIds(scene.entities, entityId, false)) {
      if (scene.entities[descendantId] && !scene.entities[descendantId].isFolder) {
        resolvedIds.push(descendantId);
      }
    }
  }

  return [...new Set(resolvedIds)];
}
