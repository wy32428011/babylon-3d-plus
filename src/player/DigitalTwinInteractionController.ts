import type {
  CameraTransitionCancelReason,
  CameraViewTransitionOptions,
} from '../runtime/babylon/ArcRotateCameraViewController';
import { findDigitalTwinAsset, type DigitalTwinAssetIndex } from '../shared/digitalTwinAssetCodes';
import {
  DIGITAL_TWIN_BRIDGE_CHANNEL,
  DIGITAL_TWIN_BRIDGE_VERSION,
  DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY,
  parseDigitalTwinBridgeMessage,
  type DigitalTwinBridgeMessage,
  type DigitalTwinCommandFailureResult,
  type DigitalTwinViewerErrorCode,
} from './digitalTwinInteractionProtocol';

export type DigitalTwinMessageEvent = {
  data: unknown;
  origin: string;
  source: unknown;
};

export type DigitalTwinFocusBounds = {
  center: { x: number; y: number; z: number };
  radiusMeters: number;
  geometryReady: boolean;
  requestedEntityCount: number;
  resolvedEntityCount: number;
  geometryReadyEntityCount: number;
};

export type DigitalTwinPatrolPhase = 'idle' | 'moving' | 'dwelling' | 'paused' | 'completed' | 'returning';

export type DigitalTwinInteractionRuntime = {
  assetIndex: DigitalTwinAssetIndex;
  getEntityBounds: (entityId: string) => DigitalTwinFocusBounds | null;
  focusOnBounds: (bounds: DigitalTwinFocusBounds, options: CameraViewTransitionOptions) => void;
  cancelCameraTransition: (reason?: CameraTransitionCancelReason) => boolean;
  setExternalHighlightEntityIds: (entityIds: readonly string[]) => void;
  clearExternalHighlight: () => void;
  getPatrolPhase: () => DigitalTwinPatrolPhase;
  pausePatrol: () => void;
  notifyCameraChangedWhilePaused: () => void;
};

export type DigitalTwinInteractionControllerOptions = {
  parentWindow: unknown;
  viewerOrigin: string;
  subscribeToMessages: (listener: (event: DigitalTwinMessageEvent) => void) => () => void;
  postToParent: (message: DigitalTwinBridgeMessage, targetOrigin: string) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  projectId?: string;
};

type ActiveFocusRequest = {
  sessionId: string;
  requestId: string;
  assetCode: string;
  entityId: string;
  geometryDeadlineMs: number;
  geometryTimer: unknown | null;
  focusStarted: boolean;
};

const GEOMETRY_READY_TIMEOUT_MS = 5_000;
const GEOMETRY_POLL_INTERVAL_MS = 50;
const CAMERA_FOCUS_DURATION_MS = 450;
const EXTERNAL_HIGHLIGHT_DURATION_MS = 3_000;

const FAILURE_MESSAGES: Record<DigitalTwinViewerErrorCode, string> = {
  INVALID_ASSET_CODE: '资产编号无效',
  ASSET_NOT_FOUND: '当前入口场景中未找到该资产编号',
  ASSET_CODE_AMBIGUOUS: '当前入口场景中存在重复资产编号',
  ASSET_NOT_VISIBLE: '目标模型当前不可见',
  ASSET_GEOMETRY_NOT_READY: '目标模型几何在限定时间内未就绪',
  COMMAND_CANCELLED: '资产聚焦请求已取消',
  UNSUPPORTED_COMMAND: '当前 Viewer 不支持该命令',
  INTERNAL_ERROR: 'Viewer 执行资产聚焦时发生内部异常',
};

function defaultSetTimer(callback: () => void, delayMs: number): unknown {
  return globalThis.setTimeout(callback, delayMs);
}

function defaultClearTimer(timer: unknown): void {
  if (timer !== null && timer !== undefined) globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>);
}

function isGeometryReady(bounds: DigitalTwinFocusBounds | null): bounds is DigitalTwinFocusBounds {
  return Boolean(bounds)
    && bounds!.geometryReady
    && bounds!.requestedEntityCount === 1
    && bounds!.resolvedEntityCount === 1
    && bounds!.geometryReadyEntityCount === 1
    && Number.isFinite(bounds!.radiusMeters)
    && bounds!.radiusMeters >= 0;
}

/** 管理发布 Viewer 的父页面握手、最新资产聚焦请求、取消和资源释放。 */
export class DigitalTwinInteractionController {
  private readonly unsubscribeMessages: () => void;
  private readonly allowedParentOrigins = new Set<string>();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private runtime: DigitalTwinInteractionRuntime | null = null;
  private activeSessionId: string | null = null;
  private activeParentOrigin: string | null = null;
  private activeRequest: ActiveFocusRequest | null = null;
  private highlightTimer: unknown | null = null;
  private highlightRequestId: string | null = null;
  private disposed = false;

