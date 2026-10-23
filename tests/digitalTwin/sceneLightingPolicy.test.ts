import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareSceneLightingPolicies, createLightingModelReference, createSceneLightingPolicyResolver, getLightingPolicySignatureValue,
  matchesLightingPolicyTarget, normalizeLightingPolicyNodeKey, normalizeSceneLightingPolicy, resolveSceneLightingPolicy,
  type LightingPolicyContext, type LightingPolicyRule, type LightingPolicyValues, type SceneLightingPolicy,
} from '../../electron/shared/sceneLightingPolicy.ts';
import {
  getSceneLightingBakeSignature, normalizeEntityLightingSettings, requiresSceneLightingBake,
} from '../../electron/shared/sceneLightingBakeContract.ts';

const context = (patch: Partial<LightingPolicyContext> = {}): LightingPolicyContext => ({
  entityId: 'machine', nodeKey: 'root/rail[0]', resourceIdentity: 'revision-1',
  automatic: { mobility: 'static', reason: '实际固定结构' }, ...patch,
});
const rule = (id: string, values: LightingPolicyValues, extra: Partial<LightingPolicyRule> = {}): LightingPolicyRule =>
  ({ id, enabled: true, target: { kind: 'all' }, values, ...extra });
const policy = (rules: LightingPolicyRule[] = [], defaults: LightingPolicyValues = {}): SceneLightingPolicy => ({ version: 1, defaults, rules });
const identity = { sourceKey: 'tenant-source', kind: 'model' as const, resourceId: '17', modelPath: 'parts/motor.glb' };

test('缺失策略不新增文档字段，显式空策略可保存但不改变旧GI语义', () => {
  assert.equal(normalizeSceneLightingPolicy(undefined), undefined);
  assert.equal(normalizeSceneLightingPolicy(null), undefined);
  assert.equal(normalizeSceneLightingPolicy({ version: 2, rules: [] }), undefined);
  assert.deepEqual(normalizeSceneLightingPolicy({ version: 1 }), policy());
  assert.equal(getLightingPolicySignatureValue(undefined), undefined);
  assert.equal(getLightingPolicySignatureValue(policy()), undefined);
  assert.equal(getLightingPolicySignatureValue(policy([], { mobility: 'auto', castShadows: true, receiveShadows: true, bakeIndirect: true })), undefined);
  assert.equal(getLightingPolicySignatureValue(policy([rule('empty', {}, { name: '仅名称' }), rule('off', { mobility: 'static' }, { enabled: false })])), undefined);
});

test('规范化只接受实际部分字段，保留false及优先级，丢弃非法目标和重复ID', () => {
  const raw = { version: 1, defaults: { castShadows: false, receiveShadows: 'false', mobility: 'unknown' }, rules: [
    { id: 'first', name: ' 第一条 ', target: { kind: 'all' }, values: { receiveShadows: false, anything: true } },
    { id: 'first', target: { kind: 'all' }, values: { mobility: 'dynamic' } },
    { id: 'invalid', target: { kind: 'group', folderId: '' }, values: { mobility: 'static' } },
    { id: 'last', enabled: false, target: { kind: 'type', deviceType: 'rgv' }, values: { bakeIndirect: false }, nodeRules: [
      { id: 'bound', target: { kind: 'node', nodeKey: 'root/rail[0]/instance:3', resourceIdentity: 'revision-1' }, values: { mobility: 'static' } },
      { id: 'unsafe', target: { kind: 'node', nodeKey: 'root/rail[0]' }, values: { mobility: 'static' } },
    ] },
  ] };
  const copy = JSON.stringify(raw), value = normalizeSceneLightingPolicy(raw)!;
  assert.deepEqual(value.defaults, { castShadows: false });
  assert.deepEqual(value.rules.map(item => item.id), ['first', 'last']);
  assert.deepEqual(value.rules[0].values, { receiveShadows: false });
  assert.equal(value.rules[0].name, '第一条');
  assert.equal(value.rules[1].enabled, false);
  assert.equal(value.rules[1].nodeRules?.length, 1);
  assert.equal(value.rules[1].nodeRules?.[0].target.kind, 'node');
  assert.equal(JSON.stringify(raw), copy);
});

