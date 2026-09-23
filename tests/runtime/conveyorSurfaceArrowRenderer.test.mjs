import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';

const sourceRoot = new URL('../../src/', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href)) {
      const candidate = new URL(specifier, context.parentURL);
      if (!existsSync(candidate) && existsSync(new URL(candidate.href + '.ts'))) return next(candidate.href + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return next(url, context);
  },
});
const { ConveyorSurfaceArrowRenderer } = await import('../../src/runtime/babylon/effects/ConveyorSurfaceArrowRenderer.ts');
const { createDefaultConveyorSurfaceArrowsConfig } = await import('../../src/editor/model/conveyorSurfaceArrows.ts');
hooks.deregister();
const { Constants, NullEngine, Scene, TransformNode, MeshBuilder, Vector3 } = await import('@babylonjs/core');

function setup(t, scale = 1) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  // Babylon 在首次创建/释放 Mesh 时惰性初始化默认材质，排除它对资源计数的干扰。
  void scene.defaultMaterial;
  const root = new TransformNode('model-root', scene);
  const contentRoot = new TransformNode('model-content', scene);
  contentRoot.parent = root;
  contentRoot.scaling.setAll(scale);
  const surface = MeshBuilder.CreateBox('belt', { width: 6 / scale, height: 0.4 / scale, depth: 1.2 / scale }, scene);
  surface.parent = contentRoot;
  surface.position.y = 0.8 / scale;
  const model = {
    root, contentRoot, meshes: [surface], sourceUrl: 'test', assetRevision: null, assetSignature: 'asset-1',
    loadToken: 1, parameterSignature: '', externalScriptSignature: '', externalScriptRuntime: null,
    entitySnapshot: { components: { modelAsset: { unitScaleToMeters: scale, dataDrivenConfig: {
      device: { devType: 'conveyor' }, fixedNodes: [], cargo: { travel: { axis: 'x', nodes: ['belt'] } },
    } } } },
  };
  const renderer = new ConveyorSurfaceArrowRenderer(scene);
  model.externalScriptRuntime = { getDataDrivenConfigs: () => [model.entitySnapshot.components.modelAsset.dataDrivenConfig] };
  t.after(() => { renderer.dispose(); scene.dispose(); engine.dispose(); });
  const config = { ...createDefaultConveyorSurfaceArrowsConfig(), enabled: true };
  return { scene, model, root, contentRoot, surface, renderer, config };
}
function arrow(scene, id = 'one') {
  return scene.meshes.find(mesh => mesh.name === `__conveyorSurfaceArrows_${id}`);
}
function near(actual, expected, message = '') {
  assert.ok(Math.abs(actual - expected) < 1e-5, `${message}: ${actual} != ${expected}`);
}
function point(mesh, x = 0, z = 0) {
  mesh.computeWorldMatrix(true);
  return Vector3.TransformCoordinates(new Vector3(x, 0, z), mesh.getWorldMatrix());
}

test('自动表面优先脚本链面高度，独立网格不污染模型测量且保留深度遮挡', t => {
  const { scene, model, renderer, config, contentRoot } = setup(t);
  contentRoot.metadata = { conveyorSurfaceY: 0.75 };
  assert.equal(renderer.update('one', model, config, 1, 0, true), null);
  const mesh = arrow(scene);
  near(point(mesh).y, 0.765);
  near(Vector3.Distance(point(mesh, -.5), point(mesh, .5)), 5.76);
  assert.equal(model.root.getChildMeshes().includes(mesh), false);
  assert.equal(mesh.isPickable, false);
  assert.equal(mesh.material.disableDepthWrite, true);
  assert.equal(mesh.material.depthFunction, Constants.LEQUAL);
  assert.equal(mesh.renderingGroupId, 0);
});

test('指定表面节点按原生单位换算局部米，并完整跟随倾斜、非均匀缩放和镜像', t => {
  const { scene, model, root, surface, renderer, config } = setup(t, .001);
  config.surfaceNode = 'belt';
  config.length = 2;
  config.width = .8;
  config.endMargin = 0;
  config.surfaceOffset = .03;
  surface.rotation.z = .4;
  root.scaling.set(-1.5, .8, 2);
  root.rotation.y = .7;
  root.position.set(5, 2, -3);
  assert.equal(renderer.update('one', model, config, 1, 0, true), null);
  const expected = Vector3.TransformCoordinates(new Vector3(0, 230, 0), surface.computeWorldMatrix(true));
  assert.ok(Vector3.Distance(point(arrow(scene)), expected) < 1e-5);
  const before = point(arrow(scene));
  surface.rotation.z = -.3;
  root.position.x += 2;
  renderer.update('one', model, config, 1, .1, true);
  const after = Vector3.TransformCoordinates(new Vector3(0, 230, 0), surface.computeWorldMatrix(true));
  assert.ok(Vector3.Distance(point(arrow(scene)), after) < 1e-5);
  assert.ok(Vector3.Distance(before, after) > 1);
});

