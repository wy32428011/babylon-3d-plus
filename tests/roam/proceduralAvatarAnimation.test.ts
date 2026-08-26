import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createConnectedLimbMask,
  createProceduralStrideTargets,
  PROCEDURAL_LIMB,
  resolveProceduralBodyMotion,
  resolveProceduralStrideInfluences,
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
    const forwardDepthDelta = targets.forward[index + 2] - positions[index + 2];
    const backwardDepthDelta = targets.backward[index + 2] - positions[index + 2];
    assert.ok(Math.abs(forwardDepthDelta + backwardDepthDelta) < 1e-6);
    assert.ok(Math.abs(targets.forward[index + 1] - targets.backward[index + 1]) < 1e-6);
  }

  assert.equal(createProceduralStrideTargets(new Float32Array()), null);
  assert.equal(createProceduralStrideTargets(new Float32Array([0, 0, 0, 1])), null);
  assert.equal(createProceduralStrideTargets(new Float32Array([0, 1, 0, 0, 1, 0])), null);
});

test('肢体连接点保持固定，并在远离关节后平滑恢复完整摆幅', () => {
  const positions = new Float32Array([
    -0.2, 1, 0, // 髋部连接点
    -0.2, 0.95, 0, // 髋部下方过渡区
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
  });

  assert.ok(targets);
  assert.equal(targets.forward[2], 0);
  assert.ok(targets.forward[5] > 0);
  assert.ok(targets.forward[5] < targets.forward[8] * 0.2);
  assert.ok(targets.forward[8] > 0.2);
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

test('步态权重按相位交替且在静止或腾空时回到中立姿态', () => {
  assert.deepEqual(resolveProceduralStrideInfluences(Math.PI / 2, 1, false), {
    forward: 1,
    backward: 0,
  });
  assert.deepEqual(resolveProceduralStrideInfluences(Math.PI * 1.5, 0.5, false), {
    forward: 0,
    backward: 0.5,
  });
  assert.deepEqual(resolveProceduralStrideInfluences(Math.PI / 2, 0, false), {
    forward: 0,
    backward: 0,
  });
  assert.deepEqual(resolveProceduralStrideInfluences(Math.PI / 2, 1, true), {
    forward: 0,
    backward: 0,
  });
});

test('行走身体起伏限制在毫米级，静止或腾空时不产生额外跳动', () => {
  const peak = resolveProceduralBodyMotion(Math.PI / 2, 1, false);
  assert.ok(peak.verticalOffsetMeters > 0);
  assert.ok(peak.verticalOffsetMeters <= 0.006);
  assert.ok(Math.abs(peak.rollRadians) <= 0.008);

  assert.deepEqual(resolveProceduralBodyMotion(Math.PI, 0, false), {
    verticalOffsetMeters: 0,
    rollRadians: 0,
  });
  assert.deepEqual(resolveProceduralBodyMotion(Math.PI / 2, 1, true), {
    verticalOffsetMeters: 0,
    rollRadians: 0,
  });
});
