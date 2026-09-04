import type { AlarmActivation } from '../runtime/babylon/AlarmManagerRuntime';
import { executeChartMarkerClick } from '../runtime/babylon/chartMarkerClick';
import { CHART_MARKER_REFRESH_EVENT } from '../shared/chartMarkerEmbed';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { deserializeScene } from '../editor/project/SceneSerializer';
import { clearDeploymentAssetManifest, installDeploymentAssetManifest } from '../runtime/assets/editorAssetUrl';
import { createBabylonViewport, isSoftwareWebGLFallbackAllowed, type BabylonViewport, type BabylonViewportRuntimeStatus } from '../runtime/babylon/createEngine';
import { applySavedSceneCameraView } from '../runtime/babylon/sceneCameraView';
import { DIGITAL_TWIN_CAMERA_CONTROL_STANDARD } from '../runtime/babylon/cameraControlStandard';
import { SceneRuntime, type SceneRuntimeModelLoadProgress } from '../runtime/babylon/SceneRuntime';
import { DataPlatformScreenOverlay } from '../runtime/babylon/DataPlatformScreenOverlay';
import { DataPlatformViewportScreenOverlay } from '../runtime/babylon/DataPlatformViewportScreenOverlay';
import type { DataPlatformScreenOverlayItem } from '../runtime/babylon/SceneRuntime';
import { findDigitalTwinAsset, buildDigitalTwinAssetIndex, type DigitalTwinAssetIndex } from '../shared/digitalTwinAssetCodes';
import { buildDigitalTwinSlotIndex } from '../shared/digitalTwinSlotCodes';
import { bindSceneModelSelectionPointer } from '../shared/sceneModelSelectionPointer';
import {
  AutoPatrolPlaybackController,
  collectAutoPatrolPlaybackRoutes,
  findAutoStartPatrolRoute,
  findFirstPlayablePatrolRoute,
  type AutoPatrolPlaybackRoute,
  type AutoPatrolPlaybackSnapshot,
} from '../runtime/babylon/AutoPatrolPlaybackController';
import { AutoPatrolRuntimeIntegration } from '../runtime/patrol/AutoPatrolRuntimeIntegration';
import {
  createSceneCameraPoseFromReplayCamera,
  type AutoPatrolInspectionReplayCamera,
} from '../runtime/patrol/AutoPatrolInspectionReplayController';
import type { AutoPatrolInspectionRecordStore } from '../runtime/patrol/AutoPatrolInspectionRecordStore';
import { mqttRuntimeStatusStore } from '../runtime/mqtt/mqttRuntimeStatus';
import { MqttStackerTelemetryClient } from '../runtime/mqtt/MqttStackerTelemetryClient';
import {
  parseDeploymentAssetManifest,
  parseDigitalTwinAllowedParentOrigins,
  parseDigitalTwinProjectRuntimeConfig,
  parsePlayerRuntimeConfig,
  type DigitalTwinProjectRuntimeConfig,
  type PlayerRuntimeConfig,
} from './runtimeConfig';
import { DigitalTwinInteractionController } from './DigitalTwinInteractionController';
import { createViewerModelClickHandler } from './viewerModelClick';
import type { DataPlatformScreenCommand } from '../runtime/babylon/dataPlatformScreenBridge';
import type { DataPlatformViewportScreenComponent } from '../editor/model/dataPlatformScreen';
import type { SceneDocument } from '../editor/model/SceneDocument';
import { hasManualRoamSpawnEntity, resolveManualRoamSpawnPose, resolveManualRoamAvatarSource } from '../editor/model/manualRoamSpawn';
import {
  CLICK_EVENT_FOCUS_DURATION_MS,
  CLICK_EVENT_FOCUS_RADIUS_SCALE,
  type ClickEventBindingPickedCell,
} from '../editor/model/clickEventBinding';
import {
  bindStatusOverlayPointerChordToggle,
  formatPlayerStatusFps,
  PLAYER_STATUS_FPS_SAMPLE_INTERVAL_MS,
  resolveInitialPlayerStatusOverlayVisibility,
  resolvePlayerFloatingControlToggle,
  shouldShowPlayerFloatingControl,
  shouldShowPlayerStatusOverlay,
  type PlayerFloatingControl,
} from './statusOverlayControls';
import {
  AutoPatrolControls,
  type AutoPatrolControlAction,
  type AutoPatrolControlPayload,
} from '../shared/ui/AutoPatrolControls';
import { ManualRoamControls } from '../shared/ui/ManualRoamControls';
import { useAutoPatrolInspectionHistory } from '../shared/ui/useAutoPatrolInspectionHistory';
import { SceneLoadingMask } from '../shared/ui/SceneLoadingMask';
import { FullscreenGlyph } from '../shared/ui/FullscreenGlyph';
import { useDigitalTwinFullscreen } from './useDigitalTwinFullscreen';
import {
  parseDigitalTwinHostRenderPixelRatioState,
  syncDigitalTwinViewerRenderSize,
} from './digitalTwinDisplayBridge';
import {
  createInitialManualRoamSnapshot,
  ManualRoamRuntime,
  type ManualRoamSnapshot,
  type ManualRoamTouchAction,
} from '../runtime/roam/ManualRoamRuntime';
import type {
  ManualRoamConfig,
  ManualRoamLocomotionMode,
  ManualRoamViewMode,
} from '../runtime/roam/manualRoamCore';
import { createDefaultManualRoamCollisionBoundsResolver } from '../runtime/roam/manualRoamCollisionBounds';
import { computePlayerLoadingProgress, PLAYER_SCENE_LOADING_TIMEOUT_MS } from './playerLoadingProgress';
import { DeferredAutoPatrolStartGate } from './deferredAutoPatrolStartGate';
import { PlayerInitialLoadGate } from './playerInitialLoadState';
import { resolvePublishedFetchConfig, startPublishedFetchDrive } from './publishedFetchDrive';
import {
  createPublishedSkyboxCameraBoundsControllerForDocument,
  type PublishedSkyboxCameraBoundsController,
} from './publishedSkyboxCameraBounds';
import './player.css';

type PlayerPhase = 'loading' | 'ready' | 'blocked';

const IDLE_AUTO_PATROL_SNAPSHOT: AutoPatrolPlaybackSnapshot = {
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

/** 将未知异常转换成状态层可展示消息。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 以 no-store 方式读取 JSON，避免部署配置刷新后仍命中浏览器缓存。 */
async function fetchJson(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`读取 ${url.pathname} 失败：HTTP ${response.status}。`);
  return JSON.parse(await response.text()) as unknown;
}

