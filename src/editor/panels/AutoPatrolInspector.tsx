import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import type {
  AutoPatrolCameraConfig,
  AutoPatrolComponent,
  AutoPatrolEventDefinition,
  AutoPatrolEventResponse,
  AutoPatrolEventTrigger,
  AutoPatrolPathType,
  AutoPatrolPlaybackMode,
  AutoPatrolTriggerRegion,
  AutoPatrolTriggerRegionShape,
  AutoPatrolWaypoint,
  TransformComponent,
} from '../model/components';
import {
  AUTO_PATROL_BUSINESS_DATA_MAX_STRING_LENGTH,
  AUTO_PATROL_MAX_SPEED_METERS_PER_SECOND,
  AUTO_PATROL_MAX_DURATION_SECONDS,
  AUTO_PATROL_MAX_VIEW_DISTANCE,
  AUTO_PATROL_MAX_WAYPOINTS,
  AUTO_PATROL_MIN_SPEED_METERS_PER_SECOND,
  AUTO_PATROL_MIN_VIEW_DISTANCE,
  AUTO_PATROL_ROUTE_JSON_MAX_BYTES,
  createDefaultAutoPatrolEvent,
  createDefaultAutoPatrolTriggerRegion,
  duplicateAutoPatrolWaypoint,
  getAutoPatrolWaypointView,
  importAutoPatrolRouteJson,
  moveAutoPatrolWaypoint,
  resolveAutoPatrolComponent,
  serializeAutoPatrolRouteJson,
  updateAutoPatrolWaypointView,
  validateAutoPatrolRoute,
} from '../model/autoPatrolInspection';
import { useEditorStore } from '../store/editorStore';

const POSITION_AXES = ['x', 'y', 'z'] as const;
const EVENT_RESPONSES: Array<{ value: AutoPatrolEventResponse; label: string }> = [
  { value: 'panel', label: '信息面板' },
  { value: 'highlight', label: '设备高亮' },
  { value: 'screenshot', label: '截图' },
  { value: 'pause', label: '暂停巡检' },
  { value: 'report', label: '实时上报' },
];

type AutoPatrolInspectorProps = {
  component: AutoPatrolComponent;
  entityId: string;
  transform: TransformComponent;
  disabled?: boolean;
};

type WaypointViewField = 'headingDegrees' | 'pitchDegrees' | 'viewDistance';

