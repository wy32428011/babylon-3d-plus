import type { DeviceSpawnerComponent } from './components';

/** 设备产生器离线超时取值范围（秒）。 */
export const DEVICE_SPAWNER_MIN_TIMEOUT_SECONDS = 1;
export const DEVICE_SPAWNER_MAX_TIMEOUT_SECONDS = 3600;
export const DEVICE_SPAWNER_DEFAULT_TIMEOUT_SECONDS = 30;

const DEVICE_SPAWNER_CODE_MAX_LENGTH = 128;

/** 创建一份默认设备产生器组件。 */
export function createDefaultDeviceSpawner(): DeviceSpawnerComponent {
  return {
    spawnerCode: '',
    templateEntityId: null,
    timeoutSeconds: DEVICE_SPAWNER_DEFAULT_TIMEOUT_SECONDS,
  };
}

/** 清理设备产生器组件；非法结构返回 null，由序列化层决定是否拒绝场景文件。 */
export function sanitizeDeviceSpawnerComponent(value: unknown): DeviceSpawnerComponent | null {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const record = value as Record<string, unknown>;

  const spawnerCode = typeof record.spawnerCode === 'string'
    ? record.spawnerCode.trim().slice(0, DEVICE_SPAWNER_CODE_MAX_LENGTH)
    : '';
  const templateEntityId = typeof record.templateEntityId === 'string' && record.templateEntityId.trim()
    ? record.templateEntityId.trim()
    : null;

  const rawTimeout = typeof record.timeoutSeconds === 'number' && Number.isFinite(record.timeoutSeconds)
    ? Math.round(record.timeoutSeconds)
    : DEVICE_SPAWNER_DEFAULT_TIMEOUT_SECONDS;
  const timeoutSeconds = Math.min(
    DEVICE_SPAWNER_MAX_TIMEOUT_SECONDS,
    Math.max(DEVICE_SPAWNER_MIN_TIMEOUT_SECONDS, rawTimeout),
  );

  return { spawnerCode, templateEntityId, timeoutSeconds };
}
