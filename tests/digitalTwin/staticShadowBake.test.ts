import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSceneShadowBakeErrorContract,
  getSceneShadowBakeSignatureContract,
  isStaticShadowEntityContract,
  sanitizeSceneShadowBake,
} from '../../electron/shared/sceneShadowBakeContract.ts';

function fixture() {
  return {
    entityIds: ['static', 'moving', 'child'],
    entities: {
      static: { id: 'static', parentId: null, components: { transform: { position: { x: 0, y: 0, z: 0 } }, meshRenderer: { kind: 'cube' } } },
      moving: { id: 'moving', parentId: null, components: { transform: { position: { x: 0, y: 0, z: 0 } }, telemetryBinding: { enabled: true } } },
      child: { id: 'child', parentId: 'moving', components: { transform: { position: { x: 1, y: 0, z: 0 } }, meshRenderer: { kind: 'cube' } } },
    },
    selectedEntityId: null as string | null,
    sceneSettings: {
      environment: { packagePath: 'C:/assets/env', activeVariantUrl: 'editor-asset://local/env/a.glb', dataPlatformRevision: '1', transform: { scale: 1 } },
      camera: { savedPose: null as unknown },
      shadows: { enabled: true, mode: 'baked', darkness: 0.32, sunAzimuthDegrees: 50, sunElevationDegrees: 60, bias: 0.002, normalBias: 0.03, bake: null as unknown },
    },
  };
}

test('静态签名忽略相机、选择、阴影开关和运动设备及其子实体的位置', () => {
  const scene = fixture();
  const before = getSceneShadowBakeSignatureContract(scene);
  scene.selectedEntityId = 'moving';
  scene.sceneSettings.camera.savedPose = { radius: 200 };
  scene.sceneSettings.shadows.enabled = false;
  scene.sceneSettings.shadows.mode = 'realtime';
  scene.sceneSettings.shadows.bake = { arbitrary: true };
  scene.entities.moving.components.transform.position.x = 99;
  scene.entities.child.components.transform.position.z = 100;
  assert.equal(getSceneShadowBakeSignatureContract(scene), before);
  assert.equal(isStaticShadowEntityContract(scene, 'moving'), false);
  assert.equal(isStaticShadowEntityContract(scene, 'child'), false);
  assert.equal(isStaticShadowEntityContract(scene, 'static'), true);
});

test('静态布局、环境修订和太阳方向变更使签名失效，JSON属性顺序不影响结果', () => {
  for (const mutate of [
    (scene: ReturnType<typeof fixture>) => { scene.entities.static.components.transform.position.x = 2; },
    (scene: ReturnType<typeof fixture>) => { scene.sceneSettings.environment.dataPlatformRevision = '2'; },
    (scene: ReturnType<typeof fixture>) => { scene.sceneSettings.environment.transform.scale = 2; },
    (scene: ReturnType<typeof fixture>) => { scene.sceneSettings.shadows.sunAzimuthDegrees = 80; },
    (scene: ReturnType<typeof fixture>) => { scene.sceneSettings.shadows.darkness = 0.6; },
    (scene: ReturnType<typeof fixture>) => { scene.sceneSettings.shadows.bias = 0.004; },
    (scene: ReturnType<typeof fixture>) => { scene.sceneSettings.shadows.normalBias = 0.05; },
  ]) {
    const scene = fixture();
    const before = getSceneShadowBakeSignatureContract(scene);
    mutate(scene);
    assert.notEqual(getSceneShadowBakeSignatureContract(scene), before);
  }
  const scene = fixture();
  assert.equal(getSceneShadowBakeSignatureContract(scene), getSceneShadowBakeSignatureContract({ ...scene, entities: Object.fromEntries(Object.entries(scene.entities).reverse()) }));
});

test('保守排除脚本、动画、motion、参数模型和手动漫游，不允许层级循环通过', () => {
  const scene = fixture();
  for (const modelAsset of [
    { scriptAssets: [{}] }, { animationScriptMetadata: [{}] }, { parameterScriptMetadata: [{}] },
    { parameterConfig: {} }, { dataDrivenConfig: { motion: true } },
  ]) {
    assert.equal(isStaticShadowEntityContract({ ...scene, entities: { dynamic: { components: { modelAsset } } } }, 'dynamic'), false);
  }
  assert.equal(isStaticShadowEntityContract({ entities: { avatar: { components: { manualRoamSpawn: {} } } } }, 'avatar'), false);
  assert.equal(isStaticShadowEntityContract({ entities: { cycle: { parentId: 'cycle', components: {} } } }, 'cycle'), false);
});

