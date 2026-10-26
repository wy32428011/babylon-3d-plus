import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { Constants, Matrix, MeshBuilder, NullEngine, RawTexture, Scene, StandardMaterial, Texture, VertexBuffer } from '@babylonjs/core';

const root = new URL('../../', import.meta.url);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (/^@babylonjs\/(?:core|loaders)\//.test(specifier) && !specifier.endsWith('.js')) return next(specifier + '.js', context);
  if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && !context.parentURL.includes('/node_modules/')) {
    const target = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
    if (!specifier.endsWith('.ts') && existsSync(target)) return { url: target.href, shortCircuit: true };
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (url.startsWith(root.href) && /\.(?:png|jpg|webp|svg)$/.test(url)) return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
  if (url.startsWith(root.href) && url.endsWith('.ts') && !url.includes('/node_modules/')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
  return next(url, context);
} });
let SceneLightingRuntime, ModelEntranceRuntime, LightingProbeSampler, getNativeLightingInstances, getLightingGeometrySignature,
  normalizeSceneLightingConfig, getSceneLightingBakeSignature, registerLightingMaterialOverride, isLightingMaterialOverrideOf,
  collectLightingRuntimeSources, EntityArrayThinInstanceBatch;
try {
  ({ SceneLightingRuntime } = await import('../../src/runtime/babylon/SceneLightingRuntime.ts'));
  ({ ModelEntranceRuntime } = await import('../../src/runtime/babylon/ModelEntranceRuntime.ts'));
  ({ LightingProbeSampler } = await import('../../src/runtime/babylon/lightingProbes.ts'));
  ({ getNativeLightingInstances } = await import('../../src/runtime/babylon/lightingNativeInstances.ts'));
  ({ getLightingGeometrySignature } = await import('../../src/runtime/babylon/lightingRuntimeCapture.ts'));
  ({ normalizeSceneLightingConfig } = await import('../../electron/shared/sceneLightingConfig.ts'));
  ({ getSceneLightingBakeSignature } = await import('../../electron/shared/sceneLightingBakeContract.ts'));
  ({ registerLightingMaterialOverride, isLightingMaterialOverrideOf } = await import('../../src/runtime/babylon/lightingMaterialOverrides.ts'));
  ({ collectLightingRuntimeSources } = await import('../../src/runtime/babylon/lightingClassificationRuntime.ts'));
  ({ EntityArrayThinInstanceBatch } = await import('../../src/runtime/babylon/EntityArrayThinInstanceBatch.ts'));
} finally { hooks.deregister(); }

const settings = { enabled: true, effect: 'dissolve', durationSeconds: 2.5, delaySeconds: 0, color: '#00ccff', intensity: 1,
  axis: 'y', reverse: false, staggerSeconds: .15, particleCount: 600, particleSize: 3, spreadMeters: 3,
  assemblyDistanceMeters: 1.5, loop: false, loopIntervalSeconds: 1, scope: 'all', targetEntityIds: [] };
const label = value => `${value?.name?.slice(0, 64) ?? '-'}:${value?.uniqueId ?? '-'}`;
function sameIdentity(actual, expected, reason) { assert.ok(actual === expected, `${reason}: actual=${label(actual)}, expected=${label(expected)}`); }
function sameIdentities(actual, expected, reason) {
  assert.ok(actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    `${reason}: actual=${actual.slice(0, 8).map(label)}, expected=${expected.slice(0, 8).map(label)}`);
}

