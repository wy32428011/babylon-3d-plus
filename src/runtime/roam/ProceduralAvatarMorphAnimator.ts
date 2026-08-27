import {
  type AbstractMesh,
  MorphTarget,
  MorphTargetManager,
  type Scene,
  Vector3,
  VertexBuffer,
} from '@babylonjs/core';
import {
  createConnectedLimbMask,
  createProceduralStrideTargets,
  resolveProceduralStrideInfluences,
  type ProceduralLimbSelection,
  type ProceduralStrideLimbLengths,
  type ProceduralStridePivots,
  type ProceduralStrideRotationOffsets,
} from './proceduralAvatarAnimation';

type MorphPair = {
  mesh: AbstractMesh;
  manager: MorphTargetManager;
  neutral: MorphTarget;
  forward: MorphTarget;
  backward: MorphTarget;
};

type LocalPoint = { x: number; y: number; z: number };
type LocalLimbSegment = { pivot: LocalPoint; distal: LocalPoint };
type MeshLocalGaitPose = {
  pivots: Partial<ProceduralStridePivots>;
  distals: Partial<ProceduralStridePivots>;
  neutralRotationOffsets: Partial<ProceduralStrideRotationOffsets>;
  limbLengths: Partial<ProceduralStrideLimbLengths>;
};

/** 为静态人物网格安装 GPU Morph Target 步态，避免每帧重传顶点。 */
export class ProceduralAvatarMorphAnimator {
  static create(scene: Scene, meshes: readonly AbstractMesh[]): ProceduralAvatarMorphAnimator | null {
    const pairs: MorphPair[] = [];
    for (const mesh of meshes) {
      if (mesh.isDisposed() || mesh.getTotalVertices() <= 0 || mesh.morphTargetManager) continue;
      const limbSelection = resolveLimbSelection(mesh.material?.name ?? mesh.name);
      const indices = mesh.getIndices();
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
      if (!limbSelection || !indices || !positions) continue;
      const limbMask = createConnectedLimbMask(positions, indices, limbSelection);
      const localPose = resolveMeshLocalGaitPose(scene, mesh);
      const strideTargets = createProceduralStrideTargets(positions, {
        limbMask,
        normals: mesh.getVerticesData(VertexBuffer.NormalKind),
        tangents: mesh.getVerticesData(VertexBuffer.TangentKind),
        pivots: localPose.pivots,
        distals: localPose.distals,
        neutralRotationOffsets: localPose.neutralRotationOffsets,
        limbLengths: localPose.limbLengths,
      });
      if (!strideTargets) continue;

      const manager = new MorphTargetManager(scene, mesh.name);
      manager.numMaxInfluencers = 2;
      const neutral = new MorphTarget(`${mesh.name}_manual_roam_stride_neutral`, 1, scene, manager);
      neutral.setPositions(strideTargets.neutral);
      neutral.setNormals(strideTargets.neutralNormals);
      neutral.setTangents(strideTargets.neutralTangents);
      const forward = new MorphTarget(`${mesh.name}_manual_roam_stride_forward`, 0, scene, manager);
      forward.setPositions(strideTargets.forward);
      forward.setNormals(strideTargets.forwardNormals);
      forward.setTangents(strideTargets.forwardTangents);
      const backward = new MorphTarget(`${mesh.name}_manual_roam_stride_backward`, 0, scene, manager);
      backward.setPositions(strideTargets.backward);
      backward.setNormals(strideTargets.backwardNormals);
      backward.setTangents(strideTargets.backwardTangents);
      manager.addTarget(neutral);
      manager.addTarget(forward);
      manager.addTarget(backward);
      mesh.morphTargetManager = manager;
      pairs.push({ mesh, manager, neutral, forward, backward });
    }
    return pairs.length > 0 ? new ProceduralAvatarMorphAnimator(pairs) : null;
  }

  private constructor(private readonly pairs: MorphPair[]) {}

  get meshCount(): number {
    return this.pairs.length;
  }

  update(phase: number, movementAmount: number, airborne: boolean): void {
    const influences = resolveProceduralStrideInfluences(phase, movementAmount, airborne);
    for (const pair of this.pairs) {
      pair.neutral.influence = influences.neutral;
      pair.forward.influence = influences.forward;
      pair.backward.influence = influences.backward;
    }
  }

