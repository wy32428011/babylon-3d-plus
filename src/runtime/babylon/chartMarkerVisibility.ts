export type ProjectedScreenPoint = { x: number; y: number; depth: number };
type Point = { x: number; y: number };
type Polygon = Point[];
type Bounds = { left: number; top: number; right: number; bottom: number };
type ProjectedScreen = {
  index: number;
  polygon: Polygon;
  bounds: Bounds;
  depthAt: (point: Point) => number;
};

const COORDINATE_EPSILON = 1e-7;
const AREA_EPSILON = 1e-7;
const DEPTH_EPSILON = 1e-9;

function signedArea(polygon: readonly Point[]): number {
  if (polygon.length < 3) return 0;
  const origin = polygon[0];
  let twiceArea = 0;
  for (let i = 1; i < polygon.length - 1; i++) {
    const a = polygon[i], b = polygon[i + 1];
    twiceArea += (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  }
  return twiceArea / 2;
}

function cleanPolygon(points: readonly Point[]): Polygon {
  const polygon: Polygon = [];
  for (const point of points) {
    const previous = polygon[polygon.length - 1];
    if (!previous || Math.abs(previous.x - point.x) > COORDINATE_EPSILON || Math.abs(previous.y - point.y) > COORDINATE_EPSILON) {
      polygon.push({ x: point.x, y: point.y });
    }
  }
  if (polygon.length > 1) {
    const first = polygon[0], last = polygon[polygon.length - 1];
    if (Math.abs(first.x - last.x) <= COORDINATE_EPSILON && Math.abs(first.y - last.y) <= COORDINATE_EPSILON) polygon.pop();
  }
  return Math.abs(signedArea(polygon)) > AREA_EPSILON ? polygon : [];
}

/** 保留线性距离非负的一侧；插值交点，不以采样网格近似遮挡边界。 */
function clipHalfPlane(polygon: readonly Point[], distance: (point: Point) => number): Polygon {
  if (!polygon.length) return [];
  const output: Polygon = [];
  let previous = polygon[polygon.length - 1];
  let previousDistance = distance(previous);
  for (const point of polygon) {
    const currentDistance = distance(point);
    if ((currentDistance >= 0) !== (previousDistance >= 0)) {
      const fraction = previousDistance / (previousDistance - currentDistance);
      output.push({
        x: previous.x + (point.x - previous.x) * fraction,
        y: previous.y + (point.y - previous.y) * fraction,
      });
    }
    if (currentDistance >= 0) output.push(point);
    previous = point;
    previousDistance = currentDistance;
  }
  return cleanPolygon(output);
}

/** 求两个屏幕凸多边形的交集，统一输出正向绕序以便合并 Canvas 裁剪路径。 */
export function intersectScreenPolygons(
  polygon: readonly { x: number; y: number }[],
  clip: readonly { x: number; y: number }[],
): { x: number; y: number }[] {
  if ([polygon, clip].some(points => points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y)))) return [];
  let intersection = cleanPolygon(polygon);
  const boundary = cleanPolygon(clip);
  if (!intersection.length || !boundary.length) return [];
  if (signedArea(intersection) < 0) intersection.reverse();
  if (signedArea(boundary) < 0) boundary.reverse();
  for (let i = 0; i < boundary.length && intersection.length; i++) {
    const a = boundary[i], b = boundary[(i + 1) % boundary.length];
    intersection = clipHalfPlane(intersection, point => (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x));
  }
  return intersection;
}

function getBounds(polygon: readonly Point[]): Bounds {
  return {
    left: Math.min(...polygon.map(point => point.x)),
    top: Math.min(...polygon.map(point => point.y)),
    right: Math.max(...polygon.map(point => point.x)),
    bottom: Math.max(...polygon.map(point => point.y)),
  };
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function prepareScreen(corners: readonly ProjectedScreenPoint[], index: number): ProjectedScreen | null {
  if (corners.length < 3 || corners.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.depth))) return null;
  const polygon = cleanPolygon(corners);
  if (!polygon.length) return null;
  if (signedArea(polygon) < 0) polygon.reverse();

  // 使用面积最大的三角形求屏幕深度平面，避免近共线顶点放大浮点误差。
  const origin = corners[0];
  let determinant = 0;
  let first = corners[1], second = corners[2];
  for (let i = 1; i < corners.length - 1; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      const a = corners[i], b = corners[j];
      const candidate = (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
      if (Math.abs(candidate) > Math.abs(determinant)) {
        determinant = candidate;
        first = a;
        second = b;
      }
    }
  }
  if (Math.abs(determinant) <= AREA_EPSILON) return null;
  const firstDepth = first.depth - origin.depth, secondDepth = second.depth - origin.depth;
  const slopeX = (firstDepth * (second.y - origin.y) - secondDepth * (first.y - origin.y)) / determinant;
  const slopeY = ((first.x - origin.x) * secondDepth - (second.x - origin.x) * firstDepth) / determinant;
  const depthAt = (point: Point): number => origin.depth + slopeX * (point.x - origin.x) + slopeY * (point.y - origin.y);
  return { index, polygon, bounds: getBounds(polygon), depthAt };
}

/** 每条遮挡边切出一个外侧片段，余下交集继续处理，输出片段的内部互不重叠。 */
function subtractConvexPolygon(polygon: Polygon, occluder: readonly Point[]): Polygon[] {
  const fragments: Polygon[] = [];
  let remaining = polygon;
  for (let i = 0; i < occluder.length && remaining.length; i++) {
    const a = occluder[i], b = occluder[(i + 1) % occluder.length];
    const distance = (point: Point): number => (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    const outside = clipHalfPlane(remaining, point => -distance(point));
    if (outside.length) fragments.push(outside);
    remaining = clipHalfPlane(remaining, distance);
  }
  return fragments;
}

/**
 * 按各像素的 NDC 深度扣除前方立标，返回可用于 CSS 裁切的屏幕坐标凸多边形。
 * 深度值越小越近；共面的重叠区由输入中较后的立标拥有，保证稳定且没有双重交互。
 */
export function getVisibleChartMarkerPolygons(
  screens: readonly { id: string; corners: readonly ProjectedScreenPoint[] }[],
): Map<string, Array<Array<{ x: number; y: number }>>> {
  const prepared = screens.map((screen, index) => prepareScreen(screen.corners, index));
  const visible = new Map<string, Polygon[]>();
  for (let index = 0; index < screens.length; index++) {
    const target = prepared[index];
    let fragments: Polygon[] = target ? [target.polygon] : [];
    if (target) {
      for (const other of prepared) {
        if (!fragments.length) break;
        if (!other || other.index === index || !overlaps(target.bounds, other.bounds)) continue;
        const depthDifference = (point: Point): number => target.depthAt(point) - other.depthAt(point);
        const coplanar = target.polygon.every(point => Math.abs(depthDifference(point)) <= DEPTH_EPSILON);
        if (coplanar && other.index < index) continue;
        const occluder = coplanar ? other.polygon : clipHalfPlane(other.polygon, depthDifference);
        if (!occluder.length) continue;
        const occluderBounds = getBounds(occluder);
        fragments = fragments.flatMap(fragment => overlaps(getBounds(fragment), occluderBounds)
          ? subtractConvexPolygon(fragment, occluder)
          : [fragment]);
      }
    }
    visible.set(screens[index].id, fragments);
  }
  return visible;
}