function fixture({ sharedGeometry = false } = {}) {
  const engine = new NullEngine(), scene = new Scene(engine);
  const fixed = MeshBuilder.CreateBox('static-receiver', { size: 1 }, scene); fixed.material = new StandardMaterial('static-material', scene);
  const carrier = MeshBuilder.CreateBox('fhb_tiHost-test', { size: 1 }, scene);
  if (sharedGeometry) fixed.geometry.applyToMesh(carrier);
  const original = new StandardMaterial('carrier-physical', scene), texture = new Texture(null, scene);
  texture.uScale = 1.25; original.diffuseTexture = texture; carrier.material = original;
  const matrices = new Float32Array(32); Matrix.Translation(3, 0, 0).copyToArray(matrices, 0); Matrix.Translation(5, 0, 0).copyToArray(matrices, 16);
  carrier.thinInstanceSetBuffer('matrix', matrices, 16, false);
  const geometryEvents = []; let geometryAction = null;
  const previousGeometryCallback = fixed.geometry.onGeometryUpdated;
  fixed.geometry.onGeometryUpdated = (geometry, kind) => {
    previousGeometryCallback?.(geometry, kind); geometryEvents.push(kind);
    geometryAction?.(geometry, kind);
  };
  const batch = getNativeLightingInstances(carrier, 'carrier-entity');
  const entity = (id, mobility) => ({ id, name: id, parentId: null, childrenIds: [], components: { meshRenderer: { type: 'box' }, lighting: { mobility },
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } } });
  const document = { name: 'thin-carrier-regression', entityIds: ['fixed', 'carrier-entity'], entities: { fixed: entity('fixed', 'static'), 'carrier-entity': entity('carrier-entity', 'dynamic') },
    sceneSettings: { environment: null, skybox: null, lighting: normalizeSceneLightingConfig({ bake: { enabled: true } }) } };
  const entry = (id, nodeKey, mobility) => ({ key: id + '/' + nodeKey, entityId: id, nodeKey, name: nodeKey, mobility, reason: 'real native thin adapter',
    castShadows: true, receiveShadows: true, bakeIndirect: mobility === 'static' });
  const sources = [{ mesh: fixed, entry: entry('fixed', '$mesh', 'static'), getWorldMatrix: () => fixed.computeWorldMatrix(true) },
    ...batch.getLightingInstances().map(value => ({ mesh: carrier, entry: entry('carrier-entity', 'native-' + value.sourceIndex, 'dynamic'),
      instance: { batch, mesh: carrier, sourceIndex: value.sourceIndex }, getWorldMatrix: () => batch.getLightingInstanceWorldMatrix(carrier, value.sourceIndex) }))];
  const geometry = { version: 1, positions: Array.from(fixed.getVerticesData(VertexBuffer.PositionKind)), normals: Array.from(fixed.getVerticesData(VertexBuffer.NormalKind)),
    indices: Array.from(fixed.getIndices()), uvs: Array.from(fixed.getVerticesData(VertexBuffer.UVKind)), bakeUvs: Array.from(fixed.getVerticesData(VertexBuffer.UVKind)) };
  const entrance = new ModelEntranceRuntime(scene); let delta = 0;
  scene.onBeforeRenderObservable.add(() => entrance.tick(delta, true));
  const lighting = new SceneLightingRuntime(scene, { getSources: () => sources, setShadowRoles: () => {}, pushLog: () => {}, classificationCoalesceMinMs: 0,
    loadResources: async () => {
      const lightmap = new RawTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, Constants.TEXTUREFORMAT_RGBA, scene, false, false);
      return { geometries: new Map([['geometry', geometry]]), textures: new Map([['map', lightmap]]),
        probes: new LightingProbeSampler({ version: 1, encoding: 'ambient-cube', spacing: 4, probes: [{ position: [3, 0, 0], irradiance: Array(18).fill(.3) }] }), dispose() { lightmap.dispose(); } };
    } });
  lighting.sync(document);
  const bake = () => lighting.applySnapshot({ version: 1, signature: getSceneLightingBakeSignature(document), geometrySignature: getLightingGeometrySignature(sources),
    createdAt: new Date().toISOString(), engineVersion: 'real native thin NullEngine fixture', probeAssetId: 'probes',
    assets: [{ id: 'geometry', kind: 'geometry', url: 'memory://geometry', byteLength: 1 }, { id: 'map', kind: 'lightmap', url: 'memory://map', byteLength: 1, rgbmRange: 1 },
      { id: 'probes', kind: 'probes', url: 'memory://probes', byteLength: 1 }],
    surfaces: [{ key: 'fixed/$mesh/primitive:0', entityId: 'fixed', nodeKey: '$mesh', geometryAssetId: 'geometry', lightmapAssetId: 'map' }],
    statistics: { meshCount: 1, triangleCount: 12, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 1 } });
  const dynamic = () => lighting.state.records.filter(record => record.dynamic && record.proxy);
  return { engine, scene, document, fixed, carrier, original, texture, batch, sources, entrance, lighting, bake, dynamic, geometryEvents,
    setGeometryAction(action) { geometryAction = action; },
    tick(seconds = 0) { delta = seconds; scene.onBeforeRenderObservable.notifyObservers(scene); },
    prepare() { return entrance.prepare(settings, [{ id: 'carrier-entity', node: carrier, meshes: [carrier, ...dynamic().map(record => record.mesh)] }]); },
    dispose() { entrance.dispose(); lighting.dispose(); scene.dispose(); engine.dispose(); } };
}