  constructor(private readonly options: DigitalTwinInteractionControllerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
    this.unsubscribeMessages = options.subscribeToMessages(this.handleMessage);
  }

  setAllowedParentOrigins(origins: readonly string[]): void {
    this.allowedParentOrigins.clear();
    for (const origin of origins) {
      if (typeof origin !== 'string' || !origin || origin === '*') continue;
      this.allowedParentOrigins.add(origin);
    }

    if (
      this.activeParentOrigin
      && this.activeParentOrigin !== this.options.viewerOrigin
      && !this.allowedParentOrigins.has(this.activeParentOrigin)
    ) {
      this.resetSession();
    }
  }

  markViewerReady(runtime: DigitalTwinInteractionRuntime): void {
    if (this.disposed) return;
    this.runtime = runtime;
    this.postViewerReady();
  }

  notifyManualCameraInput(): void {
    if (this.disposed || !this.runtime) return;
    const focusHadStarted = this.activeRequest?.focusStarted === true || this.highlightRequestId !== null;
    if (focusHadStarted) this.runtime.notifyCameraChangedWhilePaused();
    const cancelled = this.cancelActiveRequest('manual-input', true);
    if (!cancelled && this.highlightRequestId !== null) this.clearHighlight();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelActiveRequest('disposed', false);
    this.clearHighlight();
    this.unsubscribeMessages();
    this.runtime = null;
    this.activeSessionId = null;
    this.activeParentOrigin = null;
  }

  private readonly handleMessage = (event: DigitalTwinMessageEvent): void => {
    if (this.disposed || event.source !== this.options.parentWindow || !this.isAllowedOrigin(event.origin)) return;
    const message = parseDigitalTwinBridgeMessage(event.data);
    if (!message) return;

    if (message.type === 'host.hello') {
      this.acceptHostSession(message.sessionId, event.origin);
      return;
    }

    if (
      !this.activeSessionId
      || !this.activeParentOrigin
      || message.sessionId !== this.activeSessionId
      || event.origin !== this.activeParentOrigin
    ) return;

    if (message.type === 'command.focusAsset') {
      this.focusAsset(message.requestId, message.payload.assetCode);
      return;
    }

    if (message.type === 'command.cancelFocusAsset') {
      this.cancelFocusAsset(message.requestId);
    }
  };

  private isAllowedOrigin(origin: string): boolean {
    return origin === this.options.viewerOrigin || this.allowedParentOrigins.has(origin);
  }

  private acceptHostSession(sessionId: string, parentOrigin: string): void {
    const hasActiveSession = this.activeSessionId !== null || this.activeParentOrigin !== null;
    const sessionChanged = sessionId !== this.activeSessionId || parentOrigin !== this.activeParentOrigin;
    if (hasActiveSession && sessionChanged) this.resetSession();
    this.activeSessionId = sessionId;
    this.activeParentOrigin = parentOrigin;
    this.post({
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId,
      type: 'bridge.ready',
    });
    this.postViewerReady();
  }

  private resetSession(): void {
    this.cancelActiveRequest('cancelled', false);
    this.clearHighlight();
    this.activeSessionId = null;
    this.activeParentOrigin = null;
  }

  private postViewerReady(): void {
    if (!this.runtime || !this.activeSessionId || !this.activeParentOrigin) return;
    this.post({
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: this.activeSessionId,
      type: 'viewer.ready',
      payload: {
        ...(this.options.projectId ? { projectId: this.options.projectId } : {}),
        capabilities: [DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY],
      },
    });
  }

  private focusAsset(requestId: string, rawAssetCode: string): void {
    const runtime = this.runtime;
    if (!runtime) {
      this.postFailure(requestId, 'UNSUPPORTED_COMMAND');
      return;
    }

    const cancelledPrevious = this.cancelActiveRequest('replaced', true);
    if (!cancelledPrevious) this.clearHighlight();

    const lookup = findDigitalTwinAsset(runtime.assetIndex, rawAssetCode);
    switch (lookup.status) {
      case 'invalid':
        this.postFailure(requestId, 'INVALID_ASSET_CODE');
        return;
      case 'not-found':
        this.postFailure(requestId, 'ASSET_NOT_FOUND');
        return;
      case 'ambiguous':
        this.postFailure(requestId, 'ASSET_CODE_AMBIGUOUS');
        return;
      case 'not-visible':
        this.postFailure(requestId, 'ASSET_NOT_VISIBLE');
        return;
      case 'found':
        break;
    }

    if (!this.activeSessionId) return;
    const request: ActiveFocusRequest = {
      sessionId: this.activeSessionId,
      requestId,
      assetCode: lookup.assetCode,
      entityId: lookup.entityId,
      geometryDeadlineMs: this.now() + GEOMETRY_READY_TIMEOUT_MS,
      geometryTimer: null,
      focusStarted: false,
    };
    this.activeRequest = request;
    this.pollGeometry(request);
  }

