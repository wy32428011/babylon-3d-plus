import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { Constants, MeshBuilder, MultiMaterial, NullEngine, PBRMaterial, RawTexture, Scene, StandardMaterial, Texture, VertexBuffer } from '@babylonjs/core';

const repository = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    // EffectsController额外触及编辑模型的旧扩展名省略写法；与Vite一样定位实际Babylon .js。
    if (/^@babylonjs\/(?:core|loaders)\//.test(specifier) && !specifier.endsWith('.js')) return next(specifier + '.js', context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(repository.href) && !context.parentURL.includes('/node_modules/')) {
      const target = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
      if (!specifier.endsWith('.ts') && existsSync(target)) return { url: target.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(repository.href) && /\.(?:png|jpg|webp|svg)$/.test(url)) return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
    if (url.startsWith(repository.href) && url.endsWith('.ts') && !url.includes('/node_modules/')) return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
let ModelEntranceRuntime, SceneLightingRuntime, LightingProbeSampler, lightingMaterialFingerprint, getLightingGeometrySignature,
  normalizeSceneLightingConfig, getSceneLightingBakeSignature, SceneModelEntrancePlayback, ScenePoiAndEffectsController,
  registerLightingMaterialOverride, resolveLightingMaterialOverride, isLightingMaterialOverrideOf;
try {
  ({ ModelEntranceRuntime } = await import('../../src/runtime/babylon/ModelEntranceRuntime.ts'));
  ({ SceneLightingRuntime } = await import('../../src/runtime/babylon/SceneLightingRuntime.ts'));
  ({ LightingProbeSampler } = await import('../../src/runtime/babylon/lightingProbes.ts'));
  ({ lightingMaterialFingerprint, getLightingGeometrySignature } = await import('../../src/runtime/babylon/lightingRuntimeCapture.ts'));
  ({ normalizeSceneLightingConfig } = await import('../../electron/shared/sceneLightingConfig.ts'));
  ({ getSceneLightingBakeSignature } = await import('../../electron/shared/sceneLightingBakeContract.ts'));
  ({ SceneModelEntrancePlayback } = await import('../../src/shared/opening/SceneModelEntrancePlayback.ts'));
  ({ ScenePoiAndEffectsController } = await import('../../src/runtime/babylon/scene-runtime/ScenePoiAndEffectsController.ts'));
  ({ registerLightingMaterialOverride, resolveLightingMaterialOverride, isLightingMaterialOverrideOf } = await import('../../src/runtime/babylon/lightingMaterialOverrides.ts'));
} finally { hooks.deregister(); }

const settings = { enabled: true, effect: 'dissolve', durationSeconds: 2.5, delaySeconds: 0, color: '#00ccff', intensity: 1,
  axis: 'y', reverse: false, staggerSeconds: .15, particleCount: 600, particleSize: 3, spreadMeters: 3,
  assemblyDistanceMeters: 1.5, loop: false, loopIntervalSeconds: 1, scope: 'all', targetEntityIds: [] };

// Node assert的对象diff会递归展开Babylon Scene图；精确identity期望只输出有界name/id。
function label(value) {
  if (value === null || value === undefined) return String(value);
  const name = typeof value.name === 'string' ? value.name.slice(0, 64) : '?';
  const id = typeof value.uniqueId === 'number' || typeof value.uniqueId === 'string' ? String(value.uniqueId).slice(0, 24) : '?';
  return name + '/' + id;
}
function sameIdentity(actual, expected, message = 'identity应相同') {
  assert.ok(actual === expected, `${message}（actual=${label(actual)}, expected=${label(expected)}）`);
}
function differentIdentity(actual, expected, message = 'identity应不同') {
  assert.ok(actual !== expected, `${message}（actual=${label(actual)}, expected=${label(expected)}）`);
}

function fixture({ pbr = false, multi = false, dynamic = false } = {}) {
  const engine = new NullEngine(), scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('static-physical-source', { size: 1 }, scene);
  const create = name => pbr ? new PBRMaterial(name, scene) : new StandardMaterial(name, scene);
  const original = multi ? new MultiMaterial('physical-multi', scene) : create('physical');
  if (multi) original.subMaterials = [create('leaf-a'), create('leaf-b')];
  mesh.material = original;
  const entrance = new ModelEntranceRuntime(scene);
  let delta = 0;
  // 与SceneRuntime真实构造顺序一致：遥测/入口帧observer先于GI失效核对。
  scene.onBeforeRenderObservable.add(() => entrance.tick(delta, true));
  const entity = { id: 'static-entity', name: 'static-entity', parentId: null, childrenIds: [], components: {
    meshRenderer: { type: 'box' }, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, lighting: { mobility: 'static' },
  } };
  const document = { name: 'entrance-gi-contract', entities: { [entity.id]: entity }, entityIds: [entity.id], sceneSettings: {
    environment: null, skybox: null, lighting: normalizeSceneLightingConfig({ bake: { enabled: true } }),
  } };
  const source = { mesh, entry: { key: entity.id + '/$mesh', entityId: entity.id, nodeKey: '$mesh', name: mesh.name,
    mobility: 'static', reason: 'fixed fixture', castShadows: true, receiveShadows: true, bakeIndirect: true }, getWorldMatrix: () => mesh.computeWorldMatrix(true) };
  const sources = [source];
  let moving = null;
  if (dynamic) {
    const id = 'moving-entity';
    moving = MeshBuilder.CreateBox('dynamic-physical-source', { size: 1 }, scene);
    moving.position.x = 3; moving.material = create('dynamic-physical');
    document.entities[id] = { ...entity, id, name: id, components: { ...entity.components, lighting: { mobility: 'dynamic' } } };
    document.entityIds.push(id);
    sources.push({ mesh: moving, entry: { ...source.entry, key: id + '/$mesh', entityId: id, name: moving.name, mobility: 'dynamic', bakeIndirect: false },
      getWorldMatrix: () => moving.computeWorldMatrix(true) });
  }
  const geometry = { version: 1, positions: Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)), normals: Array.from(mesh.getVerticesData(VertexBuffer.NormalKind)),
    indices: Array.from(mesh.getIndices()), uvs: Array.from(mesh.getVerticesData(VertexBuffer.UVKind)), bakeUvs: Array.from(mesh.getVerticesData(VertexBuffer.UVKind)) };
  const logs = [];
  const lighting = new SceneLightingRuntime(scene, { getSources: () => sources, setShadowRoles: () => {}, pushLog: message => logs.push(message), classificationCoalesceMinMs: 0,
    // 只替换资源I/O，准备/提交/实际source watcher与Entrance类均为产品实现。无GPU/浏览器证明。
    loadResources: async () => {
      const texture = new RawTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, Constants.TEXTUREFORMAT_RGBA, scene, false, false);
      return { geometries: new Map([['geometry', geometry]]), textures: new Map([['lightmap', texture]]),
        probes: new LightingProbeSampler({ version: 1, encoding: 'ambient-cube', spacing: 4, probes: [{ position: [0, 0, 0], irradiance: Array(18).fill(.3) }] }),
        dispose() { texture.dispose(); } };
    } });
  lighting.sync(document);
  const fingerprint = () => lightingMaterialFingerprint(mesh);
  const prepare = signal => entrance.prepare(settings, [{ id: entity.id, node: mesh, meshes: [mesh] }], signal);
  const bake = () => lighting.applySnapshot({ version: 1, signature: getSceneLightingBakeSignature(document), geometrySignature: getLightingGeometrySignature(sources),
    createdAt: new Date().toISOString(), engineVersion: 'NullEngine contract fixture', probeAssetId: 'probes',
    assets: [{ id: 'geometry', kind: 'geometry', url: 'memory://geometry', byteLength: 1 }, { id: 'lightmap', kind: 'lightmap', url: 'memory://lightmap', byteLength: 1, rgbmRange: 1 },
      { id: 'probes', kind: 'probes', url: 'memory://probes', byteLength: 1 }],
    surfaces: [{ key: source.entry.key + '/primitive:0', entityId: entity.id, nodeKey: '$mesh', geometryAssetId: 'geometry', lightmapAssetId: 'lightmap' }],
    statistics: { meshCount: 1, triangleCount: 12, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 1 } });
  return { engine, scene, mesh, original, moving, entrance, lighting, document, source, logs, fingerprint, prepare, bake,
    color: material => pbr ? material.albedoColor : material.diffuseColor,
    tick(seconds = 0) { delta = seconds; scene.onBeforeRenderObservable.notifyObservers(scene); },
    complete() { entrance.start(); for (let frame = 0; frame < 26; frame++) { delta = .1; scene.onBeforeRenderObservable.notifyObservers(scene); } },
    dispose() { entrance.dispose(); lighting.dispose(); scene.dispose(); engine.dispose(); } };
}