test('真实thin Mesh carrier的合法Entrance源覆盖不重建两个logical GI proxy', async () => {
  const f = fixture();
  try {
    assert.equal(f.carrier.getClassName(), 'Mesh'); assert.equal(f.carrier.hasThinInstances, true);
    assert.equal(f.batch.getLightingInstances().length, 2);
    await f.bake(); const records = [...f.dynamic()], proxies = records.map(record => record.mesh);
    assert.equal(records.length, 2); assert.ok(records.every(record => record.source.mesh === f.carrier));
    await f.prepare(); const replacement = f.carrier.material;
    assert.ok(replacement !== f.original);
    f.entrance.start(); f.tick(.1);
    sameIdentities(f.dynamic().map(record => record.mesh), proxies, '合法carrier显示覆盖不能导致proxy raw比较重建');
    sameIdentity(f.carrier.material, replacement, 'carrier入口覆盖仍属于当前会话');
    assert.equal(f.lighting.getError(), null); assert.equal(f.entrance.getSnapshot().interruptedMeshCount, 0);
    f.carrier.thinInstanceSetMatrixAt(0, Matrix.Translation(3.25, 0, 0), false);
    f.carrier.thinInstanceBufferUpdated('matrix'); f.tick(.1);
    assert.equal(f.dynamic()[0].mesh.computeWorldMatrix(true).getTranslation().x, 3.25, '真实动态矩阵数据仍即时读取');
    assert.equal(f.dynamic()[1].mesh.computeWorldMatrix(true).getTranslation().x, 5);
    sameIdentities(f.dynamic().map(record => record.mesh), proxies, '动态位姿变化沿既有代理传播');
  } finally { f.dispose(); }
});

