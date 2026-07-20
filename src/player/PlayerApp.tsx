import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { deserializeScene } from '../editor/project/SceneSerializer';
import { clearDeploymentAssetManifest, installDeploymentAssetManifest } from '../runtime/assets/editorAssetUrl';
import { createBabylonViewport, type BabylonViewport, type BabylonViewportRuntimeStatus } from '../runtime/babylon/createEngine';
import { SceneRuntime } from '../runtime/babylon/SceneRuntime';
import { mqttRuntimeStatusStore } from '../runtime/mqtt/mqttRuntimeStatus';
import { MqttStackerTelemetryClient } from '../runtime/mqtt/MqttStackerTelemetryClient';
import { parseDeploymentAssetManifest, parsePlayerRuntimeConfig, type PlayerRuntimeConfig } from './runtimeConfig';
import './player.css';

type PlayerPhase = 'loading' | 'ready' | 'blocked';

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
  const [phase, setPhase] = useState<PlayerPhase>('loading');
  const [message, setMessage] = useState('场景加载中...');
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [config, setConfig] = useState<PlayerRuntimeConfig | null>(null);
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
    let mqttClient: MqttStackerTelemetryClient | null = null;
    let resize: (() => void) | null = null;

    /** 处理 WebGL 丢失和渲染异常，恢复事件只清除对应运行时阻断。 */
    const handleRuntimeStatus = (status: BabylonViewportRuntimeStatus): void => {
      if (disposed) return;
      setRuntimeMessage(status.type === 'context-restored' || status.type === 'render-recovered' ? null : status.message);
    };

    /** 按部署契约顺序启动 Viewer，manifest 必须先于场景反序列化安装。 */
    const start = async (): Promise<void> => {
      try {
        const runtimeConfigUrl = new URL('./runtime-config.json', document.baseURI);
        const parsedConfig = parsePlayerRuntimeConfig(await fetchJson(runtimeConfigUrl, abortController.signal));
        if (disposed) return;
        document.title = parsedConfig.page.title;
        setConfig(parsedConfig);
        setMessage(parsedConfig.page.loadingText);

        const assetBaseUrl = new URL(parsedConfig.paths.assetBase, document.baseURI);
        const manifestUrl = new URL(parsedConfig.paths.assetManifest, document.baseURI);
        const manifestMappings = parseDeploymentAssetManifest(await fetchJson(manifestUrl, abortController.signal), assetBaseUrl);
        if (disposed) return;
        installDeploymentAssetManifest(manifestMappings);

        const sceneUrl = new URL(parsedConfig.paths.scene, document.baseURI);
        const sceneDocument = deserializeScene(await fetchText(sceneUrl, abortController.signal));
        if (disposed) return;

        viewport = createBabylonViewport(canvas, handleRuntimeStatus, {
          showGrid: parsedConfig.viewer.showGrid,
          allowCameraControl: parsedConfig.viewer.allowCameraControl,
        });
        applySceneBackground(viewport, parsedConfig.page.backgroundColor);
        viewport.setViewDistance(sceneDocument.sceneSettings.camera.viewDistance);
        viewport.setSensitivity(sceneDocument.sceneSettings.sensitivity);
        viewport.applyCameraPose(sceneDocument.sceneSettings.camera.savedPose);

        runtime = new SceneRuntime(viewport.scene, (logMessage) => {
          console.info(`[Viewer] ${logMessage}`);
          if (!disposed) setRuntimeMessage(logMessage);
        });
        runtime.sync(sceneDocument);
        runtime.syncEnvironment(sceneDocument.sceneSettings.environment);
        runtime.beginTelemetryPreview();

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
        mqttClient?.dispose();
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
      mqttClient?.dispose();
      runtime?.dispose();
      viewport?.dispose();
      clearDeploymentAssetManifest();
    };
  }, []);

  const backgroundColor = config?.page.backgroundColor ?? '#141414';
  const showOverlay = phase !== 'ready' || Boolean(runtimeMessage) || Boolean(mqttStatus.lastError) || config?.viewer.showStatusOverlay;

  return (
    <main className="player-root" style={{ backgroundColor }}>
      <canvas aria-label="Babylon 3D 场景" className="player-canvas" ref={canvasRef} />
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