test('阵列代理用宿主几何映射到自身位姿，源 root 隐藏不影响箭头显隐', t => {
  const { scene, model, root, renderer, config } = setup(t);
  root.position.set(20, 5, -8); root.rotation.y = .7; root.setEnabled(false);
  const proxyRoot = new TransformNode('proxy-root', scene);
  proxyRoot.position.set(-4, 3, 10); proxyRoot.rotation.z = .3; proxyRoot.scaling.x = -2;
  const proxy = { ...model, root: proxyRoot, meshes: [], telemetryProxySource: model };
  assert.equal(renderer.update('one', proxy, config, -1, 0, true), null);
  const expected = Vector3.TransformCoordinates(new Vector3(0, 1.015, 0), proxyRoot.computeWorldMatrix(true));
  assert.ok(Vector3.Distance(point(arrow(scene)), expected) < 1e-5);
  assert.equal(arrow(scene).isEnabled(), true);
  renderer.update('one', proxy, config, -1, .1, false);
  assert.equal(arrow(scene).isEnabled(), false);
});

test('表面节点缺失或重名明确诊断并隐藏旧箭头，不静默落回整个模型', t => {
  const { scene, model, surface, renderer, config } = setup(t);
  renderer.update('one', model, config, 1, 0, true);
  config.surfaceNode = 'missing';
  assert.match(renderer.update('one', model, config, 1, 0, true), /未找到/);
  assert.equal(arrow(scene).isEnabled(), false);
  surface.clone('belt', model.contentRoot);
  config.surfaceNode = 'belt';
  model.parameterSignature = 'changed';
  assert.match(renderer.update('one', model, config, 1, 0, true), /不唯一|重名/);
});

test('修改参数和资源后重新测量，自定义布局留边且零/退化面积隐藏', t => {
  const { scene, model, surface, renderer, config } = setup(t);
  renderer.update('one', model, config, 1, 0, true);
  surface.scaling.x = 2;
  model.parameterSignature = 'size-2';
  renderer.update('one', model, config, 1, 0, true);
  near(Vector3.Distance(point(arrow(scene), -.5), point(arrow(scene), .5)), 11.76);
  config.length = 3; config.width = .5; config.endMargin = .2; config.offsetAlong = .4; config.offsetAcross = .1;
  renderer.update('one', model, config, 1, 0, true);
  near(Vector3.Distance(point(arrow(scene), -.5), point(arrow(scene), .5)), 2.6);
  near(point(arrow(scene)).x, .4); near(point(arrow(scene)).z, .1);
  config.endMargin = 10;
  assert.match(renderer.update('one', model, config, 1, 0, true), /长度|留边|面积/);
  assert.equal(arrow(scene).isEnabled(), false);
});

test('方向同时传入朝向和流动，零速度静止，停机隐藏并复用同一网格', t => {
  const { scene, model, renderer, config } = setup(t);
  renderer.update('one', model, config, 1, .1, true);
  const mesh = arrow(scene);
  const phase = mesh.material._floats.phase;
  assert.ok(phase > 0);
  assert.equal(mesh.material._floats.direction, 1);
  renderer.update('one', model, config, -1, .1, true);
  assert.equal(mesh.material._floats.direction, -1);
  assert.notEqual(mesh.material._floats.phase, phase);
  config.speed = 0;
  const stoppedPhase = mesh.material._floats.phase;
  renderer.update('one', model, config, -1, .1, true);
  near(mesh.material._floats.phase, stoppedPhase);
  renderer.update('one', model, config, 0, .1, true);
  assert.equal(mesh.isEnabled(), false);
  assert.equal(arrow(scene), mesh);
});

