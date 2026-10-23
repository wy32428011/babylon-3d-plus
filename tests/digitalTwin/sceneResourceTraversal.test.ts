import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectLightingPolicyResourceModels,
  collectLocalSceneResourceFields,
  collectSceneResourceReferences,
  collectSceneSkyboxReferences,
  mapSceneResourceValues,
  sceneResourceFieldKind,
  visitSceneResourceValues,
} from '../../electron/shared/sceneResourceTraversal.ts';

function resourceScene() {
  const asset = (id: string) => ({ sourcePath: id, sourceUrl: `editor-asset://local/${id}?v=7#mesh` });
  const target = (id: string) => ({ kind: 'model', modelAsset: asset(id) });
  const components = {
    modelAsset: asset('ordinary'), manualRoamSpawn: { avatar: asset('avatar') },
    modelGenerator: { packagePath: 'generator-package', defaultTarget: target('default'),
      rules: [{ target: { ...target('rule'), packagePath: 'rule-package' } }, { target: { kind: 'mesh' } }] },
    alarmManager: { appearanceModel: target('alarm'), targets: [{ model: target('alarm-slot') }] },
    clickEventBinding: { deviceSlots: [{ deviceType: asset('device') }, { deviceType: null }] },
    skybox: asset('entity-sky'), cadReference: asset('cad'), imageAsset: asset('image'),
  };
  return { entities: { first: { components } }, sceneSettings: {
    environment: { variants: [asset('environment-0'), asset('environment-1')], activeVariantUrl: 'environment-1?v=7' },
    skybox: asset('settings-sky'),
  } };
}

test('天空盒预检只枚举自有数据位置，保留身份描述符且不执行自身或继承 getter', () => {
  let getterCalls = 0;
  const ownAccessor = Object.defineProperty({ sourcePath: 'own.hdr' }, 'dataPlatformResourceId', {
    enumerable: true, get() { getterCalls++; return '1'; },
  });
  const inherited = Object.create(Object.defineProperty({}, 'dataPlatformResourceId', {
    enumerable: true, get() { getterCalls++; return '2'; },
  }));
  const healthy = { sourcePath: 'healthy.hdr', dataPlatformResourceId: '3' };
  const scene = { entities: {
    own: { components: { skybox: ownAccessor } }, inherited: { components: { skybox: inherited } },
  }, sceneSettings: { skybox: healthy }, parameterValues: { skybox: { dataPlatformResourceId: 'business-text' } } };
  const references = collectSceneSkyboxReferences(scene);
  assert.deepEqual(references, [ownAccessor, inherited, healthy]);
  assert.equal(getterCalls, 0);
  assert.equal(Object.getOwnPropertyDescriptor(references[0], 'dataPlatformResourceId')?.get,
    Object.getOwnPropertyDescriptor(ownAccessor, 'dataPlatformResourceId')?.get);
  assert.equal(Object.getOwnPropertyDescriptor(references[1], 'dataPlatformResourceId'), undefined);
  assert.equal(references[2].dataPlatformResourceId, '3');
  assert.equal(Object.hasOwn(references[2], 'dataPlatformResourceId'), true);
  const containerAccessor = Object.defineProperty({}, 'sceneSettings', { get() { getterCalls++; throw new Error('must not execute'); } });
  assert.deepEqual(collectSceneSkyboxReferences(containerAccessor), []);
  assert.equal(getterCalls, 0);
});

test('严格发布收集全部资源位置，保持先报警后生成器的校验与枚举顺序', () => {
  const scene = resourceScene(), refs = collectSceneResourceReferences(scene, 'strict');
  assert.deepEqual(refs.models.map(({ asset }) => asset.sourcePath), ['ordinary', 'avatar', 'alarm', 'alarm-slot', 'default', 'rule']);
  assert.deepEqual(refs.models.map(({ clickTarget }) => clickTarget), [true, false, false, false, true, true]);
  assert.equal(refs.models[4].packageOwner, scene.entities.first.components.modelGenerator);
  assert.equal(refs.models[5].packageOwner, scene.entities.first.components.modelGenerator.rules[0].target);
  assert.equal(refs.models[0].asset, scene.entities.first.components.modelAsset);
  assert.equal(refs.models[2].target, scene.entities.first.components.alarmManager.appearanceModel);
  assert.deepEqual(refs.skyboxes.map(({ skybox }) => skybox.sourcePath), ['entity-sky', 'settings-sky']);
  assert.equal(refs.environments[0].environment, scene.sceneSettings.environment);
  assert.equal(refs.environments[0].variants[1], scene.sceneSettings.environment.variants[1]);
  assert.equal(refs.clickEventBindings[0].deviceType, scene.entities.first.components.clickEventBinding.deviceSlots[0].deviceType);
  assert.deepEqual(refs.entityResources.map(({ value, kind }) => [value.sourcePath, kind]), [['entity-sky', 'skybox'], ['cad', 'other'], ['image', 'other']]);
});

test('宽容恢复保留先生成器后报警的顺序，跳过无效旧节点且保持原对象引用', () => {
  const scene = resourceScene();
  const refs = collectSceneResourceReferences({ ...scene, entities: {
    bad: null, missing: {}, ...scene.entities, invalid: { components: { modelAsset: null,
      modelGenerator: { defaultTarget: { kind: 'future' }, rules: [null, { target: [] }] },
      alarmManager: { targets: [null] }, clickEventBinding: { deviceSlots: [null, { deviceType: [] }] } } },
  } });
  assert.deepEqual(refs.models.map(({ asset }) => asset.sourcePath), ['ordinary', 'avatar', 'default', 'rule', 'alarm', 'alarm-slot']);
  assert.equal(refs.models[0].asset, scene.entities.first.components.modelAsset);
  assert.equal(collectSceneResourceReferences(undefined).models.length, 0);
});

