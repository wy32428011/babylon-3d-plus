import { ipcMain } from 'electron';
import { readDataPlatformConfig, isDataPlatformProjectClosing } from './dataPlatformIpc.js';
import { requestDataPlatformJson } from './dataPlatformTransfer.js';
import { effectDataEndpoint, validateEffectDataRequest } from '../shared/effectDataContract.js';

let registered = false;
const active = new Map<string, AbortController>();

/** 主进程地址来自当前中台配置，只允许固定的两个只读接口。 */
export function registerEffectDataIpc(): void {
  if (registered) return;
  registered = true;
  ipcMain.handle('effect-data:fetch', async (event, input: unknown): Promise<unknown> => {
    if (isDataPlatformProjectClosing()) throw new Error('项目正在关闭，已停止特效取数。');
    const request = validateEffectDataRequest(input);
    const prefix = `${event.sender.id}:`, key = prefix + request.requestId;
    if (active.has(key)) throw new Error('特效取数请求标识重复。');
    if (active.size >= 32 || [...active.keys()].filter(value => value.startsWith(prefix)).length >= 8) throw new Error('特效取数请求并发超过上限。');
    const controller = new AbortController(); active.set(key, controller);
    const cancel = () => controller.abort(); event.sender.once('destroyed', cancel);
    try {
      const config = await readDataPlatformConfig();
      if (!config.baseUrl) throw new Error('请先配置数据中台地址。');
      const { path, body } = effectDataEndpoint(request);
      return await requestDataPlatformJson({ baseUrl: config.baseUrl, endpointPath: path, body,
        signal: controller.signal, timeoutMs: request.timeoutMs, context: '特效取数' });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('特效取数已取消。');
      const message = error instanceof Error ? error.message : '';
      // 不把网络库的 URL、查询参数或远端正文透传到 renderer。
      const businessCode = /\b(?:DATA_FLOW_MQTT_DATA_[A-Z_]+|DATA_SOURCE_[A-Z_]+)\b/.exec(message)?.[0];
      if (businessCode) return { success: false, code: businessCode };
      throw new Error(message.includes('超时') ? '特效取数超时，请稍后重试。' : '特效取数失败，请检查中台地址、数据源和设备身份。');
    } finally { active.delete(key); if (!event.sender.isDestroyed()) event.sender.removeListener('destroyed', cancel); }
  });
  ipcMain.handle('effect-data:cancel', (event, requestId: unknown): boolean => {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) return false;
    const controller = active.get(`${event.sender.id}:${requestId}`);
    controller?.abort(); return !!controller;
  });
}
