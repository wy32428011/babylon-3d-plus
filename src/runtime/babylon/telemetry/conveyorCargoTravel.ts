/**
 * 输送线货箱行程计算：货箱从进入端边缘刷出，偏移量钳制在由输送线实际行程跨度
 * 和货箱长度决定的行程范围内，货箱前沿走到输送线末端即停住，不做回绕循环。
 */

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
