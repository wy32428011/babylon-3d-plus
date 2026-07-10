import type { MqttConfig } from '../../editor/model/SceneDocument';
import { ElectronMqttTelemetryClient, hasElectronMqttApi } from './ElectronMqttTelemetryClient';
import { MqttTelemetryClient, type MqttTelemetryLog } from './MqttTelemetryClient';
import { deviceTelemetryStore } from './deviceTelemetry';
import { GenericTelemetrySimulator } from './GenericTelemetrySimulator';
import { resolveMqttStackerSubscriptions } from './MqttStackerTelemetryConfig';
import { mqttRuntimeStatusStore } from './mqttRuntimeStatus';
import { StackerTelemetrySimulator } from './StackerTelemetrySimulator';

/** 兼容旧场景配置的 Stacker MQTT 客户端薄包装，内部委托通用遥测客户端。 */
export class MqttStackerTelemetryClient {
  private configSignature = '';
  private readonly telemetryClient: MqttTelemetryClient;
  private electronTelemetryClient: ElectronMqttTelemetryClient | null = null;
  private readonly simulator: StackerTelemetrySimulator;
  private readonly genericSimulator: GenericTelemetrySimulator;

  constructor(private readonly pushLog: MqttTelemetryLog) {
    this.telemetryClient = new MqttTelemetryClient(pushLog, deviceTelemetryStore);
    this.simulator = new StackerTelemetrySimulator(pushLog);
    this.genericSimulator = new GenericTelemetrySimulator(pushLog);
  }

  /** 根据旧版场景 MQTT 配置连接、重连、断开或启动本地 Stacker 模拟。 */
  updateConfig(config: MqttConfig): void {
    const signature = JSON.stringify({
      enabled: config.enabled,
      address: config.address,
      topic: config.topic,
      subscriptions: config.subscriptions,
      simulatorEnabled: config.simulatorEnabled,
      simulatorAssetCode: config.simulatorAssetCode,
      simulatorScenario: config.simulatorScenario,
      simulatorIntervalMs: config.simulatorIntervalMs,
    });
    if (signature === this.configSignature) return;

    this.configSignature = signature;
    this.telemetryClient.dispose();
    this.electronTelemetryClient?.dispose();
    this.electronTelemetryClient = null;
    if (config.simulatorScenario === 'generic') {
      this.simulator.dispose();
      this.genericSimulator.updateConfig(config);
    } else {
      this.genericSimulator.dispose();
      this.simulator.updateConfig(config);
    }

    if (!config.enabled) {
      mqttRuntimeStatusStore.update('disabled');
      deviceTelemetryStore.clear();
      return;
    }

    if (config.simulatorEnabled) {
      mqttRuntimeStatusStore.update('simulating');
      this.pushLog(`MQTT 连接已跳过：当前使用${config.simulatorScenario === 'generic' ? '通用设备' : ' Stacker'}本地模拟数据。`);
      return;
    }

    const subscriptions = resolveMqttStackerSubscriptions(config);
    if (hasElectronMqttApi()) {
      this.electronTelemetryClient = new ElectronMqttTelemetryClient(this.pushLog, deviceTelemetryStore);
      this.electronTelemetryClient.updateConfig({
        enabled: config.enabled,
        address: config.address,
        subscriptions,
      });
      return;
    }

    this.telemetryClient.updateConfig({
      enabled: config.enabled,
      address: config.address,
      subscriptions,
    });
  }

  /** 关闭当前 MQTT 连接、模拟器和运行时快照。 */
  dispose(): void {
    this.configSignature = '';
    this.simulator.dispose();
    this.genericSimulator.dispose();
    this.electronTelemetryClient?.dispose();
    this.electronTelemetryClient = null;
    this.telemetryClient.dispose();
    mqttRuntimeStatusStore.update('disabled');
    deviceTelemetryStore.clear();
  }
}