function staticShelfAsset() {
  return {
    sourcePath: 'C:/models/Shelf_横梁货架_修改.glb',
    sourceUrl: 'editor-asset://local/C%3A%5Cmodels%5CShelf_%E6%A8%AA%E6%A2%81%E8%B4%A7%E6%9E%B6_%E4%BF%AE%E6%94%B9.glb',
    scriptAssets: [{ name: 'newshelf.model.ts', path: 'C:/models/newshelf.model.ts', sourceUrl: 'editor-asset://local/C%3A%5Cmodels%5Cnewshelf.model.ts' }],
    parameterConfig: { parameters: [{ key: 'columnCount', defaultValue: 1 }], bindings: [] },
    parameterValues: { columnCount: 42, layerCount: 7 },
    parameterScriptMetadata: [{ scriptFilename: 'newshelf.model.ts', modelFilename: 'Shelf_横梁货架_修改.glb', className: 'ParametricModelParamsComponent', values: { columnCount: { value: 1 } } }],
    animationScriptMetadata: [{ scriptFilename: 'newshelf.model.ts', modelFilename: 'Shelf_横梁货架_修改.glb', className: 'ParametricModelRuntimeComponent', fields: [], values: {} }],
  };
}

test('固定参数货架参与静态烘焙，参数和参数默认值改变使旧结果过期', () => {
  const asset = staticShelfAsset();
  const scene = { entities: { shelf: { components: { modelAsset: asset } } } };
  assert.equal(isStaticShadowEntityContract(scene, 'shelf'), true);
  const before = getSceneShadowBakeSignatureContract(scene);
  asset.parameterValues.columnCount = 43;
  assert.notEqual(getSceneShadowBakeSignatureContract(scene), before);
  asset.parameterValues.columnCount = 42;
  asset.parameterConfig.parameters[0].defaultValue = 2;
  assert.notEqual(getSceneShadowBakeSignatureContract(scene), before);
  asset.parameterConfig.parameters[0].defaultValue = 1;
  asset.parameterScriptMetadata[0].values.columnCount.value = 3;
  assert.notEqual(getSceneShadowBakeSignatureContract(scene), before);
});

test('固定围栏和框架参与烘焙，额外遥测组件仍禁止准入', () => {
  for (const [scriptFilename, modelFilename] of [['fence.model.ts', '围栏.glb'], ['frame.model.ts', '框架.glb']]) {
    const modelAsset = {
      sourcePath: `assets/${modelFilename}`, scriptAssets: [{ name: scriptFilename }], parameterValues: { height: 2 },
      parameterScriptMetadata: [{ scriptFilename, modelFilename, className: 'ParametricModelParamsComponent', values: {} }],
      animationScriptMetadata: [{ scriptFilename, modelFilename, className: 'ParametricModelRuntimeComponent', values: {}, fields: [] }],
    };
    assert.equal(isStaticShadowEntityContract({ entities: { model: { components: { modelAsset } } } }, 'model'), true);
    assert.equal(isStaticShadowEntityContract({ entities: { model: { components: { modelAsset, telemetryBinding: { enabled: true } } } } }, 'model'), false);
  }
});

test('已核对的静态参数模型仍拒绝未知脚本、动画、motion和动态祖先或阵列源', () => {
  for (const override of [
    { scriptAssets: [{ name: 'custom.model.ts' }] },
    { scriptAssets: [{ name: 'newshelf.model.ts', path: 'C:/models/custom.model.ts' }] },
    { sourcePath: 'C:/models/unknown.glb', sourceUrl: 'assets/unknown.glb' },
    { animationScriptMetadata: [{ ...staticShelfAsset().animationScriptMetadata[0], className: 'MovingRuntime' }] },
    { animationScriptMetadata: [{ ...staticShelfAsset().animationScriptMetadata[0], fields: [{ key: 'speed' }] }] },
    { dataDrivenConfig: { motion: {} } },
    { dataDrivenConfig: { specializedMotion: {} } },
  ]) {
    const scene = { entities: { shelf: { components: { modelAsset: { ...staticShelfAsset(), ...override } } } } };
    assert.equal(isStaticShadowEntityContract(scene, 'shelf'), false, JSON.stringify(override));
  }
  for (const relation of [{ parentId: 'moving' }, { components: { modelAsset: staticShelfAsset(), modelArrayInstance: { sourceEntityId: 'moving' } } }]) {
    const scene = { entities: {
      moving: { components: { telemetryBinding: { enabled: true } } },
      shelf: { components: { modelAsset: staticShelfAsset() }, ...relation },
    } };
    assert.equal(isStaticShadowEntityContract(scene, 'shelf'), false);
  }
});