test('资源规则复用精确型号身份，缓存修订可持续而跨租户或同名异路径不匹配', () => {
  const reference = createLightingModelReference({ sourceUrl: 'editor-asset://local/C%3A%2Fcache%2Fmotor.glb?rev=1', dataPlatformModel: identity })!;
  assert.deepEqual(reference.identity, identity);
  assert.equal(matchesLightingPolicyTarget({ kind: 'resource', model: reference }, context({
    modelAsset: { sourceUrl: 'editor-asset://local/D%3A%2Fpublished%2Fmotor.glb?rev=2', dataPlatformModel: { ...identity } },
  })), true);
  assert.equal(matchesLightingPolicyTarget({ kind: 'resource', model: reference }, context({
    modelAsset: { sourceUrl: reference.sourceUrl, dataPlatformModel: { ...identity, sourceKey: 'another-tenant' } },
  })), false);
  assert.equal(matchesLightingPolicyTarget({ kind: 'resource', model: { sourcePath: 'C:\\models\\motor.glb' } },
    context({ modelAsset: { sourceUrl: 'editor-asset://local/C%3A%2Fmodels%2Fmotor.glb?cache=2' } })), true);
  assert.equal(matchesLightingPolicyTarget({ kind: 'resource', model: { sourcePath: 'C:/models/motor.glb' } },
    context({ modelAsset: { sourcePath: 'D:/models/motor.glb' } })), false);
});

test('type只读真实类型，group使用祖先ID而不按名称猜测，循环层级可终止', () => {
  assert.equal(matchesLightingPolicyTarget({ kind: 'type', deviceType: 'stacker' }, context({ deviceType: 'stacker' })), true);
  assert.equal(matchesLightingPolicyTarget({ kind: 'type', deviceType: 'stacker' },
    context({ entity: { components: { telemetryBinding: { deviceType: 'generic' }, modelAsset: { sourcePath: 'stacker.glb' } } } })), false);
  const entities = { machine: { id: 'machine', parentId: 'inner' }, inner: { id: 'inner', parentId: 'outer', isFolder: true },
    outer: { id: 'outer', parentId: 'inner', isFolder: true } };
  assert.equal(matchesLightingPolicyTarget({ kind: 'group', folderId: 'outer' }, context({ entity: entities.machine, entities })), true);
  assert.equal(matchesLightingPolicyTarget({ kind: 'group', folderId: 'missing' }, context({ entity: entities.machine, entities })), false);
  assert.equal(matchesLightingPolicyTarget({ kind: 'group', folderId: 'outer' }, context({ ancestorIds: ['outer'] })), true);
});

test('场景默认在自动值之上，上方规则逐字段优先并返回准确来源', () => {
  const result = resolveSceneLightingPolicy(policy([
    rule('upper', { mobility: 'dynamic', castShadows: false }),
    rule('lower', { mobility: 'static', receiveShadows: false }),
  ], { bakeIndirect: false, receiveShadows: true }), context());
  assert.deepEqual(result.settings, { mobility: 'dynamic', castShadows: false, receiveShadows: false, bakeIndirect: false });
  assert.equal(result.fieldSources.mobility.ruleId, 'upper');
  assert.equal(result.fieldSources.receiveShadows.ruleId, 'lower');
  assert.equal(result.fieldSources.bakeIndirect.kind, 'scene-default');
  assert.deepEqual(result.matchedRuleIds, ['upper', 'lower']);
  assert.equal(result.motionRole, 'unknown');
  assert.ok(result.sourceLabel && result.reason);
});

test('批量解析器编译一份独立策略快照；草稿修改后重新编译才能采用新值', () => {
  const draft = policy([rule('first', { castShadows: false })], { receiveShadows: false });
  const resolve = createSceneLightingPolicyResolver(draft);
  draft.defaults.receiveShadows = true;
  draft.rules[0].values.castShadows = true;
  const compiled = resolve(context());
  assert.equal(compiled.settings.castShadows, false);
  assert.equal(compiled.settings.receiveShadows, false);
  assert.equal(createSceneLightingPolicyResolver(draft)(context()).settings.castShadows, true);
  compiled.settings.castShadows = true;
  compiled.fieldSources.receiveShadows.label = '不影响后续解析';
  assert.equal(resolve(context()).settings.castShadows, false);
  assert.equal(resolve(context()).fieldSources.receiveShadows.label, '场景默认');
});

