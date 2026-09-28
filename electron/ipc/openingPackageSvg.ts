const TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'use', 'title', 'desc']);
const ATTRIBUTES = new Set(['id', 'xmlns', 'xmlns:xlink', 'viewbox', 'preserveaspectratio', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'd', 'points', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'transform', 'gradienttransform', 'gradientunits', 'spreadmethod', 'offset', 'stop-color', 'stop-opacity', 'clip-path', 'clippathunits', 'mask', 'maskunits', 'maskcontentunits', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'dx', 'dy', 'letter-spacing', 'href', 'xlink:href', 'version']);

/** 保守的静态 SVG 子集：无 CSS、事件、动画、实体、外链或可执行节点。运行时仍只作图片解码。 */
export function assertStaticOpeningSvg(source: string): void {
  const invalid = () => { throw new Error('开场包 SVG 仅支持静态矢量图形，不允许脚本、样式、外链或活动内容。'); };
  let svg = source.replace(/^\uFEFF?\s*<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>/i, '');
  svg = svg.replace(/<!--[\s\S]*?-->/g, '');
  if (/<!|<\?/.test(svg)) invalid();
  const tokens = svg.match(/<[^<>]*>|[^<]+/g) ?? [];
  if (tokens.join('') !== svg) invalid();
  const stack: string[] = []; let roots = 0;
  for (const token of tokens) {
    if (!token.startsWith('<')) { if (!stack.length && token.trim()) invalid(); if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(token)) invalid(); continue; }
    const closing = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>$/.exec(token);
    if (closing) { if (stack.pop() !== closing[1]) invalid(); continue; }
    const element = /^<([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/?)>$/.exec(token);
    if (!element || !TAGS.has(element[1].toLowerCase())) { invalid(); continue; }
    const [, tag, rawAttributes, selfClosing] = element;
    if (!stack.length) { if (tag !== 'svg' || ++roots > 1) invalid(); }
    const used = new Set<string>(); let attributes = rawAttributes;
    while (attributes.trim()) {
      const attribute = /^\s+([A-Za-z][A-Za-z0-9:-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/.exec(attributes);
      if (!attribute) { invalid(); break; }
      const name = attribute[1].toLowerCase(), value = attribute[2] ?? attribute[3];
      if (!ATTRIBUTES.has(name) || used.has(name) || /[&\\\u0000-\u001f\u007f]/.test(value)) invalid();
      used.add(name);
      if (name === 'xmlns' && value !== 'http://www.w3.org/2000/svg') invalid();
      if (name === 'xmlns:xlink' && value !== 'http://www.w3.org/1999/xlink') invalid();
      if (['href', 'xlink:href'].includes(name) && !/^#[A-Za-z_][\w.-]*$/.test(value)) invalid();
      if (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z_][\w.-]*\)$/.test(value)) invalid();
      if (name !== 'xmlns' && name !== 'xmlns:xlink' && /(?:https?:|data:|javascript:|file:|\/\/)/i.test(value)) invalid();
      attributes = attributes.slice(attribute[0].length);
    }
    if (!selfClosing) stack.push(tag);
  }
  if (stack.length || roots !== 1) invalid();
}
