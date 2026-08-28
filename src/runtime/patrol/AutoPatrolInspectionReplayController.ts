import type { Vector3Data } from '../../editor/model/math';
import type { SceneCameraPose } from '../../editor/model/SceneDocument';
import type {
  AutoPatrolInspectionEventRecord,
  AutoPatrolInspectionRecord,
  AutoPatrolInspectionScreenshot,
  AutoPatrolTrajectorySample,
} from './AutoPatrolInspectionRecordStore';

export type AutoPatrolInspectionReplayRate = 0.5 | 1 | 2 | 4;
export type AutoPatrolInspectionReplayPhase = 'idle' | 'paused' | 'playing' | 'completed';

export type AutoPatrolInspectionReplayCamera = {
  position: Vector3Data;
  rotation: Vector3Data;
};

/** 将历史中的位置和 ArcRotate 角度还原为可直接写入 Babylon 的相机位姿。 */
export function createSceneCameraPoseFromReplayCamera(
  camera: AutoPatrolInspectionReplayCamera,
  radius = 1,
): SceneCameraPose {
  const resolvedRadius = Number.isFinite(radius) ? Math.max(0.01, radius) : 1;
  const alpha = camera.rotation.y;
  const beta = camera.rotation.x;
  const sinBeta = Math.sin(beta);
  const offset = {
    x: resolvedRadius * Math.cos(alpha) * sinBeta,
    y: resolvedRadius * Math.cos(beta),
    z: resolvedRadius * Math.sin(alpha) * sinBeta,
  };
  return {
    alpha,
    beta,
    radius: resolvedRadius,
    target: {
      x: camera.position.x - offset.x,
      y: camera.position.y - offset.y,
      z: camera.position.z - offset.z,
    },
  };
}

export type AutoPatrolInspectionReplayEvent = {
  event: AutoPatrolInspectionEventRecord;
  screenshot: AutoPatrolInspectionScreenshot | null;
};

export type AutoPatrolInspectionReplaySnapshot = {
  phase: AutoPatrolInspectionReplayPhase;
  taskId: string | null;
  elapsedMs: number;
  durationMs: number;
  playbackRate: AutoPatrolInspectionReplayRate;
  activeEventId: string | null;
  activeScreenshot: AutoPatrolInspectionScreenshot | null;
};

export type AutoPatrolInspectionReplayAdapter = {
  now: () => number;
  subscribeFrame: (callback: () => void) => () => void;
  applyCamera: (camera: AutoPatrolInspectionReplayCamera) => void;
  onEvent?: (event: AutoPatrolInspectionReplayEvent) => void;
};

export type AutoPatrolInspectionReplayResult = { ok: true } | { ok: false; error: string };

type LoadedReplay = {
  record: AutoPatrolInspectionRecord;
  trajectory: AutoPatrolTrajectorySample[];
  events: AutoPatrolInspectionEventRecord[];
  durationMs: number;
};

const ALLOWED_RATES = new Set<AutoPatrolInspectionReplayRate>([0.5, 1, 2, 4]);

const IDLE_SNAPSHOT: AutoPatrolInspectionReplaySnapshot = {
  phase: 'idle',
  taskId: null,
  elapsedMs: 0,
  durationMs: 0,
  playbackRate: 1,
  activeEventId: null,
  activeScreenshot: null,
};

/** 历史巡检共用一条虚拟时间轴，保证相机、事件弹窗和截图同步。 */
export class AutoPatrolInspectionReplayController {
  private readonly adapter: AutoPatrolInspectionReplayAdapter;
  private readonly unsubscribeFrame: () => void;
  private readonly listeners = new Set<() => void>();
  private loaded: LoadedReplay | null = null;
  private snapshot: AutoPatrolInspectionReplaySnapshot = IDLE_SNAPSHOT;
  private playbackRate: AutoPatrolInspectionReplayRate = 1;
  private anchorNowMs = 0;
  private anchorElapsedMs = 0;
  private nextEventIndex = 0;
  private disposed = false;

  constructor(adapter: AutoPatrolInspectionReplayAdapter) {
    this.adapter = adapter;
    this.unsubscribeFrame = adapter.subscribeFrame(() => this.update());
  }

  load(record: AutoPatrolInspectionRecord): AutoPatrolInspectionReplayResult {
    if (this.disposed) return { ok: false, error: '巡检历史回放控制器已释放。' };
    const normalized = normalizeRecord(record);
    if (!normalized) return { ok: false, error: '巡检历史缺少有效的轨迹数据。' };
    this.loaded = normalized;
    this.playbackRate = 1;
    this.anchorElapsedMs = 0;
    this.anchorNowMs = this.adapter.now();
    this.nextEventIndex = findNextEventIndex(normalized.events, normalized.record.startedAtMs, true);
    this.applyAt(0);
    this.publish({
      phase: 'paused',
      taskId: normalized.record.taskId,
      elapsedMs: 0,
      durationMs: normalized.durationMs,
      playbackRate: 1,
      activeEventId: null,
      activeScreenshot: null,
    });
    return { ok: true };
  }

