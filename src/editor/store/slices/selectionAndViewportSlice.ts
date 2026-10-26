import { updateSceneRegionViewsCommand } from '../../commands/sceneRegionViewCommands';
import { MAX_SCENE_REGION_VIEWS, normalizeSceneRegionViews, updateRegionView, validateRegionViewName } from '../../model/sceneRegionViews';
import { executeCommand } from '../../commands/CommandHistory';
import { DEFAULT_EDITOR_GRID_SETTINGS } from '../../../runtime/babylon/createEngine';
import { createId } from '../../../shared/ids';
import { resolveLightTransformTool } from '../../model/lightEditor';
import { STANDARD_CAMERA_VIEW_LABELS } from '../../model/cameraOrientation';
import { isHierarchyGroupTransformSelection, resolveHierarchyGroupTransformSelection } from '../../model/entityHierarchy';
import { sanitizeSceneSensitivityValue, sanitizeSceneViewDistance } from '../../model/SceneDocument';
import { containsManualRoamSpawnEntity } from '../../model/manualRoamSpawn';
import { DEFAULT_SNAP_SETTINGS, getSelectedEntity, areSelectedModelMeasurementsEqual, areSelectedGroupSpatialInfosEqual, resolveSelectionTransformMode, sanitizeHierarchySelection, resolveSceneFocusEntityIds, getActiveHierarchySelectionIds } from './selectionOperations';
import { isRuntimePreviewState, guardRuntimePreviewMutation, prependLog } from './editorMutationGuard';
import { sanitizePositiveNumber, sanitizeGridCellSize } from './entityValueOperations';
import type { EditorSlice } from './editorStoreTypes';

/** 选区、视口工具与相机请求的编辑会话状态。 */
export const createSelectionAndViewportSlice: EditorSlice<
  "hierarchySelectionIds" |
  "sceneFocusRequest" |
  "projectAssetFocusRequest" |
  "revealHierarchyEntityRequest" |
  "cameraPoseSaveRequest" |
  "regionViewRequest" |
  "regionViewMessage" |
  "cameraResetRequest" |
  "cameraOrientation" |
  "cameraProjection" |
  "selectedModelMeasurement" |
  "selectedGroupSpatialInfo" |
  "groupInspectorTransformRequest" |
  "transformTool" |
  "transformSpace" |
  "groupTransformModeRestore" |
  "snapSettings" |
  "gridSettings" |
  "setTransformTool" |
  "setTransformSpace" |
  "setSnapEnabled" |
  "updateSnapSetting" |
  "setGridVisible" |
  "setGridCellSize" |
  "setCameraViewDistance" |
  "updateSensitivitySetting" |
  "requestRegionView" |
  "consumeRegionViewRequest" |
  "renameRegionView" |
  "moveRegionView" |
  "reorderRegionView" |
  "deleteRegionView" |
  "requestCameraPoseSave" |
  "consumeCameraPoseSaveRequest" |
  "requestCameraReset" |
  "consumeCameraResetRequest" |
  "setCameraOrientation" |
  "toggleCameraStandardView" |
  "setCameraProjection" |
  "setSelectedModelMeasurement" |
  "setSelectedGroupSpatialInfo" |
  "requestSelectedGroupTransform" |
  "consumeGroupInspectorTransformRequest" |
  "selectEntity" |
  "selectHierarchyEntities" |
  "requestSceneFocusForSelection" |
  "requestProjectAssetFocusForEntity" |
  "consumeSceneFocusRequest" |
  "requestRevealHierarchyEntity" |
  "consumeRevealHierarchyEntityRequest" |
  "consumeProjectAssetFocusRequest"
