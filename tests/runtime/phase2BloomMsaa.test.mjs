import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import { DEFAULT_SCENE_APPEARANCE_CONFIG, normalizeSceneAppearanceConfig, normalizeSceneLightingConfig,
  getSceneAppearanceConfig } from '../../electron/shared/sceneLightingConfig.ts';
import { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';

const runtimeSource = await readFile(new URL('../../src/runtime/babylon/SceneAppearanceRuntime.ts', import.meta.url), 'utf8');
const uiSource = await readFile(new URL('../../src/editor/panels/LightingBakeManagerAppearance.tsx', import.meta.url), 'utf8');
function executable(source, filename, result) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  assert.equal(ast.parseDiagnostics.length, 0);
  const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast).replace(/^export /, '')).join('\n');
  return ts.transpileModule(body + '\n' + result, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React,
  } }).outputText;
}
const runtimeExecutable = executable(runtimeSource, 'SceneAppearanceRuntime.ts', '({SceneAppearanceRuntime,resolveBloomMsaaSamples});');
function observable() {
  const observers = new Set();
  return { observers, add(callback) { const token = { callback, remove() { observers.delete(token); } }; observers.add(token); return token; },
    remove(token) { return observers.delete(token); }, notify() { for (const token of [...observers]) token.callback(); } };
}
function fixture({ supportMSAA = true, maxSamples = 8 } = {}) {
  let maximum = maxSamples, capsReads = 0;
  const pipelines = [], before = observable(), restored = observable();
  const engine = { _features: { supportMSAA }, getCaps() { capsReads++; return { maxMSAASamples: maximum }; }, onContextRestoredObservable: restored };
  const image = { applyByPostProcess: false, exposure: 1, contrast: 1, toneMappingEnabled: false, toneMappingType: 0 };
  const color = { r: 0.1, g: 0.2, b: 0.3, a: 1, clone() { return { r: this.r, g: this.g, b: this.b, a: this.a }; },
    set(r, g, b, a) { Object.assign(this, { r, g, b, a }); }, copyFrom(value) { this.set(value.r, value.g, value.b, value.a); } };
  const scene = { clearColor: color, imageProcessingConfiguration: image, activeCamera: { name: 'camera-a' },
    onBeforeRenderObservable: before, getEngine: () => engine };
  class Pipeline {
    constructor() { this._samples = 1; this.sampleWrites = []; this.cameras = []; this.disposeCount = 0; pipelines.push(this); image.applyByPostProcess = true; }
    get samples() { return this._samples; }
    set samples(value) { this._samples = value; this.sampleWrites.push(value); }
    addCamera(camera) { this.cameras.push(camera); }
    removeCamera(camera) { this.cameras = this.cameras.filter(value => value !== camera); }
    dispose() { this.disposeCount++; }
  }
  const api = runInNewContext(runtimeExecutable, { DefaultRenderingPipeline: Pipeline,
    ImageProcessingConfiguration: { TONEMAPPING_ACES: 1 },
    Color3: { FromHexString(value) { return { r: parseInt(value.slice(1, 3), 16) / 255, g: parseInt(value.slice(3, 5), 16) / 255, b: parseInt(value.slice(5, 7), 16) / 255 }; } },
    refreshSceneLightingMaterialDrawCaches() {},
  });
  return { ...api, scene, engine, pipelines, before, restored, image, capsReads: () => capsReads,
    maxSamples: value => { maximum = value; }, runtime: new api.SceneAppearanceRuntime(scene) };
}
const config = patch => normalizeSceneAppearanceConfig({ bloomEnabled: true, ...patch });

