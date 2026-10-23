import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { ArcRotateCamera, Color3, Constants, DirectionalLight, HemisphericLight, Matrix, MeshBuilder, NullEngine, PointLight, RawTexture, Scene, SpotLight, StandardMaterial, SubMesh, TransformNode, Vector3, VertexBuffer } from '@babylonjs/core';

const project = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(project.href) && !specifier.endsWith('.ts')) {
      const file = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
      if (existsSync(file)) return { url: file.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(project.href) && /\.(png|jpg|webp|bin)(\?.*)?$/.test(url)) return {
      format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(url) + ';',
    };
    if (url.startsWith(project.href) && url.endsWith('.ts') && !url.includes('/node_modules/')) return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const { SceneLightingRuntime } = await import('../../src/runtime/babylon/SceneLightingRuntime.ts');
const { ModelAssetRuntimeController } = await import('../../src/runtime/babylon/scene-runtime/ModelAssetRuntimeController.ts');
const { SceneTriangleAndReadinessController } = await import('../../src/runtime/babylon/scene-runtime/SceneTriangleAndReadinessController.ts');
const { LightingProbeSampler } = await import('../../src/runtime/babylon/lightingProbes.ts');
const { captureLightingEnvironment, getLightingGeometrySignature } = await import('../../src/runtime/babylon/lightingRuntimeCapture.ts');
const { validateLightingBakeInput } = await import('../../electron/ipc/lightingBakeValidation.ts');
const { validateLightingGeometry } = await import('../../src/runtime/babylon/lightingRuntimeResources.ts');
const { getNativeLightingInstances } = await import('../../src/runtime/babylon/lightingNativeInstances.ts');
const { EntityArrayThinInstanceBatch } = await import('../../src/runtime/babylon/EntityArrayThinInstanceBatch.ts');
const { HybridShadowMeshState } = await import('../../src/runtime/babylon/HybridShadowCache.ts');
const { getSceneLightingBakeSignature } = await import('../../electron/shared/sceneLightingBakeContract.ts');
const { normalizeSceneLightingConfig, normalizeSceneAppearanceConfig } = await import('../../electron/shared/sceneLightingConfig.ts');
hooks.deregister();

function fixture(options = {}) {
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 0, 1, 12, Vector3.Zero(), scene);
  const hemi = new HemisphericLight('ambient', Vector3.Up(), scene); hemi.intensity = 0.7;
  const document = { name: 'light-test', sceneSettings: {
    environment: null, skybox: null, appearance: normalizeSceneAppearanceConfig(undefined),
    lighting: normalizeSceneLightingConfig({ bake: { enabled: true, quality: 'preview', atlasSize: 1024, texelsPerMeter: 8, probeSpacing: 4, maxTextureMiB: 16, cacheStaticShadows: true, dynamicShadows: true } }),
  } };
  const entity = (id, mobility) => ({ id, name: id, parentId: null, childrenIds: [], components: { meshRenderer: { type: 'box' }, lighting: { mobility },
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } } });
  const staticEntity = entity('fixed-entity', 'static'), dynamicEntity = entity('moving-entity', 'dynamic');
  document.entities = { [staticEntity.id]: staticEntity, [dynamicEntity.id]: dynamicEntity };
  document.entityIds = [staticEntity.id, dynamicEntity.id];
  const fixed = MeshBuilder.CreateBox('fixed', { size: 1 }, scene);
  fixed.material = new StandardMaterial('fixed-material', scene);
  fixed.material.diffuseColor = new Color3(0.2, 0.3, 0.4);
  const moving = MeshBuilder.CreateBox('moving', { size: 1 }, scene);
  moving.position.x = 3; moving.material = new StandardMaterial('moving-material', scene);
  const originalFixedMaterial = fixed.material, originalMovingMaterial = moving.material, originalLayerMask = fixed.layerMask;
  const source = (mesh, entity, mobility) => ({ mesh, entry: { key: entity.id + '/$mesh', entityId: entity.id, nodeKey: '$mesh',
    name: mesh.name, mobility, reason: 'test', castShadows: true, receiveShadows: true, bakeIndirect: mobility === 'static', parentDynamic: false },
    getWorldMatrix: () => mesh.computeWorldMatrix(true) });
  const sources = [source(fixed, staticEntity, 'static'), source(moving, dynamicEntity, 'dynamic')];
  const geometry = { version: 1, positions: Array.from(fixed.getVerticesData(VertexBuffer.PositionKind)), normals: Array.from(fixed.getVerticesData(VertexBuffer.NormalKind)),
    indices: Array.from(fixed.getIndices()), uvs: Array.from(fixed.getVerticesData(VertexBuffer.UVKind)), bakeUvs: Array.from(fixed.getVerticesData(VertexBuffer.UVKind)) };
  let mode = 'normal', releaseLoader = null, disposedResources = 0, lastResources = null, roles = new Map(), failRoles = false;
  const log = [];
  const runtime = new SceneLightingRuntime(scene, {
    getSources: () => sources,
    setShadowRoles: next => { if (failRoles) { failRoles = false; throw new Error('test commit failure'); } roles = new Map(next); },
    pushLog: message => log.push(message),
    onBindingsChanged: options.onBindingsChanged,
    loadResources: async () => {
      if (mode === 'fail') throw new Error('test resource failure');
      if (mode === 'pause') await new Promise(resolve => { releaseLoader = resolve; });
      const texture = new RawTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, Constants.TEXTUREFORMAT_RGBA, scene, false, false);
      texture.gammaSpace = false;
      const resources = {
        geometries: new Map([['geometry', geometry]]), textures: new Map([['lightmap', texture]]),
        probes: new LightingProbeSampler({ version: 1, encoding: 'ambient-cube', spacing: 4, probes: [
          { position: [3, 1, 0], irradiance: Array(18).fill(0.3) },
        ] }),
        dispose() { disposedResources++; texture.dispose(); },
      };
      options.decorateResources?.(resources);
      lastResources = resources; return resources;
    },
  });
  runtime.sync(document);
  const snapshot = () => ({ version: 1, signature: getSceneLightingBakeSignature(document), geometrySignature: getLightingGeometrySignature(sources),
    createdAt: new Date().toISOString(), engineVersion: 'test', probeAssetId: 'probes',
    assets: [{ id: 'geometry', kind: 'geometry', url: 'memory://geometry', byteLength: 1 }, { id: 'lightmap', kind: 'lightmap', url: 'memory://lightmap', byteLength: 1, rgbmRange: 1 },
      { id: 'probes', kind: 'probes', url: 'memory://probes', byteLength: 1 }],
    surfaces: [{ key: sources[0].entry.key + '/primitive:0', entityId: staticEntity.id, nodeKey: '$mesh', geometryAssetId: 'geometry', lightmapAssetId: 'lightmap' }],
    statistics: { meshCount: 1, triangleCount: 12, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 1 },
  });
  return { engine, scene, camera, hemi, document, staticEntity, dynamicEntity, fixed, moving, sources, geometry, runtime, snapshot, log,
    originalFixedMaterial, originalMovingMaterial, originalLayerMask,
    setMode(value) { mode = value; }, release() { releaseLoader?.(); },
    failNextRoleUpdate() { failRoles = true; },
    get resources() { return lastResources; }, get disposedResources() { return disposedResources; }, get roles() { return roles; },
    tick() { scene.onBeforeRenderObservable.notifyObservers(scene); },
    proxies() { return scene.meshes.filter(mesh => mesh.metadata?.lightingDerived && !mesh.metadata?.editorHelper); },
    dispose() { runtime.dispose(); scene.dispose(); engine.dispose(); },
  };
}

