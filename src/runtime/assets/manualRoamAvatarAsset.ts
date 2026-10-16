export const DEFAULT_MANUAL_ROAM_AVATAR_PUBLIC_PATH = 'manual-roam/EQ_People_rigged_v2.glb';
export const MANUAL_ROAM_MOTION_PUBLIC_PATH = 'manual-roam/locomotion-v2.glb';
export const MANUAL_ROAM_MOTION_MANIFEST_PATH = 'manual-roam/locomotion-v2.manifest.json';

export const LEGACY_MANUAL_ROAM_AVATAR_ASSET = Object.freeze({
  fileName: 'EQ_People.glb',
  publicPath: 'manual-roam/EQ_People.glb',
  sha256: '42499f8bdd191f2a97143a668f705d840e9b9ee3a3a565285d550f89d542f6e6',
  nominalHeightMeters: 1.72467,
  hasEmbeddedAnimations: false,
  hasSkinnedMesh: false,
});

export const DEFAULT_MANUAL_ROAM_AVATAR_ASSET = Object.freeze({
  fileName: 'EQ_People_rigged_v2.glb',
  publicPath: DEFAULT_MANUAL_ROAM_AVATAR_PUBLIC_PATH,
  sha256: '382ccef3e7420936e5bc50ab4b89eb6946a3818de3e81e867225fc754ea32def',
  hasEmbeddedAnimations: false,
  hasSkinnedMesh: true,
});

/** 与人物使用同一相对部署根目录，兼容 Electron、子目录 Viewer 和离线发布缓存。 */
export function resolveManualRoamMotionUrls(
  documentBaseUrl: string = document.baseURI,
  publicBaseUrl: string = import.meta.env.BASE_URL,
  version: 'v1' | 'v2' = 'v2',
): { sourceUrl: string; manifestUrl: string } {
  const root = new URL(publicBaseUrl.endsWith('/') ? publicBaseUrl : `${publicBaseUrl}/`, documentBaseUrl);
  return {
    sourceUrl: new URL(`manual-roam/locomotion-${version}.glb`, root).href,
    manifestUrl: new URL(`manual-roam/locomotion-${version}.manifest.json`, root).href,
  };
}

/**
 * 通过 Vite 的公共目录基址解析人物模型，兼容开发、Electron 和相对路径部署。
 */
export function resolveDefaultManualRoamAvatarUrl(
  documentBaseUrl: string = document.baseURI,
  publicBaseUrl: string = import.meta.env.BASE_URL,
): string {
  const normalizedPublicBase = publicBaseUrl.endsWith('/')
    ? publicBaseUrl
    : `${publicBaseUrl}/`;
  const publicRootUrl = new URL(normalizedPublicBase, documentBaseUrl);
  return new URL(DEFAULT_MANUAL_ROAM_AVATAR_PUBLIC_PATH, publicRootUrl).href;
}