test('retain/clear/dispose 完整释放独立 mesh、root、材质，且无逐帧 Observer', t => {
  const { scene, model, renderer, config } = setup(t);
  const initial = [scene.meshes.length, scene.transformNodes.length, scene.materials.length, scene.onBeforeRenderObservable.observers.length];
  renderer.update('one', model, config, 1, 0, true);
  renderer.update('two', model, config, -1, 0, true);
  const one = arrow(scene), two = arrow(scene, 'two');
  renderer.retain(new Set(['two']));
  assert.equal(one.isDisposed(), true); assert.equal(two.isDisposed(), false);
  renderer.clear(); renderer.dispose();
  assert.deepEqual([scene.meshes.length, scene.transformNodes.length, scene.materials.length, scene.onBeforeRenderObservable.observers.length], initial);
});

test('重名表面可用完整或尾部节点路径消歧', t => {
  const { scene, model, surface, renderer, config } = setup(t);
  const branch = new TransformNode('upper', scene); branch.parent = model.contentRoot;
  const other = surface.clone('belt', branch); other.position.y = 3;
  config.surfaceNode = 'upper/belt';
  assert.equal(renderer.update('one', model, config, 1, 0, true), null);
  near(point(arrow(scene)).y, 3.215);
  config.surfaceNode = 'model-root/model-content/upper/belt';
  assert.equal(renderer.update('one', model, config, 1, 0, true), null);
  near(point(arrow(scene)).y, 3.215);
});

test('自动尺寸包含参数化源节点别名并排除已有箭头装饰', t => {
  const { scene, model, surface, renderer, config } = setup(t);
  surface.name = 'generated-part';
  surface.metadata = { generatedByParametricRuntime: true, motionSourceNodeName: 'belt' };
  const decorationRoot = new TransformNode('old-direction-visual', scene);
  decorationRoot.parent = model.contentRoot;
  decorationRoot.metadata = { directionArrowVisual: true };
  const decoration = MeshBuilder.CreateBox('belt', { size: 100 }, scene);
  decoration.parent = decorationRoot;
  renderer.update('one', model, config, 1, 0, true);
  near(Vector3.Distance(point(arrow(scene), -.5), point(arrow(scene), .5)), 5.76);
  near(point(arrow(scene)).y, 1.015);
  assert.deepEqual(arrow(scene).metadata, { conveyorSurfaceArrow: true, entityId: 'one' });
});

test('z 行走轴和 thinInstance 几何使用单机范围，不含整批矩阵包围盒', t => {
  const { scene, model, surface, renderer, config } = setup(t);
  model.entitySnapshot.components.modelAsset.dataDrivenConfig.cargo.travel.axis = 'z';
  surface.thinInstanceSetBuffer('matrix', new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 100, 1,
  ]), 16);
  renderer.update('one', model, config, 1, 0, true);
  const mesh = arrow(scene);
  near(Vector3.Distance(point(mesh, -.5), point(mesh, .5)), .96);
  near(Vector3.Distance(point(mesh, 0, -.5), point(mesh, 0, .5)), 6);
});

test('四种内置样式使用独立 shader 分支且切换仅更新 uniform，不重建网格或材质', t => {
  const { scene, model, renderer, config } = setup(t);
  const styles = ['conveyor-direction', 'moving-double-arrow', 'pipeline-flow-arrows', 'flow-arrows'];
  let mesh, material;
  for (const [index, style] of styles.entries()) {
    config.style = style;
    renderer.update('one', model, config, 1, 0, true);
    mesh ??= arrow(scene); material ??= mesh.material;
    assert.equal(arrow(scene), mesh);
    assert.equal(mesh.material, material);
    assert.equal(material._floats.arrowStyle, index);
  }
  const shader = material.shaderPath.fragmentSource;
  assert.match(shader, /singleChevronDistance/);
  assert.match(shader, /doubleChevronDistance/);
  assert.match(shader, /pipelineArrowDistance/);
  assert.match(shader, /flowArrowDistance/);
  assert.match(shader, /arrowStyle\s*<\s*0\.5/);
  assert.match(shader, /arrowStyle\s*<\s*1\.5/);
  assert.match(shader, /arrowStyle\s*<\s*2\.5/);
});

test('默认呼吸独立于流动速度，半周期亮度到30%，完整周期回到100%', t => {
  const { scene, model, renderer, config } = setup(t);
  Object.assign(config, { speed: 0, breathingEnabled: true, breathingPeriod: 1.8, breathingStrength: .7 });
  renderer.update('one', model, config, 1, 0, true);
  const material = arrow(scene).material;
  near(material._floats.breathingPhase, 0); near(material._floats.breathingFactor, 1);
  const flowPhase = material._floats.phase;
  renderer.update('one', model, config, 1, .9, true);
  near(material._floats.phase, flowPhase);
  near(material._floats.breathingPhase, .5); near(material._floats.breathingFactor, .3);
  renderer.update('one', model, config, -1, .9, true);
  near(material._floats.breathingPhase, 0); near(material._floats.breathingFactor, 1);
  assert.equal(material._floats.direction, -1);
});

