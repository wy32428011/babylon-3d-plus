import type {
  CameraTransitionCancelReason,
  CameraViewTransitionOptions,
} from '../runtime/babylon/ArcRotateCameraViewController';
import { type DigitalTwinAssetIndex } from '../shared/digitalTwinAssetCodes';
import {
  findDigitalTwinFocusTarget,
  type DigitalTwinSlotCoordinate,
  type DigitalTwinSlotIndex,
} from '../shared/digitalTwinSlotCodes';
import {
  DIGITAL_TWIN_BRIDGE_CHANNEL,
  DIGITAL_TWIN_BRIDGE_VERSION,
  DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY,
  DIGITAL_TWIN_HARDWARE_GPU_CAPABILITY,
  DIGITAL_TWIN_START_AUTO_PATROL_CAPABILITY,
  DIGITAL_TWIN_START_MANUAL_ROAM_CAPABILITY,
  parseDigitalTwinBridgeMessage,
  type DigitalTwinAssetClickedEvent,
  type DigitalTwinBridgeMessage,
  type DigitalTwinCapability,
  type DigitalTwinCommandFailureResult,
  type DigitalTwinInitialLoadPhase,
  type DigitalTwinRuntimeAction,
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
  hardwareGpuVerified: true;
  assetIndex: DigitalTwinAssetIndex;
  slotIndex: DigitalTwinSlotIndex;
  getFocusBounds: (entityId: string, slot?: DigitalTwinSlotCoordinate) => DigitalTwinFocusBounds | null;
  focusOnBounds: (bounds: DigitalTwinFocusBounds, options: CameraViewTransitionOptions) => void;
  triggerTargetClick: (entityId: string, slot?: DigitalTwinSlotCoordinate) => void;
  cancelCameraTransition: (reason?: CameraTransitionCancelReason) => boolean;
  setExternalHighlightEntityIds: (entityIds: readonly string[]) => void;
  setExternalSlotHighlight: (entityId: string, coordinate: DigitalTwinSlotCoordinate | null) => void;
  clearExternalHighlight: () => void;
  getPatrolPhase: () => DigitalTwinPatrolPhase;
  pausePatrol: () => void;
  notifyCameraChangedWhilePaused: () => void;
  startAutoPatrol?: () => void;
  startManualRoam?: () => void;
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
  slot?: DigitalTwinSlotCoordinate;
  geometryDeadlineMs: number;
  geometryTimer: unknown | null;
  focusStarted: boolean;
};

const GEOMETRY_READY_TIMEOUT_MS = 5_000;
const GEOMETRY_POLL_INTERVAL_MS = 50;
const EXTERNAL_HIGHLIGHT_DURATION_MS = 3_000;

