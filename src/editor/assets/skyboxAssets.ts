import type { ProjectSkyboxAssetEntry } from './AssetDatabase';
import {
  SCENE_SKYBOX_INTENSITY_DEFAULT,
  SCENE_SKYBOX_RESOLUTION_DEFAULT,
  SCENE_SKYBOX_ROTATION_MIN,
  normalizeDataPlatformResourceId,
  readOwnDataProperty,
  sanitizeSceneSkybox,
  type SceneSkyboxSettings,
} from '../model/SceneDocument';

function normalizePortablePath(value: string): string {
  return value.trim().replace(/\\/g, '/').toLowerCase();
}

function readPortableBaseName(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith('editor-asset://local/')) {
    try {
      normalized = decodeURIComponent(normalized.slice('editor-asset://local/'.length));
    } catch {
      return '';
    }
  }
  const segments = normalized.replace(/\\/g, '/').split('/').filter(Boolean);
  return (segments.at(-1) ?? '').toLowerCase();
}

function createPortableSkyboxKey(packagePath: string, sourcePath: string): string {
  const packageName = readPortableBaseName(packagePath);
  const fileName = readPortableBaseName(sourcePath);
  return packageName && fileName ? `${packageName}/${fileName}` : '';
}

export type SkyboxSyncPhase =
  | 'querying'
  | 'downloading'
  | 'validating'
  | 'promoting'
  | 'completed'
  | 'failed';

export type SkyboxSyncProgress = {
  runId: string;
  phase: SkyboxSyncPhase;
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

const SKYBOX_SYNC_PHASES = new Set<SkyboxSyncPhase>([
  'querying',
  'downloading',
  'validating',
  'promoting',
  'completed',
  'failed',
]);

function readOwnDataPropertySafely(value: unknown, propertyKey: PropertyKey) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return { kind: 'missing' } as const;
  }
  try {
    return readOwnDataProperty(value, propertyKey);
  } catch {
    return { kind: 'missing' } as const;
  }
}

/** 将未知同步错误转换为可渲染文本，绝不调用对象的隐式字符串转换。 */
export function formatSkyboxSyncError(error: unknown): string {
  if (typeof error === 'string') return error.trim() || '未知错误';
  if (typeof error === 'number') return Number.isFinite(error) ? String(error) : '未知错误';
  if (typeof error === 'boolean' || typeof error === 'bigint' || typeof error === 'symbol') {
    try {
      return String(error);
    } catch {
      return '未知错误';
    }
  }

  const messageField = readOwnDataPropertySafely(error, 'message');
  if (messageField.kind === 'data' && typeof messageField.value === 'string') {
    return messageField.value.trim() || '未知错误';
  }
  return '未知错误';
}

const INVALID_SKYBOX_SYNC_MESSAGE = '收到无效的天空盒同步状态。';

function createInvalidSkyboxSyncProgress(progress: unknown): SkyboxSyncProgress {
  const runIdField = readOwnDataPropertySafely(progress, 'runId');
  const runId = runIdField.kind === 'data'
    && typeof runIdField.value === 'string'
    && runIdField.value.trim()
    ? runIdField.value.trim()
    : 'renderer-invalid-skybox-sync';
  return {
    runId,
    phase: 'failed',
    completed: 0,
    total: 0,
    message: INVALID_SKYBOX_SYNC_MESSAGE,
    error: INVALID_SKYBOX_SYNC_MESSAGE,
  };
}

