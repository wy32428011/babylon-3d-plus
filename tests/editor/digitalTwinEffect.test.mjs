import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) {
      const candidate = new URL(specifier, context.parentURL);
      if (!existsSync(candidate) && existsSync(new URL(candidate.href + '.ts'))) return next(candidate.href + '.ts', context);
      if (!existsSync(candidate) && candidate.pathname.endsWith('.js') && existsSync(new URL(candidate.href.replace(/\.js$/, '.ts')))) return next(candidate.href.replace(/\.js$/, '.ts'), context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && !url.includes('/node_modules/') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const model = await import('../../src/editor/model/digitalTwinEffect.ts');
const poi = await import('../../src/editor/model/poiEffect.ts');
const registry = await import('../../src/editor/model/effectParameterRegistry.ts');
hooks.deregister();

test('新建生长特效默认完整单次播放，已有循环和显示上限保持用户配置', () => {
  const defaults = poi.createDefaultPoiEffectComponent('dissolve');
  assert.equal(defaults.visual.loop, false);
  assert.equal(defaults.visual.progress, 1);
  const existing = poi.sanitizePoiEffectComponent({ ...defaults, visual: { ...defaults.visual, loop: true, progress: 0.75 } });
  assert.equal(existing.visual.loop, true);
  assert.equal(existing.visual.progress, 0.75);
});

test('新版特效都有独立默认值，旧入口隐藏但旧场景类型保持有效', () => {
  assert.equal(model.DIGITAL_TWIN_EFFECT_DEFINITIONS.length, 37);
  for (const definition of model.DIGITAL_TWIN_EFFECT_DEFINITIONS) {
    const a = poi.createDefaultPoiEffectComponent(definition.kind);
    const b = poi.createDefaultPoiEffectComponent(definition.kind);
    assert.ok(a.visual);
    a.visual.points[0].x = 999;
    assert.notEqual(b.visual.points[0].x, 999);
    assert.equal(poi.sanitizePoiEffectComponent({ ...b, speed: 0 }).speed, 0);
    assert.equal(poi.isPoiEffectKind(definition.kind), true);
  }
  for (const kind of ['radar-scan', 'locator-beam', 'fire', 'smoke', 'pipeline-flow-particles']) {
    assert.equal(poi.isPoiEffectKind(kind), true);
    assert.equal(poi.VISIBLE_POI_EFFECT_DEFINITIONS.some(x => x.kind === kind), false);
  }
});

test('输送线可选的十种内置箭头均有库入口，其余旧特效继续隐藏', () => {
  assert.equal(poi.VISIBLE_POI_EFFECT_DEFINITIONS.length, 55);
  const counts = poi.VISIBLE_POI_EFFECT_DEFINITIONS.map(item => registry.getEffectParameterDefinitions(item.kind).length);
  assert.equal(counts.filter(count => count > 0).length, 46);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 330);
  for (const kind of ['conveyor-direction', 'moving-double-arrow', 'pipeline-flow-arrows', 'flow-arrows', 'conveyor-arrow-single', 'conveyor-arrow-chevron', 'conveyor-arrow-segmented', 'conveyor-arrow-ribbon', 'conveyor-arrow-double', 'conveyor-arrow-speed']) {
    assert.equal(poi.VISIBLE_POI_EFFECT_DEFINITIONS.filter(x => x.kind === kind).length, 1);
  }
});

test('配置拒绝无效路径与越界数据，有限参数归一化，不遗留无关字段', () => {
  const sanitized = model.sanitizeDigitalTwinEffectConfig({ radius: Infinity, opacity: 0, progress: 0, loop: false, points: [], values: [NaN, 2], labels: ['A'], targetEntityId: 'x', duration: -1 }, 'flow-path');
  assert.equal(sanitized.opacity, 0);
  assert.equal(sanitized.progress, 0);
  assert.equal(sanitized.loop, false);
  assert.ok(Number.isFinite(sanitized.radius));
  assert.ok(sanitized.duration > 0);
  assert.ok(sanitized.points.length >= 2);
  assert.ok(sanitized.values.every(Number.isFinite));
  assert.throws(() => model.validateDigitalTwinEffectConfig({ ...sanitized, points: [{x:0,y:0,z:0}] }, 'flow-path'), /路径/);
  assert.throws(() => model.validateDigitalTwinEffectConfig({ ...sanitized, points: [{x:0,y:0,z:0},{x:2,y:0,z:2},{x:0,y:0,z:2},{x:2,y:0,z:0}] }, 'area-fill'), /轮廓/);
  assert.throws(() => model.validateDigitalTwinEffectConfig({ ...sanitized, values: Array(65).fill(1) }, 'heatmap'), /64/);
});
