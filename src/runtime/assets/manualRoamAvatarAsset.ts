export const DEFAULT_MANUAL_ROAM_AVATAR_PUBLIC_PATH = 'manual-roam/EQ_People.glb';

export const DEFAULT_MANUAL_ROAM_AVATAR_ASSET = Object.freeze({
  fileName: 'EQ_People.glb',
  publicPath: DEFAULT_MANUAL_ROAM_AVATAR_PUBLIC_PATH,
  sha256: '42499f8bdd191f2a97143a668f705d840e9b9ee3a3a565285d550f89d542f6e6',
  nominalHeightMeters: 1.72467,
  hasEmbeddedAnimations: false,
  hasSkinnedMesh: false,
});

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
