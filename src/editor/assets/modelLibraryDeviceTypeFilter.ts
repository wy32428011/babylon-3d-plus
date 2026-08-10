function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function getScriptDeviceType(script: unknown): string | null {
  if (!isRecord(script)) return null;

  if (isRecord(script.values)) {
    const deviceType = script.values.deviceType;
    if (isRecord(deviceType)) {
      const currentValue = readNonEmptyString(deviceType.value);
      if (currentValue) return currentValue;
    }
  }

  if (!Array.isArray(script.fields)) return null;
  for (const field of script.fields) {
    if (!isRecord(field) || field.key !== 'deviceType') continue;
    const defaultValue = readNonEmptyString(field.defaultValue);
    if (defaultValue) return defaultValue;
  }

  return null;
}

/** 从模型包参数脚本元数据中读取第一个有效设备类型。 */
export function getModelDeviceType(asset: unknown): string | null {
  if (!isRecord(asset) || !Array.isArray(asset.parameterScriptMetadata)) return null;

  for (const script of asset.parameterScriptMetadata) {
    const deviceType = getScriptDeviceType(script);
    if (deviceType) return deviceType;
  }

  return null;
}

/** 生成模型库设备类型选项，空值不进入下拉框。 */
export function createModelDeviceTypeOptions(assets: readonly unknown[]): string[] {
  const deviceTypes = new Set<string>();
  for (const asset of assets) {
    const deviceType = getModelDeviceType(asset);
    if (deviceType) deviceTypes.add(deviceType);
  }

  return [...deviceTypes].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
}

/** “全部类型”匹配所有卡片；具体类型只匹配声明了相同类型的模型资产。 */
export function matchesModelDeviceType(item: unknown, selectedDeviceType: string): boolean {
  const normalizedSelection = selectedDeviceType.trim();
  if (!normalizedSelection) return true;
  if (!isRecord(item) || !isRecord(item.asset) || item.asset.kind !== 'model') return false;

  return getModelDeviceType(item.asset) === normalizedSelection;
}
