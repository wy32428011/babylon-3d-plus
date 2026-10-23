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
      if (!existsSync(candidate) && candidate.href.endsWith('.js') && existsSync(new URL(candidate.href.replace(/\.js$/, '.ts')))) return next(candidate.href.replace(/\.js$/, '.ts'), context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (/\.(png|jpg|svg)$/.test(url)) return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(url) };
    if (url.startsWith(root.href) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const { SandboxEnvironmentRuntime } = await import('../../src/runtime/babylon/SandboxEnvironmentRuntime.ts');
const { SceneSkyboxRuntime } = await import('../../src/runtime/babylon/SceneSkyboxRuntime.ts');
const { SceneLightRigRuntime } = await import('../../src/runtime/babylon/SceneLightRigRuntime.ts');
const { SceneAppearanceRuntime } = await import('../../src/runtime/babylon/SceneAppearanceRuntime.ts');
const { normalizeSceneLightingConfig, normalizeSceneAppearanceConfig } = await import('../../electron/shared/sceneLightingConfig.ts');
hooks.deregister();
const { NullEngine, Scene, Texture, MeshBuilder, PBRMaterial, MaterialDefines, HemisphericLight, Vector3 } = await import('@babylonjs/core');
const rotation = 5.54 * 180 / Math.PI;
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(t, integrated = false) {
  const engine = new NullEngine(), scene = new Scene(engine), loads = [], states = [];
  const loadTexture = (url, signal) => new Promise((resolve, reject) => loads.push({ url, signal, resolve, reject }));
  const options = { loadTexture };
  const runtime = integrated ? new SceneSkyboxRuntime(scene, () => {}, state => states.push(state), options)
    : new SandboxEnvironmentRuntime(scene, { ...options, onChanged: state => states.push(state) });
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });
  const texture = () => { const value = new Texture(null, scene); value.rotationY = 0; return value; };
  return { scene, runtime, loads, states, texture };
}
const sandbox = (visible = true, intensity = 1) => ({ visible, intensity, source: 'sandbox', rotationDegrees: rotation });

test('内置环境独立加载并应用旋转，缺省场景不加载环境资产', async t => {
  const h = harness(t);
  assert.equal(h.runtime.getReadiness().phase, 'idle');
  h.runtime.sync(false, rotation); assert.equal(h.loads.length, 0);
  h.runtime.sync(true, rotation); assert.equal(h.runtime.getReadiness().phase, 'loading');
  assert.match(h.loads[0].url, /sanGiuseppeBridge\.env/);
  const texture = h.texture(); h.loads[0].resolve(texture); await settle();
  assert.equal(h.runtime.getReadiness().phase, 'ready'); assert.equal(h.runtime.getTexture(), texture);
  assert.ok(Math.abs(texture.rotationY - 5.54) < 1e-12);
  h.runtime.sync(true, 90); assert.equal(h.loads.length, 1); assert.equal(texture.rotationY, Math.PI / 2);
});

test('切回场景后取消加载，迟到纹理被回收且不能覆盖新加载', async t => {
  const h = harness(t); h.runtime.sync(true, rotation); h.runtime.sync(false, rotation);
  assert.equal(h.loads[0].signal.aborted, true); assert.equal(h.runtime.getReadiness().phase, 'idle');
  const stale = h.texture(); let disposed = 0; stale.onDisposeObservable.add(() => disposed++);
  h.runtime.sync(true, 45); h.loads[0].resolve(stale); await settle();
  assert.equal(disposed, 1); assert.equal(h.runtime.getTexture(), null); assert.equal(h.runtime.getReadiness().phase, 'loading');
  const current = h.texture(); h.loads[1].resolve(current); await settle();
  assert.equal(h.runtime.getTexture(), current); assert.equal(current.rotationY, Math.PI / 4);
});

test('失败保留可诊断状态且只显式重试，释放后拒绝迟到提交', async t => {
  const h = harness(t); h.runtime.sync(true, rotation); h.loads[0].reject(new Error('fixture failed')); await settle();
  assert.equal(h.runtime.getReadiness().phase, 'error'); assert.match(h.runtime.getReadiness().message, /fixture failed/);
  h.runtime.sync(true, rotation); assert.equal(h.loads.length, 1);
  h.runtime.retry(); assert.equal(h.loads.length, 2); assert.equal(h.runtime.getReadiness().phase, 'loading');
  h.runtime.dispose(); assert.equal(h.loads[1].signal.aborted, true);
  const late = h.texture(); let disposed = false; late.onDisposeObservable.add(() => disposed = true);
  h.loads[1].resolve(late); await settle(); assert.equal(disposed, true); assert.equal(h.runtime.getTexture(), null);
});

