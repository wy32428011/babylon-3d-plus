import type { DigitalTwinRegionViewItem, DigitalTwinRegionViewError } from './digitalTwinRegionViewProtocol';
import { inspectionConfigurationMatches } from '../editor/model/inspectionBinding';
import type { ModelAssetComponent } from '../editor/model/components';
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
  DIGITAL_TWIN_CLEAR_SELECTION_CAPABILITY,
  DIGITAL_TWIN_BRIDGE_CHANNEL,
  DIGITAL_TWIN_BRIDGE_VERSION,
  DIGITAL_TWIN_FOCUS_ASSET_CAPABILITY,
  DIGITAL_TWIN_GLOBAL_OVERVIEW_CAPABILITY,
  DIGITAL_TWIN_HARDWARE_GPU_CAPABILITY,
  DIGITAL_TWIN_START_AUTO_PATROL_CAPABILITY,
  DIGITAL_TWIN_START_MANUAL_ROAM_CAPABILITY,
  parseDigitalTwinBridgeMessage,
  parseDigitalTwinInspectionMessage,
  getInspectionDataIssue,
  isDigitalTwinInspectionBinding,
  type DigitalTwinInspectionMessage,
  type DigitalTwinInspectionLoad,
  type DigitalTwinInspectionAnyLoad,
  type DigitalTwinDeviceContext,
  type DigitalTwinInspectionIdentity,
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

type InspectionTarget = Omit<DigitalTwinInspectionLoad, 'loadId'>;
export type ViewerInspectionTargetResult = { target: InspectionTarget } | { error: string };

/** 场景点击与记录反向定位共用同一固定配置和协议预算检查。 */
export function resolveViewerInspectionTarget(
  entityId: string,
  model: Pick<ModelAssetComponent, 'assetCode' | 'inspection' | 'parameterValues'> | undefined,
  expectedAssetCode?: string,
): ViewerInspectionTargetResult {
  const assetCode = model?.assetCode?.trim();
  if (!assetCode || (expectedAssetCode !== undefined && assetCode !== expectedAssetCode)) {
    return { error: '设备详情未打开：当前设备缺少有效的高模或设备数据绑定。' };
  }
  if (model?.inspection && getInspectionDataIssue(model.inspection) === 'budget') {
    return { error: '设备详情未打开：高模零件清单或参数超出跨窗口数据容量，请精简后重新配置。' };
  }
  if (!isDigitalTwinInspectionBinding(model?.inspection)) {
    return { error: '设备详情未打开：当前设备缺少有效的高模或设备数据绑定。' };
  }
  if (!inspectionConfigurationMatches(model.inspection, model.parameterValues)) {
    return { error: '设备详情未打开：设备当前模型参数与高模绑定配置不一致，请重新配置设备详情。' };
  }
  return { target: { entityId, assetCode, inspection: model.inspection } };
}

export type DigitalTwinInteractionRuntime = {
  hardwareGpuVerified: true;
  assetIndex: DigitalTwinAssetIndex;
  slotIndex: DigitalTwinSlotIndex;
  getFocusBounds: (entityId: string, slot?: DigitalTwinSlotCoordinate) => DigitalTwinFocusBounds | null;
  focusOnBounds: (bounds: DigitalTwinFocusBounds, options: CameraViewTransitionOptions) => void;
  triggerTargetClick: (entityId: string, slot?: DigitalTwinSlotCoordinate) => void;
  resolveInspectionTarget?: (entityId: string, assetCode: string) => InspectionTarget | { error: string } | null;
  cancelCameraTransition: (reason?: CameraTransitionCancelReason) => boolean;
  setExternalHighlightEntityIds: (entityIds: readonly string[]) => void;
  setExternalSlotHighlight: (entityId: string, coordinate: DigitalTwinSlotCoordinate | null) => void;
  clearExternalHighlight: () => void;
  getPatrolPhase: () => DigitalTwinPatrolPhase;
  pausePatrol: () => void;
  notifyCameraChangedWhilePaused: () => void;
  clearSelection?: () => void;
  getRegionViews?: () => readonly DigitalTwinRegionViewItem[];
  applyRegionView?: (viewId: string, options: CameraViewTransitionOptions) => void;
  globalOverview?: () => void;
  startAutoPatrol?: () => void;
  startManualRoam?: () => void;
};

