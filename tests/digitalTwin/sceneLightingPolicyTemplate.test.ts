import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSceneLightingPolicyResolver, LIGHTING_POLICY_FIELDS, resolveSceneLightingPolicy,
  type LightingPolicyContext, type SceneLightingPolicy,
} from '../../electron/shared/sceneLightingPolicy.ts';

const context = (patch: Partial<LightingPolicyContext> = {}): LightingPolicyContext => ({
  entityId: 'machine', nodeKey: 'rail[0]', partKey: 'rail[0]', resourceIdentity: 'r1',
  automatic: { mobility: 'static', reason: 'fixed' }, ...patch,
});
const policy = (): SceneLightingPolicy => ({ version: 1,
  defaults: { mobility: 'auto', castShadows: false, receiveShadows: true, bakeIndirect: false },
  rules: [{ id: 'rule', enabled: true, target: { kind: 'type', deviceType: 'lift' }, values: { receiveShadows: false }, nodeRules: [
    { id: 'fixed', enabled: true, target: { kind: 'node', nodeKey: 'rail[0]', resourceIdentity: 'r1' }, values: { mobility: 'static' } },
  ] }],
});

test('编译解析器只构造一次默认来源初始化，逐行不重复fromEntries', async () => {
  const original = Object.fromEntries; let calls = 0;
  Object.fromEntries = new Proxy(original, { apply(target, receiver, args) { calls++; return Reflect.apply(target, receiver, args); } });
  try {
    // 独立模块在透明计数器下捕获同一函数身份，避免把观察器当成运行期覆盖而走兼容路径。
    const module = await import('../../electron/shared/sceneLightingPolicy.ts?template-allocation');
    const resolve = module.createSceneLightingPolicyResolver(policy());
    for (let i = 0; i < 64; i++) resolve(context({ entityId: 'machine' + i }));
    assert.equal(calls, 1);
  } finally { Object.fromEntries = original; }
});

test('完整ResolvedPolicy与原逐次解析保持一致，覆盖规则、节点、实体、失配及动态祖先', () => {
  const value = policy(), resolve = createSceneLightingPolicyResolver(value);
  const cases = [context(), context({ deviceType: 'lift', availableNodeKeys: ['rail[0]'] }),
    context({ deviceType: 'lift', resourceIdentity: 'r2', availableNodeKeys: ['rail[0]'] }),
    context({ deviceType: 'lift', parentDynamic: true, motionRole: 'moving' }),
    context({ entityLighting: { mobility: 'dynamic', castShadows: true, inheritPolicy: ['receiveShadows'],
      nodeOverrides: { 'rail[0]': { receiveShadows: true } } } }),
    context({ entityLighting: { mobility: 'static', resourceIdentity: 'old', nodeOverrides: { 'rail[0]': { mobility: 'dynamic' } } } }),
    context({ entityLighting: null }),
  ];
  for (const input of cases) assert.deepEqual(resolve(input), resolveSceneLightingPolicy(value, input));
});

test('默认字段来源、结果及所有可变数组逐行独立，不泄漏模板或新别名', () => {
  const resolve = createSceneLightingPolicyResolver(policy()), input = context();
  const first = resolve(input), second = resolve(input), expected = resolve(input);
  assert.notEqual(first.settings, second.settings); assert.notEqual(first.fieldSources, second.fieldSources);
  for (const field of LIGHTING_POLICY_FIELDS) assert.notEqual(first.fieldSources[field], second.fieldSources[field]);
  for (const field of ['matchedRuleIds', 'mismatches', 'conflicts', 'preservedExceptionFields'] as const) assert.notEqual(first[field], second[field]);
  first.settings.castShadows = true; first.fieldSources.mobility.label = 'mutated'; first.matchedRuleIds.push('extra');
  first.mismatches.push({ kind: 'missing-node', nodeKey: 'wrong', message: 'wrong' });
  assert.deepEqual(second, expected); assert.deepEqual(resolve(input), expected);
});

test('规范化输入快照修改不能污染已编译默认值，新编译仍读取新值', () => {
  const raw = policy(), resolve = createSceneLightingPolicyResolver(raw), before = resolve(context());
  raw.defaults.castShadows = true; raw.rules[0].values.receiveShadows = true;
  assert.deepEqual(resolve(context()), before);
  assert.equal(createSceneLightingPolicyResolver(raw)(context()).settings.castShadows, true);
});