for (const pbr of [false, true]) {
  test(`${pbr ? 'PBR' : 'Standard'}受控dissolve clone身份规范化；完成/cancel/dispose均恢复同一物理指纹`, async () => {
    const f = fixture({ pbr });
    try {
      const before = f.fingerprint(); await f.prepare();
      differentIdentity(f.mesh.material, f.original, '真实入口必须创建临时显示副本');
      assert.equal(f.fingerprint(), before, '真实业务字段未变，不应因clone uniqueId变化误报');
      f.complete(); assert.equal(f.entrance.getSnapshot().status, 'completed');
      sameIdentity(f.mesh.material, f.original); assert.equal(f.fingerprint(), before);
      await f.prepare(); f.entrance.cancel(); sameIdentity(f.mesh.material, f.original); assert.equal(f.fingerprint(), before);
      await f.prepare(); f.entrance.dispose(); sameIdentity(f.mesh.material, f.original); assert.equal(f.fingerprint(), before);
    } finally { f.dispose(); }
  });
}

test('GI已激活再准备入口，以及入口中建立GI基线再完成，两种真实时序均保持有效', async () => {
  for (const entranceFirst of [false, true]) {
    const f = fixture();
    try {
      if (entranceFirst) await f.prepare();
      await f.bake();
      if (!entranceFirst) await f.prepare();
      f.tick(); assert.equal(f.lighting.getError(), null, 'prepare不能把静态源误标为物理变化');
      f.complete();
      assert.equal(f.lighting.getError(), null, '完成时恢复original不能使相同物理输入失效');
      assert.equal(f.mesh.layerMask, 0, 'GI原件仍由有效派生代理接管');
      assert.equal(f.scene.meshes.filter(mesh => mesh.metadata?.lightingDerived).length, 1);
    } finally { f.dispose(); }
  }
});

