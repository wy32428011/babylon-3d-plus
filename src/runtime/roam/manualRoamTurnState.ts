export type ManualRoamTurnClip = 'TurnLeft90' | 'TurnRight90' | 'TurnLeft180' | 'TurnRight180';
export type ManualRoamTurnFrame = {
  deltaSeconds: number;
  controlYaw: number;
  horizontalSpeed: number;
  grounded: boolean;
  fly: boolean;
  /** 巡检行走仅改变视觉朝向；停止后保持最后朝向，站立输入按控制yaw增量转身。 */
  orientToMovement?: boolean;
  movementYaw?: number;
  turnDurations?: Partial<Record<ManualRoamTurnClip, number>>;
  /** 0..1等距采样的累计转角曲线；由动作清单提供，计算本帧进度后直接插值。 */
  turnRotationCurves?: Partial<Record<ManualRoamTurnClip, readonly number[]>>;
};
export type ManualRoamTurnState = {
  visualYaw: number;
  animationYaw: number;
  deltaYaw: number;
  controlYaw: number;
  facingYaw: number;
  turnClip: ManualRoamTurnClip | null;
  turnProgress: number;
  turnWeight: number;
  startYaw: number;
  targetYaw: number;
  elapsed: number;
  duration: number;
  settledSeconds: number;
  rotationCurve: readonly number[] | null;
};

const TURN_THRESHOLD = 40 / 180 * Math.PI;
const TURN_180_THRESHOLD = 135 / 180 * Math.PI;
const MAX_ANGULAR_SPEED = 8;

/** 出生、传送、场景切换时直接创建，不将瞬移角度当作人物转身。 */
export function createManualRoamTurnState(controlYaw: number): ManualRoamTurnState {
  const yaw = finite(controlYaw);
  return { visualYaw: yaw, animationYaw: yaw, controlYaw: yaw, facingYaw:yaw, deltaYaw: 0, turnClip: null, turnProgress: 0, turnWeight: 0, startYaw: yaw, targetYaw: yaw, elapsed: 0, duration: 0, settledSeconds: 0, rotationCurve: null };
}

/** 仅输出视觉朝向，控制yaw、相机与碰撞体移动不属于此模块。 */
export function stepManualRoamTurnState(previous: ManualRoamTurnState, frame: ManualRoamTurnFrame): ManualRoamTurnState {
  const delta = Math.min(0.1, Math.max(0, finite(frame.deltaSeconds)));
  if (delta === 0) return { ...previous };
  const controlYaw = finite(frame.controlYaw, previous.controlYaw);
  const facingYaw=frame.orientToMovement&&!frame.fly
    ? Math.abs(finite(frame.horizontalSpeed))>.03?finite(frame.movementYaw,previous.facingYaw):previous.facingYaw+shortestAngle(controlYaw-previous.controlYaw)
    :controlYaw;
  const canTurn = frame.grounded && !frame.fly && Math.abs(finite(frame.horizontalSpeed)) <= 0.03;
  const controlMoving = Math.abs(shortestAngle(controlYaw - previous.controlYaw)) > Math.PI / 180;
  const state = { ...previous, controlYaw, facingYaw, settledSeconds: canTurn && !controlMoving ? previous.settledSeconds + delta : 0 };
  let difference = shortestAngle(facingYaw - state.visualYaw);

  if (!canTurn) {
    clearTurn(state);
    state.visualYaw = followYaw(state.visualYaw, difference, delta, 12, MAX_ANGULAR_SPEED);
  } else {
    if (state.turnClip) {
      const direction = Math.sign(state.targetYaw - state.startYaw);
      const reverse = Math.sign(difference) !== direction && Math.abs(difference) >= TURN_THRESHOLD;
      const abrupt = Math.abs(shortestAngle(facingYaw - state.targetYaw)) > 100 / 180 * Math.PI;
      if (reverse || abrupt) clearTurn(state);
    }
    if (!state.turnClip && Math.abs(difference) >= TURN_THRESHOLD) beginTurn(state, difference, frame);
    if (state.turnClip) {
      state.elapsed = Math.min(state.duration, state.elapsed + delta);
      state.turnProgress = state.elapsed / state.duration;
      const angleProgress = sampleRotationCurve(state.rotationCurve, state.turnProgress);
      const desiredYaw = state.startYaw + (state.targetYaw - state.startYaw) * angleProgress;
      state.visualYaw += Math.min(MAX_ANGULAR_SPEED * delta, Math.max(-MAX_ANGULAR_SPEED * delta, desiredYaw - state.visualYaw));
      state.turnWeight = smooth(Math.min(1, state.turnProgress / 0.12, (1 - state.turnProgress) / 0.12));
      if (state.turnProgress >= 1 && Math.abs(state.targetYaw - state.visualYaw) < 1e-6) clearTurn(state);
    } else if (state.settledSeconds >= 0.25) {
      state.visualYaw = followYaw(state.visualYaw, difference, delta, 7, 2.5);
    }
  }
  difference = shortestAngle(facingYaw - state.visualYaw);
  state.deltaYaw = difference;
  // 四向移动混合必须使用实际显示的身体朝向，不能继续使用滞后前的控制yaw。
  state.animationYaw = state.visualYaw;
  return state;
}

