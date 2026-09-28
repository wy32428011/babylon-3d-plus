import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpeningPackageBinding, validateOpeningPackageDefinition, validateOpeningPackageConfig, getOpeningPackageProblem } from '../../electron/shared/openingPackage.ts';
import { normalizeSceneOpeningAnimation } from '../../src/editor/model/sceneOpeningAnimation.ts';

const definition = () => ({
  manifest: { formatVersion: 1, runtimeApiVersion: 1, id: 'test.brand', version: '1.0.0', name: '品牌开场', renderer: 'timeline', assets: [] },
  schema: { type: 'object', properties: { title: { type: 'string', title: '标题' }, count: { type: 'number', minimum: 0 }, shown: { type: 'boolean' } } },
  uiSchema: { groups: [{ title: '文案', fields: ['title', 'count', 'shown'] }] },
  defaults: { title: '默认标题', count: 0, shown: false },
  timeline: { stages: [{ id: 'brand', label: '品牌', durationSeconds: 2, titleKey: 'title', routes: [] }], handoffSeconds: 0.4 },
});

test('导入定义校验并物化独立场景参数，保留零、关闭和空列表', () => {
  const source = validateOpeningPackageDefinition(definition());
  const first = createOpeningPackageBinding(source, '/project/Assets/OpeningPackages/test/manifest.json', 'a'.repeat(64));
  const second = createOpeningPackageBinding(source, first.manifestUrl, first.contentHash);
  first.config.values.title = '';
  first.config.stages[0].durationSeconds = 0;
  validateOpeningPackageConfig(source, first.config);
  assert.equal(second.config.values.title, '默认标题');
  assert.equal(second.config.stages[0].durationSeconds, 2);
  assert.equal(first.config.values.count, 0);
  assert.equal(first.config.values.shown, false);
  assert.deepEqual(first.config.stages[0].routes, []);
  const stored = normalizeSceneOpeningAnimation({ enabled: true, template: 'package', package: first });
  assert.equal(stored.template, 'package');
  assert.equal(stored.enabled, true);
  assert.deepEqual(stored.package, first);
});

test('拒绝主动脚本、路径逃逸、不兼容协议和坏分镜', () => {
  for (const path of ['../secret.png', '/abs.png', 'assets/../secret.png', 'https://host/p.png', 'assets/a.js']) {
    const value = definition();
    value.manifest.assets = [{ id: 'bg', path, type: 'image', size: 1, sha256: 'a'.repeat(64) }] as never[];
    assert.throws(() => validateOpeningPackageDefinition(value));
  }
  const future = definition(); future.manifest.runtimeApiVersion = 999;
  assert.throws(() => validateOpeningPackageDefinition(future), /版本/);
  const invalid = definition(); invalid.timeline.stages[0].durationSeconds = -1;
  assert.throws(() => validateOpeningPackageDefinition(invalid), /时长/);
});

test('未知或损坏包的配置仍保留，报告错误而不替换为地理模板', () => {
  const raw = { id: 'future', version: '9', contentHash: 'a'.repeat(64), manifestUrl: 'missing/manifest.json', definition: { future: true }, config: { values: { name: '保留我' }, stages: [] } };
  const settings = normalizeSceneOpeningAnimation({ enabled: true, template: 'package', package: raw });
  assert.equal(settings.template, 'package');
  assert.deepEqual(settings.package, raw);
  assert.ok(getOpeningPackageProblem(settings.package));
});

test('拒绝非法参数和越界飞线，字段不按真值补默认值', () => {
  const source = validateOpeningPackageDefinition(definition());
  const binding = createOpeningPackageBinding(source, 'project/assets/openings/test/manifest.json', 'a'.repeat(64));
  binding.config.values.count = -1;
  assert.throws(() => validateOpeningPackageConfig(source, binding.config));
  binding.config.values.count = 0;
  binding.config.stages[0].routes = [{ id: 'r', name: '目的地', from: { x: 0, y: 0 }, to: { x: 2, y: 1 } }];
  assert.throws(() => validateOpeningPackageConfig(source, binding.config), /坐标/);
});

