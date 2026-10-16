import type { ModelExpression, ModelParameterValue, ModelParameterValues } from '../../editor/model/modelParameters';
import type { Vector3Data } from '../../editor/model/math';

/** 模型参数与规则共用的纯求值逻辑；保留已保存表达式的类型和求值顺序语义。 */
export function evaluateBooleanExpression(expression: ModelExpression, values: ModelParameterValues): boolean {
  const value = evaluateModelExpression(expression, values);
  if (typeof value !== 'boolean') throw new Error('规则条件与已保存参数值不兼容。');
  return value;
}

export function evaluateModelExpression(expression: ModelExpression, values: ModelParameterValues): ModelParameterValue | null {
  if (typeof expression === 'number') return Number.isFinite(expression) ? expression : null;
  if (typeof expression === 'string' || typeof expression === 'boolean') return expression;
  if (isVector3Value(expression)) return expression;

  if ('param' in expression) {
    return values[expression.param] ?? null;
  }

  if ('vector3' in expression) {
    const [x, y, z] = expression.vector3.map((item) => evaluateModelExpression(item, values));
    return typeof x === 'number' && typeof y === 'number' && typeof z === 'number' ? { x, y, z } : null;
  }

  const args = expression.args.map((item) => evaluateModelExpression(item, values));
  const numbers = args.filter((arg): arg is number => typeof arg === 'number' && Number.isFinite(arg));
  if (['add', 'sub', 'mul', 'div', 'min', 'max', 'clamp', 'lerp', 'gt', 'gte', 'lt', 'lte'].includes(expression.op)
    && numbers.length !== args.length) return null;
  if (['and', 'or', 'not'].includes(expression.op) && args.some(value => typeof value !== 'boolean')) return null;
  if (expression.op === 'if' && typeof args[0] !== 'boolean') return null;

  switch (expression.op) {
    case 'add': return numbers.reduce((sum, value) => sum + value, 0);
    case 'sub': return numbers.length >= 2 ? numbers.slice(1).reduce((result, value) => result - value, numbers[0]) : null;
    case 'mul': return numbers.reduce((result, value) => result * value, 1);
    case 'div': return numbers.length === 2 && numbers[1] !== 0 ? numbers[0] / numbers[1] : null;
    case 'min': return numbers.length > 0 ? Math.min(...numbers) : null;
    case 'max': return numbers.length > 0 ? Math.max(...numbers) : null;
    case 'clamp': return numbers.length === 3 ? Math.min(numbers[2], Math.max(numbers[1], numbers[0])) : null;
    case 'lerp': return numbers.length === 3 ? numbers[0] + (numbers[1] - numbers[0]) * numbers[2] : null;
    case 'eq': return args[0] === args[1];
    case 'neq': return args[0] !== args[1];
    case 'gt': return numbers.length === 2 ? numbers[0] > numbers[1] : false;
    case 'gte': return numbers.length === 2 ? numbers[0] >= numbers[1] : false;
    case 'lt': return numbers.length === 2 ? numbers[0] < numbers[1] : false;
    case 'lte': return numbers.length === 2 ? numbers[0] <= numbers[1] : false;
    case 'and': return args.every(Boolean);
    case 'or': return args.some(Boolean);
    case 'not': return !args[0];
    case 'if': return args[0] ? args[1] ?? null : args[2] ?? null;
    default: return null;
  }
}

export function isVector3Value(value: unknown): value is Vector3Data {
  return (
    typeof value === 'object' &&
    value !== null &&
    'x' in value &&
    'y' in value &&
    'z' in value &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y) &&
    typeof value.z === 'number' &&
    Number.isFinite(value.z)
  );
}
