import type { OpeningPackageStage, OpeningRoute, OpeningScalar, OpeningTextStyle } from '../../shared/opening/openingPackage.ts';
import type { OpeningPackageAssets } from './openingPackageAssets.ts';
import { getOpeningRoutePoint, getPackageTimelineFrame, resolveOpeningStage } from './openingPackageTimeline.ts';
import { OpeningImageBudget } from './openingImageBudget.ts';

export type OpeningVisualControls = {
  onSkip(): void; onSeek(seconds: number): void; onPauseToggle(): void; onRestart(): void;
};
export type OpeningVisualRenderContext = {
  elapsedSeconds: number; totalDurationSeconds: number; isPaused: boolean; opacity: number; stageIndex: number;
};
export type OpeningControlledVisual = {
  ready: Promise<void>; renderAt(seconds: number, context: OpeningVisualRenderContext): void; resize(): void; dispose(): void;
};
let visualSequence = 0;

/** 声明式分镜只使用已注册的图片、文字、飞线与缩放绘制能力，不执行包内代码。 */
export function createTimelineOpeningVisual(container: HTMLElement, options: {
  stages: readonly OpeningPackageStage[]; values: Record<string, OpeningScalar>; assets: OpeningPackageAssets;
  allowSkip: boolean; reducedMotion: boolean; controls: OpeningVisualControls;
}): OpeningControlledVisual {
  const stages = options.stages.map(stage => resolveOpeningStage(stage, options.values));
  const fontPrefix = `Opening_${++visualSequence}_`;
  const wrapper = document.createElement('div');
  Object.assign(wrapper.style, { position: 'absolute', inset: '0', overflow: 'hidden', background: '#020813', color: '#e8f5ff', fontFamily: 'system-ui, sans-serif' });
  wrapper.tabIndex = 0;
  wrapper.setAttribute('aria-label', '开场动画播放器');
  container.appendChild(wrapper);
  const artboard = document.createElement('div');
  Object.assign(artboard.style, { position: 'absolute', overflow: 'hidden' }); wrapper.appendChild(artboard);
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
  canvas.setAttribute('aria-hidden', 'true'); artboard.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) { wrapper.remove(); throw new Error('当前设备不支持开场 Canvas2D 绘制。'); }
  const title = document.createElement('div'), subtitle = document.createElement('div'), description = document.createElement('div');
  for (const element of [title, subtitle, description]) {
    Object.assign(element.style, { position: 'absolute', whiteSpace: 'pre-wrap', lineHeight: '1.3', maxWidth: '84%', textShadow: '0 2px 16px #0009', pointerEvents: 'none' });
    artboard.appendChild(element);
  }
  const controls = document.createElement('div');
  Object.assign(controls.style, { position: 'absolute', bottom: '22px', left: '5%', right: '5%', display: 'flex', alignItems: 'center', gap: '12px', fontSize: '13px' });
  wrapper.appendChild(controls);
  const listeners: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, callback: EventListener) => { target.addEventListener(type, callback); listeners.push(() => target.removeEventListener(type, callback)); };
  const button = (label: string, action: () => void) => {
    const element = document.createElement('button'); element.type = 'button'; element.textContent = label;
    Object.assign(element.style, { border: '1px solid #79c9ff66', background: '#07182bdd', color: 'inherit', borderRadius: '6px', padding: '7px 12px', cursor: 'pointer' });
    listen(element, 'click', action); controls.appendChild(element); return element;
  };
  const play = button('暂停', options.controls.onPauseToggle);
  button('重播', options.controls.onRestart);
  const progress = document.createElement('input'); progress.type = 'range'; progress.min = '0'; progress.step = '.01';
  progress.disabled = !options.allowSkip; progress.setAttribute('aria-label', '开场播放进度');
  Object.assign(progress.style, { flex: '1', minWidth: '60px', accentColor: '#66d8ff' }); controls.appendChild(progress);
  listen(progress, 'input', () => options.controls.onSeek(Number(progress.value)));
  const readout = document.createElement('span'); controls.appendChild(readout);
  if (options.allowSkip) button('进入场景', options.controls.onSkip);
  listen(wrapper, 'keydown', event => {
    const key = event as KeyboardEvent;
    if ((event.target as HTMLElement)?.tagName === 'INPUT') return;
    if (key.key === ' ') { key.preventDefault(); key.stopPropagation(); options.controls.onPauseToggle(); }
    else if (key.key === 'Escape' && options.allowSkip) { key.preventDefault(); key.stopPropagation(); options.controls.onSkip(); }
  });
  let disposed = false, readyState = false;
  let width = 1600, height = 900, dpr = 1;
  let context: OpeningVisualRenderContext = { elapsedSeconds: 0, totalDurationSeconds: 0, isPaused: false, opacity: 1, stageIndex: 0 };
  const images = new Map<string, HTMLImageElement>(), fonts = new Map<string, FontFace>();
  const imageBudget = new OpeningImageBudget();
  const cancelImages = new Set<() => void>();

  async function loadImage(id: string): Promise<void> {
    const url = await options.assets.url(id);
    if (disposed) return;
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { image.onload = null; image.onerror = null; cancelImages.delete(cancel); };
      const cancel = () => { cleanup(); image.src = ''; reject(new Error('开场图片加载已取消。')); };
      cancelImages.add(cancel);
      image.onload = () => {
        cleanup();
        try { imageBudget.accept(image.naturalWidth, image.naturalHeight, id); }
        catch (error) { image.src = ''; reject(error); return; }
        if (!disposed) images.set(id, image); resolve();
      };
      image.onerror = () => { cleanup(); reject(new Error(`开场图片 ${id} 无法解码。`)); };
      image.src = url;
    });
  }
  async function loadFont(id: string): Promise<void> {
    const url = await options.assets.url(id);
    if (disposed) return;
    const font = new FontFace(`${fontPrefix}${id}`, `url("${url}")`);
    await font.load();
    if (disposed) return;
    document.fonts.add(font); fonts.set(id, font);
  }
  const imageIds = new Set(stages.flatMap(stage => [stage.backgroundAssetId, stage.logoAssetId].filter((id): id is string => !!id)));
  const fontIds = new Set(stages.flatMap(stage => [stage.textStyle?.fontAssetId, stage.subtitleStyle?.fontAssetId].filter((id): id is string => !!id)));
  const jobs = [...imageIds].map(id => () => loadImage(id)).concat([...fontIds].map(id => () => loadFont(id)));
  let nextJob = 0;
  const ready = Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
    while (!disposed && nextJob < jobs.length) await jobs[nextJob++]();
  })).then(() => { if (!disposed) { readyState = true; resize(); } });

  function setText(element: HTMLElement, text: string, style: OpeningTextStyle | undefined, fallback: { x: number; y: number; size: number; color: string }): void {
    const align = style?.align ?? 'left';
    element.textContent = text;
    Object.assign(element.style, { color: style?.color ?? fallback.color,
      fontSize: `${(style?.fontSize ?? fallback.size) * Math.min(width / 1600, height / 900)}px`,
      left: `${(style?.x ?? fallback.x) * 100}%`, top: `${(style?.y ?? fallback.y) * 100}%`,
      textAlign: align, transform: `translateX(${align === 'center' ? '-50%' : align === 'right' ? '-100%' : '0'})`,
      fontFamily: style?.fontAssetId ? `"${fontPrefix}${style.fontAssetId}", system-ui, sans-serif` : 'system-ui, sans-serif' });
  }
  function drawRoute(route: OpeningRoute, age: number, index: number, map: { x: number; y: number; width: number; height: number }): void {
    const color = route.color ?? '#55d9ff';
    const routeWidth = route.width ?? 2;
    if (routeWidth === 0) return;
    const reveal = options.reducedMotion ? 1 : Math.max(0, Math.min(1, (age - index * .045) / .9));
    if (!reveal) return;
    const point = (fraction: number) => {
      const uv = getOpeningRoutePoint(route, fraction);
      return { x: map.x + uv.x * map.width, y: map.y + uv.y * map.height };
    };
    const path = (from: number, to: number) => {
      ctx!.beginPath();
      for (let i = 0; i <= 64; i++) { const p = point(from + (to - from) * i / 64); if (i === 0) ctx!.moveTo(p.x, p.y); else ctx!.lineTo(p.x, p.y); }
    };
    const opacity = ctx!.globalAlpha;
    ctx!.save(); ctx!.strokeStyle = color; ctx!.fillStyle = color; ctx!.lineWidth = routeWidth * width / 1600;
    ctx!.globalAlpha = opacity * .38; path(0, reveal); ctx!.stroke();
    const head = options.reducedMotion ? reveal : Math.min(reveal, (Math.max(0, age - index * .045) * (route.speed ?? .35)) % 1);
    const trail = route.trail ?? .15;
    if (trail > 0) { ctx!.globalAlpha = opacity * .95; path(Math.max(0, head - trail), head); ctx!.stroke(); }
    const p = point(head); ctx!.globalAlpha = opacity; ctx!.shadowBlur = 12; ctx!.shadowColor = color;
    ctx!.beginPath(); ctx!.arc(p.x, p.y, 3 * width / 1600, 0, Math.PI * 2); ctx!.fill();
    ctx!.shadowBlur = 0;
    const end = point(1);
    ctx!.beginPath(); ctx!.arc(end.x, end.y, 3 * width / 1600, 0, Math.PI * 2); ctx!.fill();
    if (route.pulse !== false && !options.reducedMotion) {
      const pulse = (age * .6 + index * .13) % 1;
      ctx!.globalAlpha = opacity * (1 - pulse) * .65; ctx!.beginPath(); ctx!.arc(end.x, end.y, (5 + pulse * 17) * width / 1600, 0, Math.PI * 2); ctx!.stroke();
    }
    if (route.name) { ctx!.globalAlpha = opacity * .9; ctx!.font = `${Math.max(10, 15 * width / 1600)}px system-ui`; ctx!.fillText(route.name, end.x + 8, end.y - 8); }
    ctx!.restore();
  }
  function drawStage(stage: OpeningPackageStage, fraction: number, age: number, opacity: number): void {
    ctx!.save(); ctx!.globalAlpha = opacity; ctx!.fillStyle = stage.backgroundColor ?? '#020813'; ctx!.fillRect(0, 0, width, height);
    const zoom = (stage.zoomFrom ?? 1) + ((stage.zoomTo ?? 1) - (stage.zoomFrom ?? 1)) * fraction;
    const map = { x: (width - width * zoom) / 2 + (stage.panX ?? 0) * width * fraction,
      y: (height - height * zoom) / 2 + (stage.panY ?? 0) * height * fraction, width: width * zoom, height: height * zoom };
    const image = stage.backgroundAssetId ? images.get(stage.backgroundAssetId) : null;
    if (image) {
      const ratio = Math.max(width / image.naturalWidth, height / image.naturalHeight) * zoom;
      const w = image.naturalWidth * ratio, h = image.naturalHeight * ratio;
      ctx!.drawImage(image, (width - w) / 2 + (stage.panX ?? 0) * width * fraction, (height - h) / 2 + (stage.panY ?? 0) * height * fraction, w, h);
    }
    for (const [index, route] of (stage.routes ?? []).entries()) drawRoute({ ...stage.routeStyle, ...route }, age, index, map);
    const logo = stage.logoAssetId ? images.get(stage.logoAssetId) : null;
    if (logo) { const w = width * .11; const h = w * logo.naturalHeight / logo.naturalWidth; ctx!.drawImage(logo, width * .06, height * .06, w, h); }
    ctx!.restore();
  }
  function draw(): void {
    if (!readyState || disposed) return;
    const frame = getPackageTimelineFrame(context.elapsedSeconds, stages, 0);
    const stage = stages[frame.stageIndex];
    if (!stage) return;
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0); ctx!.clearRect(0, 0, width, height);
    let transition = 1;
    let previous = frame.stageIndex - 1;
    while (previous >= 0 && stages[previous].durationSeconds === 0) previous--;
    if (!options.reducedMotion && previous >= 0 && (stage.transitionSeconds ?? .6) > 0) {
      transition = Math.min(1, frame.stageElapsedSeconds / Math.min(stage.durationSeconds, stage.transitionSeconds ?? .6));
      if (transition < 1) drawStage(stages[previous], 1, stages[previous].durationSeconds, 1);
    }
    drawStage(stage, options.reducedMotion ? 1 : frame.stageProgress, frame.stageElapsedSeconds, transition);
    setText(title, stage.title ?? '', stage.textStyle, { x: .07, y: .16, size: 64, color: '#eff8ff' });
    title.style.fontWeight = '700';
    setText(subtitle, stage.subtitle ?? '', stage.subtitleStyle, { x: .07, y: .32, size: 25, color: '#84d7ff' });
    setText(description, stage.description ?? '', { ...stage.subtitleStyle, y: Math.min(.85, (stage.subtitleStyle?.y ?? .32) + .09), fontSize: (stage.subtitleStyle?.fontSize ?? 25) * .72 }, { x: .07, y: .41, size: 18, color: '#c1d8e6' });
    for (const element of [title, subtitle, description]) element.style.opacity = String(transition);
    wrapper.style.opacity = String(context.opacity);
    progress.max = String(context.totalDurationSeconds); progress.value = String(context.elapsedSeconds);
    readout.textContent = `${frame.stageIndex + 1} / ${stages.length} · ${stage.label}`;
    play.textContent = context.isPaused ? '播放' : '暂停';
  }
  function resize(): void {
    const rect = wrapper.getBoundingClientRect();
    width = Math.max(1, Math.min(rect.width, rect.height * 16 / 9)); height = width * 9 / 16; dpr = Math.min(1.5, window.devicePixelRatio || 1);
    Object.assign(artboard.style, { width: `${width}px`, height: `${height}px`, left: `${(rect.width - width) / 2}px`, top: `${(rect.height - height) / 2}px` });
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); draw();
  }
  return {
    ready, renderAt(_seconds, next) { context = next; draw(); }, resize,
    dispose() {
      if (disposed) return; disposed = true;
      for (const cancel of [...cancelImages]) cancel();
      listeners.forEach(remove => remove());
      for (const font of fonts.values()) document.fonts.delete(font);
      for (const image of images.values()) image.src = '';
      images.clear(); fonts.clear(); wrapper.remove(); canvas.width = canvas.height = 1;
    },
  };
}
