import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DataPlatformViewportScreenComponent } from '../../editor/model/dataPlatformScreen';
import {
  createDataPlatformScreenSelectionMessage,
  createDataPlatformScreenEmbedUrl,
  isDataPlatformScreenEmbedReady,
  parseDataPlatformScreenCommand,
  type DataPlatformScreenCommand,
} from './dataPlatformScreenBridge';

const IFRAME_FALLBACK_TIMEOUT_MS = 8000;

type MaskStyle = CSSProperties & {
  WebkitMaskImage?: string;
  WebkitMaskSize?: string;
  WebkitMaskPosition?: string;
  WebkitMaskRepeat?: string;
  WebkitMaskComposite?: string;
  maskImage?: string;
  maskSize?: string;
  maskPosition?: string;
  maskRepeat?: string;
  maskComposite?: string;
};

/** 使用两层 CSS mask 从完整 HUD 中挖出中间 3D 场景窗口。 */
export function createViewportScreenMask(
  sceneWindow: DataPlatformViewportScreenComponent['sceneWindow'],
): MaskStyle {
  const x = `${sceneWindow.x * 100}%`;
  const y = `${sceneWindow.y * 100}%`;
  const width = `${sceneWindow.width * 100}%`;
  const height = `${sceneWindow.height * 100}%`;
  return {
    WebkitMaskImage: 'linear-gradient(#000 0 0), linear-gradient(#000 0 0)',
    WebkitMaskSize: `100% 100%, ${width} ${height}`,
    WebkitMaskPosition: `0 0, ${x} ${y}`,
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskComposite: 'xor',
    maskImage: 'linear-gradient(#000 0 0), linear-gradient(#000 0 0)',
    maskSize: `100% 100%, ${width} ${height}`,
    maskPosition: `0 0, ${x} ${y}`,
    maskRepeat: 'no-repeat',
    maskComposite: 'exclude',
  };
}

/** 生成带 even-odd 中空区域的 SVG clipPath；clipPath 同时参与鼠标命中测试。 */
export function createViewportScreenClipPath(
  sceneWindow: DataPlatformViewportScreenComponent['sceneWindow'],
): string {
  const right = sceneWindow.x + sceneWindow.width;
  const bottom = sceneWindow.y + sceneWindow.height;
  return `M0 0H1V1H0Z M${sceneWindow.x} ${sceneWindow.y}H${right}V${bottom}H${sceneWindow.x}Z`;
}

export type DataPlatformViewportScreenOverlayProps = {
  screen: DataPlatformViewportScreenComponent | null;
  interactive?: boolean;
  selectedEntityIds?: readonly string[];
  onCommand?: (command: DataPlatformScreenCommand) => void;
};

/**
 * 将数据中台完整大屏作为相机视窗 HUD；支持嵌入协议时由页面自行挖空背景层，让 Babylon 3D 场景透出。
 * 普通外部页面保留 clipPath/mask 兼容路径，但该路径可能触发浏览器合成栅格化。
 */
export function DataPlatformViewportScreenOverlay({
  screen,
  interactive = true,
  selectedEntityIds = [],
  onCommand,
}: DataPlatformViewportScreenOverlayProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const iframeTimeoutRef = useRef<number | undefined>(undefined);
  const clipPathId = useId().replace(/:/g, '');
  const selectedEntityIdsSignature = JSON.stringify(selectedEntityIds);
  const screenKey = screen
    ? `${screen.projectId}:${screen.screenId}:${screen.screenUrl ?? ''}:${screen.thumbnailUrl ?? ''}:${screen.renderMode}`
    : 'empty';
  const screenOrigin = useMemo(() => {
    if (!screen?.screenUrl) return null;
    try {
      return new URL(screen.screenUrl, window.location.href).origin;
    } catch {
      return null;
    }
  }, [screen?.screenUrl]);
  const [iframeReady, setIframeReady] = useState(false);
  const [iframeFailed, setIframeFailed] = useState(false);
  const [nativeEmbedReady, setNativeEmbedReady] = useState(false);
  const iframeSrc = screen?.screenUrl
    ? createDataPlatformScreenEmbedUrl(screen.screenUrl, screen.sceneWindow)
    : undefined;

  useEffect(() => {
    setIframeReady(false);
    setIframeFailed(false);
    setNativeEmbedReady(false);
    if (!screen || screen.renderMode !== 'iframe' || !iframeSrc) return undefined;
    const timeoutId = window.setTimeout(() => setIframeFailed(true), IFRAME_FALLBACK_TIMEOUT_MS);
    iframeTimeoutRef.current = timeoutId;
    return () => {
      window.clearTimeout(timeoutId);
      if (iframeTimeoutRef.current === timeoutId) iframeTimeoutRef.current = undefined;
    };
  }, [iframeSrc, screenKey, screen?.renderMode]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (!screenOrigin || event.origin !== screenOrigin || event.source !== iframeRef.current?.contentWindow) return;
      if (isDataPlatformScreenEmbedReady(event.data)) {
        setNativeEmbedReady(true);
        return;
      }
      const command = parseDataPlatformScreenCommand(event.data);
      if (command) onCommand?.(command);
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onCommand, screenOrigin]);

  useEffect(() => {
    if (!screenOrigin || !iframeReady || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      createDataPlatformScreenSelectionMessage(selectedEntityIds, selectedEntityIds[0] ?? null),
      screenOrigin,
    );
  }, [iframeReady, screenOrigin, selectedEntityIdsSignature]);

  if (!screen) return null;

  const showIframe = screen.renderMode === 'iframe' && Boolean(screen.screenUrl) && !iframeFailed;
  const showFallback = !showIframe || !iframeReady;
  const useNativeEmbed = showIframe && iframeReady && nativeEmbedReady;
  const maskStyle = createViewportScreenMask(screen.sceneWindow);

  return (
    <div
      aria-hidden={!interactive}
      data-data-platform-viewport-screen="true"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 4,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <svg aria-hidden="true" height="0" style={{ position: 'absolute', width: 0 }} width="0">
        <defs>
          <clipPath clipPathUnits="objectBoundingBox" id={clipPathId}>
            <path
              clipRule="evenodd"
              d={createViewportScreenClipPath(screen.sceneWindow)}
              fillRule="evenodd"
            />
          </clipPath>
        </defs>
      </svg>
      <div
        style={{
          ...(useNativeEmbed
            ? {}
            : {
                ...maskStyle,
                clipPath: `url(#${clipPathId})`,
              }),
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          pointerEvents: interactive ? 'auto' : 'none',
        }}
      >
        {showFallback && screen.thumbnailUrl ? (
          <img
            alt=""
            draggable={false}
            src={screen.thumbnailUrl}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'fill',
              pointerEvents: 'none',
            }}
          />
        ) : null}
        {showIframe && iframeSrc ? (
          <iframe
            key={screenKey}
            ref={iframeRef}
            title={`数据中台大屏 ${screen.screenId}`}
            src={iframeSrc}
            onError={() => {
              window.clearTimeout(iframeTimeoutRef.current);
              iframeTimeoutRef.current = undefined;
              setIframeFailed(true);
            }}
            onLoad={() => {
              window.clearTimeout(iframeTimeoutRef.current);
              iframeTimeoutRef.current = undefined;
              setIframeReady(true);
              setIframeFailed(false);
            }}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              border: 0,
              background: 'transparent',
              pointerEvents: interactive ? 'auto' : 'none',
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
