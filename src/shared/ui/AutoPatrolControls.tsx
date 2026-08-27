import { useEffect, useMemo, useState } from 'react';
import type {
  AutoPatrolInspectionEvent,
  AutoPatrolPlaybackRoute,
  AutoPatrolPlaybackRate,
  AutoPatrolPlaybackSnapshot,
} from '../../runtime/babylon/AutoPatrolPlaybackController';
import type { AutoPatrolViewMode } from '../../editor/model/components';
import type {
  AutoPatrolInspectionEventRecord,
  AutoPatrolInspectionRecord,
} from '../../runtime/patrol/AutoPatrolInspectionRecordStore';
import type {
  AutoPatrolInspectionReplayRate,
  AutoPatrolInspectionReplaySnapshot,
} from '../../runtime/patrol/AutoPatrolInspectionReplayController';
import '../../styles/auto-patrol-controls.css';

export type AutoPatrolControlAction =
  | 'start'
  | 'pause'
  | 'resume'
  | 'skip'
  | 'stop'
  | 'emergency-stop'
  | 'return'
  | 'set-rate'
  | 'set-view'
  | 'resume-auto-view'
  | 'trigger-event';

export type AutoPatrolControlPayload = AutoPatrolPlaybackRate | AutoPatrolViewMode | string | null;

export type AutoPatrolHistoryAction =
  | 'refresh'
  | 'select-record'
  | 'play'
  | 'pause'
  | 'seek'
  | 'set-rate'
  | 'jump-to-event';

export type AutoPatrolHistoryState = {
  records: readonly AutoPatrolInspectionRecord[];
  selectedRecord: AutoPatrolInspectionRecord | null;
  replay: AutoPatrolInspectionReplaySnapshot;
  loading: boolean;
  error: string | null;
};

type AutoPatrolControlsProps = {
  routes: readonly AutoPatrolPlaybackRoute[];
  snapshot: AutoPatrolPlaybackSnapshot;
  onAction: (
    action: AutoPatrolControlAction,
    routeId: string | null,
    payload?: AutoPatrolControlPayload,
  ) => void;
  history?: AutoPatrolHistoryState;
  onHistoryAction?: (action: AutoPatrolHistoryAction, payload?: string | number) => void;
  title?: string;
};

const PHASE_LABELS: Record<AutoPatrolPlaybackSnapshot['phase'], string> = {
  idle: '待机',
  moving: '移动中',
  dwelling: '停留中',
  paused: '已暂停',
  completed: '已完成',
  returning: '正在返回',
};

const PLAYBACK_RATES: readonly AutoPatrolPlaybackRate[] = [0.5, 1, 2, 4];

const VIEW_MODES: readonly { label: string; value: AutoPatrolViewMode }[] = [
  { label: '第一人称', value: 'first-person' },
  { label: '第三人称', value: 'third-person' },
  { label: '轨道观察', value: 'orbit' },
];

function formatEventTime(triggeredAt: number): string {
  if (!Number.isFinite(triggeredAt)) return '';
  return new Date(triggeredAt).toLocaleTimeString('zh-CN', { hour12: false });
}

function getEventTriggerLabel(event: AutoPatrolInspectionEvent): string {
  switch (event.trigger.kind) {
    case 'waypoint':
      return '到点触发';
    case 'distance':
      return `距离触发 · ${event.trigger.radiusMeters}m`;
    case 'region-enter':
      return '进入区域';
    case 'region-leave':
      return '离开区域';
    case 'manual':
      return '手动触发';
  }
}

const HISTORY_STATUS_LABELS: Record<AutoPatrolInspectionRecord['status'], string> = {
  running: '进行中',
  completed: '已完成',
  stopped: '已停止',
  'emergency-stopped': '紧急停止',
  failed: '失败',
};