test('静态参数模型资源改写为发布相对路径后仍准入，脚本路径不进入几何签名', () => {
  const asset = staticShelfAsset();
  const scene = { entities: { shelf: { components: { modelAsset: asset } } } };
  const before = getSceneShadowBakeSignatureContract(scene);
  asset.scriptAssets[0].path = 'assets/models/shelf/newshelf.model.ts';
  asset.scriptAssets[0].sourceUrl = 'assets/models/shelf/newshelf.model.ts';
  assert.equal(getSceneShadowBakeSignatureContract(scene), before);
  asset.sourcePath = 'assets/models/shelf/Shelf_横梁货架_修改.glb';
  asset.sourceUrl = 'assets/models/shelf/Shelf_%E6%A8%AA%E6%A2%81%E8%B4%A7%E6%9E%B6_%E4%BF%AE%E6%94%B9.glb';
  assert.equal(isStaticShadowEntityContract(scene, 'shelf'), true);
  assert.equal(getSceneShadowBakeSignatureContract(scene), getSceneShadowBakeSignatureContract(JSON.parse(JSON.stringify(scene))));
});

test('发布阻止未烘焙和过期结果，空场景/关闭/实时模式可继续', () => {
  const scene = fixture();
  assert.match(getSceneShadowBakeErrorContract(scene)!, /尚未烘焙/);
  scene.sceneSettings.shadows.bake = { version: 1, signature: getSceneShadowBakeSignatureContract(scene), createdAt: new Date().toISOString(), surfaces: [
    { key: 'surface', width: 1, height: 1, uvBounds: [0, 0, 1, 1], dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5i8AAAAASUVORK5CYII=' },
  ] };
  assert.equal(getSceneShadowBakeErrorContract(scene), null);
  assert.ok(sanitizeSceneShadowBake(scene.sceneSettings.shadows.bake));
  scene.sceneSettings.shadows.sunElevationDegrees = 70;
  assert.match(getSceneShadowBakeErrorContract(scene)!, /过期/);
  scene.sceneSettings.shadows.enabled = false;
  assert.equal(getSceneShadowBakeErrorContract(scene), null);
  scene.sceneSettings.shadows.enabled = true;
  scene.sceneSettings.shadows.mode = 'realtime';
  assert.equal(getSceneShadowBakeErrorContract(scene), null);
  assert.equal(getSceneShadowBakeErrorContract({ sceneSettings: { shadows: { enabled: true, mode: 'baked' } } }), null);
});

test('烘焙快照拒绝重复表面、伪造PNG尺寸、总像素和数据预算超限', () => {
  const header = Buffer.alloc(24);
  Buffer.from('\x89PNG\r\n\x1a\n', 'binary').copy(header);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(4096, 16);
  header.writeUInt32BE(4096, 20);
  const surface = { key: 'a', width: 4096, height: 4096, uvBounds: [0, 0, 1, 1], dataUrl: `data:image/png;base64,${header.toString('base64')}` };
  const bake = { version: 1, signature: getSceneShadowBakeSignatureContract(fixture()), createdAt: new Date().toISOString(), surfaces: [surface] };
  assert.ok(sanitizeSceneShadowBake(bake));
  assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [surface, surface] }), null);
  assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [surface, { ...surface, key: 'b', dataUrl: `${surface.dataUrl}AAAA` }] }), null);
  assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [{ ...surface, width: 1 }] }), null);
  assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [{ ...surface, dataUrl: `data:image/png;base64,${'A'.repeat(32 * 1024 * 1024)}` }] }), null);
  assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [{ ...surface, uvBounds: [0, 0, 0, 1] }] }), null);
});

