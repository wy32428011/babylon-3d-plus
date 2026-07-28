/** 运行时通用值工具：JSON 形态守卫、路径读取与命名压缩。 */

/** 判断值是否为普通对象，用于安全处理模型脚本 JSON 元数据。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** 按路径读取字符串数组，保证外置模型脚本配置只以安全 JSON 形态参与节点选择。 */
export function readStringArrayPath(source: unknown, path: string[]): string[] {
  let current: unknown = source;
  for (const key of path) {
    if (!isPlainRecord(current)) return [];
    current = current[key];
  }

  if (!Array.isArray(current)) return [];
  return current.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

/** 把外部名称压缩成 Babylon 对象名可读片段。 */
export function sanitizeBabylonName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'layer';
}
