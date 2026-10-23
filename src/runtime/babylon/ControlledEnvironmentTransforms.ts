import type { AssetContainer } from '@babylonjs/core/assetContainer.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

/** 环境放置完成后的静态叶网格冻结会话；调用方先解除导入冻结，根和中间节点保持可编辑。 */
export class ControlledEnvironmentTransforms {
  private readonly frozenMeshes = new Set<AbstractMesh>();
  private readonly container: AssetContainer;

  constructor(container: AssetContainer) {
    this.container = container;
  }

  freeze(): void {
    this.unfreeze();
    const animatedTargets = new Set(this.container.animationGroups.flatMap(group =>
      group.targetedAnimations.map(animation => animation.target)));
    const candidates: AbstractMesh[] = [];
    const orderedNodes: TransformNode[] = [];
    const preparedNodes = new Set<TransformNode>();
    for (const mesh of this.container.meshes) {
      if (mesh.isDisposed() || mesh.getTotalVertices() === 0 || mesh.getChildren(undefined, true).length > 0) continue;
      if (!this.hasStaticAncestry(mesh, animatedTargets)) continue;
      candidates.push(mesh);
      const ancestors: TransformNode[] = [];
      for (let node: TransformNode | null = mesh; node && !preparedNodes.has(node);
        node = node.parent instanceof TransformNode ? node.parent : null) {
        preparedNodes.add(node);
        ancestors.push(node);
      }
      orderedNodes.push(...ancestors.reverse());
    }
    // 父级先失效再按序求值，避免同一帧的 Babylon 缓存短路，也避免每个叶网格强制重算整条父链。
    for (const node of orderedNodes) node.markAsDirty();
    for (const node of orderedNodes) node.computeWorldMatrix();
    for (const mesh of candidates) {
      mesh.freezeWorldMatrix(mesh.getWorldMatrix());
      this.frozenMeshes.add(mesh);
    }
  }

  unfreeze(): void {
    for (const mesh of this.frozenMeshes) {
      if (!mesh.isDisposed()) mesh.unfreezeWorldMatrix();
    }
    this.frozenMeshes.clear();
  }

  private hasStaticAncestry(mesh: AbstractMesh, animatedTargets: ReadonlySet<unknown>): boolean {
    for (let node: TransformNode | null = mesh; node; node = node.parent instanceof TransformNode ? node.parent : null) {
      if (node.parent && !(node.parent instanceof TransformNode)) return false;
      if (animatedTargets.has(node) || node.animations.length > 0 || node.billboardMode !== 0 || node.infiniteDistance
        || (node.getScene().getAllAnimatablesByTarget?.(node).length ?? 0) > 0) return false;
      const metadata = node.metadata as Record<string, unknown> | null;
      if (metadata && (metadata.editorStaticWorldMatrix === false || metadata.motionSourceNodeName
        || metadata.dataDriven || metadata.script || metadata.runtimeDynamic)) return false;
      if (node instanceof AbstractMesh && (node.actionManager || node.skeleton || node.morphTargetManager
        || node.bakedVertexAnimationManager)) return false;
    }
    return true;
  }
}
