/** IPC 通常只保留 Error.message，缺失资源仅附加规范 ID，不泄露服务端其他数据。 */
export function formatDigitalTwinPublishErrorMessage(code: string, message: string, data: unknown): string {
  if (code !== 'DIGITAL_TWIN_RESOURCES_NOT_FOUND' || !data || typeof data !== 'object' || Array.isArray(data)) return message;
  const source = data as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, label] of [['missingModels', '普通模型'], ['missingEnvModels', '环境模型'], ['missingComboModels', '组合模型']]) {
    const values = source[key];
    if (!Array.isArray(values)) continue;
    const ids = [...new Set(values.filter((value): value is string => typeof value === 'string' && /^[1-9]\d{0,63}$/.test(value)))];
    if (!ids.length) continue;
    parts.push(`${label} ID：${ids.slice(0, 20).join('、')}${ids.length > 20 ? `（另有 ${ids.length - 20} 个）` : ''}`);
  }
  return parts.length ? `${message}；${parts.join('；')}` : message;
}
