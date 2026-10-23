import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import {
  type BaseTexture, Constants, Material, MeshBuilder, NullEngine, PBRMaterial, RawTexture,
  Scene, StandardMaterial,
} from '@babylonjs/core';
import {
  createLightingTextureCapture, exportLightingMaterial, exportLightingMesh,
  registerLightingMaterialExportBaseline,
} from '../../src/runtime/babylon/lightingGeometry.ts';

const capture = async () => 'data:image/png;base64,AA==';

for (const MaterialClass of [PBRMaterial, StandardMaterial]) {
  test(`${MaterialClass.name} 按真实透明模式导出，opaque 忽略纹理 alpha，blend 不被裁剪`, async () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const material = new MaterialClass('source', scene);
    const texture = RawTexture.CreateRGBATexture(new Uint8Array([64, 128, 192, 64]), 1, 1, scene);
    texture.hasAlpha = true;
    if (material instanceof PBRMaterial) {
      material.albedoTexture = texture; material.useAlphaFromAlbedoTexture = true;
    } else {
      material.diffuseTexture = texture; material.useAlphaFromDiffuseTexture = true;
    }
    material.alpha = 0.8; material.alphaCutOff = 0.4;
    try {
      for (const [nativeMode, expected] of [
        [Material.MATERIAL_OPAQUE, 'opaque'], [Material.MATERIAL_ALPHATEST, 'mask'],
        [Material.MATERIAL_ALPHABLEND, 'blend'], [Material.MATERIAL_ALPHATESTANDBLEND, 'mask-blend'],
      ] as const) {
        material.transparencyMode = nativeMode;
        const output = await exportLightingMaterial(material, capture);
        assert.equal(output.alphaMode, expected);
        assert.equal(output.useTextureAlpha, expected !== 'opaque');
        assert.equal(output.alphaCutoff, expected.includes('mask') ? 0.4 : undefined);
        assert.equal(output.alpha, 0.8, '材质 alpha 保持独立数值，不预乘显示透明度');
      }
    } finally { scene.dispose(); engine.dispose(); }
  });
}

test('Standard auto mask 与显式 mask 使用原生实际纹理 alpha 规则', async () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const material = new StandardMaterial('standard', scene);
  material.diffuseTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 64]), 1, 1, scene);
  material.diffuseTexture.hasAlpha = true;
  material.useAlphaFromDiffuseTexture = false;
  try {
    material.transparencyMode = null;
    const automatic = await exportLightingMaterial(material, capture);
    assert.equal(automatic.alphaMode, 'mask');
    assert.equal(automatic.useTextureAlpha, true, '旧 Standard 自动 alpha test 直接裁剪 diffuse alpha');
    material.transparencyMode = Material.MATERIAL_ALPHATEST;
    const explicit = await exportLightingMaterial(material, capture);
    assert.equal(explicit.alphaMode, 'mask');
    assert.equal(explicit.useTextureAlpha, false, '显式模式在全部 alpha 计算后测试，禁用的 diffuse alpha 不得擅自启用');
  } finally { scene.dispose(); engine.dispose(); }
});

test('PBR 显式 mask 按 ALPHATEST 读取 albedo alpha，不受 hasAlpha 提示标记限制', async () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const material = new PBRMaterial('explicit-mask', scene);
  material.albedoTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 64]), 1, 1, scene);
  material.albedoTexture.hasAlpha = false;
  material.useAlphaFromAlbedoTexture = false;
  material.transparencyMode = Material.MATERIAL_ALPHATEST;
  try {
    const output = await exportLightingMaterial(material, capture);
    assert.equal(output.alphaMode, 'mask');
    assert.equal(output.useTextureAlpha, true);
  } finally { scene.dispose(); engine.dispose(); }
});

test('opaque 忽略未使用的独立透明贴图，auto 真正使用该贴图时必须明确拒绝', async () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const material = new PBRMaterial('opacity-path', scene);
  material.opacityTexture = RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 64]), 1, 1, scene);
  try {
    material.transparencyMode = Material.MATERIAL_OPAQUE;
    assert.equal((await exportLightingMaterial(material)).alphaMode, 'opaque');
    material.transparencyMode = null;
    await assert.rejects(exportLightingMaterial(material), /独立透明度贴图/);
  } finally { scene.dispose(); engine.dispose(); }
});

test('线性与 sRGB 贴图在导出契约中保持明确颜色空间和实际 UV 矩阵', async () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const material = new PBRMaterial('linear-source', scene);
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([64, 64, 64, 255]), 1, 1, scene);
  material.albedoTexture = texture;
  texture.uOffset = 0.2; texture.vScale = 2;
  try {
    texture.gammaSpace = false;
    const linear = await exportLightingMaterial(material, capture);
    assert.equal(linear.textures?.baseColor?.colorSpace, 'linear');
    assert.equal(linear.textures?.baseColor?.invertY, true, 'GPU readback 的行方向与原始上传 invertY 无关');
    assert.equal(linear.textures?.baseColor?.uvTransform?.length, 6);
    texture.gammaSpace = true;
    const srgb = await exportLightingMaterial(material, capture);
    assert.equal(srgb.textures?.baseColor?.colorSpace, 'srgb');
    assert.deepEqual(srgb.textures?.baseColor?.uvTransform, linear.textures?.baseColor?.uvTransform);
  } finally { scene.dispose(); engine.dispose(); }
});

