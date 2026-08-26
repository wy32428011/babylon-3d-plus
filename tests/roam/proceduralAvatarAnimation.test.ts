import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInitialProceduralGaitState,
  createConnectedLimbMask,
  createProceduralStrideTargets,
  PROCEDURAL_LIMB,
  resolveProceduralBodyMotion,
  resolveProceduralStrideInfluences,
  stepProceduralGaitState,
} from '../../src/runtime/roam/proceduralAvatarAnimation.ts';

test('程序化步态让左右腿反向迈步，并让手臂与同侧腿反向摆动', () => {
  const positions = new Float32Array([
    -0.2, 0, 0, // 左脚
    0.2, 0, 0, // 右脚
    -0.45, 0.55, 0, // 左手
    0.45, 0.55, 0, // 右手
    0, 1, 0, // 头顶
  ]);

  const targets = createProceduralStrideTargets(positions, {
    limbMask: new Int8Array([
      PROCEDURAL_LIMB.leftLeg,
      PROCEDURAL_LIMB.rightLeg,
      PROCEDURAL_LIMB.leftArm,
      PROCEDURAL_LIMB.rightArm,
      PROCEDURAL_LIMB.fixed,
    ]),
  });

  assert.ok(targets);
  assert.ok(targets.changedVertexCount >= 4);
  assert.ok(targets.forward[2] > 0);
  assert.ok(targets.forward[5] < 0);
  assert.ok(targets.forward[8] < 0);
  assert.ok(targets.forward[11] > 0);
  assert.equal(targets.forward[12], positions[12]);
  assert.equal(targets.forward[13], positions[13]);
  assert.equal(targets.forward[14], positions[14]);
});

test('前后两个极限姿态对称，非法或退化顶点数据不会创建步态', () => {
  const positions = new Float32Array([
    -0.2, 0, 0,
    0.2, 0, 0,
    -0.45, 0.55, 0,
    0.45, 0.55, 0,
    0, 1, 0,
  ]);
  const targets = createProceduralStrideTargets(positions, {
    limbMask: new Int8Array([
      PROCEDURAL_LIMB.leftLeg,
      PROCEDURAL_LIMB.rightLeg,
      PROCEDURAL_LIMB.leftArm,
      PROCEDURAL_LIMB.rightArm,
      PROCEDURAL_LIMB.fixed,
    ]),
  });

  assert.ok(targets);
  for (let index = 0; index < positions.length; index += 3) {
    const forwardDepthDelta = targets.forward[index + 2] - targets.neutral[index + 2];
    const backwardDepthDelta = targets.backward[index + 2] - targets.neutral[index + 2];
    assert.ok(Math.abs(forwardDepthDelta + backwardDepthDelta) < 1e-6);
    assert.ok(Math.abs(targets.forward[index + 1] - targets.backward[index + 1]) < 1e-6);
  }

  assert.equal(createProceduralStrideTargets(new Float32Array()), null);
  assert.equal(createProceduralStrideTargets(new Float32Array([0, 0, 0, 1])), null);
  assert.equal(createProceduralStrideTargets(new Float32Array([0, 1, 0, 0, 1, 0])), null);
});

test('原始跨步姿态先校正为中立站姿，再生成克制的对称摆动', () => {
  const positions = new Float32Array([
    -0.2, 0, 0.22, // 左脚原始前伸
    0.2, 0, -0.35, // 右脚原始后伸
    -0.45, 0.25, -0.24, // 左手原始后摆
    0.45, 0.25, 0.3, // 右手原始前摆
    0, 1.2, 0, // 固定头顶
  ]);
  const targets = createProceduralStrideTargets(positions, {
    limbMask: new Int8Array([
      PROCEDURAL_LIMB.leftLeg,
      PROCEDURAL_LIMB.rightLeg,
      PROCEDURAL_LIMB.leftArm,
      PROCEDURAL_LIMB.rightArm,
      PROCEDURAL_LIMB.fixed,
    ]),
    pivots: {
      leftLeg: { x: -0.2, y: 0.9, z: 0 },
      rightLeg: { x: 0.2, y: 0.9, z: 0 },
      leftArm: { x: -0.45, y: 0.85, z: 0 },
      rightArm: { x: 0.45, y: 0.85, z: 0 },
    },
  });

  assert.ok(targets);
  for (const positionIndex of [0, 3, 6, 9]) {
    assert.ok(Math.abs(targets.neutral[positionIndex + 2]) < 1e-5);
  }

  const leftFootLift = targets.forward[1] - targets.neutral[1];
  const rightFootLift = targets.forward[4] - targets.neutral[4];
  const bodyCompensation = resolveProceduralBodyMotion(Math.PI / 2, 1, false).verticalOffsetMeters;
  assert.ok(Math.max(leftFootLift, rightFootLift) + bodyCompensation <= 0.012);
});