test('完整文字、地图、字体、路线样式和素材替换可组合，损坏资源声明不能保存', () => {
  const raw: any = definition();
  raw.manifest.assets = [
    { id: 'map', path: 'assets/map.svg', type: 'image', size: 100, sha256: 'b'.repeat(64) },
    { id: 'font', path: 'assets/font.woff2', type: 'font', size: 100, sha256: 'c'.repeat(64) },
  ];
  raw.manifest.previewAssetId = 'map';
  raw.schema.properties.background = { type: 'string', format: 'asset' };
  raw.schema.properties.tint = { type: 'string', format: 'color' };
  raw.schema.properties.mode = { type: 'string', enum: ['one', 'two'], maxLength: 3 };
  raw.schema.required = ['title']; raw.schema.additionalProperties = false;
  raw.defaults = { ...raw.defaults, background: 'map', tint: '#00ffff', mode: 'one' };
  raw.timeline.stages[0] = { ...raw.timeline.stages[0], backgroundKey: 'background', backgroundColor: '#010203', logoAssetId: 'map',
    textStyle: { color: '#aabbcc', fontSize: 48, x: 0.5, y: 0.2, align: 'center', fontAssetId: 'font' },
    subtitleStyle: { fontSize: 24 }, zoomFrom: 1, zoomTo: 1.2, panX: -0.1, panY: 0.1, transitionSeconds: 0.4,
    origin: { x: 0, y: 0 }, routeStyle: { color: '#ffffff', width: 0, speed: 0, curvature: -0.2, trail: 0, pulse: false },
    routes: [{ id: 'r1', name: '目的地', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, width: 2, pulse: true }] };
  const source = validateOpeningPackageDefinition(raw);
  const binding = createOpeningPackageBinding(source, 'editor-asset://project/manifest.json', 'a'.repeat(64));
  binding.config.assetOverrides = { map: { assetUrl: 'editor-asset://project/custom.svg', size: 200, sha256: 'd'.repeat(64) } };
  assert.equal(getOpeningPackageProblem(binding), null);
  for (const mutate of [
    (b: typeof binding) => { b.config.values.tint = 'url(https://external)'; },
    (b: typeof binding) => { b.config.values.tint = '#12345'; },
    (b: typeof binding) => { b.config.values.background = 'missing'; },
    (b: typeof binding) => { b.config.values.mode = 'invalid'; },
    (b: typeof binding) => { b.config.assetOverrides!.map.sha256 = 'wrong'; },
    (b: typeof binding) => { b.config.assetOverrides!.map.assetUrl = 'javascript:alert(1)'; },
    (b: typeof binding) => { b.version = '2.0.0'; },
  ]) {
    const invalid = structuredClone(binding); mutate(invalid);
    assert.ok(getOpeningPackageProblem(invalid));
  }
});

test('拒绝重复素材、不支持的schema规则、重复分镜以及原型保留键', () => {
  const mutations = [
    (d: any) => { d.manifest.assets = [{ id: 'a', path: 'assets/a.png', type: 'image', size: 1, sha256: 'b'.repeat(64) }, { id: 'b', path: 'assets/A.png', type: 'image', size: 1, sha256: 'b'.repeat(64) }]; },
    (d: any) => { d.schema.properties.title.pattern = '.*'; },
    (d: any) => { d.schema.$ref = 'https://external/schema'; },
    (d: any) => { d.timeline.stages.push({ ...d.timeline.stages[0] }); },
    (d: any) => { d.schema.properties.title = { type: 'object' }; },
    (d: any) => { d.manifest.description = { invalid: '不能作为React子节点' }; },
    (d: any) => { d.schema.properties.title.description = { invalid: true }; },
    (d: any) => { d.defaults = JSON.parse('{"__proto__":{"polluted":true}}'); },
  ];
  for (const mutate of mutations) { const d = definition(); mutate(d); assert.throws(() => validateOpeningPackageDefinition(d)); }
});

test('场景素材替换后的总量也受预算约束，不能绕过包大小上限', () => {
  const raw: any = definition();
  raw.manifest.assets = Array.from({ length: 5 }, (_, i) => ({ id: `image-${i}`, path: `assets/image-${i}.png`, type: 'image', size: 10, sha256: 'a'.repeat(64) }));
  const source = validateOpeningPackageDefinition(raw);
  const binding = createOpeningPackageBinding(source, 'project/assets/openings/test/manifest.json', 'a'.repeat(64));
  binding.config.assetOverrides = Object.fromEntries(source.manifest.assets.map(asset => [asset.id, { assetUrl: `project/assets/${asset.id}.png`, size: 64 * 1024 * 1024, sha256: 'b'.repeat(64) }]));
  assert.match(getOpeningPackageProblem(binding)!, /替换后的素材总大小超限/);
});
