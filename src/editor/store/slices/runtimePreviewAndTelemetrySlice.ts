import { executeCommand } from '../../commands/CommandHistory';
import { updateAutoPatrolCommand, updateSceneDocumentCommand } from '../../commands/entityCommands';
import { createId } from '../../../shared/ids';
import type { AutoPatrolWaypoint } from '../../model/components';
import { sanitizeFetchConfig, sanitizeMqttConfig } from '../../model/SceneDocument';
import { AUTO_PATROL_MAX_WAYPOINTS, cloneAutoPatrolComponent, createAutoPatrolWaypointFromWorldPose, sanitizeAutoPatrolComponent, validateAutoPatrolRoute } from '../../model/autoPatrolInspection';
import { isMqttConfigEqual, validateRuntimePreviewConfig, type RuntimePreviewReadiness } from '../../model/mqttConfigUtils';
import { AUTO_PATROL_IDLE_PLAYBACK_SNAPSHOT } from './sceneSessionState';
import { prependLog, isRuntimePreviewState, guardRuntimePreviewMutation } from './editorMutationGuard';
import { getSelectedEntity, isRuntimeEntityEditable, sanitizeSelectedAutoPatrolWaypointId } from './selectionOperations';
import { areJsonValuesEqual } from './projectAssetRefresh';
import type { EditorSlice } from './editorStoreTypes';

/** 运行预检、遥测配置与巡检预览会话。 */
export const createRuntimePreviewAndTelemetrySlice: EditorSlice<
  "runtimeMode" |
  "runtimePerformanceEnabled" |
  "sceneModelStatistics" |
  "openingAnimationPreviewRequest" |
  "selectedAutoPatrolWaypointId" |
  "autoPatrolCameraRequest" |
  "autoPatrolPlaybackRequest" |
  "autoPatrolPlaybackSnapshot" |
  "trajectoryVisible" |
  "startRuntimePreview" |
  "stopRuntimePreview" |
  "setTrajectoryVisible" |
  "setSceneModelStatistics" |
  "requestOpeningAnimationPreview" |
  "consumeOpeningAnimationPreviewRequest" |
  "selectAutoPatrolWaypoint" |
  "requestAutoPatrolCapture" |
  "requestAutoPatrolFocus" |
  "consumeAutoPatrolCameraRequest" |
  "requestAutoPatrolPlayback" |
  "consumeAutoPatrolPlaybackRequest" |
  "setAutoPatrolPlaybackSnapshot" |
  "updateMqttConfig" |
  "updateFetchConfig"