test('atomic application uses independent root proxies and restores original material, layer and ambient state', async () => {
  const f = fixture();
  try {
    await f.runtime.applySnapshot(f.snapshot());
    const [proxy] = f.proxies();
    assert.ok(proxy);
    assert.equal(proxy.parent, null);
    assert.equal(proxy.metadata.editorEntityId, f.staticEntity.id);
    assert.match(proxy.name, /^__LightingDerived_[a-f0-9]+$/);
    assert.equal(f.fixed.getChildMeshes().length, 0, '代理不得进入业务层级遍历');
    assert.equal(f.fixed.layerMask, 0);
    assert.equal(f.fixed.isVisible, true, '原isVisible保留给脚本和失效检测');
    assert.equal(f.fixed.material, f.originalFixedMaterial);
    assert.notEqual(proxy.material, f.originalFixedMaterial);
    assert.notEqual(f.moving.material, f.originalMovingMaterial);
    assert.equal(f.hemi.intensity, 0.7);
    assert.ok(f.hemi.canAffectMesh(proxy), 'GI只替换漫反射，不排除原生Hemi高光');
    assert.ok(f.hemi.canAffectMesh(f.moving));
    assert.equal(f.roles.get(f.fixed).castShadows, false);
    assert.equal(f.roles.get(proxy).castShadows, true);
    f.runtime.setPreview(false, true);
    assert.deepEqual(Array.from(f.hemi.excludedMeshes), []);
    f.runtime.setPreview(false, false);
    assert.ok(f.hemi.canAffectMesh(proxy));
    f.document.sceneSettings.lighting.bake.enabled = false; f.document.sceneSettings.lighting.shadows.enabled = false;
    f.runtime.sync(f.document);
    assert.equal(f.proxies().length, 0);
    assert.equal(f.fixed.layerMask, f.originalLayerMask);
    assert.equal(f.moving.material, f.originalMovingMaterial);
    assert.deepEqual(Array.from(f.hemi.excludedMeshes), []);
    assert.equal(f.disposedResources, 1);
  } finally { f.dispose(); }
});

test('canonical appearance and shadow switches retain valid GI, while actual light changes restore the realtime baseline', async () => {
  const f = fixture();
  try {
    const snapshot = f.snapshot();
    f.document.sceneSettings.lighting.result = snapshot;
    await f.runtime.applySnapshot(snapshot);
    const [proxy] = f.proxies(), workingMaterial = f.moving.material;
    f.document.sceneSettings.appearance.exposure = 1.6;
    f.document.sceneSettings.appearance.contrast = 1.2;
    f.document.sceneSettings.lighting.shadows.enabled = false;
    f.runtime.sync(f.document); f.tick();
    assert.equal(f.proxies()[0], proxy); assert.equal(f.moving.material, workingMaterial);
    assert.equal(f.runtime.getError(), null); assert.equal(f.disposedResources, 0);
    f.document.sceneSettings.lighting.shadows.enabled = true;
    f.runtime.sync(f.document); f.tick();
    assert.equal(f.proxies()[0], proxy); assert.equal(f.runtime.getError(), null);
    f.hemi.intensity += 0.1; f.tick();
    assert.equal(f.proxies().length, 0); assert.equal(f.moving.material, f.originalMovingMaterial);
    assert.match(f.runtime.getError(), /灯光或环境照明发生变化/);
    assert.equal(f.disposedResources, 1);
  } finally { f.dispose(); }
});

test('resource failure and cancelled replacement keep the previous valid result intact', async () => {
  const f = fixture();
  try {
    const snapshot = f.snapshot();
    await f.runtime.applySnapshot(snapshot);
    const [proxy] = f.proxies(), material = f.moving.material, resources = f.resources;
    f.setMode('fail');
    await assert.rejects(f.runtime.applySnapshot(snapshot), /test resource failure/);
    assert.equal(f.proxies()[0], proxy);
    assert.equal(f.moving.material, material);
    assert.equal(f.resources, resources);
    assert.equal(f.disposedResources, 0);
    f.setMode('pause');
    const controller = new AbortController();
    const pending = assert.rejects(f.runtime.applySnapshot(snapshot, controller.signal), /cancelled/);
    controller.abort(new Error('cancelled'));
    f.release();
    await pending;
    assert.equal(f.proxies()[0], proxy);
    assert.equal(f.disposedResources, 1, '只释放取消任务的候选资源');
  } finally { f.dispose(); }
});

test('selection maps active GI proxies, preserves caller node filters and notifies every visible switch', async () => {
  let changes = 0;
  const f = fixture({ onBindingsChanged: () => { changes++; } });
  try {
    assert.equal(changes, 0, '构造和首次无GI同步不能提前调用SceneRuntime回调');
    assert.deepEqual(f.runtime.getSelectionMeshes('fixed-entity'), []);
    assert.deepEqual(f.runtime.getSelectionMeshes('fixed-entity', [f.fixed]), [f.fixed]);
    await f.runtime.applySnapshot(f.snapshot());
    const [proxy] = f.proxies();
    assert.deepEqual(f.runtime.getSelectionMeshes('fixed-entity'), [proxy]);
    assert.deepEqual(f.runtime.getSelectionMeshes('fixed-entity', [f.fixed]), [proxy]);
    assert.deepEqual(f.runtime.getSelectionMeshes('fixed-entity', [f.moving]), [f.moving], '原调用排除固定轨道时不得重新加入其代理');
    assert.deepEqual(f.runtime.getSelectionMeshes('moving-entity'), [], '无代理的动态网格继续使用调用方原粒度');
    f.runtime.setPreview(false, true);
    assert.deepEqual(f.runtime.getSelectionMeshes('fixed-entity'), [proxy], '前后比较仍绘制同一代理');
    f.document.sceneSettings.lighting.bake.enabled = false; f.runtime.sync(f.document);
    assert.deepEqual(f.runtime.getSelectionMeshes('fixed-entity'), []);
    assert.deepEqual(f.runtime.getSelectionMeshes('fixed-entity', [f.fixed]), [f.fixed]);
    assert.ok(changes >= 3);
  } finally { f.dispose(); }
});

test('post-activation validation failure rolls back original live resources without reading them again', async () => {
  const f = fixture();
  try {
    const snapshot = f.snapshot();
    await f.runtime.applySnapshot(snapshot);
    const [original] = f.proxies(), material = f.moving.material, resources = f.runtime.state.resources;
    let staged;
    await assert.rejects(f.runtime.applySnapshot(snapshot, undefined, async () => {
      [staged] = f.runtime.getSelectionMeshes(f.staticEntity.id);
      assert.notEqual(staged, original, '验证前已临时显示候选');
      assert.equal(original.isDisposed(), false, '验证期间旧代理和资源仍保留');
      assert.equal(original.isEnabled(), false, '旧代理仅留作事务回滚，不应继续绘制');
      f.moving.material.diffuseColor.set(0.1, 0.8, 0.2);
      f.setMode('fail');
      throw new Error('render validation failed');
    }), /render validation failed/);
    assert.equal(f.proxies()[0], original);
    assert.equal(f.moving.material, material);
    assert.deepEqual(material.diffuseColor.asArray(), [0.1, 0.8, 0.2], '回滚光照不得撤销候选期间的实时业务颜色');
    assert.equal(f.runtime.state.resources, resources);
    assert.equal(staged.isDisposed(), true);
    assert.equal(f.disposedResources, 1, '只释放候选资源，无须重新加载原资源');
  } finally { f.dispose(); }
});

