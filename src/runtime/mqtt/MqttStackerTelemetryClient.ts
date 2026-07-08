import mqtt, { type MqttClient } from 'mqtt';
import type { MqttConfig } from '../../editor/model/SceneDocument';
import {
  deviceTelemetryStore,
  parseDeviceTelemetryMessage,
} from './deviceTelemetry';
import { StackerTelemetrySimulator } from './StackerTelemetrySimulator';

type MqttTelemetryLog = (message: string) => void;

/** 管理场景级 MQTT 连接，并把多设备遥测写入内存快照。 */
export class MqttStackerTelemetryClient {
  private client: MqttClient | null = null;
  private configSignature = '';
  private lastParseErrorAt = 0;
  private readonly simulator: StackerTelemetrySimulator;

  constructor(private readonly pushLog: MqttTelemetryLog) {
    this.simulator = new StackerTelemetrySimulator(pushLog);
  }

  /** 根据最新场景配置连接、重连或断开 MQTT。 */
  updateConfig(config: MqttConfig): void {
    const signature = JSON.stringify({
      enabled: config.enabled,
      address: config.address,
      topic: config.topic,
      simulatorEnabled: config.simulatorEnabled,
      simulatorAssetCode: config.simulatorAssetCode,
      simulatorScenario: config.simulatorScenario,
      simulatorIntervalMs: config.simulatorIntervalMs,
    });
    if (signature === this.configSignature) return;

    this.configSignature = signature;
    this.disconnect(true);
    this.simulator.updateConfig(config);

    if (!config.enabled) {
      deviceTelemetryStore.clear();
      return;
    }

    if (config.simulatorEnabled) {
      this.pushLog('MQTT 连接已跳过：当前使用 Stacker 本地模拟数据。');
      return;
    }

    if (!config.address || !config.topic) {
      this.pushLog('MQTT 未连接：地址或 Topic 为空。');
      deviceTelemetryStore.clear();
      return;
    }

    if (!/^wss?:\/\//i.test(config.address)) {
      this.pushLog('MQTT 未连接：浏览器运行时仅支持 ws:// 或 wss:// 地址。');
      deviceTelemetryStore.clear();
      return;
    }

    this.connect(config);
  }

  /** 关闭当前 MQTT 连接并清理订阅。 */
  dispose(): void {
    this.configSignature = '';
    this.simulator.dispose();
    this.disconnect(true);
    deviceTelemetryStore.clear();
  }

  /** 建立 MQTT over WebSocket 连接并订阅一个或多个设备遥测 topic。 */
  private connect(config: MqttConfig): void {
    const topics = splitMqttTopics(config.topic);
    const client = mqtt.connect(config.address, {
      clean: true,
      clientId: `babylon-editor-${crypto.randomUUID()}`,
      connectTimeout: 8000,
      reconnectPeriod: 3000,
    });
    this.client = client;

    client.on('connect', () => {
      client.subscribe(topics, { qos: 0 }, (error) => {
        if (error) {
          this.pushLog(`MQTT 订阅失败：${error.message}`);
          return;
        }

        this.pushLog(`MQTT 已连接并订阅：${topics.join(', ')}`);
      });
    });

    client.on('message', (topic, payload) => {
      try {
        const snapshot = parseDeviceTelemetryMessage(topic, payload.toString('utf8'));
        if (!snapshot) return;
        deviceTelemetryStore.upsert(snapshot);
      } catch (error) {
        this.reportParseError(error);
      }
    });

    client.on('error', (error) => {
      this.pushLog(`MQTT 连接错误：${error.message}`);
    });

    client.on('close', () => {
      this.pushLog('MQTT 连接已关闭。');
    });
  }

  /** 断开旧连接，避免配置切换后残留订阅继续写入遥测。 */
  private disconnect(clearStore: boolean): void {
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
    if (clearStore) {
      deviceTelemetryStore.clear();
    }
  }

  /** 解析错误做节流记录，避免异常消息刷爆 Console。 */
  private reportParseError(error: unknown): void {
    const now = Date.now();
    if (now - this.lastParseErrorAt < 3000) return;
    this.lastParseErrorAt = now;
    const message = error instanceof Error ? error.message : String(error);
    this.pushLog(`MQTT 设备遥测解析失败：${message}`);
  }
}

/** 将逗号分隔 topic 归一为 mqtt.js 可订阅数组。 */
function splitMqttTopics(topic: string): string[] {
  return topic
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
