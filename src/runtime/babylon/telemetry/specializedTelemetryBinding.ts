import {
  createDefaultTelemetryBinding,
  normalizeTelemetryDeviceType,
  type TelemetryBindingComponent,
} from '../../../editor/model/telemetryBinding';
import {
  type DeviceTelemetrySnapshot,
  type DeviceTelemetryStore,
} from '../../mqtt/deviceTelemetry';
import { createTelemetryBindingKey } from './motionBindingCompiler';

export type SpecializedTelemetryDeviceType = 'stacker' | 'conveyor';

export type ResolvedSpecializedTelemetryBinding = {
  sourceId: string;
  deviceType: SpecializedTelemetryDeviceType;
  assetCode: string;
  staleAfterMs: number;
  key: string;
};

export type ResolveSpecializedTelemetryBindingOptions = {
  modelAssetCode: string;
  deviceType: SpecializedTelemetryDeviceType;
  binding: TelemetryBindingComponent | null | undefined;
};

/** 合并专用设备默认绑定和实例覆盖，只允许与专用驱动类型一致的安全绑定。 */
export function resolveSpecializedTelemetryBinding(
  options: ResolveSpecializedTelemetryBindingOptions,
): ResolvedSpecializedTelemetryBinding | null {
  if (options.binding?.enabled === false) return null;

  const binding = options.binding ?? createDefaultTelemetryBinding(options.deviceType);
  const normalizedDeviceType = normalizeTelemetryDeviceType(binding.deviceType);
  if (normalizedDeviceType !== options.deviceType) return null;

  const sourceId = binding.sourceId.trim() || 'default';
  const assetCode = (binding.assetCode ?? options.modelAssetCode).trim();
  if (!assetCode) return null;

  return {
    sourceId,
    deviceType: normalizedDeviceType,
    assetCode,
    staleAfterMs: binding.staleAfterMs,
    key: createTelemetryBindingKey(sourceId, normalizedDeviceType, assetCode),
  };
}

/** 使用已归一化的完整遥测主键读取专用设备快照，禁止跨数据源或跨设备类型兜底。 */
export function resolveSpecializedTelemetrySnapshot(
  store: Pick<DeviceTelemetryStore, 'getSnapshot'>,
  binding: ResolvedSpecializedTelemetryBinding,
): DeviceTelemetrySnapshot | null {
  return store.getSnapshot(binding.assetCode, binding.deviceType, binding.sourceId);
}

/** 统计完全相同的专用遥测主键，重复绑定时由调用方停止全部冲突模型。 */
export function collectSpecializedTelemetryConflictKeys(
  bindings: readonly ResolvedSpecializedTelemetryBinding[],
): Set<string> {
  const counts = new Map<string, number>();
  for (const binding of bindings) {
    counts.set(binding.key, (counts.get(binding.key) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
}