test('共享静态遮罩只计一次纹理像素，仍按每个表面累计序列化数据预算', () => {
  const header = Buffer.alloc(24);
  Buffer.from('\x89PNG\r\n\x1a\n', 'binary').copy(header);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(4096, 16);
  header.writeUInt32BE(4096, 20);
  const surface = { key: 'ground', kind: 'shadow-mask', width: 4096, height: 4096, uvBounds: [-155, -160, 155, 160], dataUrl: `data:image/png;base64,${header.toString('base64')}` };
  const bake = { version: 1, signature: getSceneShadowBakeSignatureContract(fixture()), createdAt: new Date().toISOString(), surfaces: [surface, { ...surface, key: 'wall' }] };
  const clean = sanitizeSceneShadowBake(bake);
  assert.ok(clean);
  assert.equal(clean.surfaces.length, 2);
  assert.deepEqual(clean.surfaces, bake.surfaces);
  assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [surface, { ...surface, key: 'wall', dataUrl: `${surface.dataUrl}AAAA` }] }), null);
  const largeSurface = { ...surface, dataUrl: `${surface.dataUrl}${'A'.repeat(12 * 1024 * 1024)}` };
  assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [largeSurface, { ...largeSurface, key: 'wall' }, { ...largeSurface, key: 'roof' }] }), null);
});

test('旧颜色烘焙快照保持缺省kind兼容，未知kind拒绝', () => {
  const surface = { key: 'surface', width: 1, height: 1, uvBounds: [0, 0, 1, 1], dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5i8AAAAASUVORK5CYII=' };
  const bake = { version: 1, signature: getSceneShadowBakeSignatureContract(fixture()), createdAt: new Date().toISOString(), surfaces: [surface] };
  assert.deepEqual(sanitizeSceneShadowBake(bake), bake);
  for (const kind of ['realtime', '', null, 1]) {
    assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [{ ...surface, kind }] }), null);
  }
});

function sharedMaskFixture() {
  const header = Buffer.alloc(24);
  Buffer.from('\x89PNG\r\n\x1a\n', 'binary').copy(header);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(4096, 16);
  header.writeUInt32BE(4096, 20);
  const surface = { key: 'mask', kind: 'shadow-mask', width: 4096, height: 4096, uvBounds: [-155, -160, 155, 160], dataUrl: `data:image/png;base64,${header.toString('base64')}` };
  return { version: 1, signature: getSceneShadowBakeSignatureContract(fixture()), createdAt: new Date().toISOString(), surfaces: [surface] };
}

test('七个静态遮罩引用只保存一份PNG，清洗返回保持紧凑结构且允许前向引用', () => {
  const bake = sharedMaskFixture();
  const payload = { ...bake.surfaces[0], dataUrl: `${bake.surfaces[0].dataUrl}${'A'.repeat(6 * 1024 * 1024)}` };
  const references = Array.from({ length: 7 }, (_, index) => ({ ...payload, key: `ref-${index}`, dataUrl: '', textureRef: payload.key }));
  const shared = { ...bake, surfaces: [...references, payload] };
  const clean = sanitizeSceneShadowBake(shared);
  assert.deepEqual(clean, shared);
  assert.equal(clean!.surfaces.filter((surface) => surface.dataUrl).length, 1);
  assert.ok(JSON.stringify(clean).length < 7 * 1024 * 1024);
});

test('静态遮罩引用拒绝无效目标、自引用、链式引用、尺寸或kind不匹配及重复payload', () => {
  const bake = sharedMaskFixture();
  const payload = bake.surfaces[0];
  const reference = { ...payload, key: 'reference', textureRef: payload.key, dataUrl: '' };
  for (const override of [
    { textureRef: 'missing' }, { textureRef: 'reference' }, { textureRef: '' }, { textureRef: null },
    { textureRef: 1 }, { width: 2048 }, { height: 2048 }, { kind: undefined }, { dataUrl: payload.dataUrl },
  ]) {
    assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [payload, { ...reference, ...override }] }), null, JSON.stringify(override));
  }
  assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [payload, reference, { ...reference, key: 'chain', textureRef: reference.key }] }), null);
  assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [{ ...payload, kind: undefined }, reference] }), null);
  assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [{ ...payload, dataUrl: '' }, reference] }), null);
  assert.deepEqual(sanitizeSceneShadowBake(bake), bake);
});
