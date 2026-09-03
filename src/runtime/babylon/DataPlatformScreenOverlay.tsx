import { getChartMarkerCorners } from './ChartMarkerPresentation';
import { createChartMarkerContent } from './chartMarkerContent';
import { canEmbedChartMarkerScreen, CHART_MARKER_REFRESH_EVENT } from '../../shared/chartMarkerEmbed';
import { useEffect, useRef } from 'react';
import { Matrix, Scene, Vector3, type Mesh } from '@babylonjs/core';
import type { SceneRuntime, DataPlatformScreenOverlayItem } from './SceneRuntime';
import { ChartMarkerDepthSurface, type ScreenPolygon } from './ChartMarkerDepthSurface';
import { getVisibleChartMarkerPolygons, intersectScreenPolygons, type ProjectedScreenPoint } from './chartMarkerVisibility';
import {
  createDataPlatformScreenSelectionMessage,
  parseDataPlatformScreenCommand,
  type DataPlatformScreenCommand,
} from './dataPlatformScreenBridge';

const OVERLAY_BASE_SIZE_PX = 1000;
const IFRAME_FALLBACK_TIMEOUT_MS = 8000;
const SCREEN_LOCAL_CORNERS = [
  new Vector3(-1, 0, -1),
  new Vector3(1, 0, -1),
  new Vector3(1, 0, 1),
  new Vector3(-1, 0, 1),
] as const;

export type CssProjectivePoint = { x: number; y: number };

/** 用 4 个投影顶点计算 CSS 2D 单应矩阵，使 iframe 在透视相机下仍贴合平面。 */
export function createCssProjectiveMatrix(
  sourceWidth: number,
  sourceHeight: number,
  destination: readonly [CssProjectivePoint, CssProjectivePoint, CssProjectivePoint, CssProjectivePoint],
): string | null {
  const source: readonly CssProjectivePoint[] = [
    { x: 0, y: 0 },
    { x: sourceWidth, y: 0 },
    { x: sourceWidth, y: sourceHeight },
    { x: 0, y: sourceHeight },
  ];
  const equations: number[][] = [];
  const values: number[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const input = source[index];
    const output = destination[index];
    if (!input || !output) return null;
    equations.push([
      input.x,
      input.y,
      1,
      0,
      0,
      0,
      -output.x * input.x,
      -output.x * input.y,
    ]);
    values.push(output.x);
    equations.push([
      0,
      0,
      0,
      input.x,
      input.y,
      1,
      -output.y * input.x,
      -output.y * input.y,
    ]);
    values.push(output.y);
  }

  const solution = solveLinearSystem(equations, values);
  if (!solution || solution.some((value) => !Number.isFinite(value))) return null;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = solution;
  return `matrix3d(${[
    h0, h3, 0, h6,
    h1, h4, 0, h7,
    0, 0, 1, 0,
    h2, h5, 0, 1,
  ].map((value) => Number(value.toFixed(8))).join(',')})`;
}

function solveLinearSystem(input: number[][], rightHandSide: number[]): number[] | null {
  const matrix = input.map((row, index) => [...row, rightHandSide[index] ?? 0]);
  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(matrix[row]?.[column] ?? 0) > Math.abs(matrix[pivot]?.[column] ?? 0)) pivot = row;
    }
    const pivotValue = matrix[pivot]?.[column] ?? 0;
    if (Math.abs(pivotValue) < 1e-9) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const normalizedPivot = matrix[column]?.[column] ?? 1;
    for (let entry = column; entry <= 8; entry += 1) {
      if (matrix[column]) matrix[column][entry] /= normalizedPivot;
    }
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = matrix[row]?.[column] ?? 0;
      if (Math.abs(factor) < 1e-12) continue;
      for (let entry = column; entry <= 8; entry += 1) {
        if (matrix[row] && matrix[column]) matrix[row][entry] -= factor * matrix[column][entry];
      }
    }
  }
  return matrix.map((row) => row[8] ?? Number.NaN);
}

