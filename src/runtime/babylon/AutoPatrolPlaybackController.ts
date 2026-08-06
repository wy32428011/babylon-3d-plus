import type { AutoPatrolComponent, TransformComponent } from '../../editor/model/components';
import type { SceneCameraPose, SceneDocument } from '../../editor/model/SceneDocument';
import {
  AUTO_PATROL_MIN_WAYPOINTS,
  getAutoPatrolWaypointWorldPose,
  interpolateAutoPatrolPose,
} from '../../editor/model/autoPatrol';

export type AutoPatrolPlaybackRoute = {
  entityId: string;
  name: string;
  transform: TransformComponent;
  component: AutoPatrolComponent;
};

export type AutoPatrolPlaybackPhase = 'idle' | 'moving' | 'dwelling' | 'paused' | 'completed' | 'returning';

export type AutoPatrolPlaybackSnapshot = {
  phase: AutoPatrolPlaybackPhase;
  routeId: string | null;
  routeName: string | null;
  currentWaypointIndex: number | null;
  waypointCount: number;
  pausedByManualInput: boolean;
  canReturnToStart: boolean;
};

export type AutoPatrolPlaybackResult = { ok: true } | { ok: false; error: string };

export type AutoPatrolPlaybackAdapter = {
  readPose: () => SceneCameraPose;
  writePose: (pose: SceneCameraPose) => void;
  now: () => number;
  subscribeFrame: (callback: () => void) => () => void;
};

type ActiveMotionPhase = 'moving' | 'dwelling';

type ActivePlaybackState = {
  route: AutoPatrolPlaybackRoute;
  poses: SceneCameraPose[];
  phase: ActiveMotionPhase | 'paused' | 'completed';
  targetIndex: number;
  sourceIndex: number | null;
  direction: 1 | -1;
  fromPose: SceneCameraPose;
  segmentStartedAtMs: number;
  segmentDurationMs: number;
  dwellStartedAtMs: number;
  dwellDurationMs: number;
  pausedAtMs: number;
  pausedFromPhase: ActiveMotionPhase | null;
  pausedPose: SceneCameraPose | null;
  pausedByManualInput: boolean;
  cameraChangedWhilePaused: boolean;
  dwellOverrideAfterArrivalMs: number | null;
};

type ReturnTransition = {
  fromPose: SceneCameraPose;
  toPose: SceneCameraPose;
  startedAtMs: number;
  durationMs: number;
};

const RETURN_TO_START_DURATION_MS = 500;
const MAX_PHASE_ADVANCES_PER_FRAME = 2048;
const POSE_COMPARISON_EPSILON = 1e-6;

const IDLE_SNAPSHOT: AutoPatrolPlaybackSnapshot = {
  phase: 'idle',
  routeId: null,
  routeName: null,
  currentWaypointIndex: null,
  waypointCount: 0,
  pausedByManualInput: false,
  canReturnToStart: false,
};

/**
 * 自动巡检播放的唯一时间轴模块。
 * 调用方只负责提供相机读写和逐帧调度；节点推进、循环、停留、暂停恢复均封装在此处。
 */
export class AutoPatrolPlaybackController {
  private readonly routes = new Map<string, AutoPatrolPlaybackRoute>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeFrame: () => void;
  private active: ActivePlaybackState | null = null;
  private returnTransition: ReturnTransition | null = null;
  private lastPreStartPose: SceneCameraPose | null = null;
  private snapshot: AutoPatrolPlaybackSnapshot = IDLE_SNAPSHOT;
  private disposed = false;

  constructor(private readonly adapter: AutoPatrolPlaybackAdapter) {
    this.unsubscribeFrame = adapter.subscribeFrame(() => this.update());
  }