test('批量节点规则仅索引一次冻结目录，存在和缺失判断的目录读取量随规模线性增长', () => {
  const size = 4_096, rows = 128;
  let reads = 0;
  const catalogue = new Proxy(Object.freeze(Array.from({ length: size }, (_, index) => `root/part[${index}]/thin:3`)), {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    },
  });
  const present = `root/part[${size - 1}]`;
  const p = policy([rule('bound', {}, { nodeRules: [
    { id: 'present', enabled: true, target: { kind: 'node', nodeKey: present, resourceIdentity: 'revision-1' }, values: { castShadows: false } },
    { id: 'missing', enabled: true, target: { kind: 'node', nodeKey: 'root/absent', resourceIdentity: 'revision-1' }, values: { bakeIndirect: false } },
  ] })]);
  const compiled = createSceneLightingPolicyResolver(p);
  for (let index = 0; index < rows; index++) {
    const result = compiled(context({ nodeKey: index % 2 ? present : 'root/part[0]', availableNodeKeys: catalogue }));
    assert.equal(result.settings.castShadows, index % 2 === 0);
    assert.equal(result.settings.bakeIndirect, true);
    assert.deepEqual(result.mismatches.map(issue => issue.nodeRuleId), ['missing']);
  }
  assert.ok(reads <= size + rows * 4, `目录读取 ${reads} 次，不应按每行重复扫描 ${size} 项`);
});

test('单次解析保持实时目录语义，编译批次的新目录与重新编译采用新快照', () => {
  const p = policy([rule('bound', {}, { nodeRules: [
    { id: 'part', enabled: true, target: { kind: 'node', nodeKey: 'root/rail[0]', resourceIdentity: 'revision-1' }, values: { castShadows: false } },
  ] })]);
  const catalogue = ['root/rail[0]'], input = context({ availableNodeKeys: catalogue });
  const compiled = createSceneLightingPolicyResolver(p);
  assert.equal(compiled(input).settings.castShadows, false);
  assert.equal(resolveSceneLightingPolicy(p, input).settings.castShadows, false);
  catalogue.splice(0, 1);
  assert.equal(resolveSceneLightingPolicy(p, input).mismatches[0].kind, 'missing-node');
  assert.equal(createSceneLightingPolicyResolver(p)(input).mismatches[0].kind, 'missing-node');
  assert.equal(compiled({ ...input, availableNodeKeys: [] }).mismatches[0].kind, 'missing-node');
});

test('部件规则仅用实际motionRole或稳定key；同规则内按字段优先且覆盖对象值', () => {
  const p = policy([rule('machine-rule', { mobility: 'dynamic', receiveShadows: true }, { nodeRules: [
    { id: 'part', enabled: true, target: { kind: 'node', nodeKey: 'root/rail[0]', resourceIdentity: 'revision-1' }, values: { receiveShadows: false } },
    { id: 'fixed', enabled: true, target: { kind: 'motion', role: 'fixed' }, values: { mobility: 'static', receiveShadows: true } },
  ] })]);
  const result = resolveSceneLightingPolicy(p, context({ nodeKey: 'root/rail[0]/instance:8', motionRole: 'fixed' }));
  assert.equal(result.settings.mobility, 'static');
  assert.equal(result.settings.receiveShadows, false);
  assert.equal(result.fieldSources.mobility.nodeRuleId, 'fixed');
  assert.equal(result.fieldSources.receiveShadows.nodeRuleId, 'part');
  assert.equal(resolveSceneLightingPolicy(p, context({ nodeKey: 'name-says-fixed', motionRole: 'unknown' })).settings.mobility, 'dynamic');
  assert.equal(normalizeLightingPolicyNodeKey('root/rail[0]/instance:8/thin:4'), 'root/rail[0]');
  assert.equal(normalizeLightingPolicyNodeKey('root/instance:business'), 'root/instance:business');
});

test('上方规则对象字段优先于下方规则的部件字段', () => {
  const p = policy([rule('upper', { mobility: 'dynamic' }), rule('lower', {}, { nodeRules: [
    { id: 'fixed', enabled: true, target: { kind: 'motion', role: 'fixed' }, values: { mobility: 'static' } },
  ] })]);
  assert.equal(resolveSceneLightingPolicy(p, context({ motionRole: 'fixed' })).settings.mobility, 'dynamic');
});

