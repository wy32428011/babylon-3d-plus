export type PublishedReleaseCacheState = {
  phase: 'checking' | 'caching' | 'ready' | 'partial';
  completedFiles: number;
  totalFiles: number;
  completedBytes: number;
  totalBytes: number;
  reason?: string;
};

/** 首帧后最多两个文件并行补齐，单项失败不丢弃已完成的文件。 */
export async function prefetchPublishedReleaseFiles<T extends { size: number }>(
  files: readonly T[], ensure: (file: T) => Promise<boolean>, signal: AbortSignal,
  onProgress?: (state: PublishedReleaseCacheState) => void,
): Promise<PublishedReleaseCacheState> {
  const state: PublishedReleaseCacheState = { phase: 'caching', completedFiles: 0, totalFiles: files.length,
    completedBytes: 0, totalBytes: files.reduce((sum, file) => sum + file.size, 0) };
  let cursor = 0;
  const worker = async () => {
    while (cursor < files.length) {
      signal.throwIfAborted();
      const file = files[cursor++];
      try {
        if (await ensure(file)) { state.completedFiles++; state.completedBytes += file.size; }
        else state.reason ??= '部分文件未能持久保存，刷新时将按需下载。';
      } catch (error) {
        signal.throwIfAborted();
        state.reason ??= error instanceof Error ? error.message : '发布资源缓存未完成。';
      }
      signal.throwIfAborted();
      onProgress?.({ ...state });
    }
  };
  await Promise.all([worker(), worker()]);
  signal.throwIfAborted();
  state.phase = state.completedFiles === files.length ? 'ready' : 'partial';
  onProgress?.({ ...state });
  return state;
}
