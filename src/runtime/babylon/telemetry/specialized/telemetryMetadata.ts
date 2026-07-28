import type { DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import type { ModelRuntimeEntry } from '../../SceneRuntime';
import { readStringField } from '../../../mqtt/deviceTelemetry';

/** 读取托盘条码，空字符串表示当前叉没有可视化货物。 */
export function readContainerCode(snapshot: DeviceTelemetrySnapshot, key: string): string | null {
  const value = readStringField(snapshot.fields, key)?.trim();
  return value ? value : null;
}

/** 写入通用设备 telemetry metadata，供脚本、调试面板和现场排查读取。 */
export function writeDeviceTelemetryMetadata(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot): void {
  const telemetryMetadata = {
    deviceType: snapshot.deviceType,
    assetCode: snapshot.assetCode,
    payloadDeviceCode: snapshot.payloadDeviceCode,
    sourceTimestamp: snapshot.sourceTimestamp,
    receivedAt: snapshot.receivedAt,
    faulted: snapshot.faulted,
    message: snapshot.message,
    fields: { ...snapshot.fields },
  };

  model.root.metadata = {
    ...(model.root.metadata ?? {}),
    telemetry: telemetryMetadata,
  };
  model.contentRoot.metadata = {
    ...(model.contentRoot.metadata ?? {}),
    telemetry: telemetryMetadata,
  };
}