test('旧对象lighting组件是完整高优先级例外；缺少组件才全部继承策略', () => {
  const p = policy([], { mobility: 'static', castShadows: false, receiveShadows: false, bakeIndirect: false });
  const old = resolveSceneLightingPolicy(p, context({ automatic: { mobility: 'dynamic', reason: '实际运动' }, entityLighting: { mobility: 'auto' } }));
  assert.deepEqual(old.settings, { mobility: 'dynamic', castShadows: true, receiveShadows: true, bakeIndirect: true });
  assert.equal(old.fieldSources.mobility.kind, 'entity');
  assert.deepEqual(old.preservedExceptionFields, ['mobility', 'castShadows', 'receiveShadows', 'bakeIndirect']);
  assert.equal(resolveSceneLightingPolicy(p, context()).settings.castShadows, false);
});

test('显式undefined或null删除旧对象例外，只有缺省entityLighting才回退实体组件', () => {
  const base = context({ automatic: { mobility: 'dynamic', reason: '实际运动' }, entity: { components: {
    lighting: { mobility: 'static', castShadows: false, receiveShadows: false, bakeIndirect: false, nodeOverrides: {} },
  } } });
  const saved = JSON.stringify(base);
  const compiled = createSceneLightingPolicyResolver(undefined);
  assert.equal(resolveSceneLightingPolicy(undefined, base).settings.mobility, 'static');
  assert.equal(compiled(base).fieldSources.mobility.kind, 'entity');
  for (const deleted of [undefined, null]) {
    const restored = { ...base, entityLighting: deleted };
    for (const result of [resolveSceneLightingPolicy(undefined, restored), compiled(restored)]) {
      assert.deepEqual(result.settings, { mobility: 'dynamic', castShadows: true, receiveShadows: true, bakeIndirect: true });
      assert.equal(result.fieldSources.mobility.kind, 'automatic');
      assert.deepEqual(result.preservedExceptionFields, []);
    }
    const comparison = compareSceneLightingPolicies(undefined, policy([], { castShadows: false }), [restored]);
    assert.equal(comparison.rows[0].before.settings.mobility, 'dynamic');
    assert.equal(comparison.rows[0].after.settings.mobility, 'dynamic');
    assert.equal(comparison.rows[0].after.fieldSources.castShadows.kind, 'scene-default');
    assert.equal(comparison.preservedExceptionCount, 0);
  }
  assert.equal(JSON.stringify(base), saved);
});

test('对象逐字段恢复继承不会覆盖其它例外，normalizer保留明确继承标记', () => {
  const settings = normalizeEntityLightingSettings({ mobility: 'dynamic', castShadows: true, receiveShadows: true,
    inheritPolicy: ['receiveShadows', 'mobility', 'mobility', 'unsupported'], nodeOverrides: {} });
  assert.deepEqual(settings.inheritPolicy, ['mobility', 'receiveShadows']);
  assert.equal(Object.hasOwn(normalizeEntityLightingSettings({ mobility: 'auto' }), 'inheritPolicy'), false);
  const result = resolveSceneLightingPolicy(policy([], { mobility: 'static', castShadows: false, receiveShadows: false }), context({ entityLighting: settings }));
  assert.deepEqual(result.settings, { mobility: 'static', castShadows: true, receiveShadows: false, bakeIndirect: true });
  assert.equal(result.fieldSources.mobility.kind, 'scene-default');
  assert.equal(result.fieldSources.castShadows.kind, 'entity');
});

test('旧节点auto继承对象，新节点明确auto与继承mobility可区分', () => {
  const resolve = (node: unknown) => resolveSceneLightingPolicy(policy(), context({
    entityLighting: { mobility: 'dynamic', nodeOverrides: { 'root/rail[0]': node } },
  }));
  assert.equal(resolve({ mobility: 'auto' }).settings.mobility, 'dynamic');
  assert.equal(resolve({ mobility: 'auto', inheritPolicy: [] }).settings.mobility, 'static');
  assert.equal(resolve({ mobility: 'static', inheritPolicy: ['mobility'] }).settings.mobility, 'dynamic');
  const normalized = normalizeEntityLightingSettings({ nodeOverrides: { 'root/rail[0]': { mobility: 'auto', inheritPolicy: [] } } });
  assert.deepEqual(normalized.nodeOverrides['root/rail[0]'].inheritPolicy, []);
});