test('严格模式保留上下文错误、空环境拒绝与目标类型拒绝', () => {
  const check = (value: unknown, expected: string) => assert.throws(() => collectSceneResourceReferences(value, 'strict'), { message: expected });
  check({}, 'scene.entities格式不正确。');
  check({ entities: { bad: {} } }, '实体 bad components格式不正确。');
  check({ entities: { a: { components: { modelGenerator: { defaultTarget: { kind: 'unknown' } } } } } }, '实体 a 默认生成目标类型不受支持。');
  check({ entities: { a: { components: { alarmManager: {}, modelGenerator: {} } } } }, '报警目标格式不正确。');
  check({ entities: { a: { components: { clickEventBinding: { deviceSlots: [{ deviceType: 5 }] } } } } }, '实体 a 设备类型槽位 1格式不正确。');
  check({ entities: {}, sceneSettings: { environment: { variants: [] } } }, '环境配置至少需要一个变体。');
  check({ entities: {}, sceneSettings: { environment: { variants: [null] } } }, '环境 variants[0]格式不正确。');
});

test('光照规则只返回 resource.model，身份提示由恢复策略明确排除', () => {
  const pathRule = { sourcePath: 'Z:/cache/model.glb' }, identityRule = { identity: { resourceId: '1' }, sourceUrl: 'old-address' };
  const scene = { sceneSettings: { lighting: { policy: { rules: [null,
    { target: { kind: 'resource', model: pathRule } }, { target: { kind: 'resource', model: identityRule } },
    { target: { kind: 'entity', model: { sourcePath: 'text' } } },
  ] } } } };
  assert.deepEqual(collectLightingPolicyResourceModels(scene), [pathRule, identityRule]);
  assert.deepEqual(collectLightingPolicyResourceModels(scene, false), [pathRule]);
  assert.equal(collectLightingPolicyResourceModels(scene)[0], pathRule);
});

test('本地字段枚举保留目录/可选缩略图规则，脚本变体共享同一资源拥有者', () => {
  const owner = { sourcePath: 'model.glb', packagePath: 'package', sourceUrl: 'model?v=7#mesh', thumbnailPath: 'thumb',
    thumbnailUrl: 'thumb-url', scriptPaths: ['one.ts', null, 'two.ts'],
    scriptAssets: [{ path: 'script.ts', packagePath: 'script-package', scriptAssets: [{ sourceUrl: 'nested.ts' }] }],
    variants: [{ sourcePath: 'variant.glb', packagePath: 'variant-package' }],
    parameterValues: { sourcePath: 'ordinary-text' }, manifestUrl: 'owned-elsewhere', assetUrl: 'owned-elsewhere' };
  const fields = collectLocalSceneResourceFields(owner);
  const read = (field: typeof fields[number]) => (field.parent as Record<string, unknown>)[field.key];
  assert.deepEqual(fields.map(read), ['model.glb', 'package', 'thumb', 'model?v=7#mesh', 'thumb-url', 'one.ts', 'two.ts',
    'script.ts', 'script-package', 'nested.ts', 'variant.glb', 'variant-package']);
  assert.deepEqual(fields.filter(field => field.directory).map(read), ['package']);
  assert.deepEqual(fields.filter(field => !field.required).map(read), ['thumb', 'thumb-url']);
  assert.equal(fields.find(field => read(field) === 'two.ts')?.key, 2);
  assert.equal(fields.find(field => read(field) === 'variant.glb')?.parent, owner.variants[0]);
});

test('字段契约不把任意参数文本当路径，明确区分 URL、路径和脚本数组', () => {
  assert.deepEqual(['sourcePath', 'packagePath', 'path', 'sourceUrl', 'manifestUrl', 'assetUrl', 'scriptPaths', 'parameterValues', null]
    .map(sceneResourceFieldKind), ['path', 'path', 'path', 'url', 'url', 'url', 'path-array', null, null]);
});

test('遍历保留数组资源字段、JSON 路径与顺序，可跳过固定版本子树', () => {
  const fixed = { sourcePath: 'fixed-package' };
  const scene = { scriptPaths: ['first', 'second'], items: [{ sourceUrl: 'model?v=7#node' }], fixed };
  const values: unknown[] = [];
  visitSceneResourceValues(scene, (value, location) => {
    if (value === fixed) return false;
    if (typeof value === 'string') values.push([value, location.field, location.path, location.parent === scene.scriptPaths, location.key]);
  });
  assert.deepEqual(values, [['first', 'scriptPaths', 'scene.scriptPaths.0', true, 0],
    ['second', 'scriptPaths', 'scene.scriptPaths.1', true, 1], ['model?v=7#node', 'sourceUrl', 'scene.items.0.sourceUrl', false, 'sourceUrl']]);
});

test('副本改写保留原文档、普通字符串、数组顺序、空值与数值，并允许专属资源分支', () => {
  const fixed = { sourceUrl: 'fixed-url', untouched: 'ordinary' };
  const scene = { sourcePath: 'old', text: 'old', scriptPaths: ['old', null, 0, false], fixed };
  const original = structuredClone(scene);
  const mapped = mapSceneResourceValues(scene, {
    string: (value, field) => sceneResourceFieldKind(field) ? value + '?v=7#node' : value,
    object: (value, _field, mapChild) => value === fixed ? { ...value, sourceUrl: 'fixed-version' }
      : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapChild(child, key)])),
  });
  assert.deepEqual(mapped, { sourcePath: 'old?v=7#node', text: 'old', scriptPaths: ['old?v=7#node', null, 0, false], fixed: { ...fixed, sourceUrl: 'fixed-version' } });
  assert.deepEqual(scene, original);
  assert.notEqual(mapped, scene);
});
