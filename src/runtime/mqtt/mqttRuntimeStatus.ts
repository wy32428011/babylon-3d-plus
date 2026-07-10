import type { TelemetryConnectionState } from './deviceTelemetry';

export type MqttRuntimeStatusSnapshot = {
  state: TelemetryConnectionState;
  lastError: string | null;
  updatedAt: number;
};

export type MqttRuntimeStatusListener = () => void;

const DISABLED_SNAPSHOT: MqttRuntimeStatusSnapshot = {
  state: 'disabled',
  lastError: null,
  updatedAt: 0,
};

/** 保存全局 MQTT 运行时连接状态，并以不可变快照供 React 订阅读取。 */
class MqttRuntimeStatusStore {
  private snapshot: MqttRuntimeStatusSnapshot = DISABLED_SNAPSHOT;
  private readonly listeners = new Set<MqttRuntimeStatusListener>();

  /** 订阅状态变化，返回取消订阅函数以适配 useSyncExternalStore。 */
  subscribe = (listener: MqttRuntimeStatusListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 返回当前只读快照；调用方不得修改返回对象。 */
  getSnapshot = (): MqttRuntimeStatusSnapshot => this.snapshot;

  /** 更新连接状态；状态与错误内容不变时不更新时间戳也不重复通知。 */
  update(state: TelemetryConnectionState, lastError: string | null = null): void {
    const normalizedError = normalizeError(lastError);
    if (this.snapshot.state === state && this.snapshot.lastError === normalizedError) return;

    this.snapshot = {
      state,
      lastError: normalizedError,
      updatedAt: Date.now(),
    };
    for (const listener of this.listeners) listener();
  }
}

export const mqttRuntimeStatusStore = new MqttRuntimeStatusStore();

/** 将空白错误归一为空值，避免 UI 显示无意义占位。 */
function normalizeError(error: string | null | undefined): string | null {
  const normalizedError = error?.trim();
  return normalizedError ? normalizedError : null;
}