const FAILURE_MESSAGES: Record<DigitalTwinViewerErrorCode, string> = {
  INVALID_ASSET_CODE: '资产编号无效',
  ASSET_NOT_FOUND: '当前入口场景中未找到该资产编号或货格',
  ASSET_CODE_AMBIGUOUS: '当前入口场景中存在重复资产编号',
  ASSET_NOT_VISIBLE: '目标模型或货格当前不可见',
  ASSET_GEOMETRY_NOT_READY: '目标模型几何在限定时间内未就绪',
  COMMAND_CANCELLED: '资产聚焦请求已取消',
  UNSUPPORTED_COMMAND: '当前 Viewer 不支持该命令',
  INTERNAL_ERROR: 'Viewer 执行命令时发生内部异常',
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
  private allowAnyParentOrigin = false;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private runtime: DigitalTwinInteractionRuntime | null = null;
  private initialLoadPhase: DigitalTwinInitialLoadPhase | null = null;
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
    this.allowAnyParentOrigin = false;
    for (const origin of origins) {
      if (typeof origin !== 'string' || !origin) continue;
      if (origin === '*') {
        this.allowAnyParentOrigin = true;
        continue;
      }
      this.allowedParentOrigins.add(origin);
    }

    if (
      !this.allowAnyParentOrigin
      && this.activeParentOrigin
      && this.activeParentOrigin !== this.options.viewerOrigin
      && !this.allowedParentOrigins.has(this.activeParentOrigin)
    ) {
      this.resetSession();
    }
  }

  markViewerReady(runtime: DigitalTwinInteractionRuntime): void {
    if (this.disposed) return;
    if (runtime.hardwareGpuVerified !== true) {
      throw new Error('Viewer 必须先通过硬件 GPU 校验才能进入 ready 状态');
    }
    this.runtime = runtime;
    this.postViewerReady();
  }

  markInitialLoadStarted(): void {
    if (this.disposed || this.initialLoadPhase !== null) return;
    this.initialLoadPhase = 'loading';
    this.postInitialLoadState();
  }

  markInitialLoadComplete(): void {
    if (this.disposed || this.initialLoadPhase === 'complete') return;
    this.initialLoadPhase = 'complete';
    this.postInitialLoadState();
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
      return;
    }

    if (message.type === 'command.startAutoPatrol') {
      this.startRuntimeAction(message.requestId, DIGITAL_TWIN_START_AUTO_PATROL_CAPABILITY);
      return;
    }

    if (message.type === 'command.startManualRoam') {
      this.startRuntimeAction(message.requestId, DIGITAL_TWIN_START_MANUAL_ROAM_CAPABILITY);
    }
  };

  private isAllowedOrigin(origin: string): boolean {
    return this.allowAnyParentOrigin || origin === this.options.viewerOrigin || this.allowedParentOrigins.has(origin);
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
    this.postInitialLoadState();
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
    const capabilities: DigitalTwinCapability[] = [
      DIGITAL_TWIN_HARDWARE_GPU_CAPABILITY,
      DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY,
    ];
    if (this.runtime.startAutoPatrol) capabilities.push(DIGITAL_TWIN_START_AUTO_PATROL_CAPABILITY);
    if (this.runtime.startManualRoam) capabilities.push(DIGITAL_TWIN_START_MANUAL_ROAM_CAPABILITY);
    this.post({
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: this.activeSessionId,
      type: 'viewer.ready',
      payload: {
        ...(this.options.projectId ? { projectId: this.options.projectId } : {}),
        capabilities,
      },
    });
  }

  private postInitialLoadState(): void {
    if (!this.initialLoadPhase || !this.activeSessionId || !this.activeParentOrigin) return;
    this.post({
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: this.activeSessionId,
      type: 'viewer.initialLoadState',
      payload: { phase: this.initialLoadPhase },
    });
  }

  private startRuntimeAction(requestId: string, action: DigitalTwinRuntimeAction): void {
    const runtime = this.runtime;
    const handler = action === DIGITAL_TWIN_START_AUTO_PATROL_CAPABILITY
      ? runtime?.startAutoPatrol
      : runtime?.startManualRoam;
    if (!handler) {
      this.postFailure(requestId, 'UNSUPPORTED_COMMAND');
      return;
    }

    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const cancelledPrevious = this.cancelActiveRequest('replaced', true);
    if (!cancelledPrevious) this.clearHighlight();

    try {
      handler();
    } catch {
      this.postFailure(requestId, 'INTERNAL_ERROR', sessionId);
      return;
    }

    this.post({
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId,
      type: 'command.result',
      requestId,
      ok: true,
      payload: { action },
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

    const lookup = findDigitalTwinFocusTarget(runtime.assetIndex, runtime.slotIndex, rawAssetCode);
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
      slot: 'slot' in lookup ? lookup.slot : undefined,
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
      bounds = runtime.getFocusBounds(request.entityId, request.slot);
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
      // 货格搜索只画单格 overlay，避免整面连续网格被选中色刷掉。
      runtime.setExternalHighlightEntityIds(request.slot ? [] : [request.entityId]);
      runtime.setExternalSlotHighlight(request.entityId, request.slot ?? null);
      this.highlightRequestId = request.requestId;
      this.highlightTimer = this.setTimer(() => {
        this.highlightTimer = null;
        if (this.highlightRequestId === request.requestId) this.clearHighlight();
      }, EXTERNAL_HIGHLIGHT_DURATION_MS);

      runtime.focusOnBounds(bounds, {
        // 模型聚焦是位置约束，不应在过渡帧暴露旧的距离或观察方向。
        animate: false,
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
    try {
      // 仅聚焦成功的最新请求触发点击；先结束请求，避免完成回调重入时重复执行事件。
      this.runtime!.triggerTargetClick(request.entityId, request.slot);
    } catch {
      if (this.highlightRequestId === request.requestId) this.clearHighlight();
      this.postFailure(request.requestId, 'INTERNAL_ERROR', request.sessionId);
      return;
    }
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

  /** Viewer 内部点击命中 show-chart 效果时向宿主页面发送点击事件；未完成握手时静默丢弃。 */
  notifyAssetClicked(payload: DigitalTwinAssetClickedEvent['payload']): void {
    if (this.disposed || !this.activeSessionId) return;
    this.post({
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: this.activeSessionId,
      type: 'event.assetClicked',
      payload,
    });
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