test('普通 mesh visibility 独立导出，环境 ghost 显示不得覆盖物理 alpha 基线', async () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('ordinary', {}, scene);
  const material = new PBRMaterial('source', scene);
  mesh.material = material; material.alpha = 0.7; mesh.visibility = 0.4;
  try {
    const ordinary = (await exportLightingMesh(mesh, { key: 'ordinary', entityId: 'a', nodeKey: 'mesh', receiver: true }))[0].material;
    assert.equal(ordinary.alphaMode, 'blend');
    assert.equal(ordinary.alpha, 0.7);
    assert.equal(ordinary.meshVisibility, 0.4);
    registerLightingMaterialExportBaseline(material, { alpha: 1, transparencyMode: Material.MATERIAL_OPAQUE });
    material.alpha = 0.15; material.transparencyMode = Material.MATERIAL_ALPHABLEND; material.freeze();
    const environment = (await exportLightingMesh(mesh, { key: 'floor', entityId: '$environment', nodeKey: 'floor', receiver: true }))[0].material;
    assert.equal(environment.alphaMode, 'opaque');
    assert.equal(environment.alpha, 1);
    assert.equal(environment.meshVisibility, 1);
    assert.equal(material.alpha, 0.15);
    assert.equal(material.transparencyMode, Material.MATERIAL_ALPHABLEND);
    assert.equal(material.isFrozen, true, '导出不修改显示材质或冻结状态');
    registerLightingMaterialExportBaseline(material, { alpha: 1, transparencyMode: null });
    const automatic = await exportLightingMaterial(material);
    assert.equal(automatic.alphaMode, 'opaque', '原始 auto 模式的 null 不能退回当前 ghost blend 模式');
  } finally { scene.dispose(); engine.dispose(); }
});

test('不透明顶点颜色保留 RGB 但不得把未启用的 vertex alpha 烘成透明', async () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('vertex-color', {}, scene), material = new PBRMaterial('opaque', scene);
  mesh.material = material;
  mesh.setVerticesData('color', Array(mesh.getTotalVertices()).fill([1, 0.5, 0.25, 0.1]).flat(), false, 4);
  mesh.useVertexColors = true; mesh.hasVertexAlpha = true; material.transparencyMode = Material.MATERIAL_OPAQUE;
  try {
    const output = (await exportLightingMesh(mesh, { key: 'box', entityId: 'box', nodeKey: 'box', receiver: true }))[0];
    assert.equal(output.colors?.[3], 0.1);
    assert.equal(output.material.useVertexAlpha, false);
  } finally { scene.dispose(); engine.dispose(); }
});

for (const value of [2, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`浮点材质纹理 ${value} 在创建 PNG 前明确拒绝，不夹断或伪造成功`, async () => {
    const fake = {
      name: 'hdr-emission', isCube: false, textureType: Constants.TEXTURETYPE_FLOAT,
      getSize: () => ({ width: 1, height: 1 }),
      readPixels: async () => new Float32Array([value, 0.5, 0.5, 1]),
    } as unknown as BaseTexture;
    await assert.rejects(createLightingTextureCapture()(fake), /hdr-emission.*(?:HDR|有限|范围)/);
  });
}

test('取消的纹理捕获不会读取或编码图片', async () => {
  const signal = new AbortController(); signal.abort();
  let read = false;
  const fake = {
    name: 'cancelled', isCube: false, getSize: () => ({ width: 1, height: 1 }),
    readPixels: async () => { read = true; return new Uint8Array(4); },
  } as unknown as BaseTexture;
  await assert.rejects(createLightingTextureCapture(signal.signal)(fake), { name: 'AbortError' });
  assert.equal(read, false);
});

test('RGBA PNG 捕获保留 alpha=0 的原始 RGB，不经 Canvas 预乘丢色', async () => {
  const pixels = new Uint8Array([201, 103, 47, 0, 79, 151, 223, 2]);
  const fake = {
    name: 'opaque-ignores-texture-alpha', isCube: false, getSize: () => ({ width: 2, height: 1 }),
    readPixels: async () => pixels,
  } as unknown as BaseTexture;
  const url = await createLightingTextureCapture()(fake);
  const png = Buffer.from(url.split(',')[1], 'base64'), chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  assert.deepEqual([...inflateSync(Buffer.concat(chunks))], [0, ...pixels]);
});
