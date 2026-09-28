import { useEffect, useState } from 'react';
import type { PublishedReleaseCacheState } from './publishedReleasePrefetch';

/** 缓存异常由缓存协调层记录到控制台，页面仅显示正常进度和短暂成功提示。 */
export function PublishedCacheStatus({ state }: { state: PublishedReleaseCacheState }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(false);
    if (state.phase !== 'ready') return;
    const timer = window.setTimeout(() => setDismissed(true), 3500);
    return () => window.clearTimeout(timer);
  }, [state.phase]);
  if (dismissed || state.phase === 'partial') return null;
  const percent = state.totalBytes > 0 ? Math.floor(state.completedBytes / state.totalBytes * 100) : 0;
  return <div className="player-cache-status" role="status" title={state.reason}>
    {state.phase === 'ready' ? '场景资源已缓存，刷新可复用'
      : state.phase === 'checking' ? '正在检查场景缓存' : `正在缓存场景资源 ${percent}%`}
  </div>;
}
