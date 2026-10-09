import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetContainer, MeshBuilder, NullEngine, PBRMaterial, RawTexture, Scene, StandardMaterial, Texture, type InternalTexture, type Material } from '@babylonjs/core';
import { cloneModelAssetContainer } from '../../src/runtime/babylon/cloneModelAssetContainer.ts';
import { cloneEnvironmentMaterial } from '../../src/runtime/babylon/cloneEnvironmentMaterial.ts';
import { cloneMaterialWithSharedTexturePixels } from '../../src/runtime/babylon/cloneMaterialWithSharedTexturePixels.ts';

test('300 个网格的 40 次环境材质克隆不重复扫描全场景子网格', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const material = new PBRMaterial('source', scene);
  let queries = 0;
  for (let i = 0; i < 300; i++) {
    const mesh = MeshBuilder.CreateBox(`mesh-${i}`, {}, scene); mesh.material = material;
    const subMesh = mesh.subMeshes[0], native = subMesh.getMaterial.bind(subMesh);
    subMesh.getMaterial = (...args) => { queries++; return native(...args); };
  }
  try {
    for (let i = 0; i < 40; i++) cloneEnvironmentMaterial(material, `copy-${i}`);
    assert.equal(queries, 0, '新材质初始化不能逐属性扫描场景');
    assert.equal(scene.blockMaterialDirtyMechanism, false);
  } finally { scene.dispose(); engine.dispose(); }
});

function fixture(kind: 'standard' | 'pbr') {
  const engine = new NullEngine(), scene = new Scene(engine);
  const allocations: { width: number; height: number; internal: InternalTexture }[] = [];
  const released = new Set<InternalTexture>();
  const createRawTexture = engine.createRawTexture.bind(engine);
  engine.createRawTexture = (...args: Parameters<typeof engine.createRawTexture>) => {
    const internal = createRawTexture(...args);
    allocations.push({ width: args[1], height: args[2], internal });
    return internal;
  };
  // NullEngine 不记录 GPU 缓存，直接观察底层资源创建和最终释放事件。
  const releaser = engine as unknown as { _releaseTexture(texture: InternalTexture): void };
  const releaseTexture = releaser._releaseTexture.bind(engine);
  releaser._releaseTexture = internal => { released.add(internal); releaseTexture(internal); };
  const texture = RawTexture.CreateRGBATexture(new Uint8Array(32 * 16 * 4).fill(255), 32, 16, scene, true, false, Texture.NEAREST_SAMPLINGMODE);
  texture.name = 'pattern'; texture.uScale = 7; texture.vScale = 3;
  texture.uOffset = .125; texture.vOffset = .25; texture.uAng = .2; texture.vAng = .3; texture.wAng = .4;
  texture.uRotationCenter = .1; texture.vRotationCenter = .2; texture.wRotationCenter = .3;
  texture.wrapU = Texture.WRAP_ADDRESSMODE; texture.wrapV = Texture.MIRROR_ADDRESSMODE;
  texture.coordinatesIndex = 1; texture.coordinatesMode = Texture.EXPLICIT_MODE;
  texture.level = .6; texture.hasAlpha = true; texture.getAlphaFromRGB = true;
  texture.gammaSpace = false; texture.anisotropicFilteringLevel = 2;
  texture.getInternalTexture()!.isReady = true;
  const material = kind === 'pbr' ? new PBRMaterial('surface', scene) : new StandardMaterial('surface', scene);
  if (material instanceof PBRMaterial) material.albedoTexture = texture;
  else material.diffuseTexture = texture;
  material.alpha = .7;
  material.stencil.enabled = true; material.stencil.funcRef = 3; material.stencil.mask = 0x7f;
  material.detailMap.isEnabled = true; material.detailMap.texture = texture; material.detailMap.diffuseBlendLevel = .25;
  const source = new AssetContainer(scene);
  const mesh = MeshBuilder.CreateBox('device', {}, scene); mesh.material = material;
  source.meshes.push(mesh); source.rootNodes.push(mesh); source.geometries.push(mesh.geometry!);
  source.materials.push(material); source.textures.push(texture); source.removeAllFromScene();
  const baselineAllocations = allocations.length;
  return { engine, scene, source, texture, material, allocations, released, baselineAllocations,
    dispose: () => { source.dispose(); scene.dispose(); engine.dispose(); } };
}