> = (set, get) => ({
  runtimeMode: 'edit',
  runtimePerformanceEnabled: false,
  sceneModelStatistics: null,
  openingAnimationPreviewRequest: null,
  selectedAutoPatrolWaypointId: null,
  autoPatrolCameraRequest: null,
  autoPatrolPlaybackRequest: null,
  autoPatrolPlaybackSnapshot: AUTO_PATROL_IDLE_PLAYBACK_SNAPSHOT,
  trajectoryVisible: false,
  startRuntimePreview: (options) => {
    const currentState = get();
    if (currentState.lightingBakeRequest) {
      const readiness: RuntimePreviewReadiness = { ok: false, code: 'lighting-bake-active', message: '请等待材质与光照烘焙完成，或取消本次烘焙后再预览。' };
      set(state => ({ logs: prependLog(state.logs, readiness.message) }));
      return readiness;
    }
    if (currentState.environmentApplyRequest || currentState.environmentRuntimeSnapshot.phase === 'loading') {
      const readiness: RuntimePreviewReadiness = {
        ok: false,
        code: 'environment-load-active',
        message: '请等待环境模型加载完成。',
      };
      set((state) => ({ logs: prependLog(state.logs, `运行预览已阻止：${readiness.message}`) }));
      return readiness;
    }
    if (currentState.environmentStartupRelinkSessionId === currentState.sceneSessionId) {
      const readiness: RuntimePreviewReadiness = {
        ok: false,
        code: 'environment-relink-active',
        message: '请等待环境模型完成当前缓存重关联，或重新选择/清除环境模型。',
      };
      set((state) => ({ logs: prependLog(state.logs, `运行预览已阻止：${readiness.message}`) }));
      return readiness;
    }
    if (currentState.cadImportProgress?.active) {
      const readiness: RuntimePreviewReadiness = {
        ok: false,
        code: 'cad-import-active',
        message: '请等待 CAD 导入完成。',
      };
      set((state) => ({ logs: prependLog(state.logs, `运行预览已阻止：${readiness.message}`) }));
      return readiness;
    }

    const readiness = validateRuntimePreviewConfig(currentState.scene.mqttConfig, {
      electronMqttAvailable: typeof window !== 'undefined' && typeof window.editorApi?.mqttConfigure === 'function',
    });
    if (!readiness.ok) {
      set((state) => ({ logs: prependLog(state.logs, `运行预览预检失败：${readiness.message}`) }));
      return readiness;
    }

    set((state) => {
      if (state.runtimeMode === 'preview') return state;
      return {
        runtimeMode: 'preview',
        runtimePerformanceEnabled: options?.performance === true,
        // 进入运行态前清掉编辑态选区，避免遗留的选中高亮与预览内点击高亮叠加。
        scene: state.scene.selectedEntityId
          ? { ...state.scene, selectedEntityId: null }
          : state.scene,
        hierarchySelectionIds: [],
        environmentAdjustmentActive: false,
        cameraPoseSaveRequest: null,
        openingAnimationPreviewRequest: null,
        regionViewRequest: null,
        autoPatrolCameraRequest: null,
        selectedAutoPatrolWaypointId: null,
        logs: prependLog(state.logs, options?.performance === true ? '已进入性能运行，正在记录本次运行指标。' : '已进入运行预览模式。'),
      };
    });
    return readiness;
  },
  stopRuntimePreview: () => {
    set((state) => {
      if (state.runtimeMode === 'edit') return state;
      return {
        runtimeMode: 'edit',
        runtimePerformanceEnabled: false,
        logs: prependLog(state.logs, '已停止运行预览模式。'),
      };
    });
  },
  setTrajectoryVisible: (visible) => {
    set((state) => {
      if (state.trajectoryVisible === visible) return state;
      return {
        trajectoryVisible: visible,
        logs: prependLog(state.logs, visible ? '显示输送线货物轨迹。' : '隐藏输送线货物轨迹。'),
      };
    });
  },
  setSceneModelStatistics: (snapshot, expectedSceneSessionId) => {
    set((state) => {
      // 场景重开可能沿用同一文档 ID，必须同时校验会话以拒绝旧异步结果。
      if (state.sceneSessionId !== expectedSceneSessionId || (snapshot && snapshot.sceneId !== state.scene.id)) return state;
      const previous = state.sceneModelStatistics;
      if (previous === snapshot || (previous && snapshot
        && previous.sceneId === snapshot.sceneId && previous.phase === snapshot.phase
        && previous.modelTriangleCount === snapshot.modelTriangleCount
        && previous.environmentTriangleCount === snapshot.environmentTriangleCount)) return state;
      return { sceneModelStatistics: snapshot };
    });
  },
  requestOpeningAnimationPreview: action => {
    set(state => {
      if (action === 'play' && isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '预览开场动画');
      return { openingAnimationPreviewRequest: {
        requestId: createId('opening_preview'), sceneSessionId: state.sceneSessionId, action,
      } };
    });
  },
  consumeOpeningAnimationPreviewRequest: (requestId, sceneSessionId) => {
    set(state => {
      const request = state.openingAnimationPreviewRequest;
      if (!request || request.requestId !== requestId || request.sceneSessionId !== sceneSessionId
        || state.sceneSessionId !== sceneSessionId) return state;
      return { openingAnimationPreviewRequest: null };
    });
  },
  selectAutoPatrolWaypoint: (waypointId) => {
    set((state) => {
      const selectedEntity = getSelectedEntity(state);
      const autoPatrol = selectedEntity?.components.autoPatrol;
      const selectedAutoPatrolWaypointId = autoPatrol?.waypoints.some((waypoint) => waypoint.id === waypointId)
        ? waypointId
        : null;
      if (state.selectedAutoPatrolWaypointId === selectedAutoPatrolWaypointId) return state;
      return {
        selectedAutoPatrolWaypointId,
        transformTool: selectedAutoPatrolWaypointId && state.transformTool === 'scale' ? 'translate' : state.transformTool,
      };
    });
  },
  requestAutoPatrolCapture: () => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '录制巡检点位');
      if (state.autoPatrolPlaybackSnapshot.phase !== 'idle' && state.autoPatrolPlaybackSnapshot.phase !== 'completed') {
        return { logs: prependLog(state.logs, '巡检运行中不能录制点位，请先停止巡检。') };
      }
      const entity = getSelectedEntity(state);
      const autoPatrol = entity?.components.autoPatrol;
      if (!isRuntimeEntityEditable(state.scene, entity) || !autoPatrol) return state;
      const waypointId = sanitizeSelectedAutoPatrolWaypointId(state.scene, state.selectedAutoPatrolWaypointId);
      if (!waypointId && autoPatrol.waypoints.length >= AUTO_PATROL_MAX_WAYPOINTS) {
        return { logs: prependLog(state.logs, `单条巡检路线最多支持 ${AUTO_PATROL_MAX_WAYPOINTS} 个节点。`) };
      }
      return {
        autoPatrolCameraRequest: {
          id: createId('patrol_camera'),
          kind: 'capture',
          entityId: entity.id,
          waypointId,
        },
      };
    });
  },
  requestAutoPatrolFocus: (waypointId) => {
    set((state) => {
      const entity = getSelectedEntity(state);
      const autoPatrol = entity?.components.autoPatrol;
      if (!entity || !autoPatrol?.waypoints.some((waypoint) => waypoint.id === waypointId)) return state;
      return {
        selectedAutoPatrolWaypointId: waypointId,
        autoPatrolCameraRequest: { id: createId('patrol_camera'), kind: 'focus', entityId: entity.id, waypointId },
        autoPatrolPlaybackRequest: { id: createId('patrol_playback'), action: 'stop', routeId: null },
      };
    });
  },
  consumeAutoPatrolCameraRequest: (requestId, pose, captureError) => {
    set((state) => {
      const request = state.autoPatrolCameraRequest;
      if (!request || request.id !== requestId) return state;
      if (request.kind === 'focus') return { autoPatrolCameraRequest: null };
      if (captureError) {
        return {
          autoPatrolCameraRequest: null,
          logs: prependLog(state.logs, captureError),
        };
      }
      if (!pose) {
        return {
          autoPatrolCameraRequest: null,
          logs: prependLog(state.logs, 'Scene View 尚未就绪，无法录制巡检视角。'),
        };
      }
      const entity = state.scene.entities[request.entityId];
      const current = entity?.components.autoPatrol;
      if (!isRuntimeEntityEditable(state.scene, entity) || !current) {
        return { autoPatrolCameraRequest: null, selectedAutoPatrolWaypointId: null };
      }

      const before = cloneAutoPatrolComponent(current);
      // 录制保留当前取景；第一人称眼高只在播放切换视角时应用。
      const captured = createAutoPatrolWaypointFromWorldPose(
        pose,
        entity.components.transform,
        request.waypointId ?? undefined,
      );
      let selectedWaypointId = captured.id;
      let waypoints: AutoPatrolWaypoint[];
      const existingIndex = request.waypointId
        ? current.waypoints.findIndex((waypoint) => waypoint.id === request.waypointId)
        : -1;
      if (existingIndex >= 0) {
        const existing = current.waypoints[existingIndex];
        const replacement: AutoPatrolWaypoint = {
          ...captured,
          id: existing.id,
          travelDurationSeconds: existing.travelDurationSeconds,
          dwellSeconds: existing.dwellSeconds,
          arrivalActions: [...existing.arrivalActions],
        };
        waypoints = current.waypoints.map((waypoint, index) => index === existingIndex ? replacement : waypoint);
        selectedWaypointId = existing.id;
      } else {
        if (current.waypoints.length >= AUTO_PATROL_MAX_WAYPOINTS) {
          return {
            autoPatrolCameraRequest: null,
            logs: prependLog(state.logs, `单条巡检路线最多支持 ${AUTO_PATROL_MAX_WAYPOINTS} 个节点。`),
          };
        }
        waypoints = [...current.waypoints, captured];
        const previousWaypoint = current.waypoints.at(-1);
        if (previousWaypoint) {
          const proximityIssue = validateAutoPatrolRoute(
            { waypoints: [previousWaypoint, captured] },
            entity.components.transform,
          ).find((issue) => issue.code === 'waypoints-too-close');
          if (proximityIssue) {
            return {
              autoPatrolCameraRequest: null,
              logs: prependLog(state.logs, `无法添加点位：${proximityIssue.message}`),
            };
          }
        }
      }
      const after = sanitizeAutoPatrolComponent({ ...current, waypoints });
      if (!after) return { autoPatrolCameraRequest: null };
      const label = existingIndex >= 0 ? '覆盖巡检点位视角' : '添加巡检点位';
      const command = updateAutoPatrolCommand(entity.id, before, after, label);
      const result = executeCommand(state.scene, state.history, command);
      return {
        ...result,
        autoPatrolCameraRequest: null,
        autoPatrolPlaybackRequest: { id: createId('patrol_playback'), action: 'stop', routeId: null },
        selectedAutoPatrolWaypointId: selectedWaypointId,
        logs: prependLog(state.logs, `${label}：节点 ${after.waypoints.findIndex((waypoint) => waypoint.id === selectedWaypointId) + 1}`),
      };
    });
  },
  requestAutoPatrolPlayback: (action, routeId, payload) => {
    set((state) => {
      let resolvedRouteId = routeId ?? null;
      if (action === 'start' && !resolvedRouteId) {
        const selected = getSelectedEntity(state);
        resolvedRouteId = selected?.components.autoPatrol ? selected.id : null;
      }
      if (action === 'start') {
        const component = resolvedRouteId ? state.scene.entities[resolvedRouteId]?.components.autoPatrol : null;
        if (!component?.enabled) return { logs: prependLog(state.logs, '巡检路线未启用，无法开始。') };
        if (component.waypoints.length < 2) return { logs: prependLog(state.logs, '巡检路线至少需要两个节点。') };
      }
      return {
        autoPatrolPlaybackRequest: {
          id: createId('patrol_playback'),
          action,
          routeId: resolvedRouteId,
          payload,
        },
      };
    });
  },
  consumeAutoPatrolPlaybackRequest: (requestId) => {
    set((state) => state.autoPatrolPlaybackRequest?.id === requestId
      ? { autoPatrolPlaybackRequest: null }
      : state);
  },
  setAutoPatrolPlaybackSnapshot: (snapshot) => {
    set((state) => areJsonValuesEqual(state.autoPatrolPlaybackSnapshot, snapshot)
      ? state
      : { autoPatrolPlaybackSnapshot: snapshot });
  },
  updateMqttConfig: (config) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '保存 MQTT 配置');
      const mqttConfig = sanitizeMqttConfig(config);
      if (isMqttConfigEqual(state.scene.mqttConfig, mqttConfig)) {
        return state;
      }

      const command = updateSceneDocumentCommand('更新 MQTT 配置', (scene) => ({
        ...scene,
        mqttConfig,
      }));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(
          state.logs,
          `MQTT 配置已保存：${mqttConfig.simulatorEnabled ? `本地模拟 ${mqttConfig.simulatorAssetCode}/${mqttConfig.simulatorScenario}` : mqttConfig.address || '未设置地址'}，Topic ${mqttConfig.topic}，${mqttConfig.enabled ? '已启用' : '未启用'}`,
        ),
      };
    });
  },
  updateFetchConfig: (config) => {
    set((state) => {
      if (isRuntimePreviewState(state)) return guardRuntimePreviewMutation(state, '保存 Fetch 配置');
      const fetchConfig = sanitizeFetchConfig(config);
      const command = updateSceneDocumentCommand('更新 Fetch 配置', (scene) => ({
        ...scene,
        fetchConfig,
      }));
      const result = executeCommand(state.scene, state.history, command);

      return {
        ...result,
        logs: prependLog(
          state.logs,
          `Fetch 配置已保存：${fetchConfig.url || '未设置地址'}，同步间隔 ${fetchConfig.syncIntervalSeconds > 0 ? `${fetchConfig.syncIntervalSeconds}秒` : '仅预览时同步一次'}`,
        ),
      };
    });
  },
});
