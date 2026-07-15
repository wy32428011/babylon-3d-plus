import type { ModelGeneratorComponent, ModelGeneratorTarget } from '../../editor/model/components';
import type { DeviceTelemetrySnapshot } from '../mqtt/deviceTelemetry';

/** 模型生成器规则可参与字符串比较的快照值类型。 */
export type ModelGeneratorRuntimeRuleValue = string | number | boolean;

/** 单个遥测快照解析出的模型生成目标，保留命中角色与原始快照用于后续运行时写元数据。 */
export type ResolvedModelGeneratorSnapshotTarget = {
  target: ModelGeneratorTarget;
  role: 'default' | 'conditional';
  snapshot: DeviceTelemetrySnapshot;
};

/** 判断快照属性值是否允许参与模型生成规则比较。 */
function isModelGeneratorRuntimeRuleValue(value: unknown): value is ModelGeneratorRuntimeRuleValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** 按属性名从快照顶层或 fields 中读取模型生成规则值。 */
function readModelGeneratorRuleValue(
  snapshot: DeviceTelemetrySnapshot,
  attributeName: string,
): ModelGeneratorRuntimeRuleValue | null {
  const value = attributeName === 'sourceId'
    ? snapshot.sourceId
    : attributeName === 'deviceType'
      ? snapshot.deviceType
      : attributeName === 'assetCode'
        ? snapshot.assetCode
        : snapshot.fields[attributeName];

  return isModelGeneratorRuntimeRuleValue(value) ? value : null;
}

/** 按规则顺序基于单个设备遥测快照解析模型生成目标。 */
export function resolveModelGeneratorTargetFromSnapshot(
  component: ModelGeneratorComponent,
  snapshot: DeviceTelemetrySnapshot,
): ResolvedModelGeneratorSnapshotTarget | null {
  for (const rule of component.rules) {
    const attributeName = rule.attributeName.trim();
    if (!attributeName) continue;

    const ruleValue = readModelGeneratorRuleValue(snapshot, attributeName);
    if (ruleValue === null) continue;
    if (String(ruleValue).trim() !== rule.attributeValue.trim()) continue;

    // 命中规则但规则目标与默认目标都为空时继续检查后续规则，避免空目标阻断可用规则。
    const target = rule.target ?? component.defaultTarget;
    if (!target) continue;

    return {
      target,
      role: rule.target ? 'conditional' : 'default',
      snapshot,
    };
  }

  if (!component.defaultTarget) return null;

  return {
    target: component.defaultTarget,
    role: 'default',
    snapshot,
  };
}