  play(): AutoPatrolInspectionReplayResult {
    if (!this.loaded) return { ok: false, error: '请先加载巡检历史。' };
    if (this.snapshot.phase === 'playing') return { ok: true };
    if (this.snapshot.phase === 'completed') {
      this.seek(0);
      this.nextEventIndex = findNextEventIndex(this.loaded.events, this.loaded.record.startedAtMs, true);
    }
    this.anchorElapsedMs = this.snapshot.elapsedMs;
    this.anchorNowMs = this.adapter.now();
    this.publish({ ...this.snapshot, phase: 'playing', activeEventId: null, activeScreenshot: null });
    return { ok: true };
  }

  pause(): AutoPatrolInspectionReplayResult {
    if (!this.loaded) return { ok: false, error: '请先加载巡检历史。' };
    if (this.snapshot.phase !== 'playing') return { ok: true };
    this.update();
    if (this.snapshot.phase !== 'playing') return { ok: true };
    this.anchorElapsedMs = this.snapshot.elapsedMs;
    this.anchorNowMs = this.adapter.now();
    this.publish({ ...this.snapshot, phase: 'paused' });
    return { ok: true };
  }

  setPlaybackRate(rate: AutoPatrolInspectionReplayRate): AutoPatrolInspectionReplayResult {
    if (!ALLOWED_RATES.has(rate)) return { ok: false, error: '回放倍率仅支持 0.5x、1x、2x 和 4x。' };
    if (this.snapshot.phase === 'playing') this.update();
    this.playbackRate = rate;
    this.anchorElapsedMs = this.snapshot.elapsedMs;
    this.anchorNowMs = this.adapter.now();
    this.publish({ ...this.snapshot, playbackRate: rate });
    return { ok: true };
  }

  seek(elapsedMs: number): AutoPatrolInspectionReplayResult {
    const loaded = this.loaded;
    if (!loaded) return { ok: false, error: '请先加载巡检历史。' };
    if (!Number.isFinite(elapsedMs)) return { ok: false, error: '回放时间无效。' };
    const resolvedElapsedMs = clamp(elapsedMs, 0, loaded.durationMs);
    const wasPlaying = this.snapshot.phase === 'playing';
    this.anchorElapsedMs = resolvedElapsedMs;
    this.anchorNowMs = this.adapter.now();
    this.nextEventIndex = findNextEventIndex(loaded.events, loaded.record.startedAtMs + resolvedElapsedMs);
    this.applyAt(resolvedElapsedMs);
    this.publish({
      ...this.snapshot,
      phase: resolvedElapsedMs >= loaded.durationMs ? 'completed' : wasPlaying ? 'playing' : 'paused',
      elapsedMs: resolvedElapsedMs,
      activeEventId: null,
      activeScreenshot: null,
    });
    return { ok: true };
  }

  jumpToEvent(eventId: string): AutoPatrolInspectionReplayResult {
    const loaded = this.loaded;
    if (!loaded) return { ok: false, error: '请先加载巡检历史。' };
    const event = loaded.events.find((candidate) => candidate.id === eventId);
    if (!event) return { ok: false, error: '巡检事件不存在。' };
    const elapsedMs = clamp(event.occurredAtMs - loaded.record.startedAtMs, 0, loaded.durationMs);
    this.seek(elapsedMs);
    const screenshot = resolveEventScreenshot(loaded.record, event);
    this.emitEvent(event, screenshot);
    this.publish({ ...this.snapshot, activeEventId: event.id, activeScreenshot: screenshot });
    return { ok: true };
  }

  getSnapshot(): AutoPatrolInspectionReplaySnapshot {
    return clone(this.snapshot);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeFrame();
    this.listeners.clear();
    this.loaded = null;
    this.snapshot = IDLE_SNAPSHOT;
  }

  private update(): void {
    const loaded = this.loaded;
    if (!loaded || this.snapshot.phase !== 'playing') return;
    const elapsedMs = clamp(
      this.anchorElapsedMs + (this.adapter.now() - this.anchorNowMs) * this.playbackRate,
      0,
      loaded.durationMs,
    );
    this.applyAt(elapsedMs);
    let activeEvent: AutoPatrolInspectionEventRecord | null = null;
    let activeScreenshot: AutoPatrolInspectionScreenshot | null = null;
    const absoluteTimeMs = loaded.record.startedAtMs + elapsedMs;
    while (this.nextEventIndex < loaded.events.length) {
      const event = loaded.events[this.nextEventIndex];
      if (event.occurredAtMs > absoluteTimeMs) break;
      this.nextEventIndex += 1;
      activeEvent = event;
      activeScreenshot = resolveEventScreenshot(loaded.record, event);
      this.emitEvent(event, activeScreenshot);
    }
    this.publish({
      ...this.snapshot,
      phase: elapsedMs >= loaded.durationMs ? 'completed' : 'playing',
      elapsedMs,
      activeEventId: activeEvent?.id ?? this.snapshot.activeEventId,
      activeScreenshot: activeEvent ? activeScreenshot : this.snapshot.activeScreenshot,
    });
  }

