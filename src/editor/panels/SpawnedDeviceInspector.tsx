import type { SpawnedDeviceInspectorSnapshot } from '../../runtime/mqtt/spawnedDeviceInspectorStore';
import { resolveModelTelemetryDataDrivenConfig } from '../model/telemetryBinding';
import { TelemetryBindingInspector } from './TelemetryBindingInspector';

/** 动态设备只读检查器：配置来自产生器模板，实时数据按合成实体 ID 隔离。 */
export function SpawnedDeviceInspector({ instance }: { instance: SpawnedDeviceInspectorSnapshot }) {
  const modelAsset = instance.entity.components.modelAsset;
  if (!modelAsset) return null;
  const dataDrivenConfig = resolveModelTelemetryDataDrivenConfig(modelAsset);

  return (
    <section className="panel inspector-panel inspector-panel-compact-model" data-testid="spawned-device-inspector">
      <h2>动态 AGV 实例</h2>
      <fieldset className="transform-fieldset">
        <legend>实例信息</legend>
        <p className="muted">名称：{instance.entity.name}</p>
        <p className="muted">设备号：{modelAsset.assetCode}</p>
        <p className="muted">来源产生器：{instance.spawnerName}</p>
        <p className="muted">配置继承自关联模板；运行预览中只读，实例不会写入场景文件。</p>
      </fieldset>
      <TelemetryBindingInspector
        entityId={instance.entityId}
        binding={instance.entity.components.telemetryBinding}
        dataDrivenConfig={dataDrivenConfig}
        disabled
        modelAssetCode={modelAsset.assetCode}
        onChange={() => undefined}
        onRestoreDefault={() => undefined}
      />
    </section>
  );
}
