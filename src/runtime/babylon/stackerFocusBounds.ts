import { Vector3, type AbstractMesh, type Node, type TransformNode } from '@babylonjs/core';
import type { SceneCameraPose } from '../../editor/model/SceneDocument';
import type { ModelRuntimeEntry } from './SceneRuntime';
import { isMeasurableModelMesh } from './modelMeasurement';
import { getMeshWorldBounds, mergeWorldBounds, type RuntimeWorldBounds } from './runtimeNodeGeometry';
import { isPlainRecord, readStringArrayPath } from './runtimeValueUtils';
import { STACKER_FALLBACK_FIXED_NODE_NAMES, STACKER_FALLBACK_TRAVEL_NODE_NAMES } from './telemetry/specialized/types';

const BODY_PATTERN = /dingbuhuagui|dingbu|dibu|lizhu|dianji|caozuotai|xiang|huocha|顶部|底部|立柱|电机|操作台|载货|货叉|机身|主体/i;

/** 参考图采用梯笼所在端面的正向平视近景；方向随模型世界旋转变化。 */
export function createStackerFocusView(
  model: ModelRuntimeEntry,
  bounds: RuntimeWorldBounds,
): Pick<SceneCameraPose, 'target' | 'alpha' | 'beta'> & { maxRadiusMeters: number } {
  const center = bounds.minimum.add(bounds.maximum).scale(0.5);
  const size = bounds.maximum.subtract(bounds.minimum);
  // 锚点抬到梯笼中部；仍按机身横向尺寸限高，避免高立柱把镜头带到整机中段。
  center.y = bounds.minimum.y + Math.min(size.y, Math.hypot(size.x, size.z)) * 0.65;
  model.root.computeWorldMatrix(true);
  const front = model.root.getDirection(new Vector3(0, 0, 1));
  return {
    target: { x: center.x, y: center.y, z: center.z },
    alpha: Math.atan2(front.z, front.x),
    beta: Math.PI / 2,
    maxRadiusMeters: 8,
  };
}

/** 同时接受场景中归一化的 specializedMotion 和脚本原始 motion，不依赖遥测连接状态。 */
function readConfigs(model: ModelRuntimeEntry): Record<string, unknown>[] {
  const configs: unknown[] = [
    model.entitySnapshot?.components.modelAsset?.dataDrivenConfig,
    ...(model.externalScriptRuntime?.getDataDrivenConfigs() ?? []),
  ];
  return configs.filter(isPlainRecord).map(config => ({
    ...config,
    motion: isPlainRecord(config.specializedMotion) ? config.specializedMotion : config.motion,
  }));
}

/** 排除固定轨道整棵子树及模型内部隐藏节点；实体根的批次禁用不代表几何失效。 */
function isBodyMesh(mesh: AbstractMesh, root: TransformNode, candidates: Set<Node>, fixed: Set<Node>): boolean {
  if (!isMeasurableModelMesh(mesh)) return false;
  let selected = false;
  for (let node: Node | null = mesh; node; node = node.parent) {
    if (fixed.has(node)) return false;
    if (candidates.has(node)) selected = true;
    if (node === root) return selected;
    if (!node.isEnabled(false)) return false;
  }
  return false;
}

function mergeBodyMeshes(model: ModelRuntimeEntry, nodes: TransformNode[], fixed: Set<Node>): RuntimeWorldBounds | null {
  const candidates = new Set<Node>(nodes);
  let bounds: RuntimeWorldBounds | null = null;
  // 从实时层级取网格，包含参数脚本新增的货叉后代，避免依赖导入时的网格快照。
  for (const mesh of model.root.getChildMeshes(false)) {
    if (!isBodyMesh(mesh, model.root, candidates, fixed)) continue;
    const next = getMeshWorldBounds(mesh);
    if (next) bounds = bounds ? mergeWorldBounds(bounds, next) : next;
  }
  return bounds;
}

/** 名称兜底必须识别到主体结构，避免只命中电机或货叉就把小配件当作整机。 */
function hasBodyStructure(nodes: TransformNode[]): boolean {
  return nodes.some(node => /机身|主体/i.test(node.name))
    || (nodes.some(node => /lizhu|立柱/i.test(node.name))
      && nodes.some(node => /dingbu|dibu|顶部|底部/i.test(node.name)));
}

/** 只返回可可靠识别的堆垛机机身范围；null 由调用方回退完整模型范围。 */
export function getStackerFocusWorldBounds(model: ModelRuntimeEntry): RuntimeWorldBounds | null {
  const configs = readConfigs(model);
  const declaredTypes = configs.map(config => isPlainRecord(config.device) ? config.device.devType : undefined)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim().toLowerCase());
  if (declaredTypes.length > 0 ? declaredTypes[0] !== 'stacker' : !model.stackerCapable) return null;

  const allNodes = [model.root, ...model.root.getChildTransformNodes(false)];
  const fixedNames = new Set([
    ...STACKER_FALLBACK_FIXED_NODE_NAMES,
    ...configs.flatMap(config => readStringArrayPath(config, ['fixedNodes'])),
  ]);
  const fixed = new Set<Node>(allNodes.filter(node => fixedNames.has(node.name)));

  for (const config of configs) {
    const travelNames = readStringArrayPath(config, ['motion', 'travel', 'nodes']);
    if (travelNames.length === 0) continue;
    const travel = allNodes.filter(node => travelNames.includes(node.name));
    // 先验证行走主体存在，再补上可能作为兄弟节点生成的第二段货叉。
    if (!mergeBodyMeshes(model, travel, fixed)) continue;
    const names = new Set([
      ...travelNames,
      ...readStringArrayPath(config, ['motion', 'lift', 'nodes']),
      ...['frontStageOneNodes', 'frontStageTwoNodes', 'backStageOneNodes', 'backStageTwoNodes']
        .flatMap(key => readStringArrayPath(config, ['motion', 'fork', key])),
    ]);
    return mergeBodyMeshes(model, allNodes.filter(node => names.has(node.name)), fixed);
  }

  const exactNames = new Set(STACKER_FALLBACK_TRAVEL_NODE_NAMES);
  const exact = allNodes.filter(node => exactNames.has(node.name));
  if (hasBodyStructure(exact)) {
    const bounds = mergeBodyMeshes(model, exact, fixed);
    if (bounds) return bounds;
  }
  const semantic = allNodes.filter(node => BODY_PATTERN.test(node.name));
  return hasBodyStructure(semantic) ? mergeBodyMeshes(model, semantic, fixed) : null;
}
