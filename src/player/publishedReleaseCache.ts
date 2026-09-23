import type { PublishedAssetCache } from '../runtime/assets/publishedAssetCache.ts';
import { parsePublishedReleaseManifest } from './publishedReleaseManifest.ts';
import { prefetchPublishedReleaseFiles, type PublishedReleaseCacheState } from './publishedReleasePrefetch.ts';
import { installPublishedResponseCache } from './publishedResponseCache.ts';
import { openPublishedReleaseStorage } from './publishedReleaseStorage.ts';
import { withPublishedCacheSetupBudget } from './publishedCacheSetup.ts';

type ReleaseConfig = { cacheRevision?: string; cacheManifest?: string };
type StateListener = (state: PublishedReleaseCacheState) => void;

/** 清单、容量准入与两种持久存储共享一个完成状态；失败始终允许普通 Viewer 继续运行。 */
export async function preparePublishedReleaseCache(config: ReleaseConfig, baseUrl: string, signal: AbortSignal,
  onState?: StateListener) {
  if (!config.cacheManifest || !config.cacheRevision) return null;
  const publish = (state: PublishedReleaseCacheState) => {
    if (signal.aborted) return;
    const snapshot = Object.freeze({ ...state });
    (globalThis as typeof globalThis & { __ZENDING_RELEASE_CACHE__?: PublishedReleaseCacheState }).__ZENDING_RELEASE_CACHE__ = snapshot;
    onState?.(snapshot);
  };
  let state: PublishedReleaseCacheState = { phase: 'checking', completedFiles: 0, totalFiles: 0, completedBytes: 0, totalBytes: 0 };
  publish(state);
  const cleanup: Array<() => void> = [];
  try {
    const { manifest, lifetime, responseSession } = await withPublishedCacheSetupBudget(signal, async setupSignal => {
      const response = await fetch(new URL(config.cacheManifest!, baseUrl), { cache: 'no-store', signal: setupSignal });
      if (!response.ok) throw new Error(`读取发布缓存清单失败：HTTP ${response.status}。`);
      const manifest = parsePublishedReleaseManifest(await response.json(), baseUrl, config.cacheRevision!);
      setupSignal.throwIfAborted();
      state = { ...state, totalFiles: manifest.files.length, totalBytes: manifest.totalBytes }; publish(state);
      const lifetime = await openPublishedReleaseStorage(baseUrl, manifest, setupSignal);
      cleanup.push(() => lifetime.dispose());
      setupSignal.throwIfAborted();
      const responseSession = lifetime.admitted ? await installPublishedResponseCache(baseUrl, manifest, setupSignal) : null;
      if (responseSession) cleanup.push(() => responseSession.dispose());
      setupSignal.throwIfAborted();
      return { manifest, lifetime, responseSession };
    });
    const resources = new Map(manifest.files.filter(file => file.storage === 'asset')
      .map(file => [file.url, { sha256: file.sha256, size: file.size }]));
    const admitted = lifetime.admitted;
    const reason = lifetime.reason ?? responseSession?.reason;
    let started = false;
    return {
      resources, rawStore: lifetime.rawStore,
      prefetch(cache: PublishedAssetCache, verifyVersion: () => Promise<void>): void {
        if (started || signal.aborted) return;
        started = true;
        if (!admitted) { state = { ...state, phase: 'partial', reason }; publish(state); return; }
        void (async () => {
          state = await prefetchPublishedReleaseFiles(manifest.files, async file => {
            if (file.storage === 'response') return responseSession?.available ? responseSession.ensure(file) : false;
            const loaded = await cache.fetch(file.url, { signal });
            if (!loaded.ok) throw new Error(`缓存发布资源失败：HTTP ${loaded.status}，${file.path}`);
            await loaded.body?.cancel();
            return cache.hasResource(file.url);
          }, signal, next => {
            // 文件补齐后还需版本复核及完成记录提交，不能提前向界面报告 ready。
            state = { ...next, phase: 'caching', reason: next.reason ?? reason }; publish(state);
          });
          await verifyVersion();
          signal.throwIfAborted();
          state = { ...state, reason: state.phase === 'ready' ? undefined : reason ?? state.reason };
          await lifetime.markComplete(state);
          publish(state);
        })().catch(error => {
          if (signal.aborted) return;
          state = { ...state, phase: 'partial', reason: error instanceof Error ? error.message : '发布资源缓存未完成。' };
          publish(state);
          console.warn('[Viewer cache] 完整缓存未完成，已缓存文件仍可复用。', error);
        });
      },
      dispose() { responseSession?.dispose(); lifetime.dispose(); },
    };
  } catch (error) {
    for (const dispose of cleanup.reverse()) dispose();
    signal.throwIfAborted();
    publish({ ...state, phase: 'partial', reason: error instanceof Error ? error.message : '完整缓存不可用。' });
    console.warn('[Viewer cache] 完整缓存不可用，继续普通资源加载。', error);
    return null;
  }
}