test('cancel during render validation immediately restores old state even when callback and future loader cannot finish', async () => {
  const f = fixture();
  let release;
  try {
    const snapshot = f.snapshot(); await f.runtime.applySnapshot(snapshot);
    const [original] = f.proxies(), resources = f.runtime.state.resources;
    const controller = new AbortController();
    let entered;
    const atValidation = new Promise(resolve => { entered = resolve; });
    const validation = new Promise(resolve => { release = resolve; });
    const pending = assert.rejects(f.runtime.applySnapshot(snapshot, controller.signal, async () => {
      f.setMode('fail'); entered(); await validation;
    }), /cancel-render-validation/);
    await atValidation;
    controller.abort(new Error('cancel-render-validation'));
    await pending;
    assert.equal(f.proxies()[0], original);
    assert.equal(f.runtime.state.resources, resources);
    assert.equal(f.disposedResources, 1);
  } finally { release?.(); f.dispose(); }
});

test('a superseding operation cannot leave an unvalidated candidate active when its next resource load fails', async () => {
  const f = fixture();
  let release;
  try {
    const snapshot = f.snapshot(); await f.runtime.applySnapshot(snapshot);
    const [original] = f.proxies(), resources = f.runtime.state.resources;
    let entered;
    const atValidation = new Promise(resolve => { entered = resolve; });
    const validation = new Promise(resolve => { release = resolve; });
    const first = assert.rejects(f.runtime.applySnapshot(snapshot, undefined, async () => {
      entered(); await validation;
    }));
    await atValidation; f.setMode('fail');
    await assert.rejects(f.runtime.applySnapshot(snapshot), /test resource failure/);
    await first;
    assert.equal(f.proxies()[0], original);
    assert.equal(f.runtime.state.resources, resources);
    assert.equal(f.disposedResources, 1);
  } finally { release?.(); f.dispose(); }
});

test('late geometry changes cannot pass final render validation', async () => {
  const f = fixture();
  try {
    const snapshot = f.snapshot();
    await assert.rejects(f.runtime.applySnapshot(snapshot, undefined, async () => {
      f.fixed.position.x += 2;
    }), /验证光照期间静态几何已经变化/);
    assert.equal(f.proxies().length, 0);
    assert.equal(f.fixed.layerMask, f.originalLayerMask);
    assert.equal(f.moving.material, f.originalMovingMaterial);
    assert.equal(f.disposedResources, 1);
  } finally { f.dispose(); }
});

test('a business material replacement during validation survives rollback and the next GI rebind', async () => {
  const f = fixture();
  try {
    const snapshot = f.snapshot(); await f.runtime.applySnapshot(snapshot);
    const replacement = new StandardMaterial('replacement-during-validation', f.scene);
    replacement.diffuseColor.set(0.2, 0.9, 0.3);
    await assert.rejects(f.runtime.applySnapshot(snapshot, undefined, async () => {
      f.moving.material = replacement;
      throw new Error('cancel-material-validation');
    }), /cancel-material-validation/);
    assert.equal(f.moving.material, replacement);
    f.tick();
    assert.notEqual(f.moving.material, replacement);
    assert.deepEqual(f.moving.material.diffuseColor.asArray(), [0.2, 0.9, 0.3]);
    f.document.sceneSettings.lighting.bake.enabled = false; f.runtime.sync(f.document);
    assert.equal(f.moving.material, replacement);
  } finally { f.dispose(); }
});

test('sync during candidate validation retains old resources until the validation result is known', async () => {
  const f = fixture();
  try {
    const snapshot = f.snapshot(); await f.runtime.applySnapshot(snapshot);
    const [original] = f.proxies();
    await assert.rejects(f.runtime.applySnapshot(snapshot, undefined, async () => {
      f.document.sceneSettings.lighting.result = snapshot;
      f.runtime.sync(f.document);
      assert.equal(original.isDisposed(), false);
      assert.equal(f.disposedResources, 0);
      throw new Error('validation after sync failed');
    }), /validation after sync failed/);
    assert.deepEqual(f.runtime.getSelectionMeshes(f.staticEntity.id), [original]);
    assert.equal(f.disposedResources, 1);
  } finally { f.dispose(); }
});

test('native point light filters follow proxy substitution and retain live user policy edits after clearing', async () => {
  const f = fixture();
  try {
    const included = new PointLight('included', Vector3.Up(), f.scene);
    const excluded = new PointLight('excluded', Vector3.Up(), f.scene);
    included.includedOnlyMeshes = [f.fixed]; excluded.excludedMeshes = [f.fixed];
    await f.runtime.applySnapshot(f.snapshot());
    const [proxy] = f.runtime.getSelectionMeshes(f.staticEntity.id);
    assert.equal(included.canAffectMesh(proxy), true);
    assert.equal(excluded.canAffectMesh(proxy), false);
    assert.equal(proxy.lightSources.includes(included), true);
    assert.equal(proxy.lightSources.includes(excluded), false);
    included.includedOnlyMeshes.push(f.moving);
    excluded.excludedMeshes = [f.moving];
    f.tick();
    assert.equal(included.canAffectMesh(proxy), true);
    assert.equal(excluded.canAffectMesh(proxy), true);
    assert.equal(proxy.lightSources.includes(excluded), true, '移除旧排除项必须同步原生Light sources');
    f.runtime.setPreview(false, true);
    assert.equal(included.canAffectMesh(proxy), true, '比较仍保持灯光过滤');
    f.document.sceneSettings.lighting.bake.enabled = false; f.runtime.sync(f.document);
    assert.deepEqual(Array.from(included.includedOnlyMeshes), [f.fixed, f.moving]);
    assert.deepEqual(Array.from(excluded.excludedMeshes), [f.moving]);
    assert.equal(f.fixed.lightSources.includes(excluded), true);
  } finally { f.dispose(); }
});

test('static motion invalidates GI without freezing the source or automatically reapplying stale data', async () => {
  const f = fixture();
  try {
    const snapshot = f.snapshot();
    f.document.sceneSettings.lighting.result = snapshot;
    await f.runtime.applySnapshot(snapshot);
    f.fixed.position.x = 5;
    f.tick();
    assert.match(f.runtime.getError(), /静态对象.*姿态/);
    assert.equal(f.fixed.position.x, 5);
    assert.equal(f.proxies().length, 0);
    assert.equal(f.fixed.layerMask, f.originalLayerMask);
    f.runtime.markDirty(); f.tick();
    await f.runtime.whenReady();
    assert.equal(f.proxies().length, 0);
  } finally { f.dispose(); }
});

test('geometry hooks preserve existing listeners and restore baseline after an actual vertex update', async () => {
  const f = fixture();
  let updates = 0;
  const listener = () => { updates++; };
  f.fixed.geometry.onGeometryUpdated = listener;
  try {
    await f.runtime.applySnapshot(f.snapshot());
    const positions = Array.from(f.fixed.getVerticesData(VertexBuffer.PositionKind)); positions[0] += 1;
    f.fixed.setVerticesData(VertexBuffer.PositionKind, positions, false);
    f.tick();
    assert.ok(updates > 0);
    assert.match(f.runtime.getError(), /几何/);
    assert.equal(f.fixed.geometry.onGeometryUpdated, listener);
    assert.equal(f.proxies().length, 0);
  } finally { f.dispose(); }
});

