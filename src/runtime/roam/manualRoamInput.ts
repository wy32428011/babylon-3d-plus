import type { ManualRoamLocomotionMode, RoamInputFrame } from './manualRoamCore';

export type RoamAxis2 = {
  x: number;
  y: number;
};

const KEYBOARD_AXIS_KEYS = Object.freeze({
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  descend: ['KeyQ'],
  ascend: ['KeyE', 'Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
});

export function createEmptyRoamInputFrame(): RoamInputFrame {
  return {
    forward: 0,
    right: 0,
    vertical: 0,
    lookX: 0,
    lookY: 0,
    jump: false,
    sprint: false,
  };
}

export function resolveKeyboardRoamInput(
  pressedKeys: ReadonlySet<string>,
  locomotionMode: ManualRoamLocomotionMode,
): Pick<RoamInputFrame, 'forward' | 'right' | 'vertical' | 'jump' | 'sprint'> {
  const forward = Number(hasAnyKey(pressedKeys, KEYBOARD_AXIS_KEYS.forward))
    - Number(hasAnyKey(pressedKeys, KEYBOARD_AXIS_KEYS.backward));
  const right = Number(hasAnyKey(pressedKeys, KEYBOARD_AXIS_KEYS.right))
    - Number(hasAnyKey(pressedKeys, KEYBOARD_AXIS_KEYS.left));
  const spacePressed = pressedKeys.has('Space');

  if (locomotionMode === 'fly') {
    const vertical = Number(hasAnyKey(pressedKeys, KEYBOARD_AXIS_KEYS.ascend))
      - Number(hasAnyKey(pressedKeys, KEYBOARD_AXIS_KEYS.descend));
    return {
      forward,
      right,
      vertical,
      jump: false,
      sprint: hasAnyKey(pressedKeys, KEYBOARD_AXIS_KEYS.sprint),
    };
  }

  return {
    forward,
    right,
    vertical: 0,
    jump: spacePressed,
    sprint: hasAnyKey(pressedKeys, KEYBOARD_AXIS_KEYS.sprint),
  };
}

/**
 * 对二维摇杆使用径向死区，并重新映射剩余行程，避免中心漂移和轴向失真。
 */
export function applyGamepadDeadZone(
  rawX: number,
  rawY: number,
  deadZone = 0.15,
): RoamAxis2 {
  const x = finiteOrZero(rawX);
  const y = finiteOrZero(rawY);
  const safeDeadZone = clamp(finiteOrFallback(deadZone, 0.15), 0, 0.95);
  const magnitude = Math.hypot(x, y);
  if (magnitude <= safeDeadZone || magnitude === 0) return { x: 0, y: 0 };

  const clampedMagnitude = Math.min(1, magnitude);
  const remappedMagnitude = (clampedMagnitude - safeDeadZone) / (1 - safeDeadZone);
  const scale = remappedMagnitude / magnitude;
  return {
    x: x * scale,
    y: y * scale,
  };
}

export function mergeRoamInputFrames(
  ...frames: readonly Partial<RoamInputFrame>[]
): RoamInputFrame {
  const merged = createEmptyRoamInputFrame();
  for (const frame of frames) {
    merged.forward += finiteOrZero(frame.forward);
    merged.right += finiteOrZero(frame.right);
    merged.vertical += finiteOrZero(frame.vertical);
    merged.lookX += finiteOrZero(frame.lookX);
    merged.lookY += finiteOrZero(frame.lookY);
    merged.jump ||= frame.jump === true;
    merged.sprint ||= frame.sprint === true;
  }
  merged.forward = clamp(merged.forward, -1, 1);
  merged.right = clamp(merged.right, -1, 1);
  merged.vertical = clamp(merged.vertical, -1, 1);
  return merged;
}

function hasAnyKey(keys: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((key) => keys.has(key));
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function finiteOrFallback(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
