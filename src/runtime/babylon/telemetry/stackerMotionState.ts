import type { ModelRuntimeEntry } from '../SceneRuntime';

/** 方向沿堆垛机运行轴，速度为本帧实际位移的绝对值（米/秒）。 */
export type StackerMotionChannelState = {
  direction: 1 | -1 | 0;
  speed: number;
};

export type StackerMotionFrame = {
  frameId: number;
  travel: StackerMotionChannelState;
  lift: StackerMotionChannelState;
  frontFork: StackerMotionChannelState;
  backFork: StackerMotionChannelState;
};

type StackerMotionDisplacements = {
  travel: number;
  lift: number;
  frontFork: number;
  backFork: number;
};

// 只保存运行态，模型卸载后随模型一起回收；不写入场景、遥测或脚本元数据。
const motionFrames = new WeakMap<ModelRuntimeEntry, StackerMotionFrame>();

/** 返回最近一次实际驱动结果；消费者必须校验 frameId，未执行的帧不能沿用运动状态。 */
export function getStackerMotionFrame(model: ModelRuntimeEntry): StackerMotionFrame | null {
  return motionFrames.get(model) ?? null;
}

/** 发布已排除吸附与基准校正的四路位移，原地复用状态，避免每帧创建通道对象。 */
export function publishStackerMotionFrame(
  model: ModelRuntimeEntry,
  frameId: number,
  deltaSeconds: number,
  displacements: StackerMotionDisplacements,
): void {
  let frame = motionFrames.get(model);
  if (!frame) {
    frame = {
      frameId,
      travel: { direction: 0, speed: 0 },
      lift: { direction: 0, speed: 0 },
      frontFork: { direction: 0, speed: 0 },
      backFork: { direction: 0, speed: 0 },
    };
    motionFrames.set(model, frame);
  }
  frame.frameId = frameId;
  updateChannel(frame.travel, displacements.travel, deltaSeconds);
  updateChannel(frame.lift, displacements.lift, deltaSeconds);
  updateChannel(frame.frontFork, displacements.frontFork, deltaSeconds);
  updateChannel(frame.backFork, displacements.backFork, deltaSeconds);
}

function updateChannel(state: StackerMotionChannelState, displacement: number, deltaSeconds: number): void {
  const speed = Math.abs(displacement) / deltaSeconds;
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0 || !Number.isFinite(speed) || Math.abs(displacement) <= 1e-7) {
    state.direction = 0;
    state.speed = 0;
    return;
  }
  state.direction = displacement > 0 ? 1 : -1;
  state.speed = speed;
}
