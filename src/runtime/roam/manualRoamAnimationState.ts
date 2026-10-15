export const MANUAL_ROAM_CLIPS = ['Idle', 'WalkForward', 'WalkBackward', 'WalkLeft', 'WalkRight', 'RunForward', 'RunBackward', 'RunLeft', 'RunRight', 'JumpStart', 'JumpUp', 'Fall', 'Land', 'FlyIdle', 'FlyMove'] as const;
export const MANUAL_ROAM_TURN_CLIPS = ['TurnLeft90','TurnRight90','TurnLeft180','TurnRight180'] as const;
export type ManualRoamClip = typeof MANUAL_ROAM_CLIPS[number] | typeof MANUAL_ROAM_TURN_CLIPS[number];
export type ManualRoamAnimationFrame = {
  deltaSeconds: number;
  velocityX: number;
  velocityZ: number;
  yaw: number;
  verticalVelocity: number;
  grounded: boolean;
  jumped: boolean;
  fly: boolean;
  sprint: boolean;
  walkSpeed: number;
  worldScale: number;
  turn?: { clip: typeof MANUAL_ROAM_TURN_CLIPS[number]; progress: number; weight: number };
};
export type ManualRoamAnimationState = {
  kind: 'ground' | 'JumpStart' | 'JumpUp' | 'Fall' | 'Land' | 'FlyIdle' | 'FlyMove';
  elapsed: number;
  phase: number;
  strideScale: number;
  grounded: boolean;
  flying: boolean;
  weights: Partial<Record<ManualRoamClip, number>>;
};
export type ManualRoamGaitTiming = { walkSpeed: number; runSpeed: number; walkDuration: number; runDuration: number; jumpStartDuration: number; landDuration: number; clipCycleDistances?: Partial<Record<ManualRoamClip, number>>; enableStrideWarp?: boolean };
/** 源动作步长偏短；允许把步幅放大到该上限以降低默认速度下的步频，腿够不到时由足部IK缩步。 */
export const MANUAL_ROAM_MAX_STRIDE_SCALE = 1.3;
export const DEFAULT_MANUAL_ROAM_GAIT_TIMING: ManualRoamGaitTiming = { walkSpeed: 1.6, runSpeed: 3.2, walkDuration: 1, runDuration: 1, jumpStartDuration: 0.15, landDuration: 0.2 };

export function createManualRoamAnimationState(): ManualRoamAnimationState {
  return { kind: 'ground', elapsed: 0, phase: 0, strideScale: 1, grounded: true, flying: false, weights: { Idle: 1 } };
}

/** 只消费碰撞后的运动结果，人物动画不参与碰撞体位移与朝向计算。 */
export function stepManualRoamAnimationState(previous: ManualRoamAnimationState, frame: ManualRoamAnimationFrame, timing: ManualRoamGaitTiming = DEFAULT_MANUAL_ROAM_GAIT_TIMING): ManualRoamAnimationState {
  const delta = Math.min(0.1, Math.max(0, finite(frame.deltaSeconds)));
  const velocityX = finite(frame.velocityX);
  const velocityZ = finite(frame.velocityZ);
  const speed = Math.hypot(velocityX, velocityZ);
  let kind: ManualRoamAnimationState['kind'] = 'ground';
  if (frame.fly) kind = Math.hypot(speed, finite(frame.verticalVelocity)) > 0.03 ? 'FlyMove' : 'FlyIdle';
  else if (!frame.grounded) {
    // 物理在按键当帧离地；起跳片段只承担短促发力，不能占满上升阶段或拖延下降状态。
    if (finite(frame.verticalVelocity) <= 0.15) kind = 'Fall';
    else if (frame.jumped || (previous.kind === 'JumpStart' && previous.elapsed + delta < Math.min(timing.jumpStartDuration, 0.10))) kind = 'JumpStart';
    else kind = 'JumpUp';
  } else if (speed <= 0.03 && !frame.jumped && ((!previous.grounded && !previous.flying) || (previous.kind === 'Land' && previous.elapsed < timing.landDuration))) kind = 'Land';
  const elapsed = previous.kind === kind ? previous.elapsed + delta : 0;
  const weights: ManualRoamAnimationState['weights'] = {};
  let phase = previous.phase;
  let gaitFrequency=0,strideTarget=1;
  if (kind !== 'ground') weights[kind] = 1;
  else if (speed <= 0.03) weights.Idle = 1;
  else {
    const yaw = finite(frame.yaw);
    const forward = velocityX * Math.sin(yaw) + velocityZ * Math.cos(yaw);
    const right = velocityX * Math.cos(yaw) - velocityZ * Math.sin(yaw);
    const total = Math.abs(forward) + Math.abs(right);
    const run = frame.sprint && speed > Math.max(0.1, finite(frame.walkSpeed)) * 1.1;
    const prefix = run ? 'Run' : 'Walk';
    if (Math.abs(forward) > 1e-6) weights[`${prefix}${forward > 0 ? 'Forward' : 'Backward'}`] = Math.abs(forward) / total;
    if (Math.abs(right) > 1e-6) weights[`${prefix}${right > 0 ? 'Right' : 'Left'}`] = Math.abs(right) / total;
    const scale = Math.max(0.01, finite(frame.worldScale, 1));
    const fallback = run ? timing.runSpeed * timing.runDuration : timing.walkSpeed * timing.walkDuration;
    const reference = Object.entries(weights).reduce((sum,[clip,weight])=>sum+(weight??0)*(timing.clipCycleDistances?.[clip as ManualRoamClip]??fallback),0);
    gaitFrequency=speed/scale/Math.max(.01,reference);
    if(timing.enableStrideWarp)strideTarget=Math.max(1,Math.min(MANUAL_ROAM_MAX_STRIDE_SCALE,gaitFrequency*(run?timing.runDuration:timing.walkDuration)));
  }
  const strideScale=timing.enableStrideWarp?smoothStride(Math.max(1,Math.min(MANUAL_ROAM_MAX_STRIDE_SCALE,finite(previous.strideScale,1))),strideTarget,delta):1;
  // 本帧足部目标使用同一strideScale；世界距离=相位增量×标定周期距离×步幅×人物缩放。
  phase=(phase+delta*Math.min(4,gaitFrequency/strideScale))%1;
  return { kind, elapsed, phase, strideScale, grounded: frame.grounded, flying: frame.fly, weights };
}

/** 对恒定目标精确积分限速一阶响应，避免30/60/120FPS得到不同步幅。 */
function smoothStride(current:number,target:number,dt:number):number {
  const response=8,maxRate=.6,difference=target-current,sign=Math.sign(difference),distance=Math.abs(difference),threshold=maxRate/response;
  const linearTime=Math.max(0,(distance-threshold)/maxRate);
  if(dt<=linearTime)return current+sign*maxRate*dt;
  const remaining=Math.min(distance,threshold)*Math.exp(-response*(dt-linearTime));
  return target-sign*remaining;
}

function finite(value: number, fallback = 0): number { return Number.isFinite(value) ? value : fallback; }
