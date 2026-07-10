import type { ModelAssetComponent } from '../../../editor/model/components';
import {
  createDefaultTelemetryBinding,
  normalizeTelemetryDeviceType,
  normalizeModelDataDrivenConfig,
  type ModelDataDrivenConfig,
  type TelemetryBindingComponent,
  type TelemetryMotionChannel,
} from '../../../editor/model/telemetryBinding';

export type CompileTelemetryMotionBindingOptions = {
  entityId: string;
  modelAsset: ModelAssetComponent;
  binding: TelemetryBindingComponent | null | undefined;
  externalDataDrivenConfigs: readonly unknown[];
};

export type CompiledTelemetryMotionBinding = {
  entityId: string;
  key: string;
  binding: TelemetryBindingComponent;
  channels: Record<string, TelemetryMotionChannel>;
  interpolationMs: number;
  signature: string;
};

/** 合并模型包、脚本 fallback 和实体实例覆盖，生成运行时可执行的通用遥测绑定。 */
export function compileTelemetryMotionBinding(options: CompileTelemetryMotionBindingOptions): CompiledTelemetryMotionBinding | null {
  const modelConfig = options.modelAsset.dataDrivenConfig ?? null;
  const scriptConfigs = collectScriptDataDrivenConfigs(options.externalDataDrivenConfigs);
  const primaryConfig = modelConfig ?? scriptConfigs[0] ?? null;
  const deviceType = normalizeTelemetryDeviceType(options.binding?.deviceType ?? primaryConfig?.device.devType);
  if (!deviceType) return null;

  const baseBinding = options.binding ?? createDefaultTelemetryBinding(deviceType);
  if (!baseBinding.enabled) return null;
  const binding: TelemetryBindingComponent = {
    ...baseBinding,
    deviceType,
    assetCode: baseBinding.assetCode ?? options.modelAsset.assetCode ?? primaryConfig?.device.defaultAssetCode,
    channelOverrides: baseBinding.channelOverrides ?? {},
  };
  if (!binding.assetCode) return null;

  const channels: Record<string, TelemetryMotionChannel> = {};
  for (const config of scriptConfigs) {
    Object.assign(channels, config.motion);
  }
  if (modelConfig) Object.assign(channels, modelConfig.motion);
  Object.assign(channels, binding.channelOverrides);
  if (Object.keys(channels).length === 0) return null;

  const interpolationMs = primaryConfig?.device.interpolationMs ?? 200;
  const signature = JSON.stringify({ binding, channels, interpolationMs });
  return {
    entityId: options.entityId,
    key: createTelemetryBindingKey(binding.sourceId, binding.deviceType, binding.assetCode),
    binding,
    channels,
    interpolationMs,
    signature,
  };
}

/** 生成 sourceId/deviceType/assetCode 组合主键；sourceId 去空格、deviceType 小写，assetCode 保持大小写语义。 */
export function createTelemetryBindingKey(sourceId: string, deviceType: string, assetCode: string): string {
  const normalizedSourceId = sourceId.trim() || 'default';
  return [normalizedSourceId, normalizeTelemetryDeviceType(deviceType, 'device') ?? 'device', assetCode].join('\u0000');
}

/** 归一化脚本导出的 dataDriven 配置；脚本只作为模型配置的 fallback/补充。 */
function collectScriptDataDrivenConfigs(externalDataDrivenConfigs: readonly unknown[]): ModelDataDrivenConfig[] {
  const configs: ModelDataDrivenConfig[] = [];
  for (const rawConfig of externalDataDrivenConfigs) {
    const config = normalizeModelDataDrivenConfig(rawConfig);
    if (config) configs.push(config);
  }
  return configs;
}
