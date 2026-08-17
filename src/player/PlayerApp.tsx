import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { deserializeScene } from '../editor/project/SceneSerializer';
import { clearDeploymentAssetManifest, installDeploymentAssetManifest } from '../runtime/assets/editorAssetUrl';
import { createBabylonViewport, type BabylonViewport, type BabylonViewportRuntimeStatus } from '../runtime/babylon/createEngine';
import { applySavedSceneCameraView } from '../runtime/babylon/sceneCameraView';
import { DIGITAL_TWIN_CAMERA_CONTROL_STANDARD } from '../runtime/babylon/cameraControlStandard';
import { SceneRuntime, type SceneRuntimeModelLoadProgress } from '../runtime/babylon/SceneRuntime';
import { buildDigitalTwinAssetIndex } from '../shared/digitalTwinAssetCodes';
import { bindSceneModelSelectionPointer } from '../shared/sceneModelSelectionPointer';
import {
  AutoPatrolPlaybackController,
  collectAutoPatrolPlaybackRoutes,
  findAutoStartPatrolRoute,
  type AutoPatrolPlaybackRoute,
  type AutoPatrolPlaybackSnapshot,
} from '../runtime/babylon/AutoPatrolPlaybackController';
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
import {
  bindStatusOverlayPointerChordToggle,
  resolveInitialPlayerStatusOverlayVisibility,
  shouldShowPlayerStatusOverlay,
} from './statusOverlayControls';
import { AutoPatrolControls, type AutoPatrolControlAction } from '../shared/ui/AutoPatrolControls';
import { SceneLoadingMask } from '../shared/ui/SceneLoadingMask';
import { computePlayerLoadingProgress, PLAYER_SCENE_LOADING_TIMEOUT_MS } from './playerLoadingProgress';
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const autoPatrolPlaybackRef = useRef<AutoPatrolPlaybackController | null>(null);
  const [phase, setPhase] = useState<PlayerPhase>('loading');
  const [autoPatrolRoutes, setAutoPatrolRoutes] = useState<AutoPatrolPlaybackRoute[]>([]);
  const [autoPatrolSnapshot, setAutoPatrolSnapshot] = useState<AutoPatrolPlaybackSnapshot>(IDLE_AUTO_PATROL_SNAPSHOT);
  const [message, setMessage] = useState('场景加载中...');
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [viewportRuntimeIssue, setViewportRuntimeIssue] = useState(false);
  const [environmentRuntimeIssue, setEnvironmentRuntimeIssue] = useState(false);
  const [statusOverlayVisible, setStatusOverlayVisible] = useState(false);
  const [config, setConfig] = useState<PlayerRuntimeConfig | null>(null);
  const [startupPercent, setStartupPercent] = useState(6);
  const [modelLoadProgress, setModelLoadProgress] = useState<SceneRuntimeModelLoadProgress | null>(null);
  /** 首次场景加载全部结算后置位：后续按需加载（如 MQTT 货物模板）不再重新弹出全屏蒙版。 */
  const initialLoadCompletedRef = useRef(false);
  /** 首次场景加载是否仍在途：驱动超时兜底与蒙版显示。 */
  const modelLoadingInProgress = modelLoadProgress?.loading === true
    && modelLoadProgress.totalCount > 0
    && !initialLoadCompletedRef.current;

  useEffect(() => {
    if (!modelLoadingInProgress) return undefined;
    const timer = window.setTimeout(() => {
      initialLoadCompletedRef.current = true;
      setRuntimeMessage('部分场景资源加载超时，场景可能尚未完整显示。');
    }, PLAYER_SCENE_LOADING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [modelLoadingInProgress]);
  const mqttStatus = useSyncExternalStore(
    mqttRuntimeStatusStore.subscribe,
    mqttRuntimeStatusStore.getSnapshot,
    mqttRuntimeStatusStore.getSnapshot,
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const abortController = new AbortController();
    let disposed = false;
    let viewport: BabylonViewport | null = null;
    let runtime: SceneRuntime | null = null;
    let autoPatrolPlayback: AutoPatrolPlaybackController | null = null;
    let interactionController: DigitalTwinInteractionController | null = null;
    let unsubscribeAutoPatrolSnapshot: (() => void) | null = null;
    let removeAutoPatrolManualInputListeners: (() => void) | null = null;
    let removeModelSelectionListeners: (() => void) | null = null;
    let mqttClient: MqttStackerTelemetryClient | null = null;
    let resize: (() => void) | null = null;

    /** 处理 WebGL 丢失和渲染异常，恢复事件只清除对应运行时阻断。 */
    const handleRuntimeStatus = (status: BabylonViewportRuntimeStatus): void => {
      if (disposed) return;
      const recovered = status.type === 'context-restored' || status.type === 'render-recovered';
      setViewportRuntimeIssue(!recovered);
      setRuntimeMessage(recovered ? null : status.message);
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
        const digitalTwinAssetIndex = buildDigitalTwinAssetIndex(sceneDocument);
        if (projectRuntimeConfig) {
          sceneDocument.fetchConfig = { url: projectRuntimeConfig.apiBaseUrl ?? '', apiKey: '' };
          (globalThis as typeof globalThis & { __ZENDING_DIGITAL_TWIN_CONFIG__?: Record<string, unknown> })
            .__ZENDING_DIGITAL_TWIN_CONFIG__ = projectRuntimeConfig.config;
        }
        if (disposed) return;
        setStartupPercent(30);

        viewport = createBabylonViewport(canvas, handleRuntimeStatus, {
          showGrid: parsedConfig.viewer.showGrid,
          allowCameraControl: parsedConfig.viewer.allowCameraControl,
          requireHardwareAcceleration: true,
        });
        applySceneBackground(viewport, parsedConfig.page.backgroundColor);
        viewport.setViewDistance(sceneDocument.sceneSettings.camera.viewDistance);
        viewport.setSensitivity(sceneDocument.sceneSettings.sensitivity);
        applySavedSceneCameraView(viewport, sceneDocument.sceneSettings.camera, {
          animate: false,
          lockStandardOrientation: false,
        });

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
            setModelLoadProgress(progress);
            if (!progress.loading && progress.totalCount > 0) {
              initialLoadCompletedRef.current = true;
            }
          },
        );
        runtime.disableEditorLightMarkers();
        runtime.disableEditorAutoPatrolMarkers();
        runtime.sync(sceneDocument);
        setStartupPercent(36);
        const environment = sceneDocument.sceneSettings.environment;
        if (environment) {
          await runtime.applyEnvironment(environment, { requestId: null, autoAlign: false });
        } else {
          runtime.syncEnvironment(null);
        }
        if (disposed) return;
        setStartupPercent(50);
        runtime.beginTelemetryPreview();

        const patrolRoutes = collectAutoPatrolPlaybackRoutes(sceneDocument);
        autoPatrolPlayback = new AutoPatrolPlaybackController({
          readPose: () => viewport!.getCameraPose(),
          writePose: (pose) => viewport!.applyCameraPose(pose, { animate: false }),
          now: () => typeof performance === 'undefined' ? Date.now() : performance.now(),
          subscribeFrame: (callback) => {
            const observer = viewport!.scene.onBeforeRenderObservable.add(callback);
            return () => viewport?.scene.onBeforeRenderObservable.remove(observer);
          },
        });
        autoPatrolPlayback.setRoutes(patrolRoutes);
        unsubscribeAutoPatrolSnapshot = autoPatrolPlayback.subscribe(() => {
          if (!disposed && autoPatrolPlayback) setAutoPatrolSnapshot(autoPatrolPlayback.getSnapshot());
        });
        autoPatrolPlaybackRef.current = autoPatrolPlayback;
        setAutoPatrolRoutes(patrolRoutes);

        const notifyManualInput = (): void => {
          interactionController?.notifyManualCameraInput();
          autoPatrolPlayback?.notifyManualInput();
          autoPatrolPlayback?.notifyCameraChangedWhilePaused();
        };
        removeModelSelectionListeners = bindSceneModelSelectionPointer(canvas, {
          clickTolerancePx: DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.selection.clickTolerancePx,
          onSelectionClick: ({ clientX, clientY }) => {
            if (disposed || !runtime) return;
            const entityId = runtime.pickRuntimeModelEntityIdAtCanvasPoint(clientX, clientY, canvas);
            runtime.setLocalHighlightEntityIds(entityId ? [entityId] : []);
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
          const result = autoPatrolPlayback.start(autoStartRoute.entityId);
          if (!result.ok) setRuntimeMessage(result.error);
        }

        interactionController.markViewerReady({
          assetIndex: digitalTwinAssetIndex,
          getEntityBounds: (entityId) => runtime!.getEntitiesWorldBounds([entityId]),
          focusOnBounds: (bounds, options) => viewport!.focusOnBounds(bounds, options),
          cancelCameraTransition: (reason) => viewport!.cancelCameraTransition(reason),
          setExternalHighlightEntityIds: (entityIds) => runtime!.setExternalHighlightEntityIds(entityIds),
          clearExternalHighlight: () => runtime!.clearExternalHighlight(),
          getPatrolPhase: () => autoPatrolPlayback!.getSnapshot().phase,
          pausePatrol: () => { autoPatrolPlayback!.pause(false); },
          notifyCameraChangedWhilePaused: () => autoPatrolPlayback!.notifyCameraChangedWhilePaused(),
        });

        mqttClient = new MqttStackerTelemetryClient((logMessage) => console.info(`[Viewer MQTT] ${logMessage}`));
        mqttClient.updateConfig(parsedConfig.mqtt);
        resize = () => viewport?.engine.resize();
        window.addEventListener('resize', resize);
        resize();
        setPhase('ready');
      } catch (error) {
        if (disposed || abortController.signal.aborted) return;
        console.error('Web Viewer 启动失败。', error);
        setPhase('blocked');
        setMessage(`Web Viewer 启动失败：${getErrorMessage(error)}`);
        interactionController?.dispose();
        interactionController = null;
        mqttClient?.dispose();
        removeModelSelectionListeners?.();
        removeAutoPatrolManualInputListeners?.();
        unsubscribeAutoPatrolSnapshot?.();
        autoPatrolPlayback?.dispose();
        autoPatrolPlaybackRef.current = null;
        runtime?.dispose();
        viewport?.dispose();
        clearDeploymentAssetManifest();
      }
    };

    void start();
    return () => {
      disposed = true;
      abortController.abort();
      if (resize) window.removeEventListener('resize', resize);
      interactionController?.dispose();
      interactionController = null;
      mqttClient?.dispose();
      removeModelSelectionListeners?.();
      removeAutoPatrolManualInputListeners?.();
      unsubscribeAutoPatrolSnapshot?.();
      autoPatrolPlayback?.dispose();
      autoPatrolPlaybackRef.current = null;
      runtime?.dispose();
      viewport?.dispose();
      clearDeploymentAssetManifest();
    };
  }, []);

  const isDigitalTwin = Boolean(config?.digitalTwin);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || phase !== 'ready' || !isDigitalTwin) return;

    return bindStatusOverlayPointerChordToggle(canvas, window, () => {
      setStatusOverlayVisible((visible) => !visible);
    });
  }, [isDigitalTwin, phase]);

  function handleAutoPatrolAction(action: AutoPatrolControlAction, routeId: string | null): void {
    const controller = autoPatrolPlaybackRef.current;
    if (!controller) return;
    let result: { ok: true } | { ok: false; error: string } | null = null;
    switch (action) {
      case 'start':
        result = routeId ? controller.start(routeId) : { ok: false, error: '未选择巡检路线。' };
        break;
      case 'pause':
        result = controller.pause(false);
        break;
      case 'resume':
        result = controller.resume();
        break;
      case 'stop':
        controller.stop();
        break;
      case 'return':
        result = controller.returnToStart();
        break;
    }
    if (result && !result.ok) setRuntimeMessage(result.error);
  }

  const backgroundColor = config?.page.backgroundColor ?? '#141414';
  const showOverlay = shouldShowPlayerStatusOverlay(
    phase,
    statusOverlayVisible,
    viewportRuntimeIssue || environmentRuntimeIssue || Boolean(mqttStatus.lastError),
  );

  // 首次场景加载：启动阶段里程碑 + 模型/环境资源单元进度共同驱动全屏蒙版。
  const loadingMask = computePlayerLoadingProgress({
    phase,
    startupPercent,
    modelLoadProgress,
    initialLoadCompleted: initialLoadCompletedRef.current,
    message,
  });

  return (
    <main className="player-root" style={{ backgroundColor }}>
      <canvas aria-label="Babylon 3D 场景" className="player-canvas" ref={canvasRef} />
      {phase === 'ready' && autoPatrolRoutes.length > 0 ? (
        <AutoPatrolControls
          routes={autoPatrolRoutes}
          snapshot={autoPatrolSnapshot}
          onAction={handleAutoPatrolAction}
        />
      ) : null}
      {loadingMask.visible ? (
        <SceneLoadingMask
          detail={loadingMask.detail}
          label={loadingMask.label}
          percent={loadingMask.percent}
        />
      ) : null}
      {showOverlay ? (
        <section className={`player-status player-status-${phase}`} role={phase === 'blocked' ? 'alert' : 'status'}>
          <strong>{phase === 'loading' ? message : phase === 'blocked' ? '场景已阻断' : '场景运行中'}</strong>
          {phase === 'blocked' ? <p>{message}</p> : null}
          {phase !== 'blocked' ? <p>MQTT：{mqttStatus.state}{mqttStatus.lastError ? `（${mqttStatus.lastError}）` : ''}</p> : null}
          {runtimeMessage ? <p>{runtimeMessage}</p> : null}
        </section>
      ) : null}
    </main>
  );
}
