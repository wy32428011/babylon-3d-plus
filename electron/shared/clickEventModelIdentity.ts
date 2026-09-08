const EDITOR_ASSET_URL_PREFIX = 'editor-asset://local/';

/**
 * 点击绑定针对设备类型，同一中台模型的共享库、工程快照和发布包共用资源 ID。
 * 包名允许重命名、SOURCE 冲突后缀和部署哈希；包内路径仍须一致，避免误绑同包其他模型。
 * 普通本地模型没有稳定资源 ID，继续由调用方按完整 URL 匹配。
 */
export function getClickEventModelResourceKey(sourceUrl: unknown): string | null {
  if (typeof sourceUrl !== 'string' || !sourceUrl.startsWith(EDITOR_ASSET_URL_PREFIX)) return null;
  let modelPath: string;
  try {
    modelPath = decodeURIComponent(sourceUrl.slice(EDITOR_ASSET_URL_PREFIX.length).split(/[?#]/, 1)[0]).replace(/\\/g, '/');
  } catch {
    return null;
  }
  if (modelPath.split('/').some((part) => part === '.' || part === '..')) return null;
  const match = /(?:^|\/)(model|combo)-([1-9]\d{0,63})(?:-[^/]+)?\/(.+\.(?:glb|gltf))$/i.exec(modelPath);
  return match ? `${match[1].toLowerCase()}:${match[2]}:${match[3].toLowerCase()}` : null;
}