test('thin carrier稳定显示Texture clone不改logical来源签名，真实动态颜色/UV仍传播且target借用拒绝', async () => {
  const f = fixture(); let lease, wrongLease;
  try {
    await f.bake();
    const records = [...f.dynamic()], proxies = records.map(record => record.mesh);
    const signatures = records.map(record => record.sourceMaterialSignature), textures = proxies.map(proxy => proxy.material.diffuseTexture);
    const display = f.original.clone('controlled-carrier-display');
    assert.ok(display.diffuseTexture !== f.texture, '必须用真实独立Texture wrapper而非共享指针');
    lease = registerLightingMaterialOverride(display, f.original, 'entrance', { targets: new Set([f.carrier]) });
    f.carrier.material = display; f.tick();
    sameIdentities(f.dynamic().map(record => record.mesh), proxies, '稳定受控来源不重建代理');
    assert.deepEqual(f.dynamic().map(record => record.sourceMaterialSignature), signatures, '显示wrapper唯一id不能变成新的物理来源');
    proxies.forEach((proxy, index) => sameIdentity(proxy.material.diffuseTexture, textures[index], '稳定显示wrapper不能替换GI工作Texture'));
    display.diffuseColor.r = .32; f.tick();
    assert.ok(proxies.every(proxy => proxy.material.diffuseColor.r === .32), '真实动态clone颜色修改仍即时传播');
    f.original.diffuseColor.g = .61; f.tick();
    assert.ok(proxies.every(proxy => proxy.material.diffuseColor.r === .32 && proxy.material.diffuseColor.g === .61), '原对象的非冲突业务更新不能被旧显示clone遮蔽');
    display.diffuseTexture.uScale = .75; f.tick();
    assert.ok(proxies.every(proxy => proxy.material.diffuseTexture.uScale === .75), '真正UV值变化不能被稳定wrapper归一化吞掉');
    sameIdentities(f.dynamic().map(record => record.mesh), proxies, '动态值变化不应要求静态GI重建');
    assert.equal(f.lighting.getError(), null);
    const wrong = display.clone('proxy-only-borrowed-source');
    wrongLease = registerLightingMaterialOverride(wrong, display, 'entrance', { targets: new Set([proxies[0]]) });
    f.carrier.material = wrong;
    assert.equal(isLightingMaterialOverrideOf(wrong, f.original, f.carrier), false);
    assert.equal(f.lighting.dynamicMaterialReplaced(f.lighting.state), true, '代理专属显示材质借给carrier仍属未知来源替换');
    f.carrier.material = display;
  } finally { wrongLease?.release(); lease?.release(); f.dispose(); }
});

test('共享真实Geometry的dtEntranceInstance安装/更新/清理不误伤static watch，原SDK通知仍完整', async () => {
  const f = fixture({ sharedGeometry: true });
  try {
    sameIdentity(f.carrier.geometry, f.fixed.geometry, '真实SDK共享Geometry必须成立');
    await f.bake();
    assert.ok(f.lighting.state.staticWatch.some(watch => watch.geometry === f.carrier.geometry));
    f.geometryEvents.length = 0;
    await f.prepare();
    const installed = [...f.geometryEvents];
    assert.ok(installed.includes('dtEntranceInstance'), 'SDK安装仍须通知既有业务callback');
    assert.equal(f.lighting.pendingInvalidation, null, '受控显示属性不能被误当静态物理几何变化');
    f.entrance.start(); const beforeUpdate = f.geometryEvents.length; f.tick(.1);
    assert.equal(f.geometryEvents.length - beforeUpdate, 0, '当前SDK updatable buffer普通更新不发Geometry更新通知');
    assert.equal(f.lighting.getError(), null);
    const beforeCleanup = f.geometryEvents.length; f.entrance.cancel();
    assert.equal(f.geometryEvents.length - beforeCleanup, 0, '当前SDK removeVerticesData清理不发Geometry通知');
    f.tick(); assert.equal(f.lighting.getError(), null);
    assert.equal(f.carrier.isVerticesDataPresent('dtEntranceInstance'), false);
  } finally { f.dispose(); }
});

test('共享Geometry中positions/indices/未知业务写仍失效，包括从受控显示写callback内重入', async () => {
  for (const kind of ['position', 'indices', 'unknown']) for (const reentrant of [false, true]) {
    const f = fixture({ sharedGeometry: true });
    try {
      await f.bake(); let done = false;
      const mutate = () => {
        if (done) return; done = true;
        if (kind === 'position') { const values = Array.from(f.carrier.getVerticesData(VertexBuffer.PositionKind)); values[0] += .125; f.carrier.setVerticesData(VertexBuffer.PositionKind, values, true); assert.equal(f.fixed.getVerticesData(VertexBuffer.PositionKind)[0], values[0]); }
        else if (kind === 'indices') { const values = Array.from(f.carrier.getIndices()); [values[0], values[1]] = [values[1], values[0]]; f.carrier.updateIndices(values); assert.equal(f.fixed.getIndices()[0], values[0]); }
        else f.carrier.setVerticesData('businessDeformation', new Float32Array(f.carrier.getTotalVertices()).fill(.12), true, 1);
      };
      if (reentrant) { f.setGeometryAction((_geometry, name) => { if (name === 'dtEntranceInstance') mutate(); }); await f.prepare(); }
      else mutate();
      assert.equal(done, true);
      assert.ok(f.lighting.pendingInvalidation !== null, `${kind}业务写不能在显示scope内被豁免`);
      f.tick(); assert.match(f.lighting.getError(), /静态对象.*几何.*变化/);
    } finally { f.dispose(); }
  }
});

