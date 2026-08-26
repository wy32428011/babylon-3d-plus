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
  createProceduralStrideTargets,
  PROCEDURAL_LIMB,
  type ProceduralLimbSelection,
  type ProceduralPoint3,
  type ProceduralStrideLimbLengths,
  type ProceduralStridePivots,
  type ProceduralStrideRotationOffsets,
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

type ProceduralLimbName = keyof ProceduralStridePivots;
type LocalLimbSegment = { pivot: ProceduralPoint3; distal: ProceduralPoint3 };

const BUNDLED_AVATAR_LIMB_SEGMENTS: Record<ProceduralLimbName, LocalLimbSegment> = {
  // 这些坐标来自当前 GLB 节点经人物网格逆世界矩阵换算后的局部空间。
  leftArm: {
    pivot: { x: -0.0017938189347823652, y: 0.013234583292596587, z: 0.00002508027703731347 },
    distal: { x: -0.0021462778807617156, y: 0.011003673296601868, z: 0.00041240446066845987 },
  },
  rightArm: {
    pivot: { x: 0.001791824753382798, y: 0.013211494828545936, z: -0.000189200799317224 },
    distal: { x: 0.0021062702419598622, y: 0.011414343242555905, z: -0.0015757442021139337 },
  },
  leftLeg: {
    pivot: { x: -0.0008909945531065944, y: 0.007824086223866206, z: 7.166965285132498e-11 },
    distal: { x: -0.0009904246351126744, y: 0.004641385385707151, z: -0.0008436403362254326 },
  },
  rightLeg: {
    pivot: { x: 0.0008910030877267161, y: 0.007824086223866206, z: 7.166965285132498e-11 },
    distal: { x: 0.0009956593048698892, y: 0.004602290468580502, z: 0.0006784095353326268 },
  },
};

const BUNDLED_AVATAR_GAIT_POSE = resolveBundledAvatarGaitPose();

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

