import type { DeepReadonly, NumericPose, Vec3 } from '../state/types';
import { interpolatePose, multiplyMatrices, poseMatrix } from '../state/pose';
import type { Matrix4 } from '../state/pose';
import { requireState } from '../state/safeJson';
import type { FrozenBounds, FrozenRange } from './manifest';

export const V = {
  zero: (): Vec3 => [0, 0, 0],
  copy: (a: readonly number[]): Vec3 => [a[0], a[1], a[2]],
  add: (a: readonly number[], b: readonly number[]): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: readonly number[], n: number): Vec3 => [a[0] * n, a[1] * n, a[2] * n],
  dot: (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  distance: (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  lerp: (a: readonly number[], b: readonly number[], t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
export function moveNumber(value: number, target: number, step: number): number {
  return Math.abs(target - value) <= step ? target : value + Math.sign(target - value) * step;
}
export function moveVector(value: Vec3, target: Vec3, step: number): Vec3 {
  const distance = V.distance(value, target); return distance <= step || distance <= 1e-12 ? V.copy(target) : V.lerp(value, target, step / distance);
}
export function projectTravel(base: Vec3, axis: Vec3, position: Vec3, range: FrozenRange | null): Vec3 {
  let delta = V.dot(V.sub(position, base), axis);
  if (range) delta = range.min <= range.max ? clamp(delta, range.min, range.max) : (range.min + range.max) / 2;
  return V.add(base, V.scale(axis, delta));
}
export function projectedBounds(bounds: FrozenBounds, axis: Vec3): FrozenRange {
  const center = V.scale(V.add(bounds.min, bounds.max), 0.5), half = V.scale(V.sub(bounds.max, bounds.min), 0.5);
  const middle = V.dot(center, axis), radius = Math.abs(axis[0]) * half[0] + Math.abs(axis[1]) * half[1] + Math.abs(axis[2]) * half[2];
  return { min: middle - radius, max: middle + radius };
}
export function catchUpSpeed(distance: number, speed: number, changedAt: number | null, interval: number | null, now: number): number {
  if (distance <= 1e-6 || changedAt === null || interval === null) return speed;
  const windowMs = clamp(interval, 250, 2000), remainingSeconds = Math.max(0.05, (windowMs - (now - changedAt)) / 1000);
  return Math.min(8, Math.max(speed, distance / remainingSeconds));
}
/** 原 conveyorCargoTravel 的纯数值部分；原模块导入 Babylon Vector3，不能在无渲染 worker 中直接加载。 */
export function conveyorHalfRange(span: number, cargoLength: number): number {
  const safeSpan = Number.isFinite(span) && span > 0 ? span : 1.2;
  return Math.max(safeSpan / 2 - (Number.isFinite(cargoLength) && cargoLength > 0 ? cargoLength : 0) / 2, 0.01);
}
export function perpendicularOffset(up: { center: Vec3; axis: Vec3; span: number }, down: { center: Vec3; axis: Vec3 }, halfRange: number, overhang: number): number | null {
  if (Math.abs(V.dot(up.axis, down.axis)) > 0.3 || Math.abs(up.center[1] - down.center[1]) > 0.5) return null;
  const cross = up.axis[0] * down.axis[2] - up.axis[2] * down.axis[0]; if (Math.abs(cross) < 1e-4) return null;
  const dx = down.center[0] - up.center[0], dz = down.center[2] - up.center[2];
  const upstreamCoordinate = (dx * down.axis[2] - dz * down.axis[0]) / cross;
  const offset = (dx * up.axis[2] - dz * up.axis[0]) / cross;
  return !Number.isFinite(offset) || Math.abs(offset) > halfRange + Math.max(0, overhang) + 1e-3
    || Math.abs(upstreamCoordinate) > up.span / 2 + 0.5 ? null : offset;
}
export function inverseMatrix(m: DeepReadonly<Matrix4>): Matrix4 {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  requireState(Number.isFinite(determinant) && Math.abs(determinant) > 1e-15, 'LOGISTICS_GEOMETRY', '逻辑宿主坐标系不可逆。');
  const s = 1 / determinant;
  const out: Matrix4 = [(e * i - f * h) * s, (f * g - d * i) * s, (d * h - e * g) * s, 0,
    (c * h - b * i) * s, (a * i - c * g) * s, (b * g - a * h) * s, 0,
    (b * f - c * e) * s, (c * d - a * f) * s, (a * e - b * d) * s, 0, 0, 0, 0, 1];
  for (let row = 0; row < 3; row += 1) out[12 + row] = -(out[row] * m[12] + out[4 + row] * m[13] + out[8 + row] * m[14]);
  return out;
}
export function matrixToPose(m: DeepReadonly<Matrix4>): NumericPose {
  let sx = Math.hypot(m[0], m[1], m[2]); const sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
  const determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (determinant < 0) sx = -sx;
  requireState(sx !== 0 && sy !== 0 && sz !== 0, 'LOGISTICS_GEOMETRY', '货物位姿存在零缩放。');
  const a = [m[0] / sx, m[1] / sx, m[2] / sx], b = [m[4] / sy, m[5] / sy, m[6] / sy], c = [m[8] / sz, m[9] / sz, m[10] / sz];
  requireState(Math.abs(V.dot(a, b)) < 1e-6 && Math.abs(V.dot(a, c)) < 1e-6 && Math.abs(V.dot(b, c)) < 1e-6,
    'LOGISTICS_GEOMETRY', '货物逻辑端口须是可分解 TRS，不能把宿主剪切当作姿态；发布器须导出独立正交逻辑端口。');
  const trace = a[0] + b[1] + c[2]; let q: NumericPose['rotation'];
  if (trace > 0) { const s = Math.sqrt(trace + 1) * 2; q = [(b[2] - c[1]) / s, (c[0] - a[2]) / s, (a[1] - b[0]) / s, s / 4]; }
  else if (a[0] > b[1] && a[0] > c[2]) { const s = Math.sqrt(1 + a[0] - b[1] - c[2]) * 2; q = [s / 4, (b[0] + a[1]) / s, (c[0] + a[2]) / s, (b[2] - c[1]) / s]; }
  else if (b[1] > c[2]) { const s = Math.sqrt(1 + b[1] - a[0] - c[2]) * 2; q = [(b[0] + a[1]) / s, s / 4, (c[1] + b[2]) / s, (c[0] - a[2]) / s]; }
  else { const s = Math.sqrt(1 + c[2] - a[0] - b[1]) * 2; q = [(c[0] + a[2]) / s, (c[1] + b[2]) / s, s / 4, (a[1] - b[0]) / s]; }
  const length = Math.hypot(...q);
  return { position: [m[12], m[13], m[14]], rotation: q.map(value => value / length) as NumericPose['rotation'], scale: [sx, sy, sz] };
}
export function relativePose(world: NumericPose, parent: DeepReadonly<Matrix4>): NumericPose {
  return matrixToPose(multiplyMatrices(inverseMatrix(parent), poseMatrix(world)));
}
export function blendPose(from: NumericPose, to: NumericPose, ratio: number): NumericPose { return interpolatePose(from, to, ratio); }
