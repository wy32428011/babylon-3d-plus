import type { ProjectSkyboxAssetEntry } from './AssetDatabase';
import {
  SCENE_SKYBOX_INTENSITY_DEFAULT,
  SCENE_SKYBOX_RESOLUTION_DEFAULT,
  SCENE_SKYBOX_ROTATION_MIN,
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

/** 用项目资源路径刷新天空盒引用；场景级显示参数由当前设置保留。 */
export function createSceneSkyboxFromAsset(
  asset: ProjectSkyboxAssetEntry,
  current: SceneSkyboxSettings | null = null,
): SceneSkyboxSettings {
  const skybox = sanitizeSceneSkybox({
    packagePath: asset.packagePath,
    sourcePath: asset.path,
    sourceUrl: asset.sourceUrl,
    assetRevision: asset.assetRevision,
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
  const sourcePathKey = normalizePortablePath(skybox.sourcePath);
  const exactCandidates = assets.filter((asset) =>
    normalizePortablePath(asset.path) === sourcePathKey || asset.sourceUrl === skybox.sourceUrl,
  );
  if (exactCandidates.length === 1) return exactCandidates[0];
  if (exactCandidates.length > 1) return null;

  const portableKey = createPortableSkyboxKey(skybox.packagePath, skybox.sourcePath);
  if (!portableKey) return null;
  const portableCandidates = assets.filter((asset) =>
    createPortableSkyboxKey(asset.packagePath, asset.path) === portableKey,
  );
  return portableCandidates.length === 1 ? portableCandidates[0] : null;
}

/** 生成资源卡片使用的紧凑文件体积文案。 */
export function formatSkyboxFileSize(fileSizeBytes: number): string {
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) return '未知大小';
  const mebibytes = fileSizeBytes / 1024 / 1024;
  return mebibytes >= 1 ? `${mebibytes.toFixed(mebibytes >= 10 ? 1 : 2)} MiB` : `${Math.max(1, Math.round(fileSizeBytes / 1024))} KiB`;
}
