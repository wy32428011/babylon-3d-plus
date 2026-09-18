import type { AbstractMesh, Node, Scene } from '@babylonjs/core';
import type { ModelRuntimeEntry } from './SceneRuntime';
import { findModelNodes, findModelNodesByName } from './runtimeNodeGeometry';
import { isPlainRecord, readStringArrayPath } from './runtimeValueUtils';
import { RGV_FALLBACK_FIXED_NODE_PATTERN, STACKER_FALLBACK_FIXED_NODE_NAMES } from './telemetry/specialized/types';

/**
 * 识别模型的固定轨道节点：模型脚本 dataDriven.fixedNodes 声明优先；
 * 缺失时按设备能力回退（堆垛机天地轨固定名 / RGV A37~A46 导轨正则），与遥测驱动同一套语义。
 */
export function getFixedTrackNodes(model: ModelRuntimeEntry, scene: Scene): Set<Node> {
  const configs: Record<string, unknown>[] = [
    model.entitySnapshot?.components.modelAsset?.dataDrivenConfig,
    ...(model.externalScriptRuntime?.getDataDrivenConfigs() ?? []),
  ].filter(isPlainRecord);

  for (const config of configs) {
    const declaredNames = readStringArrayPath(config, ['fixedNodes']);
    if (declaredNames.length === 0) continue;
    const declared = findModelNodesByName(model, scene, declaredNames);
    if (declared.length > 0) return new Set<Node>(declared);
  }

  if (model.stackerCapable) {
    return new Set<Node>(findModelNodesByName(model, scene, [...STACKER_FALLBACK_FIXED_NODE_NAMES]));
  }
  if (model.rgvCapable) {
    return new Set<Node>(findModelNodes(model, scene, RGV_FALLBACK_FIXED_NODE_PATTERN));
  }
  return new Set<Node>();
}

/** 剔除固定轨道子树网格：mesh 自身或任一祖先命中固定节点即排除。 */
export function excludeFixedTrackMeshes(meshes: readonly AbstractMesh[], fixedNodes: ReadonlySet<Node>): AbstractMesh[] {
  if (fixedNodes.size === 0) return [...meshes];
  return meshes.filter((mesh) => {
    for (let node: Node | null = mesh; node; node = node.parent) {
      if (fixedNodes.has(node)) return false;
    }
    return true;
  });
}
