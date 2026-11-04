import type { DeepReadonly, NumericPose, Quaternion, StateReadView } from './types';
import { compareText, freezeData, requireState, stableKey } from './safeJson';
import { portAnchorId } from './validation';
import { identityPose } from './stateOps';

/** 列主序仿射矩阵，可直接交给渲染适配层；内核不创建 Babylon Matrix/Mesh。 */
export type Matrix4 = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
export type PoseSample = {
  projectionId: string; stateRevision: string; sampledAt: number;
  devices: { id: string; worldMatrix: Matrix4; anchors: { id: string; worldMatrix: Matrix4 }[] }[];
  cargo: { id: string; worldMatrix: Matrix4 }[];
};
export type PoseSelection = { deviceIds?: readonly string[]; cargoIds?: readonly string[] };
export const ROOT_MOTION_CHANNEL = 'root' as const;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
function fraction(time: number, start: number, end: number): number { return end <= start ? 1 : Math.min(1, Math.max(0, (time - start) / (end - start))); }
function slerp(from: DeepReadonly<Quaternion>, to: DeepReadonly<Quaternion>, t: number): Quaternion {
  let dot = from.reduce((sum, value, i) => sum + value * to[i], 0);
  const sign = dot < 0 ? -1 : 1; dot = Math.min(1, Math.abs(dot));
  let left = 1 - t, right = t;
  if (dot < 0.9995) {
    const angle = Math.acos(dot), denominator = Math.sin(angle);
    left = Math.sin((1 - t) * angle) / denominator; right = Math.sin(t * angle) / denominator;
  }
  const result = from.map((value, i) => left * value + right * sign * to[i]) as Quaternion;
  const length = Math.hypot(...result);
  requireState(length > 0 && Number.isFinite(length), 'POSE', '运动四元数不能求值。');
  return result.map(value => value / length) as Quaternion;
}
export function interpolatePose(from: DeepReadonly<NumericPose>, to: DeepReadonly<NumericPose>, t: number): NumericPose {
  const ratio = Math.min(1, Math.max(0, t));
  return { position: from.position.map((value, i) => lerp(value, to.position[i], ratio)) as NumericPose['position'],
    rotation: slerp(from.rotation, to.rotation, ratio), scale: from.scale.map((value, i) => lerp(value, to.scale[i], ratio)) as NumericPose['scale'] };
}
export function poseMatrix(pose: DeepReadonly<NumericPose>): Matrix4 {
  const [x, y, z, w] = pose.rotation, [sx, sy, sz] = pose.scale, [px, py, pz] = pose.position;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [sx * (1 - 2 * (yy + zz)), sx * 2 * (xy + wz), sx * 2 * (xz - wy), 0,
    sy * 2 * (xy - wz), sy * (1 - 2 * (xx + zz)), sy * 2 * (yz + wx), 0,
    sz * 2 * (xz + wy), sz * 2 * (yz - wx), sz * (1 - 2 * (xx + yy)), 0, px, py, pz, 1];
}
export function multiplyMatrices(a: DeepReadonly<Matrix4>, b: DeepReadonly<Matrix4>): Matrix4 {
  const result = Array<number>(16).fill(0) as Matrix4;
  for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) {
    for (let k = 0; k < 4; k += 1) result[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  }
  requireState(result.every(Number.isFinite), 'POSE', '位姿矩阵溢出有限数值范围。'); return result;
}
/** 普通层级保留完整矩阵；仅 handoff 的 quaternion 插值要求目标能够无损分解为 TRS。 */
function matrixPose(matrix: Matrix4): NumericPose {
  let sx = Math.hypot(matrix[0], matrix[1], matrix[2]);
  const sy = Math.hypot(matrix[4], matrix[5], matrix[6]), sz = Math.hypot(matrix[8], matrix[9], matrix[10]);
  const determinant = matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9])
    - matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9]) + matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5]);
  if (determinant < 0) sx = -sx;
  requireState(sx !== 0 && sy !== 0 && sz !== 0, 'POSE', '交接展示目标不可分解。');
  const m00 = matrix[0] / sx, m10 = matrix[1] / sx, m20 = matrix[2] / sx;
  const m01 = matrix[4] / sy, m11 = matrix[5] / sy, m21 = matrix[6] / sy;
  const m02 = matrix[8] / sz, m12 = matrix[9] / sz, m22 = matrix[10] / sz;
  requireState(Math.abs(m00 * m01 + m10 * m11 + m20 * m21) < 1e-6
    && Math.abs(m00 * m02 + m10 * m12 + m20 * m22) < 1e-6
    && Math.abs(m01 * m02 + m11 * m12 + m21 * m22) < 1e-6,
  'UNSUPPORTED_POSE_SHEAR', '带剪切的交接展示不能伪装成 TRS 插值；须由适配器提供可表达的数值轨迹。');
  let rotation: Quaternion;
  const trace = m00 + m11 + m22;
  if (trace > 0) { const s = Math.sqrt(trace + 1) * 2; rotation = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; rotation = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; rotation = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; rotation = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
  const length = Math.hypot(...rotation);
  return { position: [matrix[12], matrix[13], matrix[14]], rotation: rotation.map(value => value / length) as Quaternion, scale: [sx, sy, sz] };
}

/**
 * 只读求值：不执行 reducer、不更新宿主、不触发到站/TTL/Fetch，也不修改逻辑时间。
 * 位姿为 basePose × root 轨迹；挂接设备的 basePose 相对宿主 anchor，anchor.channel 指定部件轨迹。
 * 浮点运算固定为 JS IEEE-754 double，改变展示采样率不会改变任何业务记录。
 */