  setRoutes(routes: readonly AutoPatrolPlaybackRoute[]): void {
    this.routes.clear();
    for (const route of routes) this.routes.set(route.entityId, route);

    const active = this.active;
    if (!active) return;
    const next = this.routes.get(active.route.entityId);
    if (
      !next
      || !isPlayableRoute(next)
      || next.component !== active.route.component
      || next.transform !== active.route.transform
    ) {
      this.stop();
      return;
    }

    // 重命名或 Hierarchy 调整不改变播放数据，活动路线应继续并同步最新展示名称。
    active.route = next;
    this.publishActiveSnapshot();
  }

  start(routeId: string): AutoPatrolPlaybackResult {
    if (this.disposed) return { ok: false, error: '巡检播放控制器已释放。' };
    const route = this.routes.get(routeId);
    if (!route) return { ok: false, error: '巡检路线不存在。' };
    if (!route.component.enabled) return { ok: false, error: '巡检路线未启用。' };
    if (route.component.waypoints.length < AUTO_PATROL_MIN_WAYPOINTS) {
      return { ok: false, error: `巡检路线至少需要 ${AUTO_PATROL_MIN_WAYPOINTS} 个节点。` };
    }

    this.returnTransition = null;
    const now = this.adapter.now();
    const preStartPose = clonePose(this.adapter.readPose());
    const poses = route.component.waypoints.map((waypoint) => getAutoPatrolWaypointWorldPose(waypoint, route.transform));
    this.lastPreStartPose = clonePose(preStartPose);
    this.active = {
      route,
      poses,
      phase: 'moving',
      targetIndex: 0,
      sourceIndex: null,
      direction: 1,
      fromPose: clonePose(preStartPose),
      segmentStartedAtMs: now,
      segmentDurationMs: secondsToMilliseconds(route.component.waypoints[0].travelDurationSeconds),
      dwellStartedAtMs: 0,
      dwellDurationMs: 0,
      pausedAtMs: 0,
      pausedFromPhase: null,
      pausedPose: null,
      pausedByManualInput: false,
      cameraChangedWhilePaused: false,
      dwellOverrideAfterArrivalMs: null,
    };
    this.publishActiveSnapshot();
    this.update();
    return { ok: true };
  }

  pause(manualInput = false): AutoPatrolPlaybackResult {
    const active = this.active;
    if (!active || (active.phase !== 'moving' && active.phase !== 'dwelling')) {
      return { ok: false, error: '当前没有可暂停的巡检路线。' };
    }
    this.update();
    if (!this.active || (this.active.phase !== 'moving' && this.active.phase !== 'dwelling')) {
      return { ok: false, error: '当前没有可暂停的巡检路线。' };
    }

    const now = this.adapter.now();
    this.active.pausedFromPhase = this.active.phase;
    this.active.pausedAtMs = now;
    this.active.pausedPose = clonePose(this.adapter.readPose());
    this.active.pausedByManualInput = manualInput;
    this.active.cameraChangedWhilePaused = false;
    this.active.phase = 'paused';
    this.publishActiveSnapshot();
    return { ok: true };
  }

  notifyManualInput(): void {
    const active = this.active;
    if (!active) return;
    if (active.phase === 'moving' || active.phase === 'dwelling') {
      this.pause(true);
      return;
    }
    if (active.phase === 'paused' && !active.pausedByManualInput) {
      active.pausedByManualInput = true;
      this.publishActiveSnapshot();
    }
  }

  notifyCameraChangedWhilePaused(): void {
    const active = this.active;
    if (!active || active.phase !== 'paused') return;
    active.cameraChangedWhilePaused = true;
  }