test('dynamic objects outside probe coverage keep baseline hemispheric illumination', async () => {
  const f = fixture();
  try {
    await f.runtime.applySnapshot(f.snapshot());
    assert.ok(f.runtime.state.bindings.get(f.moving).probes);
    assert.ok(f.hemi.canAffectMesh(f.moving));
    f.moving.position.x = 1000;
    f.tick();
    assert.equal(f.runtime.getError(), null);
    assert.equal(f.hemi.excludedMeshes.includes(f.moving), false);
    assert.equal(f.runtime.state.bindings.get(f.moving).probes, undefined);
    assert.ok(f.hemi.canAffectMesh(f.proxies()[0]));
    f.moving.position.x = 3; f.tick();
    assert.ok(f.runtime.state.bindings.get(f.moving).probes);
    assert.ok(f.hemi.canAffectMesh(f.moving));
  } finally { f.dispose(); }
});

test('debug classification preserves original materials and focus changes only the camera', async () => {
  const f = fixture();
  try {
    const before = JSON.stringify(f.document);
    f.runtime.setPreview(true, false);
    assert.equal(f.fixed.material, f.originalFixedMaterial);
    assert.equal(f.moving.material, f.originalMovingMaterial);
    assert.equal(f.scene.meshes.filter(mesh => mesh.metadata?.editorHelper).length, 2);
    f.runtime.focusNode(f.staticEntity.id, '$mesh');
    assert.equal(JSON.stringify(f.document), before);
    assert.ok(f.camera.radius > 0);
    f.runtime.setPreview(false, false);
    assert.equal(f.scene.meshes.filter(mesh => mesh.metadata?.editorHelper).length, 0);
  } finally { f.dispose(); }
});

test('geometry resources reject missing UVs, invalid topology and nonfinite values', () => {
  const valid = { version: 1, positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0],
    indices: [0, 1, 2], uvs: [0, 0, 1, 0, 0, 1], bakeUvs: [0, 0, 1, 0, 0, 1] };
  assert.equal(validateLightingGeometry(valid), valid);
  assert.throws(() => validateLightingGeometry({ ...valid, bakeUvs: [] }), /bakeUvs/);
  assert.throws(() => validateLightingGeometry({ ...valid, indices: [0, 1, 99] }), /索引/);
  assert.throws(() => validateLightingGeometry({ ...valid, positions: [NaN, ...valid.positions.slice(1)] }), /索引/);
});

test('telemetry colors survive successful resource replacement and disabling indirect light and shadows', async () => {
  const f = fixture();
  try {
    const snapshot = f.snapshot();
    await f.runtime.applySnapshot(snapshot);
    f.moving.material.diffuseColor.set(0.9, 0.2, 0.1);
    f.moving.material.alpha = 0.7;
    await f.runtime.applySnapshot(snapshot);
    assert.deepEqual(f.moving.material.diffuseColor.asArray(), [0.9, 0.2, 0.1]);
    f.document.sceneSettings.lighting.bake.enabled = false; f.document.sceneSettings.lighting.shadows.enabled = false; f.runtime.sync(f.document);
    assert.equal(f.moving.material, f.originalMovingMaterial);
    assert.deepEqual(f.moving.material.diffuseColor.asArray(), [0.9, 0.2, 0.1]);
    assert.equal(f.moving.material.alpha, 0.7);
  } finally { f.dispose(); }
});

test('a commit-stage error restores the previous proxies and source masks', async () => {
  const f = fixture();
  try {
    const snapshot = f.snapshot();
    await f.runtime.applySnapshot(snapshot);
    const [proxy] = f.proxies(), material = f.moving.material;
    f.failNextRoleUpdate();
    await assert.rejects(f.runtime.applySnapshot(snapshot), /test commit failure/);
    assert.equal(f.proxies().length, 1);
    assert.equal(f.proxies()[0], proxy);
    assert.equal(proxy.isEnabled(), true);
    assert.equal(f.fixed.layerMask, 0);
    assert.equal(f.moving.material, material);
    assert.ok(f.hemi.canAffectMesh(proxy));
    assert.equal(f.disposedResources, 1);
  } finally { f.dispose(); }
});

test('native thin instances keep all authoritative matrices and unbaked baseline leaves', async () => {
  const f = fixture();
  try {
    const matrices = new Float32Array(32);
    Matrix.Identity().copyToArray(matrices, 0);
    Matrix.Translation(2, 0, 0).copyToArray(matrices, 16);
    f.fixed.thinInstanceSetBuffer('matrix', matrices, 16, false);
    f.fixed.thinInstanceRefreshBoundingInfo(true);
    const batch = getNativeLightingInstances(f.fixed, f.staticEntity.id);
    const originalSource = f.sources[0];
    const entries = batch.getLightingInstances().map((entry, index) => ({
      mesh: f.fixed, entry: { ...originalSource.entry, key: originalSource.entry.key + '/instance:' + index, nodeKey: '$mesh/instance:' + index, bakeIndirect: index === 0 },
      instance: { batch, mesh: f.fixed, sourceIndex: index },
      getWorldMatrix: () => batch.getLightingInstanceWorldMatrix(f.fixed, index),
    }));
    f.sources.splice(0, 1, ...entries);
    f.runtime.markDirty();
    const snapshot = f.snapshot();
    snapshot.surfaces[0].nodeKey = entries[0].entry.nodeKey;
    await f.runtime.applySnapshot(snapshot);
    assert.equal(f.proxies().length, 2);
    assert.equal(f.fixed.thinInstanceCount, 2);
    assert.deepEqual(Array.from(f.fixed._thinInstanceDataStorage.matrixData), Array.from(matrices));
    assert.equal(f.fixed.layerMask, 0);
    const baseline = f.proxies().find(mesh => mesh.metadata.lightingSourceKey === entries[1].entry.key);
    assert.ok(baseline);
    assert.equal(baseline.parent, null);
    assert.equal(baseline.getWorldMatrix().getTranslation().x, 2);
    assert.equal(f.hemi.excludedMeshes.includes(baseline), false);
    await f.runtime.applySnapshot(snapshot);
    assert.ok(f.proxies().every(mesh => mesh.layerMask === f.originalLayerMask), '重复应用不能继承已隐藏的源layerMask=0');
    f.document.sceneSettings.lighting.bake.enabled = false; f.document.sceneSettings.lighting.shadows.enabled = false; f.runtime.sync(f.document);
    assert.equal(f.fixed.layerMask, f.originalLayerMask);
    assert.equal(f.fixed.thinInstanceCount, 2);
    assert.equal(f.proxies().length, 0);
  } finally { f.dispose(); }
});

test('classification references remain stable until sources are refreshed', () => {
  const f = fixture();
  try {
    const first = f.runtime.getClassification();
    assert.equal(f.runtime.getClassification(), first);
    f.runtime.markDirty();
    assert.notEqual(f.runtime.getClassification(), first);
  } finally { f.dispose(); }
});

