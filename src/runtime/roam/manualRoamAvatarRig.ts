import { type AssetContainer, type TransformNode, Matrix, Vector3, Quaternion, VertexBuffer } from '@babylonjs/core';

export const MANUAL_ROAM_RIG_PROFILE = 'mixamo-humanoid-v1';
export const MANUAL_ROAM_RIG_PROFILE_V2 = 'mixamo-humanoid-v2';
export const MANUAL_ROAM_JOINT_PARENTS: Readonly<Record<string, string | null>> = {
  Hips: null, Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1', Neck: 'Spine2', Head: 'Neck',
  LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot',
};

export function getManualRoamRigProfile(container: AssetContainer): string | null {
  const declarations = [...container.meshes, ...container.transformNodes].map(node => node.metadata?.gltf?.extras?.manualRoamRig ?? node.metadata?.manualRoamRig).filter(Boolean);
  if (!declarations.length) return null;
  const first = declarations[0];
  if (declarations.some(value => value.profile !== first.profile || value.version !== first.version)
    || !(first.profile === MANUAL_ROAM_RIG_PROFILE && first.version === 1 || first.profile === MANUAL_ROAM_RIG_PROFILE_V2 && first.version === 2)) throw new Error('人物骨架 profile 或 version 不受支持。');
  return first.profile;
}

/** v2保留真实bind形状，只替换动画参考rest；inverse bind始终由原蒙皮拥有。 */
export function prepareManualRoamReferencePose(container: AssetContainer): void {
  if (getManualRoamRigProfile(container) !== MANUAL_ROAM_RIG_PROFILE_V2) return;
  const references = container.transformNodes.map(node => ({ node,
    pose: node.metadata?.gltf?.extras?.manualRoamReferencePose ?? node.metadata?.manualRoamReferencePose,
  })).filter(entry => entry.pose || container.skeletons.some(skeleton => skeleton.bones.some(bone => bone.getTransformNode() === entry.node)));
  // 全部校验完成才修改，避免错误metadata把人物留在半套参考姿态。
  const validated = references.map(({node,pose}) => {
    const vector = (value: unknown, length: number): value is number[] => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
    if (!pose || !vector(pose.translation,3) || !vector(pose.rotation,4) || !vector(pose.scale,3)
      || Math.abs(Math.hypot(...pose.rotation)-1)>1e-4 || Math.min(...pose.scale)<=0
      || Math.abs(pose.scale[0]-pose.scale[1])>1e-4 || Math.abs(pose.scale[0]-pose.scale[2])>1e-4) throw new Error(`人物动画参考姿态无效：${node.name}`);
    return {node, matrix:Matrix.Compose(Vector3.FromArray(pose.scale),Quaternion.FromArray(pose.rotation),Vector3.FromArray(pose.translation))};
  });
  for (const {node,matrix} of validated) for (const skeleton of container.skeletons) {
    for (const bone of skeleton.bones) if (bone.getTransformNode() === node) bone.setRestMatrix(matrix);
  }
}

export function validateManualRoamRigNodes(container: AssetContainer): Map<string, TransformNode> {
  if (!getManualRoamRigProfile(container)) throw new Error('人物缺少兼容骨架 profile。');
  const nodes = new Map<string, TransformNode>();
  for (const [name, parent] of Object.entries(MANUAL_ROAM_JOINT_PARENTS)) {
    const matches = container.transformNodes.filter(node => node.name === name);
    if (matches.length !== 1) throw new Error(`骨架关节缺失或重名：${name}`);
    const node = matches[0];
    if (parent && node.parent?.name !== parent) throw new Error(`骨架关节父级不兼容：${name}`);
    if (!parent && node.parent && node.parent.name in MANUAL_ROAM_JOINT_PARENTS) throw new Error('Hips 必须是骨架根关节。');
    const quaternion = node.rotationQuaternion ?? Quaternion.FromEulerVector(node.rotation);
    if (![...node.position.asArray(), ...node.scaling.asArray(), ...quaternion.asArray()].every(Number.isFinite)
      || Math.min(node.scaling.x, node.scaling.y, node.scaling.z) <= 0
      || Math.abs(node.scaling.x - node.scaling.y) > 1e-4 || Math.abs(node.scaling.x - node.scaling.z) > 1e-4
      || Math.abs(quaternion.length() - 1) > 0.01) throw new Error(`骨架 rest 变换无效：${name}`);
    nodes.set(name, node);
  }
  return nodes;
}

export function validateManualRoamAvatarRig(container: AssetContainer): Map<string, TransformNode> {
  const nodes = validateManualRoamRigNodes(container);
  const skinned = container.meshes.filter(mesh => mesh.getTotalVertices() > 0);
  if (!skinned.length) throw new Error('人物没有蒙皮网格。');
  const skeletons = new Set(skinned.map(mesh => mesh.skeleton));
  if (skeletons.size !== 1 || skeletons.has(null)) throw new Error('兼容人物必须使用同一个有效骨架。');
  const skeleton = skinned[0].skeleton!;
  for (const [name, node] of nodes) {
    const bones = skeleton.bones.filter(bone => bone.name === name);
    if (bones.length !== 1 || bones[0].getTransformNode() !== node || (bones[0].getParent()?.name ?? null) !== MANUAL_ROAM_JOINT_PARENTS[name]) throw new Error(`蒙皮骨骼绑定或父级无效：${name}`);
    const matrix = bones[0].getRestMatrix();
    if (!Array.from(matrix.m).every(Number.isFinite) || Math.abs(matrix.determinant()) < 1e-8) throw new Error(`蒙皮 rest 矩阵无效：${name}`);
  }
  for (const mesh of skinned) {
    const count = mesh.getTotalVertices();
    const weights = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
    const indices = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
    if (!weights || !indices || weights.length !== count * 4 || indices.length !== count * 4 || mesh.numBoneInfluencers > 4) throw new Error(`人物蒙皮权重格式无效：${mesh.name}`);
    for (let vertex = 0; vertex < count; vertex++) {
      let sum = 0;
      for (let offset = 0; offset < 4; offset++) {
        const index = vertex * 4 + offset;
        const weight = weights[index];
        if (!Number.isFinite(weight) || weight < 0 || !Number.isInteger(indices[index]) || indices[index] < 0 || indices[index] >= skeleton.bones.length) throw new Error(`人物蒙皮权重或索引无效：${mesh.name}`);
        sum += weight;
      }
      if (Math.abs(sum - 1) > 0.01) throw new Error(`人物蒙皮权重未归一化：${mesh.name}`);
    }
  }
  return nodes;
}

export function validateManualRoamRestCompatibility(source: Map<string, TransformNode>, target: Map<string, TransformNode>): void {
  for (const [name, node] of source) {
    if (name === 'Hips') continue;
    const other = target.get(name)!;
    const sourceLength = node.position.length();
    const targetLength = other.position.length();
    if (sourceLength < 1e-5 || targetLength < 1e-5 || Vector3.Dot(node.position.scale(1 / sourceLength), other.position.scale(1 / targetLength)) < 0.75) throw new Error(`骨架 rest 姿态不兼容：${name}`);
  }
}
