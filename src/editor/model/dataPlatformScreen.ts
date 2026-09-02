import type { Entity } from './Entity';
import type { Vector3Data } from './math';
import { createId } from '../../shared/ids';
import type { DataPlatformScreenComponent, DataPlatformScreenRenderMode } from './components';

export const DATA_PLATFORM_SCREEN_DEFAULT_WIDTH_METERS = 4;
export const DATA_PLATFORM_SCREEN_DEFAULT_HEIGHT_METERS = 2.25;
export const DATA_PLATFORM_SCREEN_MIN_SIZE_METERS = 0.1;
export const DATA_PLATFORM_SCREEN_MAX_SIZE_METERS = 100;

export type DataPlatformScreenSource = {
  projectId: string;
  screenId: string;
  name?: string;
  screenUrl?: string;
  thumbnailUrl?: string;
  renderMode?: DataPlatformScreenRenderMode;
  widthMeters?: number;
  heightMeters?: number;
};

/** 相机视窗上的完整大屏只保存引用，不参与三维世界坐标和实体层级。 */
export type DataPlatformViewportScreenComponent = {
  projectId: string;
  screenId: string;
  screenUrl?: string;
  thumbnailUrl?: string;
  renderMode: DataPlatformScreenRenderMode;
  /** 归一化的中间 3D 场景窗口；大屏 Overlay 会在该区域挖空。 */
  sceneWindow: DataPlatformViewportSceneWindow;
};

export type DataPlatformViewportSceneWindow = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const DATA_PLATFORM_VIEWPORT_SCENE_WINDOW_DEFAULT: DataPlatformViewportSceneWindow = {
  x: 0.22,
  y: 0.1,
  width: 0.56,
  height: 0.8,
};

export type DataPlatformViewportScreenSource = Pick<
  DataPlatformScreenSource,
  'projectId' | 'screenId' | 'screenUrl' | 'thumbnailUrl' | 'renderMode'
> & { sceneWindow?: DataPlatformViewportSceneWindow };

function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().slice(0, 128);
  return normalized || null;
}

/** 大屏内容只能从公开 HTTP(S) 地址加载，避免场景文件携带脚本协议。 */
export function normalizeDataPlatformScreenUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().slice(0, 2048);
  if (!normalized) return undefined;

  try {
    const url = new URL(normalized);
    return url.protocol === 'http:' || url.protocol === 'https:' ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function normalizeScreenSize(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(DATA_PLATFORM_SCREEN_MAX_SIZE_METERS, Math.max(DATA_PLATFORM_SCREEN_MIN_SIZE_METERS, value));
}

/** 清洗大屏组件；返回 null 表示场景文件或拖拽数据不具备可渲染条件。 */
export function normalizeDataPlatformScreenComponent(value: unknown): DataPlatformScreenComponent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const projectId = normalizeIdentifier(source.projectId);
  const screenId = normalizeIdentifier(source.screenId);
  const screenUrl = normalizeDataPlatformScreenUrl(source.screenUrl);
  const thumbnailUrl = normalizeDataPlatformScreenUrl(source.thumbnailUrl);
  const widthMeters = normalizeScreenSize(source.widthMeters, DATA_PLATFORM_SCREEN_DEFAULT_WIDTH_METERS);
  const heightMeters = normalizeScreenSize(source.heightMeters, DATA_PLATFORM_SCREEN_DEFAULT_HEIGHT_METERS);
  const rawRenderMode = source.renderMode;

  if (!projectId || !screenId || (!screenUrl && !thumbnailUrl) || widthMeters === null || heightMeters === null) {
    return null;
  }
  if (rawRenderMode !== undefined && rawRenderMode !== 'iframe' && rawRenderMode !== 'texture') return null;
  if (rawRenderMode === 'iframe' && !screenUrl) return null;

  const renderMode = rawRenderMode ?? (screenUrl ? 'iframe' : 'texture');
  return {
    projectId,
    screenId,
    ...(screenUrl ? { screenUrl } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    renderMode,
    widthMeters,
    heightMeters,
  };
}

/** 清洗相机视窗级大屏；该配置要求嵌入页自行提供透明中间区域。 */
export function normalizeDataPlatformViewportScreen(
  value: unknown,
): DataPlatformViewportScreenComponent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const projectId = normalizeIdentifier(source.projectId);
  const screenId = normalizeIdentifier(source.screenId);
  const screenUrl = normalizeDataPlatformScreenUrl(source.screenUrl);
  const thumbnailUrl = normalizeDataPlatformScreenUrl(source.thumbnailUrl);
  const rawRenderMode = source.renderMode;
  const sceneWindow = normalizeDataPlatformViewportSceneWindow(source.sceneWindow);

  if (!projectId || !screenId || (!screenUrl && !thumbnailUrl) || !sceneWindow) return null;
  if (rawRenderMode !== undefined && rawRenderMode !== 'iframe' && rawRenderMode !== 'texture') return null;
  if (rawRenderMode === 'iframe' && !screenUrl) return null;

  return {
    projectId,
    screenId,
    ...(screenUrl ? { screenUrl } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    renderMode: rawRenderMode ?? (screenUrl ? 'iframe' : 'texture'),
    sceneWindow,
  };
}

function normalizeDataPlatformViewportSceneWindow(
  value: unknown,
): DataPlatformViewportSceneWindow | null {
  if (value === undefined) return { ...DATA_PLATFORM_VIEWPORT_SCENE_WINDOW_DEFAULT };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const values = [source.x, source.y, source.width, source.height];
  if (values.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) return null;
  const x = source.x as number;
  const y = source.y as number;
  const width = source.width as number;
  const height = source.height as number;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) return null;
  return { x, y, width, height };
}