function projectScreenCorners(
  scene: Scene,
  canvas: HTMLCanvasElement,
  root: HTMLElement,
  mesh: Mesh,
  readableBothSides = false,
  insetX = 0,
  insetY = 0,
): [ProjectedScreenPoint, ProjectedScreenPoint, ProjectedScreenPoint, ProjectedScreenPoint] | null {
  const camera = scene.activeCamera;
  const engine = scene.getEngine();
  if (!camera) return null;
  const renderWidth = engine.getRenderWidth();
  const renderHeight = engine.getRenderHeight();
  if (renderWidth <= 0 || renderHeight <= 0) return null;

  mesh.computeWorldMatrix(true);
  const worldMatrix = mesh.getWorldMatrix();
  const viewport = camera.viewport.toGlobal(renderWidth, renderHeight);
  const transform = scene.getTransformMatrix();
  const canvasRect = canvas.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  const localCorners = readableBothSides ? getChartMarkerCorners(mesh) : SCREEN_LOCAL_CORNERS;
  const points = SCREEN_LOCAL_CORNERS.map((corner) => {
    const u = corner.x < 0 ? insetX : 1 - insetX;
    const v = corner.z < 0 ? insetY : 1 - insetY;
    const localPoint = Vector3.Lerp(Vector3.Lerp(localCorners[0], localCorners[1], u), Vector3.Lerp(localCorners[3], localCorners[2], u), v);
    const worldPoint = Vector3.TransformCoordinates(localPoint, worldMatrix);
    const projected = Vector3.Project(worldPoint, Matrix.Identity(), transform, viewport);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || projected.z < 0 || projected.z > 1) return null;
    return {
      x: canvasRect.left - rootRect.left + projected.x / renderWidth * canvasRect.width,
      y: canvasRect.top - rootRect.top + projected.y / renderHeight * canvasRect.height,
      depth: projected.z,
    };
  });
  if (points.some((point) => point === null)) return null;
  const corners = points as [ProjectedScreenPoint, ProjectedScreenPoint, ProjectedScreenPoint, ProjectedScreenPoint];
  // 从背面观察时交换左右角，保持标牌文字可读；不改动实体或 Gizmo 的旋转。
  const winding = (corners[1].x - corners[0].x) * (corners[3].y - corners[0].y)
    - (corners[1].y - corners[0].y) * (corners[3].x - corners[0].x);
  return readableBothSides && winding < 0
    ? [corners[1], corners[0], corners[3], corners[2]]
    : corners;
}

type OverlayEntry = {
  host: HTMLDivElement;
  clipHost: HTMLDivElement;
  iframe: HTMLIFrameElement | null;
  item: DataPlatformScreenOverlayItem;
  screenOrigin: string;
  screenUrl?: string;
  thumbnailUrl?: string;
  lastSelectionSignature: string | null;
  width: number;
  height: number;
  builtin?: ReturnType<typeof createChartMarkerContent>;
  dispose: () => void;
};

function createOverlayEntry(root: HTMLElement, item: DataPlatformScreenOverlayItem): OverlayEntry {
  const builtinMode = item.markerStyle?.contentType === 'builtin';
  const factor = builtinMode ? 1 : 6;
  const width = item.markerStyle ? item.markerStyle.width * factor : item.chartMarker ? 1920 : OVERLAY_BASE_SIZE_PX;
  const height = item.markerStyle ? item.markerStyle.height * factor : item.chartMarker ? 1080 : OVERLAY_BASE_SIZE_PX;
  const host = document.createElement('div');
  host.dataset.screenEntityId = item.entityId;
  host.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;transform-origin:0 0;overflow:hidden;background:#101827;pointer-events:none`;
  if (item.chartMarker) host.style.boxShadow = 'inset 0 0 0 12px #58b9dc';

  const content = document.createElement('div');
  content.style.cssText = `position:absolute;inset:${item.chartMarker ? 16 : 0}px;overflow:hidden`;
  const fallback = document.createElement('img');
  fallback.alt = '';
  fallback.draggable = false;
  fallback.style.cssText = 'width:100%;height:100%;object-fit:contain;pointer-events:none';
  fallback.style.display = item.thumbnailUrl ? 'block' : 'none';
  if (item.thumbnailUrl) fallback.src = item.thumbnailUrl;

  const status = document.createElement('div');
  status.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:28px;color:#b7e7fa;background:#101827c9;font:32px sans-serif;text-align:center;padding:60px;pointer-events:none';
  const title = document.createElement('strong');
  title.style.cssText = 'font-size:56px;overflow-wrap:anywhere';
  title.textContent = item.name || '图表立标';
  const message = document.createElement('span');
  status.append(title, message);
  content.append(fallback, status);
  host.append(content);
  const clipHost = document.createElement('div');
  clipHost.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  clipHost.append(host);
  root.append(clipHost);

  const builtin = builtinMode ? createChartMarkerContent(host) : undefined;
  if (builtin) content.style.display = 'none';
  let iframe: HTMLIFrameElement | null = null;
  let timeoutId: number | undefined;
  let loaded = false;
  const canEmbed = !item.chartMarker || canEmbedChartMarkerScreen();
  const showFallback = (): void => {
    if (loaded) return;
    if (iframe) iframe.style.visibility = 'hidden';
    status.style.display = 'flex';
    message.textContent = '大屏暂未加载，请检查网络或页面访问权限后刷新内容';
  };
  const onLoad = (): void => {
    loaded = true;
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    entry.lastSelectionSignature = null;
    if (iframe) iframe.style.visibility = 'visible';
    fallback.style.display = 'none';
    status.style.display = 'none';
  };
  if (item.screenUrl && canEmbed) {
    iframe = document.createElement('iframe');
    iframe.title = item.name || item.entityId;
    iframe.src = item.screenUrl;
    iframe.loading = 'eager';
    iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;pointer-events:none;visibility:hidden';
    iframe.addEventListener('load', onLoad);
    iframe.addEventListener('error', showFallback);
    message.textContent = '大屏加载中…';
    content.append(iframe);
    timeoutId = window.setTimeout(showFallback, IFRAME_FALLBACK_TIMEOUT_MS);
  } else if (!canEmbed) {
    message.textContent = '已停止重复嵌套大屏，请检查大屏中的数字孪生组件';
  } else if (item.thumbnailUrl) {
    status.style.display = 'none';
  } else {
    message.textContent = '将图表库大屏拖到此立标，或拖到右侧大屏槽位';
  }

  const entry: OverlayEntry = {
    host,
    builtin,
    clipHost,
    iframe,
    item,
    screenOrigin: item.screenUrl ? new URL(item.screenUrl).origin : '',
    screenUrl: item.screenUrl,
    thumbnailUrl: item.thumbnailUrl,
    lastSelectionSignature: null,
    width,
    height,
    dispose: () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      iframe?.removeEventListener('load', onLoad);
      iframe?.removeEventListener('error', showFallback);
      builtin?.dispose();
      clipHost.remove();
    },
  };
  return entry;
}