  resume(): AutoPatrolPlaybackResult {
    const active = this.active;
    if (!active || active.phase !== 'paused' || !active.pausedFromPhase) {
      return { ok: false, error: '当前巡检未暂停。' };
    }

    const now = this.adapter.now();
    const currentPose = clonePose(this.adapter.readPose());
    const cameraChanged = active.cameraChangedWhilePaused
      || !active.pausedPose
      || !arePosesClose(active.pausedPose, currentPose);
    const pausedDuration = Math.max(0, now - active.pausedAtMs);
    const pausedFromPhase = active.pausedFromPhase;

    active.pausedFromPhase = null;
    active.pausedPose = null;
    active.pausedByManualInput = false;
    active.cameraChangedWhilePaused = false;

    if (!cameraChanged) {
      if (pausedFromPhase === 'moving') active.segmentStartedAtMs += pausedDuration;
      else active.dwellStartedAtMs += pausedDuration;
      active.phase = pausedFromPhase;
      this.publishActiveSnapshot();
      return { ok: true };
    }

    if (pausedFromPhase === 'dwelling') {
      const elapsedDwell = Math.max(0, active.pausedAtMs - active.dwellStartedAtMs);
      active.dwellOverrideAfterArrivalMs = Math.max(0, active.dwellDurationMs - elapsedDwell);
    } else {
      active.dwellOverrideAfterArrivalMs = null;
    }
    active.phase = 'moving';
    active.sourceIndex = null;
    active.fromPose = currentPose;
    active.segmentStartedAtMs = now;
    active.segmentDurationMs = secondsToMilliseconds(
      active.route.component.waypoints[active.targetIndex].travelDurationSeconds,
    );
    this.publishActiveSnapshot();
    this.update();
    return { ok: true };
  }

  stop(): void {
    this.active = null;
    this.returnTransition = null;
    this.publishSnapshot({
      ...IDLE_SNAPSHOT,
      canReturnToStart: this.lastPreStartPose !== null,
    });
  }

  returnToStart(): AutoPatrolPlaybackResult {
    if (!this.lastPreStartPose) return { ok: false, error: '没有可恢复的巡检前视角。' };
    const now = this.adapter.now();
    this.active = null;
    this.returnTransition = {
      fromPose: clonePose(this.adapter.readPose()),
      toPose: clonePose(this.lastPreStartPose),
      startedAtMs: now,
      durationMs: RETURN_TO_START_DURATION_MS,
    };
    this.publishSnapshot({
      phase: 'returning',
      routeId: null,
      routeName: null,
      currentWaypointIndex: null,
      waypointCount: 0,
      pausedByManualInput: false,
      canReturnToStart: true,
    });
    this.update();
    return { ok: true };
  }