/** 数字孪生部署每次启动都从数据中台读取项目级配置，因此回滚版本不会回滚运行配置。 */
async function fetchDigitalTwinRuntimeConfig(
  config: PlayerRuntimeConfig,
  signal: AbortSignal,
): Promise<DigitalTwinProjectRuntimeConfig | null> {
  if (!config.digitalTwin) return null;
  const endpoint = new URL(config.digitalTwin.runtimeConfigEndpoint, document.baseURI);
  const response = await fetch(endpoint, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ projectId: config.digitalTwin.projectId }),
    signal,
  });
  if (!response.ok) throw new Error(`读取项目运行配置失败：HTTP ${response.status}。`);
  const runtimeConfig = parseDigitalTwinProjectRuntimeConfig(JSON.parse(await response.text()) as unknown);
  if (runtimeConfig.projectId !== config.digitalTwin.projectId) throw new Error('项目运行配置与部署项目不匹配。');
  return runtimeConfig;
}

function applyDigitalTwinRuntimeConfig(
  config: PlayerRuntimeConfig,
  runtimeConfig: DigitalTwinProjectRuntimeConfig | null,
): PlayerRuntimeConfig {
  if (!runtimeConfig) return config;
  if (!runtimeConfig.runtimeEnabled) throw new Error('该数字孪生项目当前已在数据中台停用。');
  const address = runtimeConfig.mqttBrokerUrl ?? "";
  return {
    ...config,
    mqtt: {
      ...config.mqtt,
      address,
      enabled: config.mqtt.enabled && Boolean(address) && config.mqtt.subscriptions.length > 0,
    },
  };
}
/** 以 no-store 方式读取场景文本并保留 SceneSerializer 的统一校验入口。 */
async function fetchText(url: URL, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`读取 ${url.pathname} 失败：HTTP ${response.status}。`);
  return response.text();
}

/** 把 #RRGGBB 同步到 Babylon 清屏色。 */
function applySceneBackground(viewport: BabylonViewport, color: string): void {
  viewport.scene.clearColor.set(
    Number.parseInt(color.slice(1, 3), 16) / 255,
    Number.parseInt(color.slice(3, 5), 16) / 255,
    Number.parseInt(color.slice(5, 7), 16) / 255,
    1,
  );
}

