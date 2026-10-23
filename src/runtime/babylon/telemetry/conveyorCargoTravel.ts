/**
 * 输送线货箱行程计算：货箱从进入端边缘刷出，偏移量钳制在由输送线实际行程跨度
 * 和货箱长度决定的行程范围内，货箱前沿走到输送线末端即停住，不做回绕循环。
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

/** 行程半径下限，避免跨度数据异常时货箱完全钉死在中心。 */
const MIN_CARGO_TRAVEL_HALF_RANGE_METERS = 0.01;

/** 包围盒不可用时的回退行程跨度（沿用历史 1.2m 窗口）。 */
export const CONVEYOR_CARGO_FALLBACK_SPAN_METERS = 1.2;

/**
 * 计算货箱中心相对输送线中心的最大偏移半径。
 * 货箱前沿到达输送线末端即停住：半径 = 跨度/2 − 货箱长度/2。
 */
export function resolveConveyorCargoTravelHalfRange(spanMeters: number, cargoLengthMeters: number): number {
  if (!Number.isFinite(spanMeters) || spanMeters <= 0) {
    spanMeters = CONVEYOR_CARGO_FALLBACK_SPAN_METERS;
  }
  const safeCargoLength = Number.isFinite(cargoLengthMeters) && cargoLengthMeters > 0 ? cargoLengthMeters : 0;
  return Math.max(spanMeters / 2 - safeCargoLength / 2, MIN_CARGO_TRAVEL_HALF_RANGE_METERS);
}

export type ConveyorCenterLine = {
  /** 输送线中心（世界坐标）。 */
  center: Vector3;
  /** 行走轴（世界坐标，水平单位向量）。 */
  axis: Vector3;
  /** 行走轴方向半跨度；null 表示未知（不校验上游范围）。 */
  halfSpanMeters: number | null;
};

/**
 * 直角相邻输送线的交付落点：求上游/下游两条中心轨迹的交叉点，返回交叉点沿下游轴的偏移（米）。
 * 交叉点允许超出下游正常行程半径至多 overhangMeters（通常为一个货箱轴向长度）：
 * 现场直角接驳处常由第三方设备或短过渡段填充，中心线交叉点会落在下游几何端面之外，
 * 但货物需要从该拐角点开始沿下游轴走行，而不是瞬移到进入端。
 * 非近似直角、近似平行、层高差异过大、交叉点明显偏离上游时返回 null，调用方回退旧的“下游进入端”落点。
 */
export function resolvePerpendicularHandoffOffset(
  upstream: ConveyorCenterLine,
  downstream: ConveyorCenterLine,
  downstreamTravelHalfRangeMeters: number,
  downstreamOverhangMeters = 0,
): number | null {
  const overhang = Number.isFinite(downstreamOverhangMeters) && downstreamOverhangMeters > 0
    ? downstreamOverhangMeters
    : 0;
  const da = upstream.axis;
  const db = downstream.axis;
  if (!Number.isFinite(da.x) || !Number.isFinite(da.z) || !Number.isFinite(db.x) || !Number.isFinite(db.z)) return null;
  // 仅在近似直角时启用；平行/同轴仍走原进入端逻辑
  if (Math.abs(Vector3.Dot(da, db)) > 0.3) return null;
  if (Math.abs(upstream.center.y - downstream.center.y) > 0.5) return null;

  const cross = da.x * db.z - da.z * db.x;
  if (Math.abs(cross) < 1e-4) return null;
  const dx = downstream.center.x - upstream.center.x;
  const dz = downstream.center.z - upstream.center.z;
  const upstreamCoordinate = (dx * db.z - dz * db.x) / cross;
  const downstreamOffset = (dx * da.z - dz * da.x) / cross;

  if (!Number.isFinite(downstreamOffset)
    || Math.abs(downstreamOffset) > downstreamTravelHalfRangeMeters + overhang + 1e-3) {
    return null;
  }
  // 交叉点允许落在上游端面附近（货箱/设备边缘有重叠），明显偏离则不是相邻直角设备
  if (upstream.halfSpanMeters !== null && Math.abs(upstreamCoordinate) > upstream.halfSpanMeters + 0.5) {
    return null;
  }
  return downstreamOffset;
}