  dispose(): void {
    for (const pair of this.pairs) {
      if (!pair.mesh.isDisposed() && pair.mesh.morphTargetManager === pair.manager) {
        pair.mesh.morphTargetManager = null;
      }
      pair.manager.dispose();
    }
    this.pairs.length = 0;
  }
}

function resolveLimbSelection(materialName: string): ProceduralLimbSelection | null {
  const normalized = materialName.toLowerCase();
  if (/yifu|clothes?|shirt|uniform|jacket/.test(normalized)) return 'outerArms';
  if (/shou|hands?|gloves?/.test(normalized)) return 'allArms';
  if (/kuzi|pants?|trousers?/.test(normalized)) return 'lowerLegs';
  if (/xie|shoes?|boots?/.test(normalized)) return 'allLegs';
  return null;
}

function resolveMeshLocalGaitPose(scene: Scene, mesh: AbstractMesh): MeshLocalGaitPose {
  mesh.computeWorldMatrix(true);
  const inverseWorld = mesh.getWorldMatrix().clone().invert();
  const resolve = (name: string): LocalPoint | undefined => {
    const node = scene.getTransformNodeByName(name);
    if (!node) return undefined;
    node.computeWorldMatrix(true);
    const local = Vector3.TransformCoordinates(node.getAbsolutePosition(), inverseWorld);
    return { x: local.x, y: local.y, z: local.z };
  };

  const resolveSegment = (pivotName: string, distalName: string): LocalLimbSegment | null => {
    const pivot = resolve(pivotName);
    const distal = resolve(distalName);
    return pivot && distal ? { pivot, distal } : null;
  };
  const arms = orderSegmentsByLocalX([
    resolveSegment('Character1_LeftArm', 'Character1_LeftForeArm'),
    resolveSegment('Character1_RightArm', 'Character1_RightForeArm'),
  ]);
  const legs = orderSegmentsByLocalX([
    resolveSegment('Character1_LeftUpLeg', 'Character1_LeftLeg'),
    resolveSegment('Character1_RightUpLeg', 'Character1_RightLeg'),
  ]);

  return {
    pivots: {
      leftArm: arms[0]?.pivot,
      rightArm: arms[1]?.pivot,
      leftLeg: legs[0]?.pivot,
      rightLeg: legs[1]?.pivot,
    },
    distals: {
      leftArm: arms[0]?.distal,
      rightArm: arms[1]?.distal,
      leftLeg: legs[0]?.distal,
      rightLeg: legs[1]?.distal,
    },
    neutralRotationOffsets: {
      leftArm: resolveNeutralRotationOffset(arms[0]),
      rightArm: resolveNeutralRotationOffset(arms[1]),
      leftLeg: resolveNeutralRotationOffset(legs[0]),
      rightLeg: resolveNeutralRotationOffset(legs[1]),
    },
    limbLengths: {
      leftArm: resolveSegmentLength(arms[0]),
      rightArm: resolveSegmentLength(arms[1]),
      leftLeg: resolveSegmentLength(legs[0]),
      rightLeg: resolveSegmentLength(legs[1]),
    },
  };
}

function orderSegmentsByLocalX(segments: Array<LocalLimbSegment | null>): LocalLimbSegment[] {
  const validSegments = segments
    .filter((segment): segment is LocalLimbSegment => Boolean(segment))
    .sort((left, right) => left.pivot.x - right.pivot.x);
  return validSegments.length === 2 ? validSegments : [];
}

function resolveNeutralRotationOffset(segment: LocalLimbSegment | undefined): number | undefined {
  if (!segment) return undefined;
  const relativeY = segment.distal.y - segment.pivot.y;
  const relativeZ = segment.distal.z - segment.pivot.z;
  if (Math.hypot(relativeY, relativeZ) <= 1e-6) return undefined;
  return Math.atan2(relativeZ, -relativeY);
}

function resolveSegmentLength(segment: LocalLimbSegment | undefined): number | undefined {
  if (!segment) return undefined;
  return Math.hypot(
    segment.distal.x - segment.pivot.x,
    segment.distal.y - segment.pivot.y,
    segment.distal.z - segment.pivot.z,
  );
}