/** Inspector 数值统一截断小数噪声，保持 Gizmo 和表单往返时可读。 */
function formatNumber(value: number, digits = 3): number {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function sanitizeFileName(value: string): string {
  const sanitized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
  return sanitized || 'auto-patrol-route';
}

/** 自动巡检路线属性、播放控制和节点摘要编辑器。 */
export function AutoPatrolInspector({
  component,
  entityId,
  transform,
  disabled = false,
}: AutoPatrolInspectorProps) {
  const resolved = useMemo(() => resolveAutoPatrolComponent(component), [component]);
  const selectedWaypointId = useEditorStore((state) => state.selectedAutoPatrolWaypointId);
  const playbackSnapshot = useEditorStore((state) => state.autoPatrolPlaybackSnapshot);
  const scene = useEditorStore((state) => state.scene);
  const selectWaypoint = useEditorStore((state) => state.selectAutoPatrolWaypoint);
  const requestCapture = useEditorStore((state) => state.requestAutoPatrolCapture);
  const requestFocus = useEditorStore((state) => state.requestAutoPatrolFocus);
  const requestPlayback = useEditorStore((state) => state.requestAutoPatrolPlayback);
  const renameSelectedEntity = useEditorStore((state) => state.renameSelectedEntity);
  const updatePatrol = useEditorStore((state) => state.updateSelectedAutoPatrol);
  const [draggedWaypointId, setDraggedWaypointId] = useState<string | null>(null);
  const [routeFileMessage, setRouteFileMessage] = useState<string | null>(null);
  const routeFileInputRef = useRef<HTMLInputElement>(null);

  const entityName = scene.entities[entityId]?.name ?? '自动巡检路线';
  const targetEntities = useMemo(
    () => scene.entityIds
      .map((id) => scene.entities[id])
      .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity) && entity?.id !== entityId),
    [entityId, scene.entities, scene.entityIds],
  );
  const activeForRoute = playbackSnapshot.routeId === entityId;
  const isPlaying = activeForRoute && (playbackSnapshot.phase === 'moving' || playbackSnapshot.phase === 'dwelling');
  const isPaused = activeForRoute && playbackSnapshot.phase === 'paused';
  const canStop = activeForRoute && playbackSnapshot.phase !== 'idle';
  const selectedWaypoint = component.waypoints.find((waypoint) => waypoint.id === selectedWaypointId) ?? null;
  const routeIssues = useMemo(
    () => validateAutoPatrolRoute(component, transform),
    [component, transform],
  );

  function commit(next: AutoPatrolComponent, label: string): void {
    if (disabled) return;
    updatePatrol(next, label);
  }

  function handleEnabledChange(event: ChangeEvent<HTMLInputElement>): void {
    commit({ ...component, enabled: event.target.checked }, '切换自动巡检启用状态');
  }

  function handleAutoStartChange(event: ChangeEvent<HTMLInputElement>): void {
    commit({ ...component, autoStart: event.target.checked }, '切换自动启动巡检');
  }

  function handleDefaultRouteChange(event: ChangeEvent<HTMLInputElement>): void {
    commit({ ...component, isDefault: event.target.checked }, '设置默认巡检路线');
  }

  function handleTagsChange(event: ChangeEvent<HTMLInputElement>): void {
    const tags = event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    commit({ ...component, tags }, '更新巡检路线标签');
  }

  function handleRouteSpeedChange(rawValue: string): void {
    if (rawValue === '') return;
    const speed = clampNumber(
      Number(rawValue),
      AUTO_PATROL_MIN_SPEED_METERS_PER_SECOND,
      AUTO_PATROL_MAX_SPEED_METERS_PER_SECOND,
      resolved.speedMetersPerSecond,
    );
    commit({ ...component, speedMetersPerSecond: speed }, '更新巡检路线速度');
  }

  function handleCameraConfigChange(field: keyof AutoPatrolCameraConfig, rawValue: string): void {
    if (rawValue === '') return;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return;
    commit({
      ...component,
      camera: { ...resolved.camera, [field]: value },
    }, '更新巡检视角参数');
  }

  function handlePathTypeChange(event: ChangeEvent<HTMLSelectElement>): void {
    commit({ ...component, pathType: event.target.value as AutoPatrolPathType }, '切换巡检路径类型');
  }

  function handlePlaybackModeChange(event: ChangeEvent<HTMLSelectElement>): void {
    commit({ ...component, playbackMode: event.target.value as AutoPatrolPlaybackMode }, '切换巡检循环模式');
  }

  function handleAddWaypoint(): void {
    if (disabled || component.waypoints.length >= AUTO_PATROL_MAX_WAYPOINTS) return;
    selectWaypoint(null);
    requestCapture();
  }

  function handleDeleteWaypoint(waypointId: string): void {
    if (disabled) return;
    const deletedEventIds = new Set(resolved.events.filter((event) => (
      (event.trigger.kind === 'waypoint' || event.trigger.kind === 'distance')
      && event.trigger.waypointId === waypointId
    )).map((event) => event.id));
    commit({
      ...component,
      waypoints: component.waypoints
        .filter((waypoint) => waypoint.id !== waypointId)
        .map((waypoint) => ({
          ...waypoint,
          arrivalActions: waypoint.arrivalActions.filter((actionId) => !deletedEventIds.has(actionId)),
        })),
      events: resolved.events.filter((event) => !(
        (event.trigger.kind === 'waypoint' || event.trigger.kind === 'distance')
        && event.trigger.waypointId === waypointId
      )),
    }, '删除巡检点位');
  }

  function handleDuplicateWaypoint(waypointId: string): void {
    if (disabled || component.waypoints.length >= AUTO_PATROL_MAX_WAYPOINTS) return;
    const next = duplicateAutoPatrolWaypoint(component, waypointId);
    const sourceIndex = component.waypoints.findIndex((waypoint) => waypoint.id === waypointId);
    const duplicatedId = next.waypoints[sourceIndex + 1]?.id ?? null;
    commit(next, '复制巡检点位');
    if (duplicatedId) selectWaypoint(duplicatedId);
  }

  function moveWaypoint(waypointId: string, destinationIndex: number): void {
    if (disabled) return;
    commit(moveAutoPatrolWaypoint(component, waypointId, destinationIndex), '调整巡检点位顺序');
    selectWaypoint(waypointId);
  }

  function handleWaypointDragStart(event: DragEvent<HTMLDivElement>, waypointId: string): void {
    if (disabled) return;
    setDraggedWaypointId(waypointId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', waypointId);
  }

  function handleWaypointDrop(event: DragEvent<HTMLDivElement>, destinationIndex: number): void {
    if (disabled) return;
    event.preventDefault();
    const waypointId = draggedWaypointId || event.dataTransfer.getData('text/plain');
    setDraggedWaypointId(null);
    if (waypointId) moveWaypoint(waypointId, destinationIndex);
  }

  function updateWaypoint(waypointId: string, updater: (waypoint: AutoPatrolWaypoint) => AutoPatrolWaypoint, label: string): void {
    const waypointIndex = component.waypoints.findIndex((waypoint) => waypoint.id === waypointId);
    if (waypointIndex < 0) return;
    commit({
      ...component,
      waypoints: component.waypoints.map((waypoint, index) => index === waypointIndex ? updater(waypoint) : waypoint),
    }, label);
  }

  function handleWaypointPositionChange(waypoint: AutoPatrolWaypoint, axis: typeof POSITION_AXES[number], rawValue: string): void {
    if (rawValue === '') return;
    const current = getAutoPatrolWaypointView(waypoint, transform);
    const nextValue = Number(rawValue);
    if (!Number.isFinite(nextValue)) return;
    updateWaypoint(waypoint.id, (item) => updateAutoPatrolWaypointView(item, transform, {
      position: { ...current.position, [axis]: nextValue },
    }), '更新巡检点位位置');
  }

  function handleWaypointViewChange(waypoint: AutoPatrolWaypoint, field: WaypointViewField, rawValue: string): void {
    if (rawValue === '') return;
    const nextValue = Number(rawValue);
    if (!Number.isFinite(nextValue)) return;
    updateWaypoint(waypoint.id, (item) => updateAutoPatrolWaypointView(item, transform, {
      [field]: nextValue,
    }), field === 'viewDistance' ? '更新巡检观察距离' : '更新巡检观察方向');
  }

  function handleWaypointDurationChange(
    waypoint: AutoPatrolWaypoint,
    field: 'travelDurationSeconds' | 'dwellSeconds',
    rawValue: string,
  ): void {
    if (rawValue === '') return;
    const nextValue = clampNumber(Number(rawValue), 0, AUTO_PATROL_MAX_DURATION_SECONDS, waypoint[field]);
    updateWaypoint(waypoint.id, (item) => ({ ...item, [field]: nextValue }), field === 'travelDurationSeconds'
      ? '更新巡检移动时间'
      : '更新巡检停留时间');
  }

  function handleExportRoute(): void {
    try {
      const json = serializeAutoPatrolRouteJson(component, entityName);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${sanitizeFileName(entityName)}.auto-patrol.json`;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setRouteFileMessage('路线已导出。');
    } catch (error) {
      setRouteFileMessage(error instanceof Error ? error.message : '路线导出失败。');
    }
  }

  async function handleImportRoute(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || disabled) return;
    try {
      if (file.size > AUTO_PATROL_ROUTE_JSON_MAX_BYTES) {
        throw new Error('自动巡检路线 JSON 不能超过 1 MB。');
      }
      const imported = importAutoPatrolRouteJson(await file.text());
      if (useEditorStore.getState().scene.selectedEntityId !== entityId) {
        throw new Error('选中的巡检路线已变化，请重新导入。');
      }
      commit(imported.component, '导入自动巡检路线');
      renameSelectedEntity(imported.name);
      selectWaypoint(null);
      setRouteFileMessage(`已导入：${imported.name}`);
    } catch (error) {
      setRouteFileMessage(error instanceof Error ? error.message : '路线导入失败。');
    }
  }

  function updateTriggerRegion(
    regionId: string,
    updater: (region: AutoPatrolTriggerRegion) => AutoPatrolTriggerRegion,
    label: string,
  ): void {
    commit({
      ...component,
      triggerRegions: resolved.triggerRegions.map((region) => region.id === regionId ? updater(region) : region),
    }, label);
  }

  function handleAddTriggerRegion(): void {
    commit({
      ...component,
      triggerRegions: [...resolved.triggerRegions, createDefaultAutoPatrolTriggerRegion()],
    }, '添加巡检触发区域');
  }

  function handleDeleteTriggerRegion(regionId: string): void {
    const deletedEventIds = new Set(resolved.events.filter((event) => (
      (event.trigger.kind === 'region-enter' || event.trigger.kind === 'region-leave')
      && event.trigger.regionId === regionId
    )).map((event) => event.id));
    commit({
      ...component,
      triggerRegions: resolved.triggerRegions.filter((region) => region.id !== regionId),
      events: resolved.events.filter((event) => !(
        (event.trigger.kind === 'region-enter' || event.trigger.kind === 'region-leave')
        && event.trigger.regionId === regionId
      )),
      waypoints: component.waypoints.map((waypoint) => ({
        ...waypoint,
        arrivalActions: waypoint.arrivalActions.filter((actionId) => !deletedEventIds.has(actionId)),
      })),
    }, '删除巡检触发区域');
  }

  function handleRegionVectorChange(
    region: AutoPatrolTriggerRegion,
    field: 'center' | 'size',
    axis: typeof POSITION_AXES[number],
    rawValue: string,
  ): void {
    if (rawValue === '') return;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return;
    updateTriggerRegion(region.id, (item) => ({
      ...item,
      [field]: {
        ...item[field],
        [axis]: field === 'size' ? Math.max(0.01, Math.abs(value)) : value,
      },
    }), field === 'center' ? '更新触发区域位置' : '更新触发区域尺寸');
  }

  function handleAddEvent(): void {
    commit({
      ...component,
      events: [...resolved.events, createDefaultAutoPatrolEvent(component)],
    }, '添加巡检事件');
  }

  function updateEvent(
    eventId: string,
    updater: (definition: AutoPatrolEventDefinition) => AutoPatrolEventDefinition,
    label: string,
  ): void {
    commit({
      ...component,
      events: resolved.events.map((definition) => definition.id === eventId ? updater(definition) : definition),
    }, label);
  }

  function handleDeleteEvent(eventId: string): void {
    commit({
      ...component,
      events: resolved.events.filter((definition) => definition.id !== eventId),
      waypoints: component.waypoints.map((waypoint) => ({
        ...waypoint,
        arrivalActions: waypoint.arrivalActions.filter((actionId) => actionId !== eventId),
      })),
    }, '删除巡检事件');
  }

  function createEventTrigger(kind: AutoPatrolEventTrigger['kind']): AutoPatrolEventTrigger {
    if (kind === 'manual') return { kind: 'manual' };
    if (kind === 'waypoint' || kind === 'distance') {
      const waypointId = component.waypoints[0]?.id;
      return waypointId
        ? kind === 'distance'
          ? { kind, waypointId, radiusMeters: 2 }
          : { kind, waypointId }
        : { kind: 'manual' };
    }
    const regionId = resolved.triggerRegions[0]?.id;
    return regionId ? { kind, regionId } : { kind: 'manual' };
  }

  function handleEventResponseChange(
    definition: AutoPatrolEventDefinition,
    response: AutoPatrolEventResponse,
    checked: boolean,
  ): void {
    const responses = checked
      ? [...new Set([...definition.responses, response])]
      : definition.responses.filter((item) => item !== response);
    updateEvent(definition.id, (item) => ({ ...item, responses }), '更新巡检事件响应');
  }

  function handleBusinessDataBlur(definition: AutoPatrolEventDefinition, rawValue: string): void {
    try {
      const parsed: unknown = JSON.parse(rawValue || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('业务数据必须是 JSON 对象。');
      const entries = Object.entries(parsed);
      if (entries.length > 64) throw new Error('业务数据最多支持 64 个字段。');
      for (const [key, value] of entries) {
        if (!key.trim() || key !== key.trim() || key.length > 128) {
          throw new Error('业务数据字段名不能为空、带首尾空格或超过 128 个字符。');
        }
        if (!(value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) {
          throw new Error('业务数据仅支持字符串、数字、布尔值和 null。');
        }
        if (typeof value === 'string' && value.length > AUTO_PATROL_BUSINESS_DATA_MAX_STRING_LENGTH) {
          throw new Error(`业务数据字符串最多支持 ${AUTO_PATROL_BUSINESS_DATA_MAX_STRING_LENGTH} 个字符。`);
        }
      }
      updateEvent(definition.id, (item) => ({
        ...item,
        businessData: parsed as AutoPatrolEventDefinition['businessData'],
      }), '更新巡检事件业务数据');
      setRouteFileMessage(null);
    } catch (error) {
      setRouteFileMessage(error instanceof Error ? error.message : '业务数据 JSON 无效。');
    }
  }

  return (
    <fieldset className="transform-fieldset auto-patrol-inspector">
      <legend>自动巡检</legend>

      <div className="auto-patrol-switches">
        <label className="mqtt-config-dialog-checkbox">
          <input checked={component.enabled} disabled={disabled} type="checkbox" onChange={handleEnabledChange} />
          运行时启用
        </label>
        <label className="mqtt-config-dialog-checkbox" title="全场景最多一条路线自动启动">
          <input
            checked={component.autoStart}
            disabled={disabled}
            type="checkbox"
            onChange={handleAutoStartChange}
          />
          自动启动
        </label>
        <label className="mqtt-config-dialog-checkbox" title="Viewer 未指定路线时优先使用默认路线">
          <input
            checked={resolved.isDefault}
            disabled={disabled}
            type="checkbox"
            onChange={handleDefaultRouteChange}
          />
          默认路线
        </label>
      </div>

      <label className="inspector-row">
        <span>分类标签</span>
        <input
          defaultValue={resolved.tags.join(', ')}
          disabled={disabled}
          key={`${entityId}:${resolved.tags.join('|')}`}
          placeholder="生产区, 夜班"
          type="text"
          onBlur={handleTagsChange}
        />
      </label>
      <label className="inspector-row">
        <span>路径类型</span>
        <select disabled={disabled} value={component.pathType} onChange={handlePathTypeChange}>
          <option value="smooth">平滑</option>
          <option value="linear">直线</option>
        </select>
      </label>
      <label className="inspector-row">
        <span>播放模式</span>
        <select disabled={disabled} value={component.playbackMode} onChange={handlePlaybackModeChange}>
          <option value="once">单次</option>
          <option value="loop">循环</option>
          <option value="ping-pong">往返</option>
        </select>
      </label>

      <label className="mqtt-config-dialog-checkbox auto-patrol-inline-switch">
        <input
          checked={resolved.useRouteSpeed}
          disabled={disabled}
          type="checkbox"
          onChange={(event) => commit({ ...component, useRouteSpeed: event.target.checked }, '切换路线速度模式')}
        />
        使用路线统一速度
      </label>
      <label className="number-row">
        <span>巡检速度 (m/s)</span>
        <input
          disabled={disabled || !resolved.useRouteSpeed}
          max={AUTO_PATROL_MAX_SPEED_METERS_PER_SECOND}
          min={AUTO_PATROL_MIN_SPEED_METERS_PER_SECOND}
          step="0.1"
          type="number"
          value={resolved.speedMetersPerSecond}
          onChange={(event) => handleRouteSpeedChange(event.target.value)}
        />
      </label>

      <details className="auto-patrol-settings-section">
        <summary>视角自动切换</summary>
        <label className="mqtt-config-dialog-checkbox auto-patrol-inline-switch">
          <input
            checked={resolved.automaticViewSwitching}
            disabled={disabled}
            type="checkbox"
            onChange={(event) => commit({ ...component, automaticViewSwitching: event.target.checked }, '切换巡检自动视角')}
          />
          根据巡航、接近点和警戒区自动切换
        </label>
        <label className="number-row">
          <span>第一人称眼高 (m)</span>
          <input disabled type="number" value={resolved.camera.eyeHeightMeters} />
        </label>
        <label className="number-row">
          <span>第三人称距离 (m)</span>
          <input disabled={disabled} min="0.5" step="0.1" type="number" value={resolved.camera.thirdPersonDistanceMeters} onChange={(event) => handleCameraConfigChange('thirdPersonDistanceMeters', event.target.value)} />
        </label>
        <label className="number-row">
          <span>第三人称高度 (m)</span>
          <input disabled={disabled} min="0" step="0.1" type="number" value={resolved.camera.thirdPersonHeightMeters} onChange={(event) => handleCameraConfigChange('thirdPersonHeightMeters', event.target.value)} />
        </label>
        <label className="number-row">
          <span>旋转偏移 (deg)</span>
          <input disabled={disabled} max="180" min="-180" step="1" type="number" value={resolved.camera.thirdPersonRotationOffsetDegrees} onChange={(event) => handleCameraConfigChange('thirdPersonRotationOffsetDegrees', event.target.value)} />
        </label>
        <label className="number-row">
          <span>接近点距离 (m)</span>
          <input disabled={disabled} min="0.1" step="0.1" type="number" value={resolved.camera.approachDistanceMeters} onChange={(event) => handleCameraConfigChange('approachDistanceMeters', event.target.value)} />
        </label>
        <label className="number-row">
          <span>视角过渡 (s)</span>
          <input disabled={disabled} max="5" min="0" step="0.1" type="number" value={resolved.camera.transitionSeconds} onChange={(event) => handleCameraConfigChange('transitionSeconds', event.target.value)} />
        </label>
      </details>

      <div className="auto-patrol-route-file-actions">
        <button disabled={disabled} onClick={() => routeFileInputRef.current?.click()} type="button">导入 JSON</button>
        <button onClick={handleExportRoute} type="button">导出 JSON</button>
        <input
          ref={routeFileInputRef}
          accept="application/json,.json"
          className="auto-patrol-hidden-file-input"
          type="file"
          onChange={(event) => void handleImportRoute(event)}
        />
      </div>
      {routeFileMessage ? <p className="muted auto-patrol-file-message">{routeFileMessage}</p> : null}

      <div className="auto-patrol-playback-actions" aria-label="巡检播放控制">
        {!isPlaying && !isPaused ? (
          <button disabled={!component.enabled || component.waypoints.length < 2} onClick={() => requestPlayback('start', entityId)} type="button">
            开始
          </button>
        ) : null}
        {isPlaying ? <button onClick={() => requestPlayback('pause', entityId)} type="button">暂停</button> : null}
        {isPaused ? <button onClick={() => requestPlayback('resume', entityId)} type="button">继续</button> : null}
        <button disabled={!canStop} onClick={() => requestPlayback('stop', entityId)} type="button">停止</button>
        <button disabled={!playbackSnapshot.canReturnToStart} onClick={() => requestPlayback('return', entityId)} type="button">
          返回巡检前视角
        </button>
      </div>
      {activeForRoute && playbackSnapshot.currentWaypointIndex !== null ? (
        <p className="muted auto-patrol-runtime-status">
          {playbackSnapshot.phase === 'paused' ? '已暂停' : playbackSnapshot.phase === 'dwelling' ? '停留中' : '巡检中'}：
          节点 {playbackSnapshot.currentWaypointIndex + 1} / {playbackSnapshot.waypointCount}
          {playbackSnapshot.pausedByManualInput ? '（相机被手动接管）' : ''}
        </p>
      ) : null}

      <div className="auto-patrol-waypoint-toolbar">
        <strong>路径节点（{component.waypoints.length}）</strong>
        <button
          disabled={disabled || component.waypoints.length >= AUTO_PATROL_MAX_WAYPOINTS}
          onClick={handleAddWaypoint}
          title="追加当前相机视角"
          type="button"
        >
          + 添加点位
        </button>
      </div>
      <p className="muted auto-patrol-capture-hint">
        选中路线后按 F1 追加当前视角；选中节点后按 F1 覆盖该节点。
      </p>
      {routeIssues.length > 0 ? (
        <ul className="auto-patrol-validation-list" aria-label="路线校验结果">
          {routeIssues.map((issue, index) => <li key={`${issue.code}:${issue.waypointIndex ?? -1}:${index}`}>{issue.message}</li>)}
        </ul>
      ) : (
        <p className="auto-patrol-validation-ok">路线基础校验通过</p>
      )}

      <div className="auto-patrol-waypoint-list">
        {component.waypoints.length === 0 ? (
          <p className="muted auto-patrol-empty">暂无节点，请调整相机后按 F1。</p>
        ) : component.waypoints.map((waypoint, index) => {
          const selected = waypoint.id === selectedWaypoint?.id;
          const view = getAutoPatrolWaypointView(waypoint, transform);
          return (
            <div
              className={`auto-patrol-waypoint-card${selected ? ' is-selected' : ''}${draggedWaypointId === waypoint.id ? ' is-dragging' : ''}`}
              draggable={!disabled}
              key={waypoint.id}
              onDragEnd={() => setDraggedWaypointId(null)}
              onDragOver={(event) => {
                if (!disabled) event.preventDefault();
              }}
              onDragStart={(event) => handleWaypointDragStart(event, waypoint.id)}
              onDrop={(event) => handleWaypointDrop(event, index)}
            >
              <div className="auto-patrol-waypoint-summary">
                <button
                  aria-pressed={selected}
                  className="auto-patrol-waypoint-select"
                  onClick={() => selectWaypoint(selected ? null : waypoint.id)}
                  type="button"
                >
                  <span className="auto-patrol-waypoint-index">{index + 1}</span>
                  <span>
                    <strong>节点 {index + 1}</strong>
                    <small>
                      X {formatNumber(view.position.x)} / Y {formatNumber(view.position.y)} / Z {formatNumber(view.position.z)}
                    </small>
                  </span>
                </button>
                <div className="auto-patrol-waypoint-actions">
                  <button disabled={disabled || index === 0} onClick={() => moveWaypoint(waypoint.id, index - 1)} title="上移" type="button">↑</button>
                  <button disabled={disabled || index === component.waypoints.length - 1} onClick={() => moveWaypoint(waypoint.id, index + 1)} title="下移" type="button">↓</button>
                  <button onClick={() => requestFocus(waypoint.id)} title="聚焦此视角" type="button">◎</button>
                  <button disabled={disabled || component.waypoints.length >= AUTO_PATROL_MAX_WAYPOINTS} onClick={() => handleDuplicateWaypoint(waypoint.id)} title="复制" type="button">⧉</button>
                  <button disabled={disabled} onClick={() => handleDeleteWaypoint(waypoint.id)} title="删除" type="button">×</button>
                </div>
              </div>

              {selected ? (
                <div className="auto-patrol-waypoint-details">
                  <fieldset className="transform-fieldset transform-axis-fieldset">
                    <legend>相机位置 (m)</legend>
                    {POSITION_AXES.map((axis) => (
                      <label className="number-row" key={`${waypoint.id}-${axis}`}>
                        <span>{axis.toUpperCase()}</span>
                        <input
                          disabled={disabled}
                          step="0.1"
                          type="number"
                          value={formatNumber(view.position[axis])}
                          onChange={(event) => handleWaypointPositionChange(waypoint, axis, event.target.value)}
                        />
                      </label>
                    ))}
                  </fieldset>
                  <label className="number-row">
                    <span>水平角 (deg)</span>
                    <input disabled={disabled} max="360" min="0" step="1" type="number" value={formatNumber(view.headingDegrees)} onChange={(event) => handleWaypointViewChange(waypoint, 'headingDegrees', event.target.value)} />
                  </label>
                  <label className="number-row">
                    <span>俯仰角 (deg)</span>
                    <input disabled={disabled} max="89" min="-89" step="1" type="number" value={formatNumber(view.pitchDegrees)} onChange={(event) => handleWaypointViewChange(waypoint, 'pitchDegrees', event.target.value)} />
                  </label>
                  <label className="number-row">
                    <span>观察距离 (m)</span>
                    <input disabled={disabled} max={AUTO_PATROL_MAX_VIEW_DISTANCE} min={AUTO_PATROL_MIN_VIEW_DISTANCE} step="0.1" type="number" value={formatNumber(view.viewDistance)} onChange={(event) => handleWaypointViewChange(waypoint, 'viewDistance', event.target.value)} />
                  </label>
                  <label className="number-row">
                    <span>移动时间 (s)</span>
                    <input disabled={disabled} max={AUTO_PATROL_MAX_DURATION_SECONDS} min="0" step="0.1" type="number" value={waypoint.travelDurationSeconds} onChange={(event) => handleWaypointDurationChange(waypoint, 'travelDurationSeconds', event.target.value)} />
                  </label>
                  <label className="number-row">
                    <span>停留时间 (s)</span>
                    <input disabled={disabled} max={AUTO_PATROL_MAX_DURATION_SECONDS} min="0" step="0.1" type="number" value={waypoint.dwellSeconds} onChange={(event) => handleWaypointDurationChange(waypoint, 'dwellSeconds', event.target.value)} />
                  </label>
                  <div className="auto-patrol-waypoint-detail-actions">
                    <button onClick={() => requestFocus(waypoint.id)} type="button">聚焦节点</button>
                    <button disabled={disabled} onClick={requestCapture} type="button">使用当前视角覆盖</button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <section className="auto-patrol-definition-section">
        <div className="auto-patrol-section-heading">
          <strong>触发区域（{resolved.triggerRegions.length}）</strong>
          <button disabled={disabled} onClick={handleAddTriggerRegion} type="button">+ 添加区域</button>
        </div>
        {resolved.triggerRegions.length === 0 ? (
          <p className="muted auto-patrol-empty">暂无触发区域。</p>
        ) : (
          <div className="auto-patrol-definition-list">
            {resolved.triggerRegions.map((region, regionIndex) => (
              <div className="auto-patrol-definition-card" key={region.id}>
                <div className="auto-patrol-definition-card-header">
                  <label className="mqtt-config-dialog-checkbox">
                    <input
                      checked={region.enabled}
                      disabled={disabled}
                      type="checkbox"
                      onChange={(event) => updateTriggerRegion(region.id, (item) => ({ ...item, enabled: event.target.checked }), '切换触发区域启用状态')}
                    />
                    区域 {regionIndex + 1}
                  </label>
                  <button aria-label={`删除区域 ${regionIndex + 1}`} disabled={disabled} onClick={() => handleDeleteTriggerRegion(region.id)} title="删除区域" type="button">×</button>
                </div>
                <label className="inspector-row">
                  <span>名称</span>
                  <input
                    defaultValue={region.name}
                    disabled={disabled}
                    key={`${region.id}:${region.name}`}
                    type="text"
                    onBlur={(event) => updateTriggerRegion(region.id, (item) => ({ ...item, name: event.target.value }), '重命名触发区域')}
                  />
                </label>
                <label className="inspector-row">
                  <span>形状</span>
                  <select
                    disabled={disabled}
                    value={region.shape ?? 'box'}
                    onChange={(event) => {
                      const shape = event.target.value as AutoPatrolTriggerRegionShape;
                      updateTriggerRegion(region.id, (item) => ({
                        ...item,
                        shape,
                        radiusMeters: shape === 'sphere'
                          ? item.radiusMeters ?? Math.max(item.size.x, item.size.y, item.size.z) / 2
                          : item.radiusMeters,
                      }), '切换触发区域形状');
                    }}
                  >
                    <option value="box">箱体</option>
                    <option value="sphere">球体</option>
                  </select>
                </label>
                <fieldset className="transform-fieldset auto-patrol-vector-fieldset">
                  <legend>中心位置 (m)</legend>
                  {POSITION_AXES.map((axis) => (
                    <label className="number-row" key={`${region.id}:center:${axis}`}>
                      <span>{axis.toUpperCase()}</span>
                      <input disabled={disabled} step="0.1" type="number" value={formatNumber(region.center[axis])} onChange={(event) => handleRegionVectorChange(region, 'center', axis, event.target.value)} />
                    </label>
                  ))}
                </fieldset>
                {(region.shape ?? 'box') === 'sphere' ? (
                  <label className="number-row">
                    <span>半径 (m)</span>
                    <input
                      disabled={disabled}
                      min="0.01"
                      step="0.1"
                      type="number"
                      value={formatNumber(region.radiusMeters ?? Math.max(region.size.x, region.size.y, region.size.z) / 2)}
                      onChange={(event) => {
                        if (event.target.value === '') return;
                        const radiusMeters = Math.max(0.01, Number(event.target.value));
                        if (Number.isFinite(radiusMeters)) {
                          updateTriggerRegion(region.id, (item) => ({ ...item, radiusMeters }), '更新球形触发区域半径');
                        }
                      }}
                    />
                  </label>
                ) : (
                  <fieldset className="transform-fieldset auto-patrol-vector-fieldset">
                    <legend>箱体尺寸 (m)</legend>
                    {POSITION_AXES.map((axis) => (
                      <label className="number-row" key={`${region.id}:size:${axis}`}>
                        <span>{axis.toUpperCase()}</span>
                        <input disabled={disabled} min="0.01" step="0.1" type="number" value={formatNumber(region.size[axis])} onChange={(event) => handleRegionVectorChange(region, 'size', axis, event.target.value)} />
                      </label>
                    ))}
                  </fieldset>
                )}
                <label className="inspector-row">
                  <span>调试颜色</span>
                  <input
                    disabled={disabled}
                    type="color"
                    value={region.color}
                    onChange={(event) => updateTriggerRegion(region.id, (item) => ({ ...item, color: event.target.value }), '更新触发区域颜色')}
                  />
                </label>
                <label className="mqtt-config-dialog-checkbox auto-patrol-inline-switch">
                  <input
                    checked={region.alert}
                    disabled={disabled}
                    type="checkbox"
                    onChange={(event) => updateTriggerRegion(region.id, (item) => ({ ...item, alert: event.target.checked }), '切换警戒区域')}
                  />
                  警戒区域
                </label>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="auto-patrol-definition-section">
        <div className="auto-patrol-section-heading">
          <strong>巡检事件（{resolved.events.length}）</strong>
          <button disabled={disabled} onClick={handleAddEvent} type="button">+ 添加事件</button>
        </div>
        {resolved.events.length === 0 ? (
          <p className="muted auto-patrol-empty">暂无巡检事件。</p>
        ) : (
          <div className="auto-patrol-definition-list">
            {resolved.events.map((definition, eventIndex) => (
              <div className="auto-patrol-definition-card" key={definition.id}>
                <div className="auto-patrol-definition-card-header">
                  <label className="mqtt-config-dialog-checkbox">
                    <input
                      checked={definition.enabled}
                      disabled={disabled}
                      type="checkbox"
                      onChange={(event) => updateEvent(definition.id, (item) => ({ ...item, enabled: event.target.checked }), '切换巡检事件启用状态')}
                    />
                    事件 {eventIndex + 1}
                  </label>
                  <button aria-label={`删除事件 ${eventIndex + 1}`} disabled={disabled} onClick={() => handleDeleteEvent(definition.id)} title="删除事件" type="button">×</button>
                </div>
                <label className="inspector-row">
                  <span>名称</span>
                  <input
                    defaultValue={definition.name}
                    disabled={disabled}
                    key={`${definition.id}:${definition.name}`}
                    type="text"
                    onBlur={(event) => updateEvent(definition.id, (item) => ({ ...item, name: event.target.value }), '重命名巡检事件')}
                  />
                </label>
                <label className="inspector-row">
                  <span>触发类型</span>
                  <select
                    disabled={disabled}
                    value={definition.trigger.kind}
                    onChange={(event) => updateEvent(definition.id, (item) => ({
                      ...item,
                      trigger: createEventTrigger(event.target.value as AutoPatrolEventTrigger['kind']),
                    }), '更新巡检事件触发类型')}
                  >
                    <option value="waypoint" disabled={component.waypoints.length === 0}>到点停留</option>
                    <option value="distance" disabled={component.waypoints.length === 0}>距离检测</option>
                    <option value="region-enter" disabled={resolved.triggerRegions.length === 0}>进入区域</option>
                    <option value="region-leave" disabled={resolved.triggerRegions.length === 0}>离开区域</option>
                    <option value="manual">手动触发</option>
                  </select>
                </label>
                {definition.trigger.kind === 'waypoint' || definition.trigger.kind === 'distance' ? (
                  <label className="inspector-row">
                    <span>巡检点</span>
                    <select
                      disabled={disabled}
                      value={definition.trigger.waypointId}
                      onChange={(event) => updateEvent(definition.id, (item) => ({
                        ...item,
                        trigger: item.trigger.kind === 'distance'
                          ? { ...item.trigger, waypointId: event.target.value }
                          : { kind: 'waypoint', waypointId: event.target.value },
                      }), '更新巡检事件点位')}
                    >
                      {component.waypoints.map((waypoint, waypointIndex) => (
                        <option key={waypoint.id} value={waypoint.id}>节点 {waypointIndex + 1}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {definition.trigger.kind === 'distance' ? (
                  <label className="number-row">
                    <span>触发半径 (m)</span>
                    <input
                      disabled={disabled}
                      min="0.1"
                      step="0.1"
                      type="number"
                      value={definition.trigger.radiusMeters}
                      onChange={(event) => updateEvent(definition.id, (item) => item.trigger.kind === 'distance' ? ({
                        ...item,
                        trigger: {
                          ...item.trigger,
                          radiusMeters: Math.max(0.1, Number(event.target.value) || item.trigger.radiusMeters),
                        },
                      }) : item, '更新距离触发半径')}
                    />
                  </label>
                ) : null}
                {definition.trigger.kind === 'region-enter' || definition.trigger.kind === 'region-leave' ? (
                  <label className="inspector-row">
                    <span>触发区域</span>
                    <select
                      disabled={disabled}
                      value={definition.trigger.regionId}
                      onChange={(event) => updateEvent(definition.id, (item) => (
                        item.trigger.kind === 'region-enter' || item.trigger.kind === 'region-leave'
                          ? { ...item, trigger: { ...item.trigger, regionId: event.target.value } }
                          : item
                      ), '更新巡检事件区域')}
                    >
                      {resolved.triggerRegions.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}
                    </select>
                  </label>
                ) : null}
                <label className="inspector-row">
                  <span>目标设备</span>
                  <select
                    disabled={disabled}
                    value={definition.targetEntityId ?? ''}
                    onChange={(event) => updateEvent(definition.id, (item) => ({
                      ...item,
                      targetEntityId: event.target.value || null,
                    }), '更新巡检事件目标')}
                  >
                    <option value="">未指定</option>
                    {targetEntities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
                  </select>
                </label>
                <div className="auto-patrol-event-responses">
                  {EVENT_RESPONSES.map((response) => (
                    <label className="mqtt-config-dialog-checkbox" key={response.value}>
                      <input
                        checked={definition.responses.includes(response.value)}
                        disabled={disabled}
                        type="checkbox"
                        onChange={(event) => handleEventResponseChange(definition, response.value, event.target.checked)}
                      />
                      {response.label}
                    </label>
                  ))}
                </div>
                <label className="number-row">
                  <span>冷却时间 (s)</span>
                  <input
                    disabled={disabled}
                    min="0"
                    step="0.5"
                    type="number"
                    value={definition.cooldownSeconds}
                    onChange={(event) => updateEvent(definition.id, (item) => ({
                      ...item,
                      cooldownSeconds: Math.max(0, Number(event.target.value) || 0),
                    }), '更新巡检事件冷却时间')}
                  />
                </label>
                <label className="mqtt-config-dialog-checkbox auto-patrol-inline-switch">
                  <input
                    checked={definition.oncePerPatrol}
                    disabled={disabled}
                    type="checkbox"
                    onChange={(event) => updateEvent(definition.id, (item) => ({
                      ...item,
                      oncePerPatrol: event.target.checked,
                    }), '切换巡检事件一次性触发')}
                  />
                  每次巡检仅触发一次
                </label>
                <label className="mqtt-config-dialog-checkbox auto-patrol-inline-switch">
                  <input
                    checked={definition.anomaly === true}
                    disabled={disabled}
                    type="checkbox"
                    onChange={(event) => updateEvent(definition.id, (item) => ({
                      ...item,
                      anomaly: event.target.checked,
                    }), '切换巡检事件异常标记')}
                  />
                  计入异常汇总
                </label>
                <label className="auto-patrol-business-data-field">
                  <span>业务数据 JSON</span>
                  <textarea
                    defaultValue={JSON.stringify(definition.businessData, null, 2)}
                    disabled={disabled}
                    key={`${definition.id}:${JSON.stringify(definition.businessData)}`}
                    rows={4}
                    onBlur={(event) => handleBusinessDataBlur(definition, event.target.value)}
                  />
                </label>
              </div>
            ))}
          </div>
        )}
      </section>

    </fieldset>
  );
}
