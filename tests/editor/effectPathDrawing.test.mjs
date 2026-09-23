import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
const root = new URL('../../src/', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) { if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) { const path = new URL(specifier, context.parentURL); if (!existsSync(path) && existsSync(new URL(path.href + '.ts'))) return next(path.href + '.ts', context); } return next(specifier, context); },
  load(url, context, next) { return url.startsWith(root.href) && url.endsWith('.ts') ? { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText } : next(url, context); },
});
const drawing = await import('../../src/editor/model/effectPathDrawing.ts');
const { createDefaultPoiEffectComponent } = await import('../../src/editor/model/poiEffect.ts');
hooks.deregister();
test.afterEach(() => drawing.cancelEffectPathDrawing());
const append = (x, y, z) => drawing.appendEffectPathDrawingPoint({ x, y, z }, { x, y, z });

test('绘制草稿不修改配置，提交一次产生新组件，取消丢弃草稿', () => {
  const c = createDefaultPoiEffectComponent('flow-path'); const before = structuredClone(c); let notices = 0;
  const off = drawing.subscribeEffectPathDrawing(() => notices++);
  drawing.startEffectPathDrawing('effect', c.effectKind); append(1, 0, 2); append(3, 0, 4);
  assert.deepEqual(c, before); assert.equal(drawing.getEffectPathDrawing().points.length, 2);
  const next = drawing.commitEffectPathDrawing(c); assert.deepEqual(next.visual.points, [{ x: 1, y: 0, z: 2 }, { x: 3, y: 0, z: 4 }]); assert.equal(drawing.getEffectPathDrawing(), null);
  assert.equal(drawing.commitEffectPathDrawing(c), null); assert.ok(notices >= 4); off();
  drawing.startEffectPathDrawing('effect', c.effectKind); append(8, 0, 7); drawing.cancelEffectPathDrawing(); assert.deepEqual(c, before);
});

test('点数、有限值、重复点和自交均受约束，可撤销最后一点恢复有效路径', () => {
  const c = createDefaultPoiEffectComponent('flow-arrows'); drawing.startEffectPathDrawing('a', c.effectKind);
  assert.equal(drawing.commitEffectPathDrawing(c), null); assert.match(drawing.getEffectPathDrawing().error, /至少|2/);
  assert.equal(append(Infinity, 0, 1), false); assert.equal(drawing.getEffectPathDrawing().points.length, 0);
  append(0, 0, 0); assert.equal(append(0, 0, 0), false); append(2, 0, 2); append(0, 0, 2); append(2, 0, 0);
  assert.equal(drawing.commitEffectPathDrawing(c), null); assert.match(drawing.getEffectPathDrawing().error, /自交|重叠/);
  drawing.undoEffectPathDrawingPoint(); assert.ok(drawing.commitEffectPathDrawing(c));
});

test('轮廓闭合边也必须检查，光墙只写X/Z且保留高度透明度', () => {
  const c = createDefaultPoiEffectComponent('light-wall-fence'); c.lightWall.height = 8;
  drawing.startEffectPathDrawing('wall', c.effectKind); append(0, 0, 0); append(3, 0, 0); append(3, 0, 2); append(0, 0, 2);
  const next = drawing.commitEffectPathDrawing(c); assert.equal(next.lightWall.height, 8); assert.deepEqual(next.lightWall.points, [{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 2 }, { x: 0, z: 2 }]);
  drawing.startEffectPathDrawing('area', 'area-fill'); append(0, 0, 0); append(2, 0, 2); append(0, 0, 2); append(2, 0, 0);
  assert.equal(drawing.commitEffectPathDrawing(createDefaultPoiEffectComponent('area-fill')), null);
});

test('水域绘制启用多边形，区域绘制只替换指定ID并保留其数值', () => {
  const water = createDefaultPoiEffectComponent('water-surface'); drawing.startEffectPathDrawing('water', water.effectKind);
  append(0, 0, 0); append(2, 0, 0); append(0, 0, 2); const nextWater = drawing.commitEffectPathDrawing(water);
  assert.equal(nextWater.configuration.parameters.usePolygon, true);
  const region = createDefaultPoiEffectComponent('region-level'); region.configuration = { version: 2, parameters: { regions: [{ id: 'A', name: '仓储', value: 12, points: [] }, { id: 'B', name: '车间', value: 8, points: [] }] } };
  drawing.startEffectPathDrawing('region', region.effectKind, 'A'); append(0, 0, 0); append(2, 0, 0); append(0, 0, 2);
  const next = drawing.commitEffectPathDrawing(region); assert.equal(next.configuration.parameters.regions[0].value, 12); assert.equal(next.configuration.parameters.regions[0].points.length, 3); assert.deepEqual(next.configuration.parameters.regions[1], region.configuration.parameters.regions[1]);
});

test('更换类型拒绝提交，超过128点拒绝追加，错误可显示并取消', () => {
  drawing.startEffectPathDrawing('path', 'flow-path');
  for (let i = 0; i < 128; i++) assert.equal(append(i, 0, 0), true);
  assert.equal(append(129, 0, 0), false); assert.equal(drawing.getEffectPathDrawing().points.length, 128);
  assert.equal(drawing.commitEffectPathDrawing(createDefaultPoiEffectComponent('area-fill')), null);
  drawing.setEffectPathDrawingError('场景未就绪'); assert.equal(drawing.getEffectPathDrawing().error, '场景未就绪');
});