> = (set, get) => ({
  hierarchySelectionIds: [],
  sceneFocusRequest: null,
  projectAssetFocusRequest: null,
  revealHierarchyEntityRequest: null,
  cameraPoseSaveRequest: null,
  regionViewRequest: null,
  regionViewMessage: null,
  cameraResetRequest: null,
  cameraOrientation: 'orbit',
  cameraProjection: 'perspective',
  selectedModelMeasurement: null,
  selectedGroupSpatialInfo: null,
  groupInspectorTransformRequest: null,
  transformTool: 'translate',
  transformSpace: 'local',
  groupTransformModeRestore: null,
  snapSettings: DEFAULT_SNAP_SETTINGS,
  gridSettings: DEFAULT_EDITOR_GRID_SETTINGS,
  setTransformTool: (tool) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换变换工具');
      if (isHierarchyGroupTransformSelection(state.scene, state.hierarchySelectionIds)) {
        const resolvedTool = tool === 'rotate' ? 'rotate' : 'translate';
        if (tool === 'scale') {
          return {
            transformTool: resolvedTool,
            transformSpace: 'global',
            logs: prependLog(state.logs, '选区群组不支持缩放，已切回世界坐标移动工具。'),
          };
        }
        if (state.transformTool === resolvedTool && state.transformSpace === 'global') return state;
        return {
          transformTool: resolvedTool,
          transformSpace: 'global',
          logs: prependLog(state.logs, `切换群组工具：${resolvedTool}`),
        };
      }

      const selectedEntity = getSelectedEntity(state);
      const selectedLightKind = selectedEntity?.components.light?.lightKind;
      const patrolScaleUnsupported = Boolean(selectedEntity?.components.autoPatrol && tool === 'scale');
      const resolvedTool = patrolScaleUnsupported
        ? 'translate'
        : selectedLightKind
          ? resolveLightTransformTool(selectedLightKind, tool)
          : tool;
      if ((selectedLightKind || patrolScaleUnsupported) && resolvedTool !== tool) {
        return {
          transformTool: resolvedTool,
          logs: prependLog(
            state.logs,
            patrolScaleUnsupported
              ? '自动巡检不支持缩放，已切回移动工具。'
              : `${selectedLightKind} 灯光不支持 ${tool}，已切回移动工具。`,
          ),
        };
      }
      if (state.transformTool === resolvedTool) return state;

      return {
        transformTool: resolvedTool,
        logs: prependLog(state.logs, `切换工具：${resolvedTool}`),
      };
    });
  },
  setTransformSpace: (space) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换坐标空间');
      if (isHierarchyGroupTransformSelection(state.scene, state.hierarchySelectionIds) && space !== 'global') {
        return {
          transformTool: state.transformTool === 'scale' ? 'translate' : state.transformTool,
          transformSpace: 'global',
          logs: prependLog(state.logs, '选区群组移动和旋转仅支持世界坐标，已忽略局部坐标切换。'),
        };
      }
      if (state.transformSpace === space) return state;

      return {
        transformSpace: space,
        logs: prependLog(state.logs, `切换坐标空间：${space}`),
      };
    });
  },
  setSnapEnabled: (enabled) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '切换吸附');
      if (state.snapSettings.enabled === enabled) return state;

      return {
        snapSettings: {
          ...state.snapSettings,
          enabled,
        },
        logs: prependLog(state.logs, enabled ? '开启 Gizmo 吸附。' : '关闭 Gizmo 吸附。'),
      };
    });
  },
  updateSnapSetting: (key, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改吸附参数');
      const nextValue = sanitizePositiveNumber(value, DEFAULT_SNAP_SETTINGS[key]);
      if (state.snapSettings[key] === nextValue) return state;

      return {
        snapSettings: {
          ...state.snapSettings,
          [key]: nextValue,
        },
      };
    });
  },
  setGridVisible: (visible) => {
    set((state) => {
      if (state.gridSettings.visible === visible) return state;

      return {
        gridSettings: {
          ...state.gridSettings,
          visible,
        },
        logs: prependLog(state.logs, visible ? '显示地面网格。' : '隐藏地面网格。'),
      };
    });
  },
  setGridCellSize: (cellSizeMeters) => {
    set((state) => {
      const nextCellSizeMeters = sanitizeGridCellSize(cellSizeMeters);
      if (state.gridSettings.cellSizeMeters === nextCellSizeMeters) return state;

      return {
        gridSettings: {
          ...state.gridSettings,
          cellSizeMeters: nextCellSizeMeters,
        },
        logs: prependLog(state.logs, `网格格子大小：${nextCellSizeMeters} m。`),
      };
    });
  },
  setCameraViewDistance: (viewDistance) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改相机距离');
      const nextViewDistance = sanitizeSceneViewDistance(viewDistance);
      if (state.scene.sceneSettings.camera.viewDistance === nextViewDistance) return state;

      return {
        scene: {
          ...state.scene,
          sceneSettings: {
            ...state.scene.sceneSettings,
            camera: {
              ...state.scene.sceneSettings.camera,
              viewDistance: nextViewDistance,
            },
          },
        },
      };
    });
  },
  updateSensitivitySetting: (key, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改相机灵敏度');
      const nextValue = sanitizeSceneSensitivityValue(value);
      if (state.scene.sceneSettings.sensitivity[key] === nextValue) return state;

      return {
        scene: {
          ...state.scene,
          sceneSettings: {
            ...state.scene.sceneSettings,
            sensitivity: {
              ...state.scene.sceneSettings.sensitivity,
              [key]: nextValue,
            },
          },
        },
      };
    });
  },
  requestRegionView: (kind, name, regionViewId) => {
    set(state => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '区域视角');
      const views = state.scene.sceneSettings.regionViews;
      const target = regionViewId ? views.find(view => view.id === regionViewId) : undefined;
      const error = regionViewId && !target ? '区域视角不存在，可能已被删除'
        : kind === 'apply' && !target ? '请选择要定位的区域视角'
        : kind === 'save' && !regionViewId ? validateRegionViewName(name, views)
        || (views.length >= MAX_SCENE_REGION_VIEWS ? `最多保存 ${MAX_SCENE_REGION_VIEWS} 个区域视角` : null) : null;
      if (error) return { regionViewMessage: error };
      return { regionViewRequest: { id: createId('region_view_request'), sceneSessionId: state.sceneSessionId,
        kind, name: name.trim(), regionViewId }, regionViewMessage: null };
    });
  },
  consumeRegionViewRequest: (requestId, camera, captureError) => {
    set(state => {
      const request = state.regionViewRequest;
      if (!request || request.id !== requestId || request.sceneSessionId !== state.sceneSessionId) return state;
      const base = { regionViewRequest: null };
      if (isRuntimePreviewState(state)) return { ...base, regionViewMessage: '运行预览只读，已取消区域视角操作' };
      if (captureError) return { ...base, regionViewMessage: captureError, logs: prependLog(state.logs, captureError) };
      const views = state.scene.sceneSettings.regionViews;
      const target = request.regionViewId ? views.find(view => view.id === request.regionViewId) : undefined;
      if (request.regionViewId && !target) return { ...base, regionViewMessage: '区域视角已删除，操作已取消' };
      if (request.kind === 'apply' && target) return {
        ...base, cameraOrientation: target.camera.savedOrientation, cameraProjection: target.camera.savedProjection,
        regionViewMessage: `已定位：${target.name}`,
      };
      try {
        if (!camera) throw new Error('无法读取当前相机视角');
        const next = target ? updateRegionView(views, target.id, { camera })
          : normalizeSceneRegionViews([...views, { id: createId('region_view'), name: request.name, camera }]).views;
        if (!target && next.length !== views.length + 1) throw new Error('保存失败：名称重复、数量超限或相机数据无效');
        const label = `${target ? '更新' : '保存'}区域视角：${target?.name ?? request.name}`;
        const result = executeCommand(state.scene, state.history, updateSceneRegionViewsCommand(views, next, label));
        return { ...base, ...result, regionViewMessage: label, logs: prependLog(state.logs, label) };
      } catch (error) {
        const message = error instanceof Error ? error.message : '区域视角保存失败';
        return { ...base, regionViewMessage: message, logs: prependLog(state.logs, message) };
      }
    });
  },
  renameRegionView: (id, name) => {
    set(state => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '重命名区域视角');
      const views = state.scene.sceneSettings.regionViews;
      const error = validateRegionViewName(name, views, id);
      if (error) return { regionViewMessage: error };
      if (views.find(view => view.id === id)?.name === name.trim()) return state;
      try {
        const next = updateRegionView(views, id, { name: name.trim() });
        return { ...executeCommand(state.scene, state.history, updateSceneRegionViewsCommand(views, next, '重命名区域视角')),
          regionViewMessage: `已重命名：${name.trim()}` };
      } catch (error) { return { regionViewMessage: error instanceof Error ? error.message : '重命名失败' }; }
    });
  },
  moveRegionView: (id, direction) => {
    const views = get().scene.sceneSettings.regionViews;
    const index = views.findIndex(view => view.id === id);
    const target = views[index + (direction === 'up' ? -1 : 1)];
    if (index < 0 || !target) return;
    get().reorderRegionView(id, target.id, direction === 'up' ? 'before' : 'after');
  },
  reorderRegionView: (id, targetId, position) => {
    set(state => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '调整区域视角顺序');
      if (state.regionViewRequest) return state;
      const views = state.scene.sceneSettings.regionViews;
      const index = views.findIndex(view => view.id === id);
      const targetIndex = views.findIndex(view => view.id === targetId);
      if (index < 0 || targetIndex < 0 || index === targetIndex) return state;
      const insertionIndex = targetIndex + (position === 'after' ? 1 : 0) - (index < targetIndex ? 1 : 0);
      if (insertionIndex === index) return state;
      const next = [...views];
      next.splice(index, 1);
      next.splice(insertionIndex, 0, views[index]);
      const label = `调整区域视角顺序：${views[index].name}`;
      return { ...executeCommand(state.scene, state.history, updateSceneRegionViewsCommand(views, next, label)),
        regionViewMessage: `${label}，请保存场景` };
    });
  },
  deleteRegionView: id => {
    set(state => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '删除区域视角');
      const views = state.scene.sceneSettings.regionViews;
      if (!views.some(view => view.id === id)) return state;
      return { ...executeCommand(state.scene, state.history, updateSceneRegionViewsCommand(views, views.filter(view => view.id !== id), '删除区域视角')),
        regionViewMessage: '区域视角已删除，可撤销恢复' };
    });
  },
  requestCameraPoseSave: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '保存当前视角');
      return {
        cameraPoseSaveRequest: {
          id: createId('camera_pose_save'),
          orientation: state.cameraOrientation,
          projection: state.cameraProjection,
        },
        logs: prependLog(state.logs, '准备保存当前视角。'),
      };
    });
  },
  consumeCameraPoseSaveRequest: (requestId, pose) => {
    set((state) => {
      const request = state.cameraPoseSaveRequest;
      if (request?.id !== requestId) return state;
      if (isRuntimePreviewState(state)) {
        return {
          cameraPoseSaveRequest: null,
          logs: prependLog(state.logs, '运行预览只读：已取消待保存的相机位姿。'),
        };
      }

      return {
        cameraPoseSaveRequest: null,
        scene: {
          ...state.scene,
          sceneSettings: {
            ...state.scene.sceneSettings,
            camera: {
              ...state.scene.sceneSettings.camera,
              savedPose: pose,
              savedOrientation: request.orientation,
              savedProjection: request.projection,
            },
          },
        },
        logs: prependLog(state.logs, '当前视角已保存。'),
      };
    });
  },
  requestCameraReset: () => {
    set((state) => ({
      cameraResetRequest: { id: createId('camera_reset') },
      cameraOrientation: state.scene.sceneSettings.camera.savedOrientation,
      cameraProjection: state.scene.sceneSettings.camera.savedProjection,
      logs: prependLog(state.logs, '准备复位视角。'),
    }));
  },
  consumeCameraResetRequest: (requestId) => {
    set((state) => {
      if (state.cameraResetRequest?.id !== requestId) return state;

      return {
        cameraResetRequest: null,
        logs: prependLog(state.logs, '视角已复位。'),
      };
    });
  },
  /** 切换编辑器视口朝向；只有显式“保存当前视角”才会把当前值写入场景文档。 */
  setCameraOrientation: (orientation) => {
    set((state) => {
      if (state.cameraOrientation === orientation) return state;
      const message = orientation === 'orbit'
        ? '已退出标准视角硬锁。'
        : `已进入${STANDARD_CAMERA_VIEW_LABELS[orientation].chinese}硬锁。`;
      return { cameraOrientation: orientation, logs: prependLog(state.logs, message) };
    });
  },
  /** 点击标准面时原子切换硬锁并强制正交；再次点击当前面只退出硬锁，保留投影。 */
  toggleCameraStandardView: (orientation) => {
    set((state) => {
      const label = STANDARD_CAMERA_VIEW_LABELS[orientation].chinese;
      if (state.cameraOrientation === orientation) {
        return {
          cameraOrientation: 'orbit',
          logs: prependLog(state.logs, `已退出${label}硬锁。`),
        };
      }
      return {
        cameraOrientation: orientation,
        cameraProjection: 'orthographic',
        logs: prependLog(state.logs, `已进入${label}硬锁并切换为正交投影。`),
      };
    });
  },
  /** 切换编辑器视口投影；普通切换只影响会话，显式保存视角后才持久化。 */
  setCameraProjection: (projection) => {
    set((state) => {
      if (state.cameraProjection === projection) return state;
      return {
        cameraProjection: projection,
        logs: prependLog(state.logs, projection === 'orthographic' ? '已切换为正交投影。' : '已切换为透视投影。'),
      };
    });
  },
  setSelectedModelMeasurement: (measurement) => {
    set((state) => {
      if (measurement && state.scene.selectedEntityId !== measurement.entityId) return state;
      if (areSelectedModelMeasurementsEqual(state.selectedModelMeasurement, measurement)) return state;
      return { selectedModelMeasurement: measurement };
    });
  },
  setSelectedGroupSpatialInfo: (info) => {
    set((state) => {
      if (areSelectedGroupSpatialInfosEqual(state.selectedGroupSpatialInfo, info)) return state;
      return { selectedGroupSpatialInfo: info };
    });
  },
  requestSelectedGroupTransform: (field, axis, value) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '修改群组空间信息');
      if (!Number.isFinite(value)) return state;

      const selection = resolveHierarchyGroupTransformSelection(state.scene, state.hierarchySelectionIds);
      if (selection.status !== 'ready') {
        const message = selection.status === 'blocked'
          ? '群组空间信息修改已阻止：选区内包含锁定对象。'
          : selection.status === 'empty'
            ? '群组空间信息修改已取消：群组内没有可变换对象。'
            : '群组空间信息修改已取消：当前不再是群组选区。';
        return { logs: prependLog(state.logs, message) };
      }
      if (
        field === 'rotation'
        && axis !== 'y'
        && containsManualRoamSpawnEntity(state.scene, selection.entityIds)
      ) {
        return {
          groupInspectorTransformRequest: null,
          logs: prependLog(state.logs, '含手动漫游初始位置的群组仅允许绕 Y 轴旋转。'),
        };
      }

      return {
        groupInspectorTransformRequest: {
          id: createId('group_inspector_transform'),
          groupId: selection.groupId,
          field,
          axis,
          value,
        },
      };
    });
  },
  consumeGroupInspectorTransformRequest: (requestId) => {
    set((state) => state.groupInspectorTransformRequest?.id === requestId
      ? { groupInspectorTransformRequest: null }
      : state);
  },
  selectEntity: (entityId) => {
    set((state) => {
      const selectedEntityId = entityId && state.scene.entities[entityId] ? entityId : null;
      const scene = {
        ...state.scene,
        selectedEntityId,
      };
      const hierarchySelectionIds = selectedEntityId ? [selectedEntityId] : [];
      return {
        scene,
        hierarchySelectionIds,
        selectedModelMeasurement: null,
        selectedAutoPatrolWaypointId: null,
        ...resolveSelectionTransformMode(state, scene, hierarchySelectionIds),
      };
    });
  },
  selectHierarchyEntities: (entityIds, primaryEntityId) => {
    set((state) => {
      const hierarchySelectionIds = sanitizeHierarchySelection(state.scene, entityIds);
      const selectedEntityId = primaryEntityId && hierarchySelectionIds.includes(primaryEntityId)
        ? primaryEntityId
        : hierarchySelectionIds[hierarchySelectionIds.length - 1] ?? null;

      const scene = {
        ...state.scene,
        selectedEntityId,
      };
      return {
        scene,
        hierarchySelectionIds,
        selectedModelMeasurement: null,
        selectedAutoPatrolWaypointId: null,
        ...resolveSelectionTransformMode(state, scene, hierarchySelectionIds),
      };
    });
  },
  requestSceneFocusForSelection: (entityIds, transition) => {
    set((state) => {
      const focusIds = resolveSceneFocusEntityIds(
        state.scene,
        entityIds ?? getActiveHierarchySelectionIds(state),
      );
      if (focusIds.length === 0) return state;

      return {
        sceneFocusRequest: {
          id: createId('scene_focus'),
          entityIds: focusIds,
          ...(transition ? { transition } : {}),
        },
        logs: prependLog(state.logs, `场景聚焦: ${focusIds.length} 个对象`),
      };
    });
  },
  requestProjectAssetFocusForEntity: (entityId) => {
    set((state) => {
      const entity = entityId ? state.scene.entities[entityId] : getSelectedEntity(state);
      const modelAsset = entity?.components.modelAsset;
      if (!entity || !modelAsset) {
        return { logs: prependLog(state.logs, '库聚焦仅支持导入模型。') };
      }

      return {
        projectAssetFocusRequest: {
          id: createId('asset_focus'),
          sourcePath: modelAsset.sourcePath,
          sourceUrl: modelAsset.sourceUrl,
          entityName: entity.name,
        },
        logs: prependLog(state.logs, `库聚焦: ${entity.name}`),
      };
    });
  },
  consumeSceneFocusRequest: (requestId) => {
    set((state) => {
      if (state.sceneFocusRequest?.id !== requestId) return state;
      return { sceneFocusRequest: null };
    });
  },
  requestRevealHierarchyEntity: (entityId) => {
    set((state) => {
      if (!state.scene.entities[entityId]) return state;
      return {
        revealHierarchyEntityRequest: {
          id: createId('reveal_hierarchy'),
          entityId,
        },
      };
    });
  },
  consumeRevealHierarchyEntityRequest: (requestId) => {
    set((state) => {
      if (state.revealHierarchyEntityRequest?.id !== requestId) return state;
      return { revealHierarchyEntityRequest: null };
    });
  },
  consumeProjectAssetFocusRequest: (requestId) => {
    set((state) => {
      if (state.projectAssetFocusRequest?.id !== requestId) return state;
      return { projectAssetFocusRequest: null };
    });
  },
});
