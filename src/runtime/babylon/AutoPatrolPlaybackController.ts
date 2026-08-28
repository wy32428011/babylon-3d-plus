import type {
  AutoPatrolComponent,
  AutoPatrolEventDefinition,
  AutoPatrolEventResponse,
  AutoPatrolEventTrigger,
  AutoPatrolViewMode,
  TransformComponent,
} from '../../editor/model/components';
import type { SceneCameraPose, SceneDocument } from '../../editor/model/SceneDocument';
import type { Vector3Data } from '../../editor/model/math';
import {
  AUTO_PATROL_MIN_WAYPOINTS,
  createSceneCameraPose,
  getAutoPatrolWaypointWorldPose,
  getSceneCameraPosition,
  interpolateAutoPatrolPose,
  intersectWorldSegmentWithAutoPatrolRegion,
  isWorldPointInsideAutoPatrolRegion,
  resolveAutoPatrolComponent,
  type ResolvedAutoPatrolComponent,
} from '../../editor/model/autoPatrolInspection';

export type AutoPatrolPlaybackRoute = {
  entityId: string;
  name: string;
  transform: TransformComponent;
  component: AutoPatrolComponent;
};

export type AutoPatrolPlaybackPhase = 'idle' | 'moving' | 'dwelling' | 'paused' | 'completed' | 'returning';

export type AutoPatrolPlaybackRate = 0.5 | 1 | 2 | 4;

export type AutoPatrolInspectionStatus = 'completed' | 'stopped' | 'emergency-stopped';

export type AutoPatrolInspectionEvent = {
  occurrenceId: string;
  eventId: string;
  name: string;
  anomaly: boolean;
  triggeredAt: number;
  elapsedMs: number;
  trigger: AutoPatrolEventTrigger;
  responses: AutoPatrolEventResponse[];
  targetEntityId: string | null;
  position: Vector3Data;
  businessData: Record<string, string | number | boolean | null>;
  screenshotDataUrl?: string;
};

export type AutoPatrolInspectionTrajectorySample = {
  elapsedMs: number;
  capturedAt: number;
  pose: SceneCameraPose;
  phase: AutoPatrolPlaybackPhase;
  waypointIndex: number | null;
  viewMode: AutoPatrolViewMode;
};

export type AutoPatrolInspectionScreenshot = {
  occurrenceId: string;
  capturedAt: number;
  dataUrl: string;
};

export type AutoPatrolInspectionRecord = {
  taskId: string;
  routeId: string;
  routeName: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  status: AutoPatrolInspectionStatus | 'running';
  trajectory: AutoPatrolInspectionTrajectorySample[];
  events: AutoPatrolInspectionEvent[];
  screenshots: AutoPatrolInspectionScreenshot[];
};

export type AutoPatrolPlaybackSnapshot = {
  phase: AutoPatrolPlaybackPhase;
  routeId: string | null;
  routeName: string | null;
  currentWaypointIndex: number | null;
  waypointCount: number;
  pausedByManualInput: boolean;
  canReturnToStart: boolean;
  playbackRate: AutoPatrolPlaybackRate;
  viewMode: AutoPatrolViewMode;
  automaticViewMode: AutoPatrolViewMode;
  manualCameraOverride: boolean;
  taskId: string | null;
  eventCount: number;
  lastEvent: AutoPatrolInspectionEvent | null;
};

export type AutoPatrolPlaybackResult = { ok: true } | { ok: false; error: string };

export type AutoPatrolPlaybackLimits = {
  maxEvents: number;
  maxScreenshots: number;
  maxPendingScreenshotCaptures: number;
  maxScreenshotDataUrlLength: number;
  screenshotCaptureTimeoutMs: number;
};

export type AutoPatrolPlaybackAdapter = {
  readPose: () => SceneCameraPose;
  writePose: (pose: SceneCameraPose) => void;
  now: () => number;
  wallNow?: () => number;
  subscribeFrame: (callback: () => void) => () => void;
  captureScreenshot?: () => Promise<string | null>;
  onInspectionEvent?: (event: AutoPatrolInspectionEvent) => void;
  onInspectionScreenshot?: (
    event: AutoPatrolInspectionEvent,
    screenshot: AutoPatrolInspectionScreenshot,
  ) => void | Promise<void>;
  onInspectionStart?: (record: AutoPatrolInspectionRecord) => void | Promise<void>;
  onInspectionTrajectory?: (
    taskId: string,
    samples: readonly AutoPatrolInspectionTrajectorySample[],
  ) => void | Promise<void>;
  onInspectionRecord?: (record: AutoPatrolInspectionRecord) => void | Promise<void>;
};

type ActiveMotionPhase = 'moving' | 'dwelling';

