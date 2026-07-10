import { Bone, Matrix, Quaternion, TransformNode, Vector3 } from '@babylonjs/core';

export type ModelTelemetryPreviewBaseline = {
  nodes: ModelTelemetryPreviewNodeBaseline[];
  bones: ModelTelemetryPreviewBoneBaseline[];
};

type ModelTelemetryPreviewNodeBaseline = {
  node: TransformNode;
  position: Vector3;
  rotation: Vector3;
  rotationQuaternion: Quaternion | null;
  scaling: Vector3;
  enabled: boolean;
};

type ModelTelemetryPreviewBoneBaseline = {
  bone: Bone;
  localMatrix: Matrix;
};

/** 捕获单个模型参与 MQTT 预览前的节点和骨骼姿态，供结束预览时无损恢复编辑态。 */
export function captureModelTelemetryPreviewBaseline(options: {
  root: TransformNode;
  contentRoot: TransformNode;
}): ModelTelemetryPreviewBaseline {
  const nodes = collectModelTelemetryPreviewNodes(options.root, options.contentRoot).map((node) => ({
    node,
    position: node.position.clone(),
    rotation: node.rotation.clone(),
    rotationQuaternion: node.rotationQuaternion?.clone() ?? null,
    scaling: node.scaling.clone(),
    enabled: node.isEnabled(false),
  }));
  const bones = collectModelTelemetryPreviewBones(options.contentRoot).map((bone) => ({
    bone,
    localMatrix: bone.getLocalMatrix().clone(),
  }));
  return { nodes, bones };
}

/** 按捕获形态恢复 TransformNode 和 Bone，本方法不重新加载 GLB，也不触碰 SceneDocument。 */
export function restoreModelTelemetryPreviewBaseline(baseline: ModelTelemetryPreviewBaseline): void {
  for (const item of baseline.nodes) {
    item.node.position.copyFrom(item.position);
    item.node.scaling.copyFrom(item.scaling);
    if (item.rotationQuaternion) {
      if (!item.node.rotationQuaternion) item.node.rotationQuaternion = item.rotationQuaternion.clone();
      else item.node.rotationQuaternion.copyFrom(item.rotationQuaternion);
      item.node.rotation.copyFrom(item.rotation);
    } else {
      item.node.rotationQuaternion = null;
      item.node.rotation.copyFrom(item.rotation);
    }
    item.node.setEnabled(item.enabled);
    item.node.computeWorldMatrix(true);
  }
  for (const item of baseline.bones) {
    restoreBoneLocalMatrix(item.bone, item.localMatrix);
  }
  for (const item of baseline.nodes) {
    item.node.computeWorldMatrix(true);
  }
}

/** 收集 root、contentRoot、全部子 TransformNode 和 mesh，使用 Set 去重避免父子重复捕获。 */
function collectModelTelemetryPreviewNodes(root: TransformNode, contentRoot: TransformNode): TransformNode[] {
  return [...new Set([root, contentRoot, ...contentRoot.getChildTransformNodes(false), ...contentRoot.getChildMeshes(false)])];
}

/** 从所有子 mesh 的 skeleton 中收集去重骨骼，避免共享 skeleton 被重复恢复。 */
function collectModelTelemetryPreviewBones(contentRoot: TransformNode): Bone[] {
  const bones = new Set<Bone>();
  for (const mesh of contentRoot.getChildMeshes(false)) {
    for (const bone of mesh.skeleton?.bones ?? []) {
      bones.add(bone);
    }
  }
  return [...bones];
}

/** 恢复 Babylon Bone 私有本地矩阵并刷新其 skeleton 绝对矩阵，匹配运行时直接改骨骼的回滚需求。 */
function restoreBoneLocalMatrix(bone: Bone, matrix: Matrix): void {
  const writableBone = bone as Bone & { _matrix: Matrix };
  writableBone._matrix = matrix.clone();
  bone.markAsDirty();
  bone.getSkeleton()?.computeAbsoluteMatrices();
}
