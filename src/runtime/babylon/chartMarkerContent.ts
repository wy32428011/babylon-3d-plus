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
  return {
    update(style: Required<ChartMarkerComponent>, value: string) {
      if (style !== previous) {
        backdrop.style.backgroundColor = style.backgroundImage ? style.backgroundColor : '#061b2b';
        backdrop.style.backgroundImage = style.backgroundImage
          ? `url("${style.backgroundImage}")`
          : `radial-gradient(ellipse at 50% 78%, ${style.backgroundColor}aa 0%, ${style.backgroundColor}33 35%, transparent 66%), linear-gradient(0deg, ${style.backgroundColor}44, transparent 78%)`;
        ring.style.display = style.backgroundImage ? 'none' : 'block';
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
    dispose() { animation?.cancel(); panel.remove(); },
  };
}