test('肢体连接点保持固定，并在远离关节后平滑恢复完整摆幅', () => {
  const positions = new Float32Array([
    -0.2, 1, 0.14, // 横向厚度超过半段肢体长度的髋部连接点
    -0.2, 0.85, 0, // 髋部下方过渡区
    -0.2, 0, 0, // 小腿末端
    0.2, 1, 0, // 固定参照点
  ]);
  const targets = createProceduralStrideTargets(positions, {
    limbMask: new Int8Array([
      PROCEDURAL_LIMB.leftLeg,
      PROCEDURAL_LIMB.leftLeg,
      PROCEDURAL_LIMB.leftLeg,
      PROCEDURAL_LIMB.fixed,
    ]),
    pivots: {
      leftLeg: { x: -0.2, y: 1, z: 0 },
    },
    distals: {
      leftLeg: { x: -0.2, y: 0.8, z: 0 },
    },
    neutralRotationOffsets: {
      leftLeg: 0,
    },
    limbLengths: {
      leftLeg: 0.2,
    },
  });

  assert.ok(targets);
  for (const target of [targets.neutral, targets.forward, targets.backward]) {
    assertVertexClose(target, 0, positions, 0);
  }

  const transitionDisplacement = readVertexDisplacement(targets.forward, positions, 1);
  const distalDisplacement = readVertexDisplacement(targets.forward, positions, 2);
  assert.ok(transitionDisplacement > 0);
  assert.ok(transitionDisplacement < distalDisplacement * 0.2);
  assert.ok(distalDisplacement > 0.16);
  assert.ok(distalDisplacement < 0.18);
});