/** 独立 Web Viewer 根组件，负责配置、资源、场景、遥测和完整释放生命周期。 */
export function PlayerApp() {
  const playerRootRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneFullscreen = useDigitalTwinFullscreen(playerRootRef);
  const viewportRef = useRef<BabylonViewport | null>(null);
  const chartMarkerClickRef = useRef<((entityId: string) => boolean) | null>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const autoPatrolPlaybackRef = useRef<AutoPatrolPlaybackController | null>(null);
  const autoPatrolStartGateRef = useRef<DeferredAutoPatrolStartGate | null>(null);
  const manualRoamRef = useRef<ManualRoamRuntime | null>(null);
  const dataPlatformScreenContextRef = useRef<{
    sceneDocument: SceneDocument;
    assetIndex: DigitalTwinAssetIndex;
  } | null>(null);
  const [phase, setPhase] = useState<PlayerPhase>('loading');
  const [viewerSelectedEntityIds, setViewerSelectedEntityIds] = useState<string[]>([]);
  const [viewportScreen, setViewportScreen] = useState<DataPlatformViewportScreenComponent | null>(null);
  const [autoPatrolRoutes, setAutoPatrolRoutes] = useState<AutoPatrolPlaybackRoute[]>([]);
  const [autoPatrolSnapshot, setAutoPatrolSnapshot] = useState<AutoPatrolPlaybackSnapshot>(IDLE_AUTO_PATROL_SNAPSHOT);
  const [autoPatrolRecordStore, setAutoPatrolRecordStore] = useState<AutoPatrolInspectionRecordStore | null>(null);
  const [manualRoamSnapshot, setManualRoamSnapshot] = useState<ManualRoamSnapshot>(createInitialManualRoamSnapshot);
  /** 发布场景是否包含手动漫游 POI；无出生点时不渲染漫游面板、不创建漫游运行时。 */
  const [hasManualRoamSpawn, setHasManualRoamSpawn] = useState(false);
  const [message, setMessage] = useState('场景加载中...');
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [chartMarkerError, setChartMarkerError] = useState('');
  const [viewportRuntimeIssue, setViewportRuntimeIssue] = useState(false);
  const [environmentRuntimeIssue, setEnvironmentRuntimeIssue] = useState(false);
  const [statusOverlayVisible, setStatusOverlayVisible] = useState(false);
  const openedDigitalTwinFloatingControlRef = useRef<PlayerFloatingControl | null>(null);
  const [openedDigitalTwinFloatingControl, setOpenedDigitalTwinFloatingControl] = useState<PlayerFloatingControl | null>(null);
  const [playerFps, setPlayerFps] = useState<number | null>(null);
  const [config, setConfig] = useState<PlayerRuntimeConfig | null>(null);
  const [startupPercent, setStartupPercent] = useState(6);
  const [modelLoadProgress, setModelLoadProgress] = useState<SceneRuntimeModelLoadProgress | null>(null);
  /** 首次场景加载全部结算后置位：后续按需加载（如 MQTT 货物模板）不再重新弹出全屏蒙版。 */
  const initialLoadCompletedRef = useRef(false);
  const completeInitialLoadRef = useRef<(() => void) | null>(null);
  /** 首次场景加载是否仍在途：驱动超时兜底与蒙版显示。 */
  const modelLoadingInProgress = modelLoadProgress?.loading === true
    && modelLoadProgress.totalCount > 0
    && !initialLoadCompletedRef.current;

  useEffect(() => {
    if (!modelLoadingInProgress) return undefined;
    const timer = window.setTimeout(() => {
      completeInitialLoadRef.current?.();
      setRuntimeMessage('部分场景资源加载超时，场景可能尚未完整显示。');
    }, PLAYER_SCENE_LOADING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [modelLoadingInProgress]);
  const mqttStatus = useSyncExternalStore(
    mqttRuntimeStatusStore.subscribe,
    mqttRuntimeStatusStore.getSnapshot,
    mqttRuntimeStatusStore.getSnapshot,
  );
  const applyHistoryReplayCamera = useCallback((camera: AutoPatrolInspectionReplayCamera): void => {
    viewportRef.current?.applyCameraPose(createSceneCameraPoseFromReplayCamera(camera), { animate: false });
  }, []);
  const updateOpenedDigitalTwinFloatingControl = useCallback((control: PlayerFloatingControl | null): void => {
    openedDigitalTwinFloatingControlRef.current = control;
    setOpenedDigitalTwinFloatingControl(control);
  }, []);
  const beginHistoryReplay = useCallback((): void => {
    autoPatrolStartGateRef.current?.cancelPending();
    manualRoamRef.current?.setEnabled(false);
    autoPatrolPlaybackRef.current?.stop();
    viewportRef.current?.cancelCameraTransition('manual-input');
  }, []);
  const handleDataPlatformScreenCommand = useCallback((
    _item: DataPlatformScreenOverlayItem | null,
    command: DataPlatformScreenCommand,
  ): void => {
    const runtime = runtimeRef.current;
    const context = dataPlatformScreenContextRef.current;
    if (!runtime || !context) return;
    if (command.type === 'screen.clearSelection') {
      runtime.clearExternalHighlight();
      return;
    }

    const entityId = command.payload.entityId
      ?? (command.payload.assetCode
        ? (() => {
          const lookup = findDigitalTwinAsset(context.assetIndex, command.payload.assetCode);
          return lookup.status === 'found' ? lookup.entityId : null;
        })()
        : null);
    if (!entityId || !context.sceneDocument.entities[entityId]) {
      setRuntimeMessage('大屏联动目标不存在或资产编号不唯一。');
      return;
    }

    runtime.setExternalHighlightEntityIds([entityId]);
    if (command.type !== 'screen.focusEntity') return;
    const bounds = runtime.getEntitiesWorldBounds([entityId]);
    const viewport = viewportRef.current;
    if (!bounds || !viewport) {
      setRuntimeMessage('大屏联动目标的三维几何尚未就绪。');
      return;
    }
    viewport.focusOnBounds(bounds, { animate: true, durationMs: CLICK_EVENT_FOCUS_DURATION_MS });
  }, []);
  const handleViewportDataPlatformScreenCommand = useCallback((command: DataPlatformScreenCommand): void => {
    handleDataPlatformScreenCommand(null, command);
  }, [handleDataPlatformScreenCommand]);
  const {
    history: autoPatrolHistory,
    handleHistoryAction,
    pauseReplay: pauseHistoryReplay,
  } = useAutoPatrolInspectionHistory({
    recordStore: autoPatrolRecordStore,
    applyCamera: applyHistoryReplayCamera,
    onReplayStart: beginHistoryReplay,
    onError: setRuntimeMessage,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const abortController = new AbortController();
    let disposed = false;
    let viewport: BabylonViewport | null = null;
    let runtime: SceneRuntime | null = null;
    let autoPatrolPlayback: AutoPatrolPlaybackController | null = null;
    let autoPatrolIntegration: AutoPatrolRuntimeIntegration | null = null;
    let manualRoam: ManualRoamRuntime | null = null;
    let skyboxCameraBounds: PublishedSkyboxCameraBoundsController | null = null;
    let interactionController: DigitalTwinInteractionController | null = null;
    // 宿主握手可能晚于首条遥测；仅保留最新主题，在 ready 后确认报警仍有效再发送。
    let pendingAlarmTheme: AlarmActivation | null = null;
    const flushAlarmTheme = (): void => {
      const pending = pendingAlarmTheme;
      if (!pending?.theme || disposed) return;
      if (!runtime?.isAlarmActive(pending.managerId, pending.targetId)) { pendingAlarmTheme = null; return; }
      if (interactionController?.showScreen(pending.theme)) { pendingAlarmTheme = null; setChartMarkerError(''); }
    };
    const autoPatrolStartGate = new DeferredAutoPatrolStartGate();
    autoPatrolStartGateRef.current = autoPatrolStartGate;
    initialLoadCompletedRef.current = false;
    setModelLoadProgress(null);
    const initialLoadGate = new PlayerInitialLoadGate(() => {
      initialLoadCompletedRef.current = true;
      interactionController?.markInitialLoadComplete();
    }, {
      // 超时只结束蒙版和握手；真实资源结算后才放行最新巡检启动请求。
      onSettled: () => autoPatrolStartGate.markReady(),
    });
    const forceCompleteInitialLoad = () => initialLoadGate.forceComplete();
    completeInitialLoadRef.current = forceCompleteInitialLoad;
    let unsubscribeAutoPatrolSnapshot: (() => void) | null = null;
    let unsubscribeManualRoamSnapshot: (() => void) | null = null;
    let removeAutoPatrolManualInputListeners: (() => void) | null = null;
    let removeModelSelectionListeners: (() => void) | null = null;
    let mqttClient: MqttStackerTelemetryClient | null = null;
    let resize: (() => void) | null = null;
    let canvasResizeObserver: ResizeObserver | null = null;
    let localHighlightedEntityIds: string[] = [];
    let hostRenderPixelRatio: number | undefined;

    resize = () => {
      if (!viewport) return;
      syncDigitalTwinViewerRenderSize(viewport, {
        devicePixelRatio: window.devicePixelRatio || 1,
        hostRenderPixelRatio,
      });
    };
    const handleHostDisplayMessage = (event: MessageEvent<unknown>): void => {
      if (window.parent === window || event.source !== window.parent) return;
      const state = parseDigitalTwinHostRenderPixelRatioState(event.data);
      if (!state) return;
      hostRenderPixelRatio = state.renderPixelRatio;
      resize?.();
    };
    window.addEventListener('message', handleHostDisplayMessage);

    /** 处理 WebGL 丢失和渲染异常，恢复事件只清除对应运行时阻断。 */
    const handleRuntimeStatus = (status: BabylonViewportRuntimeStatus): void => {
      if (disposed) return;
      const recovered = status.type === 'context-restored' || status.type === 'render-recovered';
      setViewportRuntimeIssue(!recovered);
      setRuntimeMessage(recovered ? null : status.message);
      if (status.type === 'context-restored') resize?.();
    };

    /** 按部署契约顺序启动 Viewer，manifest 必须先于场景反序列化安装。 */
    const start = async (): Promise<void> => {
      try {
        const runtimeConfigUrl = new URL('./runtime-config.json', document.baseURI);
        const baseConfig = parsePlayerRuntimeConfig(await fetchJson(runtimeConfigUrl, abortController.signal));
        const projectRuntimeConfig = await fetchDigitalTwinRuntimeConfig(baseConfig, abortController.signal);
        const parsedConfig = applyDigitalTwinRuntimeConfig(baseConfig, projectRuntimeConfig);
        if (disposed) return;
        interactionController = new DigitalTwinInteractionController({
          parentWindow: window.parent,
          viewerOrigin: window.location.origin,
          projectId: parsedConfig.digitalTwin?.projectId,
          onReady: flushAlarmTheme,
          subscribeToMessages: (listener) => {
            const handleMessage = (event: MessageEvent<unknown>) => listener({
              data: event.data,
              origin: event.origin,
              source: event.source,
            });
            window.addEventListener('message', handleMessage);
            return () => window.removeEventListener('message', handleMessage);
          },
          postToParent: (message, targetOrigin) => window.parent.postMessage(message, targetOrigin),
          now: () => typeof performance === 'undefined' ? Date.now() : performance.now(),
        });
        interactionController.setAllowedParentOrigins(
          projectRuntimeConfig ? parseDigitalTwinAllowedParentOrigins(projectRuntimeConfig.config) : [],
        );
        interactionController.markInitialLoadStarted();
        document.title = parsedConfig.page.title;
        setConfig(parsedConfig);
        setStatusOverlayVisible(resolveInitialPlayerStatusOverlayVisibility(
          parsedConfig.viewer.showStatusOverlay,
          Boolean(parsedConfig.digitalTwin),
        ));
        setMessage(parsedConfig.page.loadingText);
        setStartupPercent(14);

        const assetBaseUrl = new URL(parsedConfig.paths.assetBase, document.baseURI);
        const manifestUrl = new URL(parsedConfig.paths.assetManifest, document.baseURI);
        const manifestMappings = parseDeploymentAssetManifest(await fetchJson(manifestUrl, abortController.signal), assetBaseUrl);
        if (disposed) return;
        installDeploymentAssetManifest(manifestMappings);
        setStartupPercent(20);

        const sceneUrl = new URL(parsedConfig.paths.scene, document.baseURI);
        const sceneDocument = deserializeScene(await fetchText(sceneUrl, abortController.signal));
        setViewportScreen(sceneDocument.sceneSettings.viewportScreen);
        const digitalTwinAssetIndex = buildDigitalTwinAssetIndex(sceneDocument);
        const digitalTwinSlotIndex = buildDigitalTwinSlotIndex(sceneDocument);
        dataPlatformScreenContextRef.current = { sceneDocument, assetIndex: digitalTwinAssetIndex };
        if (parsedConfig.digitalTwin) {
          sceneDocument.fetchConfig = resolvePublishedFetchConfig(sceneDocument.fetchConfig, projectRuntimeConfig);
        }
        if (projectRuntimeConfig) {
          (globalThis as typeof globalThis & { __ZENDING_DIGITAL_TWIN_CONFIG__?: Record<string, unknown> })
            .__ZENDING_DIGITAL_TWIN_CONFIG__ = projectRuntimeConfig.config;
        }
        if (disposed) return;
        setStartupPercent(30);

        viewport = createBabylonViewport(canvas, handleRuntimeStatus, {
          showGrid: parsedConfig.viewer.showGrid,
          allowCameraControl: parsedConfig.viewer.allowCameraControl,
          requireHardwareAcceleration: !isSoftwareWebGLFallbackAllowed(),
          keepRenderingInBackground: true,
          initialSensitivity: sceneDocument.sceneSettings.sensitivity,
        });
        viewportRef.current = viewport;
        applySceneBackground(viewport, parsedConfig.page.backgroundColor);
        viewport.setViewDistance(sceneDocument.sceneSettings.camera.viewDistance);
        viewport.setSensitivity(sceneDocument.sceneSettings.sensitivity);
        applySavedSceneCameraView(viewport, sceneDocument.sceneSettings.camera, {
          animate: false,
          lockStandardOrientation: false,
        });
        skyboxCameraBounds = createPublishedSkyboxCameraBoundsControllerForDocument(
          viewport.scene,
          viewport.camera,
          sceneDocument,
        );
        resize();

        runtime = new SceneRuntime(
          viewport.scene,
          (logMessage) => {
            console.info(`[Viewer] ${logMessage}`);
            if (!disposed) setRuntimeMessage(logMessage);
          },
          undefined,
          (snapshot) => {
            if (disposed) return;
            if (snapshot.phase === 'loading') {
              setEnvironmentRuntimeIssue(false);
              setRuntimeMessage(snapshot.message || '环境模型正在加载...');
            } else if (snapshot.phase === 'error') {
              setEnvironmentRuntimeIssue(true);
              setRuntimeMessage(`环境模型加载失败：${snapshot.message || '未知错误'}`);
            } else if (snapshot.phase === 'ready') {
              setEnvironmentRuntimeIssue(false);
              setRuntimeMessage(null);
            }
          },
          (progress) => {
            if (disposed) return;
            initialLoadGate.update(progress);
            setModelLoadProgress(progress);
          },
        );
        runtimeRef.current = runtime;
        runtime.disableEditorLightMarkers();
        runtime.disableEditorAutoPatrolMarkers();
        runtime.disableEditorManualRoamSpawnMarkers();
        runtime.disableEditorClickEventBindingMarkers();
        initialLoadGate.startTracking();
        runtime.sync(sceneDocument);
        setStartupPercent(36);
        const environment = sceneDocument.sceneSettings.environment;
        if (environment) {
          void runtime.applyEnvironment(environment, { requestId: null, autoAlign: false }).catch((error) => {
            if (disposed) return;
            setEnvironmentRuntimeIssue(true);
            setRuntimeMessage(`环境模型加载失败：${getErrorMessage(error)}`);
          });
        } else {
          runtime.syncEnvironment(null);
        }
        if (disposed) return;
        setStartupPercent(50);
        runtime.beginTelemetryPreview();
        if (parsedConfig.digitalTwin) {
          void startPublishedFetchDrive(runtime, sceneDocument.fetchConfig, abortController.signal);
        }

        const patrolRoutes = collectAutoPatrolPlaybackRoutes(sceneDocument);
        const autoPatrolScopeId = parsedConfig.digitalTwin?.projectId
          ? `${parsedConfig.digitalTwin.projectId}:${sceneDocument.id}`
          : sceneDocument.id;
        autoPatrolIntegration = new AutoPatrolRuntimeIntegration({
          engine: viewport.engine,
          scopeId: autoPatrolScopeId,
          getCamera: () => viewport?.camera ?? null,
          getInspectionContext: () => {
            const snapshot = autoPatrolPlayback?.getSnapshot();
            return {
              taskId: snapshot?.taskId ?? null,
              routeId: snapshot?.routeId ?? null,
              routeName: snapshot?.routeName ?? null,
            };
          },
          setHighlightedEntityIds: (entityIds) => runtime?.setLocalHighlightEntityIds(
            entityIds.length > 0 ? entityIds : localHighlightedEntityIds,
          ),
          onError: (errorMessage, error) => {
            console.error(errorMessage, error);
            setRuntimeMessage(errorMessage);
          },
        });
        setAutoPatrolRecordStore(autoPatrolIntegration.recordStore);
        autoPatrolPlayback = new AutoPatrolPlaybackController({
          readPose: () => viewport!.getCameraPose(),
          writePose: (pose) => viewport!.applyCameraPose(pose, { animate: false }),
          now: () => typeof performance === 'undefined' ? Date.now() : performance.now(),
          wallNow: Date.now,
          subscribeFrame: (callback) => {
            const observer = viewport!.scene.onBeforeRenderObservable.add(callback);
            return () => viewport?.scene.onBeforeRenderObservable.remove(observer);
          },
          captureScreenshot: autoPatrolIntegration.captureScreenshot,
          onInspectionEvent: autoPatrolIntegration.onInspectionEvent,
          onInspectionScreenshot: autoPatrolIntegration.onInspectionScreenshot,
          onInspectionStart: autoPatrolIntegration.onInspectionStart,
          onInspectionTrajectory: autoPatrolIntegration.onInspectionTrajectory,
          onInspectionRecord: autoPatrolIntegration.onInspectionRecord,
        });
        autoPatrolPlayback.setRoutes(patrolRoutes);
        unsubscribeAutoPatrolSnapshot = autoPatrolPlayback.subscribe(() => {
          if (!disposed && autoPatrolPlayback) setAutoPatrolSnapshot(autoPatrolPlayback.getSnapshot());
        });
        autoPatrolPlaybackRef.current = autoPatrolPlayback;
        setAutoPatrolRoutes(patrolRoutes);

        const notifyManualInput = (): void => {
          pauseHistoryReplay();
          interactionController?.notifyManualCameraInput();
          autoPatrolPlayback?.notifyManualInput();
          autoPatrolPlayback?.notifyCameraChangedWhilePaused();
        };
        const sceneHasManualRoamSpawn = hasManualRoamSpawnEntity(sceneDocument);
        if (!disposed) setHasManualRoamSpawn(sceneHasManualRoamSpawn);
        // 没有手动漫游 POI 时不创建运行时，避免加载人物并对外暴露 startManualRoam。
        if (parsedConfig.viewer.allowCameraControl && sceneHasManualRoamSpawn) {
          manualRoam = new ManualRoamRuntime({
            scene: viewport.scene,
            engine: viewport.engine,
            camera: viewport.camera,
            canvas,
            avatarUrl: resolveManualRoamAvatarSource(sceneDocument),
            resolveSpawnPose: () => resolveManualRoamSpawnPose(sceneDocument),
            resolveCollisionBounds: createDefaultManualRoamCollisionBoundsResolver({
              getSceneDocument: () => sceneDocument,
              getRuntime: () => runtime,
              getMeshes: () => viewport!.scene.meshes,
            }),
            setOrbitControlsEnabled: viewport.setCameraControlsEnabled,
            onActivated: () => {
              pauseHistoryReplay();
              viewport?.cancelCameraTransition('manual-input');
              autoPatrolPlayback?.stop();
              interactionController?.notifyManualCameraInput();
            },
            onManualInput: notifyManualInput,
            onLog: (logMessage) => console.info(`[Viewer Roam] ${logMessage}`),
          });
          unsubscribeManualRoamSnapshot = manualRoam.subscribe(() => {
            if (!disposed && manualRoam) setManualRoamSnapshot(manualRoam.getSnapshot());
          });
          manualRoamRef.current = manualRoam;
          setManualRoamSnapshot(manualRoam.getSnapshot());
        }
        const handleModelClick = createViewerModelClickHandler(sceneDocument, {
          updateSelection: (entityIds) => {
            const nextEntityIds = [...entityIds];
            localHighlightedEntityIds = nextEntityIds;
            setViewerSelectedEntityIds(nextEntityIds);
            runtime!.setLocalHighlightEntityIds(nextEntityIds);
          },
          setSlotHighlight: (entityId, cell) => runtime!.setLocalSlotHighlight(entityId, cell),
          focusTarget: (entityId, cell) => {
            const bounds = cell
              ? runtime!.getLocatorCellWorldBounds(entityId, cell)
              : runtime!.getEntitiesWorldBounds([entityId]);
            if (bounds && viewport) {
              viewport.focusOnBounds(bounds, { animate: true, durationMs: CLICK_EVENT_FOCUS_DURATION_MS, useModelFocusAngle: false, radiusScale: CLICK_EVENT_FOCUS_RADIUS_SCALE });
            }
          },
          triggerManualEvents: (entityId) => { autoPatrolPlayback?.triggerManualEventsForTarget(entityId); },
          emitAssetClicked: (payload) => interactionController?.notifyAssetClicked(payload),
          showScreen: (screen) => {
            if (interactionController?.showScreen(screen)) {
              setChartMarkerError('');
            } else {
              setChartMarkerError('大屏展示未发送：请从同项目的数据中台大屏中打开当前数字孪生。');
            }
          },
        });
        runtime.onAlarmActivated = event => {
          if (disposed || !runtime) return;
          if (event.focusCamera) {
            const bounds = runtime.getEntitiesWorldBounds([event.targetId]);
            if (bounds && viewport) { manualRoam?.setEnabled(false); notifyManualInput(); viewport.focusOnBounds(bounds, { animate: true, durationMs: CLICK_EVENT_FOCUS_DURATION_MS }); }
          }
          if (event.theme) {
            pendingAlarmTheme = event;
            flushAlarmTheme();
            if (pendingAlarmTheme) setChartMarkerError('告警主题等待连接：请在同项目的数据中台大屏中打开数字孪生。');
          }
        };
        chartMarkerClickRef.current = (markerId) => {
          if (disposed || !runtime) return false;
          pauseHistoryReplay();
          setChartMarkerError('');
          return executeChartMarkerClick(sceneDocument, markerId, {
            focusEntity: (targetId) => {
              const bounds = runtime!.getEntitiesWorldBounds([targetId]);
              if (!bounds || !viewport) return false;
              manualRoam?.setEnabled(false);
              notifyManualInput();
              viewport.focusOnBounds(bounds, { animate: true, durationMs: CLICK_EVENT_FOCUS_DURATION_MS });
              return true;
            },
            selectEntity: (targetId) => {
              localHighlightedEntityIds = [targetId];
              setViewerSelectedEntityIds([targetId]);
              runtime!.setLocalSlotHighlight('', null);
              runtime!.setLocalHighlightEntityIds([targetId]);
            },
            refreshMarker: (entityId) => window.dispatchEvent(new CustomEvent(CHART_MARKER_REFRESH_EVENT, { detail: entityId })),
            showTheme: (screen) => {
              if (!interactionController?.showScreen(screen)) {
                setChartMarkerError('主题展示未发送：请从数据中台大屏中打开当前数字孪生，并确认主题与当前项目一致。');
              }
            },
            reportError: setChartMarkerError,
          });
        };
        removeModelSelectionListeners = bindSceneModelSelectionPointer(canvas, {
          clickTolerancePx: DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.selection.clickTolerancePx,
          onSelectionClick: ({ clientX, clientY }) => {
            if (disposed || !runtime) return;
            pauseHistoryReplay();
            const markerId = runtime.pickChartMarkerAtCanvasPoint(clientX, clientY, canvas);
            if (markerId && chartMarkerClickRef.current?.(markerId)) return;
            const modelHit = runtime.pickRuntimeModelHitAtCanvasPoint(clientX, clientY, canvas);
            // 货格反解对所有内置货格填充体做射线检测取最近命中，避免透过前排货架空格穿透到另一排。
            const cellHit = runtime.pickBuiltInSlotCellAtCanvasPoint(clientX, clientY, canvas);
            let entityId = modelHit?.entityId ?? null;
            let pickedCell: ClickEventBindingPickedCell | null = null;
            if (cellHit && (!modelHit || !modelHit.precise || modelHit.entityId === cellHit.hostEntityId || cellHit.distance < modelHit.distance)) {
              entityId = cellHit.hostEntityId;
              pickedCell = { locatorEntityId: cellHit.locatorEntityId, row: cellHit.row, column: cellHit.column, layer: cellHit.layer };
            }
            handleModelClick(entityId, pickedCell);
          },
          onDragStarted: () => {
            if (parsedConfig.viewer.allowCameraControl) notifyManualInput();
          },
        });

        if (parsedConfig.viewer.allowCameraControl) {
          const handlePointerMove = (event: globalThis.PointerEvent): void => {
            const secondaryOrAdditionalPointerDrag = event.buttons !== 0
              && ((event.buttons & 1) === 0 || !event.isPrimary);
            if (secondaryOrAdditionalPointerDrag) notifyManualInput();
          };
          const handleWheel = (): void => notifyManualInput();
          const handleKeyDown = (event: KeyboardEvent): void => {
            if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC'].includes(event.code)) return;
            const target = event.target;
            const interactiveControlFocused = target instanceof HTMLElement
              && Boolean(target.closest('input, textarea, select, button, a, [role="button"], [contenteditable="true"]'));
            if (interactiveControlFocused) return;
            notifyManualInput();
          };
          canvas.addEventListener('pointermove', handlePointerMove);
          canvas.addEventListener('wheel', handleWheel, { passive: true });
          window.addEventListener('keydown', handleKeyDown, true);
          removeAutoPatrolManualInputListeners = () => {
            canvas.removeEventListener('pointermove', handlePointerMove);
            canvas.removeEventListener('wheel', handleWheel);
            window.removeEventListener('keydown', handleKeyDown, true);
          };
        }

        const autoStartRoute = findAutoStartPatrolRoute(patrolRoutes);
        if (autoStartRoute) {
          autoPatrolStartGate.request(() => {
            if (disposed || !autoPatrolPlayback) return;
            const result = autoPatrolPlayback.start(autoStartRoute.entityId);
            if (!result.ok) setRuntimeMessage(result.error);
          });
        }

        const preferredPatrolRoute = patrolRoutes.find((route) => (
          route.component.isDefault
          && route.component.enabled
          && route.component.waypoints.length >= 2
        )) ?? findFirstPlayablePatrolRoute(patrolRoutes);
        const manualRoamRuntime = manualRoam;

        interactionController.markViewerReady({
          hardwareGpuVerified: true,
          assetIndex: digitalTwinAssetIndex,
          slotIndex: digitalTwinSlotIndex,
          getFocusBounds: (entityId, slot) => slot
            ? runtime!.getLocatorCellWorldBounds(entityId, slot)
            : runtime!.getEntitiesWorldBounds([entityId]),
          focusOnBounds: (bounds, options) => {
            manualRoam?.setEnabled(false);
            viewport!.focusOnBounds(bounds, options);
          },
          triggerTargetClick: (entityId, slot) => {
            pauseHistoryReplay();
            handleModelClick(entityId, slot ? { locatorEntityId: entityId, ...slot } : null, { focus: false });
          },
          cancelCameraTransition: (reason) => viewport!.cancelCameraTransition(reason),
          setExternalHighlightEntityIds: (entityIds) => runtime!.setExternalHighlightEntityIds(entityIds),
          setExternalSlotHighlight: (entityId, coordinate) => runtime!.setExternalSlotHighlight(entityId, coordinate),
          clearExternalHighlight: () => runtime!.clearExternalHighlight(),
          getPatrolPhase: () => autoPatrolPlayback!.getSnapshot().phase,
          pausePatrol: () => { autoPatrolPlayback!.pause(false); },
          notifyCameraChangedWhilePaused: () => autoPatrolPlayback!.notifyCameraChangedWhilePaused(),
          ...(preferredPatrolRoute ? {
            startAutoPatrol: () => {
              const nextControl = resolvePlayerFloatingControlToggle(
                openedDigitalTwinFloatingControlRef.current,
                'auto-patrol',
              );
              if (nextControl === null) {
                autoPatrolStartGate.cancelPending();
                autoPatrolPlayback?.stop();
                updateOpenedDigitalTwinFloatingControl(null);
                return;
              }

              updateOpenedDigitalTwinFloatingControl('auto-patrol');
              manualRoamRuntime?.setEnabled(false);
              let startError: string | null = null;
              autoPatrolStartGate.request(() => {
                if (
                  disposed
                  || !autoPatrolPlayback
                  || openedDigitalTwinFloatingControlRef.current !== 'auto-patrol'
                ) return;
                const patrolController = autoPatrolPlayback;
                const result = patrolController.getSnapshot().phase === 'paused'
                  ? patrolController.resume()
                  : patrolController.start(preferredPatrolRoute.entityId);
                if (!result.ok) {
                  startError = result.error;
                  updateOpenedDigitalTwinFloatingControl(null);
                  setRuntimeMessage(result.error);
                }
              });
              if (startError) throw new Error(startError);
            },
          } : {}),
          ...(manualRoamRuntime ? {
            startManualRoam: () => {
              const nextControl = resolvePlayerFloatingControlToggle(
                openedDigitalTwinFloatingControlRef.current,
                'manual-roam',
              );
              if (nextControl === null) {
                manualRoamRuntime.setEnabled(false);
                updateOpenedDigitalTwinFloatingControl(null);
                return;
              }

              autoPatrolStartGate.cancelPending();
              autoPatrolPlayback?.stop();
              manualRoamRuntime.setEnabled(true);
              updateOpenedDigitalTwinFloatingControl('manual-roam');
            },
          } : {}),
        });

        mqttClient = new MqttStackerTelemetryClient((logMessage) => console.info(`[Viewer MQTT] ${logMessage}`));
        mqttClient.updateConfig(parsedConfig.mqtt);
        if (typeof ResizeObserver !== 'undefined') {
          canvasResizeObserver = new ResizeObserver(resize);
          canvasResizeObserver.observe(canvas);
        }
        window.addEventListener('resize', resize);
        resize();
        requestAnimationFrame(() => {
          if (!disposed) resize?.();
        });
        setPhase('ready');
      } catch (error) {
        if (disposed || abortController.signal.aborted) return;
        console.error('Web Viewer 启动失败。', error);
        setPhase('blocked');
        setMessage(`Web Viewer 启动失败：${getErrorMessage(error)}`);
        interactionController?.dispose();
        interactionController = null;
        initialLoadGate.dispose();
        autoPatrolStartGate.dispose();
        if (autoPatrolStartGateRef.current === autoPatrolStartGate) {
          autoPatrolStartGateRef.current = null;
        }
        if (completeInitialLoadRef.current === forceCompleteInitialLoad) {
          completeInitialLoadRef.current = null;
        }
        mqttClient?.dispose();
        unsubscribeManualRoamSnapshot?.();
        manualRoam?.dispose();
        manualRoamRef.current = null;
        removeModelSelectionListeners?.();
        removeAutoPatrolManualInputListeners?.();
        unsubscribeAutoPatrolSnapshot?.();
        autoPatrolPlayback?.dispose();
        autoPatrolIntegration?.dispose();
        setAutoPatrolRecordStore(null);
        autoPatrolPlaybackRef.current = null;
        dataPlatformScreenContextRef.current = null;
        chartMarkerClickRef.current = null;
        setViewportScreen(null);
        runtimeRef.current = null;
        viewportRef.current = null;
        canvasResizeObserver?.disconnect();
        canvasResizeObserver = null;
        if (resize) window.removeEventListener('resize', resize);
        window.removeEventListener('message', handleHostDisplayMessage);
        skyboxCameraBounds?.dispose();
        skyboxCameraBounds = null;
        runtime?.dispose();
        viewport?.dispose();
        clearDeploymentAssetManifest();
      }
    };

    void start();
    return () => {
      disposed = true;
      abortController.abort();
      canvasResizeObserver?.disconnect();
      canvasResizeObserver = null;
      if (resize) window.removeEventListener('resize', resize);
      window.removeEventListener('message', handleHostDisplayMessage);
      interactionController?.dispose();
      interactionController = null;
      initialLoadGate.dispose();
      autoPatrolStartGate.dispose();
      if (autoPatrolStartGateRef.current === autoPatrolStartGate) {
        autoPatrolStartGateRef.current = null;
      }
      if (completeInitialLoadRef.current === forceCompleteInitialLoad) {
        completeInitialLoadRef.current = null;
      }
      mqttClient?.dispose();
      unsubscribeManualRoamSnapshot?.();
      manualRoam?.dispose();
      manualRoamRef.current = null;
      removeModelSelectionListeners?.();
      removeAutoPatrolManualInputListeners?.();
      unsubscribeAutoPatrolSnapshot?.();
      autoPatrolPlayback?.dispose();
      autoPatrolIntegration?.dispose();
      setAutoPatrolRecordStore(null);
      autoPatrolPlaybackRef.current = null;
      dataPlatformScreenContextRef.current = null;
      chartMarkerClickRef.current = null;
      setViewportScreen(null);
      runtimeRef.current = null;
      viewportRef.current = null;
      skyboxCameraBounds?.dispose();
      skyboxCameraBounds = null;
      runtime?.dispose();
      viewport?.dispose();
      clearDeploymentAssetManifest();
    };
  }, [pauseHistoryReplay]);

  const isDigitalTwin = Boolean(config?.digitalTwin);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || phase !== 'ready' || !isDigitalTwin) return;

    return bindStatusOverlayPointerChordToggle(canvas, window, () => {
      setStatusOverlayVisible((visible) => !visible);
    });
  }, [isDigitalTwin, phase]);

  function handleAutoPatrolAction(
    action: AutoPatrolControlAction,
    routeId: string | null,
    payload?: AutoPatrolControlPayload,
  ): void {
    pauseHistoryReplay();
    const controller = autoPatrolPlaybackRef.current;
    if (!controller) return;
    let result: { ok: true } | { ok: false; error: string } | null = null;
    if (action === 'resume' || action === 'set-view') {
      manualRoamRef.current?.setEnabled(false);
    }
    switch (action) {
      case 'start': {
        const startGate = autoPatrolStartGateRef.current;
        if (!routeId) {
          result = { ok: false, error: '未选择巡检路线。' };
          break;
        }
        if (!startGate) {
          result = { ok: false, error: '场景加载状态尚未就绪。' };
          break;
        }
        startGate.request(() => {
          manualRoamRef.current?.setEnabled(false);
          const startResult = controller.start(routeId);
          if (!startResult.ok) setRuntimeMessage(startResult.error);
        });
        result = { ok: true };
        break;
      }
      case 'pause':
        autoPatrolStartGateRef.current?.cancelPending();
        result = controller.pause(false);
        break;
      case 'resume':
        result = controller.resume();
        break;
      case 'skip':
        result = controller.skipCurrentWaypoint();
        break;
      case 'stop':
        autoPatrolStartGateRef.current?.cancelPending();
        controller.stop();
        break;
      case 'emergency-stop':
        autoPatrolStartGateRef.current?.cancelPending();
        controller.emergencyStop();
        break;
      case 'return':
        autoPatrolStartGateRef.current?.cancelPending();
        result = controller.returnToStart();
        break;
      case 'set-rate':
        result = controller.setPlaybackRate(typeof payload === 'number' ? payload : Number.NaN);
        break;
      case 'set-view':
        result = payload === 'first-person' || payload === 'third-person' || payload === 'orbit'
          ? controller.setManualViewMode(payload)
          : { ok: false, error: '巡检视角参数无效。' };
        break;
      case 'resume-auto-view':
        result = controller.resumeAutomaticView();
        break;
      case 'trigger-event':
        result = typeof payload === 'string'
          ? controller.triggerManualEvent(payload)
          : { ok: false, error: '手动巡检事件参数无效。' };
        break;
    }
    if (result && !result.ok) setRuntimeMessage(result.error);
  }

  /** 启用或关闭 Viewer 手动漫游；场景没有出生点 POI 时拒绝启用。 */
  function handleManualRoamEnabled(enabled: boolean): void {
    if (enabled && !hasManualRoamSpawn) return;
    if (enabled) {
      autoPatrolStartGateRef.current?.cancelPending();
      pauseHistoryReplay();
    }
    manualRoamRef.current?.setEnabled(enabled);
  }

  function handleManualRoamViewMode(viewMode: ManualRoamViewMode): void {
    manualRoamRef.current?.setViewMode(viewMode);
  }

  function handleManualRoamLocomotionMode(mode: ManualRoamLocomotionMode): void {
    manualRoamRef.current?.setLocomotionMode(mode);
  }

  function handleManualRoamConfig(patch: Partial<ManualRoamConfig>): void {
    manualRoamRef.current?.updateConfig(patch);
  }

  function handleManualRoamTouchAction(action: ManualRoamTouchAction, pressed: boolean): void {
    manualRoamRef.current?.setTouchAction(action, pressed);
  }

  const backgroundColor = config?.page.backgroundColor ?? '#141414';
  const manualRoamControlsVisible = shouldShowPlayerFloatingControl(
    isDigitalTwin,
    openedDigitalTwinFloatingControl,
    'manual-roam',
  );
  const autoPatrolControlsVisible = shouldShowPlayerFloatingControl(
    isDigitalTwin,
    openedDigitalTwinFloatingControl,
    'auto-patrol',
  );
  const showOverlay = shouldShowPlayerStatusOverlay(
    phase,
    statusOverlayVisible,
    viewportRuntimeIssue || environmentRuntimeIssue || Boolean(mqttStatus.lastError),
  );

  useEffect(() => {
    if (phase !== 'ready' || !showOverlay) {
      setPlayerFps(null);
      return undefined;
    }

    const sampleFps = (): void => {
      setPlayerFps(viewportRef.current?.engine.getFps() ?? null);
    };
    sampleFps();
    const timer = window.setInterval(sampleFps, PLAYER_STATUS_FPS_SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [phase, showOverlay]);

  // 首次场景加载：启动阶段里程碑 + 模型/环境资源单元进度共同驱动全屏蒙版。
  const loadingMask = computePlayerLoadingProgress({
    phase,
    startupPercent,
    modelLoadProgress,
    initialLoadCompleted: initialLoadCompletedRef.current,
    message,
  });

  useEffect(() => {
    /** 独立 Viewer 切换场景全屏；内嵌 Viewer 交由宿主把完整大屏作为一个整体全屏。 */
    function handleWindowKeyDown(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== 'f11') return;
      event.preventDefault();
      void sceneFullscreen.toggle();
    }

    window.addEventListener('keydown', handleWindowKeyDown, true);
    return () => window.removeEventListener('keydown', handleWindowKeyDown, true);
  }, [sceneFullscreen]);

  const fullscreenLabel = sceneFullscreen.isFullscreen
    ? '退出全屏'
    : sceneFullscreen.isEmbedded
      ? '全屏显示大屏'
      : '全屏显示场景';

  return (
    <main className="player-root" ref={playerRootRef} style={{ backgroundColor }}>
      <canvas aria-label="Babylon 3D 场景" className="player-canvas" ref={canvasRef} />
      {phase === 'ready' && viewportRef.current && runtimeRef.current ? (
        <DataPlatformScreenOverlay
          canvas={canvasRef.current}
          runtime={runtimeRef.current}
          onCommand={handleDataPlatformScreenCommand}
          selectedEntityIds={viewerSelectedEntityIds}
          scene={viewportRef.current.scene}
        />
      ) : null}
      {phase === 'ready' ? (
        <DataPlatformViewportScreenOverlay
          interactive
          onCommand={handleViewportDataPlatformScreenCommand}
          screen={viewportScreen}
          selectedEntityIds={viewerSelectedEntityIds}
        />
      ) : null}
      {phase !== 'blocked' ? (
        <button
          aria-label={fullscreenLabel}
          aria-pressed={sceneFullscreen.isFullscreen}
          className="player-fullscreen-button"
          onClick={() => void sceneFullscreen.toggle()}
          title={`${fullscreenLabel} (F11)`}
          type="button"
        >
          <FullscreenGlyph exit={sceneFullscreen.isFullscreen} />
        </button>
      ) : null}
      {phase === 'ready' && manualRoamControlsVisible && config?.viewer.allowCameraControl && hasManualRoamSpawn ? (
        <ManualRoamControls
          snapshot={manualRoamSnapshot}
          onConfigChange={handleManualRoamConfig}
          onDebugCollidersChange={(visible) => manualRoamRef.current?.setDebugColliders(visible)}
          onEnabledChange={handleManualRoamEnabled}
          onLocomotionModeChange={handleManualRoamLocomotionMode}
          onPointerLock={() => manualRoamRef.current?.requestPointerLock()}
          onReset={() => manualRoamRef.current?.reset()}
          onTouchAction={handleManualRoamTouchAction}
          onViewModeChange={handleManualRoamViewMode}
          onVirtualMove={(right, forward) => manualRoamRef.current?.setVirtualMovement(right, forward)}
        />
      ) : null}
      {phase === 'ready'
      && autoPatrolControlsVisible
      && (autoPatrolRoutes.length > 0 || Boolean(autoPatrolHistory?.records.length))
      && !manualRoamSnapshot.enabled ? (
        <AutoPatrolControls
          routes={autoPatrolRoutes}
          snapshot={autoPatrolSnapshot}
          onAction={handleAutoPatrolAction}
          history={autoPatrolHistory}
          onHistoryAction={handleHistoryAction}
        />
      ) : null}
      {loadingMask.visible ? (
        <SceneLoadingMask
          detail={loadingMask.detail}
          label={loadingMask.label}
          percent={loadingMask.percent}
        />
      ) : null}
      {chartMarkerError ? (
        <section className="player-status" role="alert" style={{ pointerEvents: 'auto' }}>
          <strong>点击事件未完成</strong>
          <p>{chartMarkerError}</p>
          <button type="button" onClick={() => setChartMarkerError('')}>关闭提示</button>
        </section>
      ) : showOverlay ? (
        <section className={`player-status player-status-${phase}`} role={phase === 'blocked' ? 'alert' : 'status'}>
          <strong>{phase === 'loading' ? message : phase === 'blocked' ? '场景已阻断' : '场景运行中'}</strong>
          {phase === 'blocked' ? <p>{message}</p> : null}
          {phase === 'ready' ? <p aria-hidden="true">FPS：{formatPlayerStatusFps(playerFps)}</p> : null}
          {phase !== 'blocked' ? <p>MQTT：{mqttStatus.state}{mqttStatus.lastError ? `（${mqttStatus.lastError}）` : ''}</p> : null}
          {runtimeMessage ? <p>{runtimeMessage}</p> : null}
        </section>
      ) : null}
    </main>
  );
}
