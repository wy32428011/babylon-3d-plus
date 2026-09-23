/** 特效仅可读取已登记数据源或最新遥测，场景不能提供 URL、请求头或凭据。 */
export type EffectDataRequest = {
  requestId: string;
  mode: 'data-source' | 'mqtt-latest';
  assetCode: string;
  dataSourceId?: string;
  namespace?: string;
  deviceType?: string;
  timeoutMs: number;
};

function text(value: unknown, max: number, label: string, required = true): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (required && !value.trim())) {
    throw new Error(`${label}必须是${required ? '非空' : ''}字符串，最多 ${max} 个字符。`);
  }
  return value.trim();
}

export function validateEffectDataRequest(value: unknown): EffectDataRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('特效取数请求无效。');
  const object = value as Record<string, unknown>;
  const allowed = ['requestId', 'mode', 'assetCode', 'dataSourceId', 'namespace', 'deviceType', 'timeoutMs'];
  if (Object.keys(object).some(key => !allowed.includes(key))) throw new Error('特效取数请求包含未允许的字段。');
  const requestId = text(object.requestId, 128, '请求标识');
  if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw new Error('请求标识格式无效。');
  if (object.mode !== 'data-source' && object.mode !== 'mqtt-latest') throw new Error('特效数据源类型无效。');
  const timeoutMs = object.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('特效取数超时必须为 100～30000 毫秒。');
  const assetCode = text(object.assetCode, 128, '资产编号', object.mode === 'mqtt-latest');
  if (object.mode === 'data-source') {
    const dataSourceId = text(object.dataSourceId, 64, '数据源 ID');
    if (!/^[1-9]\d{0,63}$/.test(dataSourceId)) throw new Error('数据源 ID 必须为正整数字符串。');
    return { requestId, mode: object.mode, assetCode, dataSourceId, timeoutMs };
  }
  return { requestId, mode: object.mode, assetCode, timeoutMs,
    namespace: text(object.namespace, 64, '存储空间'), deviceType: text(object.deviceType, 64, '设备类型') };
}

export function effectDataEndpoint(request: EffectDataRequest): { path: string; body: unknown } {
  const validated = validateEffectDataRequest(request);
  return validated.mode === 'data-source'
    ? { path: 'api/v1/data-sources/fetch', body: { id: validated.dataSourceId, runParams: { assetCode: validated.assetCode } } }
    : { path: 'api/v1/dataflow/mqtt-storage/detail', body: { namespace: validated.namespace, deviceType: validated.deviceType, deviceNo: validated.assetCode } };
}