export function samplePose(view: StateReadView, time: number, selection: PoseSelection = {}): DeepReadonly<PoseSample> {
  requireState(Number.isFinite(time) && time >= view.metadata.logicalTime && time <= 8_640_000_000_000_000,
    'SAMPLE_TIME', '只能从已恢复状态向前采样；更早时刻须先恢复相应检查点及变化。');
  requireState(view.metadata.continuity.status === 'complete', 'CONTINUITY_GAP', '断档状态不能冒充连续的历史展示。');
  for (const timer of view.values('timers')) requireState(time === view.metadata.logicalTime || time < timer.dueAt,
    'SAMPLE_BOUNDARY', '展示采样不能越过尚未应用的业务定时边界。');
  const models = new Map(view.logic.models.map(model => [model.id, model]));
  const slots = new Map(view.logic.slots.map(slot => [slot.id, slot]));
  const motions = new Map([...view.values('motions')].map(motion => [stableKey(motion.deviceId, motion.channel), motion]));
  const deviceCache = new Map<string, Matrix4>(), anchorCache = new Map<string, Matrix4>();
  const visiting = new Set<string>();
  const inHierarchy = (key: string, calculate: () => Matrix4): Matrix4 => {
    requireState(!visiting.has(key) && visiting.size < 256, 'POSE_HIERARCHY', '位姿层级包含环或超过采样深度预算。');
    visiting.add(key);
    try { return calculate(); } finally { visiting.delete(key); }
  };
  const motionMatrix = (deviceId: string, channel: string): Matrix4 => {
    const motion = motions.get(stableKey(deviceId, channel));
    return poseMatrix(motion ? interpolatePose(motion.from, motion.to, fraction(time, motion.startedAt, motion.endsAt)) : identityPose());
  };
  const deviceWorld = (id: string): Matrix4 => {
    const cached = deviceCache.get(id); if (cached) return cached;
    return inHierarchy(stableKey('device', id), () => {
      const device = view.get('devices', id); requireState(device, 'REFERENCE', '采样设备不存在。');
      let matrix = multiplyMatrices(poseMatrix(device.basePose), motionMatrix(id, ROOT_MOTION_CHANNEL));
      if (device.attachment) matrix = multiplyMatrices(multiplyMatrices(anchorWorld(device.attachment.deviceId, device.attachment.anchorId), poseMatrix(device.attachment.offset)), matrix);
      deviceCache.set(id, matrix); return matrix;
    });
  };
  const anchorWorld = (deviceId: string, anchorId: string): Matrix4 => {
    const key = stableKey('anchor', deviceId, anchorId), cached = anchorCache.get(key); if (cached) return cached;
    return inHierarchy(key, () => {
      const device = view.get('devices', deviceId), anchor = device && models.get(device.modelId)?.anchors.find(item => item.id === anchorId);
      requireState(anchor, 'REFERENCE', '采样锚点不存在。');
      const parent = anchor.parentAnchorId === null ? deviceWorld(deviceId) : anchorWorld(deviceId, anchor.parentAnchorId);
      let local = poseMatrix(anchor.localPose);
      if (anchor.channel !== null) local = multiplyMatrices(local, motionMatrix(deviceId, anchor.channel));
      const matrix = multiplyMatrices(parent, local); anchorCache.set(key, matrix); return matrix;
    });
  };
  const deviceIds = selection.deviceIds ?? [...view.values('devices')].map(device => device.id);
  const cargoIds = selection.cargoIds ?? [...view.values('cargo')].filter(cargo => cargo.destroyedAt === null).map(cargo => cargo.id);
  const devices = [...new Set(deviceIds)].sort(compareText).map(id => {
    const device = view.get('devices', id); requireState(device, 'REFERENCE', '所选设备不存在。');
    const model = models.get(device.modelId); requireState(model, 'REFERENCE', '所选设备缺少数值模型。');
    return { id, worldMatrix: deviceWorld(id), anchors: [...model.anchors].sort((a, b) => compareText(a.id, b.id))
      .map(anchor => ({ id: anchor.id, worldMatrix: anchorWorld(id, anchor.id) })) };
  });
  const cargo = [...new Set(cargoIds)].sort(compareText).map(id => {
    const value = view.get('cargo', id); requireState(value?.host && value.destroyedAt === null, 'REFERENCE', '所选货物不存在或已销毁。');
    const host = value.host;
    let parent: Matrix4;
    if (host.kind === 'device') parent = anchorWorld(host.deviceId, portAnchorId(view, host.deviceId, host.portId));
    else if (host.kind === 'slot') { const slot = slots.get(host.slotId); requireState(slot, 'REFERENCE', '货物库位缺失。'); parent = poseMatrix(slot.pose); }
    else { const transfer = view.get('transfers', host.transferId); requireState(transfer, 'REFERENCE', '货物在途交接缺失。'); parent = poseMatrix(transfer.pose); }
    let worldMatrix = multiplyMatrices(parent, poseMatrix(value.localPose));
    if (value.handoff && time < value.handoff.endsAt) worldMatrix = poseMatrix(interpolatePose(value.handoff.fromWorld,
      matrixPose(worldMatrix), fraction(time, value.handoff.startedAt, value.handoff.endsAt)));
    return { id, worldMatrix };
  });
  return freezeData({ projectionId: view.metadata.projectionId, stateRevision: view.metadata.cursor.stateRevision, sampledAt: time, devices, cargo });
}
