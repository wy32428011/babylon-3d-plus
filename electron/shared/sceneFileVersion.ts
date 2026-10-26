/** 场景文件外层版本；光照、资产索引和发布 manifest 各自维护独立版本。 */
export const CURRENT_SCENE_FILE_VERSION = 7;

export type SupportedSceneFileVersion = 1 | 2 | 3 | 4 | 5 | 6 | typeof CURRENT_SCENE_FILE_VERSION;

/** 所有读入口共用严格白名单，避免新保存格式被旧资源/发布入口拒绝。 */
export function isSupportedSceneFileVersion(version: unknown): version is SupportedSceneFileVersion {
  return version === 1 || version === 2 || version === 3 || version === 4 || version === 5 || version === 6
    || version === CURRENT_SCENE_FILE_VERSION;
}
