import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultManualRoamConfig,
  createInitialRoamKinematicState,
  resolveRoamHorizontalSpeed,
  resolveRoamKinematicStep,
  sanitizeManualRoamConfig,
} from '../../src/runtime/roam/manualRoamCore.ts';
import {
  applyGamepadDeadZone,
  createEmptyRoamInputFrame,
  mergeRoamInputFrames,
  resolveKeyboardRoamInput,
} from '../../src/runtime/roam/manualRoamInput.ts';

test('地面模式将 Space 解析为跳跃，飞行模式将 Q/E/Space 解析为升降', () => {
  const keys = new Set(['KeyW', 'KeyD', 'KeyQ', 'Space']);

  const ground = resolveKeyboardRoamInput(keys, 'ground');
  assert.deepEqual(ground, {
    forward: 1,
    right: 1,
    vertical: 0,
    jump: true,
    sprint: false,
  });

  const fly = resolveKeyboardRoamInput(keys, 'fly');
  assert.deepEqual(fly, {
    forward: 1,
    right: 1,
    vertical: 0,
    jump: false,
    sprint: false,
  });

  assert.equal(resolveKeyboardRoamInput(new Set(['KeyQ']), 'fly').vertical, -1);
  assert.equal(resolveKeyboardRoamInput(new Set(['KeyE']), 'fly').vertical, 1);
});

test('方向键与 WASD 等价，互相抵消的按键不会产生移动', () => {
  const arrows = resolveKeyboardRoamInput(new Set(['ArrowUp', 'ArrowLeft']), 'ground');
  assert.equal(arrows.forward, 1);
  assert.equal(arrows.right, -1);

  const cancelled = resolveKeyboardRoamInput(
    new Set(['KeyW', 'KeyS', 'ArrowLeft', 'ArrowRight']),
    'ground',
  );
  assert.equal(cancelled.forward, 0);
  assert.equal(cancelled.right, 0);
});

test('手柄死区过滤漂移，并保持死区外输入连续', () => {
  assert.deepEqual(applyGamepadDeadZone(0.05, -0.08, 0.15), { x: 0, y: 0 });

  const outside = applyGamepadDeadZone(0.6, 0.8, 0.15);
  assert.ok(Math.abs(Math.hypot(outside.x, outside.y) - 1) < 1e-9);
  assert.ok(outside.x > 0 && outside.y > 0);
});

test('键鼠、触摸和手柄输入可合并，轴值限幅且动作标记不会丢失', () => {
  const merged = mergeRoamInputFrames(
    { forward: 0.8, right: -0.4, lookX: 3, jump: true },
    { forward: 0.7, right: -0.8, lookX: -1, lookY: 2, sprint: true },
  );

  assert.deepEqual(merged, {
    forward: 1,
    right: -1,
    vertical: 0,
    lookX: 2,
    lookY: 2,
    jump: true,
    sprint: true,
  });
});

test('默认配置经过清洗后保持可用，非法配置回退或限制到安全范围', () => {
  const defaults = createDefaultManualRoamConfig();
  assert.deepEqual(sanitizeManualRoamConfig(defaults), defaults);

  const sanitized = sanitizeManualRoamConfig({
    ...defaults,
    walkSpeed: Number.NaN,
    runSpeed: -5,
    mouseSensitivity: 100,
    capsuleHeight: 0.2,
    capsuleRadius: 10,
    maxPitchDegrees: 120,
  });
  assert.equal(sanitized.walkSpeed, defaults.walkSpeed);
  assert.equal(sanitized.runSpeed, sanitized.walkSpeed);
  assert.equal(sanitized.mouseSensitivity, 5);
  assert.equal(sanitized.capsuleHeight, 0.8);
  assert.equal(sanitized.capsuleRadius, 0.39);
  assert.equal(sanitized.maxPitchDegrees, 89);
});

test('运动步进归一化对角移动并按视角偏航转换到世界坐标', () => {
  const config = createDefaultManualRoamConfig();
  const state = createInitialRoamKinematicState({ x: 0, y: 0, z: 0 });
  state.yaw = Math.PI / 2;
  const input = createEmptyRoamInputFrame();
  input.forward = 1;
  input.right = 1;

  const step = resolveRoamKinematicStep(state, input, config, config.maxDeltaSeconds, 'ground');
  assert.ok(
    Math.abs(
      Math.hypot(step.displacement.x, step.displacement.z)
      - config.walkSpeed * config.maxDeltaSeconds,
    ) < 1e-9,
  );
  assert.ok(step.displacement.x > 0);
  assert.ok(step.displacement.z < 0);
});

