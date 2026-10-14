import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelExpression, ModelParameterValues } from '../../src/editor/model/modelParameters.ts';
import { executeModelParameterBindings } from '../../src/runtime/babylon/modelParameterBindingExecution.ts';

import { evaluateModelExpression, evaluateBooleanExpression, isVector3Value } from '../../src/runtime/babylon/modelParameterExpression.ts';

const evaluate = (expression: ModelExpression, values: ModelParameterValues = {}) => evaluateModelExpression(expression, values);
const op = (name: string, ...args: ModelExpression[]) => ({ op: name, args }) as ModelExpression;

test('常量和已保存参数原样保留，缺失值与非有限数字常量返回 null', () => {
  for (const value of [0, -3.5, '', 'text', false, true]) assert.equal(evaluate(value), value);
  for (const value of [NaN, Infinity, -Infinity]) assert.equal(evaluate(value), null);
  assert.equal(evaluate({ param: 'missing' }), null);
  const saved = { zero: 0, empty: '', disabled: false, old: 'old-type', infinite: Infinity };
  for (const [key, value] of Object.entries(saved)) assert.equal(evaluate({ param: key }, saved), value);
});

test('有限三维向量保留对象身份，向量表达式逐轴求值', () => {
  const vector = { x: 0, y: -2, z: 4 };
  assert.equal(evaluate(vector), vector);
  assert.deepEqual(evaluate({ vector3: [{ param: 'width' }, op('mul', 2, 3), -1] }, { width: 8 }), { x: 8, y: 6, z: -1 });
  assert.equal(evaluate({ vector3: [1, { param: 'missing' }, 3] }), null);
  assert.equal(evaluate({ vector3: [1, '2', 3] }), null);
  // 已保存参数引用不做二次清洗，数值运算仍单独拒绝非有限输入。
  assert.deepEqual(evaluate({ vector3: [1, { param: 'old' }, 3] }, { old: Infinity }), { x: 1, y: Infinity, z: 3 });
  assert.equal(evaluate(op('add', { param: 'old' }, 1), { old: Infinity }), null);
});

test('向量类型守卫拒绝缺轴、非数值轴及非有限轴', () => {
  assert.equal(isVector3Value({ x: 0, y: -1, z: 2, extra: true }), true);
  for (const value of [null, undefined, 1, [], {}, { x: 1, y: 2 }, { x: '1', y: 2, z: 3 },
    { x: 1, y: NaN, z: 3 }, { x: 1, y: 2, z: Infinity }]) assert.equal(isVector3Value(value), false);
});

test('数值运算及比较执行嵌套表达式', () => {
  const cases: [string, ModelExpression[], unknown][] = [
    ['add', [2, 3, -1], 4], ['sub', [10, 2, 3], 5], ['mul', [2, 3, -1], -6], ['div', [9, 2], 4.5],
    ['min', [3, -2, 4], -2], ['max', [3, -2, 4], 4], ['clamp', [20, 1, 8], 8], ['lerp', [2, 10, .25], 4],
    ['gt', [3, 2], true], ['gte', [2, 2], true], ['lt', [3, 2], false], ['lte', [2, 2], true],
  ];
  for (const [name, args, expected] of cases) assert.equal(evaluate(op(name, ...args)), expected, name);
  assert.equal(evaluate(op('mul', op('add', { param: 'width' }, 1), 2), { width: 3 }), 8);
});

test('空参数和参数数量错误保持现有兼容语义，除零不会返回 Infinity', () => {
  assert.equal(evaluate(op('add')), 0); assert.equal(evaluate(op('mul')), 1);
  for (const expression of [op('sub', 1), op('div', 1), op('div', 1, 0), op('div', 1, 2, 3),
    op('min'), op('max'), op('clamp', 2, 1), op('lerp', 2, 3)]) assert.equal(evaluate(expression), null);
  for (const name of ['gt', 'gte', 'lt', 'lte']) assert.equal(evaluate(op(name, 1)), false);
  // 运算结果沿用原值；有限输入相乘溢出不在此层追加清洗。
  assert.equal(evaluate(op('mul', Number.MAX_VALUE, 2)), Infinity);
});

