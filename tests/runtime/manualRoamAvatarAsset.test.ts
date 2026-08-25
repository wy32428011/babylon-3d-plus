import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  DEFAULT_MANUAL_ROAM_AVATAR_ASSET,
  resolveDefaultManualRoamAvatarUrl,
} from '../../src/runtime/assets/manualRoamAvatarAsset.ts';
import {
  createConnectedLimbMask,
  PROCEDURAL_LIMB,
  type ProceduralLimbSelection,
} from '../../src/runtime/roam/proceduralAvatarAnimation.ts';

type GlbJson = {
  accessors: Array<{
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4';
  }>;
  bufferViews: Array<{ byteOffset?: number; byteStride?: number }>;
  materials?: Array<{ name?: string }>;
  meshes?: Array<{
    primitives?: Array<{
      attributes: { POSITION: number };
      indices: number;
      material?: number;
    }>;
  }>;
  animations?: unknown[];
  skins?: unknown[];
};

test('resolves the bundled avatar from a relative deployment base', () => {
  assert.equal(
    resolveDefaultManualRoamAvatarUrl('https://example.test/viewer/index.html', './'),
    'https://example.test/viewer/manual-roam/EQ_People.glb',
  );
});

test('resolves the bundled avatar from an absolute application base', () => {
  assert.equal(
    resolveDefaultManualRoamAvatarUrl('https://example.test/index.html', '/digital-twin/'),
    'https://example.test/digital-twin/manual-roam/EQ_People.glb',
  );
});

test('describes the animation capabilities of the supplied GLB', () => {
  assert.equal(DEFAULT_MANUAL_ROAM_AVATAR_ASSET.hasEmbeddedAnimations, false);
  assert.equal(DEFAULT_MANUAL_ROAM_AVATAR_ASSET.hasSkinnedMesh, false);
  assert.ok(DEFAULT_MANUAL_ROAM_AVATAR_ASSET.nominalHeightMeters > 1.7);
});

test('bundles the expected GLB and keeps its declared animation metadata in sync', async () => {
  const file = await readFile(new URL('../../public/manual-roam/EQ_People.glb', import.meta.url));
  const hash = createHash('sha256').update(file).digest('hex');
  assert.equal(hash, DEFAULT_MANUAL_ROAM_AVATAR_ASSET.sha256);
  assert.equal(file.toString('ascii', 0, 4), 'glTF');

  const jsonChunkLength = file.readUInt32LE(12);
  assert.equal(file.toString('ascii', 16, 20), 'JSON');
  const json = JSON.parse(file.subarray(20, 20 + jsonChunkLength).toString('utf8').trimEnd()) as GlbJson;
  assert.equal(
    (json.animations?.length ?? 0) > 0,
    DEFAULT_MANUAL_ROAM_AVATAR_ASSET.hasEmbeddedAnimations,
  );
  assert.equal(
    (json.skins?.length ?? 0) > 0,
    DEFAULT_MANUAL_ROAM_AVATAR_ASSET.hasSkinnedMesh,
  );
});

test('the bundled static avatar exposes separable left and right limb geometry for procedural walking', async () => {
  const file = await readFile(new URL('../../public/manual-roam/EQ_People.glb', import.meta.url));
  const jsonChunkLength = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + jsonChunkLength).toString('utf8').trimEnd()) as GlbJson;
  const binaryChunkHeaderOffset = 20 + jsonChunkLength;
  const binaryChunkLength = file.readUInt32LE(binaryChunkHeaderOffset);
  const binary = file.subarray(
    binaryChunkHeaderOffset + 8,
    binaryChunkHeaderOffset + 8 + binaryChunkLength,
  );
  const expectedSelections = new Map<string, ProceduralLimbSelection>([
    ['Ren_YiFu_M', 'outerArms'],
    ['Ren_Shou_M', 'allArms'],
    ['Ren_KuZi_M', 'lowerLegs'],
    ['Ren_Xie_M', 'allLegs'],
  ]);
  const verifiedMaterials = new Set<string>();

  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const materialName = json.materials?.[primitive.material ?? -1]?.name ?? '';
      const selection = expectedSelections.get(materialName);
      if (!selection) continue;
      const positions = readGlbAccessor(json, binary, primitive.attributes.POSITION);
      const indices = readGlbAccessor(json, binary, primitive.indices);
      const mask = createConnectedLimbMask(positions, indices, selection);
      const expectedLeft = selection.includes('Arm')
        ? PROCEDURAL_LIMB.leftArm
        : PROCEDURAL_LIMB.leftLeg;
      const expectedRight = selection.includes('Arm')
        ? PROCEDURAL_LIMB.rightArm
        : PROCEDURAL_LIMB.rightLeg;

      assert.ok(mask.some((value) => value === expectedLeft), `${materialName} must contain left-limb vertices`);
      assert.ok(mask.some((value) => value === expectedRight), `${materialName} must contain right-limb vertices`);
      verifiedMaterials.add(materialName);
    }
  }

  assert.deepEqual(verifiedMaterials, new Set(expectedSelections.keys()));
});

function readGlbAccessor(json: GlbJson, binary: Buffer, accessorIndex: number): Float32Array {
  const accessor = json.accessors[accessorIndex];
  const bufferView = json.bufferViews[accessor.bufferView];
  const componentCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
  const componentSize = accessor.componentType === 5125 || accessor.componentType === 5126 ? 4 : 2;
  const stride = bufferView.byteStride ?? componentCount * componentSize;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const result = new Float32Array(accessor.count * componentCount);

  for (let element = 0; element < accessor.count; element += 1) {
    for (let component = 0; component < componentCount; component += 1) {
      const offset = start + element * stride + component * componentSize;
      result[element * componentCount + component] = accessor.componentType === 5126
        ? view.getFloat32(offset, true)
        : accessor.componentType === 5125
          ? view.getUint32(offset, true)
          : view.getUint16(offset, true);
    }
  }
  return result;
}
