import { useEffect, useMemo, useState } from 'react';
import type {
  AutoPatrolPlaybackRoute,
  AutoPatrolPlaybackSnapshot,
} from '../../runtime/babylon/AutoPatrolPlaybackController';
import '../../styles/auto-patrol-controls.css';

export type AutoPatrolControlAction = 'start' | 'pause' | 'resume' | 'stop' | 'return';

type AutoPatrolControlsProps = {
  routes: readonly AutoPatrolPlaybackRoute[];
  snapshot: AutoPatrolPlaybackSnapshot;
  onAction: (action: AutoPatrolControlAction, routeId: string | null) => void;
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

/** 运行预览与发布 Viewer 共用的可折叠自动巡检控制器。 */
export function AutoPatrolControls({ routes, snapshot, onAction, title = '自动巡检' }: AutoPatrolControlsProps) {
  const [collapsed, setCollapsed] = useState(false);
  const fallbackRouteId = useMemo(() => (
    routes.find((route) => route.component.enabled && route.component.waypoints.length >= 2)?.entityId
      ?? routes[0]?.entityId
      ?? null
  ), [routes]);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(snapshot.routeId ?? fallbackRouteId);

  useEffect(() => {
    if (snapshot.routeId) {
      setSelectedRouteId(snapshot.routeId);
      return;
    }
    if (!selectedRouteId || !routes.some((route) => route.entityId === selectedRouteId)) {
      setSelectedRouteId(fallbackRouteId);
    }
  }, [fallbackRouteId, routes, selectedRouteId, snapshot.routeId]);

  const selectedRoute = routes.find((route) => route.entityId === selectedRouteId) ?? null;
  const activeForSelected = snapshot.routeId === selectedRouteId;
  const isPlaying = activeForSelected && (snapshot.phase === 'moving' || snapshot.phase === 'dwelling');
  const isPaused = activeForSelected && snapshot.phase === 'paused';
  const canStart = Boolean(selectedRoute?.component.enabled && selectedRoute.component.waypoints.length >= 2);
  const canStop = snapshot.phase !== 'idle' && snapshot.phase !== 'completed';
  const statusPrefix = snapshot.routeId && snapshot.routeId !== selectedRouteId
    ? `${snapshot.routeName ?? '其他路线'} · `
    : '';

  return (
    <section className={`auto-patrol-controls${collapsed ? ' is-collapsed' : ''}`} aria-label={title}>
      <header>
        <button
          aria-expanded={!collapsed}
          className="auto-patrol-controls-toggle"
          onClick={() => setCollapsed((value) => !value)}
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
            {snapshot.pausedByManualInput ? <small>相机已手动接管</small> : null}
          </p>

          <div className="auto-patrol-controls-actions">
            {!isPlaying && !isPaused ? (
              <button disabled={!canStart} onClick={() => onAction('start', selectedRouteId)} type="button">开始</button>
            ) : null}
            {isPlaying ? <button onClick={() => onAction('pause', selectedRouteId)} type="button">暂停</button> : null}
            {isPaused ? <button onClick={() => onAction('resume', selectedRouteId)} type="button">继续</button> : null}
            <button disabled={!canStop} onClick={() => onAction('stop', snapshot.routeId)} type="button">停止</button>
            <button disabled={!snapshot.canReturnToStart} onClick={() => onAction('return', null)} type="button">返回</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