test('连通分量掩码只选择外侧衣袖和低位裤腿，躯干与腰胯保持固定', () => {
  const positions = new Float32Array([
    -2, 5, 0, -1.8, 4, 0, -2.1, 4, 0, // 左袖 0..2
    2, 5, 0, 1.8, 4, 0, 2.1, 4, 0, // 右袖 3..5
    -0.5, 5, 0, 0.5, 5, 0, 0, 7, 0, // 躯干 6..8
    -0.6, 0, 0, -0.2, 3, 0, -0.8, 3, 0, // 左裤腿 9..11
    0.6, 0, 0, 0.2, 3, 0, 0.8, 3, 0, // 右裤腿 12..14
    -0.8, 4.5, 0, 0.8, 4.5, 0, 0, 5.5, 0, // 腰胯 15..17
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16, 17,
  ]);

  const arms = createConnectedLimbMask(positions, indices.subarray(0, 9), 'outerArms');
  assert.deepEqual([...arms], [
    -2, -2, -2, 2, 2, 2, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);

  const legs = createConnectedLimbMask(positions, indices.subarray(9), 'lowerLegs');
  assert.deepEqual([...legs], [
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    -1, -1, -1, 1, 1, 1, 0, 0, 0,
  ]);
});

test('重合衣袖接缝保持闭合，同时远端衣袖仍可摆动', () => {
  const positions = new Float32Array([
    -2, 5, 0.8, -2, 3, 0, -2.2, 3, 0, // 独立衣袖组件 0..2
    -2, 5, 0.8, 2, 5, 0, 0, 7, 0, // 固定躯干组件 3..5，顶点 3 与顶点 0 重合
  ]);
  const mask = createConnectedLimbMask(
    positions,
    new Uint16Array([0, 1, 2, 3, 4, 5]),
    'outerArms',
  );

  assert.equal(mask[0], PROCEDURAL_LIMB.leftArm);
  assert.equal(mask[1], PROCEDURAL_LIMB.leftArm);
  assert.equal(mask[2], PROCEDURAL_LIMB.leftArm);
  assert.deepEqual([...mask.slice(3)], [0, 0, 0]);

  const targets = createProceduralStrideTargets(positions, {
    limbMask: mask,
    pivots: {
      leftArm: { x: -2, y: 5.1, z: 0 },
    },
    distals: {
      leftArm: { x: -2, y: 4.1, z: 0 },
    },
    neutralRotationOffsets: {
      leftArm: 0,
    },
    limbLengths: {
      leftArm: 1,
    },
  });

  assert.ok(targets);
  for (const target of [targets.neutral, targets.forward, targets.backward]) {
    assertVertexClose(target, 0, target, 3);
  }
  assert.ok(readVertexDisplacement(targets.forward, positions, 1) > 0.2);
});

test('步态权重按相位交替且在静止或腾空时回到中立姿态', () => {
  assert.deepEqual(resolveProceduralStrideInfluences(Math.PI / 2, 1, false), {
    neutral: 0,
    forward: 1,
    backward: 0,
  });
  assert.deepEqual(resolveProceduralStrideInfluences(Math.PI * 1.5, 0.5, false), {
    neutral: 0.5,
    forward: 0,
    backward: 0.5,
  });
  assert.deepEqual(resolveProceduralStrideInfluences(Math.PI / 2, 0, false), {
    neutral: 1,
    forward: 0,
    backward: 0,
  });
  assert.deepEqual(resolveProceduralStrideInfluences(Math.PI / 2, 1, true), {
    neutral: 1,
    forward: 0,
    backward: 0,
  });
});

test('程序化步态从中立相位平滑启动，并在停止时冻结相位后渐隐', () => {
  let state = createInitialProceduralGaitState();
  state = stepProceduralGaitState(state, 0, false, false, 0.5);
  assert.deepEqual(state, { phase: 0, amount: 0, active: false });

  state = stepProceduralGaitState(state, 1, false, false, 1 / 60);
  assert.ok(state.phase > 0 && state.phase < 0.2);
  assert.ok(state.amount > 0 && state.amount < 0.25);
  assert.equal(state.active, true);

  const movingState = stepProceduralGaitState(state, 1, false, false, 1 / 60);
  assert.ok(movingState.phase > state.phase);
  const stoppingState = stepProceduralGaitState(movingState, 0, false, false, 1 / 60);
  assert.equal(stoppingState.phase, movingState.phase);
  assert.ok(stoppingState.amount < movingState.amount);
  assert.ok(stoppingState.amount > 0);
  assert.equal(stoppingState.active, false);
});

test('低于移动阈值的摇杆漂移不会让人物停在偏步姿势', () => {
  let state = { phase: Math.PI / 2, amount: 0.5, active: true };
  for (let frame = 0; frame < 120; frame += 1) {
    state = stepProceduralGaitState(state, 0.04, false, false, 1 / 60);
  }

  assert.deepEqual(state, { phase: 0, amount: 0, active: false });
});

test('真实输入幅度先经过死区判断，再映射为完整步幅', () => {
  const belowDeadZone = stepProceduralGaitState(createInitialProceduralGaitState(), 0.04, false, false, 1 / 60);
  assert.deepEqual(belowDeadZone, { phase: 0, amount: 0, active: false });

  const walking = stepProceduralGaitState(createInitialProceduralGaitState(), 0.35, false, false, 1 / 60);
  assert.equal(walking.active, true);
  assert.ok(walking.amount > 0.1 && walking.amount < 0.2);

  const slightMovement = stepProceduralGaitState(createInitialProceduralGaitState(), 0.06, false, false, 1 / 60);
  assert.equal(slightMovement.active, true);
  assert.ok(slightMovement.amount > 0 && slightMovement.amount < 0.01);
});

test('行走身体起伏限制在毫米级，静止或腾空时不产生额外跳动', () => {
  const peak = resolveProceduralBodyMotion(Math.PI / 2, 1, false);
  assert.ok(peak.verticalOffsetMeters < 0);
  assert.ok(peak.verticalOffsetMeters >= -0.004);
  assert.ok(Math.abs(peak.rollRadians) <= 0.004);

  assert.deepEqual(resolveProceduralBodyMotion(Math.PI, 0, false), {
    verticalOffsetMeters: 0,
    rollRadians: 0,
  });
  assert.deepEqual(resolveProceduralBodyMotion(Math.PI / 2, 1, true), {
    verticalOffsetMeters: 0,
    rollRadians: 0,
  });
});

function assertVertexClose(
  actual: ArrayLike<number>,
  actualVertexIndex: number,
  expected: ArrayLike<number>,
  expectedVertexIndex: number,
  tolerance = 1e-7,
): void {
  const actualIndex = actualVertexIndex * 3;
  const expectedIndex = expectedVertexIndex * 3;
  for (let component = 0; component < 3; component += 1) {
    assert.ok(
      Math.abs(actual[actualIndex + component] - expected[expectedIndex + component]) <= tolerance,
      `vertex ${actualVertexIndex} component ${component} must remain within ${tolerance}`,
    );
  }
}

function readVertexDisplacement(
  target: ArrayLike<number>,
  source: ArrayLike<number>,
  vertexIndex: number,
): number {
  const index = vertexIndex * 3;
  return Math.hypot(
    target[index] - source[index],
    target[index + 1] - source[index + 1],
    target[index + 2] - source[index + 2],
  );
}