/** 严格校验 IPC 进度；任一字段非法都转为 renderer failed，且绝不触发资源刷新。 */
export function normalizeSkyboxSyncProgress(progress: unknown): {
  valid: boolean;
  progress: SkyboxSyncProgress;
  shouldReloadProjectAssets: boolean;
} {
  const runIdField = readOwnDataPropertySafely(progress, 'runId');
  const phaseField = readOwnDataPropertySafely(progress, 'phase');
  const completedField = readOwnDataPropertySafely(progress, 'completed');
  const totalField = readOwnDataPropertySafely(progress, 'total');
  const messageField = readOwnDataPropertySafely(progress, 'message');
  const errorField = readOwnDataPropertySafely(progress, 'error');

  const runId = runIdField.kind === 'data' && typeof runIdField.value === 'string'
    ? runIdField.value.trim()
    : '';
  const phase = phaseField.kind === 'data' && typeof phaseField.value === 'string'
    && SKYBOX_SYNC_PHASES.has(phaseField.value as SkyboxSyncPhase)
    ? phaseField.value as SkyboxSyncPhase
    : null;
  const completed = completedField.kind === 'data' ? completedField.value : null;
  const total = totalField.kind === 'data' ? totalField.value : null;
  const message = messageField.kind === 'data' ? messageField.value : null;
  const error = errorField.kind === 'data' ? errorField.value : undefined;
  const valid = Boolean(runId)
    && phase !== null
    && typeof completed === 'number'
    && typeof total === 'number'
    && Number.isSafeInteger(completed)
    && Number.isSafeInteger(total)
    && completed >= 0
    && total >= 0
    && completed <= total
    && typeof message === 'string'
    && (error === null || typeof error === 'string');

  if (!valid || phase === null || typeof completed !== 'number' || typeof total !== 'number' || typeof message !== 'string') {
    return {
      valid: false,
      progress: createInvalidSkyboxSyncProgress(progress),
      shouldReloadProjectAssets: false,
    };
  }

  const normalizedProgress: SkyboxSyncProgress = {
    runId,
    phase,
    completed,
    total,
    message,
    error: error as string | null,
  };
  return {
    valid: true,
    progress: normalizedProgress,
    shouldReloadProjectAssets: phase === 'completed',
  };
}

/** 仅在进度计数完整合法且 total 大于零时显示 completed/total。 */
export function formatSkyboxSyncProgressCount(
  progress: Pick<SkyboxSyncProgress, 'completed' | 'total'>,
): string | null {
  if (
    !Number.isSafeInteger(progress.completed)
    || !Number.isSafeInteger(progress.total)
    || progress.completed < 0
    || progress.total <= 0
    || progress.completed > progress.total
  ) return null;
  return `${progress.completed}/${progress.total}`;
}

/** 普通初载只更新资源状态；显式刷新时才允许通过命令系统重关联当前天空盒。 */
export function refreshCurrentSkyboxAfterProjectAssetsLoad(
  refreshSceneAssets: boolean,
  assets: ProjectSkyboxAssetEntry[],
  refreshCurrentSkyboxFromAssets: (assets: ProjectSkyboxAssetEntry[]) => boolean,
): boolean {
  return refreshSceneAssets ? refreshCurrentSkyboxFromAssets(assets) : false;
}

/** 用项目资源路径刷新天空盒引用；场景级显示参数由当前设置保留。 */
export function createSceneSkyboxFromAsset(
  asset: ProjectSkyboxAssetEntry,
  current: SceneSkyboxSettings | null = null,
): SceneSkyboxSettings {
  let dataPlatformResourceId: string | null = null;
  if (asset.source === 'data-platform') {
    if (asset.availability !== 'active') throw new Error('天空盒资源元数据无效。');
    const resourceIdField = readOwnDataProperty(asset, 'dataPlatformResourceId');
    if (resourceIdField.kind !== 'data') throw new Error('天空盒资源元数据无效。');
    dataPlatformResourceId = normalizeDataPlatformResourceId(resourceIdField.value);
    if (!dataPlatformResourceId) throw new Error('天空盒资源元数据无效。');
  }
  const skybox = sanitizeSceneSkybox({
    packagePath: asset.packagePath,
    sourcePath: asset.path,
    sourceUrl: asset.sourceUrl,
    assetRevision: asset.assetRevision,
    ...(dataPlatformResourceId ? { dataPlatformResourceId } : {}),
    format: asset.format,
    rotationDegrees: current?.rotationDegrees ?? SCENE_SKYBOX_ROTATION_MIN,
    intensity: current?.intensity ?? SCENE_SKYBOX_INTENSITY_DEFAULT,
    resolution: current?.resolution ?? SCENE_SKYBOX_RESOLUTION_DEFAULT,
  });
  if (!skybox) throw new Error('天空盒资源元数据无效。');
  return skybox;
}