test('失败或空材质克隆恢复源 clone descriptor 并清理新增纹理引用', () => {
  for (const mode of ['throw', 'null']) {
    const f = fixture('standard');
    try {
      const descriptor = Object.getOwnPropertyDescriptor(f.texture, 'clone');
      f.material.clone = () => { f.texture.clone(); if (mode === 'throw') throw new Error('clone failed'); return null!; };
      if (mode === 'throw') assert.throws(() => cloneMaterialWithSharedTexturePixels(f.material, 'copy'), /clone failed/);
      else assert.equal(cloneMaterialWithSharedTexturePixels(f.material, 'copy'), null);
      assert.deepEqual(Object.getOwnPropertyDescriptor(f.texture, 'clone'), descriptor);
      assert.equal(f.texture.isReady(), true); assertNoExtraStorage(f);
      const internal = f.texture.getInternalTexture()!;
      f.source.dispose(); assert.equal(f.released.has(internal), true);
    } finally { f.dispose(); }
  }
});

test('同源重入成功的内层副本在外层失败后仍可使用并独立释放', () => {
  const f = fixture('standard');
  const nativeClone = f.material.clone.bind(f.material);
  let nested: StandardMaterial | undefined, nesting = false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(f.texture, 'clone');
    f.material.clone = name => {
      if (nesting) return nativeClone(name);
      nesting = true;
      nested = cloneMaterialWithSharedTexturePixels(f.material, 'nested') as StandardMaterial;
      f.texture.clone(); throw new Error('outer failed');
    };
    assert.throws(() => cloneMaterialWithSharedTexturePixels(f.material, 'outer'), /outer failed/);
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.texture, 'clone'), descriptor);
    const textures = new Set(nested!.getActiveTextures());
    for (const texture of textures) assert.equal(texture.isReady(), true);
    assertNoExtraStorage(f);
    nested!.dispose(false, false); for (const texture of textures) texture.dispose();
    const internal = f.texture.getInternalTexture()!;
    assert.equal(f.texture.isReady(), true); f.source.dispose(); assert.equal(f.released.has(internal), true);
  } finally { nested?.dispose(false, false); f.dispose(); }
});

test('自定义 RawTexture clone 保留；安全副本再次 clone 保持属性和引用平衡', () => {
  const f = fixture('standard');
  let copy: StandardMaterial | undefined, again: Texture | undefined;
  try {
    const customClone = () => f.texture;
    f.texture.clone = customClone;
    copy = cloneMaterialWithSharedTexturePixels(f.material, 'custom') as StandardMaterial;
    assert.equal(f.texture.clone, customClone); assert.equal(copy.diffuseTexture, f.texture);
    copy.dispose(false, false); delete (f.texture as unknown as { clone?: unknown }).clone;
    copy = cloneMaterialWithSharedTexturePixels(f.material, 'safe') as StandardMaterial;
    again = copy.diffuseTexture!.clone() as Texture;
    assert.ok(again instanceof RawTexture); assert.deepEqual(textureState(again), textureState(f.texture));
    assert.notEqual(again, copy.diffuseTexture); assert.equal(again.getInternalTexture(), f.texture.getInternalTexture());
    assertNoExtraStorage(f); again.dispose();
    const textures = new Set(copy.getActiveTextures()); copy.dispose(false, false); for (const texture of textures) texture.dispose();
    const internal = f.texture.getInternalTexture()!;
    assert.equal(f.texture.isReady(), true); f.source.dispose(); assert.equal(f.released.has(internal), true);
  } finally { again?.dispose(); copy?.dispose(false, false); f.dispose(); }
});

test('环境只读纹理不生成临时副本，保留原 clone descriptor 和共享引用', () => {
  const f = fixture('pbr');
  let copy: Material | null = null;
  const clone = () => { throw new Error('禁止创建异步纹理副本'); };
  f.texture.clone = clone;
  try {
    copy = cloneEnvironmentMaterial(f.material, 'display');
    assert.equal(f.texture.clone, clone);
    assert.equal(copy!.getActiveTextures()[0], f.texture);
    assert.equal(copy!.getScene().blockMaterialDirtyMechanism, false);
  } finally { copy?.dispose(false, false); f.dispose(); }
});

function textureState(texture: Texture) {
  return Object.fromEntries(['name', 'uScale', 'vScale', 'uOffset', 'vOffset', 'uAng', 'vAng', 'wAng',
    'uRotationCenter', 'vRotationCenter', 'wRotationCenter', 'wrapU', 'wrapV', 'coordinatesIndex', 'coordinatesMode',
    'level', 'hasAlpha', 'getAlphaFromRGB', 'gammaSpace', 'anisotropicFilteringLevel', 'samplingMode', 'invertY']
    .map(key => [key, (texture as unknown as Record<string, unknown>)[key]]));
}