type ActivePlaybackState = {
  route: AutoPatrolPlaybackRoute & { component: ResolvedAutoPatrolComponent };
  sourceComponent: AutoPatrolComponent;
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

type ViewTransition = {
  fromPose: SceneCameraPose;
  startedAtMs: number;
  durationMs: number;
  targetMode: AutoPatrolViewMode;
};

type TrajectorySampleState = {
  pose: SceneCameraPose;
  phase: AutoPatrolPlaybackPhase;
  waypointIndex: number | null;
  viewMode: AutoPatrolViewMode;
};

type TrajectoryObservation = TrajectorySampleState & {
  observedAtMs: number;
};

type SpatialObservation = {
  position: Vector3Data;
  observedAtMs: number;
};

const RETURN_TO_START_DURATION_MS = 500;
const TRAJECTORY_SAMPLE_INTERVAL_MS = 500;
const MAX_TRAJECTORY_SAMPLES = 100_000;
const MAX_PHASE_ADVANCES_PER_FRAME = 2048;
const POSE_COMPARISON_EPSILON = 1e-6;
const DEFAULT_PLAYBACK_LIMITS: Readonly<AutoPatrolPlaybackLimits> = {
  maxEvents: 10_000,
  maxScreenshots: 50,
  maxPendingScreenshotCaptures: 1,
  maxScreenshotDataUrlLength: 8 * 1024 * 1024,
  screenshotCaptureTimeoutMs: 10_000,
};

const IDLE_SNAPSHOT: AutoPatrolPlaybackSnapshot = {
  phase: 'idle',
  routeId: null,
  routeName: null,
  currentWaypointIndex: null,
  waypointCount: 0,
  pausedByManualInput: false,
  canReturnToStart: false,
  playbackRate: 1,
  viewMode: 'orbit',
  automaticViewMode: 'orbit',
  manualCameraOverride: false,
  taskId: null,
  eventCount: 0,
  lastEvent: null,
};

/** 自动巡检播放的唯一时间轴，统一处理移动、事件、视角和记录。 */
export class AutoPatrolPlaybackController {
  private readonly routes = new Map<string, AutoPatrolPlaybackRoute>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeFrame: () => void;
  private active: ActivePlaybackState | null = null;
  private returnTransition: ReturnTransition | null = null;
  private lastPreStartPose: SceneCameraPose | null = null;
  private snapshot: AutoPatrolPlaybackSnapshot = IDLE_SNAPSHOT;
  private playbackRate: AutoPatrolPlaybackRate = 1;
  private automaticViewMode: AutoPatrolViewMode = 'orbit';
  private manualViewMode: AutoPatrolViewMode | null = null;
  private viewMode: AutoPatrolViewMode = 'orbit';
  private viewTransition: ViewTransition | null = null;
  private lastBasePose: SceneCameraPose | null = null;
  private currentRecord: AutoPatrolInspectionRecord | null = null;
  private recordStartedAtMs = 0;
  private nextTrajectorySampleAtMs = 0;
  private lastTrajectoryObservation: TrajectoryObservation | null = null;
  private lastSpatialObservation: SpatialObservation | null = null;
  private readonly firedOnceEventIds = new Set<string>();
  private readonly eventLastTriggeredAtMs = new Map<string, number>();
  private readonly regionMembership = new Set<string>();
  private readonly distanceEventMembership = new Set<string>();
  private readonly pendingScreenshotCaptures = new Map<Promise<void>, AutoPatrolInspectionRecord>();
  private readonly limits: AutoPatrolPlaybackLimits;
  private pendingInspectionStartTaskId: string | null = null;
  private pendingInspectionStartAtMs = 0;
  private disposed = false;

  constructor(
    private readonly adapter: AutoPatrolPlaybackAdapter,
    limits: Partial<AutoPatrolPlaybackLimits> = {},
  ) {
    this.limits = resolvePlaybackLimits(limits);
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
      || next.component !== active.sourceComponent
      || next.transform !== active.route.transform
    ) {
      this.stop();
      return;
    }
    active.route = { ...next, component: resolveAutoPatrolComponent(next.component) };
    this.publishActiveSnapshot();
  }

  start(routeId: string): AutoPatrolPlaybackResult {
    if (this.disposed) return { ok: false, error: '巡检播放控制器已释放。' };
    const route = this.routes.get(routeId);
    if (!route) return { ok: false, error: '巡检路线不存在。' };
    if (!route.component.enabled) return { ok: false, error: '巡检路线未启用。' };
    if (route.component.waypoints.length < AUTO_PATROL_MIN_WAYPOINTS) {
      return { ok: false, error: '巡检路线至少需要 ' + AUTO_PATROL_MIN_WAYPOINTS + ' 个节点。' };
    }

    this.finishInspectionRecord('stopped');
    this.returnTransition = null;
    this.viewTransition = null;
    const now = this.adapter.now();
    const preStartPose = clonePose(this.adapter.readPose());
    const resolvedRoute = { ...route, component: resolveAutoPatrolComponent(route.component) };
    const poses = resolvedRoute.component.waypoints.map((waypoint) => (
      getAutoPatrolWaypointWorldPose(waypoint, route.transform)
    ));
    this.lastPreStartPose = clonePose(preStartPose);
    this.playbackRate = 1;
    this.automaticViewMode = 'orbit';
    this.manualViewMode = null;
    this.viewMode = 'orbit';
    this.lastBasePose = clonePose(preStartPose);
    this.lastSpatialObservation = { position: getSceneCameraPosition(preStartPose), observedAtMs: now };
    this.firedOnceEventIds.clear();
    this.eventLastTriggeredAtMs.clear();
    this.regionMembership.clear();
    this.distanceEventMembership.clear();
    this.active = {
      route: resolvedRoute,
      sourceComponent: route.component,
      poses,
      phase: 'moving',
      targetIndex: 0,
      sourceIndex: null,
      direction: 1,
      fromPose: clonePose(preStartPose),
      segmentStartedAtMs: now,
      segmentDurationMs: this.resolveSegmentDurationMs(resolvedRoute.component, preStartPose, poses[0], 0),
      dwellStartedAtMs: 0,
      dwellDurationMs: 0,
      pausedAtMs: 0,
      pausedFromPhase: null,
      pausedPose: null,
      pausedByManualInput: false,
      cameraChangedWhilePaused: false,
      dwellOverrideAfterArrivalMs: null,
    };
    const inspectionStartResult = this.beginInspectionRecord(resolvedRoute, now);
    if (!inspectionStartResult.ok) {
      this.resetPlaybackToIdle();
      return inspectionStartResult;
    }
    this.publishActiveSnapshot();
    this.update();
    return { ok: true };
  }

  setPlaybackRate(rate: number): AutoPatrolPlaybackResult {
    if (rate !== 0.5 && rate !== 1 && rate !== 2 && rate !== 4) {
      return { ok: false, error: '巡检倍速仅支持 0.5x、1x、2x、4x。' };
    }
    if (rate === this.playbackRate) return { ok: true };
    const previousRate = this.playbackRate;
    this.update();
    const active = this.active;
    const now = active?.phase === 'paused' ? active.pausedAtMs : this.adapter.now();
    const phase = active?.phase === 'paused' ? active.pausedFromPhase : active?.phase;
    if (active && phase === 'moving' && active.segmentDurationMs > 0) {
      const oldDuration = active.segmentDurationMs / previousRate;
      const progress = Math.min(1, Math.max(0, (now - active.segmentStartedAtMs) / oldDuration));
      active.segmentStartedAtMs = now - progress * (active.segmentDurationMs / rate);
    } else if (active && phase === 'dwelling' && active.dwellDurationMs > 0) {
      const oldDuration = active.dwellDurationMs / previousRate;
      const progress = Math.min(1, Math.max(0, (now - active.dwellStartedAtMs) / oldDuration));
      active.dwellStartedAtMs = now - progress * (active.dwellDurationMs / rate);
    }
    this.playbackRate = rate;
    if (active) this.publishActiveSnapshot();
    else this.publishSnapshot({ ...this.snapshot, playbackRate: rate });
    return { ok: true };
  }

  skipCurrentWaypoint(): AutoPatrolPlaybackResult {
    this.update();
    const active = this.active;
    if (!active || active.phase === 'completed') return { ok: false, error: '当前没有可跳过的巡检点。' };
    const currentIndex = active.targetIndex;
    const lastIndex = active.poses.length - 1;
    let nextIndex: number;
    if (active.route.component.playbackMode === 'once') {
      if (currentIndex >= lastIndex) {
        active.phase = 'completed';
        this.finishInspectionRecord('completed');
        this.publishActiveSnapshot();
        return { ok: true };
      }
      nextIndex = currentIndex + 1;
      active.direction = 1;
    } else if (active.route.component.playbackMode === 'loop') {
      nextIndex = currentIndex >= lastIndex ? 0 : currentIndex + 1;
      active.direction = 1;
    } else {
      if (active.direction > 0 && currentIndex >= lastIndex) active.direction = -1;
      else if (active.direction < 0 && currentIndex <= 0) active.direction = 1;
      nextIndex = currentIndex + active.direction;
    }

    const now = this.adapter.now();
    const fromPose = clonePose(this.lastBasePose ?? this.adapter.readPose());
    active.phase = 'moving';
    active.pausedFromPhase = null;
    active.pausedPose = null;
    active.pausedByManualInput = false;
    active.cameraChangedWhilePaused = false;
    active.sourceIndex = null;
    active.targetIndex = nextIndex;
    active.fromPose = fromPose;
    active.segmentStartedAtMs = now;
    active.segmentDurationMs = this.resolveSegmentDurationMs(active.route.component, fromPose, active.poses[nextIndex], nextIndex);
    active.dwellStartedAtMs = 0;
    active.dwellDurationMs = 0;
    active.dwellOverrideAfterArrivalMs = null;
    this.manualViewMode = null;
    this.viewTransition = null;
    this.publishActiveSnapshot();
    this.update();
    return { ok: true };
  }

  emergencyStop(): void {
    this.finishInspectionRecord('emergency-stopped');
    this.resetPlaybackToIdle();
  }

  triggerManualEvent(eventId: string): AutoPatrolPlaybackResult {
    const active = this.active;
    if (!active || active.phase === 'completed') return { ok: false, error: '当前没有运行中的巡检任务。' };
    const event = active.route.component.events.find((candidate) => (
      candidate.id === eventId && candidate.enabled && candidate.trigger.kind === 'manual'
    ));
    if (!event) return { ok: false, error: '手动巡检事件不存在或未启用。' };
    return this.emitInspectionEvent(event, this.adapter.now())
      ? { ok: true }
      : { ok: false, error: '巡检事件仍在冷却中。' };
  }

  /** 运行态点击设备时触发绑定到该设备的手动事件。 */
  triggerManualEventsForTarget(targetEntityId: string): number {
    const active = this.active;
    if (!active || active.phase === 'completed' || !targetEntityId) return 0;
    let triggeredCount = 0;
    const now = this.adapter.now();
    for (const event of active.route.component.events) {
      if (
        event.enabled
        && event.trigger.kind === 'manual'
        && event.targetEntityId === targetEntityId
        && this.emitInspectionEvent(event, now)
      ) triggeredCount += 1;
    }
    return triggeredCount;
  }

  setManualViewMode(mode: AutoPatrolViewMode): AutoPatrolPlaybackResult {
    const active = this.active;
    if (!active || active.phase === 'completed') return { ok: false, error: '当前没有运行中的巡检任务。' };
    if (active.phase === 'moving' || active.phase === 'dwelling') this.pause(true);
    const now = this.adapter.now();
    const transitionDurationMs = secondsToMilliseconds(active.route.component.camera.transitionSeconds);
    this.manualViewMode = mode;
    this.viewTransition = transitionDurationMs > 0
      ? {
          fromPose: clonePose(this.adapter.readPose()),
          startedAtMs: now,
          durationMs: transitionDurationMs,
          targetMode: mode,
        }
      : null;
    active.pausedByManualInput = active.phase === 'paused';
    if (this.lastBasePose) this.writeViewPose(this.lastBasePose, now, true);
    this.publishActiveSnapshot();
    return { ok: true };
  }

  resumeAutomaticView(): AutoPatrolPlaybackResult {
    const active = this.active;
    if (!active || !this.manualViewMode) return { ok: false, error: '当前未处于手动视角。' };
    this.manualViewMode = null;
    const transitionDurationMs = secondsToMilliseconds(active.route.component.camera.transitionSeconds);
    this.viewTransition = transitionDurationMs > 0
      ? {
          fromPose: clonePose(this.adapter.readPose()),
          startedAtMs: this.adapter.now(),
          durationMs: transitionDurationMs,
          targetMode: this.automaticViewMode,
        }
      : null;
    if (active.phase === 'paused') {
      active.pausedPose = clonePose(this.adapter.readPose());
      active.cameraChangedWhilePaused = false;
      const result = this.resume();
      if (result.ok) this.update();
      return result;
    }
    this.publishActiveSnapshot();
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
      this.manualViewMode = 'first-person';
      this.viewTransition = null;
      this.viewMode = 'first-person';
      this.publishActiveSnapshot();
      return;
    }
    if (active.phase === 'paused' && !active.pausedByManualInput) {
      active.pausedByManualInput = true;
      this.manualViewMode = 'first-person';
      this.viewTransition = null;
      this.viewMode = 'first-person';
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
      active.dwellOverrideAfterArrivalMs = Math.max(0, active.dwellDurationMs - elapsedDwell * this.playbackRate);
    } else {
      active.dwellOverrideAfterArrivalMs = null;
    }
    active.phase = 'moving';
    active.sourceIndex = null;
    active.fromPose = currentPose;
    this.lastBasePose = clonePose(currentPose);
    active.segmentStartedAtMs = now;
    active.segmentDurationMs = this.resolveSegmentDurationMs(active.route.component, currentPose, active.poses[active.targetIndex], active.targetIndex);
    this.publishActiveSnapshot();
    this.update();
    return { ok: true };
  }

  stop(): void {
    this.finishInspectionRecord('stopped');
    this.resetPlaybackToIdle();
  }

  returnToStart(): AutoPatrolPlaybackResult {
    if (!this.lastPreStartPose) return { ok: false, error: '没有可恢复的巡检前视角。' };
    this.finishInspectionRecord('stopped');
    const now = this.adapter.now();
    this.active = null;
    this.currentRecord = null;
    this.viewTransition = null;
    this.manualViewMode = null;
    this.returnTransition = {
      fromPose: clonePose(this.adapter.readPose()),
      toPose: clonePose(this.lastPreStartPose),
      startedAtMs: now,
      durationMs: RETURN_TO_START_DURATION_MS,
    };
    this.publishSnapshot({ ...IDLE_SNAPSHOT, phase: 'returning', canReturnToStart: true });
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
    this.finishInspectionRecord('stopped');
    this.unsubscribeFrame();
    this.listeners.clear();
    this.active = null;
    this.returnTransition = null;
    this.currentRecord = null;
  }

  private update(): void {
    if (this.disposed) return;
    if (this.pendingInspectionStartTaskId !== null) return;
    const now = this.adapter.now();
    if (this.returnTransition) {
      this.updateReturnTransition(now);
      return;
    }
    let active = this.active;
    if (!active) return;
    if (active.phase === 'paused') {
      if (this.viewTransition && this.lastBasePose) this.writeViewPose(this.lastBasePose, now, true);
      this.captureTrajectorySamples(now);
      return;
    }
    if (active.phase === 'completed') return;

    for (let guard = 0; guard < MAX_PHASE_ADVANCES_PER_FRAME; guard += 1) {
      active = this.active;
      if (!active || active.phase === 'paused' || active.phase === 'completed') return;
      if (active.phase === 'dwelling') {
        const dwellEnd = active.dwellStartedAtMs + this.getEffectiveDurationMs(active.dwellDurationMs);
        const basePose = active.poses[active.targetIndex];
        this.writeViewPose(basePose, now, true);
        this.evaluateSpatialEvents(basePose, Math.min(now, dwellEnd));
        this.captureTrajectorySamples(this.active?.phase === 'paused' ? now : Math.min(now, dwellEnd));
        if (this.active?.phase === 'paused' || now < dwellEnd) return;
        this.beginNextSegment(active, dwellEnd);
        continue;
      }

      const movingActive = active;
      const effectiveSegmentDurationMs = this.getEffectiveDurationMs(active.segmentDurationMs);
      const segmentEnd = active.segmentStartedAtMs + effectiveSegmentDurationMs;
      if (effectiveSegmentDurationMs > 0 && now < segmentEnd) {
        const progress = (now - active.segmentStartedAtMs) / effectiveSegmentDurationMs;
        const basePose = this.interpolateActiveSegment(active, progress);
        this.writeViewPose(basePose, now, true);
        this.evaluateSpatialEvents(basePose, now);
        this.captureTrajectorySamples(now, (sampleAtMs) => (
          this.resolveMovingTrajectorySample(movingActive, sampleAtMs, effectiveSegmentDurationMs)
        ));
        return;
      }

      const basePose = active.poses[active.targetIndex];
      this.writeViewPose(basePose, now, true);
      const arrivalTime = effectiveSegmentDurationMs > 0 ? segmentEnd : active.segmentStartedAtMs;
      this.captureTrajectorySamples(arrivalTime, (sampleAtMs) => (
        this.resolveMovingTrajectorySample(movingActive, sampleAtMs, effectiveSegmentDurationMs)
      ));
      const waypoint = active.route.component.waypoints[active.targetIndex];
      const dwellDurationMs = active.dwellOverrideAfterArrivalMs
        ?? secondsToMilliseconds(waypoint.dwellSeconds);
      active.dwellOverrideAfterArrivalMs = null;
      active.phase = 'dwelling';
      active.dwellStartedAtMs = arrivalTime;
      active.dwellDurationMs = dwellDurationMs;
      this.publishActiveSnapshot();
      this.evaluateSpatialEvents(basePose, arrivalTime);
      this.handleWaypointArrival(active.targetIndex, arrivalTime);
      const dwellEnd = arrivalTime + this.getEffectiveDurationMs(dwellDurationMs);
      this.captureTrajectorySamples(this.active?.phase === 'paused' ? now : Math.min(now, dwellEnd));
      if (this.active?.phase === 'paused') return;
      if (now < dwellEnd) return;
      if (!this.beginNextSegment(active, dwellEnd)) return;
    }
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

  private resolveMovingTrajectorySample(
    active: ActivePlaybackState,
    sampleAtMs: number,
    effectiveSegmentDurationMs: number,
  ): TrajectorySampleState {
    const progress = effectiveSegmentDurationMs <= 0
      ? 1
      : Math.min(1, Math.max(0, (sampleAtMs - active.segmentStartedAtMs) / effectiveSegmentDurationMs));
    const basePose = this.interpolateActiveSegment(active, progress);
    const sampleViewMode = this.manualViewMode ?? this.resolveAutomaticViewMode(basePose);
    return {
      pose: this.createViewPose(basePose, sampleViewMode),
      phase: 'moving',
      waypointIndex: active.targetIndex,
      viewMode: sampleViewMode,
    };
  }

  private beginNextSegment(active: ActivePlaybackState, startedAtMs: number): boolean {
    const lastIndex = active.poses.length - 1;
    const arrivedIndex = active.targetIndex;
    let nextIndex: number;
    if (active.route.component.playbackMode === 'once') {
      if (arrivedIndex >= lastIndex) {
        active.phase = 'completed';
        this.finishInspectionRecord('completed');
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
    active.segmentDurationMs = this.resolveSegmentDurationMs(active.route.component, active.fromPose, active.poses[nextIndex], nextIndex);
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

  private getEffectiveDurationMs(durationMs: number): number {
    return durationMs <= 0 ? 0 : durationMs / this.playbackRate;
  }

  private resolveSegmentDurationMs(
    component: ResolvedAutoPatrolComponent,
    fromPose: SceneCameraPose,
    toPose: SceneCameraPose,
    targetIndex: number,
  ): number {
    if (!component.useRouteSpeed) {
      return secondsToMilliseconds(component.waypoints[targetIndex].travelDurationSeconds);
    }
    // 路线速度描述巡检员在地面的行进速度；眼高或旧数据的 Y 差异不应拉长行程。
    const distanceMeters = horizontalDistance(getSceneCameraPosition(fromPose), getSceneCameraPosition(toPose));
    return secondsToMilliseconds(distanceMeters / component.speedMetersPerSecond);
  }

  private resolveAutomaticViewMode(basePose: SceneCameraPose): AutoPatrolViewMode {
    const active = this.active;
    if (!active || !active.route.component.automaticViewSwitching) return 'orbit';
    const position = getSceneCameraPosition(basePose);
    if (active.route.component.triggerRegions.some((region) => (
      region.enabled
      && region.alert
      && isWorldPointInsideAutoPatrolRegion(position, region, active.route.transform)
    ))) return 'first-person';
    const targetPose = active.poses[active.targetIndex];
    return vectorDistance(position, getSceneCameraPosition(targetPose))
      <= active.route.component.camera.approachDistanceMeters
      ? 'orbit'
      : 'third-person';
  }

  private createViewPose(basePose: SceneCameraPose, mode: AutoPatrolViewMode): SceneCameraPose {
    const active = this.active;
    if (!active || mode === 'orbit') return clonePose(basePose);
    const config = active.route.component.camera;
    const basePosition = getSceneCameraPosition(basePose);
    const direction = normalizeVector(subtractVector(basePose.target, basePosition), { x: 0, y: 0, z: 1 });
    if (mode === 'first-person') {
      const position = { ...basePosition, y: active.route.transform.position.y + config.eyeHeightMeters };
      return createSceneCameraPose(position, addVector(position, scaleVector(direction, Math.max(1, basePose.radius))));
    }
    const horizontalDirection = normalizeVector({ x: direction.x, y: 0, z: direction.z }, { x: 0, y: 0, z: 1 });
    const followedDirection = rotateAroundY(horizontalDirection, degreesToRadians(config.thirdPersonRotationOffsetDegrees));
    const position = {
      x: basePosition.x - followedDirection.x * config.thirdPersonDistanceMeters,
      y: basePosition.y + config.thirdPersonHeightMeters,
      z: basePosition.z - followedDirection.z * config.thirdPersonDistanceMeters,
    };
    return createSceneCameraPose(position, basePosition);
  }

  private writeViewPose(basePose: SceneCameraPose, now: number, allowTransition: boolean): void {
    this.lastBasePose = clonePose(basePose);
    const automaticMode = this.resolveAutomaticViewMode(basePose);
    if (automaticMode !== this.automaticViewMode) {
      this.automaticViewMode = automaticMode;
      if (!this.manualViewMode && allowTransition && this.active) {
        const durationMs = secondsToMilliseconds(this.active.route.component.camera.transitionSeconds);
        this.viewTransition = durationMs > 0
          ? {
              fromPose: clonePose(this.adapter.readPose()),
              startedAtMs: now,
              durationMs,
              targetMode: automaticMode,
            }
          : null;
      }
    }
    const targetMode = this.manualViewMode ?? this.automaticViewMode;
    const targetPose = this.createViewPose(basePose, targetMode);
    if (!allowTransition) this.viewTransition = null;
    const transition = this.viewTransition;
    if (transition && transition.targetMode === targetMode) {
      const progress = transition.durationMs <= 0
        ? 1
        : Math.min(1, Math.max(0, (now - transition.startedAtMs) / transition.durationMs));
      this.adapter.writePose(interpolateAutoPatrolPose(
        transition.fromPose,
        targetPose,
        transition.fromPose,
        targetPose,
        progress,
        'linear',
        true,
      ));
      if (progress >= 1) this.viewTransition = null;
    } else {
      this.adapter.writePose(targetPose);
    }
    this.viewMode = targetMode;
    this.publishActiveSnapshot();
  }

  private evaluateSpatialEvents(basePose: SceneCameraPose, now: number): void {
    const active = this.active;
    if (!active) return;
    const position = getSceneCameraPosition(basePose);
    const previous = this.lastSpatialObservation && this.lastSpatialObservation.observedAtMs <= now
      ? this.lastSpatialObservation
      : { position, observedAtMs: now };
    for (const region of active.route.component.triggerRegions) {
      const wasInside = this.regionMembership.has(region.id);
      const isInside = region.enabled
        && isWorldPointInsideAutoPatrolRegion(position, region, active.route.transform);
      const intersection = region.enabled
        ? intersectWorldSegmentWithAutoPatrolRegion(
            previous.position,
            position,
            region,
            active.route.transform,
          )
        : null;
      if (isInside) this.regionMembership.add(region.id);
      else this.regionMembership.delete(region.id);
      if (!wasInside && isInside) {
        const fraction = intersection?.enterFraction ?? 1;
        this.emitRegionEvents(
          region.id,
          'region-enter',
          interpolateNumber(previous.observedAtMs, now, fraction),
          interpolateVector(previous.position, position, fraction),
        );
      } else if (wasInside && !isInside) {
        const fraction = intersection?.leaveFraction ?? 1;
        this.emitRegionEvents(
          region.id,
          'region-leave',
          interpolateNumber(previous.observedAtMs, now, fraction),
          interpolateVector(previous.position, position, fraction),
        );
      } else if (
        !wasInside
        && !isInside
        && intersection
        && intersection.leaveFraction - intersection.enterFraction > POSE_COMPARISON_EPSILON
      ) {
        this.emitRegionEvents(
          region.id,
          'region-enter',
          interpolateNumber(previous.observedAtMs, now, intersection.enterFraction),
          interpolateVector(previous.position, position, intersection.enterFraction),
        );
        this.emitRegionEvents(
          region.id,
          'region-leave',
          interpolateNumber(previous.observedAtMs, now, intersection.leaveFraction),
          interpolateVector(previous.position, position, intersection.leaveFraction),
        );
      }
    }
    for (const event of active.route.component.events) {
      const trigger = event.trigger;
      if (!event.enabled || trigger.kind !== 'distance') continue;
      const waypointIndex = active.route.component.waypoints.findIndex((waypoint) => waypoint.id === trigger.waypointId);
      if (waypointIndex < 0) continue;
      const waypointPosition = getSceneCameraPosition(active.poses[waypointIndex]);
      const isInside = vectorDistance(position, waypointPosition)
        <= trigger.radiusMeters + POSE_COMPARISON_EPSILON;
      const wasInside = this.distanceEventMembership.has(event.id);
      if (isInside) this.distanceEventMembership.add(event.id);
      else this.distanceEventMembership.delete(event.id);
      if (wasInside) continue;
      const intersection = intersectSegmentSphere(
        previous.position,
        position,
        waypointPosition,
        trigger.radiusMeters + POSE_COMPARISON_EPSILON,
      );
      if (intersection) {
        this.emitInspectionEvent(
          event,
          interpolateNumber(previous.observedAtMs, now, intersection.enterFraction),
          interpolateVector(previous.position, position, intersection.enterFraction),
        );
      }
    }
    this.lastSpatialObservation = { position, observedAtMs: now };
  }

  private emitRegionEvents(
    regionId: string,
    triggerKind: 'region-enter' | 'region-leave',
    now: number,
    position: Vector3Data,
  ): void {
    const active = this.active;
    if (!active) return;
    for (const event of active.route.component.events) {
      if (
        event.enabled
        && event.trigger.kind === triggerKind
        && event.trigger.regionId === regionId
      ) this.emitInspectionEvent(event, now, position);
    }
  }

  private handleWaypointArrival(waypointIndex: number, now: number): void {
    const active = this.active;
    if (!active) return;
    const waypoint = active.route.component.waypoints[waypointIndex];
    const actionIds = new Set(waypoint.arrivalActions);
    for (const event of active.route.component.events) {
      if (!event.enabled) continue;
      const waypointTrigger = event.trigger.kind === 'waypoint' && event.trigger.waypointId === waypoint.id;
      if (waypointTrigger || actionIds.has(event.id)) this.emitInspectionEvent(event, now);
    }
  }

  private emitInspectionEvent(
    event: AutoPatrolEventDefinition,
    now: number,
    positionOverride?: Vector3Data,
  ): boolean {
    const record = this.currentRecord;
    if (!record || record.status !== 'running') return false;
    if (record.events.length >= this.limits.maxEvents) return false;
    const oncePerPatrol = event.oncePerPatrol || event.trigger.kind === 'distance';
    if (oncePerPatrol && this.firedOnceEventIds.has(event.id)) return false;
    const lastTriggeredAt = this.eventLastTriggeredAtMs.get(event.id);
    if (lastTriggeredAt !== undefined && now - lastTriggeredAt < secondsToMilliseconds(event.cooldownSeconds)) {
      return false;
    }
    this.eventLastTriggeredAtMs.set(event.id, now);
    if (oncePerPatrol) this.firedOnceEventIds.add(event.id);
    const occurrence: AutoPatrolInspectionEvent = {
      occurrenceId: createRuntimeId('patrol_event'),
      eventId: event.id,
      name: event.name,
      anomaly: event.anomaly === true || hasLegacyAnomalyFlag(event.businessData),
      triggeredAt: record.startedAt + this.getRecordElapsedMs(now),
      elapsedMs: this.getRecordElapsedMs(now),
      trigger: { ...event.trigger },
      responses: [...event.responses],
      targetEntityId: event.targetEntityId,
      position: positionOverride
        ? { ...positionOverride }
        : getSceneCameraPosition(this.lastBasePose ?? this.adapter.readPose()),
      businessData: { ...event.businessData },
    };
    record.events.push(occurrence);
    if (event.responses.includes('pause')) this.pauseForEvent(now);
    this.publishActiveSnapshot(occurrence);
    if (this.adapter.onInspectionEvent) {
      try {
        this.adapter.onInspectionEvent(cloneInspectionEvent(occurrence));
      } catch (error) {
        console.error('[AutoPatrol] 巡检事件回调失败。', error);
      }
    }
    if (
      event.responses.includes('screenshot')
      && this.adapter.captureScreenshot
      && this.hasScreenshotCapacity(record)
    ) {
      let screenshotResult: Promise<string | null>;
      try {
        screenshotResult = this.adapter.captureScreenshot();
      } catch (error) {
        console.warn('[AutoPatrol] 巡检截图采集失败。', error);
        return true;
      }
      let captureTask!: Promise<void>;
      captureTask = withTimeout(
        Promise.resolve(screenshotResult),
        this.limits.screenshotCaptureTimeoutMs,
        '巡检截图采集超时。',
      )
        .then((dataUrl) => {
          this.pendingScreenshotCaptures.delete(captureTask);
          if (
            !dataUrl
            || dataUrl.length > this.limits.maxScreenshotDataUrlLength
            || !dataUrl.startsWith('data:image/png;base64,')
            || record.screenshots.length >= this.limits.maxScreenshots
          ) return;
          occurrence.screenshotDataUrl = dataUrl;
          const screenshot = {
            occurrenceId: occurrence.occurrenceId,
            capturedAt: this.getWallNow(),
            dataUrl,
          };
          record.screenshots.push(screenshot);
          if (this.adapter.onInspectionScreenshot) {
            try {
              const result = this.adapter.onInspectionScreenshot(
                cloneInspectionEvent(occurrence),
                { ...screenshot },
              );
              if (result && typeof result.then === 'function') {
                void result.catch((error) => console.error('[AutoPatrol] 巡检截图持久化失败。', error));
              }
            } catch (error) {
              console.error('[AutoPatrol] 巡检截图持久化失败。', error);
            }
          }
          if (this.currentRecord === record) this.publishActiveSnapshot();
        })
        .catch((error) => {
          this.pendingScreenshotCaptures.delete(captureTask);
          console.warn('[AutoPatrol] 巡检截图采集失败。', error);
        });
      this.pendingScreenshotCaptures.set(captureTask, record);
    }
    return true;
  }

  private hasScreenshotCapacity(record: AutoPatrolInspectionRecord): boolean {
    if (this.pendingScreenshotCaptures.size >= this.limits.maxPendingScreenshotCaptures) return false;
    let pendingForRecord = 0;
    for (const pendingRecord of this.pendingScreenshotCaptures.values()) {
      if (pendingRecord === record) pendingForRecord += 1;
    }
    return record.screenshots.length + pendingForRecord < this.limits.maxScreenshots;
  }

  private pauseForEvent(now: number): void {
    const active = this.active;
    if (!active || (active.phase !== 'moving' && active.phase !== 'dwelling')) return;
    active.pausedFromPhase = active.phase;
    active.pausedAtMs = now;
    active.pausedPose = clonePose(this.adapter.readPose());
    active.pausedByManualInput = false;
    active.cameraChangedWhilePaused = false;
    active.phase = 'paused';
  }

  private beginInspectionRecord(
    route: AutoPatrolPlaybackRoute & { component: ResolvedAutoPatrolComponent },
    now: number,
  ): AutoPatrolPlaybackResult {
    this.pendingInspectionStartTaskId = null;
    this.pendingInspectionStartAtMs = 0;
    this.recordStartedAtMs = now;
    this.nextTrajectorySampleAtMs = now;
    this.lastTrajectoryObservation = null;
    this.currentRecord = {
      taskId: createRuntimeId('patrol_task'),
      routeId: route.entityId,
      routeName: route.name,
      startedAt: this.getWallNow(),
      endedAt: null,
      durationMs: 0,
      status: 'running',
      trajectory: [],
      events: [],
      screenshots: [],
    };
    if (!this.adapter.onInspectionStart) return { ok: true };
    const taskId = this.currentRecord.taskId;
    try {
      const result = this.adapter.onInspectionStart(cloneInspectionRecord(this.currentRecord));
      if (!result || typeof result.then !== 'function') return { ok: true };
      this.pendingInspectionStartTaskId = taskId;
      this.pendingInspectionStartAtMs = now;
      void result.then(
        () => this.handleInspectionStartReady(taskId),
        (error) => this.handleInspectionStartFailure(taskId, error),
      );
      return { ok: true };
    } catch (error) {
      this.currentRecord = null;
      return { ok: false, error: `巡检任务开始持久化失败：${getErrorMessage(error)}` };
    }
  }

  private handleInspectionStartReady(taskId: string): void {
    if (
      this.disposed
      || this.pendingInspectionStartTaskId !== taskId
      || this.currentRecord?.taskId !== taskId
    ) return;
    const pendingDurationMs = Math.max(0, this.adapter.now() - this.pendingInspectionStartAtMs);
    if (this.active?.phase === 'moving') this.active.segmentStartedAtMs += pendingDurationMs;
    if (this.lastSpatialObservation) this.lastSpatialObservation.observedAtMs += pendingDurationMs;
    this.pendingInspectionStartTaskId = null;
    this.pendingInspectionStartAtMs = 0;
    this.update();
  }

  private handleInspectionStartFailure(taskId: string, error: unknown): void {
    console.error('[AutoPatrol] 巡检任务开始持久化失败。', error);
    if (
      this.disposed
      || this.pendingInspectionStartTaskId !== taskId
      || this.currentRecord?.taskId !== taskId
    ) return;
    this.resetPlaybackToIdle();
  }

  private captureTrajectorySamples(
    now: number,
    resolveSampleAtMs?: (sampleAtMs: number) => TrajectorySampleState,
  ): void {
    const record = this.currentRecord;
    if (!record || record.status !== 'running') return;
    const resolvedObservation = resolveSampleAtMs?.(now);
    const observation: TrajectoryObservation = {
      observedAtMs: now,
      pose: resolvedObservation?.pose ?? clonePose(this.adapter.readPose()),
      phase: resolvedObservation?.phase ?? this.active?.phase ?? 'idle',
      waypointIndex: resolvedObservation?.waypointIndex ?? this.active?.targetIndex ?? null,
      viewMode: resolvedObservation?.viewMode ?? this.viewMode,
    };
    const previous = this.lastTrajectoryObservation;
    const appendedSamples: AutoPatrolInspectionTrajectorySample[] = [];
    while (this.nextTrajectorySampleAtMs <= now && record.trajectory.length < MAX_TRAJECTORY_SAMPLES) {
      const sampleAtMs = this.nextTrajectorySampleAtMs;
      const elapsedMs = this.getRecordElapsedMs(sampleAtMs);
      const progress = previous && now > previous.observedAtMs
        ? Math.min(1, Math.max(0, (sampleAtMs - previous.observedAtMs) / (now - previous.observedAtMs)))
        : 1;
      const resolvedSample = resolveSampleAtMs?.(sampleAtMs);
      const metadata = resolvedSample ?? observation;
      const samplePose = resolvedSample?.pose ?? (previous
        ? interpolateAutoPatrolPose(
            previous.pose,
            observation.pose,
            previous.pose,
            observation.pose,
            progress,
            'linear',
            true,
          )
        : clonePose(observation.pose));
      const sample: AutoPatrolInspectionTrajectorySample = {
        elapsedMs,
        capturedAt: record.startedAt + elapsedMs,
        pose: samplePose,
        phase: metadata.phase,
        waypointIndex: metadata.waypointIndex,
        viewMode: metadata.viewMode,
      };
      record.trajectory.push(sample);
      appendedSamples.push(cloneTrajectorySample(sample));
      this.nextTrajectorySampleAtMs += TRAJECTORY_SAMPLE_INTERVAL_MS;
    }
    if (!previous || now >= previous.observedAtMs) this.lastTrajectoryObservation = observation;
    if (record.trajectory.length >= MAX_TRAJECTORY_SAMPLES) this.nextTrajectorySampleAtMs = Number.POSITIVE_INFINITY;
    if (appendedSamples.length > 0 && this.adapter.onInspectionTrajectory) {
      this.dispatchInspectionCallback(
        '巡检轨迹增量持久化失败。',
        () => this.adapter.onInspectionTrajectory!(record.taskId, appendedSamples),
      );
    }
  }

  private dispatchInspectionCallback(
    errorMessage: string,
    callback: () => void | Promise<void>,
  ): void {
    try {
      const result = callback();
      if (result && typeof result.then === 'function') {
        void result.catch((error) => console.error(`[AutoPatrol] ${errorMessage}`, error));
      }
    } catch (error) {
      console.error(`[AutoPatrol] ${errorMessage}`, error);
    }
  }

  private finishInspectionRecord(status: AutoPatrolInspectionStatus): void {
    const record = this.currentRecord;
    if (!record || record.status !== 'running') return;
    const now = this.adapter.now();
    this.captureTrajectorySamples(now);
    record.endedAt = this.getWallNow();
    record.durationMs = this.getRecordElapsedMs(now);
    record.status = status;
    const publishRecord = (): void => {
      if (!this.adapter.onInspectionRecord) return;
      try {
        const result = this.adapter.onInspectionRecord(cloneInspectionRecord(record));
        if (result && typeof result.then === 'function') {
          void result.catch((error) => console.error('[AutoPatrol] 巡检记录持久化失败。', error));
        }
      } catch (error) {
        console.error('[AutoPatrol] 巡检记录持久化失败。', error);
      }
    };
    const pendingCaptures = [...this.pendingScreenshotCaptures]
      .filter(([, pendingRecord]) => pendingRecord === record)
      .map(([captureTask]) => captureTask);
    if (pendingCaptures.length > 0) void Promise.allSettled(pendingCaptures).then(publishRecord);
    else publishRecord();
  }

  private getRecordElapsedMs(now: number): number {
    return Math.max(0, now - this.recordStartedAtMs);
  }

  private getWallNow(): number {
    return this.adapter.wallNow?.() ?? Date.now();
  }

  private resetPlaybackToIdle(): void {
    this.active = null;
    this.returnTransition = null;
    this.viewTransition = null;
    this.manualViewMode = null;
    this.automaticViewMode = 'orbit';
    this.viewMode = 'orbit';
    this.lastBasePose = null;
    this.lastSpatialObservation = null;
    this.currentRecord = null;
    this.pendingInspectionStartTaskId = null;
    this.pendingInspectionStartAtMs = 0;
    this.playbackRate = 1;
    this.regionMembership.clear();
    this.distanceEventMembership.clear();
    this.publishSnapshot({ ...IDLE_SNAPSHOT, canReturnToStart: this.lastPreStartPose !== null });
  }

  private publishActiveSnapshot(lastEventOverride?: AutoPatrolInspectionEvent): void {
    const active = this.active;
    if (!active) return;
    const record = this.currentRecord;
    const lastEvent = lastEventOverride ?? record?.events[record.events.length - 1] ?? null;
    this.publishSnapshot({
      phase: active.phase,
      routeId: active.route.entityId,
      routeName: active.route.name,
      currentWaypointIndex: active.targetIndex,
      waypointCount: active.poses.length,
      pausedByManualInput: active.phase === 'paused' && active.pausedByManualInput,
      canReturnToStart: this.lastPreStartPose !== null,
      playbackRate: this.playbackRate,
      viewMode: this.viewMode,
      automaticViewMode: this.automaticViewMode,
      manualCameraOverride: this.manualViewMode !== null,
      taskId: record?.taskId ?? null,
      eventCount: record?.events.length ?? 0,
      lastEvent: lastEvent ? cloneInspectionEvent(lastEvent) : null,
    });
  }

  private publishSnapshot(next: AutoPatrolPlaybackSnapshot): void {
    if (areSnapshotsEqual(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function resolvePlaybackLimits(overrides: Partial<AutoPatrolPlaybackLimits>): AutoPatrolPlaybackLimits {
  return {
    maxEvents: normalizePlaybackLimit(overrides.maxEvents, DEFAULT_PLAYBACK_LIMITS.maxEvents),
    maxScreenshots: normalizePlaybackLimit(overrides.maxScreenshots, DEFAULT_PLAYBACK_LIMITS.maxScreenshots),
    maxPendingScreenshotCaptures: normalizePlaybackLimit(
      overrides.maxPendingScreenshotCaptures,
      DEFAULT_PLAYBACK_LIMITS.maxPendingScreenshotCaptures,
    ),
    maxScreenshotDataUrlLength: normalizePlaybackLimit(
      overrides.maxScreenshotDataUrlLength,
      DEFAULT_PLAYBACK_LIMITS.maxScreenshotDataUrlLength,
    ),
    screenshotCaptureTimeoutMs: normalizePlaybackLimit(
      overrides.screenshotCaptureTimeoutMs,
      DEFAULT_PLAYBACK_LIMITS.screenshotCaptureTimeoutMs,
    ),
  };
}

function normalizePlaybackLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** 按 Hierarchy 顺序收集场景中的巡检路线，供编辑预览和 Viewer 共用。 */
export function collectAutoPatrolPlaybackRoutes(document: SceneDocument): AutoPatrolPlaybackRoute[] {
  const routes: AutoPatrolPlaybackRoute[] = [];
  for (const entityId of document.entityIds) {
    const entity = document.entities[entityId];
    const component = entity?.components.autoPatrol;
    if (!entity || !component) continue;
    routes.push({ entityId: entity.id, name: entity.name, transform: entity.components.transform, component });
  }
  return routes;
}

export function findAutoStartPatrolRoute(routes: readonly AutoPatrolPlaybackRoute[]): AutoPatrolPlaybackRoute | null {
  return routes.find((route) => isPlayableRoute(route) && route.component.autoStart) ?? null;
}

export function findFirstPlayablePatrolRoute(routes: readonly AutoPatrolPlaybackRoute[]): AutoPatrolPlaybackRoute | null {
  return routes.find(isPlayableRoute) ?? null;
}

function isPlayableRoute(route: AutoPatrolPlaybackRoute): boolean {
  return route.component.enabled && route.component.waypoints.length >= AUTO_PATROL_MIN_WAYPOINTS;
}

function secondsToMilliseconds(seconds: number): number {
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 0;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (timeoutMs <= 0) return Promise.reject(new Error(message));
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    const timer = timeout as ReturnType<typeof setTimeout> & { unref?: () => void };
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clonePose(pose: SceneCameraPose): SceneCameraPose {
  return { alpha: pose.alpha, beta: pose.beta, radius: pose.radius, target: { ...pose.target } };
}

function cloneInspectionEvent(event: AutoPatrolInspectionEvent): AutoPatrolInspectionEvent {
  return {
    ...event,
    trigger: { ...event.trigger },
    responses: [...event.responses],
    position: { ...event.position },
    businessData: { ...event.businessData },
  };
}

function hasLegacyAnomalyFlag(
  businessData: AutoPatrolEventDefinition['businessData'],
): boolean {
  return businessData.anomaly === true
    || businessData.abnormal === true
    || businessData.alert === true;
}

function cloneInspectionRecord(record: AutoPatrolInspectionRecord): AutoPatrolInspectionRecord {
  return {
    ...record,
    trajectory: record.trajectory.map(cloneTrajectorySample),
    events: record.events.map(cloneInspectionEvent),
    screenshots: record.screenshots.map((screenshot) => ({ ...screenshot })),
  };
}

function cloneTrajectorySample(
  sample: AutoPatrolInspectionTrajectorySample,
): AutoPatrolInspectionTrajectorySample {
  return { ...sample, pose: clonePose(sample.pose) };
}

function vectorDistance(left: Vector3Data, right: Vector3Data): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function horizontalDistance(left: Vector3Data, right: Vector3Data): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
}

function intersectSegmentSphere(
  start: Vector3Data,
  end: Vector3Data,
  center: Vector3Data,
  radius: number,
): { enterFraction: number; leaveFraction: number } | null {
  const directionX = end.x - start.x;
  const directionY = end.y - start.y;
  const directionZ = end.z - start.z;
  const offsetX = start.x - center.x;
  const offsetY = start.y - center.y;
  const offsetZ = start.z - center.z;
  const a = directionX * directionX + directionY * directionY + directionZ * directionZ;
  if (a <= 1e-18) {
    return offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ <= radius * radius
      ? { enterFraction: 0, leaveFraction: 1 }
      : null;
  }
  const b = 2 * (offsetX * directionX + offsetY * directionY + offsetZ * directionZ);
  const c = offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const enterFraction = Math.max(0, (-b - root) / (2 * a));
  const leaveFraction = Math.min(1, (-b + root) / (2 * a));
  return enterFraction <= leaveFraction ? { enterFraction, leaveFraction } : null;
}

function interpolateNumber(from: number, to: number, progress: number): number {
  return from + (to - from) * Math.min(1, Math.max(0, progress));
}

function interpolateVector(from: Vector3Data, to: Vector3Data, progress: number): Vector3Data {
  const clampedProgress = Math.min(1, Math.max(0, progress));
  return {
    x: interpolateNumber(from.x, to.x, clampedProgress),
    y: interpolateNumber(from.y, to.y, clampedProgress),
    z: interpolateNumber(from.z, to.z, clampedProgress),
  };
}

function normalizeVector(value: Vector3Data, fallback: Vector3Data): Vector3Data {
  const length = Math.hypot(value.x, value.y, value.z);
  return length > 1e-9 ? scaleVector(value, 1 / length) : { ...fallback };
}

function addVector(left: Vector3Data, right: Vector3Data): Vector3Data {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtractVector(left: Vector3Data, right: Vector3Data): Vector3Data {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scaleVector(value: Vector3Data, scale: number): Vector3Data {
  return { x: value.x * scale, y: value.y * scale, z: value.z * scale };
}

function rotateAroundY(value: Vector3Data, radians: number): Vector3Data {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return { x: value.x * cosine + value.z * sine, y: value.y, z: -value.x * sine + value.z * cosine };
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function createRuntimeId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
    ?? Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
  return prefix + '_' + uuid;
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
    && left.canReturnToStart === right.canReturnToStart
    && left.playbackRate === right.playbackRate
    && left.viewMode === right.viewMode
    && left.automaticViewMode === right.automaticViewMode
    && left.manualCameraOverride === right.manualCameraOverride
    && left.taskId === right.taskId
    && left.eventCount === right.eventCount
    && left.lastEvent?.occurrenceId === right.lastEvent?.occurrenceId
    && left.lastEvent?.screenshotDataUrl === right.lastEvent?.screenshotDataUrl;
}
