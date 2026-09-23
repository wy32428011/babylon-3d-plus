import { isConveyorArrowEffectKind } from '../model/conveyorArrowEffect';

const chevron = (x: number, y = 32, scale = 1) => `<path transform="translate(${x} ${y}) scale(${scale})" d="M-8 -15 L9 0 L-8 15 L-1 15 L16 0 L-1 -15 Z"/>`;
const shapes: Record<string, string> = {
  'conveyor-arrow-single': '<path d="M12 27 H112 V15 L143 32 L112 49 V37 H12 Z"/>',
  'conveyor-arrow-chevron': [18, 46, 74, 102, 130].map(x => chevron(x)).join(''),
  'conveyor-arrow-segmented': '<path d="M12 27 H34 V37 H12 Z M43 27 H65 V37 H43 Z M74 27 H96 V37 H74 Z M105 27 H119 V17 L144 32 L119 47 V37 H105 Z"/>',
  'conveyor-arrow-ribbon': '<path d="M12 20 H113 V9 L146 32 L113 55 V44 H12 Z"/><path d="M20 21 L30 43 M35 21 L45 43 M50 21 L60 43 M65 21 L75 43 M80 21 L90 43 M95 21 L105 43" fill="none" opacity=".3"/>',
  'conveyor-arrow-double': [21, 43].map(y => [30, 76, 122].map(x => chevron(x, y, 0.6)).join('')).join(''),
  'conveyor-arrow-speed': '<path d="M112 12 L146 32 L112 52 L123 32 Z"/><path d="M12 23 H99 M29 18 H114 M35 32 H127 M12 39 H102 M38 46 H114" fill="none" stroke-width="2"/>',
};

/** 固定代码生成的预览，不引入纹理资源、网络请求或用户输入。 */
export function getConveyorArrowThumbnail(kind: string): string | undefined {
  if (!isConveyorArrowEffectKind(kind)) return undefined;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="64" viewBox="0 0 160 64"><defs><filter id="glow"><feGaussianBlur stdDeviation="3"/></filter></defs><rect width="160" height="64" rx="6" fill="#061d30"/><g fill="#18dfff" stroke="#a5faff" stroke-width="1">${`<g filter="url(#glow)">${shapes[kind]}</g>`}${shapes[kind]}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