test('the bundled clothing keeps shoulder and waist seams closed without pinning the limbs', async () => {
  const file = await readFile(new URL('../../public/manual-roam/EQ_People.glb', import.meta.url));
  const jsonChunkLength = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + jsonChunkLength).toString('utf8').trimEnd()) as GlbJson;
  const binaryChunkHeaderOffset = 20 + jsonChunkLength;
  const binaryChunkLength = file.readUInt32LE(binaryChunkHeaderOffset);
  const binary = file.subarray(
    binaryChunkHeaderOffset + 8,
    binaryChunkHeaderOffset + 8 + binaryChunkLength,
  );
  const seamSelections = new Map<string, ProceduralLimbSelection>([
    ['Ren_YiFu_M', 'outerArms'],
    ['Ren_KuZi_M', 'lowerLegs'],
  ]);

  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const materialName = json.materials?.[primitive.material ?? -1]?.name ?? '';
      const selection = seamSelections.get(materialName);
      if (!selection) continue;
      const positions = readGlbAccessor(json, binary, primitive.attributes.POSITION);
      const indices = readGlbAccessor(json, binary, primitive.indices);
      const mask = createConnectedLimbMask(positions, indices, selection);
      const targets = createProceduralStrideTargets(positions, {
        limbMask: mask,
        pivots: BUNDLED_AVATAR_GAIT_POSE.pivots,
        distals: BUNDLED_AVATAR_GAIT_POSE.distals,
        neutralRotationOffsets: BUNDLED_AVATAR_GAIT_POSE.neutralRotationOffsets,
        limbLengths: BUNDLED_AVATAR_GAIT_POSE.limbLengths,
      });
      assert.ok(targets, `${materialName} must create procedural stride targets`);
      const verticesByPosition = new Map<string, number[]>();

      for (const vertexIndex of new Set(Array.from(indices, (value) => Math.trunc(value)))) {
        const positionIndex = vertexIndex * 3;
        const key = `${positions[positionIndex]}|${positions[positionIndex + 1]}|${positions[positionIndex + 2]}`;
        const vertexIndices = verticesByPosition.get(key) ?? [];
        vertexIndices.push(vertexIndex);
        verticesByPosition.set(key, vertexIndices);
      }

      let protectedSeamVertexCount = 0;
      let protectedJointVertexCount = 0;
      let maximumDisplacementRatio = 0;
      for (const vertexIndices of verticesByPosition.values()) {
        const fixedVertexIndex = vertexIndices.find((vertexIndex) => (
          mask[vertexIndex] === PROCEDURAL_LIMB.fixed
        ));
        if (fixedVertexIndex === undefined) continue;

        for (const movingVertexIndex of vertexIndices) {
          const limbName = resolveProceduralLimbName(mask[movingVertexIndex]);
          if (!limbName) continue;
          const distanceFromJoint = readVertexAxialDistance(
            positions,
            movingVertexIndex,
            BUNDLED_AVATAR_LIMB_SEGMENTS[limbName],
          );
          if (distanceFromJoint > BUNDLED_AVATAR_GAIT_POSE.limbLengths[limbName] * 0.5 + 1e-8) {
            continue;
          }

          protectedSeamVertexCount += 1;
          for (const target of [targets.neutral, targets.forward, targets.backward]) {
            assertVertexDistanceAtMost(target, movingVertexIndex, target, fixedVertexIndex, 1e-7);
          }
        }
      }

      for (let vertexIndex = 0; vertexIndex < mask.length; vertexIndex += 1) {
        const limbName = resolveProceduralLimbName(mask[vertexIndex]);
        if (!limbName) continue;
        const limbLength = BUNDLED_AVATAR_GAIT_POSE.limbLengths[limbName];
        const axialDistance = readVertexAxialDistance(
          positions,
          vertexIndex,
          BUNDLED_AVATAR_LIMB_SEGMENTS[limbName],
        );
        if (axialDistance <= limbLength * 0.5 + 1e-8) {
          protectedJointVertexCount += 1;
          for (const target of [targets.neutral, targets.forward, targets.backward]) {
            assertVertexDistanceAtMost(target, vertexIndex, positions, vertexIndex, 1e-7);
          }
        }
        maximumDisplacementRatio = Math.max(
          maximumDisplacementRatio,
          readVertexDisplacement(targets.forward, positions, vertexIndex) / limbLength,
          readVertexDisplacement(targets.backward, positions, vertexIndex) / limbLength,
        );
      }

      assert.ok(protectedSeamVertexCount > 0, `${materialName} must expose a protected joint seam`);
      assert.ok(
        protectedJointVertexCount > protectedSeamVertexCount,
        `${materialName} must protect the full joint cross-section, not only coincident seam vertices`,
      );
      assert.ok(
        maximumDisplacementRatio > 0.4,
        `${materialName} distal vertices must retain at least 40% of one limb length of motion`,
      );
    }
  }
});

