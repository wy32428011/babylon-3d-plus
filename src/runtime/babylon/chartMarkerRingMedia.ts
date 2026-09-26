import type { ChartMarkerComponent } from '../../editor/model/components';
import type { ChartMarkerTextureFrame } from './chartMarkerContent';
import { CHART_MARKER_SURFACE_CHANNEL, getChartMarkerSurfaceSize, parseChartMarkerSurfaceResponse } from './chartMarkerSurfaceBridge';

/** 网页只保留一个运行实例；拉取帧有界串行，过期的异步解码不会覆盖新内容。 */
export function createChartMarkerRingMedia(iframe: HTMLIFrameElement | null, video?: HTMLVideoElement) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const frame: ChartMarkerTextureFrame = { canvas, revision: 0, ring: true, opaque: true };
  // HTTP 内网 Viewer 也能使用 getRandomValues；randomUUID 仅在安全上下文暴露。
  const session = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join('');
  let requestCount = 0;
  let pending = '';
  let pendingSince = 0;
  let lastRequest = -Infinity;
  let lastVideoTime = -1;
  let lastVideoFrame = -Infinity;
  let status = '';
  let disposed = false;
  let generation = 0;
  let screenOrigin = '';
  let failedVideo = false;
  let hasFrame = false;
  let decoding = false;

  function drawStatus(message: string): void {
    if (status === message && frame.revision) return;
    status = message;
    hasFrame = false;
    lastVideoTime = -1;
    context.fillStyle = '#101827';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#b7e7fa';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `${Math.max(16, Math.min(canvas.height / 10, canvas.width / 32))}px "Microsoft YaHei",sans-serif`;
    const lines = message.split('\n');
    lines.forEach((line, index) => context.fillText(line, canvas.width / 2, canvas.height / 2 + (index - (lines.length - 1) / 2) * canvas.height / 7, canvas.width * 0.92));
    frame.revision++;
  }

  function resize(style: Required<ChartMarkerComponent>): void {
    const size = getChartMarkerSurfaceSize(style.width, style.height);
    if (canvas.width === size.width && canvas.height === size.height) return;
    canvas.width = size.width;
    canvas.height = size.height;
    status = '';
    hasFrame = false;
    lastVideoTime = -1;
    generation++;
    pending = '';
  }

  function onLoad(): void {
    generation++;
    pending = '';
    lastRequest = -Infinity;
    status = '';
    hasFrame = false;
  }
  iframe?.addEventListener('load', onLoad);

  async function receive(event: MessageEvent<unknown>): Promise<void> {
    if (disposed || decoding || !pending || event.source !== iframe?.contentWindow || event.origin !== screenOrigin) return;
    const response = parseChartMarkerSurfaceResponse(event.data, pending);
    if (!response) return;
    // 解码完成前仍保持在途状态，防止低速设备堆积图片解码任务。
    const request = pending;
    const version = generation;
    if (response.type === 'frame-error') {
      pending = '';
      drawStatus(`${response.message}\n双击打开原始大屏`);
      return;
    }
    decoding = true;
    try {
      const bitmap = new Image();
      bitmap.src = response.dataUrl;
      await bitmap.decode();
      if (disposed || generation !== version || pending !== request) return;
      if (bitmap.naturalWidth !== response.width || bitmap.naturalHeight !== response.height) throw new Error('画面尺寸与声明不一致');
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      status = '';
      hasFrame = true;
      frame.revision++;
    } catch (error) {
      if (!disposed && generation === version && pending === request) {
        drawStatus('环形大屏画面解码失败\n双击打开原始大屏');
        console.warn('图表立标环形画面解码失败', error);
      }
    } finally {
      decoding = false;
      if (pending === request) pending = '';
    }
  }
  const onMessage = (event: MessageEvent<unknown>): void => { void receive(event); };
  window.addEventListener('message', onMessage);

  return {
    update(style: Required<ChartMarkerComponent>, url: string, active: boolean): ChartMarkerTextureFrame {
      if (disposed) return frame;
      resize(style);
      frame.repeats = style.ringRepeat;
      screenOrigin = url ? new URL(url).origin : '';
      const now = performance.now();
      if (video) {
        if (!active) { drawStatus('视频已配置，运行后自动播放'); return frame; }
        if (failedVideo) return frame;
        if (video.error) { drawStatus('视频加载失败\n请检查地址、编码与服务器跨域许可'); return frame; }
        if (video.readyState < 2) { drawStatus(url ? '视频加载中…\n双击打开播放窗口' : '请在属性面板配置视频地址'); return frame; }
        if (video.currentTime === lastVideoTime || now - lastVideoFrame < 1000 / 30) return frame;
        lastVideoTime = video.currentTime;
        lastVideoFrame = now;
        try {
          context.fillStyle = '#000';
          context.fillRect(0, 0, canvas.width, canvas.height);
          const factor = style.videoFit === 'cover' ? Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight)
            : Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
          const width = video.videoWidth * factor, height = video.videoHeight * factor;
          context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
          status = '';
          hasFrame = true;
          frame.revision++;
        } catch (error) {
          failedVideo = true;
          drawStatus('视频不能映射到曲面\n请使用允许跨域访问的视频直链');
          console.warn('图表立标环形视频纹理不可用', error);
        }
      } else if (iframe) {
        if (!hasFrame && !status) drawStatus('正在连接环形大屏…');
        if (!active || document.hidden) return frame;
        if (!decoding && pending && now - pendingSince > 8000) {
          pending = '';
          generation++;
          drawStatus('大屏暂未提供环形画面\n请更新中台或双击打开原始大屏');
        }
        if (!decoding && !pending && now - lastRequest >= 1200 && iframe.contentWindow) {
          pending = `${session}:${++requestCount}`;
          pendingSince = lastRequest = now;
          iframe.contentWindow.postMessage({ channel: CHART_MARKER_SURFACE_CHANNEL, version: 1, type: 'request-frame', requestId: pending,
            width: canvas.width, height: canvas.height }, screenOrigin);
        }
      } else if (!status) drawStatus('请绑定数据中台大屏');
      return frame;
    },
    dispose(): void {
      disposed = true;
      generation++;
      pending = '';
      iframe?.removeEventListener('load', onLoad);
      window.removeEventListener('message', onMessage);
      canvas.width = canvas.height = 0;
    },
  };
}