test('入口期间clone单改、original单改、双侧冲突均保留真实物理失效；释放保留业务值', async () => {
  for (const change of ['clone', 'original', 'both']) {
    const f = fixture();
    try {
      const baseline = f.fingerprint(); await f.prepare();
      assert.equal(f.fingerprint(), baseline);
      const replacement = f.mesh.material;
      if (change !== 'original') f.color(replacement).r = .127;
      if (change !== 'clone') f.color(f.original).g = .619;
      assert.notEqual(f.fingerprint(), baseline, change + '变化不能被受控覆盖掩盖');
      f.entrance.cancel(); sameIdentity(f.mesh.material, f.original);
      if (change === 'clone') assert.equal(f.color(f.original).r, .127, '业务写当前材质的值不得随副本dispose丢失');
      if (change !== 'clone') assert.equal(f.color(f.original).g, .619, '原材质外部更新不能被旧clone反向覆盖');
    } finally { f.dispose(); }
  }
  for (const target of ['clone', 'original']) {
    const f = fixture();
    try {
      await f.bake(); await f.prepare(); f.tick(); assert.equal(f.lighting.getError(), null);
      f.color(target === 'clone' ? f.mesh.material : f.original).r = .231;
      f.tick(); assert.match(f.lighting.getError(), /静态对象.*变化/);
    } finally { f.dispose(); }
  }
  for (const conflict of [false, true]) {
    const f = fixture();
    try {
      const baseline = f.fingerprint(); await f.prepare(); assert.equal(f.fingerprint(), baseline);
      f.mesh.material.alpha = .412;
      if (conflict) f.original.alpha = .619;
      else f.color(f.original).g = .619;
      assert.notEqual(f.fingerprint(), baseline);
      f.entrance.cancel();
      assert.equal(f.original.alpha, conflict ? .619 : .412, '冲突字段保留原对象更新，非冲突clone字段不能丢');
      if (!conflict) assert.equal(f.color(f.original).g, .619, '不同字段的原对象业务更新同时保留');
    } finally { f.dispose(); }
  }
});

