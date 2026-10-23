export type BrowserMqttModule = Pick<typeof import('mqtt'), 'connect'>;
export type MqttModuleLoader = () => Promise<BrowserMqttModule>;

/** 共用浏览器模块下载；失败后清空缓存，使下一次连接能够重试。 */
export function createBrowserMqttLoader(
  importModule: () => Promise<unknown> = () => import('mqtt'),
): MqttModuleLoader {
  let pendingModule: Promise<BrowserMqttModule> | null = null;
  return () => {
    if (!pendingModule) {
      pendingModule = Promise.resolve().then(importModule).then(resolveBrowserMqttModule).catch((error: unknown) => {
        pendingModule = null;
        throw error;
      });
    }
    return pendingModule;
  };
}

/** 浏览器发布包只提供 default，Node/测试可能提供命名导出；保留真实 API 对象。 */
function resolveBrowserMqttModule(namespace: unknown): BrowserMqttModule {
  if (hasMqttConnect(namespace)) return namespace;
  const fallback = namespace !== null && (typeof namespace === 'object' || typeof namespace === 'function')
    ? (namespace as { default?: unknown }).default
    : undefined;
  if (hasMqttConnect(fallback)) return fallback;
  throw new Error('MQTT 模块缺少可调用的 connect 导出。');
}

function hasMqttConnect(value: unknown): value is BrowserMqttModule {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    && 'connect' in value && typeof value.connect === 'function';
}

/** 仅在浏览器实际需要 MQTT 网络连接时调用，Electron IPC 与模拟器不触发下载。 */
export const loadBrowserMqtt = createBrowserMqttLoader();
