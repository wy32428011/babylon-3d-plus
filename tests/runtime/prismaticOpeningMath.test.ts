import assert from 'node:assert/strict';
import test from 'node:test';
import { getPrismaticOpeningState } from '../../src/runtime/opening/prismaticOpeningMath.ts';

const stages = ['core', 'tunnel', 'assembly', 'showcase'].map((id, index) => ({ id, label: id, durationSeconds: [4, 3, 7, 8][index] }));

test('22 秒分镜与仓库构建进度按真实时长推进，支持反向寻帧', () => {
  assert.equal(getPrismaticOpeningState(2, stages).phase, 'core');
  assert.equal(getPrismaticOpeningState(5, stages).phase, 'tunnel');
  assert.equal(getPrismaticOpeningState(7, stages).reveal, 0);
  assert.ok(getPrismaticOpeningState(10.5, stages).reveal > .4);
  assert.equal(getPrismaticOpeningState(14, stages).reveal, 1);
  assert.equal(getPrismaticOpeningState(21, stages).phase, 'showcase');
  assert.equal(getPrismaticOpeningState(7, stages).reveal, 0, '寻帧不依赖上次画面');
});

test('零秒阶段略过，减少动态直接给出静止的完整环境画面', () => {
  const shortened = stages.map(stage => ({ ...stage, durationSeconds: stage.id === 'core' || stage.id === 'tunnel' ? 0 : stage.durationSeconds }));
  assert.equal(getPrismaticOpeningState(0, shortened).phase, 'assembly');
  assert.equal(getPrismaticOpeningState(7, shortened).phase, 'showcase');
  const first = getPrismaticOpeningState(1, stages, true);
  const second = getPrismaticOpeningState(21, stages, true);
  assert.equal(first.phase, 'showcase'); assert.equal(first.reveal, 1);
  assert.equal(first.orbit, second.orbit); assert.equal(first.visualSeconds, second.visualSeconds);
});
