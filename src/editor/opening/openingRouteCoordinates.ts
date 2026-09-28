type Point = { x: number; y: number };
type Rectangle = { left: number; top: number; width: number; height: number };

/** 以底图实际显示区域换算 UV；指针拖出边界时仍落在底图边缘。 */
export function openingUvFromPointer(clientX: number, clientY: number, rectangle: Rectangle): Point | null {
  if (rectangle.width <= 0 || rectangle.height <= 0) return null;
  const clamp = (value: number) => Number(Math.max(0, Math.min(1, value)).toFixed(5));
  return { x: clamp((clientX - rectangle.left) / rectangle.width), y: clamp((clientY - rectangle.top) / rectangle.height) };
}

export function openingRouteCurve(from: Point, to: Point, curvature: number): string {
  const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const control = { x: midpoint.x, y: midpoint.y - Math.hypot(to.x - from.x, to.y - from.y) * curvature };
  return `M ${from.x * 1000} ${from.y * 1000} Q ${control.x * 1000} ${control.y * 1000} ${to.x * 1000} ${to.y * 1000}`;
}
