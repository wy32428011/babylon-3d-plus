import { useEffect, useRef } from 'react';
import { Matrix, Scene, Vector3, type Mesh } from '@babylonjs/core';
import type { SceneRuntime, DataPlatformScreenOverlayItem } from './SceneRuntime';
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
): [CssProjectivePoint, CssProjectivePoint, CssProjectivePoint, CssProjectivePoint] | null {
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
  const points = SCREEN_LOCAL_CORNERS.map((corner) => {
    const worldPoint = Vector3.TransformCoordinates(corner, worldMatrix);
    const projected = Vector3.Project(worldPoint, Matrix.Identity(), transform, viewport);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || projected.z < 0 || projected.z > 1) return null;
    return {
      x: canvasRect.left - rootRect.left + projected.x / renderWidth * canvasRect.width,
      y: canvasRect.top - rootRect.top + projected.y / renderHeight * canvasRect.height,
    };
  });
  if (points.some((point) => point === null)) return null;
  return points as [CssProjectivePoint, CssProjectivePoint, CssProjectivePoint, CssProjectivePoint];
}

type OverlayEntry = {
  host: HTMLDivElement;
  iframe: HTMLIFrameElement;
  fallback: HTMLImageElement;
  item: DataPlatformScreenOverlayItem;
  screenOrigin: string;
  screenUrl: string;
  thumbnailUrl?: string;
  lastSelectionSignature: string | null;
  timeoutId: number;
  onLoad: () => void;
  onError: () => void;
};

function createOverlayEntry(root: HTMLElement, item: DataPlatformScreenOverlayItem, interactive: boolean): OverlayEntry {
  const screenOrigin = new URL(item.screenUrl, window.location.href).origin;
  let entry!: OverlayEntry;
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.left = '0';
  host.style.top = '0';
  host.style.width = `${OVERLAY_BASE_SIZE_PX}px`;
  host.style.height = `${OVERLAY_BASE_SIZE_PX}px`;
  host.style.transformOrigin = '0 0';
  host.style.overflow = 'hidden';
  host.style.pointerEvents = interactive ? 'auto' : 'none';
  host.style.background = '#101827';

  const fallback = document.createElement('img');
  fallback.alt = '';
  fallback.draggable = false;
  fallback.style.display = item.thumbnailUrl ? 'block' : 'none';
  fallback.style.width = '100%';
  fallback.style.height = '100%';
  fallback.style.objectFit = 'fill';
  fallback.style.pointerEvents = 'none';
  if (item.thumbnailUrl) fallback.src = item.thumbnailUrl;

  const iframe = document.createElement('iframe');
  iframe.title = item.entityId;
  iframe.src = item.screenUrl;
  iframe.loading = 'eager';
  iframe.style.position = 'absolute';
  iframe.style.inset = '0';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.style.background = 'transparent';
  iframe.style.pointerEvents = interactive ? 'auto' : 'none';

  let loaded = false;
  const showFallback = (): void => {
    if (loaded) return;
    iframe.style.display = 'none';
    fallback.style.display = item.thumbnailUrl ? 'block' : 'none';
  };
  const onLoad = (): void => {
    loaded = true;
    entry.lastSelectionSignature = null;
    iframe.style.display = 'block';
    fallback.style.display = 'none';
  };
  const onError = (): void => showFallback();
  iframe.addEventListener('load', onLoad);
  iframe.addEventListener('error', onError);
  const timeoutId = window.setTimeout(showFallback, IFRAME_FALLBACK_TIMEOUT_MS);

  host.append(fallback, iframe);
  root.append(host);
  entry = {
    host,
    iframe,
    fallback,
    item,
    screenOrigin,
    screenUrl: item.screenUrl,
    thumbnailUrl: item.thumbnailUrl,
    lastSelectionSignature: null,
    timeoutId,
    onLoad,
    onError,
  };
  return entry;
}

function postSelectionToScreen(entry: OverlayEntry, selectedEntityIds: readonly string[]): void {
  const message = createDataPlatformScreenSelectionMessage(selectedEntityIds, selectedEntityIds[0] ?? null);
  const signature = JSON.stringify(message.payload);
  if (entry.lastSelectionSignature === signature || !entry.iframe.contentWindow) return;
  entry.iframe.contentWindow.postMessage(message, entry.screenOrigin);
  entry.lastSelectionSignature = signature;
}

function disposeOverlayEntry(entry: OverlayEntry): void {
  window.clearTimeout(entry.timeoutId);
  entry.iframe.removeEventListener('load', entry.onLoad);
  entry.iframe.removeEventListener('error', entry.onError);
  entry.host.remove();
}

export type DataPlatformScreenOverlayProps = {
  scene: Scene;
  runtime: SceneRuntime;
  canvas: HTMLCanvasElement | null;
  interactive?: boolean;
  selectedEntityIds?: readonly string[];
  onCommand?: (item: DataPlatformScreenOverlayItem, command: DataPlatformScreenCommand) => void;
};

/** 在画布上方管理大屏 iframe；没有 URL 或 iframe 超时则自动显示缩略图。 */
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
  selectedEntityIdsRef.current = selectedEntityIds;
  onCommandRef.current = onCommand;

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !canvas) return undefined;
    const entries = entriesRef.current;

    const handleMessage = (event: MessageEvent<unknown>): void => {
      for (const entry of entries.values()) {
        if (event.source !== entry.iframe.contentWindow || event.origin !== entry.screenOrigin) continue;
        const command = parseDataPlatformScreenCommand(event.data);
        if (command) onCommandRef.current?.(entry.item, command);
        return;
      }
    };
    window.addEventListener('message', handleMessage);

    const update = (): void => {
      const items = runtime.getDataPlatformScreenOverlayItems();
      const itemIds = new Set(items.map((item) => item.entityId));
      for (const [entityId, entry] of entries.entries()) {
        if (!itemIds.has(entityId)) {
          disposeOverlayEntry(entry);
          entries.delete(entityId);
        }
      }

      for (const item of items) {
        let entry = entries.get(item.entityId);
        if (entry && (
          entry.screenUrl !== item.screenUrl
          || entry.thumbnailUrl !== item.thumbnailUrl
          || entry.item.projectId !== item.projectId
          || entry.item.screenId !== item.screenId
        )) {
          disposeOverlayEntry(entry);
          entries.delete(item.entityId);
          entry = undefined;
        }
        if (!entry) {
          entry = createOverlayEntry(root, item, interactive);
          entries.set(item.entityId, entry);
        } else {
          entry.item = item;
        }
        postSelectionToScreen(entry, selectedEntityIdsRef.current);
        const corners = projectScreenCorners(scene, canvas, root, item.mesh);
        if (!corners) {
          entry.host.style.display = 'none';
          continue;
        }
        const transform = createCssProjectiveMatrix(OVERLAY_BASE_SIZE_PX, OVERLAY_BASE_SIZE_PX, corners);
        entry.host.style.display = transform ? 'block' : 'none';
        if (transform) entry.host.style.transform = transform;
      }
    };

    const observer = scene.onAfterRenderObservable.add(update);
    update();
    return () => {
      scene.onAfterRenderObservable.remove(observer);
      window.removeEventListener('message', handleMessage);
      for (const entry of entries.values()) disposeOverlayEntry(entry);
      entries.clear();
    };
  }, [canvas, interactive, runtime, scene]);

  return <div aria-hidden={!interactive} ref={rootRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 3 }} />;
}
