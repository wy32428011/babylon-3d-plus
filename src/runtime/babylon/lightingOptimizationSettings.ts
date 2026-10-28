export type LightingOptimizationOptions = {
  shadowCache: 'global' | 'local';
  environmentBatching: boolean;
};

/** 诊断候选只影响当前运行实例，不进入场景文件；URL 可覆盖本机显式开关。 */
export function readLightingOptimizationOptions(): LightingOptimizationOptions {
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const read = (query: string, key: string): string | null => {
    if (params.has(query)) return params.get(query);
    try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); }
    catch { return null; }
  };
  return {
    shadowCache: read('lightingShadowCache', 'editor.lightingShadowCache') === 'local' ? 'local' : 'global',
    environmentBatching: read('lightingGiBatching', 'editor.lightingGiBatching') === '1',
  };
}