/** 优先精确路径，其次按“包目录名 + 主文件名”安全重关联跨电脑天空盒资源。 */
export function findSkyboxAssetForSettings(
  skybox: SceneSkyboxSettings,
  assets: ProjectSkyboxAssetEntry[],
): ProjectSkyboxAssetEntry | null {
  const activeAssets = assets.filter((asset) => asset.availability === 'active');
  const resourceIdField = readOwnDataProperty(skybox, 'dataPlatformResourceId');
  if (resourceIdField.kind === 'accessor') return null;
  if (resourceIdField.kind === 'data') {
    const dataPlatformResourceId = normalizeDataPlatformResourceId(resourceIdField.value);
    if (!dataPlatformResourceId) return null;
    const idCandidates = activeAssets.filter((asset) => {
      if (asset.source !== 'data-platform' || asset.availability !== 'active') return false;
      const candidateIdField = readOwnDataProperty(asset, 'dataPlatformResourceId');
      return candidateIdField.kind === 'data'
        && normalizeDataPlatformResourceId(candidateIdField.value) === dataPlatformResourceId;
    });
    return idCandidates.length === 1 ? idCandidates[0] : null;
  }

  const sourcePathKey = normalizePortablePath(skybox.sourcePath);
  const exactCandidates = activeAssets.filter((asset) =>
    normalizePortablePath(asset.path) === sourcePathKey || asset.sourceUrl === skybox.sourceUrl,
  );
  if (exactCandidates.length === 1) return exactCandidates[0];
  if (exactCandidates.length > 1) return null;

  const portableKey = createPortableSkyboxKey(skybox.packagePath, skybox.sourcePath);
  if (!portableKey) return null;
  const portableCandidates = activeAssets.filter((asset) =>
    createPortableSkyboxKey(asset.packagePath, asset.path) === portableKey,
  );
  return portableCandidates.length === 1 ? portableCandidates[0] : null;
}

/** 仅按场景稳定 ID 唯一定位已孤立的数据中台天空盒缓存。 */
export function findOrphanedSkyboxForSettings(
  settings: SceneSkyboxSettings | null,
  orphaned: ProjectSkyboxAssetEntry[],
): ProjectSkyboxAssetEntry | null {
  if (!settings) return null;
  const resourceIdField = readOwnDataProperty(settings, 'dataPlatformResourceId');
  if (resourceIdField.kind !== 'data') return null;
  const dataPlatformResourceId = normalizeDataPlatformResourceId(resourceIdField.value);
  if (!dataPlatformResourceId) return null;

  const candidates = orphaned.filter((asset) => {
    if (asset.source !== 'data-platform' || asset.availability !== 'orphaned') return false;
    const candidateIdField = readOwnDataProperty(asset, 'dataPlatformResourceId');
    return candidateIdField.kind === 'data'
      && normalizeDataPlatformResourceId(candidateIdField.value) === dataPlatformResourceId;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

/** 生成资源卡片使用的紧凑文件体积文案。 */
export function formatSkyboxFileSize(fileSizeBytes: number): string {
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) return '未知大小';
  const mebibytes = fileSizeBytes / 1024 / 1024;
  return mebibytes >= 1 ? `${mebibytes.toFixed(mebibytes >= 10 ? 1 : 2)} MiB` : `${Math.max(1, Math.round(fileSizeBytes / 1024))} KiB`;
}
