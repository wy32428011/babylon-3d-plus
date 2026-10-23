import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLightingBakeInput } from '../../electron/ipc/lightingBakeValidation.ts';

function fixture() {
  return {
    version: 1, jobId: 'material-contract', signature: 'material-contract', sceneName: '材质契约',
    settings: { atlasSize: 256, quality: 'preview', texelsPerMeter: 8, probeSpacing: 4, maxTextureMiB: 16 },
    meshes: [{
      key: 'mesh', entityId: 'mesh', nodeKey: 'mesh', name: '材质网格',
      positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0],
      indices: [0, 2, 1], uvs: [0, 0, 1, 0, 0, 1], colors: [1, 1, 1, 0.5, 1, 1, 1, 0.5, 1, 1, 1, 0.5],
      worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      material: {
        baseColor: [1, 1, 1], alpha: 0.8, alphaMode: 'blend', useTextureAlpha: true, useVertexAlpha: true,
        meshVisibility: 0.7, metallic: 0, roughness: 0.5, emissive: [0, 0, 0], doubleSided: true,
        textures: { baseColor: { url: 'editor-asset://local/color.png', colorSpace: 'linear' } },
      } as Record<string, unknown>,
    }],
    lights: [], environment: { color: [0, 0, 0], intensity: 1 },
  };
}

test('后端保留连续透明因子和颜色空间，但拒绝 blend 携带 mask 裁剪', () => {
  const input = fixture();
  const material = validateLightingBakeInput(input).meshes[0].material;
  assert.equal(material.alphaMode, 'blend');
  assert.equal(material.meshVisibility, 0.7);
  assert.equal(material.textures?.baseColor?.colorSpace, 'linear');
  input.meshes[0].material.alphaCutoff = 0.4;
  assert.throws(() => validateLightingBakeInput(input), /只有 mask/);
  input.meshes[0].material.alphaMode = 'mask-blend';
  assert.equal(validateLightingBakeInput(input).meshes[0].material.alphaCutoff, 0.4);
});

test('不接受未知颜色空间、不透明与alpha开关矛盾或缺失alpha数据', () => {
  const input = fixture();
  delete input.meshes[0].material.alphaMode;
  assert.throws(() => validateLightingBakeInput(input), /明确 alphaMode/);
  input.meshes[0].material.alphaMode = 'opaque';
  assert.throws(() => validateLightingBakeInput(input), /不透明材质/);
  input.meshes[0].material.alphaMode = 'blend';
  input.meshes[0].material.textures = { baseColor: { url: 'editor-asset://local/color.png', colorSpace: 'display-p3' } };
  assert.throws(() => validateLightingBakeInput(input), /颜色空间/);
  input.meshes[0].material.textures = {};
  assert.throws(() => validateLightingBakeInput(input), /没有基础色贴图/);
  input.meshes[0].material.useTextureAlpha = false;
  input.meshes[0].colors = [];
  assert.throws(() => validateLightingBakeInput(input), /顶点颜色/);
});