test('未知mesh替换和MultiMaterial子叶替换不获identity豁免，cancel不覆盖外部材质', async () => {
  const f = fixture();
  try {
    const baseline = f.fingerprint(); await f.prepare();
    const outside = new StandardMaterial('unknown-business-replacement', f.scene); f.mesh.material = outside;
    assert.notEqual(f.fingerprint(), baseline); f.entrance.cancel(); sameIdentity(f.mesh.material, outside);
  } finally { f.dispose(); }
  for (const side of ['clone', 'original', 'unknown-child']) {
    const m = fixture({ multi: true });
    try {
      const baseline = m.fingerprint(); await m.prepare(); assert.equal(m.fingerprint(), baseline);
      const replacement = m.mesh.material;
      if (side === 'unknown-child') replacement.subMaterials[0] = new StandardMaterial('unknown-sub-leaf', m.scene);
      else m.color((side === 'clone' ? replacement : m.original).subMaterials[1]).b = .313;
      assert.notEqual(m.fingerprint(), baseline, '每个MultiMaterial物理子叶仍被核对');
    } finally { m.dispose(); }
  }
});

test('实际Playback abort入口撤销覆盖；pre-abort不创建替换，不泄露已完成租约', async () => {
  const f = fixture();
  const previous = new Map(['document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const events = new EventTarget(); events.hidden = false;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: events });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ visibility: 'visible', display: 'block' }) });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 1 });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });
  let playback;
  try {
    const baseline = f.fingerprint(), controller = new AbortController();
    const runtime = { prepareModelEntrance: (_settings, signal) => f.prepare(signal), startModelEntrance: () => f.entrance.start(),
      cancelModelEntrance: () => f.entrance.cancel(), setModelEntranceVisible: () => {} };
    playback = new SceneModelEntrancePlayback({ runtime, settings, signal: controller.signal,
      container: { getBoundingClientRect: () => ({ width: 100, height: 100 }) } });
    await playback.ready; assert.equal(f.fingerprint(), baseline);
    controller.abort(); assert.equal(playback.isDisposed, true); sameIdentity(f.mesh.material, f.original); assert.equal(f.fingerprint(), baseline);
    const aborted = new AbortController(); aborted.abort(); await f.prepare(aborted.signal); sameIdentity(f.mesh.material, f.original);
  } finally {
    playback?.dispose(); f.dispose();
    for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test('真实EffectsController入口作用到可见GI代理并保留GI插件，源材质和完成后的GI均不变', async () => {
  const f = fixture();
  try {
    await f.bake();
    const proxy = f.scene.meshes.find(mesh => mesh.metadata?.lightingDerived);
    assert.ok(proxy);
    const working = proxy.material, baseline = f.fingerprint();
    assert.ok(working.pluginManager?.getPlugin('BakedIndirectLighting'));
    const id = f.source.entry.entityId;
    const effects = new ScenePoiAndEffectsController({ scene: f.scene, pushLog: () => {}, callbackReceiver: null }, {
      telemetry: { telemetryPreviewActive: false }, outputs: { generatedOutputOwners: new Map() }, fetch: { locatorFetchRuntimes: new Map() },
      environment: { environmentRuntime: { getBuildingEffectTarget: () => null, getSnapshot: () => ({ phase: 'idle' }) }, lightingRuntime: f.lighting },
      document: { syncedEntities: new Map([[id, { id, components: { modelAsset: {} } }]]), isEntityVisible: () => true },
      assets: { models: new Map([[id, { root: f.mesh, contentRoot: f.mesh, meshes: [f.mesh] }]]) },
      presentation: { meshes: new Map() }, variants: { modelArrayParameterVariants: new Map() },
      readiness: { loadDiagnostics: { measureAsync: (_name, job) => job() } }, bounds: { getEntityWorldBounds: () => null },
    });
    effects.modelEntranceRuntime = f.entrance;
    await effects.prepareModelEntrance(settings);
    sameIdentity(f.mesh.material, f.original, '物理source不应为了可见代理动画换材');
    differentIdentity(proxy.material, working, '真实可见GI代理应获得入口显示覆盖');
    assert.ok(proxy.material.pluginManager?.getPlugin('DigitalTwinModelEntrance'));
    assert.ok(proxy.material.pluginManager?.getPlugin('BakedIndirectLighting'), 'doNotSerialize的GI plugin必须显式保留');
    f.tick(); assert.equal(f.fingerprint(), baseline); assert.equal(f.lighting.getError(), null);
    f.complete();
    sameIdentity(proxy.material, working); sameIdentity(f.mesh.material, f.original);
    assert.equal(f.fingerprint(), baseline); assert.equal(f.lighting.getError(), null);
    // 对可见GI工作材质的真实业务编辑也必须沿租约树触发静态失效，不能只盯隐藏源。
    f.color(working).r = .913;
    f.tick(); assert.match(f.lighting.getError(), /静态对象.*变化/);
    assert.equal(f.color(f.original).r, .913, '回退实时基线保留可见工作材质接收的业务颜色');
  } finally { f.dispose(); }
});

test('真实lease释放遇setter/getActiveTextures错误仍撤销整棵映射、继续其它child并传播错误', () => {
  for (const failure of ['setter', 'getActiveTextures']) {
    const engine = new NullEngine(), scene = new Scene(engine);
    const original = new StandardMaterial('release-original', scene), parent = original.clone('release-parent');
    const parentLease = registerLightingMaterialOverride(parent, original, 'release-parent');
    const first = parent.clone('release-throwing-child'), second = parent.clone('release-normal-child');
    registerLightingMaterialOverride(first, parent, 'release-first');
    registerLightingMaterialOverride(second, parent, 'release-second');
    first.alpha = .41; second.diffuseColor.g = .73;
    const sentinel = new Error('controlled ' + failure + ' failure');
    const target = failure === 'setter' ? parent : first;
    const field = failure === 'setter' ? 'alpha' : 'getActiveTextures';
    const previous = Object.getOwnPropertyDescriptor(target, field);
    if (failure === 'setter') Object.defineProperty(parent, 'alpha', { configurable: true, get: () => 1, set: () => { throw sentinel; } });
    else Object.defineProperty(first, 'getActiveTextures', { configurable: true, value: () => { throw sentinel; } });
    try {
      const contains = error => error === sentinel || (Array.isArray(error?.errors) && error.errors.some(contains)) || (error?.cause && contains(error.cause));
      assert.throws(() => parentLease.release(), contains, '清理不能吞掉业务getter/setter异常');
      for (const material of [parent, first, second]) sameIdentity(resolveLightingMaterialOverride(material).material, material, '失败child或parent不能遗留活动identity映射');
      assert.equal(original.diffuseColor.g, .73, '一个child失败不能跳过另一个child及父级收束');
      assert.doesNotThrow(() => parentLease.release(), '已释放租约再次调用须幂等');
    } finally {
      if (previous) Object.defineProperty(target, field, previous); else Reflect.deleteProperty(target, field);
      parentLease.release(); scene.dispose(); engine.dispose();
    }
  }
});

test('真实GI独立Texture wrapper子字段变化触发失效，回退保留非冲突UV delta且不换源wrapper', async () => {
  for (const change of ['clone-only', 'original-only', 'nonconflict', 'conflict']) {
    const f = fixture();
    try {
      // null URL没有图像I/O；使用真实Texture.clone及材质复制路径，不能用同wrapper假装覆盖该缺口。
      const originalTexture = new Texture(null, f.scene);
      originalTexture.uScale = 1.25; originalTexture.vScale = 1.5;
      f.original.diffuseTexture = originalTexture;
      await f.bake(); f.tick(); assert.equal(f.lighting.getError(), null);
      const proxy = f.scene.meshes.find(mesh => mesh.metadata?.lightingDerived), workingTexture = proxy.material.diffuseTexture;
      assert.ok(workingTexture instanceof Texture);
      differentIdentity(workingTexture, originalTexture, '夹具必须验证独立wrapper上的子字段delta');
      assert.equal(workingTexture.uScale, 1.25); assert.equal(workingTexture.vScale, 1.5);
      if (change !== 'original-only') workingTexture.uScale = .625;
      if (change === 'conflict') originalTexture.uScale = .875;
      else if (change !== 'clone-only') originalTexture.vScale = .875;
      f.tick(); assert.match(f.lighting.getError(), /静态对象.*变化/);
      sameIdentity(f.original.diffuseTexture, originalTexture, '同一wrapper子字段更改不应被替换成另一对象');
      assert.equal(originalTexture.uScale, change === 'original-only' ? 1.25 : change === 'conflict' ? .875 : .625);
      assert.equal(originalTexture.vScale, change === 'original-only' || change === 'nonconflict' ? .875 : 1.5);
    } finally { f.dispose(); }
  }
});

test('动态非proxy GI工作材质的受控入口不触发binding重建打断，完成后恢复精确working对象', async () => {
  const f = fixture({ dynamic: true });
  try {
    await f.bake();
    const working = f.moving.material, proxies = f.scene.meshes.filter(mesh => mesh.metadata?.lightingDerived);
    assert.ok(working.pluginManager?.getPlugin('BakedIndirectLighting'));
    await f.entrance.prepare(settings, [{ id: 'moving-entity', node: f.moving, meshes: [f.moving] }]);
    const replacement = f.moving.material;
    differentIdentity(replacement, working);
    assert.ok(replacement.pluginManager?.getPlugin('DigitalTwinModelEntrance'));
    assert.ok(replacement.pluginManager?.getPlugin('BakedIndirectLighting'));
    f.entrance.start(); f.tick(.1);
    sameIdentity(f.moving.material, replacement, '有效入口lease不能被dynamicMaterialReplaced误当未知业务换材');
    assert.equal(f.entrance.getSnapshot().interruptedMeshCount, 0);
    assert.equal(f.lighting.getError(), null);
    f.complete();
    assert.equal(f.entrance.getSnapshot().status, 'completed');
    assert.equal(f.entrance.getSnapshot().interruptedMeshCount, 0);
    sameIdentity(f.moving.material, working);
    const current = f.scene.meshes.filter(mesh => mesh.metadata?.lightingDerived);
    assert.ok(current.length === proxies.length && current.every((mesh, index) => mesh === proxies[index]),
      `无物理变化时GI代理不能被刷新重建（actual=${current.length}:${current.slice(0, 8).map(label).join(',')}, expected=${proxies.length}:${proxies.slice(0, 8).map(label).join(',')}）`);
    assert.equal(f.lighting.getError(), null);
  } finally { f.dispose(); }
});

test('共享物理M和GI工作A时直接链限制target，物理root审计仍发现其它render target的B业务修改', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const [s1, s2, p1, p2] = ['source-1', 'source-2', 'proxy-1', 'proxy-2'].map(name => MeshBuilder.CreateBox(name, { size: 1 }, scene));
  const physical = new StandardMaterial('shared-physical-M', scene);
  s1.material = s2.material = physical;
  const baseline1 = lightingMaterialFingerprint(s1), baseline2 = lightingMaterialFingerprint(s2);
  const working = physical.clone('shared-working-A'), replacement = working.clone('entrance-B-for-P1');
  const targetsA = new Set([p1, p2]), targetsB = new Set([p1]);
  const leaseA = registerLightingMaterialOverride(working, physical, 'lighting', { targets: targetsA });
  const leaseB = registerLightingMaterialOverride(replacement, working, 'entrance', { targets: targetsB });
  p1.material = replacement; p2.material = working;
  try {
    assert.equal(lightingMaterialFingerprint(s1), baseline1);
    assert.equal(lightingMaterialFingerprint(s2), baseline2);
    assert.equal(isLightingMaterialOverrideOf(p1.material, working, p1), true);
    assert.equal(isLightingMaterialOverrideOf(p2.material, working, p2), true);
    p2.material = replacement;
    assert.equal(isLightingMaterialOverrideOf(p2.material, working, p2), false, '同父A不代表可以借用只属于P1的B');
    assert.equal(resolveLightingMaterialOverride(replacement, p2).stable, false, '未知target不能获得受控身份豁免');
    replacement.diffuseColor.r = .261;
    assert.equal(targetsB.has(s1), false, '物理source不是入口可见target，必须覆盖此分离边界');
    assert.notEqual(lightingMaterialFingerprint(s1), baseline1, 'root.children审计不能按source target筛掉P1/B');
    assert.notEqual(lightingMaterialFingerprint(s2), baseline2);
    assert.equal(resolveLightingMaterialOverride(physical, s1).stable, false);
  } finally {
    leaseB.release(); leaseA.release(); scene.dispose(); engine.dispose();
  }
});
