import type { CompositionLibraryEntry } from '../../../../electron/shared/compositionTypes';

/**
 * 组合库条目的模块级 Promise 缓存：同一 libraryId+revision 并发只发一次 IPC，
 * entry 内容不可变（revision 钉死）可跨预览复用；失败不缓存，允许上层重试。
 */
const compositionEntryCache = new Map<string, Promise<CompositionLibraryEntry>>();

/** 按 libraryId+revision 加载组合库条目；条目不存在或加载失败时 reject。 */
export function getCompositionLibraryEntry(libraryId: string, revision: string): Promise<CompositionLibraryEntry> {
  const key = `${libraryId}:${revision}`;
  const cached = compositionEntryCache.get(key);
  if (cached) return cached;

  if (typeof window === 'undefined' || !window.editorApi?.loadComposition) {
    return Promise.reject(new Error('当前环境不支持组合库加载。'));
  }

  const pending = window.editorApi.loadComposition(libraryId, revision).then((entry) => {
    if (!entry) throw new Error(`组合库条目不存在：${libraryId}（revision ${revision}）。`);
    return entry;
  });
  pending.catch(() => {
    if (compositionEntryCache.get(key) === pending) compositionEntryCache.delete(key);
  });
  compositionEntryCache.set(key, pending);
  return pending;
}

/** 预览停止/场景卸载时清空缓存，防止组合库删除后旧 entry 长期驻留。 */
export function clearCompositionCache(): void {
  compositionEntryCache.clear();
}
