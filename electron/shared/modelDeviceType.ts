/** 中台 model_device_type.devType 编码；不从显示名称或遥测驱动枚举推断。 */
export function normalizeModelDeviceType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.trim();
  return /^[a-z0-9_-]{1,64}$/.test(code) ? code : undefined;
}

export function modelDeviceTypeField(value: unknown): { deviceType?: string } {
  const deviceType = normalizeModelDeviceType(value);
  return deviceType ? { deviceType } : {};
}
