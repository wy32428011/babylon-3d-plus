import { useState, type ChangeEvent, type DragEvent } from 'react';
import type {
  AutoPatrolComponent,
  AutoPatrolPathType,
  AutoPatrolPlaybackMode,
  AutoPatrolWaypoint,
  TransformComponent,
} from '../model/components';
import {
  AUTO_PATROL_MAX_DURATION_SECONDS,
  AUTO_PATROL_MAX_VIEW_DISTANCE,
  AUTO_PATROL_MAX_WAYPOINTS,
  AUTO_PATROL_MIN_VIEW_DISTANCE,
  duplicateAutoPatrolWaypoint,
  getAutoPatrolWaypointView,
  moveAutoPatrolWaypoint,
  updateAutoPatrolWaypointView,
} from '../model/autoPatrol';
import { useEditorStore } from '../store/editorStore';

const POSITION_AXES = ['x', 'y', 'z'] as const;

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

/** 自动巡检路线属性、播放控制和节点摘要编辑器。 */
export function AutoPatrolInspector({
  component,
  entityId,
  transform,
  disabled = false,
}: AutoPatrolInspectorProps) {
  const selectedWaypointId = useEditorStore((state) => state.selectedAutoPatrolWaypointId);
  const playbackSnapshot = useEditorStore((state) => state.autoPatrolPlaybackSnapshot);
  const selectWaypoint = useEditorStore((state) => state.selectAutoPatrolWaypoint);
  const requestCapture = useEditorStore((state) => state.requestAutoPatrolCapture);
  const requestFocus = useEditorStore((state) => state.requestAutoPatrolFocus);
  const requestPlayback = useEditorStore((state) => state.requestAutoPatrolPlayback);
  const updatePatrol = useEditorStore((state) => state.updateSelectedAutoPatrol);
  const [draggedWaypointId, setDraggedWaypointId] = useState<string | null>(null);

  const activeForRoute = playbackSnapshot.routeId === entityId;
  const isPlaying = activeForRoute && (playbackSnapshot.phase === 'moving' || playbackSnapshot.phase === 'dwelling');
  const isPaused = activeForRoute && playbackSnapshot.phase === 'paused';
  const canStop = activeForRoute && playbackSnapshot.phase !== 'idle';
  const selectedWaypoint = component.waypoints.find((waypoint) => waypoint.id === selectedWaypointId) ?? null;

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
    commit({
      ...component,
      waypoints: component.waypoints.filter((waypoint) => waypoint.id !== waypointId),
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
      </div>

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
    </fieldset>
  );
}
