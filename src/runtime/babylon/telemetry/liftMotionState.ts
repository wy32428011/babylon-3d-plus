import type { ModelRuntimeEntry } from '../SceneRuntime';

export type LiftMotionAxis = { x: number; y: number; z: number };

/** 升降沿模型 Y，台面输送沿 axis 世界水平单位向量；速度单位为米/秒。 */
export type LiftMotionChannelState = { direction: 1 | -1 | 0; speed: number; axis?: LiftMotionAxis };

export type LiftMotionFrame = {
  frameId: number;
  lift: LiftMotionChannelState;
  front: LiftMotionChannelState;
  back: LiftMotionChannelState;
};

type LiftMotionDisplacements = { lift: number; front: number; back: number; axis?: LiftMotionAxis | null };
type MotionEntry = {
  liftState: ModelRuntimeEntry['liftTelemetry'];
  liftBaseline: ModelRuntimeEntry['liftTelemetry']['rootBasePosition'] | undefined;
  hcliftState: ModelRuntimeEntry['hcliftTelemetry'];
  hcliftBaseline: ModelRuntimeEntry['hcliftTelemetry']['rootBasePosition'] | undefined;
  frame: LiftMotionFrame;
};

// 只存会话运行态；真实预览重置会替换基准，即使原地复用遥测对象也须立即废弃旧帧。
const motionFrames = new WeakMap<ModelRuntimeEntry, MotionEntry>();

/** 消费者必须校验 frameId，当前帧未运行驱动时不能沿用上一帧方向。 */
export function getLiftMotionFrame(model: ModelRuntimeEntry): LiftMotionFrame | null {
  const entry = motionFrames.get(model);
  return entry && entry.liftState === model.liftTelemetry && entry.liftBaseline === model.liftTelemetry?.rootBasePosition
    && entry.hcliftState === model.hcliftTelemetry && entry.hcliftBaseline === model.hcliftTelemetry?.rootBasePosition
    ? entry.frame : null;
}

export function clearLiftMotionFrame(model: ModelRuntimeEntry): void {
  motionFrames.delete(model);
}

/** 发布排除吸附、补齐与约束校正的真实位移，复用通道对象避免每帧分配。 */
export function publishLiftMotionFrame(
  model: ModelRuntimeEntry,
  frameId: number,
  deltaSeconds: number,
  displacements: LiftMotionDisplacements,
): void {
  let frame = getLiftMotionFrame(model);
  if (!frame) {
    frame = { frameId, lift: { direction: 0, speed: 0 }, front: { direction: 0, speed: 0 }, back: { direction: 0, speed: 0 } };
    motionFrames.set(model, {
      liftState: model.liftTelemetry, liftBaseline: model.liftTelemetry?.rootBasePosition,
      hcliftState: model.hcliftTelemetry, hcliftBaseline: model.hcliftTelemetry?.rootBasePosition, frame,
    });
  }
  frame.frameId = frameId;
  updateChannel(frame.lift, displacements.lift, deltaSeconds);
  updateChannel(frame.front, displacements.front, deltaSeconds);
  updateChannel(frame.back, displacements.back, deltaSeconds);
  updateAxis(frame.front, displacements.axis);
  updateAxis(frame.back, displacements.axis);
}

function updateChannel(channel: LiftMotionChannelState, displacement: number, deltaSeconds: number): void {
  const speed = Math.abs(displacement) / deltaSeconds;
  const active = Number.isFinite(deltaSeconds) && deltaSeconds > 0 && Number.isFinite(speed) && Math.abs(displacement) > 1e-7;
  channel.direction = active ? displacement > 0 ? 1 : -1 : 0;
  channel.speed = active ? speed : 0;
}

function updateAxis(channel: LiftMotionChannelState, axis: LiftMotionAxis | null | undefined): void {
  if (!axis || !Number.isFinite(axis.x) || !Number.isFinite(axis.y) || !Number.isFinite(axis.z)) {
    delete channel.axis;
    return;
  }
  channel.axis ??= { x: 0, y: 0, z: 0 };
  channel.axis.x = axis.x;
  channel.axis.y = axis.y;
  channel.axis.z = axis.z;
}