export type DigitalTwinInteractionControllerOptions = {
  parentWindow: unknown;
  viewerOrigin: string;
  subscribeToMessages: (listener: (event: DigitalTwinMessageEvent) => void) => () => void;
  postToParent: (message: DigitalTwinBridgeMessage | DigitalTwinInspectionMessage, targetOrigin: string) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  projectId?: string;
  onReady?: () => void;
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
const SCENE_NAVIGATION_TIMEOUT_MS = 3_000;

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
  private inspectionNegotiated = false;
  private focusClickRequestId: string | null = null;
  private activeRequest: ActiveFocusRequest | null = null;
  private regionViewsEnabled = false;
  private activeRegionView: { requestId: string; sessionId: string } | null = null;
  private appliedRegionView: { requestId: string; sessionId: string } | null = null;
  private highlightTimer: unknown | null = null;
  private highlightRequestId: string | null = null;
  private selectionRevision = 0;
  private sceneNavigationSequence = 0;
  private pendingSceneNavigation: { requestId: string; timer: unknown; onError: (message: string) => void } | null = null;
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

  /** 仅向当前已握手的宿主请求切换大屏，不在 Viewer 内加载主题页面。 */
  showScreen(screen: { projectId: string; screenId: string }, selectionBound = false): boolean {
    if (this.disposed || !this.runtime || !this.activeSessionId || !this.activeParentOrigin) return false;
    const message = parseDigitalTwinBridgeMessage({
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: this.activeSessionId,
      type: 'viewer.showScreen',
      payload: {
        projectId: screen.projectId, screenId: screen.screenId,
        ...(selectionBound ? { selectionToken: String(this.selectionRevision) } : {}),
      },
    });
    if (!message || (this.options.projectId && screen.projectId !== this.options.projectId)) return false;
    this.post(message);
    return true;
  }

  /** 请求已握手的中台宿主切换整个页面；旧宿主超时后提示而不改为切换 iframe。 */
  navigateScene(url: string, onError: (message: string) => void): boolean {
    if (this.disposed || !this.runtime || !this.activeSessionId || !this.activeParentOrigin || this.pendingSceneNavigation) return false;
    const requestId = `scene-navigation:${this.now()}:${++this.sceneNavigationSequence}`;
    const message = parseDigitalTwinBridgeMessage({
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: this.activeSessionId,
      type: 'viewer.navigateScene',
      requestId,
      payload: { url },
    });
    if (!message) return false;
    const timer = this.setTimer(() => {
      if (this.pendingSceneNavigation?.requestId !== requestId) return;
      this.pendingSceneNavigation = null;
      onError('中台未响应场景切换，请确认中台已升级并允许整页跳转。');
    }, SCENE_NAVIGATION_TIMEOUT_MS);
    this.pendingSceneNavigation = { requestId, timer, onError };
    try {
      this.post(message);
      return true;
    } catch {
      this.clearTimer(timer);
      this.pendingSceneNavigation = null;
      return false;
    }
  }

  /** 每次设备/货格选择产生新标记，旧弹层的关闭不能清理后来的选择。 */
  beginSelection(): void {
    if (this.disposed) return;
    this.clearAppliedRegionView();
    this.cancelActiveRegionView('replaced');
    this.selectionRevision++;
    this.cancelActiveRequest('replaced', true);
  }

  notifyManualCameraInput(): void {
    if (this.disposed || !this.runtime) return;
    this.clearAppliedRegionView();
    this.cancelActiveRegionView('manual-input');
    const focusHadStarted = this.activeRequest?.focusStarted === true || this.highlightRequestId !== null;
    if (focusHadStarted) this.runtime.notifyCameraChangedWhilePaused();
    const cancelled = this.cancelActiveRequest('manual-input', true);
    if (!cancelled && this.highlightRequestId !== null) this.clearHighlight();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelActiveRegionView('disposed');
    this.disposed = true;
    this.cancelActiveRequest('disposed', false);
    this.clearHighlight();
    if (this.pendingSceneNavigation) this.clearTimer(this.pendingSceneNavigation.timer);
    this.pendingSceneNavigation = null;
    this.unsubscribeMessages();
    this.runtime = null;
    this.activeSessionId = null;
    this.activeParentOrigin = null;
  }

  private readonly handleMessage = (event: DigitalTwinMessageEvent): void => {
    if (this.disposed || event.source !== this.options.parentWindow || !this.isAllowedOrigin(event.origin)) return;
    const inspection = parseDigitalTwinInspectionMessage(event.data);
    if (inspection?.type === 'host.inspectionHello') {
      if (this.runtime && this.activeSessionId === inspection.sessionId
        && this.activeParentOrigin === event.origin && inspection.payload.role === 'scene') {
        this.inspectionNegotiated = true;
        this.post({ channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
          sessionId: inspection.sessionId, type: 'viewer.inspectionReady', requestId: inspection.requestId,
          payload: { role: 'scene', capabilities: ['openInspection', 'focusCause', 'deviceContext', ...(this.runtime.resolveInspectionTarget ? ['openAssetInspection' as const] : [])] } });
      }
      return;
    }
    if (inspection?.type === 'command.openInspectionAsset') {
      if (!this.inspectionNegotiated || !this.runtime || this.activeSessionId !== inspection.sessionId
        || this.activeParentOrigin !== event.origin) return;
      let opened = false;
      let error = '设备缺少有效的高模或设备绑定。';
      try {
        const target = this.runtime.resolveInspectionTarget?.(inspection.payload.entityId, inspection.payload.assetCode);
        if (target && 'error' in target) error = target.error;
        else opened = Boolean(target && this.openInspection({ ...target, causeRequestId: inspection.requestId }));
      } catch {
        error = '设备详情解析失败。';
      }
      if (!opened) this.post({ channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
        sessionId: inspection.sessionId, type: 'viewer.openInspectionAssetFailed', requestId: inspection.requestId,
        error: error.slice(0, 1024) });
      return;
    }
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

    if (message.type === 'host.navigateSceneResult') {
      const pending = this.pendingSceneNavigation;
      if (!pending || pending.requestId !== message.requestId) return;
      this.clearTimer(pending.timer);
      this.pendingSceneNavigation = null;
      if (!message.ok) pending.onError(message.error.message);
      return;
    }

    if (message.type === 'host.regionViews') {
      if (!this.runtime?.getRegionViews || !this.runtime.applyRegionView) return;
      this.regionViewsEnabled = true;
      this.post({ channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
        sessionId: message.sessionId, requestId: message.requestId, type: 'viewer.regionViews',
        payload: { views: this.runtime.getRegionViews().map(({ id, name }) => ({ id, name })) } });
      return;
    }
    if (message.type === 'command.regionView') {
      this.applyRegionView(message.requestId, message.payload.viewId, message.payload.animate);
      return;
    }
    if (message.type === 'command.cancelRegionView') {
      if (message.requestId === this.activeRegionView?.requestId) this.cancelActiveRegionView('cancelled');
      return;
    }
    if (message.type === 'command.clearSelection') {
      this.clearSelection(message.requestId, message.payload.selectionToken);
      return;
    }

    if (message.type === 'command.focusAsset') {
      this.focusAsset(message.requestId, message.payload.assetCode);
      return;
    }

    if (message.type === 'command.cancelFocusAsset') {
      this.cancelFocusAsset(message.requestId);
      return;
    }

    if (message.type === 'command.globalOverview') {
      this.startRuntimeAction(message.requestId, DIGITAL_TWIN_GLOBAL_OVERVIEW_CAPABILITY);
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
    if (this.pendingSceneNavigation) {
      const pending = this.pendingSceneNavigation;
      this.clearTimer(pending.timer);
      this.pendingSceneNavigation = null;
      pending.onError('中台连接已重置，场景切换未完成。');
    }
    this.appliedRegionView = null;
    this.cancelActiveRegionView('cancelled');
    this.regionViewsEnabled = false;
    this.inspectionNegotiated = false;
    this.focusClickRequestId = null;
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
    if (this.runtime.clearSelection) capabilities.push(DIGITAL_TWIN_CLEAR_SELECTION_CAPABILITY);
    if (this.runtime.globalOverview) capabilities.push(DIGITAL_TWIN_GLOBAL_OVERVIEW_CAPABILITY);
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
    this.options.onReady?.();
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

  private clearSelection(requestId: string, selectionToken: string): void {
    if (!this.runtime?.clearSelection) {
      this.postFailure(requestId, 'UNSUPPORTED_COMMAND');
      return;
    }
    if (!this.activeSessionId) return;
    const cleared = selectionToken === String(this.selectionRevision);
    try {
      if (cleared) {
        this.clearHighlight();
        this.runtime.clearSelection();
        this.selectionRevision++;
      }
    } catch {
      this.postFailure(requestId, 'INTERNAL_ERROR');
      return;
    }
    this.post({
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: this.activeSessionId, type: 'command.result', requestId, ok: true,
      payload: { action: DIGITAL_TWIN_CLEAR_SELECTION_CAPABILITY, cleared },
    });
  }

  private startRuntimeAction(requestId: string, action: DigitalTwinRuntimeAction): void {
    const runtime = this.runtime;
    const handler = action === DIGITAL_TWIN_GLOBAL_OVERVIEW_CAPABILITY
      ? runtime?.globalOverview
      : action === DIGITAL_TWIN_START_AUTO_PATROL_CAPABILITY
        ? runtime?.startAutoPatrol
        : runtime?.startManualRoam;
    if (!handler) {
      this.postFailure(requestId, 'UNSUPPORTED_COMMAND');
      return;
    }

    this.cancelActiveRegionView('replaced');
    this.clearAppliedRegionView();

    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const cancelledPrevious = this.cancelActiveRequest('replaced', true);
    if (!cancelledPrevious) this.clearHighlight();

    try {
      if (action === DIGITAL_TWIN_GLOBAL_OVERVIEW_CAPABILITY) this.selectionRevision++;
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
    this.clearAppliedRegionView();
    this.cancelActiveRegionView('replaced');
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
    // 新定位尚在等待几何时，也不能让旧大屏的关闭清除后续选择。
    this.selectionRevision++;
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

  private applyRegionView(requestId: string, viewId: string, animate: boolean): void {
    const runtime = this.runtime;
    this.cancelActiveRegionView('replaced');
    if (!this.activeSessionId) return;
    const request = { requestId, sessionId: this.activeSessionId };
    if (!this.regionViewsEnabled || !runtime?.getRegionViews || !runtime.applyRegionView) {
      this.postRegionViewFailure(request, 'UNSUPPORTED_COMMAND', '当前 Viewer 不支持区域视角');
      return;
    }
    if (!runtime.getRegionViews().some(view => view.id === viewId)) {
      this.postRegionViewFailure(request, 'REGION_VIEW_NOT_FOUND', '该区域视角不存在，请重新加载场景');
      return;
    }
    this.cancelActiveRequest('replaced', true);
    this.activeRegionView = request;
    try {
      runtime.applyRegionView(viewId, {
        animate,
        onCompleted: () => {
          if (this.activeRegionView !== request) return;
          this.activeRegionView = null;
          this.appliedRegionView = request;
          this.post({ channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
            ...request, type: 'viewer.regionViewResult', ok: true, payload: { viewId } });
        },
        onCancelled: () => {
          if (this.activeRegionView !== request) return;
          this.activeRegionView = null;
          this.postRegionViewFailure(request, 'COMMAND_CANCELLED', '区域视角切换已取消');
        },
      });
    } catch {
      if (this.activeRegionView !== request) return;
      this.activeRegionView = null;
      runtime.cancelCameraTransition('cancelled');
      this.postRegionViewFailure(request, 'INTERNAL_ERROR', '区域视角切换失败');
    }
  }

  private clearAppliedRegionView(): void {
    const request = this.appliedRegionView;
    if (!request) return;
    this.appliedRegionView = null;
    this.post({ channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
      ...request, type: 'viewer.regionViewCleared' });
  }

  private cancelActiveRegionView(reason: CameraTransitionCancelReason): void {
    const request = this.activeRegionView;
    if (!request) return;
    this.activeRegionView = null;
    this.runtime?.cancelCameraTransition(reason);
    this.postRegionViewFailure(request, 'COMMAND_CANCELLED', '区域视角切换已取消或被替换');
  }

  private postRegionViewFailure(request: { requestId: string; sessionId: string }, code: DigitalTwinRegionViewError, message: string): void {
    this.post({ channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
      ...request, type: 'viewer.regionViewResult', ok: false, error: { code, message } });
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
      this.focusClickRequestId = request.requestId;
      try {
        this.runtime!.triggerTargetClick(request.entityId, request.slot);
      } finally {
        this.focusClickRequestId = null;
      }
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
      payload: this.inspectionNegotiated && this.focusClickRequestId
        ? { ...payload, inspectionFocusRequestId: this.focusClickRequestId }
        : payload,
    });
  }

  /** 普通低模选择独立于高模绑定；焦点命令的衍生点击保留因果标记。 */
  notifyDeviceContext(context: DigitalTwinDeviceContext | null): void {
    if (this.disposed || !this.inspectionNegotiated || !this.activeSessionId) return;
    const message = parseDigitalTwinInspectionMessage({
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: this.activeSessionId, type: 'event.deviceContext',
      payload: { context, ...(this.focusClickRequestId ? { causeRequestId: this.focusClickRequestId } : {}) },
    });
    if (message) this.post(message);
  }

  notifyInspectionDeviceSelected(payload: Omit<Extract<DigitalTwinInspectionMessage, { type: 'event.inspectionDeviceSelected' }>['payload'], 'causeRequestId'>): void {
    if (!this.inspectionNegotiated || !this.activeSessionId) return;
    const message = parseDigitalTwinInspectionMessage({ channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION, sessionId: this.activeSessionId, type: 'event.inspectionDeviceSelected',
      payload: { ...payload, ...(this.focusClickRequestId ? { causeRequestId: this.focusClickRequestId } : {}) } });
    if (message) this.post(message);
  }

  /** 聚焦衍生普通点击不得再次打开详情；显式命令带独立因果标记。 */
  openInspection(payload: Omit<DigitalTwinInspectionLoad, 'loadId'> & { causeRequestId?: string }): boolean {
    if (!this.inspectionNegotiated || this.focusClickRequestId || !this.activeSessionId) return false;
    const message = parseDigitalTwinInspectionMessage({
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: this.activeSessionId, type: 'event.openInspection', payload,
    });
    if (!message) return false;
    this.post(message);
    return true;
  }

  private post(message: DigitalTwinBridgeMessage | DigitalTwinInspectionMessage): void {
    if (
      this.disposed
      || !this.activeSessionId
      || !this.activeParentOrigin
      || message.sessionId !== this.activeSessionId
    ) return;
    this.options.postToParent(message, this.activeParentOrigin);
  }
}

export type DigitalTwinInspectionControllerOptions = {
  parentWindow: unknown;
  viewerOrigin: string;
  subscribeToMessages: (listener: (event: DigitalTwinMessageEvent) => void) => () => void;
  postToParent: (message: DigitalTwinBridgeMessage | DigitalTwinInspectionMessage, targetOrigin: string) => void;
  load: (payload: DigitalTwinInspectionAnyLoad, signal: AbortSignal) => void | Promise<void>;
  selectPart: (payload: DigitalTwinInspectionIdentity & { partKey: string | null }, signal: AbortSignal) => void | Promise<void>;
  setProgress: (payload: DigitalTwinInspectionIdentity & { progress: number }, signal: AbortSignal) => void | Promise<void>;
  reset: (payload: DigitalTwinInspectionIdentity, signal: AbortSignal) => void | Promise<void>;
};

/** 详情 iframe 的独立桥；调用方负责加载资产和释放被 AbortSignal 取消的资源。 */
export class DigitalTwinInspectionController {
  private readonly unsubscribe: () => void;
  private readonly origins = new Set<string>();
  private allowAnyOrigin = false;
  private ready = false;
  private negotiated = false;
  private sessionId: string | null = null;
  private origin: string | null = null;
  private generation = 0;
  private current: DigitalTwinInspectionIdentity | null = null;
  private loaded = false;
  private abort: AbortController | null = null;
  private selectionAbort: AbortController | null = null;
  private selectionRequestId: string | null = null;
  private operations: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: DigitalTwinInspectionControllerOptions) {
    this.unsubscribe = options.subscribeToMessages(this.handleMessage);
  }

  setAllowedParentOrigins(origins: readonly string[]): void {
    this.origins.clear();
    this.allowAnyOrigin = origins.includes('*');
    for (const origin of origins) if (origin && origin !== '*') this.origins.add(origin);
    if (this.origin && !this.isAllowedOrigin(this.origin)) this.resetSession();
  }

  markViewerReady(): void {
    if (this.disposed) return;
    this.ready = true;
    this.postReady();
  }

  notifyPartSelected(payload: DigitalTwinInspectionIdentity & { partKey: string | null }): boolean {
    if (!this.negotiated || !this.matches(payload) || !this.sessionId) return false;
    const causeRequestId = this.selectionRequestId;
    if (!causeRequestId) this.cancelSelection();
    const message = parseDigitalTwinInspectionMessage({
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: this.sessionId, type: 'event.inspectionPartSelected',
      payload: { ...payload, ...(causeRequestId ? { causeRequestId } : {}) },
    });
    if (!message) return false;
    this.post(message);
    return true;
  }

  notifyClosed(payload: DigitalTwinInspectionIdentity): boolean {
    if (!this.negotiated || !this.matches(payload) || !this.sessionId) return false;
    this.post({ channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: this.sessionId, type: 'event.inspectionClosed', payload });
    this.cancelSelection();
    this.abort?.abort();
    this.abort = null;
    this.generation++;
    this.current = null;
    this.loaded = false;
    this.operations = Promise.resolve();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.resetSession();
    this.disposed = true;
    this.unsubscribe();
  }

  private isAllowedOrigin(origin: string): boolean {
    return this.allowAnyOrigin || origin === this.options.viewerOrigin || this.origins.has(origin);
  }

  private readonly handleMessage = (event: DigitalTwinMessageEvent): void => {
    if (this.disposed || event.source !== this.options.parentWindow || !this.isAllowedOrigin(event.origin)) return;
    const base = parseDigitalTwinBridgeMessage(event.data);
    if (base?.type === 'host.hello') {
      if (this.sessionId !== base.sessionId || this.origin !== event.origin) this.resetSession();
      this.sessionId = base.sessionId;
      this.origin = event.origin;
      this.post({ channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
        sessionId: base.sessionId, type: 'bridge.ready' });
      this.postReady();
      return;
    }
    const message = parseDigitalTwinInspectionMessage(event.data);
    if (!message || !this.ready || !this.sessionId || message.sessionId !== this.sessionId || event.origin !== this.origin) return;
    if (message.type === 'host.inspectionHello') {
      if (message.payload.role !== 'detail') return;
      this.negotiated = true;
      this.post({ channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
        sessionId: this.sessionId, type: 'viewer.inspectionReady', requestId: message.requestId,
        payload: { role: 'detail', capabilities: ['inspectionLoad', 'modelVersionLoad', 'selectPart', 'selectionCause', 'cancelSelect', 'setProgress', 'reset'] } });
      return;
    }
    if (!this.negotiated) return;
    if (message.type === 'command.inspectionLoad' || message.type === 'command.inspectionLoadModelVersion') {
      this.cancelSelection();
      this.abort?.abort();
      this.abort = new AbortController();
      this.generation++;
      this.current = { loadId: message.payload.loadId, assetCode: message.payload.assetCode };
      this.loaded = false;
      this.operations = Promise.resolve();
      const generation = this.generation;
      this.enqueue(message.requestId, message.payload, async signal => {
        await this.options.load(message.payload, signal);
        if (!signal.aborted && generation === this.generation) this.loaded = true;
      }, false);
      return;
    }
    if (message.type === 'command.inspectionCancelSelect') {
      if (this.matches(message.payload)) this.cancelSelection();
    } else if (message.type === 'command.inspectionSelectPart') {
      if (!this.matches(message.payload)) return;
      this.cancelSelection();
      const selection = new AbortController();
      this.selectionAbort = selection;
      this.enqueue(message.requestId, message.payload, signal => {
        const combined = AbortSignal.any([signal, selection.signal]);
        combined.throwIfAborted();
        this.selectionRequestId = message.requestId;
        try {
          return this.options.selectPart(message.payload, combined);
        } finally {
          this.selectionRequestId = null;
        }
      });
    } else if (message.type === 'command.inspectionSetProgress') {
      this.enqueue(message.requestId, message.payload, signal => this.options.setProgress(message.payload, signal));
    } else if (message.type === 'command.inspectionReset') {
      this.enqueue(message.requestId, message.payload, signal => this.options.reset(message.payload, signal));
    }
  };

  private enqueue(requestId: string, identity: DigitalTwinInspectionIdentity, run: (signal: AbortSignal) => void | Promise<void>, requiresLoaded = true): void {
    if (!this.matches(identity) || !this.abort || !this.sessionId) return;
    const generation = this.generation;
    const sessionId = this.sessionId;
    const signal = this.abort.signal;
    const task = this.operations.then(() => {
      if (signal.aborted || generation !== this.generation) throw new Error('加载已取消');
      if (requiresLoaded && !this.loaded) throw new Error('高模尚未成功加载');
      return run(signal);
    });
    this.operations = task.catch(() => undefined);
    void task.then(() => this.reply(requestId, identity, sessionId, generation), error => {
      this.reply(requestId, identity, sessionId, generation, error instanceof Error ? error.message : '详情操作失败');
    });
  }

  private reply(requestId: string, identity: DigitalTwinInspectionIdentity, sessionId: string, generation: number, error?: string): void {
    if (this.disposed || generation !== this.generation || sessionId !== this.sessionId || !this.matches(identity)) return;
    this.post({ channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION, sessionId,
      type: 'viewer.inspectionResult', requestId, payload: { loadId: identity.loadId, assetCode: identity.assetCode },
      ...(error === undefined ? { ok: true } : { ok: false, error: (error || '详情操作失败').slice(0, 1024) }) });
  }

  private cancelSelection(): void {
    this.selectionAbort?.abort();
    this.selectionAbort = null;
  }

  private matches(identity: DigitalTwinInspectionIdentity): boolean {
    return this.current?.loadId === identity.loadId && this.current.assetCode === identity.assetCode;
  }

  private postReady(): void {
    if (!this.ready || !this.sessionId) return;
    this.post({ channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId: this.sessionId, type: 'viewer.ready', payload: { capabilities: [] } });
  }

  private post(message: DigitalTwinBridgeMessage | DigitalTwinInspectionMessage): void {
    if (!this.disposed && this.origin && this.sessionId === message.sessionId) this.options.postToParent(message, this.origin);
  }

  private resetSession(): void {
    this.cancelSelection();
    this.abort?.abort();
    this.abort = null;
    this.generation++;
    this.current = null;
    this.loaded = false;
    this.operations = Promise.resolve();
    this.negotiated = false;
    this.sessionId = null;
    this.origin = null;
  }
}
