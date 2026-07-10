import type { MqttConfig, MqttSubscriptionConfig } from '../../editor/model/SceneDocument';

/** 解析旧包装器使用的订阅列表，非空 subscriptions 必须保持原引用和全部适配器配置。 */
export function resolveMqttStackerSubscriptions(
  config: Pick<MqttConfig, 'subscriptions' | 'topic'>,
): MqttSubscriptionConfig[] {
  if (config.subscriptions.length > 0) return config.subscriptions;

  return splitLegacyMqttTopics(config.topic).map((topic) => ({
    topic,
    qos: 0,
    adapter: { kind: 'epv' },
  }));
}

/** 将逗号分隔 legacy topic 归一为非空 topic 数组。 */
function splitLegacyMqttTopics(topic: string): string[] {
  return topic
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
