import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { ArcRotateCamera, Color3, HemisphericLight, MeshBuilder, MultiMaterial, NullEngine, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';

const root = new URL('../../src/', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@babylonjs/core/') && !specifier.endsWith('.js')) return next(`${specifier}.js`, context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) {
      const candidate = new URL(specifier, context.parentURL);
      if (!existsSync(candidate) && existsSync(new URL(candidate.href + '.ts'))) return next(candidate.href + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const { TargetModelEffects } = await import('../../src/runtime/babylon/effects/TargetModelEffects.ts');
const { SceneEnvironmentEffects } = await import('../../src/runtime/babylon/effects/SceneEnvironmentEffects.ts');
const { getModelEffectParameters } = await import('../../src/editor/model/modelEffectParameters.ts');
const { getEnvironmentEffectParameters } = await import('../../src/editor/model/environmentEffectParameters.ts');
hooks.deregister();

const config = (kind, parameters = {}, visual = {}) => ({ effectKind: kind, enabled: true, primaryColor: '#00ccff', secondaryColor: '#ff5500', intensity: 1, speed: 1, density: 12,
  visual: { targetEntityId: 'target', radius: 5, height: 3, width: .1, opacity: .3, duration: 5, progress: 1, loop: false, axis: 'y', amount: 3, points: [], values: [], labels: [], ...visual },
  configuration: { version: 2, parameters },
});
function setup(t) {
  const engine = new NullEngine(); const scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 1, 1, 20, Vector3.Zero(), scene);
  const root = new TransformNode('target', scene); const targets = new Map([['target', root]]);
  const mesh = MeshBuilder.CreateBox('body', {}, scene); mesh.parent = root;
  const material = new StandardMaterial('base', scene); mesh.material = material;
  const models = new TargetModelEffects(scene, id => targets.get(id) ?? null);
  const environment = new SceneEnvironmentEffects(scene, id => targets.get(id) ?? null, () => true);
  t.after(() => { models.dispose(); environment.dispose(); scene.dispose(); engine.dispose(); });
  return { scene, camera, root, mesh, material, models, environment, targets };
}
const uniforms = mesh => {
  const values = {};
  mesh.material.pluginManager.getPlugin('DigitalTwinModelSurface').hardBindForSubMesh({ updateFloat4: (name, ...v) => { values[name] = v; } });
  return values;
};

test('每种模型、镜头和场景环境效果登记专用字段且键无重复', () => {
  for (const kind of ['model-outline', 'model-edges', 'model-emissive', 'model-scan', 'height-gradient', 'hologram', 'xray', 'dissolve', 'floor-expand', 'explode', 'clip-section', 'roof-fade']) {
    const defs = getModelEffectParameters(kind); assert.ok(defs.length > 1, kind); assert.equal(new Set(defs.map(d => d.key)).size, defs.length);
  }
  for (const kind of ['target-follow', 'environment-fog', 'day-night']) assert.ok(getEnvironmentEffectParameters(kind).length > 4, kind);
});

test('结构分组和色带验证拒绝非有限、重复与越界内容', () => {
  const group = getModelEffectParameters('explode').find(def => def.key === 'structureGroups');
  assert.equal(group.validate([{ nodePath: 'body', offset: { x: 1, y: 2, z: 3 }, fixed: false }]), null);
  for (const rows of [[{ nodePath: 'body', distance: Infinity }], [{ nodePath: 'a' }, { nodePath: 'a' }], [{ nodePath: 'a', offset: { x: 1 } }], [{ nodePath: 'a', axis: 'wrong' }]]) assert.ok(group.validate(rows));
  const stops = getModelEffectParameters('height-gradient').find(def => def.key === 'gradientStops');
  assert.equal(stops.validate([{ position: 1, color: '#ff3300' }, { position: 0, color: '#000000' }]), null);
  for (const rows of [[{ position: 2, color: '#ffffff' }], [{ position: 0, color: 'red' }], [{ position: 0, color: '#ffffff' }, { position: 0, color: '#000000' }]]) assert.ok(stops.validate(rows));
});

test('重复节点名不误命中，完整节点路径可准确选中一个部件', t => {
  const { models, scene, root, mesh, material } = setup(t);
  const groupA = new TransformNode('A', scene), groupB = new TransformNode('B', scene); groupA.parent = root; groupB.parent = root;
  mesh.parent = groupA;
  const other = MeshBuilder.CreateBox('body', {}, scene); other.parent = groupB; other.material = material;
  models.sync('fx', config('xray', { nodePaths: 'body' }), true); assert.equal(mesh.material, material); assert.equal(other.material, material);
  models.sync('fx', config('xray', { nodePaths: 'A/body' }), true); assert.notEqual(mesh.material, material); assert.equal(other.material, material);
});

test('动态进度和颜色原位更新：材质、纹理和模型数量稳定，100%保留完成状态', t => {
  const { models, mesh, scene } = setup(t);
  models.sync('fx', config('dissolve', { progressMode: 'external', progress: .2 }), true);
  const replacement = mesh.material, count = [scene.meshes.length, scene.materials.length, scene.textures.length];
  for (let i = 1; i <= 100; i++) models.sync('fx', { ...config('dissolve', { progressMode: 'external', progress: i / 100 }), primaryColor: i % 2 ? '#ff0000' : '#00ff00' }, true);
  assert.equal(mesh.material, replacement);
  assert.deepEqual([scene.meshes.length, scene.materials.length, scene.textures.length], count);
  assert.equal(uniforms(mesh).dtEffectParams[1], 1);
});

test('节点路径只覆盖指定部件，多材质只克隆明确选中的材质', t => {
  const { models, mesh, scene, root, material } = setup(t);
  const body2 = MeshBuilder.CreateBox('other', {}, scene); body2.parent = root; body2.material = material;
  const selected = new StandardMaterial('selected', scene), unselected = new StandardMaterial('unselected', scene);
  const multi = new MultiMaterial('multi', scene); multi.subMaterials = [selected, unselected]; mesh.material = multi;
  models.sync('fx', config('model-emissive', { nodePaths: 'body', materialNames: 'selected' }), true);
  assert.equal(body2.material, material); assert.notEqual(mesh.material.subMaterials[0], selected); assert.equal(mesh.material.subMaterials[1], unselected);
  models.dispose(); assert.equal(mesh.material, multi); assert.ok(scene.materials.includes(unselected));
});

test('反向扫光使用延迟、范围和间隔，材质参数更新不重新开始计时', t => {
  const { models, mesh } = setup(t);
  const c = config('model-scan', { direction: 'reverse', scanStart: .2, scanEnd: .8, delay: 1, duration: 2, interval: 1 });
  models.sync('fx', c, true); models.tick(.5); assert.equal(uniforms(mesh).dtEffectOptions[0], 0);
  models.tick(.5); assert.ok(Math.abs(uniforms(mesh).dtEffectParams[1] - .8) < 1e-6);
  models.tick(1); assert.ok(Math.abs(uniforms(mesh).dtEffectParams[1] - .5) < 1e-6);
  models.sync('fx', { ...c, intensity: 2 }, true); assert.ok(Math.abs(uniforms(mesh).dtEffectParams[1] - .5) < 1e-6);
  models.tick(1); assert.equal(uniforms(mesh).dtEffectOptions[0], 0);
});

test('显式楼层分组包含无几何包装节点，固定组不移动且恢复基准', t => {
  const { models, scene, root, mesh } = setup(t);
  const floor = new TransformNode('floor-two', scene); floor.parent = root;
  mesh.parent = floor;
  models.sync('fx', config('floor-expand', { structureGroups: [{ nodePath: 'floor-two', order: 1, distance: 4, axis: 'y' }], progress: .5 }), true);
  assert.equal(floor.position.y, 2); assert.equal(mesh.position.y, 0);
  models.sync('fx', config('floor-expand', { structureGroups: [{ nodePath: 'floor-two', fixed: true, distance: 4 }], progress: 1 }), true);
  assert.equal(floor.position.y, 0); models.dispose(); assert.equal(floor.position.y, 0);
});

test('明确屋顶路径和渐隐时长：非屋顶不改变，停止恢复材质', t => {
  const { models, scene, root, mesh, material } = setup(t);
  const roof = MeshBuilder.CreateBox('custom-top', {}, scene); roof.parent = root; roof.material = material;
  models.sync('fx', config('roof-fade', { roofPaths: 'custom-top', fadeDuration: 2, opacity: .1 }), true);
  assert.equal(roof.material.alpha, 1); models.tick(1); assert.ok(Math.abs(roof.material.alpha - .55) < 1e-6); assert.equal(mesh.material.alpha, 1);
  models.tick(1); assert.ok(Math.abs(roof.material.alpha - .1) < 1e-6); models.dispose(); assert.equal(roof.material, material);
});

test('渐变多色断点和本地高度范围传入着色器，剖切保留侧和切片厚度独立', t => {
  const { models, mesh, root } = setup(t); root.position.y = 20;
  models.sync('fx', config('height-gradient', { coordinateSpace: 'local', rangeMode: 'manual', rangeMin: -2, rangeMax: 3, originalMix: .4, gradientStops: [{ position: 0, color: '#ff0000' }, { position: .4, color: '#00ff00' }, { position: 1, color: '#0000ff' }] }), true);
  const u = uniforms(mesh); assert.equal(u.dtEffectParams[2], -2); assert.equal(u.dtEffectParams[3], 5); assert.equal(u.dtEffectGradient1[3], .4); assert.equal(u.dtEffectOptions[2], .4);
  models.sync('fx', config('clip-section', { clipSide: 'slice', sliceThickness: .25, progress: .3 }), true);
  const clip = uniforms(mesh); assert.equal(clip.dtEffectExtra[2], 2); assert.equal(clip.dtEffectExtra[3], .25);
});

test('全息表面与边线分开配置，关闭恢复已有轮廓状态', t => {
  const { models, mesh, material } = setup(t);
  models.sync('fx', config('hologram', { surfaceOpacity: .2, wireframe: false, edgeEnabled: true, edgeColor: '#ff0000', edgeWidth: 3, scanLines: 12 }), true);
  assert.equal(mesh.material.wireframe, false); assert.equal(mesh.material.alpha, .2); assert.ok(mesh.edgesRenderer); assert.equal(mesh.edgesColor.r, 1); assert.equal(mesh.edgesWidth, 3);
  models.dispose(); assert.equal(mesh.material, material); assert.equal(mesh.edgesRenderer, null);
});

test('默认发光复用光晕，独立半径可更新且释放不影响其他目标', t => {
  const { models, scene, root, mesh, material, targets } = setup(t);
  const otherRoot = new TransformNode('other-root', scene); targets.set('other', otherRoot);
  const other = MeshBuilder.CreateBox('other-body', {}, scene); other.parent = otherRoot; other.material = material;
  const first = config('model-emissive'); const second = config('model-emissive', {}, { targetEntityId: 'other' });
  models.sync('first', first, true); models.sync('second', second, true); assert.equal(scene.effectLayers.length, 1);
  models.sync('first', config('model-emissive', { glowRadius: 64, glowIntensity: .7 }), true); assert.equal(scene.effectLayers.length, 2);
  const replacement = mesh.material;
  models.sync('first', config('model-emissive', { glowRadius: 48, glowIntensity: .5 }), true); assert.equal(mesh.material, replacement); assert.equal(scene.effectLayers.length, 2);
  const specific = scene.effectLayers.find(layer => layer.name.includes('first')); assert.equal(specific.blurKernelSize, 48); assert.equal(specific.intensity, .5);
  models.disposeMissing(new Set(['second'])); assert.equal(scene.effectLayers.length, 1); assert.notEqual(other.material, material);
  models.dispose(); assert.equal(scene.effectLayers.length, 0); assert.equal(mesh.material, material); assert.equal(other.material, material); assert.equal(root.isDisposed(), false);
});

test('跟随模型前轴、局部偏移、限速及失去目标保持最后镜头', t => {
  const { environment, camera, root, targets } = setup(t);
  const c = config('target-follow', { cameraMode: 'follow', forwardAxis: '+z', heading: 'target', distance: 10, height: 5, lateral: 2, targetOffset: { x: 0, y: 2, z: 0 }, smoothTime: 0, maxCatchupSpeed: 2 });
  environment.sync('f', c, true); environment.tick(.1);
  assert.equal(camera.target.y, 2); assert.ok(camera.alpha < 0, '相机位于设备后方');
  root.position.x = 20; environment.tick(.5); assert.ok(Math.abs(camera.target.x - 1) < 1e-6);
  const pose = { alpha: camera.alpha, target: camera.target.asArray(), radius: camera.radius };
  targets.delete('target'); environment.tick(.1); assert.deepEqual({ alpha: camera.alpha, target: camera.target.asArray(), radius: camera.radius }, pose);
  assert.equal(environment.getStatus('f').status, 'missing-target');
});

test('设备急转弯时限制相机实际位移，关闭后可保持当前镜头', t => {
  const { environment, camera, root } = setup(t);
  const c = config('target-follow', { cameraMode: 'follow', heading: 'target', smoothTime: 0, maxCatchupSpeed: 1, exitBehavior: 'hold' });
  environment.sync('f', c, true); environment.tick(.1); camera.getViewMatrix(true); const position = camera.position.clone();
  root.rotation.y = Math.PI; environment.tick(.1); camera.getViewMatrix(true);
  assert.ok(Vector3.Distance(position, camera.position) <= .100001);
  const finalPose = { target: camera.target.asArray(), alpha: camera.alpha, radius: camera.radius };
  environment.sync('f', c, false); environment.tick(.1); assert.deepEqual({ target: camera.target.asArray(), alpha: camera.alpha, radius: camera.radius }, finalPose);
});

test('人工接管可显式恢复，多个目标跟随报告相机控制权占用', t => {
  const { environment, camera, root } = setup(t);
  environment.sync('first', config('target-follow', { manualTakeover: true }), true);
  environment.sync('second', config('target-follow'), true); environment.tick(.1);
  camera.alpha += .5; root.position.x = 30; environment.tick(.1);
  assert.equal(environment.getStatus('first').status, 'paused'); assert.equal(environment.getStatus('second').status, 'occupied');
  environment.resume('first'); environment.tick(.1); assert.ok(camera.target.x > 0); assert.equal(environment.getStatus('first').status, 'active');
});

test('指数雾使用密度并能平滑调整距离，释放后恢复原始场景', t => {
  const { environment, scene } = setup(t); scene.fogStart = 1; scene.fogEnd = 200; scene.fogDensity = .01;
  environment.sync('fog', config('environment-fog', { fogMode: 'exp2', density: .03, start: 10, end: 500, transition: 0 }), true); environment.tick(.1);
  assert.equal(scene.fogMode, Scene.FOGMODE_EXP2); assert.equal(scene.fogDensity, .03); assert.equal(scene.fogEnd, 500);
  environment.sync('fog', config('environment-fog', { fogMode: 'linear', start: 30, end: 600, transition: 1 }), true); environment.tick(.5);
  assert.ok(scene.fogStart > 10 && scene.fogStart < 30);
  environment.dispose(); assert.equal(scene.fogStart, 1); assert.equal(scene.fogDensity, .01);
});

test('昼夜手动时刻、最低灯光与固定主题优先级', t => {
  const { environment, scene } = setup(t); const light = new HemisphericLight('light', Vector3.Up(), scene); light.intensity = 2;
  environment.sync('day', config('day-night', { dayMode: 'manual', hour: 0, lightFloor: .25 }), true); environment.tick(.1); assert.equal(light.intensity, .5);
  environment.sync('day', config('day-night', { dayMode: 'manual', hour: 12, lightFloor: .25 }), true); environment.tick(.1); assert.equal(light.intensity, 2);
  environment.setThemeActive(true); light.intensity = .7; environment.tick(.1); assert.equal(light.intensity, .7);
});