test('entity与entityLighting同步getter的次数、顺序、修改及错误保持原解析语义', () => {
  const value = policy(), resolve = createSceneLightingPolicyResolver(value);
  const exercise = (run: (input: LightingPolicyContext) => unknown) => {
    const log: string[] = []; let mobility: 'static' | 'dynamic' = 'static';
    const entity = { id: 'machine', get components() { log.push('components'); mobility = mobility === 'static' ? 'dynamic' : 'static'; return {}; } };
    const input = context({ entity, deviceType: 'lift' });
    Object.defineProperty(input, 'entityLighting', { get() { log.push('lighting:' + mobility); return { mobility }; } });
    return { result: run(input), log };
  };
  assert.deepEqual(exercise(resolve), exercise(input => resolveSceneLightingPolicy(value, input)));
  const failure = new Error('entity-lighting');
  const input = context(); Object.defineProperty(input, 'entityLighting', { get() { throw failure; } });
  assert.throws(() => resolve(input), error => error === failure);
});

test('运行期fromEntries覆盖仍每行执行并保留this及其返回效果，恢复后模板未污染', () => {
  const value = policy(); value.defaults = {};
  const resolve = createSceneLightingPolicyResolver(value), original = Object.fromEntries; let calls = 0;
  try {
    Object.fromEntries = function(entries) {
      assert.equal(this, Object); calls++;
      const result = original(entries); if (result.mobility) result.mobility.label = 'override'; return result;
    };
    const first = resolve(context()), second = resolve(context());
    assert.equal(first.fieldSources.mobility.label, 'override');
    assert.deepEqual(first, second); assert.equal(calls, 2);
  } finally { Object.fromEntries = original; }
  assert.deepEqual(resolve(context()), resolveSceneLightingPolicy(value, context()));
});

test('运行期map与iterator覆盖不减少原调用，逐次恢复保持一致', () => {
  const resolve = createSceneLightingPolicyResolver(policy()), map = Array.prototype.map, iterator = Array.prototype[Symbol.iterator];
  let maps = 0, iterations = 0;
  try {
    Array.prototype.map = function(callback, receiver) { if (this === LIGHTING_POLICY_FIELDS) maps++; return Reflect.apply(map, this, [callback, receiver]); };
    Array.prototype[Symbol.iterator] = function() { if (this === LIGHTING_POLICY_FIELDS) iterations++; return iterator.call(this); };
    const first = resolve(context()); assert.equal(maps, 2); assert.equal(iterations, 1);
    assert.equal(first.settings.castShadows, false);
  } finally { Array.prototype.map = map; Array.prototype[Symbol.iterator] = iterator; }
  assert.deepEqual(resolve(context()), resolveSceneLightingPolicy(policy(), context()));
});

test('fromEntries访问器原错误与次数保持，兼容资格检查不调用getter', () => {
  const resolve = createSceneLightingPolicyResolver(policy()), original = Object.getOwnPropertyDescriptor(Object, 'fromEntries')!, failure = new Error('fromEntries'); let reads = 0;
  try {
    Object.defineProperty(Object, 'fromEntries', { configurable: true, get() { reads++; throw failure; } });
    assert.throws(() => resolve(context()), error => error === failure); assert.equal(reads, 1);
  } finally { Object.defineProperty(Object, 'fromEntries', original); }
});


test('兼容路径保持fromEntries自定义setter与Set构造器的原先后顺序', () => {
  const resolve = createSceneLightingPolicyResolver(policy()), entries = Object.fromEntries, Original = globalThis.Set;
  const log: string[] = [];
  try {
    Object.fromEntries = function(values) {
      log.push('fromEntries'); const result = entries(values);
      Object.defineProperty(result, 'castShadows', { configurable: true, set() { log.push('cast:set'); }, get() { return { kind: 'automatic', label: '自动分类', value: true }; } });
      return result;
    };
    globalThis.Set = new Proxy(Original, { construct(target, args, newTarget) {
      log.push(args.length ? 'set:values' : 'set:empty'); return Reflect.construct(target, args, newTarget);
    } });
    resolve(context());
    assert.deepEqual(log.slice(0, 4), ['fromEntries', 'set:empty', 'cast:set', 'set:empty']);
  } finally { Object.fromEntries = entries; globalThis.Set = Original; }
});
