export type ChartMarkerVideoOptions = {
  url: string;
  loop: boolean;
  controls: boolean;
  fit: 'contain' | 'cover';
};

/** 视频自身管理媒体状态；几何更新只传入可见性，不逐帧调用 play 或重建视频。 */
export function createChartMarkerVideo(parent: HTMLElement, options: ChartMarkerVideoOptions) {
  const video = document.createElement('video');
  video.dataset.chartMarkerVideo = '';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#000;pointer-events:none';
  const status = document.createElement('div');
  status.dataset.chartMarkerVideoStatus = '';
  status.setAttribute('role', 'status');
  status.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:12px;color:#fff;background:#101827d9;text-align:center;font:14px sans-serif;pointer-events:none';
  const message = document.createElement('span');
  const action = document.createElement('button');
  action.type = 'button';
  action.style.cssText = 'font:inherit;color:#fff;background:#12627a;border:1px solid #7de3ff;border-radius:4px;padding:6px 12px;cursor:pointer;pointer-events:none';
  status.append(message, action);
  parent.append(video, status);
  let active = false;
  let inView = false;
  let interactive = false;
  let disposed = false;
  let suspended = true;
  let wantsPlayback = true;
  let needsAction = false;
  let failed = false;
  let generation = 0;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  let current = options;

  function clearSlowTimer(): void {
    if (slowTimer !== undefined) clearTimeout(slowTimer);
    slowTimer = undefined;
  }

  function show(text: string, button = ''): void {
    message.textContent = text;
    action.textContent = button;
    action.hidden = !button;
    action.style.pointerEvents = interactive && active && button ? 'auto' : 'none';
    status.style.display = text ? 'flex' : 'none';
  }

  function pause(): void {
    if (!video.paused) video.pause();
  }

  function release(): void {
    generation++;
    clearSlowTimer();
    pause();
    if (video.hasAttribute('src')) {
      video.removeAttribute('src');
      video.load();
    }
  }

  function attemptPlay(): void {
    if (disposed || suspended || !wantsPlayback || needsAction || !current.url) return;
    const request = ++generation;
    if (!video.hasAttribute('src')) {
      video.src = current.url;
      show('视频加载中…');
    }
    clearSlowTimer();
    slowTimer = setTimeout(() => {
      if (!disposed && request === generation && video.readyState < 3) show('视频加载较慢，正在等待媒体数据…');
    }, 8000);
    void video.play().catch((error: unknown) => {
      if (disposed || request !== generation || suspended) return;
      clearSlowTimer();
      const name = error instanceof DOMException ? error.name : '';
      // 用户在开始缓冲时暂停也会中止 play Promise，不应显示网络失败。
      if (name === 'AbortError') return;
      needsAction = true;
      failed = name !== 'NotAllowedError';
      show(failed ? '视频无法播放，请检查地址、网络或视频编码' : '浏览器未允许自动播放', failed ? '重试视频' : '点击播放');
    });
  }

  function reconcile(): void {
    const nextSuspended = !active || !inView || document.hidden;
    if (nextSuspended === suspended) return;
    suspended = nextSuspended;
    if (suspended) { generation++; clearSlowTimer(); pause(); }
    else attemptPlay();
  }

  function onPlaying(): void {
    if (disposed || suspended) { pause(); return; }
    clearSlowTimer();
    needsAction = failed = false;
    wantsPlayback = true;
    show('');
  }
  function onPause(): void {
    // 旧 pause 事件可能在重新 play 后到达；以当前媒体状态判断，load 清队列也不会留下计数。
    if (video.paused && !disposed && !suspended && !video.ended && !failed && !needsAction) {
      wantsPlayback = false;
      clearSlowTimer();
      show('');
    }
  }
  function onWaiting(): void {
    if (!disposed && !suspended && wantsPlayback && !needsAction) show('视频缓冲中…');
  }
  function onError(): void {
    if (disposed || !active || !video.hasAttribute('src') || !video.error) return;
    generation++;
    clearSlowTimer();
    needsAction = failed = true;
    show(video.error.code === 3 ? '视频解码失败，请使用浏览器支持的编码' : '视频加载失败，请检查地址、网络或访问权限', '重试视频');
  }
  function onEnded(): void {
    if (!current.loop) { wantsPlayback = false; show('播放结束', '重新播放'); }
  }
  function onAction(event: Event): void {
    event.stopPropagation();
    if (!active || suspended || disposed) return;
    if (failed) release();
    needsAction = failed = false;
    wantsPlayback = true;
    if (video.ended) video.currentTime = 0;
    attemptPlay();
  }
  const listeners = { playing: onPlaying, pause: onPause, waiting: onWaiting, error: onError, ended: onEnded };
  for (const [event, listener] of Object.entries(listeners)) video.addEventListener(event, listener);
  action.addEventListener('click', onAction);
  document.addEventListener('visibilitychange', reconcile);

  function update(next: ChartMarkerVideoOptions): void {
    current = next;
    video.loop = next.loop;
    video.controls = next.controls;
    video.style.objectFit = next.fit;
    video.style.pointerEvents = active && interactive && next.controls ? 'auto' : 'none';
  }
  update(options);
  show(options.url ? '视频已配置，运行后自动播放' : '请在属性面板配置视频地址');

  return {
    video,
    update,
    setPlayback(nextActive: boolean, visible: boolean): void {
      if (disposed) return;
      if (active !== nextActive) {
        active = nextActive;
        if (!active) {
          suspended = true;
          release();
          wantsPlayback = true;
          needsAction = failed = false;
          video.muted = true;
          show(current.url ? '视频已配置，运行后自动播放' : '请在属性面板配置视频地址');
        }
      }
      inView = visible;
      reconcile();
      video.style.pointerEvents = active && interactive && current.controls ? 'auto' : 'none';
      action.style.pointerEvents = active && interactive && !action.hidden ? 'auto' : 'none';
    },
    setInteractive(value: boolean): void {
      interactive = value;
      video.style.pointerEvents = active && interactive && current.controls ? 'auto' : 'none';
      action.style.pointerEvents = active && interactive && !action.hidden ? 'auto' : 'none';
    },
    hasInteractiveContent(): boolean {
      return active && interactive && ((current.controls && video.readyState >= 2) || !action.hidden);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const [event, listener] of Object.entries(listeners)) video.removeEventListener(event, listener);
      document.removeEventListener('visibilitychange', reconcile);
      action.removeEventListener('click', onAction);
      release();
      video.remove();
      status.remove();
    },
  };
}
