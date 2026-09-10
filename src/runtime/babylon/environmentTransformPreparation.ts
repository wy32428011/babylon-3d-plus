import type { TransformNode } from '@babylonjs/core';

/**
 * 仅冻结环境清单里的静态节点，父节点先完成，避免每个子网格重复计算未冻结的祖先。
 * freezeWorldMatrix 自身会计算矩阵，不再额外调用 computeWorldMatrix(true)。
 */
export function freezeEnvironmentTransforms(nodes: readonly TransformNode[]): void {
  const pending = new Set(nodes.filter(node => !node.isDisposed()));
  for (const node of pending) {
    const ancestors: TransformNode[] = [];
    let current: TransformNode | null = node;
    while (current && pending.delete(current)) {
      ancestors.push(current);
      current = current.parent as TransformNode | null;
    }
    for (let index = ancestors.length - 1; index >= 0; index--) {
      ancestors[index].freezeWorldMatrix();
    }
  }
}