test('真实batch collector保留已有logicalMesh引用，GI选择同entity精确映射且隐藏代理不回落prototype', async () => {
  const f = fixture(); let batch;
  try {
    const first = MeshBuilder.CreateBox('logical-source-a', { size: 1 }, f.scene), second = MeshBuilder.CreateBox('logical-source-b', { size: 1 }, f.scene);
    first.material = second.material = f.original;
    const secondId = 'second-entity';
    f.document.entities[secondId] = { ...f.document.entities['carrier-entity'], id: secondId, name: secondId };
    f.document.entityIds.push(secondId);
    batch = EntityArrayThinInstanceBatch.create('alias-source', [first], { interactive: false }); assert.ok(batch);
    const item = (entityId, x) => ({ entityId, pickable: true, transform: { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
    batch.updateEntityTransforms(Matrix.Identity(), [item('carrier-entity', 3), item(secondId, 5)]);
    const actual = collectLightingRuntimeSources({ scene: f.scene, document: f.document, models: [],
      primitiveMeshes: new Map([['fixed', f.fixed], ['carrier-entity', first], [secondId, second]]), environment: [], batches: [batch],
      resolveBatchSource: (_batch, id) => id === secondId ? second : first,
      getMotionTargets: () => ({ moving: [], fixed: [], known: true }), readEntityId: () => null });
    const aliases = actual.filter(source => source.instance);
    assert.equal(aliases.length, 2);
    sameIdentity(aliases[0].logicalMesh, first, 'collector保存真实首源对象引用');
    sameIdentity(aliases[1].logicalMesh, second, 'collector保存真实次源对象引用');
    assert.ok(aliases.every(source => source.mesh !== source.logicalMesh), '实际batch carrier与逻辑源必须分离');
    f.sources.splice(0, f.sources.length, ...actual); f.lighting.markDirty('alias-fixture'); await f.bake();
    const records = f.dynamic(), firstProxy = records.find(record => record.source.entry.entityId === 'carrier-entity').mesh;
    const secondProxy = records.find(record => record.source.entry.entityId === secondId).mesh;
    sameIdentities(f.lighting.getSelectionMeshes('carrier-entity', [first]), [firstProxy], '首entity只映射自己的actual alias');
    sameIdentities(f.lighting.getSelectionMeshes(secondId, [second]), [secondProxy], '次entity只映射自己的actual alias');
    const lookalike = MeshBuilder.CreateBox(first.name, { size: 1 }, f.scene);
    assert.ok(f.lighting.getSelectionMeshes('carrier-entity', [lookalike]).every(mesh => mesh !== firstProxy && mesh !== secondProxy), '同名不同对象不能当作alias');
    assert.ok(f.lighting.getSelectionMeshes('carrier-entity', [second]).every(mesh => mesh !== secondProxy), '别的entity源不能串到其GI proxy');
    firstProxy.setEnabled(false);
    assert.equal(f.lighting.getSelectionMeshes('carrier-entity', [first]).length, 0, '已知own proxy全部隐藏时不能fallback原型');
    assert.ok(secondProxy.isEnabled());
  } finally { f.lighting.dispose(); batch?.dispose(); f.dispose(); }
});