function beginTurn(state: ManualRoamTurnState, difference: number, frame: ManualRoamTurnFrame): void {
  const direction = difference < 0 ? 'Left' : 'Right';
  const large = Math.abs(difference) >= TURN_180_THRESHOLD && (!frame.turnDurations || frame.turnDurations[`Turn${direction}180`] !== undefined);
  state.turnClip = `Turn${difference < 0 ? 'Left' : 'Right'}${large ? '180' : '90'}`;
  state.startYaw = state.visualYaw;
  // 只提供90度步态时，180度分成两次双步转身，避免两脚直接交换站位。
  const targetDifference = !large && Math.abs(difference)>Math.PI/2 ? Math.sign(difference)*Math.PI/2 : difference;
  state.targetYaw = state.visualYaw + targetDifference;
  state.elapsed = 0;
  const curve = frame.turnRotationCurves?.[state.turnClip];
  state.rotationCurve = curve && curve.length >= 2 && curve[0] === 0 && curve[curve.length - 1] === 1
    && curve.every((value, index) => Number.isFinite(value) && value >= 0 && value <= 1 && (index === 0 || value >= curve[index - 1])) ? curve : null;
  const maxSlope = state.rotationCurve
    ? Math.max(...state.rotationCurve.slice(1).map((value, index) => (value - state.rotationCurve![index]) * (state.rotationCurve!.length - 1)))
    : 1.5 / 0.43;
  // 首步转向、次步归位；按曲线斜率延长过短动作，避免视觉角度追不上脚步。
  state.duration = Math.max(0.12, finite(frame.turnDurations?.[state.turnClip], large ? 1.2 : 0.8), Math.abs(targetDifference) * maxSlope / MAX_ANGULAR_SPEED);
  state.turnProgress = 0;
  state.turnWeight = 0;
}

function clearTurn(state: ManualRoamTurnState): void {
  state.turnClip = null; state.turnProgress = 0; state.turnWeight = 0; state.elapsed = 0; state.duration = 0; state.rotationCurve = null;
}

function sampleRotationCurve(curve: readonly number[] | null, progress: number): number {
  if (!curve) return smooth(Math.max(0, Math.min(1, (progress - 0.12) / 0.43)));
  const index = progress * (curve.length - 1);
  const lower = Math.floor(index); const upper = Math.min(curve.length - 1, lower + 1);
  return curve[lower] + (curve[upper] - curve[lower]) * (index - lower);
}

function followYaw(yaw: number, difference: number, delta: number, response: number, maxSpeed: number): number {
  const change = difference * (1 - Math.exp(-response * delta));
  return yaw + Math.min(maxSpeed * delta, Math.max(-maxSpeed * delta, change));
}

function shortestAngle(value: number): number {
  const angle = Math.atan2(Math.sin(value), Math.cos(value));
  return Math.abs(Math.abs(angle) - Math.PI) < 1e-10 ? Math.sign(value) * Math.PI : angle;
}

function smooth(value: number): number { return value * value * (3 - 2 * value); }
function finite(value: number | undefined, fallback = 0): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
