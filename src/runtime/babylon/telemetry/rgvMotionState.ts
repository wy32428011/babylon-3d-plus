import type { ModelRuntimeEntry } from '../SceneRuntime';

/** 行走方向沿局部 Z，工位输送方向沿局部 X；速度单位为米/秒。 */
export type RgvMotionChannelState = { direction: 1 | -1 | 0; speed: number };

export type RgvMotionFrame = {
  frameId: number;
  travel: RgvMotionChannelState;
  front: RgvMotionChannelState;
  back: RgvMotionChannelState;
};

type RgvMotionDisplacements = { travel: number; front: number; back: number };
type MotionEntry = {
  runtimeState: ModelRuntimeEntry['rgvTelemetry'];
  baseline: ModelRuntimeEntry['rgvTelemetry']['rootBasePosition'];
  frame: RgvMotionFrame;
};

// 仅保存会话运行态；基准重建后旧帧立即失效，模型卸载后随模型回收。
const motionFrames = new WeakMap<ModelRuntimeEntry, MotionEntry>();

/** 消费者必须校验 frameId，当前帧未运行驱动时不能沿用上一帧方向。 */
export function getRgvMotionFrame(model: ModelRuntimeEntry): RgvMotionFrame | null {
  const entry = motionFrames.get(model);
  return entry && entry.runtimeState === model.rgvTelemetry && entry.baseline === model.rgvTelemetry.rootBasePosition
    ? entry.frame : null;
}

export function clearRgvMotionFrame(model: ModelRuntimeEntry): void {
  motionFrames.delete(model);
}

/** 行走传实际连续位移；工位传已锁定交接速度乘帧间隔，不依赖货物持有状态。 */
export function publishRgvMotionFrame(
  model: ModelRuntimeEntry,
  frameId: number,
  deltaSeconds: number,
  displacements: RgvMotionDisplacements,
): void {
  let frame = getRgvMotionFrame(model);
  if (!frame) {
    frame = { frameId, travel: { direction: 0, speed: 0 }, front: { direction: 0, speed: 0 }, back: { direction: 0, speed: 0 } };
    motionFrames.set(model, { runtimeState: model.rgvTelemetry, baseline: model.rgvTelemetry.rootBasePosition, frame });
  }
  frame.frameId = frameId;
  updateChannel(frame.travel, displacements.travel, deltaSeconds);
  updateChannel(frame.front, displacements.front, deltaSeconds);
  updateChannel(frame.back, displacements.back, deltaSeconds);
}

function updateChannel(channel: RgvMotionChannelState, displacement: number, deltaSeconds: number): void {
  const speed = Math.abs(displacement) / deltaSeconds;
  const active = Number.isFinite(deltaSeconds) && deltaSeconds > 0 && Number.isFinite(speed) && Math.abs(displacement) > 1e-7;
  channel.direction = active ? displacement > 0 ? 1 : -1 : 0;
  channel.speed = active ? speed : 0;
}
