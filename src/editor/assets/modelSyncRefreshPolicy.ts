export type ModelSyncRefreshProgress = {
  phase: 'querying' | 'downloading' | 'validating' | 'promoting' | 'completed' | 'failed';
  /** 新主进程返回本轮是否实际修改了本地模型库；缺省表示旧版本契约。 */
  libraryChanged?: boolean;
  runtimeChangedResourceKeys?: readonly string[];
  changedResourceIds?: readonly string[];
  changedCount?: number;
};

export type ProjectModelSyncAsset = {
  packagePath?: string;
  path: string;
};

/**
 * 模型同步是项目打开后的后台校验任务。只有同步成功且本地模型库实际变化时，
 * 才需要重新关联场景模型；旧主进程没有变更摘要时保守刷新一次以保持兼容。
 */
export function shouldRefreshProjectModelsAfterSync(progress: ModelSyncRefreshProgress): boolean {
  if (progress.phase !== 'completed') return false;
  if (typeof progress.libraryChanged === 'boolean') return progress.libraryChanged;
  if (Array.isArray(progress.runtimeChangedResourceKeys)) return progress.runtimeChangedResourceKeys.length > 0;
  if (Array.isArray(progress.changedResourceIds)) return progress.changedResourceIds.length > 0;
  if (typeof progress.changedCount === 'number' && Number.isFinite(progress.changedCount)) {
    return progress.changedCount > 0;
  }
  return true;
}

/** 从同步受管目录提取普通/组合模型稳定键，目录名称变化以后的旧路径仍可匹配。 */
export function getProjectModelSyncResourceKey(asset: ProjectModelSyncAsset): string | null {
  const normalizedPath = (asset.packagePath || asset.path).replace(/\\/g, '/');
  const packageName = normalizedPath.split('/').filter(Boolean).at(-1) ?? '';
  const match = /^(Model|Combo)-(\d{1,64})(?:-|$)/i.exec(packageName);
  return match ? `${match[1].toLowerCase() === 'combo' ? 'combo' : 'model'}:${match[2]}` : null;
}

/**
 * 新协议只把运行时 revision 变化的模型交给 Store；null 表示旧协议，需要保守全量关联。
 */
export function filterProjectModelsForSyncRefresh<T extends ProjectModelSyncAsset>(
  assets: readonly T[],
  runtimeChangedResourceKeys: readonly string[] | null,
): T[] {
  if (runtimeChangedResourceKeys === null) return [...assets];
  const changed = new Set(runtimeChangedResourceKeys);
  if (changed.size === 0) return [];
  return assets.filter((asset) => {
    const key = getProjectModelSyncResourceKey(asset);
    return key !== null && changed.has(key);
  });
}
