import { useEffect, useState } from 'react';
import type { PublishedReleaseCacheState } from './publishedReleasePrefetch';

/** 缓存进度不阻挡场景操作，成功提示短暂显示后自动收起。 */
export function PublishedCacheStatus({ state }: { state: PublishedReleaseCacheState }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(false);
    if (state.phase !== 'ready') return;
    const timer = window.setTimeout(() => setDismissed(true), 3500);
    return () => window.clearTimeout(timer);
  }, [state.phase]);
  if (dismissed) return null;
  const percent = state.totalBytes > 0 ? Math.floor(state.completedBytes / state.totalBytes * 100) : 0;
  return <div className="player-cache-status" role="status" title={state.reason}>
    {state.phase === 'ready' ? '场景资源已缓存，刷新可复用'
      : state.phase === 'partial' ? '部分资源尚未缓存，刷新时将按需下载'
        : state.phase === 'checking' ? '正在检查场景缓存' : `正在缓存场景资源 ${percent}%`}
  </div>;
}