test('旧appearance归一化/JSON输出不新增可选键，显式布尔才持久化', () => {
  assert.deepEqual(normalizeSceneAppearanceConfig(undefined), DEFAULT_SCENE_APPEARANCE_CONFIG);
  const legacy = normalizeSceneAppearanceConfig({ version: 1, exposure: 1.25, customFutureField: 'keep' });
  assert.equal(Object.hasOwn(legacy, 'bloomMsaaEnabled'), false);
  const before = JSON.stringify(legacy);
  assert.equal(JSON.stringify(normalizeSceneAppearanceConfig(JSON.parse(before))), before);
  for (const value of [true, false]) {
    const serialized = JSON.stringify(normalizeSceneAppearanceConfig({ ...legacy, bloomMsaaEnabled: value }));
    assert.equal(getSceneAppearanceConfig({ sceneSettings: { appearance: JSON.parse(serialized) } }).bloomMsaaEnabled, value);
  }
  for (const value of ['true', 1, null, undefined]) assert.equal(Object.hasOwn(normalizeSceneAppearanceConfig({ bloomMsaaEnabled: value }), 'bloomMsaaEnabled'), false);
});

test('Bloom MSAA只是显示配置，旧GI输入签名与结果引用不受开关影响', () => {
  const scene = { entities: {}, entityIds: [], sceneSettings: { lighting: normalizeSceneLightingConfig(undefined), appearance: normalizeSceneAppearanceConfig(undefined) } };
  const before = getSceneLightingBakeSignature(scene), oldJson = JSON.stringify(scene);
  for (const value of [true, false]) {
    const changed = { ...scene, sceneSettings: { ...scene.sceneSettings, appearance: config({ bloomMsaaEnabled: value }) } };
    assert.equal(getSceneLightingBakeSignature(changed), before);
  }
  assert.equal(JSON.stringify(scene), oldJson);
});

test('档位只取真实能力内的4/2/1，未知或不支持能力保持1', () => {
  const f = fixture();
  for (const [maximum, expected] of [[8, 4], [4, 4], [3, 2], [2, 2], [1, 1], [0, 1], [NaN, 1], [Infinity, 1]]) {
    assert.equal(f.resolveBloomMsaaSamples(true, true, maximum), expected);
  }
  assert.equal(f.resolveBloomMsaaSamples(false, true, 8), 1);
  assert.equal(f.resolveBloomMsaaSamples(true, false, 8), 1); f.runtime.dispose();
});

test('旧默认Bloom保持samples1与FXAA，不查询新能力或注册新上下文observer', () => {
  const f = fixture();
  f.runtime.sync(config()); f.runtime.sync(config({ bloomWeight: 0.2 }));
  assert.equal(f.pipelines.length, 1); assert.equal(f.pipelines[0].samples, 1);
  assert.equal(f.pipelines[0].fxaaEnabled, true); assert.deepEqual(f.pipelines[0].sampleWrites, []);
  assert.equal(f.capsReads(), 0); assert.equal(f.restored.observers.size, 0); f.runtime.dispose();
});

test('显式启用只修改同一Bloom管线，重复同步不重复set并保留相机切换', () => {
  const f = fixture(); f.runtime.sync(config({ bloomMsaaEnabled: true }));
  const pipeline = f.pipelines[0];
  assert.equal(pipeline.samples, 4); assert.deepEqual(pipeline.sampleWrites, [4]);
  assert.equal(f.runtime.getBloomMsaaState().reason, 'configured');
  f.runtime.sync(config({ bloomMsaaEnabled: true, bloomWeight: 0.4 }));
  assert.equal(f.pipelines.length, 1); assert.deepEqual(pipeline.sampleWrites, [4]);
  const nextCamera = { name: 'camera-b' }; f.scene.activeCamera = nextCamera; f.before.notify();
  assert.deepEqual(pipeline.cameras, [nextCamera]); assert.equal(pipeline.samples, 4);
  f.runtime.dispose(); assert.equal(pipeline.disposeCount, 1); assert.equal(f.before.observers.size, 0); assert.equal(f.restored.observers.size, 0);
});

test('上下文恢复重新核查能力，4可降至2/1且不冒称硬件成功', () => {
  const f = fixture(); f.runtime.sync(config({ bloomMsaaEnabled: true }));
  const pipeline = f.pipelines[0];
  f.maxSamples(3); f.restored.notify(); assert.equal(pipeline.samples, 2);
  f.maxSamples(1); f.restored.notify(); assert.equal(pipeline.samples, 1);
  assert.equal(f.runtime.getBloomMsaaState().reason, 'unsupported-hardware');
  f.maxSamples(8); f.restored.notify(); assert.equal(pipeline.samples, 4);
  assert.deepEqual(pipeline.sampleWrites, [4, 2, 1, 4]); f.runtime.dispose();
});

