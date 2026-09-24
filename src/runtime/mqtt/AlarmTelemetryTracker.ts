import { readAlarmProperty } from '../../editor/model/alarmManager';
import { DEFAULT_TELEMETRY_SOURCE_ID, type DeviceTelemetrySnapshot, type DeviceTelemetryStore } from './deviceTelemetry';

export type AlarmTelemetryRequest = { sourceId: string; deviceType: string; assetCode: string; properties: string[] };
type WatchedDevice = {
  request: AlarmTelemetryRequest;
  latest: DeviceTelemetrySnapshot | null;
  values: Map<string, { value: unknown; receivedAt: number }>;
};

const keyOf = (value: Pick<AlarmTelemetryRequest, 'sourceId' | 'deviceType' | 'assetCode'>) =>
  JSON.stringify([value.sourceId.trim() || DEFAULT_TELEMETRY_SOURCE_ID, value.deviceType.toLowerCase(), value.assetCode]);

/** 仅保留当前报警配置订阅的点位；逐消息捕获，避免250ms评估间隔内被其它点位覆盖。 */
export class AlarmTelemetryTracker {
  private static readonly active = new WeakMap<DeviceTelemetryStore, Set<AlarmTelemetryTracker>>();
  private readonly devices = new Map<string, WatchedDevice>();
  private readonly unsubscribe: () => void;

  constructor(private readonly store: DeviceTelemetryStore) {
    const trackers = AlarmTelemetryTracker.active.get(store) ?? new Set();
    trackers.add(this);
    AlarmTelemetryTracker.active.set(store, trackers);
    this.unsubscribe = store.subscribe(snapshot => {
      if (snapshot) {
        const watched = this.devices.get(keyOf(snapshot));
        if (watched) this.capture(watched, snapshot);
      } else {
        // clear/clearSource 是显式清空；只清理已被 Store 移除的数据源，保留其它源。
        for (const watched of this.devices.values()) {
          const { assetCode, deviceType, sourceId } = watched.request;
          if (!store.getSnapshot(assetCode, deviceType, sourceId)) { watched.latest = null; watched.values.clear(); }
        }
      }
    });
  }

  watch(requests: readonly AlarmTelemetryRequest[]): void {
    const next = new Map<string, AlarmTelemetryRequest>();
    for (const request of requests) {
      if (!request.assetCode || !request.deviceType) continue;
      const key = keyOf(request), previous = next.get(key);
      next.set(key, { ...request, properties: [...new Set([...(previous?.properties ?? []), ...request.properties].filter(Boolean))] });
    }
    for (const key of this.devices.keys()) if (!next.has(key)) this.devices.delete(key);
    for (const [key, request] of next) {
      const watched = this.devices.get(key) ?? { request, latest: null, values: new Map() };
      watched.request = request;
      for (const property of watched.values.keys()) if (!request.properties.includes(property)) watched.values.delete(property);
      // 后打开的诊断面板复用正在监控的运行时点位，避免最新帧只含其它点位时显示成缺失。
      for (const other of AlarmTelemetryTracker.active.get(this.store) ?? []) {
        if (other === this) continue;
        const existing = other.devices.get(key);
        if (!existing) continue;
        for (const property of request.properties) {
          const held = existing.values.get(property);
          if (held && !watched.values.has(property)) watched.values.set(property, held);
        }
      }
      this.devices.set(key, watched);
      const snapshot = this.store.getSnapshot(request.assetCode, request.deviceType, request.sourceId);
      if (snapshot) this.capture(watched, snapshot);
    }
  }

  getSnapshot(binding: Pick<AlarmTelemetryRequest, 'sourceId' | 'deviceType' | 'assetCode'>, property?: string): DeviceTelemetrySnapshot | null {
    const watched = this.devices.get(keyOf(binding));
    if (!watched?.latest) return null;
    return { ...watched.latest,
      receivedAt: (property ? watched.values.get(property)?.receivedAt : undefined) ?? watched.latest.receivedAt,
      fields: Object.fromEntries([...watched.values].map(([name, entry]) => [name, entry.value])),
    };
  }

  private capture(watched: WatchedDevice, snapshot: DeviceTelemetrySnapshot): void {
    watched.latest = snapshot;
    for (const property of watched.request.properties) {
      const value = readAlarmProperty(snapshot.fields, property);
      // 缺少p或v表示该点位没有新值；显式null、对象等新值仍覆盖旧值并按无效值诊断。
      if (value !== undefined) watched.values.set(property, { value, receivedAt: snapshot.receivedAt });
    }
  }

  clear(): void { this.devices.clear(); }
  reset(): void { for (const watched of this.devices.values()) { watched.latest = null; watched.values.clear(); } }
  dispose(): void { this.unsubscribe(); this.clear(); AlarmTelemetryTracker.active.get(this.store)?.delete(this); }
}
