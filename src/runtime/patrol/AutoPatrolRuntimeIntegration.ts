import type { AbstractEngine, Camera } from '@babylonjs/core';
import { CreateScreenshotUsingRenderTargetAsync } from '@babylonjs/core/Misc/screenshotTools.pure';
import { getSceneCameraPosition } from '../../editor/model/autoPatrolInspection';
import type {
  AutoPatrolInspectionEvent as PlaybackInspectionEvent,
  AutoPatrolInspectionRecord as PlaybackInspectionRecord,
  AutoPatrolInspectionScreenshot as PlaybackInspectionScreenshot,
  AutoPatrolInspectionTrajectorySample as PlaybackInspectionTrajectorySample,
} from '../babylon/AutoPatrolPlaybackController';
import {
  AutoPatrolInspectionRecordStore,
  type AutoPatrolInspectionEventRecord,
  type AutoPatrolInspectionScreenshot,
} from './AutoPatrolInspectionRecordStore';

export type AutoPatrolRuntimeInspectionContext = {
  taskId: string | null;
  routeId: string | null;
  routeName: string | null;
};

export type AutoPatrolRuntimeIntegrationOptions = {
  engine: AbstractEngine;
  getCamera: () => Camera | null;
  getInspectionContext: () => AutoPatrolRuntimeInspectionContext;
  setHighlightedEntityIds: (entityIds: readonly string[]) => void;
  recordStore?: AutoPatrolInspectionRecordStore;
  scopeId?: string;
  operator?: string | null;
  highlightDurationMs?: number;
  screenshotCaptureTimeoutMs?: number;
  createScreenshot?: () => Promise<string>;
  onError?: (message: string, error: unknown) => void;
};

const SCREENSHOT_SIZE = { width: 1920, height: 1080 } as const;
const DEFAULT_HIGHLIGHT_DURATION_MS = 2_000;
const DEFAULT_SCREENSHOT_CAPTURE_TIMEOUT_MS = 10_000;

type ScopedInspectionContext = AutoPatrolRuntimeInspectionContext & { scopeId: string };

/**
 * 为 Editor 和 Viewer 共享巡检截图、设备高亮和 IndexedDB 记录接线。
 */
export class AutoPatrolRuntimeIntegration {
  readonly recordStore: AutoPatrolInspectionRecordStore;