test('跳跃只在落地时产生初速度，空中持续应用重力', () => {
  const config = createDefaultManualRoamConfig();
  const grounded = createInitialRoamKinematicState({ x: 0, y: 0, z: 0 });
  grounded.grounded = true;
  const jumpInput = createEmptyRoamInputFrame();
  jumpInput.jump = true;

  const jumpStep = resolveRoamKinematicStep(grounded, jumpInput, config, 0.1, 'ground');
  assert.ok(jumpStep.verticalVelocity > 0);
  assert.ok(jumpStep.displacement.y > 0);

  const airborne = { ...grounded, grounded: false, verticalVelocity: 1 };
  const airStep = resolveRoamKinematicStep(airborne, jumpInput, config, 0.1, 'ground');
  assert.ok(airStep.verticalVelocity < 1);
  assert.notEqual(airStep.verticalVelocity, config.jumpSpeed);
});

test('飞行模式不应用重力，升降速度和奔跑倍率可独立生效', () => {
  const config = createDefaultManualRoamConfig();
  const state = createInitialRoamKinematicState({ x: 0, y: 5, z: 0 });
  state.verticalVelocity = -20;
  const input = createEmptyRoamInputFrame();
  input.forward = 1;
  input.vertical = 1;
  input.sprint = true;

  const step = resolveRoamKinematicStep(state, input, config, config.maxDeltaSeconds, 'fly');
  assert.equal(step.verticalVelocity, 0);
  assert.equal(step.displacement.y, config.flyVerticalSpeed * config.maxDeltaSeconds);
  assert.equal(
    Math.hypot(step.displacement.x, step.displacement.z),
    config.runSpeed * config.maxDeltaSeconds,
  );
});

test('视角增量按独立灵敏度更新并限制俯仰角', () => {
  const config = createDefaultManualRoamConfig();
  const state = createInitialRoamKinematicState({ x: 0, y: 0, z: 0 });
  const input = createEmptyRoamInputFrame();
  input.lookX = 100;
  input.lookY = 100_000;

  const step = resolveRoamKinematicStep(state, input, config, 0.016, 'ground');
  assert.ok(step.yaw > 0);
  assert.equal(step.pitch, -config.maxPitchDegrees * Math.PI / 180);
});

test('半幅摇杆输入只产生一半水平位移', () => {
  const config = createDefaultManualRoamConfig();
  const state = createInitialRoamKinematicState({ x: 0, y: 0, z: 0 });
  const input = createEmptyRoamInputFrame();
  input.forward = 0.5;

  const step = resolveRoamKinematicStep(state, input, config, 0.016, 'ground');
  assert.equal(step.horizontalSpeed, config.walkSpeed * 0.5);
  assert.ok(Math.abs(Math.hypot(step.displacement.x, step.displacement.z) - config.walkSpeed * 0.008) < 1e-9);
});

test('水平移动速度按输入幅度缩放，奔跑时使用奔跑上限', () => {
  const config = createDefaultManualRoamConfig();
  const walkInput = createEmptyRoamInputFrame();
  walkInput.forward = 1;
  assert.equal(resolveRoamHorizontalSpeed(walkInput, config), config.walkSpeed);

  const analogInput = createEmptyRoamInputFrame();
  analogInput.forward = 0.5;
  analogInput.right = 0;
  analogInput.sprint = false;
  assert.equal(resolveRoamHorizontalSpeed(analogInput, config), config.walkSpeed * 0.5);

  const sprintInput = createEmptyRoamInputFrame();
  sprintInput.forward = 1;
  sprintInput.sprint = true;
  assert.equal(resolveRoamHorizontalSpeed(sprintInput, config), config.runSpeed);

  const idleInput = createEmptyRoamInputFrame();
  idleInput.sprint = true;
  assert.equal(resolveRoamHorizontalSpeed(idleInput, config), 0);
});

test('异常或超长帧间隔不会产生无界位移', () => {
  const config = { ...createDefaultManualRoamConfig(), maxDeltaSeconds: 0.05 };
  const state = createInitialRoamKinematicState({ x: 0, y: 0, z: 0 });
  const input = createEmptyRoamInputFrame();
  input.forward = 1;

  const stalledFrame = resolveRoamKinematicStep(state, input, config, 10, 'ground');
  assert.equal(
    Math.hypot(stalledFrame.displacement.x, stalledFrame.displacement.z),
    config.walkSpeed * config.maxDeltaSeconds,
  );

  const invalidFrame = resolveRoamKinematicStep(state, input, config, Number.NaN, 'ground');
  assert.deepEqual(invalidFrame.displacement, { x: 0, y: 0, z: 0 });
});
