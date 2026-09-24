import { TransformNode, type Scene } from '@babylonjs/core';
import type { CompositionDefinition, CompositionNode } from '../../../../electron/shared/compositionTypes';
import type { MeshRendererComponent } from '../../../editor/model/components';
import { isPlainRecord, sanitizeBabylonName } from '../runtimeValueUtils';

export type CompositionNodeTree = {
  /** 组合层级根节点，调用方负责挂到自己的父节点下。 */
  root: TransformNode;
  /** 组合节点 id → 运行时 TransformNode（folder 节点也在内）。 */
  nodes: Map<string, TransformNode>;
  /** 销毁整棵层级树（含所有后代节点）。 */
  dispose: () => void;
};

/**
 * 按组合定义构建纯 TransformNode 层级：节点 transform 已是相对组合 frame 的局部量，
 * 直接按 parentId 挂树；visible === false 的节点连同子树一起跳过；父引用缺失的孤儿节点挂到根下。
 */
export function buildCompositionNodeTree(
  definition: CompositionDefinition,
  scene: Scene,
  namePrefix: string,
): CompositionNodeTree {
  const root = new TransformNode(`${namePrefix}_root`, scene);
  root.doNotSerialize = true;
  const nodes = new Map<string, TransformNode>();

  for (const node of definition.nodes) {
    if (node.visible === false) continue;
    const transformNode = new TransformNode(`${namePrefix}_${sanitizeBabylonName(node.id)}`, scene);
    transformNode.doNotSerialize = true;
    const transform = node.components.transform;
    transformNode.position.set(transform.position.x, transform.position.y, transform.position.z);
    transformNode.rotation.set(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    transformNode.scaling.set(transform.scale.x, transform.scale.y, transform.scale.z);
    nodes.set(node.id, transformNode);
  }

  for (const node of definition.nodes) {
    const transformNode = nodes.get(node.id);
    if (!transformNode) continue;
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    transformNode.parent = parent ?? root;
  }

  return {
    root,
    nodes,
    dispose: () => root.dispose(),
  };
}

/** 读取组合节点上的内置网格组件；非基础网格类型或非法颜色时回退/忽略。 */
export function readCompositionNodeMeshRenderer(node: CompositionNode): MeshRendererComponent | null {
  const value = node.components.meshRenderer;
  if (!isPlainRecord(value)) return null;
  if (value.meshKind !== 'cube' && value.meshKind !== 'sphere' && value.meshKind !== 'plane') return null;
  const materialColor = typeof value.materialColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.materialColor)
    ? value.materialColor
    : '#8ab4f8';
  return { meshKind: value.meshKind, materialColor };
}

/** 读取组合节点的阵列实例源成员 id；非阵列实例成员返回 null。 */
export function readCompositionNodeArraySourceId(node: CompositionNode): string | null {
  const value = node.components.modelArrayInstance;
  if (!isPlainRecord(value)) return null;
  return typeof value.sourceEntityId === 'string' && value.sourceEntityId.length > 0 ? value.sourceEntityId : null;
}
