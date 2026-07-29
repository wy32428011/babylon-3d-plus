import type { DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import type { ModelRuntimeEntry } from '../../SceneRuntime';

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