test('数值运算拒绝字符串、布尔和缺失参数，布尔运算拒绝数值', () => {
  for (const name of ['add', 'sub', 'mul', 'div', 'min', 'max', 'clamp', 'lerp', 'gt', 'gte', 'lt', 'lte']) {
    for (const invalid of ['2', false, { param: 'missing' }] as ModelExpression[]) assert.equal(evaluate(op(name, 1, invalid)), null, name);
  }
  for (const name of ['and', 'or', 'not']) assert.equal(evaluate(op(name, 1)), null, name);
  assert.equal(evaluate(op('if', 1, 'yes', 'no')), null);
});

test('相等比较保持严格值与对象身份语义', () => {
  assert.equal(evaluate(op('eq', 2, '2')), false);
  assert.equal(evaluate(op('neq', 2, '2')), true);
  const vector = { x: 1, y: 2, z: 3 };
  assert.equal(evaluate(op('eq', { param: 'a' }, { param: 'b' }), { a: vector, b: vector }), true);
  assert.equal(evaluate(op('eq', vector, { ...vector })), false);
  assert.equal(evaluate(op('eq', { param: 'a' }, { param: 'b' })), true);
});

test('布尔组合、空集合和 if 缺分支保留历史结果', () => {
  assert.equal(evaluate(op('and')), true); assert.equal(evaluate(op('or')), false);
  assert.equal(evaluate(op('and', true, false)), false); assert.equal(evaluate(op('or', false, true)), true);
  assert.equal(evaluate(op('not', false)), true); assert.equal(evaluate(op('not')), true);
  assert.equal(evaluate(op('if', true, 0, 8)), 0); assert.equal(evaluate(op('if', false, 8, false)), false);
  assert.equal(evaluate(op('if', false, 8)), null);
});

test('if、and 与 or 先按顺序求值全部参数，保持已保存表达式的执行顺序', () => {
  const reads: string[] = [];
  const values = Object.defineProperties({}, {
    yes: { get() { reads.push('yes'); return true; } },
    no: { get() { reads.push('no'); return false; } },
  }) as ModelParameterValues;
  assert.equal(evaluate(op('if', true, { param: 'yes' }, { param: 'no' }), values), true);
  assert.deepEqual(reads.splice(0), ['yes', 'no']);
  assert.equal(evaluate(op('and', false, { param: 'yes' }), values), false); assert.deepEqual(reads.splice(0), ['yes']);
  assert.equal(evaluate(op('or', true, { param: 'no' }), values), true); assert.deepEqual(reads, ['no']);
});

test('规则只接受布尔结果，错误文本保持兼容', () => {
  assert.equal(evaluateBooleanExpression(op('gt', 3, 2), {}), true);
  assert.equal(evaluateBooleanExpression(false, {}), false);
  for (const expression of [0, '', { param: 'missing' }] as ModelExpression[]) {
    assert.throws(() => evaluateBooleanExpression(expression, {}), { message: '规则条件与已保存参数值不兼容。' });
  }
});

test('真实求值错误经执行器记录后继续后续绑定和规则', () => {
  const applied: string[] = [], logs: string[] = [];
  const binding = (name: string, value: ModelExpression = true) => ({ target: { kind: 'mesh' as const, name }, property: 'visible' as const, value });
  executeModelParameterBindings({ schema: 'babylon-editor.model-parameters', version: 1, parameters: [],
    bindings: [binding('base')], rules: [{ when: { param: 'missing' }, set: [binding('skipped')] },
      { when: op('gt', 3, 2), set: [binding('rule', op('if', true, false, true))] }],
  }, {
    apply: item => { applied.push(`${item.target.name}:${evaluate(item.value)}`); },
    evaluateRule: expression => evaluateBooleanExpression(expression, {}), report: message => logs.push(message),
  });
  assert.deepEqual(applied, ['base:true', 'rule:false']);
  assert.deepEqual(logs, ['参数规则暂时无法执行，已保留模型和参数值：规则条件与已保存参数值不兼容。']);
});
