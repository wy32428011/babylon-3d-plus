import assert from 'node:assert/strict';
import test from 'node:test';
import { OpeningImageBudget } from '../../src/runtime/opening/openingImageBudget.ts';

test('单图3200万像素和累计6400万像素边界允许，下一张超限立即拒绝', () => {
  const budget = new OpeningImageBudget();
  budget.accept(8000, 4000, '第一张');
  budget.accept(8000, 4000, '第二张');
  assert.throws(() => budget.accept(1, 1, '额外图片'), /额外图片.*6400/);
});

test('超大单图与非法尺寸被拒绝，失败不消耗其它图片额度', () => {
  const budget = new OpeningImageBudget();
  assert.throws(() => budget.accept(8001, 4000, '超大图片'), /超大图片.*3200/);
  for (const dimension of [0, -1, Infinity, NaN, 1.5]) assert.throws(() => budget.accept(dimension, 100, '坏图片'), /尺寸/);
  budget.accept(8000, 4000, '合法第一张');
  budget.accept(8000, 4000, '合法第二张');
});

test('不同播放实例独立计量，常规图片与累计超限有明确诊断', () => {
  const first = new OpeningImageBudget(), second = new OpeningImageBudget();
  first.accept(6000, 5000, '图一'); first.accept(6000, 5000, '图二');
  assert.throws(() => first.accept(3000, 2000, '图三'), /图三.*6400/);
  first.accept(2000, 2000, '小图');
  second.accept(8000, 4000, '另一场景');
});