  getSnapshot = (): AutoPatrolPlaybackSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeFrame();
    this.listeners.clear();
    this.active = null;
    this.returnTransition = null;
  }

  private update(): void {
    if (this.disposed) return;
    const now = this.adapter.now();
    if (this.returnTransition) {
      this.updateReturnTransition(now);
      return;
    }

    let active = this.active;
    if (!active || active.phase === 'paused' || active.phase === 'completed') return;

    for (let guard = 0; guard < MAX_PHASE_ADVANCES_PER_FRAME; guard += 1) {
      active = this.active;
      if (!active || active.phase === 'paused' || active.phase === 'completed') return;
      if (active.phase === 'dwelling') {
        const dwellEnd = active.dwellStartedAtMs + active.dwellDurationMs;
        this.adapter.writePose(clonePose(active.poses[active.targetIndex]));
        if (now < dwellEnd) return;
        this.beginNextSegment(active, dwellEnd);
        continue;
      }

      const segmentEnd = active.segmentStartedAtMs + active.segmentDurationMs;
      if (active.segmentDurationMs > 0 && now < segmentEnd) {
        const progress = (now - active.segmentStartedAtMs) / active.segmentDurationMs;
        this.adapter.writePose(this.interpolateActiveSegment(active, progress));
        return;
      }

      this.adapter.writePose(clonePose(active.poses[active.targetIndex]));
      const arrivalTime = active.segmentDurationMs > 0 ? segmentEnd : active.segmentStartedAtMs;
      const waypoint = active.route.component.waypoints[active.targetIndex];
      const dwellDurationMs = active.dwellOverrideAfterArrivalMs
        ?? secondsToMilliseconds(waypoint.dwellSeconds);
      active.dwellOverrideAfterArrivalMs = null;
      if (dwellDurationMs > 0) {
        active.phase = 'dwelling';
        active.dwellStartedAtMs = arrivalTime;
        active.dwellDurationMs = dwellDurationMs;
        this.publishActiveSnapshot();
        if (now < arrivalTime + dwellDurationMs) return;
        continue;
      }

      if (!this.beginNextSegment(active, arrivalTime)) return;
    }

    // 全零时长的异常路线也必须有界，避免单帧无限循环占满渲染线程。
    this.stop();
  }

  private updateReturnTransition(now: number): void {
    const transition = this.returnTransition;
    if (!transition) return;
    const progress = transition.durationMs <= 0
      ? 1
      : Math.min(1, Math.max(0, (now - transition.startedAtMs) / transition.durationMs));
    this.adapter.writePose(interpolateAutoPatrolPose(
      transition.fromPose,
      transition.toPose,
      transition.fromPose,
      transition.toPose,
      progress,
      'linear',
      true,
    ));
    if (progress < 1) return;
    this.returnTransition = null;
    this.lastPreStartPose = null;
    this.publishSnapshot(IDLE_SNAPSHOT);
  }

  private interpolateActiveSegment(active: ActivePlaybackState, progress: number): SceneCameraPose {
    const targetPose = active.poses[active.targetIndex];
    const previousPose = this.resolveContextPose(active, -1);
    const nextPose = this.resolveContextPose(active, 1);
    const sourceDwell = active.sourceIndex === null
      ? 1
      : active.route.component.waypoints[active.sourceIndex].dwellSeconds;
    const targetDwell = active.route.component.waypoints[active.targetIndex].dwellSeconds;
    const pingPongEndpoint = active.route.component.playbackMode === 'ping-pong'
      && (active.sourceIndex === 0
        || active.sourceIndex === active.poses.length - 1
        || active.targetIndex === 0
        || active.targetIndex === active.poses.length - 1);
    return interpolateAutoPatrolPose(
      active.fromPose,
      targetPose,
      previousPose,
      nextPose,
      progress,
      active.route.component.pathType,
      sourceDwell > 0 || targetDwell > 0 || pingPongEndpoint,
    );
  }

  /** 到达并完成停留后决定下一目标；单次路线在最后节点进入 completed。 */
  private beginNextSegment(active: ActivePlaybackState, startedAtMs: number): boolean {
    const lastIndex = active.poses.length - 1;
    const arrivedIndex = active.targetIndex;
    let nextIndex: number;

    if (active.route.component.playbackMode === 'once') {
      if (arrivedIndex >= lastIndex) {
        active.phase = 'completed';
        this.publishActiveSnapshot();
        return false;
      }
      nextIndex = arrivedIndex + 1;
      active.direction = 1;
    } else if (active.route.component.playbackMode === 'loop') {
      nextIndex = arrivedIndex >= lastIndex ? 0 : arrivedIndex + 1;
      active.direction = 1;
    } else {
      if (active.direction > 0 && arrivedIndex >= lastIndex) active.direction = -1;
      else if (active.direction < 0 && arrivedIndex <= 0) active.direction = 1;
      nextIndex = arrivedIndex + active.direction;
    }

    active.phase = 'moving';
    active.sourceIndex = arrivedIndex;
    active.targetIndex = nextIndex;
    active.fromPose = clonePose(active.poses[arrivedIndex]);
    active.segmentStartedAtMs = startedAtMs;
    active.segmentDurationMs = secondsToMilliseconds(
      active.route.component.waypoints[nextIndex].travelDurationSeconds,
    );
    active.dwellStartedAtMs = 0;
    active.dwellDurationMs = 0;
    this.publishActiveSnapshot();
    return true;
  }

  private resolveContextPose(active: ActivePlaybackState, relativeStep: -1 | 1): SceneCameraPose {
    if (active.sourceIndex === null) {
      return relativeStep < 0
        ? active.fromPose
        : active.poses[Math.min(active.poses.length - 1, active.targetIndex + 1)];
    }

    // loop 的末点 -> 首点仍是正向闭环；不能按数组下标误判成反向。
    const direction = active.route.component.playbackMode === 'loop'
      ? 1
      : active.targetIndex >= active.sourceIndex ? 1 : -1;
    const baseIndex = relativeStep < 0 ? active.sourceIndex : active.targetIndex;
    let index = baseIndex + direction * relativeStep;
    if (active.route.component.playbackMode === 'loop') {
      index = (index + active.poses.length) % active.poses.length;
    } else {
      index = Math.max(0, Math.min(active.poses.length - 1, index));
    }
    return active.poses[index];
  }

  private publishActiveSnapshot(): void {
    const active = this.active;
    if (!active) return;
    this.publishSnapshot({
      phase: active.phase,
      routeId: active.route.entityId,
      routeName: active.route.name,
      currentWaypointIndex: active.targetIndex,
      waypointCount: active.poses.length,
      pausedByManualInput: active.phase === 'paused' && active.pausedByManualInput,
      canReturnToStart: this.lastPreStartPose !== null,
    });
  }

  private publishSnapshot(next: AutoPatrolPlaybackSnapshot): void {
    if (areSnapshotsEqual(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

/** 按 Hierarchy 顺序收集场景中的巡检路线，供编辑预览和 Viewer 共用。 */
export function collectAutoPatrolPlaybackRoutes(document: SceneDocument): AutoPatrolPlaybackRoute[] {
  const routes: AutoPatrolPlaybackRoute[] = [];
  for (const entityId of document.entityIds) {
    const entity = document.entities[entityId];
    const component = entity?.components.autoPatrol;
    if (!entity || !component) continue;
    routes.push({
      entityId: entity.id,
      name: entity.name,
      transform: entity.components.transform,
      component,
    });
  }
  return routes;
}

export function findAutoStartPatrolRoute(
  routes: readonly AutoPatrolPlaybackRoute[],
): AutoPatrolPlaybackRoute | null {
  return routes.find((route) => isPlayableRoute(route) && route.component.autoStart) ?? null;
}

function isPlayableRoute(route: AutoPatrolPlaybackRoute): boolean {
  return route.component.enabled && route.component.waypoints.length >= AUTO_PATROL_MIN_WAYPOINTS;
}

function secondsToMilliseconds(seconds: number): number {
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 0;
}

function clonePose(pose: SceneCameraPose): SceneCameraPose {
  return {
    alpha: pose.alpha,
    beta: pose.beta,
    radius: pose.radius,
    target: { x: pose.target.x, y: pose.target.y, z: pose.target.z },
  };
}

function arePosesClose(left: SceneCameraPose, right: SceneCameraPose): boolean {
  return Math.abs(left.alpha - right.alpha) <= POSE_COMPARISON_EPSILON
    && Math.abs(left.beta - right.beta) <= POSE_COMPARISON_EPSILON
    && Math.abs(left.radius - right.radius) <= POSE_COMPARISON_EPSILON
    && Math.abs(left.target.x - right.target.x) <= POSE_COMPARISON_EPSILON
    && Math.abs(left.target.y - right.target.y) <= POSE_COMPARISON_EPSILON
    && Math.abs(left.target.z - right.target.z) <= POSE_COMPARISON_EPSILON;
}

function areSnapshotsEqual(left: AutoPatrolPlaybackSnapshot, right: AutoPatrolPlaybackSnapshot): boolean {
  return left.phase === right.phase
    && left.routeId === right.routeId
    && left.routeName === right.routeName
    && left.currentWaypointIndex === right.currentWaypointIndex
    && left.waypointCount === right.waypointCount
    && left.pausedByManualInput === right.pausedByManualInput
    && left.canReturnToStart === right.canReturnToStart;
}
