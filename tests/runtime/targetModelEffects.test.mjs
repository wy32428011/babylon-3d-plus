import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Color3, MeshBuilder, MultiMaterial, NullEngine, PBRMaterial, Scene, StandardMaterial, Texture, TransformNode } from '@babylonjs/core';
import ts from 'typescript';

const root = new URL('../../src/', import.meta.url);
const electronRoot = new URL('../../electron/', import.meta.url);
const isSource = url => url?.startsWith(root.href) || url?.startsWith(electronRoot.href);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@babylonjs/core/') && !specifier.endsWith('.js')) return next(`${specifier}.js`, context);
    if (specifier.startsWith('.') && isSource(context.parentURL)) {
      const candidate = new URL(specifier, context.parentURL);
      if (!existsSync(candidate) && existsSync(new URL(candidate.href.replace(/\.js$/, '') + '.ts'))) return next(candidate.href.replace(/\.js$/, '') + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (isSource(url) && /\.(png|svg|jpg)$/.test(url)) return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
    if (isSource(url) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
let TargetModelEffects;
let suspendTargetModelEffects;
let AlarmColorOverrides;
try {
  ({ TargetModelEffects, suspendTargetModelEffects } = await import(new URL('runtime/babylon/effects/TargetModelEffects.ts', root).href));
  ({ AlarmColorOverrides } = await import(new URL('runtime/babylon/AlarmManagerRuntime.ts', root).href));
}
finally { hooks.deregister(); }

const component = (effectKind = 'model-emissive', visual = {}) => ({
  effectKind, enabled: true, primaryColor: '#00ccff', secondaryColor: '#ff5500', intensity: 1.4, speed: 1, density: 12,
  visual: { targetEntityId: 'target', radius: 5, height: 10, width: 0.15, opacity: 0.3, duration: 5, progress: 0.5, loop: true, axis: 'y', amount: 3, points: [], values: [], labels: [], ...visual },
});
function harness(t) {
  const engine = new NullEngine(); const scene = new Scene(engine); const targets = new Map();
  const runtime = new TargetModelEffects(scene, id => targets.get(id) ?? null);
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });
  const target = new TransformNode('target', scene); targets.set('target', target);
  const mesh = MeshBuilder.CreateBox('body', {}, scene); mesh.parent = target;
  const original = new StandardMaterial('source-material', scene); mesh.material = original;
  return { scene, runtime, targets, target, mesh, original };
}

function surfaceUniforms(material, mesh) {
  const values = new Map();
  const updateFloat4 = material._uniformBuffer.updateFloat4;
  material._uniformBuffer.updateFloat4 = (name, ...value) => values.set(name, value);
  try { material._callbackPluginEventHardBindForSubMesh({ subMesh: mesh.subMeshes[0] }); }
  finally { material._uniformBuffer.updateFloat4 = updateFloat4; }
  return values;
}

test('设备整面着色作用于 Standard/PBR 子材质，保留纹理及共享原材质并完整恢复', t => {
  const { scene, runtime, mesh, original } = harness(t);
  original.emissiveColor.set(0.1, 0.2, 0.3);
  const texture = new Texture(null, scene); texture.name = 'shared-device-texture'; original.diffuseTexture = texture;
  const pbr = new PBRMaterial('paint-pbr', scene); pbr.albedoColor.set(0.2, 0.4, 0.7);
  pbr.albedoTexture = texture;
  const multi = new MultiMaterial('paint-multi', scene); multi.subMaterials = [original, pbr]; mesh.material = multi;
  const sibling = MeshBuilder.CreateBox('paint-sibling', {}, scene); sibling.material = multi;
  const effect = { ...component('model-color'), primaryColor: '#ff3300', configuration: { parameters: { originalMix: 0.2, emissiveIntensity: 0.7, glowIntensity: 0.6 } } };
  runtime.sync('color', effect, true);
  const replacement = mesh.material;
  assert.notEqual(replacement, multi); assert.equal(sibling.material, multi);
  assert.equal(runtime.getStatus('color').status, 'active');
  for (const material of replacement.subMaterials) {
    const uniforms = surfaceUniforms(material, mesh);
    assert.equal(uniforms.get('dtEffectParams')[0], 6, '真实表面着色需启用 shader，而非仅叠加自发光');
    assert.deepEqual(uniforms.get('dtEffectPrimary').slice(0, 3), [1, 0.2, 0]);
    assert.equal(uniforms.get('dtEffectOptions')[2], 0.2);
  }
  assert.equal(replacement.subMaterials[0].diffuseTexture.name, texture.name);
  assert.equal(replacement.subMaterials[1].albedoTexture.name, texture.name);
  assert.ok(original.diffuseTexture === texture && pbr.albedoTexture === texture);
  assert.deepEqual(original.emissiveColor.asArray(), [0.1, 0.2, 0.3]);
  const clones = replacement.subMaterials.slice();
  runtime.disposeMissing(new Set());
  assert.equal(mesh.material, multi); assert.equal(sibling.material, multi);
  assert.ok(clones.every(material => !scene.materials.includes(material)));
  assert.equal(scene.textures.includes(texture), true, '恢复不得释放共享原贴图');
});

test('模型闪烁按周期进入原外观暗相位，参数更新暂停和重复 tick 不重建资源', t => {
  const { scene, runtime, mesh, original, target } = harness(t);
  original.emissiveColor.set(0.1, 0.2, 0.3);
  const other = MeshBuilder.CreateBox('unselected-part', {}, scene); other.parent = target; other.material = original;
  const effect = { ...component('model-flash'), primaryColor: '#ff0000', configuration: { parameters: { nodePaths: 'body', flashPeriod: 1, dutyCycle: 0.25, emissiveIntensity: 1, glowIntensity: 0.7 } } };
  runtime.sync('flash', effect, true);
  const replacement = mesh.material;
  assert.notEqual(replacement, original); assert.equal(other.material, original);
  assert.equal(surfaceUniforms(replacement, mesh).get('dtEffectOptions')[0], 1);
  assert.deepEqual(replacement.emissiveColor.asArray(), [1, 0, 0]);
  const counts = [scene.meshes.length, scene.materials.length, scene.effectLayers.length];
  runtime.tick(0.3);
  assert.equal(surfaceUniforms(replacement, mesh).get('dtEffectOptions')[0], 0);
  assert.deepEqual(replacement.emissiveColor.asArray(), original.emissiveColor.asArray(), '暗相位保留原材质发光');
  assert.equal(scene.effectLayers[0].intensity, 0, '暗相位不残留报警光晕');
  runtime.sync('flash', { ...effect, speed: 0 }, true); runtime.tick(0.9);
  assert.equal(surfaceUniforms(replacement, mesh).get('dtEffectOptions')[0], 0);
  runtime.sync('flash', effect, true); runtime.tick(0.75);
  assert.equal(surfaceUniforms(replacement, mesh).get('dtEffectOptions')[0], 1);
  for (let index = 0; index < 120; index++) runtime.tick(1 / 60);
  assert.equal(mesh.material, replacement);
  assert.deepEqual([scene.meshes.length, scene.materials.length, scene.effectLayers.length], counts);
  runtime.sync('flash', { ...effect, configuration: { parameters: { ...effect.configuration.parameters, dutyCycle: 0 } } }, true);
  runtime.setGlowIntensity(2);
  assert.equal(surfaceUniforms(replacement, mesh).get('dtEffectOptions')[0], 0);
  assert.equal(scene.effectLayers[0].intensity, 0, '全局光晕更新不能点亮暗相位');
  runtime.sync('flash', { ...effect, configuration: { parameters: { ...effect.configuration.parameters, dutyCycle: 1, originalMix: 1 } } }, true);
  assert.equal(surfaceUniforms(replacement, mesh).get('dtEffectOptions')[2], 1);
  assert.deepEqual(replacement.emissiveColor.asArray(), original.emissiveColor.asArray());
  assert.equal(scene.effectLayers[0].intensity, 0, '完全保留原材质时不添加报警光晕');
  runtime.sync('flash', effect, false);
  assert.equal(mesh.material, original); assert.equal(other.material, original);
  assert.equal(scene.effectLayers.length, 0);
});

test('实例闪烁只覆盖自身代理，报警租约解除后恢复常驻外观和真实原材质', t => {
  const { scene, runtime, mesh, target, targets, original } = harness(t);
  mesh.parent = null;
  const instance = mesh.createInstance('flash-instance'); instance.parent = target; targets.set('target', instance);
  const sibling = mesh.createInstance('flash-sibling');
  const count = scene.meshes.length;
  runtime.sync('ordinary', component('xray'), true);
  const release = suspendTargetModelEffects(instance);
  const alarm = new TargetModelEffects(scene, () => instance, true);
  try {
    alarm.sync('flash', { ...component('model-flash'), configuration: { parameters: { flashPeriod: 0.5, dutyCycle: 0.5 } } }, true);
    assert.equal(instance.isEnabled(false), false); assert.equal(sibling.isEnabled(false), true); assert.equal(mesh.material, original);
    assert.equal(scene.meshes.length, count + 1);
    const proxy = scene.meshes.find(candidate => candidate.metadata?.digitalTwinEffectProxy);
    alarm.tick(0.3);
    assert.equal(surfaceUniforms(proxy.material, proxy).get('dtEffectOptions')[0], 0);
    assert.equal(scene.meshes.length, count + 1);
    alarm.dispose(); assert.equal(instance.isEnabled(false), true); assert.equal(scene.meshes.length, count);
  } finally { alarm.dispose(); release(); }
  runtime.tick(0.3); assert.equal(instance.isEnabled(false), false);
  runtime.dispose(); assert.equal(instance.isEnabled(false), true); assert.equal(scene.meshes.length, count);
  assert.equal(mesh.material, original);
});

test('共享原材质隔离，禁用和删除恢复，动画不增加资源', t => {
  const { scene, runtime, mesh, original } = harness(t);
  const other = MeshBuilder.CreateBox('other', {}, scene); other.material = original;
  runtime.sync('fx', component(), true);
  const replacement = mesh.material;
  assert.notEqual(replacement, original); assert.equal(other.material, original);
  assert.deepEqual(original.emissiveColor.asArray(), Color3.Black().asArray());
  assert.ok(replacement.emissiveColor.b > 0);
  const resourceCount = [scene.meshes.length, scene.materials.length];
  for (let i = 0; i < 120; i++) runtime.tick(1 / 60);
  assert.deepEqual([scene.meshes.length, scene.materials.length], resourceCount);
  runtime.sync('fx', component(), false);
  assert.equal(mesh.material, original); assert.equal(scene.materials.includes(replacement), false);
  runtime.sync('fx', component(), true); runtime.disposeMissing(new Set());
  assert.equal(mesh.material, original);
});

test('异步目标、晚到子网格及目标替换均生效，旧目标恢复', t => {
  const { runtime, targets, target, mesh, original, scene } = harness(t);
  targets.delete('target'); runtime.sync('fx', component('xray'), true); assert.equal(mesh.material, original);
  targets.set('target', target); runtime.tick(0.3); assert.notEqual(mesh.material, original);
  const late = MeshBuilder.CreateBox('late-body', {}, scene); late.parent = target; late.material = original;
  runtime.tick(0.3); assert.notEqual(late.material, original);
  const next = MeshBuilder.CreateBox('replacement-target', {}, scene); next.material = original;
  targets.set('target', next); runtime.tick(0.3);
  assert.equal(mesh.material, original); assert.equal(late.material, original); assert.notEqual(next.material, original);
});

test('同目标先绑定者优先，释放后下一特效接管，最终恢复真实原材质', t => {
  const { runtime, mesh, original } = harness(t);
  runtime.sync('first', component('model-emissive'), true); const firstMaterial = mesh.material;
  runtime.sync('second', component('xray'), true); assert.equal(mesh.material, firstMaterial);
  runtime.disposeMissing(new Set(['second'])); runtime.tick(0.3);
  assert.notEqual(mesh.material, firstMaterial); assert.equal(mesh.material.alpha, 0.3);
  runtime.dispose(); assert.equal(mesh.material, original);
});

test('实例只创建自己的代理，保留源实例和兄弟实例，关闭恢复', t => {
  const { scene, runtime, mesh, target, targets, original } = harness(t);
  mesh.parent = null;
  const instance = mesh.createInstance('target-instance'); instance.parent = target;
  const sibling = mesh.createInstance('sibling');
  targets.set('target', instance);
  const baseline = scene.meshes.length;
  runtime.sync('fx', component('xray'), true);
  assert.equal(instance.isEnabled(false), false); assert.equal(mesh.material, original); assert.equal(sibling.isEnabled(false), true);
  assert.equal(scene.meshes.length, baseline + 1);
  runtime.tick(0.3); runtime.tick(0.3); assert.equal(scene.meshes.length, baseline + 1);
  runtime.disposeMissing(new Set()); assert.equal(instance.isEnabled(false), true); assert.equal(scene.meshes.length, baseline);
});

test('楼层展开与爆炸仅偏移真实子部件，停止恢复原位置', t => {
  const { runtime, scene, target, mesh } = harness(t);
  mesh.position.y = 1;
  const upper = MeshBuilder.CreateBox('floor-2', {}, scene); upper.parent = target; upper.position.y = 5;
  const original = upper.position.clone();
  runtime.sync('fx', component('floor-expand', { amount: 4, progress: 1, loop: false }), true);
  assert.ok(upper.position.y > original.y); assert.equal(mesh.position.y, 1);
  runtime.sync('fx', component('floor-expand'), false); assert.deepEqual(upper.position.asArray(), original.asArray());
  runtime.sync('fx', component('explode', { amount: 3, progress: 1, loop: false }), true);
  assert.notDeepEqual(upper.position.asArray(), original.asArray());
  runtime.dispose(); assert.deepEqual(upper.position.asArray(), original.asArray());
});

test('所有模型样式可切换且清理材质、轮廓、边缘与透明状态', t => {
  const { runtime, mesh, original, scene } = harness(t);
  const baselineMaterials = scene.materials.length;
  const originalOutline = mesh.renderOutline;
  for (const kind of ['model-outline', 'model-edges', 'model-emissive', 'model-scan', 'height-gradient', 'hologram', 'xray', 'dissolve', 'floor-expand', 'explode', 'clip-section', 'roof-fade']) {
    runtime.sync('fx', component(kind), true); runtime.tick(0.1);
    assert.equal(mesh.isDisposed(), false);
    runtime.sync('fx', component(kind), false);
    assert.equal(mesh.material, original, kind); assert.equal(mesh.renderOutline, originalOutline, kind);
    assert.equal(mesh.edgesRenderer, null, kind); assert.equal(mesh.visibility, 1, kind);
    assert.equal(scene.materials.filter(material => material.name !== 'lineShader').length, baselineMaterials, kind);
  }
});

test('PBR 与多材质只克隆目标引用，保留透明及贴图来源并释放所有克隆', t => {
  const { runtime, mesh, scene } = harness(t);
  const pbr = new PBRMaterial('pbr', scene); pbr.metallic = 0.7;
  const standard = new StandardMaterial('secondary', scene);
  const multi = new MultiMaterial('multi', scene); multi.subMaterials = [pbr, standard]; mesh.material = multi;
  const baseline = scene.materials.length;
  runtime.sync('fx', component('height-gradient'), true);
  assert.notEqual(mesh.material, multi); assert.notEqual(mesh.material.subMaterials[0], pbr);
  assert.equal(mesh.material.subMaterials[0].metallic, 0.7);
  runtime.dispose(); assert.equal(mesh.material, multi); assert.equal(scene.materials.length, baseline);
});


test('材质克隆产生的纹理随特效释放，保留原纹理和非屋顶部件深度策略', t => {
  const { runtime, scene, mesh, target, original } = harness(t);
  original.diffuseTexture = new Texture(null, scene);
  const originalTexture = original.diffuseTexture;
  const baseline = scene.textures.length;
  const roof = MeshBuilder.CreateBox('roof-panel', {}, scene); roof.parent = target; roof.position.y = 3; roof.material = original;
  runtime.sync('fx', component('roof-fade'), true);
  assert.equal(mesh.material.alpha, 1); assert.equal(mesh.material.disableDepthWrite, false);
  assert.equal(roof.material.alpha, 0.3); assert.equal(roof.material.disableDepthWrite, true);
  runtime.dispose();
  assert.equal(scene.textures.length, baseline); assert.equal(original.diffuseTexture, originalTexture);
  assert.ok(scene.textures.includes(originalTexture));
});


test('空 glTF 包装节点下的独立子部件按真实几何高度展开', t => {
  const { runtime, scene, target, mesh } = harness(t);
  const wrapper = new TransformNode('__root__', scene); wrapper.parent = target;
  mesh.parent = wrapper;
  const upper = MeshBuilder.CreateBox('baked-upper-floor', {}, scene); upper.parent = wrapper;
  // 高度烘焙进顶点，节点自身 position 仍为零。
  upper.position.y = 5; upper.bakeCurrentTransformIntoVertices();
  assert.equal(upper.position.y, 0);
  runtime.sync('fx', component('floor-expand', { amount: 4, progress: 1 }), true);
  assert.equal(mesh.position.y, 0); assert.equal(upper.position.y, 4);
  runtime.dispose(); assert.equal(upper.position.y, 0);
});


test('生长只播放一次、零速暂停，剖切进度不受默认循环影响', t => {
  const { runtime, mesh } = harness(t);
  const growth = component('dissolve', { duration: 2, loop: false, progress: 0.8 });
  runtime.sync('fx', growth, true);
  const uniforms = () => {
    const values = new Map();
    mesh.material.pluginManager.getPlugin('DigitalTwinModelSurface').hardBindForSubMesh({ updateFloat4: (name, ...value) => values.set(name, value) });
    return values.get('dtEffectParams');
  };
  assert.equal(uniforms()[1], 0);
  runtime.tick(1); assert.equal(uniforms()[1], 0.4);
  runtime.tick(1); runtime.tick(1); assert.equal(uniforms()[1], 0.8);
  runtime.sync('fx', component('model-scan'), true); runtime.tick(0.2);
  const before = uniforms()[1];
  // 零速和其他参数更新保留当前动画相位。
  runtime.sync('fx', { ...component('model-scan'), speed: 0 }, true);
  const paused = uniforms()[1]; assert.equal(paused, before); runtime.tick(0.5); assert.equal(uniforms()[1], paused); assert.ok(before > 0);
  runtime.sync('fx', component('clip-section', { progress: 0.35, loop: true }), true);
  runtime.tick(1); assert.equal(uniforms()[1], 0.35);
});

test('循环生长在结束边界完整显示并停留，不能直接跳过完整模型', t => {
  const { runtime, mesh } = harness(t);
  runtime.sync('fx', component('dissolve', { duration: 1, progress: 1, loop: true }), true);
  const phase = () => mesh.material.pluginManager.getPlugin('DigitalTwinModelSurface').phase;
  runtime.tick(0.5); assert.ok(phase() > 0 && phase() < 1);
  runtime.tick(0.5); assert.equal(phase(), 1, '到达生长时长后必须显示完整模型');
  runtime.tick(0.1); assert.equal(phase(), 1, '循环重新开始前保持可见的完成状态');
  runtime.tick(0.2); assert.ok(phase() < 1, '停留后才开始下一轮');
});

test('逐帧累计到生长终点收敛到100%，暂停和后续帧保持完整', t => {
  const { runtime, mesh } = harness(t);
  const growth = component('dissolve', { duration: 1, progress: 1, loop: false });
  runtime.sync('fx', growth, true);
  const phase = () => mesh.material.pluginManager.getPlugin('DigitalTwinModelSurface').phase;
  for (let i = 0; i < 10; i++) runtime.tick(0.1);
  assert.equal(phase(), 1);
  runtime.sync('fx', { ...growth, speed: 0 }, true);
  for (let i = 0; i < 3; i++) runtime.tick(1);
  assert.equal(phase(), 1);
});


test('结构效果释放不覆盖外部更新的位置', t => {
  const { runtime, scene, target } = harness(t);
  const upper = MeshBuilder.CreateBox('floor-2', {}, scene); upper.parent = target; upper.position.y = 5;
  runtime.sync('fx', component('floor-expand', { amount: 4, progress: 1 }), true);
  assert.equal(upper.position.y, 9);
  upper.position.y = 12; runtime.tick(0.01); assert.equal(upper.position.y, 16);
  runtime.dispose(); assert.equal(upper.position.y, 12);
});


test('材质插件由 Babylon 实际 hard-bind 回调写入着色参数', t => {
  const { runtime, mesh, scene } = harness(t);
  runtime.sync('fx', component('height-gradient'), true);
  const material = mesh.material;
  const values = new Map();
  const original = material._uniformBuffer.updateFloat4;
  material._uniformBuffer.updateFloat4 = (name, ...value) => values.set(name, value);
  material._callbackPluginEventHardBindForSubMesh({ subMesh: mesh.subMeshes[0] });
  material._uniformBuffer.updateFloat4 = original;
  assert.equal(values.get('dtEffectParams')[0], 2);
  assert.ok(values.get('dtEffectPrimary')[2] > 0.9);
});

test('特效期间修改目标外观写入真实原材质，解除特效后保留新颜色', t => {
  const { runtime, mesh, original } = harness(t);
  runtime.sync('fx', component('xray'), true);
  runtime.withTargetMutation('target', () => {
    assert.equal(mesh.material, original);
    mesh.material.diffuseColor = Color3.FromHexString('#ff6600');
  });
  assert.notEqual(mesh.material, original); assert.equal(mesh.material.alpha, 0.3);
  runtime.dispose(); assert.equal(mesh.material, original);
  assert.deepEqual(original.diffuseColor.asArray(), [1, 0.4, 0]);
});


test('报警接管模型效果时捕获真实原材质，禁用效果后报警解除不会恢复已释放材质', t => {
  const { runtime, mesh, original, scene } = harness(t);
  const alarms = new AlarmColorOverrides(); t.after(() => alarms.clear());
  runtime.sync('fx', component('xray'), true);
  const previousEffectMaterial = mesh.material;
  alarms.apply(new Map([[mesh, '#ff0000']]));
  assert.equal(scene.materials.includes(previousEffectMaterial), false);
  runtime.sync('fx', component('xray'), false);
  alarms.clear();
  assert.equal(mesh.material, original);
  assert.ok(scene.materials.includes(mesh.material));
});

test('报警期间模型效果保持挂起，呼吸更新不重建，解除后下一次tick恢复模型视觉', t => {
  const { runtime, mesh, original, scene } = harness(t);
  const alarms = new AlarmColorOverrides(); t.after(() => alarms.clear());
  alarms.apply(new Map([[mesh, '#ff0000']])); const alarmMaterial = mesh.material;
  runtime.sync('fx', component('xray'), true);
  runtime.withTargetMutation('target', () => {});
  assert.ok(mesh.material === alarmMaterial, '外观同步结束不能重绑到报警材质');
  const baseline = scene.materials.length;
  for (let i = 0; i < 20; i++) {
    runtime.tick(0.1); alarms.apply(new Map([[mesh, '#ff0000']]), new Set([mesh]), 0.5);
    assert.equal(mesh.material, alarmMaterial); assert.equal(scene.materials.length, baseline);
  }
  alarms.clear(); assert.equal(mesh.material, original);
  runtime.tick(0.3); assert.notEqual(mesh.material, original); assert.equal(mesh.material.alpha, 0.3);
  runtime.dispose(); assert.equal(mesh.material, original);
});

test('报警选用模型表面特效时接管常驻特效，解除恢复常驻效果及真实原材质', t => {
  const { runtime, target, mesh, original, scene } = harness(t);
  const alarmEffects = new TargetModelEffects(scene, () => target, true);
  t.after(() => alarmEffects.dispose());
  runtime.sync('normal', component('xray'), true);
  assert.equal(mesh.material.alpha, 0.3);
  const release = suspendTargetModelEffects(mesh);
  try {
    assert.equal(mesh.material, original);
    alarmEffects.sync('alarm', component('hologram'), true);
    const appearance = mesh.material;
    assert.equal(appearance.wireframe, true);
    for (let i = 0; i < 10; i++) { runtime.tick(0.3); alarmEffects.tick(0.3); assert.equal(mesh.material, appearance); }
    alarmEffects.disposeMissing(new Set());
    assert.equal(mesh.material, original);
    assert.equal(scene.materials.includes(appearance), false);
  } finally { alarmEffects.dispose(); release(); }
  runtime.tick(0.3);
  assert.equal(mesh.material.alpha, 0.3);
  runtime.dispose(); assert.equal(mesh.material, original);
});
