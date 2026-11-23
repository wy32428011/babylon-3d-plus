import type { DeviceSpawnerComponent, DeviceSpawnerTemplateRule } from './components';
import type { Entity } from './Entity';
import { isAgvTelemetryDeviceType } from './telemetryBinding';

/** 设备产生器离线超时取值范围（秒）。 */
export const DEVICE_SPAWNER_MIN_TIMEOUT_SECONDS = 1;
export const DEVICE_SPAWNER_MAX_TIMEOUT_SECONDS = 3600;
export const DEVICE_SPAWNER_DEFAULT_TIMEOUT_SECONDS = 30;
export const DEVICE_SPAWNER_MAX_TEMPLATE_RULES = 32;

const DEVICE_SPAWNER_CODE_MAX_LENGTH = 128;
const DEVICE_SPAWNER_RULE_TEXT_MAX_LENGTH = 256;

function sanitizeRuleText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, DEVICE_SPAWNER_RULE_TEXT_MAX_LENGTH) : '';
}

function sanitizeTemplateEntityId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sanitizeTemplateRule(value: unknown): DeviceSpawnerTemplateRule | null {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const record = value as Record<string, unknown>;
  const id = sanitizeRuleText(record.id);
  if (!id) return null;
  return {
    id,
    attributeName: sanitizeRuleText(record.attributeName),
    attributeValue: sanitizeRuleText(record.attributeValue),
    templateEntityId: sanitizeTemplateEntityId(record.templateEntityId),
  };
}

/** 读取模板实例最终遥测设备类型，优先级与运行时绑定解析一致。 */
export function resolveDeviceSpawnerTemplateDeviceType(entity: Pick<Entity, 'components'> | undefined): string {
  return (
    entity?.components.telemetryBinding?.deviceType
    || entity?.components.modelAsset?.dataDrivenConfig?.device.devType
    || entity?.components.modelAsset?.deviceType
    || ''
  ).trim().toLowerCase();
}

/** AGV 产生器只接受 modelAsset 完整且设备类型为 agv/agv_xxx 的场景实例。 */
export function isAgvSpawnerTemplateEntity(entity: Pick<Entity, 'components'> | undefined): boolean {
  return Boolean(entity?.components.modelAsset && isAgvTelemetryDeviceType(resolveDeviceSpawnerTemplateDeviceType(entity)));
}

/** 创建一份默认设备产生器组件。 */
export function createDefaultDeviceSpawner(): DeviceSpawnerComponent {
  return {
    spawnerCode: '',
    templateEntityId: null,
    timeoutSeconds: DEVICE_SPAWNER_DEFAULT_TIMEOUT_SECONDS,
    templateRules: [],
  };
}

/** 清理设备产生器组件；非法结构返回 null，由序列化层决定是否拒绝场景文件。 */
export function sanitizeDeviceSpawnerComponent(value: unknown): DeviceSpawnerComponent | null {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const record = value as Record<string, unknown>;

  const spawnerCode = typeof record.spawnerCode === 'string'
    ? record.spawnerCode.trim().slice(0, DEVICE_SPAWNER_CODE_MAX_LENGTH)
    : '';
  const templateEntityId = sanitizeTemplateEntityId(record.templateEntityId);

  const rawTimeout = typeof record.timeoutSeconds === 'number' && Number.isFinite(record.timeoutSeconds)
    ? Math.round(record.timeoutSeconds)
    : DEVICE_SPAWNER_DEFAULT_TIMEOUT_SECONDS;
  const timeoutSeconds = Math.min(
    DEVICE_SPAWNER_MAX_TIMEOUT_SECONDS,
    Math.max(DEVICE_SPAWNER_MIN_TIMEOUT_SECONDS, rawTimeout),
  );
  const templateRules = Array.isArray(record.templateRules)
    ? record.templateRules.slice(0, DEVICE_SPAWNER_MAX_TEMPLATE_RULES).map(sanitizeTemplateRule)
      .filter((rule): rule is DeviceSpawnerTemplateRule => Boolean(rule))
    : [];

  return { spawnerCode, templateEntityId, timeoutSeconds, templateRules };
}
