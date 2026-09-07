import assert from 'node:assert/strict';
import test from 'node:test';
import { ScenePreparationFrameBudget } from '../../src/runtime/babylon/scenePreparationFrameBudget.ts';

test('蒙版期间保留首帧和周期完整渲染，给加载任务让出主线程', () => {
  const budget = new ScenePreparationFrameBudget();
  assert.deepEqual([0, 16, 100, 199, 200, 216, 400].map((now) => budget.shouldRender(true, now)),
    [true, false, false, false, true, false, true]);
});

test('就绪后立即恢复每次绘制，再次加载仍有有限等待而不是停掉渲染', () => {
  const budget = new ScenePreparationFrameBudget();
  assert.equal(budget.shouldRender(true, 0), true);
  assert.equal(budget.shouldRender(false, 1), true);
  assert.equal(budget.shouldRender(false, 2), true);
  assert.equal(budget.shouldRender(true, 3), false);
  assert.equal(budget.shouldRender(true, 202), true);
});
