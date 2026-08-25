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
  type ProceduralStridePivots,
} from './proceduralAvatarAnimation';

type MorphPair = {
  mesh: AbstractMesh;
  manager: MorphTargetManager;
  forward: MorphTarget;
  backward: MorphTarget;
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
      const strideTargets = createProceduralStrideTargets(positions, {
        limbMask,
        normals: mesh.getVerticesData(VertexBuffer.NormalKind),
        tangents: mesh.getVerticesData(VertexBuffer.TangentKind),
        pivots: resolveMeshLocalPivots(scene, mesh),
      });
      if (!strideTargets) continue;

      const manager = new MorphTargetManager(scene, mesh.name);
      manager.numMaxInfluencers = 2;
      const forward = new MorphTarget(`${mesh.name}_manual_roam_stride_forward`, 0, scene, manager);
      forward.setPositions(strideTargets.forward);
      forward.setNormals(strideTargets.forwardNormals);
      forward.setTangents(strideTargets.forwardTangents);
      const backward = new MorphTarget(`${mesh.name}_manual_roam_stride_backward`, 0, scene, manager);
      backward.setPositions(strideTargets.backward);
      backward.setNormals(strideTargets.backwardNormals);
      backward.setTangents(strideTargets.backwardTangents);
      manager.addTarget(forward);
      manager.addTarget(backward);
      mesh.morphTargetManager = manager;
      pairs.push({ mesh, manager, forward, backward });
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

function resolveMeshLocalPivots(scene: Scene, mesh: AbstractMesh): Partial<ProceduralStridePivots> {
  mesh.computeWorldMatrix(true);
  const inverseWorld = mesh.getWorldMatrix().clone().invert();
  const resolve = (name: string): { x: number; y: number; z: number } | undefined => {
    const node = scene.getTransformNodeByName(name);
    if (!node) return undefined;
    node.computeWorldMatrix(true);
    const local = Vector3.TransformCoordinates(node.getAbsolutePosition(), inverseWorld);
    return { x: local.x, y: local.y, z: local.z };
  };
  return {
    leftArm: resolve('Character1_LeftArm'),
    rightArm: resolve('Character1_RightArm'),
    leftLeg: resolve('Character1_LeftUpLeg'),
    rightLeg: resolve('Character1_RightUpLeg'),
  };
}