test('型号规则跨修订持续；稳定部件与旧对象节点例外必须精确资源绑定', () => {
  const p = policy([rule('model', { castShadows: false }, { target: { kind: 'resource', model: { identity } }, nodeRules: [
    { id: 'part', enabled: true, target: { kind: 'node', nodeKey: 'root/rail[0]', resourceIdentity: 'revision-1' }, values: { mobility: 'static' } },
  ] })]);
  const result = resolveSceneLightingPolicy(p, context({ modelAsset: { dataPlatformModel: identity }, resourceIdentity: 'revision-2',
    automatic: { mobility: 'dynamic', reason: '实际运动' } }));
  assert.equal(result.settings.castShadows, false);
  assert.equal(result.settings.mobility, 'dynamic');
  assert.deepEqual(result.matchedRuleIds, ['model']);
  assert.equal(result.mismatches[0].kind, 'resource-identity');
  assert.equal(result.mismatches[0].nodeRuleId, 'part');
  const old = resolveSceneLightingPolicy(undefined, context({ resourceIdentity: 'revision-2', entityLighting: {
    mobility: 'auto', resourceIdentity: 'revision-1', nodeOverrides: { 'root/rail[0]': { mobility: 'static', receiveShadows: false } },
  }, automatic: { mobility: 'dynamic', reason: '实际运动' } }));
  assert.equal(old.settings.mobility, 'dynamic');
  assert.equal(old.settings.receiveShadows, true);
  assert.equal(old.mismatches[0].kind, 'resource-identity');
});

test('稳定partKey不使用生成器运行时前缀，缺少节点仅在已知节点目录时报告', () => {
  const p = policy([rule('all', {}, { nodeRules: [
    { id: 'rail', enabled: true, target: { kind: 'node', nodeKey: 'root/rail[0]', resourceIdentity: 'revision-1' }, values: { castShadows: false } },
  ] })]);
  assert.equal(resolveSceneLightingPolicy(p, context({ nodeKey: 'generated/owner/member/primitive', partKey: 'root/rail[0]' })).settings.castShadows, false);
  assert.equal(resolveSceneLightingPolicy(p, context({ nodeKey: 'root/other[0]' })).mismatches.length, 0);
  assert.equal(resolveSceneLightingPolicy(p, context({ availableNodeKeys: ['root/other[0]'] })).mismatches[0].kind, 'missing-node');
});

test('动态祖先最终约束不会被规则或已有例外抵消，并返回冲突来源', () => {
  const result = resolveSceneLightingPolicy(policy([rule('force-static', { mobility: 'static' })]), context({ parentDynamic: true }));
  assert.equal(result.settings.mobility, 'dynamic');
  assert.equal(result.fieldSources.mobility.kind, 'ancestor');
  assert.equal(result.conflicts[0].field, 'mobility');
  assert.equal(result.conflicts[0].ruleId, 'force-static');
  assert.equal(resolveSceneLightingPolicy(undefined, context({ parentDynamic: true, entityLighting: { mobility: 'static' } })).settings.mobility, 'dynamic');
});

test('草稿影响计算不修改输入，按对象和部件去重并保留已有例外', () => {
  const contexts = [context(), context({ nodeKey: 'root/moving[0]', motionRole: 'moving' }),
    context({ entityId: 'exception', entityLighting: { mobility: 'dynamic', castShadows: false } })];
  const before = policy(), after = policy([], { receiveShadows: false });
  const saved = JSON.stringify([before, after, contexts]);
  const comparison = compareSceneLightingPolicies(before, after, contexts);
  assert.equal(comparison.affectedEntityCount, 1);
  assert.equal(comparison.affectedNodeCount, 2);
  assert.equal(comparison.preservedExceptionCount, 1);
  assert.deepEqual(comparison.rows[0].changedFields, ['receiveShadows']);
  assert.deepEqual(comparison.rows[2].changedFields, []);
  assert.equal(JSON.stringify([before, after, contexts]), saved);
});

