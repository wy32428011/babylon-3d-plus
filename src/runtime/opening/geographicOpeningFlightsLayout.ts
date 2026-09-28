export type FlightWindowOptions = { startTime?: number; endTime?: number; fadeDuration?: number };
export type FlightWindow = { start: number; end: number; fadeIn: number; fadeOut: number };

/** 全球沿用原时窗；国内传入真实停留秒数，收尾淡出包含在该停留之内。 */
export function resolveFlightWindow(options: FlightWindowOptions = {}): FlightWindow {
  const start = Number.isFinite(options.startTime) ? Math.max(0, options.startTime!) : 5;
  const end = Number.isFinite(options.endTime) ? Math.max(start, options.endTime!) : Math.max(start, 9);
  const maxFade = (end - start) / 2;
  const fade = Number.isFinite(options.fadeDuration) ? Math.max(0, options.fadeDuration!) : undefined;
  return { start, end, fadeIn: Math.min(maxFade, fade ?? 0.5), fadeOut: Math.min(maxFade, fade ?? 1) };
}

export function flightWindowOpacity(time: number, window: FlightWindow): number {
  if (!Number.isFinite(time) || time < window.start || time >= window.end || window.end <= window.start) return 0;
  const smooth = (value: number) => { const t = Math.min(1, Math.max(0, value)); return t * t * (3 - 2 * t); };
  return (window.fadeIn > 0 ? smooth((time - window.start) / window.fadeIn) : 1)
    * (window.fadeOut > 0 ? smooth((window.end - time) / window.fadeOut) : 1);
}

export type FlightLabelAnchor = { index: number; anchorX: number; anchorY: number; width: number; height: number };
export type FlightLabelPlacement = FlightLabelAnchor & { x: number; y: number; edgeX: number; edgeY: number };

/** 仅移动文字框，地点锚点始终保留真实投影位置；密集地区用有界候选搜索向外展开。 */
export function layoutFlightLabels(
  anchors: readonly FlightLabelAnchor[],
  options: { originX: number; originY: number; referenceViewHeight: number },
): FlightLabelPlacement[] {
  const height = Number.isFinite(options.referenceViewHeight) && options.referenceViewHeight > 0 ? options.referenceViewHeight : 1;
  const gap = height * 0.055;
  const padding = height * 0.018;
  const placed: FlightLabelPlacement[] = [];
  const valid = anchors.filter(anchor => [anchor.anchorX, anchor.anchorY, anchor.width, anchor.height].every(Number.isFinite) && anchor.width > 0 && anchor.height > 0);
  const nearPoint = (box: FlightLabelPlacement, x: number, y: number, radius: number): boolean => {
    const nearestX = Math.max(box.x - box.width / 2, Math.min(x, box.x + box.width / 2));
    const nearestY = Math.max(box.y - box.height / 2, Math.min(y, box.y + box.height / 2));
    return Math.hypot(nearestX - x, nearestY - y) < radius;
  };
  const fits = (candidate: FlightLabelPlacement): boolean => !placed.some(other => (
    Math.abs(candidate.x - other.x) < (candidate.width + other.width) / 2 + padding
    && Math.abs(candidate.y - other.y) < (candidate.height + other.height) / 2 + padding
  )) && !nearPoint(candidate, options.originX, options.originY, height * 0.145)
    && !valid.some(anchor => nearPoint(candidate, anchor.anchorX, anchor.anchorY, height * 0.041));

  for (const anchor of [...valid].sort((a, b) => b.anchorY - a.anchorY || a.index - b.index)) {
    const side = anchor.anchorX >= options.originX ? 1 : -1;
    const directions = [[side, 0.45], [side, -0.45], [-side, 0.45], [-side, -0.45], [0, 1], [0, -1], [side, 1], [-side, -1]];
    let placement: FlightLabelPlacement | undefined;
    for (let ring = 0; ring < 24 && !placement; ring++) {
      for (const [dx, dy] of directions) {
        const candidate = { ...anchor,
          x: anchor.anchorX + dx * (anchor.width / 2 + gap + ring * height * 0.085),
          y: anchor.anchorY + dy * (anchor.height / 2 + gap + ring * height * 0.085), edgeX: 0, edgeY: 0,
        };
        if (fits(candidate)) { placement = candidate; break; }
      }
    }
    // 极长名称或极端密集输入保留文字，有限地排到现有框右侧，不重叠也不更改地点。
    placement ??= { ...anchor, x: Math.max(anchor.anchorX, ...placed.map(item => item.x + item.width / 2)) + gap + anchor.width / 2,
      y: anchor.anchorY, edgeX: 0, edgeY: 0 };
    placement.edgeX = Math.max(placement.x - placement.width / 2, Math.min(anchor.anchorX, placement.x + placement.width / 2));
    placement.edgeY = Math.max(placement.y - placement.height / 2, Math.min(anchor.anchorY, placement.y + placement.height / 2));
    placed.push(placement);
  }
  return placed.sort((a, b) => a.index - b.index);
}

export function wrapFlightLabel(name: string, columns = 8): string[] {
  const characters = Array.from(name.trim());
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 8;
  const lines: string[] = [];
  for (let index = 0; index < characters.length; index += width) lines.push(characters.slice(index, index + width).join(''));
  return lines.length ? lines : [''];
}