  private readonly ownsRecordStore: boolean;
  private readonly highlightDurationMs: number;
  private readonly screenshotCaptureTimeoutMs: number;
  private readonly startedTaskIds = new Set<string>();
  private readonly taskContexts = new Map<string, {
    routeId: string;
    routeName: string | null;
    startedAtMs: number;
    scopeId: string;
  }>();
  private readonly screenshotContexts = new Map<string, ScopedInspectionContext>();
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  private screenshotTail: Promise<void> = Promise.resolve();
  private nativeScreenshotCapture: Promise<string> | null = null;
  private persistenceTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: AutoPatrolRuntimeIntegrationOptions) {
    this.recordStore = options.recordStore ?? new AutoPatrolInspectionRecordStore({ scopeId: options.scopeId });
    if (options.recordStore && options.scopeId) options.recordStore.setScope(options.scopeId);
    this.ownsRecordStore = !options.recordStore;
    this.highlightDurationMs = options.highlightDurationMs ?? DEFAULT_HIGHLIGHT_DURATION_MS;
    this.screenshotCaptureTimeoutMs = normalizePositiveTimeout(
      options.screenshotCaptureTimeoutMs,
      DEFAULT_SCREENSHOT_CAPTURE_TIMEOUT_MS,
    );
  }

  captureScreenshot = (): Promise<string | null> => {
    if (this.disposed) return Promise.resolve(null);
    if (this.nativeScreenshotCapture) return Promise.resolve(null);
    const camera = this.options.getCamera();
    if (!camera) return Promise.resolve(null);
    let nativeCapture: Promise<string>;
    try {
      nativeCapture = this.options.createScreenshot
        ? Promise.resolve(this.options.createScreenshot())
        : CreateScreenshotUsingRenderTargetAsync(
            this.options.engine,
            camera,
            SCREENSHOT_SIZE,
            'image/png',
            1,
            true,
          );
    } catch (error) {
      return Promise.reject(error);
    }
    this.nativeScreenshotCapture = nativeCapture;
    void nativeCapture.then(
      () => {
        if (this.nativeScreenshotCapture === nativeCapture) this.nativeScreenshotCapture = null;
      },
      () => {
        if (this.nativeScreenshotCapture === nativeCapture) this.nativeScreenshotCapture = null;
      },
    );
    const capture = withTimeout(nativeCapture, this.screenshotCaptureTimeoutMs, '巡检截图采集超时。');
    this.screenshotTail = capture.then(() => undefined, () => undefined);
    return capture;
  };

  onInspectionEvent = (event: PlaybackInspectionEvent): void => {
    if (this.disposed) return;
    if (event.responses.includes('highlight') && event.targetEntityId) {
      this.highlightTarget(event.targetEntityId);
    }
    const context = this.options.getInspectionContext();
    if (!context.taskId || !context.routeId) return;
    const scopedContext: ScopedInspectionContext = {
      ...context,
      scopeId: this.taskContexts.get(context.taskId)?.scopeId ?? this.recordStore.getScopeId(),
    };
    if (event.responses.includes('screenshot')) {
      this.screenshotContexts.set(event.occurrenceId, scopedContext);
    }
    void this.enqueuePersistence(async () => {
      await this.ensureInspectionStarted(
        scopedContext.taskId!,
        scopedContext.routeId!,
        scopedContext.routeName,
        event.triggeredAt - event.elapsedMs,
        scopedContext.scopeId,
      );
      await this.recordStore.appendEvent(scopedContext.taskId!, toStoredEvent(event), {
        queueForReport: event.responses.includes('report'),
      });
    }).catch(() => undefined);
  };

  onInspectionScreenshot = (
    event: PlaybackInspectionEvent,
    screenshot: PlaybackInspectionScreenshot,
  ): Promise<void> => this.enqueuePersistence(async () => {
    const fallbackContext = this.options.getInspectionContext();
    const context = this.screenshotContexts.get(event.occurrenceId) ?? (
      fallbackContext.taskId && fallbackContext.routeId
        ? {
            ...fallbackContext,
            scopeId: this.taskContexts.get(fallbackContext.taskId)?.scopeId ?? this.recordStore.getScopeId(),
          }
        : null
    );
    this.screenshotContexts.delete(event.occurrenceId);
    if (!context?.taskId || !context.routeId) return;
    await this.ensureInspectionStarted(
      context.taskId,
      context.routeId,
      context.routeName,
      event.triggeredAt - event.elapsedMs,
      context.scopeId,
    );
    await this.recordStore.appendEvent(context.taskId, toStoredEvent(event, {
      id: screenshot.occurrenceId,
      capturedAtMs: screenshot.capturedAt,
      localUrl: screenshot.dataUrl,
      remoteUrl: null,
    }), {
      queueForReport: event.responses.includes('report'),
    });
  });

  onInspectionStart = (record: PlaybackInspectionRecord): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    const context = {
      routeId: record.routeId,
      routeName: record.routeName,
      startedAtMs: record.startedAt,
      scopeId: this.recordStore.getScopeId(),
    };
    this.taskContexts.set(record.taskId, context);
    return this.enqueuePersistence(() => this.ensureInspectionStarted(
      record.taskId,
      context.routeId,
      context.routeName,
      context.startedAtMs,
      context.scopeId,
    )).catch((error) => {
      this.taskContexts.delete(record.taskId);
      this.startedTaskIds.delete(record.taskId);
      throw error;
    });
  };

  onInspectionTrajectory = (
    taskId: string,
    samples: readonly PlaybackInspectionTrajectorySample[],
  ): Promise<void> => {
    if (this.disposed || samples.length === 0) return Promise.resolve();
    const context = this.taskContexts.get(taskId);
    return this.enqueuePersistence(async () => {
      if (context) {
        await this.ensureInspectionStarted(
          taskId,
          context.routeId,
          context.routeName,
          context.startedAtMs,
          context.scopeId,
        );
      }
      await this.recordStore.appendTrajectoryBatch(taskId, samples.map(toStoredTrajectorySample));
    });
  };

  onInspectionRecord = (record: PlaybackInspectionRecord): Promise<void> => {
    const previousContext = this.taskContexts.get(record.taskId);
    const context = {
      routeId: record.routeId,
      routeName: record.routeName,
      startedAtMs: record.startedAt,
      scopeId: previousContext?.scopeId ?? this.recordStore.getScopeId(),
    };
    this.taskContexts.set(record.taskId, context);
    return this.enqueuePersistence(async () => {
      await this.ensureInspectionStarted(
        record.taskId,
        context.routeId,
        context.routeName,
        context.startedAtMs,
        context.scopeId,
      );
      let detailError: unknown = null;
      try {
        await this.recordStore.appendTrajectoryBatch(record.taskId, record.trajectory.map(toStoredTrajectorySample));
      } catch (error) {
        detailError = error;
      }
      const screenshots = new Map(record.screenshots.map((screenshot) => [screenshot.occurrenceId, screenshot]));
      for (const event of record.events) {
        const screenshot = screenshots.get(event.occurrenceId);
        try {
          await this.recordStore.appendEvent(record.taskId, toStoredEvent(event, screenshot ? {
            id: screenshot.occurrenceId,
            capturedAtMs: screenshot.capturedAt,
            localUrl: screenshot.dataUrl,
            remoteUrl: null,
          } : undefined), {
            queueForReport: event.responses.includes('report'),
          });
        } catch (error) {
          detailError ??= error;
        }
      }
      const storedRecord = await this.recordStore.getTaskRecord(record.taskId);
      if (storedRecord?.status === 'running') {
        await this.recordStore.completeInspection(record.taskId, {
          status: record.status === 'running' ? 'stopped' : record.status,
          endedAtMs: record.endedAt ?? record.startedAt + record.durationMs,
        });
      }
      if (detailError) throw detailError;
    }).finally(() => {
      for (const [occurrenceId, screenshotContext] of this.screenshotContexts) {
        if (screenshotContext.taskId === record.taskId) this.screenshotContexts.delete(occurrenceId);
      }
      this.taskContexts.delete(record.taskId);
      this.startedTaskIds.delete(record.taskId);
    });
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.highlightTimer !== null) clearTimeout(this.highlightTimer);
    this.highlightTimer = null;
    this.screenshotContexts.clear();
    this.taskContexts.clear();
    this.options.setHighlightedEntityIds([]);
    if (this.ownsRecordStore) {
      // Controller.dispose() 可能仍在等待最后一张截图，让其收尾回调先进入持久化队列。
      void this.screenshotTail
        .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
        .then(() => this.persistenceTail)
        .finally(() => this.recordStore.dispose());
    }
  }

  private highlightTarget(entityId: string): void {
    if (this.highlightTimer !== null) clearTimeout(this.highlightTimer);
    this.options.setHighlightedEntityIds([entityId]);
    this.highlightTimer = setTimeout(() => {
      this.highlightTimer = null;
      if (!this.disposed) this.options.setHighlightedEntityIds([]);
    }, this.highlightDurationMs);
  }

  private enqueuePersistence(operation: () => Promise<void>): Promise<void> {
    const result = this.persistenceTail.then(operation);
    this.persistenceTail = result.catch((error) => {
      try {
        if (this.options.onError) this.options.onError('自动巡检记录持久化失败。', error);
        else console.error('[AutoPatrol] 自动巡检记录持久化失败。', error);
      } catch (reportError) {
        console.error('[AutoPatrol] 自动巡检记录持久化失败，且错误回调执行异常。', reportError);
      }
    });
    return result;
  }

  private async ensureInspectionStarted(
    taskId: string,
    routeId: string,
    routeName: string | null,
    startedAtMs: number,
    scopeId: string,
  ): Promise<void> {
    if (this.startedTaskIds.has(taskId)) return;
    const existing = await this.recordStore.getRecordForScope(taskId, scopeId);
    if (!existing) {
      await this.recordStore.startInspectionForScope(scopeId, {
        taskId,
        routeId,
        routeName,
        operator: this.options.operator,
        startedAtMs,
      });
    }
    this.startedTaskIds.add(taskId);
  }
}

function normalizePositiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

function toStoredTrajectorySample(sample: PlaybackInspectionTrajectorySample) {
  return {
    recordedAtMs: sample.capturedAt,
    position: getSceneCameraPosition(sample.pose),
    rotation: { x: sample.pose.beta, y: sample.pose.alpha, z: 0 },
  };
}

function toStoredEvent(
  event: PlaybackInspectionEvent,
  screenshot?: AutoPatrolInspectionScreenshot,
): AutoPatrolInspectionEventRecord {
  return {
    id: event.occurrenceId,
    eventDefinitionId: event.eventId,
    name: event.name,
    trigger: event.trigger.kind,
    occurredAtMs: event.triggeredAt,
    targetEntityId: event.targetEntityId,
    position: { ...event.position },
    businessData: { ...event.businessData },
    anomaly: isAnomalyEvent(event),
    ...(screenshot ? { screenshot } : {}),
  };
}

function isAnomalyEvent(event: PlaybackInspectionEvent): boolean {
  return event.anomaly
    || event.businessData.anomaly === true
    || event.businessData.abnormal === true
    || event.businessData.alert === true;
}