function assertNoExtraStorage(f: ReturnType<typeof fixture>) {
  for (const allocation of f.allocations.slice(f.baselineAllocations)) {
    assert.ok(f.released.has(allocation.internal), '材质克隆创建的临时 InternalTexture 必须立即释放');
    assert.equal(allocation.width, 1, '保留 RawTexture 子类型只允许 1x1 临时占位，不重复分配原图');
    assert.equal(allocation.height, 1);
  }
}

for (const kind of ['standard', 'pbr'] as const) {
  test(`${kind} 模型副本保留 RawTexture 属性、独立 wrapper 和共享存储释放语义`, () => {
    const f = fixture(kind), copies: AssetContainer[] = [];
    try {
      copies.push(cloneModelAssetContainer(f.source), cloneModelAssetContainer(f.source));
      const [a, b] = copies.map(copy => copy.materials[0].getActiveTextures()[0] as Texture);
      assert.ok(a instanceof RawTexture); assert.ok(b instanceof RawTexture);
      assert.equal(typeof a.update, 'function'); assert.equal(typeof b.update, 'function');
      assert.deepEqual(textureState(a), textureState(f.texture));
      assert.deepEqual(textureState(b), textureState(f.texture));
      assert.notEqual(a, b); assert.notEqual(a, f.texture);
      assert.equal(a.getInternalTexture(), f.texture.getInternalTexture());
      assert.equal(b.getInternalTexture(), f.texture.getInternalTexture());
      assert.equal(copies[0].materials[0].alpha, .7);
      a.uScale = 11; assert.equal(b.uScale, 7); assert.equal(f.texture.uScale, 7);
      const internal = f.texture.getInternalTexture()!;
      copies[0].dispose(); assert.equal(b.isReady(), true); assert.equal(f.released.has(internal), false);
      copies[1].dispose(); assert.equal(f.texture.isReady(), true); assert.equal(f.released.has(internal), false);
      f.source.dispose(); assert.equal(f.released.has(internal), true, '最后一个所有者释放底层存储');
    } finally { for (const copy of copies) copy.dispose(); f.dispose(); }
  });

  test(`${kind} 模型材质克隆不遗留额外 InternalTexture`, () => {
    const f = fixture(kind);
    let copy: AssetContainer | undefined;
    try { copy = cloneModelAssetContainer(f.source); assertNoExtraStorage(f); }
    finally { copy?.dispose(); f.dispose(); }
  });

  test(`${kind} 环境材质保留共享贴图和插件属性且不遗留额外 InternalTexture`, () => {
    const f = fixture(kind);
    let copy: StandardMaterial | PBRMaterial | undefined;
    try {
      copy = cloneEnvironmentMaterial(f.material, 'display') as StandardMaterial | PBRMaterial;
      assert.ok(copy); assert.notEqual(copy, f.material);
      const texture = copy.getActiveTextures()[0] as Texture;
      assert.equal(texture, f.texture); assert.deepEqual(textureState(texture), textureState(f.texture));
      assert.equal(copy.alpha, .7); assert.equal(copy.detailMap.texture, f.texture);
      assert.equal(copy.stencil.enabled, true); assert.equal(copy.stencil.funcRef, 3); assert.equal(copy.stencil.mask, 0x7f);
      assert.equal(copy.detailMap.diffuseBlendLevel, .25); assertNoExtraStorage(f);
      const internal = texture.getInternalTexture()!;
      copy.dispose(false, false); assert.equal(f.texture.isReady(), true); assert.equal(f.released.has(internal), false);
    } finally { copy?.dispose(false, false); f.dispose(); }
  });
}

test('PBR 显示副本共享不在 activeTextures 中的 BRDF，避免临时 RGBD 解码副本', () => {
  const f = fixture('pbr'); const brdf = new Texture(null, f.scene);
  const descriptor = Object.getOwnPropertyDescriptor(brdf, 'clone');
  brdf.clone = () => { throw new Error('BRDF must remain shared'); };
  (f.material as PBRMaterial).environmentBRDFTexture = brdf;
  const before = Object.getOwnPropertyDescriptor(brdf, 'clone');
  let display: PBRMaterial | null = null;
  try {
    assert.equal(f.material.getActiveTextures().includes(brdf), false);
    display = cloneEnvironmentMaterial(f.material, 'shared-brdf') as PBRMaterial;
    assert.ok(display.environmentBRDFTexture === brdf, 'BRDF 必须保留源纹理引用');
    assert.deepEqual(Object.getOwnPropertyDescriptor(brdf, 'clone'), before);
  } finally {
    display?.dispose(false, false);
    if (descriptor) Object.defineProperty(brdf, 'clone', descriptor); else Reflect.deleteProperty(brdf, 'clone');
    f.dispose();
  }
});