test('无天空背景也有内置IBL，显隐和异步完成不重置昼夜有效强度', async t => {
  const h = harness(t, true); h.runtime.setLightingOverrides(sandbox()); h.runtime.sync(null);
  assert.equal(h.runtime.getReadiness().phase, 'loading'); h.scene.environmentIntensity = .27;
  const texture = h.texture(); h.loads[0].resolve(texture); await settle();
  assert.equal(h.scene.environmentTexture, texture); assert.equal(h.scene.environmentIntensity, .27);
  assert.equal(h.runtime.getReadiness().phase, 'ready'); h.runtime.setLightingOverrides(sandbox(false)); h.runtime.sync(null);
  assert.equal(h.scene.environmentTexture, texture); assert.equal(h.scene.environmentIntensity, .27);
  h.runtime.setLightingOverrides(sandbox(false, .6)); assert.equal(h.scene.environmentIntensity, .6);
});

test('内置环境与隐藏天空实体解耦，切回场景恢复原有天空IBL', async t => {
  const h = harness(t, true), background = h.texture(), mesh = MeshBuilder.CreateSphere('background', {}, h.scene), material = new PBRMaterial('background', h.scene);
  mesh.material = material;
  h.runtime.active = { entityKey: 'skybox', signature: 'test', mesh, material, texture: background };
  h.runtime.desired = { entityId: 'skybox', visible: false, pickable: false, selected: false,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    skybox: { rotationDegrees: 0, intensity: 1, sourceUrl: 'fixture.hdr' } };
  h.runtime.setLightingOverrides(sandbox()); const environment = h.texture(); h.loads[0].resolve(environment); await settle();
  assert.equal(mesh.isEnabled(), false); assert.equal(h.scene.environmentTexture, environment);
  h.runtime.desired.visible = true; h.runtime.setLightingOverrides({ visible: false, intensity: .8, source: 'scene', rotationDegrees: 0 });
  assert.equal(mesh.isEnabled(), false); assert.equal(h.scene.environmentTexture, background); assert.equal(h.scene.environmentIntensity, .8);
  h.runtime.desired.visible = false; h.runtime.setLightingOverrides({ visible: false, intensity: .7 });
  assert.equal(h.scene.environmentTexture, null);
});

test('内置环境失败通过统一readiness报告并可在原重试入口恢复', async t => {
  const h = harness(t, true); h.runtime.setLightingOverrides(sandbox());
  h.loads[0].reject(new Error('decode fixture')); await settle();
  assert.equal(h.runtime.getReadiness().phase, 'error'); assert.match(h.runtime.getReadiness().message, /decode fixture/);
  h.runtime.retry(); const texture = h.texture(); h.loads[1].resolve(texture); await settle();
  assert.equal(h.runtime.getReadiness().phase, 'ready'); assert.equal(h.scene.environmentTexture, texture);
  h.runtime.dispose(); assert.equal(h.scene.environmentTexture, null);
});


test('内置IBL就绪时隐藏的失败背景不阻塞，重新显示恢复背景错误', async t => {
  const h = harness(t, true);
  h.runtime.desired = { visible: true, skybox: { sourceUrl: 'broken-background.hdr' } };
  h.runtime.loadError = '背景文件损坏';
  h.runtime.setLightingOverrides(sandbox(false));
  assert.equal(h.runtime.getReadiness().phase, 'loading', '内置IBL尚未完成时仍等待');
  h.loads[0].resolve(h.texture()); await settle();
  assert.equal(h.runtime.getReadiness().phase, 'ready');
  assert.equal(h.runtime.loadError, '背景文件损坏', '隐藏不会删除背景诊断');
  h.runtime.setLightingOverrides(sandbox(true));
  assert.equal(h.runtime.getReadiness().phase, 'error');
  assert.equal(h.runtime.getReadiness().message, '背景文件损坏');
  h.runtime.desired.visible = false;
  assert.equal(h.runtime.getReadiness().phase, 'ready', '天空盒实体隐藏时也不需要背景');
  h.runtime.setLightingOverrides({ visible: false, intensity: 1, source: 'scene' });
  assert.equal(h.runtime.getReadiness().phase, 'error', '沿用场景环境时保持历史失败行为');
});