test('禁用回1，关闭Bloom释放原管线；再次开启创建新管线而非叠加', () => {
  const f = fixture(); f.runtime.sync(config({ bloomMsaaEnabled: true }));
  const first = f.pipelines[0]; f.runtime.sync(config({ bloomMsaaEnabled: false }));
  assert.equal(first.samples, 1); assert.equal(f.restored.observers.size, 0);
  f.runtime.sync(config({ bloomEnabled: false, bloomMsaaEnabled: true }));
  assert.equal(first.disposeCount, 1); assert.equal(f.runtime.getBloomMsaaState().active, false);
  assert.equal(f.image.applyByPostProcess, false); assert.equal(f.before.observers.size, 0);
  f.runtime.sync(config({ bloomMsaaEnabled: true })); assert.equal(f.pipelines.length, 2);
  assert.equal(f.pipelines[1].samples, 4); assert.equal(f.restored.observers.size, 1);
  f.runtime.dispose(); f.runtime.dispose(); assert.equal(f.pipelines[1].disposeCount, 1); assert.equal(f.restored.observers.size, 0);
});

test('不支持MSAA的引擎维持1采样和FXAA，能力恢复后可重新配置', () => {
  const f = fixture({ supportMSAA: false }); f.runtime.sync(config({ bloomMsaaEnabled: true }));
  const pipeline = f.pipelines[0]; assert.equal(pipeline.samples, 1); assert.equal(pipeline.fxaaEnabled, true);
  assert.deepEqual(pipeline.sampleWrites, []); assert.equal(f.runtime.getBloomMsaaState().reason, 'unsupported-hardware');
  f.engine._features.supportMSAA = true; f.maxSamples(2); f.restored.notify(); assert.equal(pipeline.samples, 2); f.runtime.dispose();
});

test('默认关闭不接管既有外部samples改值，禁用只还原自身仍拥有的等级', () => {
  const f = fixture(); f.runtime.sync(config()); const pipeline = f.pipelines[0];
  pipeline.samples = 8; f.runtime.sync(config()); assert.equal(pipeline.samples, 8);
  f.runtime.sync(config({ bloomMsaaEnabled: true })); assert.equal(pipeline.samples, 4);
  pipeline.samples = 2; f.runtime.sync(config({ bloomMsaaEnabled: false })); assert.equal(pipeline.samples, 2); f.runtime.dispose();
});

test('真实appearance控件使用受控草稿回调，Bloom未开或整窗禁用时不能操作', () => {
  const Toggle = () => null, Field = () => null;
  const code = executable(uiSource, 'LightingBakeManagerAppearance.tsx', 'LightingBakeManagerAppearance;');
  const Component = runInNewContext(code, { React, SCENE_THEME_PRESETS: [], LightingManagerToggle: Toggle,
    LightingManagerColorField: Field, LightingManagerNumberField: Field });
  const find = element => {
    if (!element || typeof element !== 'object') return null;
    if (element.type === Toggle && element.props.label === '泛光抗锯齿（MSAA）') return element;
    for (const child of React.Children.toArray(element.props?.children)) { const found = find(child); if (found) return found; }
    return null;
  };
  const initial = config(), changes = [];
  const toggle = find(Component({ appearance: initial, disabled: false, onChange: value => changes.push(value), onPreset() {} }));
  assert.ok(toggle); assert.equal(toggle.props.checked, false); assert.equal(toggle.props.disabled, false);
  toggle.props.onChange(true); assert.equal(changes[0].bloomMsaaEnabled, true); assert.equal(Object.hasOwn(initial, 'bloomMsaaEnabled'), false);
  for (const props of [{ appearance: config({ bloomEnabled: false }), disabled: false }, { appearance: config({ bloomMsaaEnabled: true }), disabled: true }]) {
    assert.equal(find(Component({ ...props, onChange() {}, onPreset() {} })).props.disabled, true);
  }
});
