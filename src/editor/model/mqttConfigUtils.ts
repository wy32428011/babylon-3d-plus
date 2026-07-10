import type { MqttConfig } from './SceneDocument';

export type RuntimePreviewReadiness =
  | { ok: true; source: 'simulator' | 'mqtt' }
  | {
      ok: false;
      code:
        | 'mqtt-disabled'
        | 'cad-import-active'
        | 'missing-address'
        | 'missing-subscription'
        | 'unsupported-browser-protocol'
        | 'unsupported-electron-protocol';
      message: string;
    };

/** 判断 MQTT 订阅是否存在可用于运行预览的有效 Topic。 */
function hasValidRuntimeSubscription(config: MqttConfig): boolean {
  return config.subscriptions.some((subscription) => subscription.topic.trim().length > 0);
}

/** 判断当前运行环境是否允许使用指定 MQTT 地址协议。 */
function isRuntimeAddressProtocolAllowed(address: string, electronMqttAvailable: boolean): boolean {
  try {
    const protocol = new URL(address).protocol.replace(':', '').toLowerCase();
    const allowedProtocols = electronMqttAvailable ? ['mqtt', 'mqtts', 'ws', 'wss'] : ['ws', 'wss'];
    return allowedProtocols.includes(protocol);
  } catch {
    return false;
  }
}

/** 校验进入运行预览前 MQTT/模拟器配置是否满足最低运行条件。 */
export function validateRuntimePreviewConfig(
  config: MqttConfig,
  options: { electronMqttAvailable: boolean },
): RuntimePreviewReadiness {
  if (!config.enabled) {
    return { ok: false, code: 'mqtt-disabled', message: 'MQTT 未启用，无法进入运行预览。' };
  }

  if (config.simulatorEnabled) {
    return { ok: true, source: 'simulator' };
  }

  const address = config.address.trim();
  if (!address) {
    return { ok: false, code: 'missing-address', message: '真实 MQTT 运行预览需要填写 Broker 地址。' };
  }

  if (!hasValidRuntimeSubscription(config)) {
    return { ok: false, code: 'missing-subscription', message: '真实 MQTT 运行预览至少需要一个有效订阅 Topic。' };
  }

  if (!isRuntimeAddressProtocolAllowed(address, options.electronMqttAvailable)) {
    return options.electronMqttAvailable
      ? { ok: false, code: 'unsupported-electron-protocol', message: 'Electron MQTT 地址协议需为 mqtt/mqtts/ws/wss。' }
      : { ok: false, code: 'unsupported-browser-protocol', message: '浏览器运行预览仅支持 ws/wss MQTT 地址。' };
  }

  return { ok: true, source: 'mqtt' };
}

/** 使用稳定 JSON 字符串比较 MQTT 订阅，确保 qos/adapter/fields 变化不会被漏判。 */
function stringifySubscription(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** 比较 MQTT 配置是否等价，包含 subscriptions 的深比较。 */
export function isMqttConfigEqual(left: MqttConfig, right: MqttConfig): boolean {
  return (
    left.enabled === right.enabled &&
    left.ip === right.ip &&
    left.address === right.address &&
    left.topic === right.topic &&
    left.simulatorEnabled === right.simulatorEnabled &&
    left.simulatorAssetCode === right.simulatorAssetCode &&
    left.simulatorScenario === right.simulatorScenario &&
    left.simulatorIntervalMs === right.simulatorIntervalMs &&
    stringifySubscription(left.subscriptions) === stringifySubscription(right.subscriptions)
  );
}

/** 删除订阅后重建以数字索引为 key 的草稿/错误记录，避免删除项残留阻塞保存。 */
export function reindexRecordAfterRemoval<T>(record: Record<number, T>, removedIndex: number): Record<number, T> {
  const next: Record<number, T> = {};
  for (const [key, value] of Object.entries(record)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index === removedIndex) continue;
    next[index > removedIndex ? index - 1 : index] = value;
  }
  return next;
}