test('隐藏的背景加载不阻塞已就绪内置IBL，显示后重新等待背景', async t => {
  const h = harness(t, true);
  h.runtime.desired = { visible: true, skybox: { sourceUrl: 'pending-background.hdr' } };
  h.runtime.pending = { controller: new AbortController() };
  h.runtime.setLightingOverrides(sandbox(false));
  assert.equal(h.runtime.getReadiness().phase, 'loading');
  h.loads[0].resolve(h.texture()); await settle();
  assert.equal(h.runtime.getReadiness().phase, 'ready');
  assert.notEqual(h.runtime.pending, null, '本次修复只改变就绪判定，不改变背景资源生命周期');
  h.runtime.setLightingOverrides(sandbox(true));
  assert.equal(h.runtime.getReadiness().phase, 'loading');
  assert.equal(h.runtime.getReadiness().sourceUrl, 'pending-background.hdr');
  h.runtime.desired.visible = false;
  assert.equal(h.runtime.getReadiness().phase, 'ready');
});


function detachedSource(h, t) {
  const source = MeshBuilder.CreateBox('detached-template', {}, h.scene), material = new PBRMaterial('detached-material', h.scene);
  material.albedoColor.set(.7, .6, .5); material.metallic = .2; material.roughness = .8; source.material = material;
  const instances = [source.createInstance('visible-instance-1'), source.createInstance('visible-instance-2')];
  h.scene.removeMesh(source); h.scene.removeMaterial(material);
  t.after(() => source.dispose(false, false));
  const seed = () => {
    const draw = source.subMeshes[0]._getDrawWrapper(7, true), defines = new MaterialDefines();
    defines.REFLECTION = false; defines.markAsProcessed();
    draw.defines = defines; draw.materialContext = material._materialContext;
    draw._wasPreviouslyReady = true; draw._wasPreviouslyUsingInstances = true;
    draw._forceRebindOnNextCall = false;
    draw.effect = { getEngine: () => h.scene.getEngine(), dispose() {} };
    return { draw, effect: draw.effect, defines, wasUsingInstances: true };
  };
  return { source, material, instances, seed };
}

/** Babylon 9.12 Material.markDirty(true) 保留 wrapper/effect，恢复就绪检查并标脏 defines。 */
function assertDrawInvalidation(source, seeded, dirty, message) {
  const draw = source.subMeshes[0]._getDrawWrapper(7);
  assert.equal(draw, seeded.draw, `${message}：保留 draw wrapper`);
  assert.equal(draw.effect, seeded.effect, `${message}：保留已编译 effect 供原生 hot-swap`);
  assert.equal(draw.defines, seeded.defines, `${message}：保留 defines 对象`);
  assert.equal(draw._wasPreviouslyReady, !dirty, `${message}：就绪 fast-path 标记`);
  assert.equal(draw._wasPreviouslyUsingInstances, dirty ? null : seeded.wasUsingInstances, `${message}：实例就绪状态`);
  assert.equal(draw._forceRebindOnNextCall, dirty, `${message}：下次绑定标记`);
  assert.equal(draw.defines.isDirty, dirty, `${message}：defines 总体脏状态`);
  for (const flag of ['_areTexturesDirty', '_areAttributesDirty', '_areLightsDirty', '_areFresnelDirty',
    '_areMiscDirty', '_arePrePassDirty', '_areImageProcessingDirty']) {
    assert.equal(draw.defines[flag], dirty, `${message}：${flag}`);
  }
}

test('真实共享实例的离场源缓存不会被Babylon材质标脏触达，内置IBL提交必须使其重编译', async t => {
  const h = harness(t, true), fixture = detachedSource(h, t), { source, material, seed } = fixture;
  const beforeMeshes = [...h.scene.meshes], beforeColor = material.albedoColor.asArray();
  const stale = seed();
  material.markDirty(true); h.scene.markAllMaterialsAsDirty(63);
  assertDrawInvalidation(source, stale, false, '原生标脏确实漏过离场源');
  h.runtime.setLightingOverrides(sandbox());
  const pendingDraw = seed(); h.loads[0].resolve(h.texture()); await settle();
  assertDrawInvalidation(source, pendingDraw, true, '异步环境绑定恢复源 shader 检查');
  assert.deepEqual(h.scene.meshes, beforeMeshes, '不能重新注册隐藏模板');
  assert.deepEqual(material.albedoColor.asArray(), beforeColor); assert.equal(material.metallic, .2); assert.equal(material.roughness, .8);
  const unchanged = seed(); h.runtime.setLightingOverrides(sandbox(false));
  assertDrawInvalidation(source, unchanged, false, '只改背景不触达无关 shader');
  h.runtime.setLightingOverrides({ ...sandbox(false), rotationDegrees: 90 });
  assertDrawInvalidation(source, unchanged, true, '旋转环境需要重新检查并绑定源 shader');
  const removed = seed(); h.runtime.setLightingOverrides({ visible: false, intensity: 1, source: 'scene' });
  assertDrawInvalidation(source, removed, true, '移除内置 IBL 需要重新检查反射 defines');
});