  private applyAt(elapsedMs: number): void {
    const loaded = this.loaded;
    if (!loaded) return;
    const absoluteTimeMs = loaded.record.startedAtMs + elapsedMs;
    this.adapter.applyCamera(interpolateTrajectory(loaded.trajectory, absoluteTimeMs));
  }

  private emitEvent(
    event: AutoPatrolInspectionEventRecord,
    screenshot: AutoPatrolInspectionScreenshot | null,
  ): void {
    this.adapter.onEvent?.({ event: clone(event), screenshot: screenshot ? clone(screenshot) : null });
  }

  private publish(snapshot: AutoPatrolInspectionReplaySnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function normalizeRecord(record: AutoPatrolInspectionRecord): LoadedReplay | null {
  const trajectory = record.trajectory
    .filter(isValidTrajectorySample)
    .map(clone)
    .sort((left, right) => left.recordedAtMs - right.recordedAtMs);
  if (trajectory.length === 0 || !Number.isFinite(record.startedAtMs)) return null;
  const events = record.events
    .filter((event) => Number.isFinite(event.occurredAtMs))
    .map(clone)
    .sort((left, right) => left.occurredAtMs - right.occurredAtMs || left.id.localeCompare(right.id));
  const declaredDurationMs = record.durationMs ?? (
    record.endedAtMs === null ? 0 : record.endedAtMs - record.startedAtMs
  );
  const lastTrajectoryElapsedMs = trajectory.at(-1)!.recordedAtMs - record.startedAtMs;
  const lastEventElapsedMs = events.length === 0 ? 0 : events.at(-1)!.occurredAtMs - record.startedAtMs;
  const durationMs = Math.max(0, declaredDurationMs, lastTrajectoryElapsedMs, lastEventElapsedMs);
  return { record: clone(record), trajectory, events, durationMs };
}

function isValidTrajectorySample(sample: AutoPatrolTrajectorySample): boolean {
  return Number.isFinite(sample.recordedAtMs)
    && isFiniteVector(sample.position)
    && isFiniteVector(sample.rotation);
}

function isFiniteVector(value: Vector3Data): boolean {
  return [value.x, value.y, value.z].every(Number.isFinite);
}

function interpolateTrajectory(
  trajectory: readonly AutoPatrolTrajectorySample[],
  absoluteTimeMs: number,
): AutoPatrolInspectionReplayCamera {
  if (absoluteTimeMs <= trajectory[0].recordedAtMs) return cameraFromSample(trajectory[0]);
  const last = trajectory.at(-1)!;
  if (absoluteTimeMs >= last.recordedAtMs) return cameraFromSample(last);

  let low = 0;
  let high = trajectory.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (trajectory[middle].recordedAtMs <= absoluteTimeMs) low = middle;
    else high = middle;
  }
  const from = trajectory[low];
  const to = trajectory[high];
  const progress = (absoluteTimeMs - from.recordedAtMs) / (to.recordedAtMs - from.recordedAtMs);
  return {
    position: interpolateVector(from.position, to.position, progress),
    rotation: {
      x: interpolateAngle(from.rotation.x, to.rotation.x, progress),
      y: interpolateAngle(from.rotation.y, to.rotation.y, progress),
      z: interpolateAngle(from.rotation.z, to.rotation.z, progress),
    },
  };
}

function cameraFromSample(sample: AutoPatrolTrajectorySample): AutoPatrolInspectionReplayCamera {
  return { position: { ...sample.position }, rotation: { ...sample.rotation } };
}

function interpolateVector(from: Vector3Data, to: Vector3Data, progress: number): Vector3Data {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
    z: from.z + (to.z - from.z) * progress,
  };
}

function interpolateAngle(from: number, to: number, progress: number): number {
  const delta = ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return from + delta * progress;
}

function findNextEventIndex(
  events: readonly AutoPatrolInspectionEventRecord[],
  absoluteTimeMs: number,
  includeEqual = false,
): number {
  let index = 0;
  while (
    index < events.length
    && (includeEqual ? events[index].occurredAtMs < absoluteTimeMs : events[index].occurredAtMs <= absoluteTimeMs)
  ) index += 1;
  return index;
}

function resolveEventScreenshot(
  record: AutoPatrolInspectionRecord,
  event: AutoPatrolInspectionEventRecord,
): AutoPatrolInspectionScreenshot | null {
  return event.screenshot ?? record.screenshots.find((screenshot) => screenshot.id === event.id) ?? null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