  private pollGeometry(request: ActiveFocusRequest): void {
    const runtime = this.runtime;
    if (!runtime || this.activeRequest !== request) return;

    let bounds: DigitalTwinFocusBounds | null;
    try {
      bounds = runtime.getEntityBounds(request.entityId);
    } catch {
      this.finishFailure(request, 'INTERNAL_ERROR');
      return;
    }

    if (isGeometryReady(bounds)) {
      this.beginFocus(request, bounds);
      return;
    }

    const remainingMs = request.geometryDeadlineMs - this.now();
    if (remainingMs <= 0) {
      this.finishFailure(request, 'ASSET_GEOMETRY_NOT_READY');
      return;
    }

    request.geometryTimer = this.setTimer(
      () => {
        request.geometryTimer = null;
        this.pollGeometry(request);
      },
      Math.min(GEOMETRY_POLL_INTERVAL_MS, remainingMs),
    );
  }

  private beginFocus(request: ActiveFocusRequest, bounds: DigitalTwinFocusBounds): void {
    const runtime = this.runtime;
    if (!runtime || this.activeRequest !== request) return;
    request.focusStarted = true;

    try {
      const patrolPhase = runtime.getPatrolPhase();
      if (patrolPhase === 'moving' || patrolPhase === 'dwelling') runtime.pausePatrol();
      runtime.setExternalHighlightEntityIds([request.entityId]);
      this.highlightRequestId = request.requestId;
      this.highlightTimer = this.setTimer(() => {
        this.highlightTimer = null;
        if (this.highlightRequestId === request.requestId) this.clearHighlight();
      }, EXTERNAL_HIGHLIGHT_DURATION_MS);

      runtime.focusOnBounds(bounds, {
        animate: true,
        durationMs: CAMERA_FOCUS_DURATION_MS,
        onCompleted: () => this.finishSuccess(request),
        onCancelled: () => {
          if (this.activeRequest === request) this.finishFailure(request, 'COMMAND_CANCELLED');
        },
      });
    } catch {
      this.finishFailure(request, 'INTERNAL_ERROR');
    }
  }

  private finishSuccess(request: ActiveFocusRequest): void {
    if (this.activeRequest !== request) return;
    this.clearGeometryTimer(request);
    this.activeRequest = null;
    this.post({
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: request.sessionId,
      type: 'command.result',
      requestId: request.requestId,
      ok: true,
      payload: {
        assetCode: request.assetCode,
        entityIds: [request.entityId],
      },
    });
  }

  private finishFailure(request: ActiveFocusRequest, code: DigitalTwinViewerErrorCode): void {
    if (this.activeRequest !== request) return;
    this.clearGeometryTimer(request);
    this.activeRequest = null;
    if (request.focusStarted) this.clearHighlight();
    this.postFailure(request.requestId, code, request.sessionId);
  }

  private cancelFocusAsset(requestId: string): void {
    if (this.activeRequest?.requestId === requestId) {
      this.cancelActiveRequest('cancelled', true);
      return;
    }
    if (this.highlightRequestId === requestId) this.clearHighlight();
  }

  private cancelActiveRequest(reason: CameraTransitionCancelReason, emitResult: boolean): boolean {
    const request = this.activeRequest;
    if (!request) return false;
    this.activeRequest = null;
    this.clearGeometryTimer(request);
    if (request.focusStarted) this.runtime?.cancelCameraTransition(reason);
    this.clearHighlight();
    if (emitResult) this.postFailure(request.requestId, 'COMMAND_CANCELLED', request.sessionId);
    return true;
  }

  private clearGeometryTimer(request: ActiveFocusRequest): void {
    if (request.geometryTimer === null) return;
    this.clearTimer(request.geometryTimer);
    request.geometryTimer = null;
  }

  private clearHighlight(): void {
    if (this.highlightTimer !== null) {
      this.clearTimer(this.highlightTimer);
      this.highlightTimer = null;
    }
    this.highlightRequestId = null;
    this.runtime?.clearExternalHighlight();
  }

  private postFailure(requestId: string, code: DigitalTwinViewerErrorCode, sessionId = this.activeSessionId): void {
    if (!sessionId) return;
    const result: DigitalTwinCommandFailureResult = {
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId,
      type: 'command.result',
      requestId,
      ok: false,
      error: { code, message: FAILURE_MESSAGES[code] },
    };
    this.post(result);
  }

  private post(message: DigitalTwinBridgeMessage): void {
    if (
      this.disposed
      || !this.activeSessionId
      || !this.activeParentOrigin
      || message.sessionId !== this.activeSessionId
    ) return;
    this.options.postToParent(message, this.activeParentOrigin);
  }
}
