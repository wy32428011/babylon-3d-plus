import type { ChartMarkerComponent } from '../../editor/model/components';

/** 内置面板只写入文本和受校验的图片，不执行用户输入的 HTML。 */
export function createChartMarkerContent(host: HTMLElement) {
  const panel = document.createElement('div');
  panel.dataset.chartMarkerBuiltin = '';
  panel.style.cssText = 'position:absolute;inset:0;overflow:hidden;display:grid;place-items:center;color:white;font-family:Microsoft YaHei,sans-serif;text-align:center';
  const backdrop = document.createElement('div');
  backdrop.style.cssText = 'position:absolute;inset:0;background-size:100% 100%;background-position:center;background-repeat:no-repeat;pointer-events:none';
  const ring = document.createElement('div');
  ring.style.cssText = 'position:absolute;left:15%;right:15%;height:24%;bottom:10%;border:2px solid;border-radius:50%;pointer-events:none';
  const text = document.createElement('span');
  text.dataset.chartMarkerText = '';
  text.style.cssText = 'position:relative;max-width:100%;overflow-wrap:anywhere;padding:8px;box-sizing:border-box;text-shadow:0 2px 8px #00131f';
  panel.append(backdrop, ring, text);
  host.append(panel);
  let previous: Required<ChartMarkerComponent> | undefined;
  let previousText: string | undefined;
  let animation: Animation | undefined;
  let textureContent: ReturnType<typeof createTransparentChartMarkerTexture> | undefined;
  return {
    update(style: Required<ChartMarkerComponent>, value: string) {
      if (style !== previous) {
        const transparent = style.backgroundColor === 'transparent';
        backdrop.style.backgroundColor = transparent ? 'transparent' : style.backgroundImage ? style.backgroundColor : '#061b2b';
        backdrop.style.backgroundImage = style.backgroundImage
          ? `url("${style.backgroundImage}")`
          : transparent ? 'none' : `radial-gradient(ellipse at 50% 78%, ${style.backgroundColor}aa 0%, ${style.backgroundColor}33 35%, transparent 66%), linear-gradient(0deg, ${style.backgroundColor}44, transparent 78%)`;
        ring.style.display = style.backgroundImage || transparent ? 'none' : 'block';
        ring.style.color = style.backgroundColor;
        ring.style.boxShadow = `0 0 16px ${style.backgroundColor}, inset 0 0 18px ${style.backgroundColor}77`;
        text.style.fontSize = `${style.fontSize}px`;
        text.style.whiteSpace = style.marquee ? 'nowrap' : 'pre-wrap';
        text.style.maxWidth = style.marquee ? 'none' : '100%';
        panel.style.boxShadow = style.appearance === 'none' ? 'none' : `inset 0 0 0 ${style.appearance === 'column' ? 4 : 2}px ${style.appearanceColor}`;
      }
      if (previousText !== value) text.textContent = value;
      if (previous?.marquee !== style.marquee || previous?.fontSize !== style.fontSize || previous?.width !== style.width) {
        animation?.cancel();
        animation = style.marquee ? text.animate([
          { transform: `translateX(${style.width}px)` }, { transform: 'translateX(calc(-100% - 16px))' },
        ], { duration: Math.max(6000, value.length * style.fontSize * 60), iterations: Infinity, easing: 'linear' }) : undefined;
      }
      previous = style;
      previousText = value;
    },
    textureFrame() {
      if (!previous) return undefined;
      textureContent ??= createTransparentChartMarkerTexture();
      return textureContent.update(previous, previousText ?? '');
    },
    dispose() { animation?.cancel(); textureContent?.dispose(); panel.remove(); },
  };
}


export type ChartMarkerTextureFrame = { canvas: HTMLCanvasElement; revision: number };

/** 无色内置内容绘为透明纹理，让场景自身完成逐像素混合；无需复制或重绘场景。 */
function createTransparentChartMarkerTexture() {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const frame: ChartMarkerTextureFrame = { canvas, revision: 0 };
  let previous: Required<ChartMarkerComponent> | undefined;
  let previousValue = '';
  let image: HTMLImageElement | undefined;
  let imageUrl = '';
  let dirty = true;
  let animationStart = 0;
  let lastAnimationFrame = -1;
  let lines: string[] = [];
  let textWidth = 0;
  return {
    update(style: Required<ChartMarkerComponent>, value: string): ChartMarkerTextureFrame {
      const now = performance.now();
      if (style !== previous || value !== previousValue) {
        dirty = true;
        if (previous?.marquee !== style.marquee || previous?.fontSize !== style.fontSize || previous?.width !== style.width) animationStart = now;
        if (canvas.width !== style.width || canvas.height !== style.height) {
          canvas.width = style.width;
          canvas.height = style.height;
        }
        context.font = `${style.fontSize}px "Microsoft YaHei", sans-serif`;
        textWidth = context.measureText(value).width;
        lines = [];
        for (const paragraph of value.split('\n')) {
          let line = '';
          for (const character of paragraph) {
            if (line && context.measureText(line + character).width > style.width - 16) { lines.push(line); line = ''; }
            line += character;
          }
          lines.push(line);
        }
        previous = style;
        previousValue = value;
      }
      if (imageUrl !== style.backgroundImage) {
        if (image) { image.onload = null; image.onerror = null; }
        imageUrl = style.backgroundImage;
        image = imageUrl ? new Image() : undefined;
        if (image) {
          image.onload = () => { dirty = true; };
          image.onerror = () => { dirty = true; console.warn('图表立标背景图片解码失败'); };
          image.src = imageUrl;
        }
        dirty = true;
      }
      // 静态内容只在变更时上传；跑马灯最多每秒 30 帧，避免多个立标无界上传纹理。
      const animationFrame = Math.floor((now - animationStart) / (1000 / 30));
      if (!dirty && (!style.marquee || animationFrame === lastAnimationFrame)) return frame;
      lastAnimationFrame = animationFrame;
      dirty = false;
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (image?.complete && image.naturalWidth > 0) context.drawImage(image, 0, 0, canvas.width, canvas.height);
      context.save();
      context.font = `${style.fontSize}px "Microsoft YaHei", sans-serif`;
      context.fillStyle = '#ffffff';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.shadowColor = '#00131f';
      context.shadowBlur = 8;
      context.shadowOffsetY = 2;
      if (style.marquee) {
        const duration = Math.max(6000, value.length * style.fontSize * 60);
        const progress = ((now - animationStart) % duration) / duration;
        context.fillText(value.replace(/\n/g, ' '), style.width / 2 + style.width - progress * (style.width + textWidth + 32), style.height / 2);
      } else {
        const lineHeight = style.fontSize * 1.2;
        lines.forEach((line, index) => context.fillText(line, style.width / 2, style.height / 2 + (index - (lines.length - 1) / 2) * lineHeight));
      }
      context.restore();
      if (style.appearance !== 'none') {
        const width = style.appearance === 'column' ? 4 : 2;
        context.strokeStyle = style.appearanceColor;
        context.lineWidth = width;
        context.strokeRect(width / 2, width / 2, style.width - width, style.height - width);
      }
      frame.revision++;
      return frame;
    },
    dispose() {
      if (image) { image.onload = null; image.onerror = null; }
      canvas.width = canvas.height = 0;
    },
  };
}