test('unchanged authoritative array revisions avoid per-frame static instance matrix queries', async () => {
  const f = fixture();
  const batch = EntityArrayThinInstanceBatch.create('source', [f.fixed], { interactive: true });
  const item = x => ({ entityId: f.staticEntity.id, pickable: true, transform: {
    position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
  try {
    batch.updateEntityTransforms(Matrix.Identity(), [item(0)]);
    const [instance] = batch.getLightingInstances(), original = f.sources[0];
    let queries = 0;
    f.sources[0] = { mesh: instance.mesh, entry: original.entry,
      instance: { batch, mesh: instance.mesh, sourceIndex: instance.sourceIndex },
      getWorldMatrix: () => { queries++; return batch.getLightingInstanceWorldMatrix(instance.mesh, instance.sourceIndex); } };
    f.runtime.markDirty();
    const snapshot = f.snapshot();
    await f.runtime.applySnapshot(snapshot);
    await f.runtime.applySnapshot(snapshot);
    assert.ok(f.proxies().every(mesh => mesh.isPickable), '重复提交不能继承被清空的源批次拾取状态');
    queries = 0;
    f.tick(); f.tick();
    assert.equal(queries, 0);
    batch.updateEntityTransforms(Matrix.Identity(), [item(2)]);
    f.tick();
    assert.ok(queries > 0);
    assert.match(f.runtime.getError(), /姿态/);
  } finally { f.runtime.dispose(); batch.dispose(); f.dispose(); }
});

test('array selection returns only the requested logical entity proxy and falls back cleanly after clearing', async () => {
  const f = fixture();
  const batch = EntityArrayThinInstanceBatch.create('source', [f.moving], { interactive: true });
  try {
    const item = (entityId, x) => ({ entityId, pickable: true, transform: {
      position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
    batch.updateEntityTransforms(Matrix.Identity(), [item('array-a', 0), item('array-b', 2)]);
    const instances = batch.getLightingInstances(), original = f.sources[1];
    f.sources.splice(1, 1, ...instances.map(instance => ({
      mesh: instance.mesh, entry: { ...original.entry, key: instance.entityId + '/$mesh', entityId: instance.entityId },
      instance: { batch, mesh: instance.mesh, sourceIndex: instance.sourceIndex },
      getWorldMatrix: () => batch.getLightingInstanceWorldMatrix(instance.mesh, instance.sourceIndex),
    })));
    f.runtime.markDirty();
    await f.runtime.applySnapshot(f.snapshot());
    const selectedA = f.runtime.getSelectionMeshes('array-a'), selectedB = f.runtime.getSelectionMeshes('array-b');
    assert.equal(selectedA.length, 1); assert.equal(selectedB.length, 1);
    assert.notEqual(selectedA[0], selectedB[0]);
    assert.equal(selectedA[0].metadata.entityId, 'array-a');
    assert.equal(selectedB[0].metadata.entityId, 'array-b');
    f.runtime.setPreview(true, true);
    assert.deepEqual(f.runtime.getSelectionMeshes('array-a'), selectedA, '调试覆盖层不进入业务选中层');
    f.document.sceneSettings.lighting.bake.enabled = false; f.runtime.sync(f.document);
    assert.deepEqual(f.runtime.getSelectionMeshes('array-a'), [], '清除后调用方使用原thin-instance mask');
  } finally { f.runtime.dispose(); batch.dispose(); f.dispose(); }
});

test('without GI conflicting native instances use independent shadow proxies and preserve motion, geometry, material and picking', async () => {
  const f = fixture();
  try {
    const instance = f.moving.createInstance('native-shadow-override'); instance.position.x = 6;
    const originalMask = instance.layerMask, matrix = Array.from(instance.computeWorldMatrix(true).m);
    const base = f.sources[1];
    f.sources.push({ mesh: instance, entry: { ...base.entry, key: 'native-override/$mesh', entityId: 'native-override',
      receiveShadows: false }, getWorldMatrix: () => instance.computeWorldMatrix(true) });
    f.runtime.markDirty(); f.tick();
    const [proxy] = f.runtime.getSelectionMeshes('native-override');
    assert.equal(proxy.metadata.lightingShadowOnly, true);
    assert.equal(proxy.material, f.moving.material, '无GI代理共享业务材质，不添加GI插件');
    assert.equal(f.runtime.state, null);
    assert.equal(instance.layerMask, 0);
    assert.equal(proxy.layerMask, originalMask);
    assert.equal(proxy.isPickable, instance.isPickable);
    assert.equal(proxy.metadata.editorEntityId, 'native-override');
    assert.equal(f.roles.get(proxy).receiveShadows, false);
    assert.equal(f.roles.get(f.moving).receiveShadows, true);
    assert.deepEqual(Array.from(instance.computeWorldMatrix(true).m), matrix);
    instance.position.x = 7;
    f.moving.material.diffuseColor.set(0.3, 0.8, 0.2);
    const positions = Array.from(f.moving.getVerticesData(VertexBuffer.PositionKind)); positions[0] += 0.25;
    f.moving.setVerticesData(VertexBuffer.PositionKind, positions, false);
    f.tick();
    assert.equal(proxy.computeWorldMatrix(true).getTranslation().x, 7);
    assert.equal(proxy.getVerticesData(VertexBuffer.PositionKind)[0], positions[0]);
    assert.deepEqual(proxy.material.diffuseColor.asArray(), [0.3, 0.8, 0.2]);
    const snapshot = f.snapshot();
    await assert.rejects(f.runtime.applySnapshot(snapshot, undefined, async () => {
      const [candidate] = f.runtime.getSelectionMeshes('native-override');
      assert.notEqual(candidate, proxy);
      assert.equal(candidate.layerMask, originalMask);
      assert.equal(candidate.isPickable, true);
      throw new Error('late-shadow-proxy-validation');
    }), /late-shadow-proxy-validation/);
    const [rolledBack] = f.runtime.getSelectionMeshes('native-override');
    assert.equal(rolledBack.metadata.lightingShadowOnly, true);
    assert.equal(rolledBack.layerMask, originalMask);
    assert.equal(rolledBack.isPickable, true);
    assert.equal(instance.layerMask, 0);
    await f.runtime.applySnapshot(snapshot);
    const [baked] = f.runtime.getSelectionMeshes('native-override');
    assert.equal(baked.metadata.lightingShadowOnly, undefined);
    assert.equal(baked.layerMask, originalMask);
    assert.equal(baked.isPickable, true);
    f.document.sceneSettings.lighting.bake.enabled = false; f.document.sceneSettings.lighting.shadows.enabled = false; f.runtime.sync(f.document);
    assert.equal(instance.layerMask, originalMask);
    assert.deepEqual(f.runtime.getSelectionMeshes('native-override'), []);
  } finally { f.dispose(); }
});

test('new classification objects update shadow-only proxy mobility static to dynamic to static without losing interaction', () => {
  const f = fixture(), cache = new HybridShadowMeshState();
  try {
    const instance = f.moving.createInstance('mobility-override'); instance.position.x = 6;
    const originalMask = instance.layerMask, sourceIndex = f.sources.length;
    f.sources.push({ mesh: instance, entry: { ...f.sources[1].entry, key: 'mobility-override/$mesh',
      entityId: 'mobility-override', mobility: 'static', receiveShadows: false },
      getWorldMatrix: () => instance.computeWorldMatrix(true) });
    const updateClassification = mobility => {
      const previous = f.sources[sourceIndex];
      // 实际分类器每次刷新均产生新 source/entry，不能原地改旧引用掩盖生命周期缺陷。
      f.sources[sourceIndex] = { ...previous, entry: { ...previous.entry, mobility } };
      f.runtime.markDirty(); f.tick();
      const [proxy] = f.runtime.getSelectionMeshes('mobility-override');
      assert.equal(proxy.layerMask, originalMask);
      assert.equal(proxy.isPickable, true);
      assert.equal(proxy.metadata.editorEntityId, 'mobility-override');
      assert.equal(f.roles.get(proxy).receiveShadows, false);
      assert.equal(f.roles.get(proxy).mobility, mobility);
      assert.equal(instance.layerMask, 0);
      cache.setMeshes(f.scene.meshes, f.roles); cache.refresh();
      return proxy;
    };
    const initial = updateClassification('static');
    assert.equal(cache.isStatic(initial), true);
    const beforeStaticMove = cache.revision;
    instance.position.x += 1; f.tick(); cache.refresh();
    assert.ok(cache.revision > beforeStaticMove, '原静态代理移动仍必须使缓存失效');
    const dynamic = updateClassification('dynamic');
    assert.equal(initial.isDisposed(), true);
    assert.equal(cache.isStatic(dynamic), false);
    assert.ok(cache.dynamicMeshes.has(dynamic));
    const beforeDynamicMove = cache.revision;
    instance.position.x += 1; f.tick(); cache.refresh();
    assert.equal(dynamic.getWorldMatrix().getTranslation().x, instance.position.x);
    assert.equal(cache.revision, beforeDynamicMove, '切为动态后运动不得污染静态缓存版本');
    const restoredStatic = updateClassification('static');
    assert.equal(dynamic.isDisposed(), true);
    assert.equal(cache.isStatic(restoredStatic), true);
    const beforeRestoredMove = cache.revision;
    instance.position.x += 1; f.tick(); cache.refresh();
    assert.ok(cache.revision > beforeRestoredMove, '重新设静态后恢复正常的几何失效规则');
    f.document.sceneSettings.lighting.bake.enabled = false; f.document.sceneSettings.lighting.shadows.enabled = false; f.runtime.sync(f.document);
    assert.equal(instance.layerMask, originalMask);
    assert.equal(instance.isPickable, true);
  } finally { cache.dispose(); f.dispose(); }
});

test('native thin-instance conflicts retain authoritative matrices across shadow-only to GI activation and cancellation', async () => {
  const f = fixture();
  try {
    const matrices = new Float32Array(32);
    Matrix.Identity().copyToArray(matrices, 0); Matrix.Translation(2, 0, 0).copyToArray(matrices, 16);
    f.moving.thinInstanceSetBuffer('matrix', matrices, 16, false);
    const originalMask = f.moving.layerMask, batch = getNativeLightingInstances(f.moving, f.dynamicEntity.id), base = f.sources[1];
    f.sources.splice(1, 1, ...batch.getLightingInstances().map((instance, i) => ({
      mesh: f.moving, entry: { ...base.entry, key: 'thin-' + i + '/$mesh', entityId: 'thin-' + i, receiveShadows: i === 0 },
      instance: { batch, mesh: f.moving, sourceIndex: i },
      getWorldMatrix: () => batch.getLightingInstanceWorldMatrix(f.moving, i),
    })));
    f.runtime.markDirty(); f.tick();
    assert.equal(f.moving.layerMask, 0);
    for (const id of ['thin-0', 'thin-1']) assert.equal(f.runtime.getSelectionMeshes(id)[0].layerMask, originalMask);
    const snapshot = f.snapshot(), controller = new AbortController();
    await assert.rejects(f.runtime.applySnapshot(snapshot, controller.signal, async () => {
      for (const id of ['thin-0', 'thin-1']) assert.equal(f.runtime.getSelectionMeshes(id)[0].layerMask, originalMask);
      controller.abort(new Error('cancel-thin-transition'));
    }), /cancel-thin-transition/);
    for (const id of ['thin-0', 'thin-1']) {
      const [proxy] = f.runtime.getSelectionMeshes(id);
      assert.equal(proxy.metadata.lightingShadowOnly, true);
      assert.equal(proxy.layerMask, originalMask);
      assert.equal(proxy.isPickable, true);
    }
    assert.equal(f.moving.layerMask, 0);
    assert.deepEqual(Array.from(f.moving._thinInstanceDataStorage.matrixData), Array.from(matrices));
    f.sources[2].entry.receiveShadows = true; f.runtime.markDirty(); f.tick();
    assert.equal(f.runtime.getSelectionMeshes('thin-0').length, 0, '统一规则恢复原批次');
    assert.equal(f.moving.layerMask, originalMask);
  } finally { f.dispose(); }
});

test('logical array conflicts preserve per-entity picking through GI rollback and return to batching when rules match', async () => {
  const f = fixture();
  const batch = EntityArrayThinInstanceBatch.create('source', [f.moving], { interactive: true });
  try {
    batch.updateEntityTransforms(Matrix.Identity(), ['array-0', 'array-1'].map((entityId, i) => ({ entityId, pickable: i !== 0, transform: {
      position: { x: i * 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } })));
    const base = f.sources[1], instances = batch.getLightingInstances();
    f.sources.splice(1, 1, ...instances.map((instance, i) => ({
      mesh: instance.mesh, entry: { ...base.entry, key: instance.entityId + '/$mesh', entityId: instance.entityId, receiveShadows: i === 0 },
      instance: { batch, mesh: instance.mesh, sourceIndex: instance.sourceIndex },
      getWorldMatrix: () => batch.getLightingInstanceWorldMatrix(instance.mesh, instance.sourceIndex),
    })));
    const before = instances.map(instance => Array.from(instance.worldMatrix.m));
    f.runtime.markDirty(); f.tick();
    const [a] = f.runtime.getSelectionMeshes('array-0'), [b] = f.runtime.getSelectionMeshes('array-1');
    assert.equal(a.metadata.lightingShadowOnly, true); assert.equal(b.metadata.lightingShadowOnly, true);
    assert.equal(f.roles.get(a).receiveShadows, true); assert.equal(f.roles.get(b).receiveShadows, false);
    assert.equal(a.isPickable, false); assert.equal(b.isPickable, true);
    assert.deepEqual(batch.getLightingInstances().map(instance => Array.from(instance.worldMatrix.m)), before);
    await assert.rejects(f.runtime.applySnapshot(f.snapshot(), undefined, async () => {
      assert.equal(f.runtime.getSelectionMeshes('array-0')[0].isPickable, false);
      assert.equal(f.runtime.getSelectionMeshes('array-1')[0].isPickable, true);
      throw new Error('cancel-array-picking-transition');
    }), /cancel-array-picking-transition/);
    const [rollbackA] = f.runtime.getSelectionMeshes('array-0'), [rollbackB] = f.runtime.getSelectionMeshes('array-1');
    assert.equal(rollbackA.isPickable, false); assert.equal(rollbackB.isPickable, true);
    f.moving.isVisible = false; f.tick();
    assert.equal(rollbackA.isVisible, false); assert.equal(rollbackB.isVisible, false);
    f.moving.isVisible = true; f.tick();
    f.sources[2].entry.receiveShadows = true; f.runtime.markDirty(); f.tick();
    assert.equal(rollbackA.isDisposed(), true); assert.equal(rollbackB.isDisposed(), true);
    assert.deepEqual(f.runtime.getSelectionMeshes('array-0'), []);
    assert.equal(batch.getLightingInstances().length, 2);
  } finally { f.runtime.dispose(); batch.dispose(); f.dispose(); }
});

test('actual material and light changes during a bake reject results even when the document is unchanged', async () => {
  const f = fixture();
  try {
    const input = await f.runtime.captureBakeInput('material-race');
    const snapshot = f.snapshot();
    assert.equal(input.geometrySignature, snapshot.geometrySignature);
    f.fixed.material.diffuseColor.r = 0.9;
    await assert.rejects(f.runtime.applySnapshot(snapshot), /实际静态材质或灯光发生变化/);
    assert.equal(f.proxies().length, 0);
    f.fixed.material.diffuseColor.r = 0.2;
    await f.runtime.captureBakeInput('light-race');
    f.hemi.intensity = 0.1;
    await assert.rejects(f.runtime.applySnapshot(snapshot), /实际静态材质或灯光发生变化/);
    assert.equal(f.fixed.layerMask, f.originalLayerMask);
  } finally { f.dispose(); }
});

test('missing material primitive resources are rejected without hiding the source', async () => {
  const f = fixture();
  try {
    f.fixed.releaseSubMeshes();
    new SubMesh(0, 0, f.fixed.getTotalVertices(), 0, 18, f.fixed);
    new SubMesh(0, 0, f.fixed.getTotalVertices(), 18, 18, f.fixed);
    await assert.rejects(f.runtime.applySnapshot(f.snapshot()), /完整的材质分组/);
    assert.equal(f.fixed.layerMask, f.originalLayerMask);
    assert.equal(f.proxies().length, 0);
  } finally { f.dispose(); }
});

test('multiple atlas tiles share one primitive source while all visible tile proxies remain selectable', async () => {
  const f = fixture({ decorateResources(resources) {
    const geometry = resources.geometries.get('geometry');
    resources.geometries.set('tile-a', { ...geometry, indices: geometry.indices.slice(0, 18) });
    resources.geometries.set('tile-b', { ...geometry, indices: geometry.indices.slice(18) });
  } });
  try {
    const snapshot = f.snapshot(), original = snapshot.surfaces[0];
    snapshot.assets.push(...['tile-a', 'tile-b'].map(id => ({ id, kind: 'geometry', url: 'memory://' + id, byteLength: 1 })));
    snapshot.surfaces = ['tile-a', 'tile-b'].map(id => ({ ...original, key: original.key + '/tile:' + id, geometryAssetId: id }));
    await f.runtime.applySnapshot(snapshot);
    const selected = f.runtime.getSelectionMeshes(f.staticEntity.id);
    assert.equal(selected.length, 2);
    assert.deepEqual(selected.map(mesh => mesh.getTotalIndices()), [18, 18]);
    assert.deepEqual(selected.flatMap(mesh => Array.from(mesh.getIndices())), f.geometry.indices);
    assert.deepEqual(f.runtime.getSelectionMeshes(f.staticEntity.id, [f.fixed]), selected);
    assert.equal(f.runtime.state.hiddenSources.size, 1, '同源只隐藏一次');
    assert.equal(f.runtime.state.staticWatch.length, 1, '同源失效监听按对象去重');
    assert.equal(selected[0].material, selected[1].material, '同primitive继续共享原材质克隆');
    f.runtime.setPreview(false, true);
    assert.deepEqual(f.runtime.getSelectionMeshes(f.staticEntity.id), selected);
    f.document.sceneSettings.lighting.bake.enabled = false; f.runtime.sync(f.document);
    assert.equal(f.fixed.layerMask, f.originalLayerMask);
    assert.ok(selected.every(mesh => mesh.isDisposed()));
  } finally { f.dispose(); }
});

test('dynamic native geometry and material updates mirror to proxies without changing source matrices', async () => {
  const f = fixture();
  try {
    const matrices = new Float32Array(32);
    Matrix.Identity().copyToArray(matrices, 0);
    Matrix.Translation(2, 0, 0).copyToArray(matrices, 16);
    f.moving.thinInstanceSetBuffer('matrix', matrices, 16, false);
    const batch = getNativeLightingInstances(f.moving, f.dynamicEntity.id), original = f.sources[1];
    f.sources.splice(1, 1, ...batch.getLightingInstances().map((entry, index) => ({
      mesh: f.moving, entry: { ...original.entry, key: original.entry.key + '/instance:' + index, nodeKey: '$mesh/instance:' + index },
      instance: { batch, mesh: f.moving, sourceIndex: index },
      getWorldMatrix: () => batch.getLightingInstanceWorldMatrix(f.moving, index),
    })));
    f.runtime.markDirty();
    await f.runtime.applySnapshot(f.snapshot());
    const proxies = f.proxies().filter(mesh => mesh.metadata.entityId === f.dynamicEntity.id);
    assert.equal(proxies.length, 2);
    assert.notEqual(proxies[0].geometry, f.moving.geometry);
    const positions = Array.from(f.moving.getVerticesData(VertexBuffer.PositionKind)); positions[0] = 0.75;
    f.moving.setVerticesData(VertexBuffer.PositionKind, positions, false);
    f.moving.material.diffuseColor.set(0.1, 0.2, 0.9);
    f.tick();
    assert.equal(f.runtime.getError(), null);
    assert.equal(proxies[0].getVerticesData(VertexBuffer.PositionKind)[0], 0.75);
    assert.equal(proxies[1].getVerticesData(VertexBuffer.PositionKind)[0], 0.75);
    assert.deepEqual(proxies[0].material.diffuseColor.asArray(), [0.1, 0.2, 0.9]);
    assert.deepEqual(Array.from(f.moving._thinInstanceDataStorage.matrixData), Array.from(matrices));
    f.moving.isVisible = false; f.tick();
    assert.ok(proxies.every(mesh => !mesh.isVisible));
  } finally { f.dispose(); }
});

test('replacing a dynamic material through the business mesh is retained after clearing GI', async () => {
  const f = fixture();
  try {
    await f.runtime.applySnapshot(f.snapshot());
    const replacement = new StandardMaterial('business-replacement', f.scene);
    replacement.diffuseColor.set(0.2, 0.8, 0.1);
    f.moving.material = replacement;
    f.tick();
    assert.notEqual(f.moving.material, replacement);
    assert.deepEqual(f.moving.material.diffuseColor.asArray(), [0.2, 0.8, 0.1]);
    f.document.sceneSettings.lighting.bake.enabled = false; f.document.sceneSettings.lighting.shadows.enabled = false; f.runtime.sync(f.document);
    assert.equal(f.moving.material, replacement);
  } finally { f.dispose(); }
});

test('classification polling cannot consume the pending binding refresh for newly spawned dynamic objects', async () => {
  const f = fixture();
  try {
    await f.runtime.applySnapshot(f.snapshot());
    const spawned = MeshBuilder.CreateBox('spawned-dynamic', { size: 0.2 }, f.scene);
    spawned.position.set(3, 0.3, 0);
    const original = new StandardMaterial('spawned-original', f.scene); spawned.material = original;
    f.sources.push({ mesh: spawned, entry: { ...f.sources[1].entry, key: 'runtime-spawn/$mesh', entityId: 'runtime-spawn', name: 'spawned' },
      getWorldMatrix: () => spawned.computeWorldMatrix(true) });
    f.runtime.markDirty();
    assert.equal(f.runtime.getClassification().length, 3);
    f.tick();
    assert.notEqual(spawned.material, original);
    assert.ok(f.hemi.canAffectMesh(spawned));
    assert.equal(f.runtime.getError(), null);
    f.document.sceneSettings.lighting.bake.enabled = false; f.document.sceneSettings.lighting.shadows.enabled = false; f.runtime.sync(f.document);
    assert.equal(spawned.material, original);
  } finally { f.dispose(); }
});

test('logical instance proxies follow remapped source indexes after native matrix reordering', async () => {
  const f = fixture();
  try {
    const matrices = new Float32Array(32);
    Matrix.Identity().copyToArray(matrices, 0); Matrix.Translation(2, 0, 0).copyToArray(matrices, 16);
    f.moving.thinInstanceSetBuffer('matrix', matrices, 16, false);
    const batch = getNativeLightingInstances(f.moving, f.dynamicEntity.id), base = f.sources[1];
    const makeSource = (logical, sourceIndex) => ({
      mesh: f.moving, entry: { ...base.entry, key: base.entry.key + '/instance:' + logical, nodeKey: '$mesh/instance:' + logical },
      instance: { batch, mesh: f.moving, sourceIndex },
      getWorldMatrix: () => batch.getLightingInstanceWorldMatrix(f.moving, sourceIndex),
    });
    f.sources.splice(1, 1, makeSource(0, 0), makeSource(1, 1)); f.runtime.markDirty();
    await f.runtime.applySnapshot(f.snapshot());
    const key = f.sources[1].entry.key;
    const first = f.proxies().find(mesh => mesh.metadata.lightingSourceKey === key);
    assert.equal(first.getWorldMatrix().getTranslation().x, 3, JSON.stringify({
      sourcePosition: f.moving.position.asArray(), sourceWorld: f.sources[1].getWorldMatrix()?.asArray(),
      pivot: first.getPivotMatrix().asArray(), world: first.getWorldMatrix().asArray(),
    }));
    Matrix.Translation(2, 0, 0).copyToArray(matrices, 0); Matrix.Identity().copyToArray(matrices, 16);
    f.moving.thinInstanceBufferUpdated('matrix');
    f.sources.splice(1, 2, makeSource(0, 1), makeSource(1, 0));
    f.runtime.markDirty(); f.runtime.getClassification(); f.tick();
    assert.equal(f.proxies().find(mesh => mesh.metadata.lightingSourceKey === key).getWorldMatrix().getTranslation().x, 3);
    assert.equal(f.runtime.getError(), null);
  } finally { f.dispose(); }
});

test('actual default Babylon light range sentinels are omitted while real finite ranges are preserved', async () => {
  const f = fixture();
  try {
    const sun = new DirectionalLight('default-sun', Vector3.Down(), f.scene);
    const point = new PointLight('default-point', new Vector3(1, 3, 0), f.scene);
    const spot = new SpotLight('default-spot', new Vector3(0, 3, 1), Vector3.Down(), Math.PI / 3, 2, f.scene);
    assert.equal(sun.range, Number.MAX_VALUE);
    assert.equal(point.range, Number.MAX_VALUE);
    assert.equal(spot.range, Number.MAX_VALUE);
    let result = captureLightingEnvironment(f.scene, f.document);
    assert.ok(result.lights.every(light => !Object.hasOwn(light, 'range')));
    point.range = 123456789;
    spot.range = Infinity;
    sun.range = 50;
    result = captureLightingEnvironment(f.scene, f.document);
    assert.equal(result.lights.find(light => light.kind === 'point').range, 123456789);
    assert.equal(Object.hasOwn(result.lights.find(light => light.kind === 'directional'), 'range'), false);
    assert.equal(Object.hasOwn(result.lights.find(light => light.kind === 'spot'), 'range'), false);
    const parent = new TransformNode('light-parent', f.scene);
    point.parent = parent; parent.computeWorldMatrix(true); parent.position.x = 7;
    result = captureLightingEnvironment(f.scene, f.document);
    assert.equal(result.lights.find(light => light.kind === 'point').position[0], 8, '同renderId的父节点变化必须进入本次烘焙');
    const input = await f.runtime.captureBakeInput('real-default-lights');
    assert.equal(validateLightingBakeInput(input), input);
  } finally { f.dispose(); }
});

test('loading geometry mismatch recovers with complete sources and dynamic motion leaves current GI error clear', async () => {
  const f = fixture();
  try {
    f.document.sceneSettings.lighting.result = f.snapshot();
    const [fixedSource] = f.sources.splice(0, 1);
    f.runtime.markDirty(); f.runtime.sync(f.document);
    await f.runtime.whenReady();
    assert.match(f.runtime.getError(), /模型几何或实际姿态/);
    assert.equal(f.proxies().length, 0);

    f.sources.unshift(fixedSource);
    f.runtime.markDirty(); f.runtime.sync(f.document);
    await f.runtime.whenReady();
    assert.equal(f.runtime.getError(), null, '全部模型就绪且实际签名匹配后当前错误已恢复');
    assert.equal(f.proxies().length, 1);
    assert.ok(f.log.some(message => message.includes('模型几何或实际姿态')), '历史日志仍保留，不能用它代表当前诊断');

    for (const height of [0, 4, 0]) {
      f.moving.position.y = height; f.tick();
      assert.equal(f.runtime.getError(), null, `动态高度 ${height} 不能产生静态GI失配`);
      assert.equal(f.proxies().length, 1);
    }
    f.fixed.position.x += 1; f.tick();
    assert.match(f.runtime.getError(), /静态对象.*姿态/);
    assert.equal(f.proxies().length, 0, '真实静态姿态改变仍必须撤下失效GI');
  } finally { f.dispose(); }
});


test('阵列宿主往返保留脚本可见性和真实失效，稳定几何不重复编码', async () => {
  const f = fixture();
  const root = new TransformNode('runtime-array-host', f.scene);
  f.fixed.parent = root;
  const model = { root, contentRoot: root, meshes: [f.fixed], modelArraySuspendedMeshes: new Set() };
  const context = { scene: f.scene };
  const environment = { lightingRuntime: f.runtime };
  const readiness = new SceneTriangleAndReadinessController(context, {
    environment, document: { disposed: false }, telemetry: { motionStaticBatchRuntime: { isTemporaryMeshEvent: () => false } },
  });
  readiness.initializeModelStatisticsMeshAddedObserver();
  readiness.initializeModelStatisticsMeshRemovedObserver();
  const assets = new ModelAssetRuntimeController(context, { environment, readiness });
  const from = Array.from;
  let encodedPositionArrays = 0, updates = 0;
  try {
    assets.suspendModelArrayHost(model);
    await new Promise(resolve => setImmediate(resolve));
    await f.runtime.applySnapshot(f.snapshot());
    f.tick();
    const positions = f.fixed.getVerticesData(VertexBuffer.PositionKind);
    Array.from = function(value, ...args) {
      if (value === positions) encodedPositionArrays++;
      return Reflect.apply(from, this, [value, ...args]);
    };
    for (let frame = 0; frame < 3; frame++) {
      assets.restoreModelArrayHostMeshes(model);
      assert.ok(f.scene.meshes.includes(f.fixed), '脚本执行前仍恢复真实宿主');
      updates++;
      assets.refreshModelMeshes(model, { editorEntityId: f.staticEntity.id });
      assets.suspendModelArrayHost(model);
      assert.ok(!f.scene.meshes.includes(f.fixed), '更新后仍挂起宿主，批次继续负责绘制');
      f.tick();
      await new Promise(resolve => setImmediate(resolve));
      f.tick();
    }
    assert.equal(updates, 3);
    assert.equal(f.fixed.parent, root);
    assert.equal(f.fixed.getVerticesData(VertexBuffer.PositionKind), positions);
    assert.equal(f.runtime.getError(), null);
    assert.equal(encodedPositionArrays, 0, '多次局部刷新仍检查输入，但不得重新 Array.from 编码相同几何');
    const uvs = f.fixed.getVerticesData(VertexBuffer.UVKind);
    uvs[0] += 0.125;
    assets.refreshModelMeshes(model, { editorEntityId: f.staticEntity.id });
    f.tick();
    assert.match(f.runtime.getError(), /静态对象集合或实际几何/, '无通知原位 UV 变化仍当次使旧烘焙失效');
  } finally {
    Array.from = from;
    f.scene.onNewMeshAddedObservable.remove(readiness.modelStatisticsMeshAddedObserver);
    f.scene.onMeshRemovedObservable.remove(readiness.modelStatisticsMeshRemovedObserver);
    f.dispose();
  }
});