test('呼吸强度和开关立即生效且周期相位有界，流动仍独立继续', t => {
  const { scene, model, renderer, config } = setup(t);
  Object.assign(config, { breathingEnabled: true, breathingPeriod: 2, breathingStrength: .7 });
  renderer.update('one', model, config, 1, 0, true);
  const material = arrow(scene).material;
  renderer.update('one', model, config, 1, 1, true);
  near(material._floats.breathingFactor, .3);
  config.breathingStrength = .4;
  renderer.update('one', model, config, 1, 0, true);
  near(material._floats.breathingFactor, .6);
  config.breathingEnabled = false;
  renderer.update('one', model, config, 1, .15, true);
  near(material._floats.breathingFactor, 1);
  config.breathingEnabled = true; config.breathingStrength = 0;
  renderer.update('one', model, config, 1, .15, true);
  near(material._floats.breathingFactor, 1);
  const beforeFlow = material._floats.phase;
  renderer.update('one', model, config, 1, 1000000.1, true);
  assert.ok(material._floats.breathingPhase >= 0 && material._floats.breathingPhase < 1);
  assert.ok(material._floats.phase >= 0 && material._floats.phase < config.spacing);
  assert.notEqual(material._floats.phase, beforeFlow);
  config.speed = 1; config.spacing = .9;
  renderer.update('wrap', model, config, 1, .8, true);
  config.speed = 0; config.spacing = .5;
  renderer.update('wrap', model, config, 1, 0, true);
  near(arrow(scene, 'wrap').material._floats.phase, .3);
});

test('呼吸不抬高零透明度和黑色，静止流动仍按原样支持隐藏与恢复', t => {
  const { scene, model, renderer, config } = setup(t);
  Object.assign(config, { speed: 0, breathingEnabled: true, breathingPeriod: 2, breathingStrength: .7 });
  renderer.update('one', model, config, 1, 0, true);
  const mesh = arrow(scene), material = mesh.material;
  config.opacity = 0; config.color = '#000000';
  renderer.update('one', model, config, 1, 1, true);
  assert.equal(material._floats.opacity, 0);
  assert.equal(mesh.isEnabled(), false);
  assert.deepEqual(material._colors3.arrowColor.asArray(), [0, 0, 0]);
  config.opacity = .5;
  renderer.update('one', model, config, 1, 0, true);
  assert.equal(mesh.isEnabled(), true);
  near(material._floats.opacity, .5);
  renderer.update('one', model, config, 0, .1, true);
  assert.equal(mesh.isEnabled(), false);
});

test('100条未运行实例不创建 mesh、root、材质且不测量，已有资源隐藏复用', t => {
  const { scene, model, renderer, config } = setup(t);
  const initial = [scene.meshes.length, scene.transformNodes.length, scene.materials.length];
  const originalTraversal = model.root.getChildTransformNodes;
  model.root.getChildTransformNodes = () => { throw new Error('未运行实例不应遍历模型节点'); };
  for (let i = 0; i < 100; i += 1) {
    assert.equal(renderer.update(`stop-${i}`, model, config, 0, .1, true), null);
    assert.equal(renderer.update(`hidden-${i}`, model, config, 1, .1, false), null);
    assert.equal(renderer.update(`transparent-${i}`, model, { ...config, opacity: 0 }, 1, .1, true), null);
  }
  assert.deepEqual([scene.meshes.length, scene.transformNodes.length, scene.materials.length], initial);
  model.root.getChildTransformNodes = originalTraversal;
  renderer.update('one', model, config, 1, 0, true);
  const mesh = arrow(scene), material = mesh.material;
  model.root.getChildTransformNodes = () => { throw new Error('已隐藏实例不应重新测量'); };
  model.parameterSignature = 'changed-while-hidden';
  renderer.update('one', model, config, 0, .1, true);
  assert.equal(mesh.isEnabled(), false);
  model.root.getChildTransformNodes = originalTraversal;
  renderer.update('one', model, config, 1, 0, true);
  assert.equal(arrow(scene), mesh); assert.equal(mesh.material, material); assert.equal(mesh.isEnabled(), true);
});