test('统一灯光变化刷新冻结的离场源缓存，不改变冻结状态且相同配置不重复刷新', t => {
  const h = harness(t), { source, material, seed } = detachedSource(h, t), rig = new SceneLightRigRuntime(h.scene);
  material.freeze(); const stale = seed();
  const config = normalizeSceneLightingConfig({ main: { enabled: false }, fill: { intensity: 0 } });
  rig.sync(config);
  assertDrawInvalidation(source, stale, true, '统一灯光变化恢复冻结源的就绪检查');
  assert.equal(material.isFrozen, true, '恢复检查不能解冻用户材质或销毁旧 effect');
  const current = seed(); rig.sync(config);
  assertDrawInvalidation(source, current, false, '相同灯光配置不能重复刷新');
  rig.sync({ ...config, main: { ...config.main, enabled: true } });
  assertDrawInvalidation(source, current, true, '新增主光需要恢复灯光与 shader 检查');
  rig.dispose();
});

test('外观映射变化刷新离场源缓存，背景颜色变化与重复sync不触发重编译', t => {
  const h = harness(t), { source, seed } = detachedSource(h, t), appearance = new SceneAppearanceRuntime(h.scene);
  const config = normalizeSceneAppearanceConfig({ toneMappingEnabled: true });
  const stale = seed(); appearance.sync(config);
  assertDrawInvalidation(source, stale, true, '色调映射变化需要重新检查图像处理 defines');
  const current = seed(); appearance.sync(config);
  assertDrawInvalidation(source, current, false, '重复外观配置不能刷新');
  appearance.sync({ ...config, backgroundColor: '#ffffff' });
  assertDrawInvalidation(source, current, false, '背景颜色变化不能重编译材质');
  appearance.sync({ ...config, exposure: 1.2 });
  assertDrawInvalidation(source, current, true, '曝光变化需要重新检查图像处理 defines');
  appearance.dispose();
});


test('离场源保留的已释放灯光在统一更新后被清理，新灯列表与scene一致', t => {
  const h = harness(t);
  const oldLight = new HemisphericLight('old-template-light', Vector3.Up(), h.scene);
  const { source, seed } = detachedSource(h, t);
  assert.ok(source.lightSources.includes(oldLight)); oldLight.dispose();
  assert.ok(source.lightSources.includes(oldLight), 'Babylon灯释放同样未触达离场模板');
  const stale = seed(), rig = new SceneLightRigRuntime(h.scene);
  rig.sync(normalizeSceneLightingConfig({ main: { enabled: false }, fill: { intensity: 0 } }));
  assert.equal(source.lightSources.includes(oldLight), false);
  assert.deepEqual(source.lightSources, h.scene.lights.filter(light => light.isEnabled() && light.canAffectMesh(source)));
  assertDrawInvalidation(source, stale, true, '释放灯光后恢复源材质灯光检查');
  assert.equal(stale.defines._areLightsDisposed, true, '实际灯光被释放时必须保留 disposed 标记，不能沿用旧灯 shader');
  rig.dispose();
});


test('已注册冻结环境网格等待IBL后也必须刷新缓存，保留冻结与材质参数', async t => {
  const h = harness(t, true), source = MeshBuilder.CreateBox('frozen-environment', {}, h.scene), material = new PBRMaterial('frozen-environment-material', h.scene);
  source.material = material; material.albedoColor.set(.8, .7, .6); material.freeze();
  const draw = source.subMeshes[0]._getDrawWrapper(7, true);
  draw.defines = new MaterialDefines(); draw.defines.markAsProcessed();
  draw.materialContext = material._materialContext; draw._wasPreviouslyReady = true; draw._wasPreviouslyUsingInstances = false;
  draw._forceRebindOnNextCall = false;
  draw.effect = { getEngine: () => h.scene.getEngine(), dispose() {} };
  const seeded = { draw, effect: draw.effect, defines: draw.defines, wasUsingInstances: false };
  h.runtime.setLightingOverrides(sandbox()); h.loads[0].resolve(h.texture()); await settle();
  assertDrawInvalidation(source, seeded, true, '冻结环境不能继续跳过 IBL 就绪检查');
  assert.equal(material.isFrozen, true); assert.deepEqual(material.albedoColor.asArray(), [.8, .7, .6]);
  assert.equal(h.scene.meshes.includes(source), true);
});