function formatDuration(milliseconds: number | null): string {
  const totalSeconds = Math.max(0, Math.floor((milliseconds ?? 0) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatRecordDate(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '-';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function getHistoryEventTriggerLabel(event: AutoPatrolInspectionEventRecord): string {
  switch (event.trigger) {
    case 'waypoint': return '到点';
    case 'distance': return '距离';
    case 'region-enter': return '进入区域';
    case 'region-leave': return '离开区域';
    case 'dwell': return '停留';
    case 'manual': return '手动';
  }
}

/** 运行预览与发布 Viewer 共用的可折叠自动巡检控制器。 */
export function AutoPatrolControls({
  routes,
  snapshot,
  onAction,
  history,
  onHistoryAction,
  title = '自动巡检',
}: AutoPatrolControlsProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<'patrol' | 'history'>('patrol');
  const [dismissedEventId, setDismissedEventId] = useState<string | null>(null);
  const fallbackRouteId = useMemo(() => (
    routes.find((route) => (
      route.component.isDefault
      && route.component.enabled
      && route.component.waypoints.length >= 2
    ))?.entityId
      ?? routes.find((route) => route.component.enabled && route.component.waypoints.length >= 2)?.entityId
      ?? routes[0]?.entityId
      ?? null
  ), [routes]);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(snapshot.routeId ?? fallbackRouteId);

  useEffect(() => {
    const taskIsActive = snapshot.phase !== 'idle' && snapshot.phase !== 'completed';
    if (taskIsActive && snapshot.routeId) {
      setSelectedRouteId(snapshot.routeId);
      return;
    }
    if (!selectedRouteId || !routes.some((route) => route.entityId === selectedRouteId)) {
      setSelectedRouteId(fallbackRouteId);
    }
  }, [fallbackRouteId, routes, selectedRouteId, snapshot.phase, snapshot.routeId]);

  const selectedRoute = routes.find((route) => route.entityId === selectedRouteId) ?? null;
  const activeForSelected = snapshot.routeId === selectedRouteId;
  const isPlaying = activeForSelected && (snapshot.phase === 'moving' || snapshot.phase === 'dwelling');
  const isPaused = activeForSelected && snapshot.phase === 'paused';
  const canStart = Boolean(selectedRoute?.component.enabled && selectedRoute.component.waypoints.length >= 2);
  const canStop = snapshot.phase !== 'idle' && snapshot.phase !== 'completed';
  const canControlActiveTask = Boolean(
    snapshot.routeId
    && snapshot.phase !== 'idle'
    && snapshot.phase !== 'completed'
    && snapshot.phase !== 'returning',
  );
  const manualEvents = (selectedRoute?.component.events ?? []).filter((event) => (
    event.enabled && event.trigger.kind === 'manual'
  ));
  const lastEvent = snapshot.lastEvent;
  const showEventPanel = Boolean(
    lastEvent
    && lastEvent.responses.includes('panel')
    && lastEvent.occurrenceId !== dismissedEventId,
  );
  const statusPrefix = snapshot.routeId && snapshot.routeId !== selectedRouteId
    ? `${snapshot.routeName ?? '其他路线'} · `
    : '';
  const historyAvailable = Boolean(history && onHistoryAction);
  const selectedHistoryRecord = history?.selectedRecord ?? null;
  const activeHistoryEvent = selectedHistoryRecord?.events.find((event) => (
    event.id === history?.replay.activeEventId
  )) ?? null;

  function selectTab(tab: 'patrol' | 'history'): void {
    setActiveTab(tab);
    if (tab === 'history') onHistoryAction?.('refresh');
    else onHistoryAction?.('pause');
  }

  function toggleCollapsed(): void {
    const nextCollapsed = !collapsed;
    setCollapsed(nextCollapsed);
    if (nextCollapsed && activeTab === 'history') onHistoryAction?.('pause');
  }

  return (
    <section className={`auto-patrol-controls${collapsed ? ' is-collapsed' : ''}`} aria-label={title}>
      <header>
        <button
          aria-expanded={!collapsed}
          className="auto-patrol-controls-toggle"
          onClick={toggleCollapsed}
          title={collapsed ? '展开自动巡检控制器' : '收起自动巡检控制器'}
          type="button"
        >
          <span aria-hidden="true">⌁</span>
          <strong>{title}</strong>
          <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        </button>
      </header>
      {!collapsed ? (
        <div className="auto-patrol-controls-body">
          {historyAvailable ? (
            <div className="auto-patrol-controls-tabs" role="tablist" aria-label="自动巡检视图">
              <button
                aria-selected={activeTab === 'patrol'}
                className={activeTab === 'patrol' ? 'is-active' : ''}
                onClick={() => selectTab('patrol')}
                role="tab"
                type="button"
              >
                巡检
              </button>
              <button
                aria-selected={activeTab === 'history'}
                className={activeTab === 'history' ? 'is-active' : ''}
                onClick={() => selectTab('history')}
                role="tab"
                type="button"
              >
                历史
              </button>
            </div>
          ) : null}
          {activeTab === 'history' && history && onHistoryAction ? (
            <div className="auto-patrol-history" role="tabpanel">
              <div className="auto-patrol-history-toolbar">
                <span>{history.records.length} 条记录</span>
                <button disabled={history.loading} onClick={() => onHistoryAction('refresh')} type="button">
                  {history.loading ? '刷新中' : '刷新'}
                </button>
              </div>
              {history.error ? <p className="auto-patrol-history-error" role="alert">{history.error}</p> : null}
              {history.records.length > 0 ? (
                <div className="auto-patrol-history-records" role="listbox" aria-label="巡检历史记录">
                  {history.records.map((record) => (
                    <button
                      aria-selected={selectedHistoryRecord?.taskId === record.taskId}
                      className={selectedHistoryRecord?.taskId === record.taskId ? 'is-active' : ''}
                      key={record.taskId}
                      onClick={() => onHistoryAction('select-record', record.taskId)}
                      role="option"
                      type="button"
                    >
                      <span>
                        <strong>{record.routeName ?? record.routeId}</strong>
                        <small>{formatRecordDate(record.startedAtMs)}</small>
                      </span>
                      <span>
                        <em>{HISTORY_STATUS_LABELS[record.status]}</em>
                        <small>{formatDuration(record.durationMs)}</small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : !history.loading ? <p className="auto-patrol-history-empty">暂无巡检记录</p> : null}
              {selectedHistoryRecord ? (
                <div className="auto-patrol-replay">
                  <div className="auto-patrol-replay-summary">
                    <span>轨迹 {selectedHistoryRecord.trajectory.length}</span>
                    <span>事件 {selectedHistoryRecord.events.length}</span>
                    <span>异常 {selectedHistoryRecord.anomalyEventIds.length}</span>
                  </div>
                  <input
                    aria-label="历史回放进度"
                    disabled={history.replay.durationMs <= 0}
                    max={Math.max(1, history.replay.durationMs)}
                    min="0"
                    onChange={(event) => onHistoryAction('seek', Number(event.target.value))}
                    step="100"
                    type="range"
                    value={Math.min(history.replay.elapsedMs, Math.max(1, history.replay.durationMs))}
                  />
                  <div className="auto-patrol-replay-time">
                    <span>{formatDuration(history.replay.elapsedMs)}</span>
                    <span>{formatDuration(history.replay.durationMs)}</span>
                  </div>
                  <div className="auto-patrol-replay-actions">
                    {history.replay.phase === 'playing' ? (
                      <button onClick={() => onHistoryAction('pause')} type="button">暂停</button>
                    ) : (
                      <button onClick={() => onHistoryAction('play')} type="button">
                        {history.replay.phase === 'completed' ? '重新播放' : '播放'}
                      </button>
                    )}
                    {PLAYBACK_RATES.map((rate) => (
                      <button
                        aria-pressed={history.replay.playbackRate === rate}
                        className={history.replay.playbackRate === rate ? 'is-active' : ''}
                        key={rate}
                        onClick={() => onHistoryAction('set-rate', rate as AutoPatrolInspectionReplayRate)}
                        type="button"
                      >
                        {rate}x
                      </button>
                    ))}
                  </div>
                  {selectedHistoryRecord.events.length > 0 ? (
                    <div className="auto-patrol-replay-events" aria-label="巡检事件">
                      {selectedHistoryRecord.events.map((event) => (
                        <button
                          className={`${event.anomaly ? 'is-anomaly' : ''}${activeHistoryEvent?.id === event.id ? ' is-active' : ''}`}
                          key={event.id}
                          onClick={() => onHistoryAction('jump-to-event', event.id)}
                          type="button"
                        >
                          <span>{event.name}</span>
                          <small>{formatDuration(event.occurredAtMs - selectedHistoryRecord.startedAtMs)} · {getHistoryEventTriggerLabel(event)}</small>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {activeHistoryEvent ? (
                    <aside className="auto-patrol-replay-event" aria-live="polite">
                      <strong>{activeHistoryEvent.name}</strong>
                      {Object.keys(activeHistoryEvent.businessData).length > 0 ? (
                        <dl>
                          {Object.entries(activeHistoryEvent.businessData).map(([key, value]) => (
                            <div key={key}><dt>{key}</dt><dd>{value === null ? 'null' : String(value)}</dd></div>
                          ))}
                        </dl>
                      ) : null}
                      {history.replay.activeScreenshot ? (
                        <img
                          alt={`${activeHistoryEvent.name} 历史截图`}
                          referrerPolicy="no-referrer"
                          src={history.replay.activeScreenshot.remoteUrl ?? history.replay.activeScreenshot.localUrl}
                        />
                      ) : null}
                    </aside>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
          <>
          {routes.length > 1 ? (
            <label>
              <span>路线</span>
              <select value={selectedRouteId ?? ''} onChange={(event) => setSelectedRouteId(event.target.value || null)}>
                {routes.map((route) => (
                  <option key={route.entityId} value={route.entityId}>
                    {route.name}{route.component.enabled ? '' : '（未启用）'}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="auto-patrol-controls-route">{selectedRoute?.name ?? '暂无巡检路线'}</p>
          )}

          <p className="auto-patrol-controls-status" aria-live="polite">
            <span>{statusPrefix}{PHASE_LABELS[snapshot.phase]}</span>
            {snapshot.currentWaypointIndex !== null ? (
              <strong>{snapshot.currentWaypointIndex + 1} / {snapshot.waypointCount}</strong>
            ) : null}
            {snapshot.eventCount > 0 ? <small>事件 {snapshot.eventCount}</small> : null}
            {snapshot.pausedByManualInput ? <small>手动接管</small> : null}
          </p>

          <div className="auto-patrol-controls-actions">
            {!isPlaying && !isPaused ? (
              <button disabled={!canStart} onClick={() => onAction('start', selectedRouteId)} type="button">开始</button>
            ) : null}
            {isPlaying ? <button onClick={() => onAction('pause', selectedRouteId)} type="button">暂停</button> : null}
            {isPaused ? <button onClick={() => onAction('resume', selectedRouteId)} type="button">继续</button> : null}
            <button disabled={!canControlActiveTask} onClick={() => onAction('skip', snapshot.routeId)} type="button">
              跳过当前点
            </button>
            <button disabled={!canStop} onClick={() => onAction('stop', snapshot.routeId)} type="button">停止</button>
            <button
              className="is-danger"
              disabled={!canControlActiveTask}
              onClick={() => onAction('emergency-stop', snapshot.routeId)}
              type="button"
            >
              紧急停止
            </button>
            <button disabled={!snapshot.canReturnToStart} onClick={() => onAction('return', null)} type="button">返回</button>
          </div>

          <fieldset className="auto-patrol-controls-fieldset" disabled={!canControlActiveTask}>
            <legend>倍速</legend>
            <div className="auto-patrol-controls-segmented" role="group" aria-label="巡检播放倍速">
              {PLAYBACK_RATES.map((rate) => (
                <button
                  aria-pressed={snapshot.playbackRate === rate}
                  className={snapshot.playbackRate === rate ? 'is-active' : ''}
                  key={rate}
                  onClick={() => onAction('set-rate', snapshot.routeId, rate)}
                  type="button"
                >
                  {rate}x
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="auto-patrol-controls-fieldset" disabled={!canControlActiveTask}>
            <legend>视角</legend>
            <div className="auto-patrol-controls-segmented auto-patrol-controls-views" role="group" aria-label="巡检视角">
              {VIEW_MODES.map((viewMode) => (
                <button
                  aria-pressed={snapshot.viewMode === viewMode.value}
                  className={snapshot.viewMode === viewMode.value ? 'is-active' : ''}
                  key={viewMode.value}
                  onClick={() => onAction('set-view', snapshot.routeId, viewMode.value)}
                  type="button"
                >
                  {viewMode.label}
                </button>
              ))}
              <button
                disabled={!snapshot.manualCameraOverride}
                onClick={() => onAction('resume-auto-view', snapshot.routeId)}
                type="button"
              >
                恢复自动
              </button>
            </div>
          </fieldset>

          {manualEvents.length > 0 ? (
            <fieldset className="auto-patrol-controls-fieldset" disabled={!activeForSelected || !canControlActiveTask}>
              <legend>手动事件</legend>
              <div className="auto-patrol-controls-manual-events">
                {manualEvents.map((event) => (
                  <button
                    key={event.id}
                    onClick={() => onAction('trigger-event', snapshot.routeId, event.id)}
                    type="button"
                  >
                    {event.name}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}

          {showEventPanel && lastEvent ? (
            <aside className="auto-patrol-event-panel" aria-live="assertive">
              <header>
                <div>
                  <strong>{lastEvent.name}</strong>
                  <span>{formatEventTime(lastEvent.triggeredAt)} · {getEventTriggerLabel(lastEvent)}</span>
                </div>
                <button
                  aria-label="关闭事件面板"
                  onClick={() => setDismissedEventId(lastEvent.occurrenceId)}
                  title="关闭事件面板"
                  type="button"
                >
                  ×
                </button>
              </header>
              {Object.keys(lastEvent.businessData).length > 0 ? (
                <dl>
                  {Object.entries(lastEvent.businessData).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{value === null ? 'null' : String(value)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {lastEvent.screenshotDataUrl ? (
                <img
                  alt={`${lastEvent.name} 巡检截图`}
                  referrerPolicy="no-referrer"
                  src={lastEvent.screenshotDataUrl}
                />
              ) : null}
            </aside>
          ) : null}
          </>
          )}
        </div>
      ) : null}
    </section>
  );
}
