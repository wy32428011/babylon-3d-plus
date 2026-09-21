import type { LightWallFenceConfig, LightWallFencePoint } from './components';

export const LIGHT_WALL_HEIGHT_MIN = 0.1;
export const LIGHT_WALL_HEIGHT_MAX = 1000;
export const LIGHT_WALL_MAX_POINTS = 128;
const COORDINATE_LIMIT = 100000;
const MIN_EDGE_LENGTH = 0.001;

export function createDefaultLightWallFence(): LightWallFenceConfig {
  return { height: 3, opacity: 0.75, points: [
    { x: -5, z: -4 }, { x: 5, z: -4 }, { x: 5, z: 4 }, { x: -5, z: 4 },
  ] };
}

const cross = (a: LightWallFencePoint, b: LightWallFencePoint, c: LightWallFencePoint) =>
  (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);

function segmentsIntersect(a: LightWallFencePoint, b: LightWallFencePoint, c: LightWallFencePoint, d: LightWallFencePoint): boolean {
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x)
    || Math.max(a.z, b.z) < Math.min(c.z, d.z) || Math.max(c.z, d.z) < Math.min(a.z, b.z)) return false;
  return cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0;
}

/** 轮廓限定为简单闭合多边形，允许凹角；点数有界后再做边相交检查。 */
export function validateLightWallPoints(points: readonly LightWallFencePoint[]): string | null {
  if (!Array.isArray(points) || points.length < 3 || points.length > LIGHT_WALL_MAX_POINTS) return '轮廓需要 3–128 个顶点。';
  if (points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.z)
    || Math.abs(p.x) > COORDINATE_LIMIT || Math.abs(p.z) > COORDINATE_LIMIT)) return '轮廓坐标必须是 ±100000 米内的有限数值。';
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (Math.hypot(b.x - a.x, b.z - a.z) < MIN_EDGE_LENGTH) return '轮廓相邻顶点至少间隔 0.001 米。';
    area += a.x * b.z - b.x * a.z;
    const c = points[(i + 2) % points.length];
    if (cross(a, b, c) === 0 && (b.x - a.x) * (c.x - b.x) + (b.z - a.z) * (c.z - b.z) < 0) return '轮廓边不能折返重叠。';
    for (let j = i + 2; j < points.length; j += 1) {
      if (i === 0 && j === points.length - 1) continue;
      if (segmentsIntersect(a, b, points[j], points[(j + 1) % points.length])) return '轮廓不能自交或重叠。';
    }
  }
  return Math.abs(area) < 0.000001 ? '轮廓顶点不能全部共线。' : null;
}

/** 文本只在用户应用时解析，编辑未完成的坐标不写入场景。 */
export function parseLightWallPoints(text: string): LightWallFencePoint[] {
  const lines = text.trim().split(/\r?\n/).filter(line => line.trim());
  if (lines.length > LIGHT_WALL_MAX_POINTS + 1) throw new Error('轮廓最多支持 128 个顶点。');
  const points = lines.map((line, index) => {
    const values = line.trim().split(/[,，\s]+/);
    if (values.length !== 2 || values.some(value => !value || !Number.isFinite(Number(value)))) throw new Error(`第 ${index + 1} 行坐标格式应为 X, Z。`);
    return { x: Number(values[0]), z: Number(values[1]) };
  });
  const first = points[0], last = points.at(-1);
  if (points.length > 3 && first.x === last?.x && first.z === last.z) points.pop();
  const error = validateLightWallPoints(points);
  if (error) throw new Error(error);
  return points;
}

export function sanitizeLightWallFence(value: LightWallFenceConfig | undefined): LightWallFenceConfig {
  const defaults = createDefaultLightWallFence();
  return {
    height: Number.isFinite(value?.height) ? Math.min(LIGHT_WALL_HEIGHT_MAX, Math.max(LIGHT_WALL_HEIGHT_MIN, value!.height)) : defaults.height,
    opacity: Number.isFinite(value?.opacity) ? Math.min(1, Math.max(0, value!.opacity)) : defaults.opacity,
    points: value?.points && !validateLightWallPoints(value.points) ? value.points.map(p => ({ x: p.x, z: p.z })) : defaults.points,
  };
}