/** 将图表库条目转为视窗级完整大屏配置。 */
export function createDataPlatformViewportScreen(
  source: DataPlatformViewportScreenSource,
): DataPlatformViewportScreenComponent {
  const component = normalizeDataPlatformViewportScreen({
    projectId: source.projectId,
    screenId: source.screenId,
    screenUrl: source.screenUrl,
    thumbnailUrl: source.thumbnailUrl,
    renderMode: source.renderMode ?? (source.screenUrl ? 'iframe' : 'texture'),
    sceneWindow: source.sceneWindow,
  });
  if (!component) throw new Error('视窗大屏必须提供 screenUrl 或 thumbnailUrl，且地址必须使用 http/https。');
  return component;
}

/** 将图表库大屏条目转为可直接挂载到场景实体的组件。 */
export function createDataPlatformScreenComponent(source: DataPlatformScreenSource): DataPlatformScreenComponent {
  const component = normalizeDataPlatformScreenComponent({
    projectId: source.projectId,
    screenId: source.screenId,
    screenUrl: source.screenUrl,
    thumbnailUrl: source.thumbnailUrl,
    renderMode: source.renderMode ?? (source.screenUrl ? 'iframe' : 'texture'),
    widthMeters: source.widthMeters,
    heightMeters: source.heightMeters,
  });
  if (!component) throw new Error('大屏必须提供 screenUrl 或 thumbnailUrl，且地址必须使用 http/https。');
  return component;
}

/** 创建一个竖直的大屏平面实体；没有 screenUrl 时自动退化为纹理模式。 */
export function createDataPlatformScreenEntity(
  source: DataPlatformScreenSource,
  position: Vector3Data = { x: 0, y: 0, z: 0 },
): Entity {
  const id = createId('entity');
  const dataPlatformScreen = createDataPlatformScreenComponent(source);

  return {
    id,
    name: source.name?.trim() || '数据中台大屏',
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: { x: position.x, y: position.y, z: position.z },
        // Ground plane 的本地 X/Z 轴分别成为屏幕宽/高；绕 X 轴 90° 后立起。
        rotation: { x: Math.PI / 2, y: 0, z: 0 },
        scale: {
          x: dataPlatformScreen.widthMeters / 2,
          y: 1,
          z: dataPlatformScreen.heightMeters / 2,
        },
      },
      meshRenderer: {
        meshKind: 'plane',
        materialColor: '#101827',
      },
      dataPlatformScreen,
    },
  };
}