function resolveBundledAvatarGaitPose(): {
  pivots: ProceduralStridePivots;
  distals: ProceduralStridePivots;
  neutralRotationOffsets: ProceduralStrideRotationOffsets;
  limbLengths: ProceduralStrideLimbLengths;
} {
  const resolveLength = (segment: LocalLimbSegment): number => Math.hypot(
    segment.distal.x - segment.pivot.x,
    segment.distal.y - segment.pivot.y,
    segment.distal.z - segment.pivot.z,
  );
  const resolveRotationOffset = (segment: LocalLimbSegment): number => Math.atan2(
    segment.distal.z - segment.pivot.z,
    -(segment.distal.y - segment.pivot.y),
  );

  return {
    pivots: {
      leftArm: BUNDLED_AVATAR_LIMB_SEGMENTS.leftArm.pivot,
      rightArm: BUNDLED_AVATAR_LIMB_SEGMENTS.rightArm.pivot,
      leftLeg: BUNDLED_AVATAR_LIMB_SEGMENTS.leftLeg.pivot,
      rightLeg: BUNDLED_AVATAR_LIMB_SEGMENTS.rightLeg.pivot,
    },
    distals: {
      leftArm: BUNDLED_AVATAR_LIMB_SEGMENTS.leftArm.distal,
      rightArm: BUNDLED_AVATAR_LIMB_SEGMENTS.rightArm.distal,
      leftLeg: BUNDLED_AVATAR_LIMB_SEGMENTS.leftLeg.distal,
      rightLeg: BUNDLED_AVATAR_LIMB_SEGMENTS.rightLeg.distal,
    },
    neutralRotationOffsets: {
      leftArm: resolveRotationOffset(BUNDLED_AVATAR_LIMB_SEGMENTS.leftArm),
      rightArm: resolveRotationOffset(BUNDLED_AVATAR_LIMB_SEGMENTS.rightArm),
      leftLeg: resolveRotationOffset(BUNDLED_AVATAR_LIMB_SEGMENTS.leftLeg),
      rightLeg: resolveRotationOffset(BUNDLED_AVATAR_LIMB_SEGMENTS.rightLeg),
    },
    limbLengths: {
      leftArm: resolveLength(BUNDLED_AVATAR_LIMB_SEGMENTS.leftArm),
      rightArm: resolveLength(BUNDLED_AVATAR_LIMB_SEGMENTS.rightArm),
      leftLeg: resolveLength(BUNDLED_AVATAR_LIMB_SEGMENTS.leftLeg),
      rightLeg: resolveLength(BUNDLED_AVATAR_LIMB_SEGMENTS.rightLeg),
    },
  };
}

function resolveProceduralLimbName(value: number): ProceduralLimbName | null {
  if (value === PROCEDURAL_LIMB.leftArm) return 'leftArm';
  if (value === PROCEDURAL_LIMB.rightArm) return 'rightArm';
  if (value === PROCEDURAL_LIMB.leftLeg) return 'leftLeg';
  if (value === PROCEDURAL_LIMB.rightLeg) return 'rightLeg';
  return null;
}

function readVertexAxialDistance(
  positions: ArrayLike<number>,
  vertexIndex: number,
  segment: LocalLimbSegment,
): number {
  const axisX = segment.distal.x - segment.pivot.x;
  const axisY = segment.distal.y - segment.pivot.y;
  const axisZ = segment.distal.z - segment.pivot.z;
  const axisLength = Math.hypot(axisX, axisY, axisZ);
  const positionIndex = vertexIndex * 3;
  return Math.max(
    0,
    (
      (positions[positionIndex] - segment.pivot.x) * axisX
      + (positions[positionIndex + 1] - segment.pivot.y) * axisY
      + (positions[positionIndex + 2] - segment.pivot.z) * axisZ
    ) / axisLength,
  );
}

function readVertexDisplacement(
  target: ArrayLike<number>,
  source: ArrayLike<number>,
  vertexIndex: number,
): number {
  const positionIndex = vertexIndex * 3;
  return Math.hypot(
    target[positionIndex] - source[positionIndex],
    target[positionIndex + 1] - source[positionIndex + 1],
    target[positionIndex + 2] - source[positionIndex + 2],
  );
}

function assertVertexDistanceAtMost(
  left: ArrayLike<number>,
  leftVertexIndex: number,
  right: ArrayLike<number>,
  rightVertexIndex: number,
  maximumDistance: number,
): void {
  const leftIndex = leftVertexIndex * 3;
  const rightIndex = rightVertexIndex * 3;
  const distance = Math.hypot(
    left[leftIndex] - right[rightIndex],
    left[leftIndex + 1] - right[rightIndex + 1],
    left[leftIndex + 2] - right[rightIndex + 2],
  );
  assert.ok(distance <= maximumDistance, `seam distance ${distance} must be <= ${maximumDistance}`);
}

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