function postSelectionToScreen(entry: OverlayEntry, selectedEntityIds: readonly string[]): void {
  if (!entry.iframe?.contentWindow) return;
  const message = createDataPlatformScreenSelectionMessage(selectedEntityIds, selectedEntityIds[0] ?? null);
  const signature = JSON.stringify(message.payload);
  if (entry.lastSelectionSignature === signature) return;
  entry.iframe.contentWindow.postMessage(message, entry.screenOrigin);
  entry.lastSelectionSignature = signature;
}

function disposeOverlayEntry(entry: OverlayEntry): void {
  entry.dispose();
}

export type DataPlatformScreenOverlayProps = {
  scene: Scene;
  runtime: SceneRuntime;
  canvas: HTMLCanvasElement | null;
  interactive?: boolean;
  selectedEntityIds?: readonly string[];
  onCommand?: (item: DataPlatformScreenOverlayItem, command: DataPlatformScreenCommand) => void;
};

/** 图表立标网页置于深度打孔画布下方；旧大屏保持原有覆盖层行为。 */
export function DataPlatformScreenOverlay({
  scene,
  runtime,
  canvas,
  interactive = true,
  selectedEntityIds = [],
  onCommand,
}: DataPlatformScreenOverlayProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const entriesRef = useRef<Map<string, OverlayEntry>>(new Map());
  const selectedEntityIdsRef = useRef<readonly string[]>(selectedEntityIds);
  const onCommandRef = useRef(onCommand);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  selectedEntityIdsRef.current = selectedEntityIds;
  onCommandRef.current = onCommand;

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !canvas) return undefined;
    const entries = entriesRef.current;
    let depthSurface: ChartMarkerDepthSurface | undefined;
    let visibleMarkerMeshes: Mesh[] = [];
    let markerPolygons: ScreenPolygon[] = [];

    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (!interactiveRef.current) return;
      for (const entry of entries.values()) {
        if (event.source !== entry.iframe?.contentWindow || event.origin !== entry.screenOrigin) continue;
        const command = parseDataPlatformScreenCommand(event.data);
        if (command) onCommandRef.current?.(entry.item, command);
        return;
      }
    };
    window.addEventListener('message', handleMessage);
    const handleRefresh = (event: Event): void => {
      const entityId: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof entityId !== 'string') return;
      const entry = entries.get(entityId);
      if (!entry?.item.chartMarker) return;
      disposeOverlayEntry(entry);
      entries.delete(entityId);
    };
    window.addEventListener(CHART_MARKER_REFRESH_EVENT, handleRefresh);

    const update = (): void => {
      const items = runtime.getDataPlatformScreenOverlayItems();
      const itemIds = new Set(items.map((item) => item.entityId));
      for (const [entityId, entry] of entries.entries()) {
        if (!itemIds.has(entityId)) {
          disposeOverlayEntry(entry);
          entries.delete(entityId);
        }
      }

      if (items.some(item => item.chartMarker) && !depthSurface) depthSurface = new ChartMarkerDepthSurface(scene, canvas);
      visibleMarkerMeshes = [];
      markerPolygons = [];
      const projectedMarkers: { id: string; corners: ProjectedScreenPoint[] }[] = [];
      const contentPolygons = new Map<string, ScreenPolygon>();
      for (const item of items) {
        let entry = entries.get(item.entityId);
        if (entry && (
          entry.screenUrl !== item.screenUrl
          || entry.item.chartMarker !== item.chartMarker
          || entry.item.markerStyle?.contentType !== item.markerStyle?.contentType
          || entry.thumbnailUrl !== item.thumbnailUrl
          || entry.item.projectId !== item.projectId
          || entry.item.screenId !== item.screenId
        )) {
          disposeOverlayEntry(entry);
          entries.delete(item.entityId);
          entry = undefined;
        }
        if (!entry) {
          entry = createOverlayEntry(item.chartMarker && depthSurface ? depthSurface.root : root, item);
          entries.set(item.entityId, entry);
        } else {
          entry.item = item;
        }
        if (item.markerStyle) {
          const style = item.markerStyle;
          const factor = style.contentType === 'builtin' ? 1 : 6;
          entry.width = style.width * factor;
          entry.height = style.height * factor;
          entry.host.style.width = entry.width + 'px';
          entry.host.style.height = entry.height + 'px';
          entry.host.style.backgroundColor = style.contentType === 'builtin' ? '#061b2b' : style.backgroundColor;
          entry.host.style.boxShadow = style.contentType === 'builtin' ? 'none' : ('inset 0 0 0 12px ' + style.appearanceColor);
          entry.builtin?.update(style, item.markerText ?? style.text);
        }
        if (entry.iframe) {
          entry.iframe.style.pointerEvents = interactiveRef.current ? 'auto' : 'none';
          entry.iframe.title = item.name || item.entityId;
        }
        postSelectionToScreen(entry, selectedEntityIdsRef.current);
        const corners = projectScreenCorners(scene, canvas, root, item.mesh, item.chartMarker);
        if (!corners) {
          entry.host.style.display = 'none';
          continue;
        }
        const transform = createCssProjectiveMatrix(entry.width, entry.height, corners);
        entry.host.style.display = transform ? 'block' : 'none';
        if (transform) {
          entry.host.style.transform = transform;
          if (item.chartMarker) {
            visibleMarkerMeshes.push(item.mesh);
            projectedMarkers.push({ id: item.entityId, corners });
            // 空牌、错误提示和边框仍由 canvas 接收相机操作；只放行已加载网页的内容区。
            if (interactiveRef.current && entry.iframe?.style.visibility === 'visible') {
              const contentCorners = projectScreenCorners(scene, canvas, root, item.mesh, true, 16 / entry.width, 16 / entry.height);
              if (contentCorners) contentPolygons.set(item.entityId, contentCorners);
            }
          }
        }
      }
      // 多块倾斜或相交立标不能仅按中心排序；各网页只占据自己深度最近的区域。
      const visiblePolygons = getVisibleChartMarkerPolygons(projectedMarkers);
      for (const [id, polygons] of visiblePolygons) {
        const entry = entries.get(id)!;
        const path = polygons.map(polygon => polygon.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join('') + 'Z').join('');
        entry.clipHost.style.clipPath = path ? `path("${path}")` : 'inset(100%)';
        const content = contentPolygons.get(id);
        if (content) {
          const rootRect = root.getBoundingClientRect(), canvasRect = canvas.getBoundingClientRect();
          for (const polygon of polygons) {
            const visibleContent = intersectScreenPolygons(polygon, content);
            if (visibleContent.length) markerPolygons.push(visibleContent.map(p => ({
              x: p.x + rootRect.left - canvasRect.left, y: p.y + rootRect.top - canvasRect.top,
            })));
          }
        }
      }
    };

    const beforeObserver = scene.onBeforeCameraRenderObservable.add(() => {
      update();
      depthSurface?.beginFrame(visibleMarkerMeshes);
    });
    const observer = scene.onAfterRenderObservable.add(() => {
      depthSurface?.endFrame();
      depthSurface?.updateInteraction(markerPolygons, interactiveRef.current);
    });
    update();
    return () => {
      scene.onBeforeCameraRenderObservable.remove(beforeObserver);
      scene.onAfterRenderObservable.remove(observer);
      depthSurface?.dispose();
      window.removeEventListener('message', handleMessage);
      window.removeEventListener(CHART_MARKER_REFRESH_EVENT, handleRefresh);
      for (const entry of entries.values()) disposeOverlayEntry(entry);
      entries.clear();
    };
  }, [canvas, runtime, scene]);

  return <div aria-hidden={!interactive} ref={rootRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 3 }} />;
}