test('比较按对象与资源修订聚合节点清单，生成器采用稳定partKey且显式清单优先', () => {
  const after = policy([rule('parts', {}, { nodeRules: [
    { id: 'rail', enabled: true, target: { kind: 'node', nodeKey: 'root/rail[0]', resourceIdentity: 'revision-1' }, values: { castShadows: false } },
  ] })]);
  const contexts = [
    context({ ownerEntityId: 'array', entityId: 'array:1', nodeKey: 'member/1/rail', partKey: 'root/rail[0]/thin:1' }),
    context({ ownerEntityId: 'array', entityId: 'array:2', nodeKey: 'member/2/motor', partKey: 'root/motor[0]' }),
    context({ ownerEntityId: 'other', nodeKey: 'root/motor[0]' }),
    context({ ownerEntityId: 'array', resourceIdentity: 'revision-2', nodeKey: 'root/motor[0]' }),
    context({ ownerEntityId: 'array', nodeKey: 'known-empty', partKey: 'root/rail[0]', availableNodeKeys: [] }),
  ];
  const saved = JSON.stringify(contexts);
  const comparison = compareSceneLightingPolicies(undefined, after, contexts);
  assert.equal(comparison.rows[0].after.settings.castShadows, false);
  assert.equal(comparison.rows[1].after.mismatches.length, 0);
  assert.equal(comparison.rows[2].after.mismatches[0].kind, 'missing-node');
  assert.equal(comparison.rows[3].after.mismatches[0].kind, 'resource-identity');
  assert.equal(comparison.rows[4].after.mismatches[0].kind, 'missing-node');
  assert.equal(JSON.stringify(contexts), saved);
});

function legacyScene() {
  return { name: 'legacy', entities: { a: { id: 'a', parentId: null, visible: true, components: {
    meshRenderer: { meshKind: 'cube' }, transform: { position: { x: 0, y: 0, z: 0 } },
    lighting: { mobility: 'static', castShadows: true, receiveShadows: true, bakeIndirect: true, nodeOverrides: {} },
  } } }, sceneSettings: { shadows: { mode: 'hybrid' }, lightingBake: {} } };
}

test('旧入口转换为v2签名，空策略不失效，名称和ID不hash而规则次序目标及字段进入hash', () => {
  const legacy = legacyScene();
  const migratedSignature = getSceneLightingBakeSignature(legacy);
  assert.match(migratedSignature, /^lighting-v2-/);
  assert.notEqual(migratedSignature, 'lighting-v1-887e62e60b51b72a', 'v1缺少真实填充输入戳，不能继续证明有效');
  assert.equal(getSceneLightingBakeSignature({ ...legacy, sceneSettings: { ...legacy.sceneSettings, lightingPolicy: policy() } }), migratedSignature);
  const current = { ...legacy, sceneSettings: { ...legacy.sceneSettings, lightingPolicy: policy([rule('a', { castShadows: false }), rule('b', { mobility: 'dynamic' })]) } };
  const hash = getSceneLightingBakeSignature(current);
  assert.notEqual(hash, getSceneLightingBakeSignature(legacy));
  current.sceneSettings.lightingPolicy.rules[0].name = '重命名';
  current.sceneSettings.lightingPolicy.rules[0].id = 'replacement-ui-id';
  assert.equal(getSceneLightingBakeSignature(current), hash);
  current.sceneSettings.lightingPolicy.rules.reverse();
  assert.notEqual(getSceneLightingBakeSignature(current), hash);
});

test('新策略确定为动态的实体姿态不进GI摘要，潜在静态部件和类型/分组条件仍参与', () => {
  const scene = { entities: { machine: { id: 'machine', parentId: null, visible: true, components: {
    modelAsset: { sourceUrl: 'C:/models/lift.glb' }, transform: { position: { x: 0, y: 0, z: 0 } },
  } } }, sceneSettings: { shadows: { mode: 'hybrid' }, lightingPolicy: policy([], { mobility: 'dynamic' }) } };
  const initial = getSceneLightingBakeSignature(scene);
  scene.entities.machine.components.transform.position.x = 4;
  assert.equal(getSceneLightingBakeSignature(scene), initial);
  assert.equal(requiresSceneLightingBake(scene), false);
  scene.sceneSettings.lightingPolicy.rules = [rule('parts', {}, { nodeRules: [
    { id: 'fixed', enabled: true, target: { kind: 'motion', role: 'fixed' }, values: { mobility: 'static' } },
  ] })];
  assert.equal(requiresSceneLightingBake(scene), true);
  const withFixed = getSceneLightingBakeSignature(scene);
  scene.entities.machine.components.transform.position.x = 7;
  assert.notEqual(getSceneLightingBakeSignature(scene), withFixed);
  scene.sceneSettings.lightingPolicy = policy([], { bakeIndirect: false });
  assert.equal(requiresSceneLightingBake(scene), false);
});
