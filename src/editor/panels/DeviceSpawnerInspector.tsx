import { useEditorStore } from '../store/editorStore';
import type { DeviceSpawnerComponent } from '../model/components';
import {
  DEVICE_SPAWNER_MAX_TIMEOUT_SECONDS,
  DEVICE_SPAWNER_MIN_TIMEOUT_SECONDS,
} from '../model/deviceSpawner';
import { SearchableSelect } from '../ui/SearchableSelect';

type DeviceSpawnerInspectorProps = {
  component: DeviceSpawnerComponent;
  disabled?: boolean;
};

/** 渲染并编辑设备产生器配置：产生器 id、模板实体与离线超时。 */
export function DeviceSpawnerInspector({ component, disabled = false }: DeviceSpawnerInspectorProps) {
  const updateSelectedDeviceSpawner = useEditorStore((state) => state.updateSelectedDeviceSpawner);
  const scene = useEditorStore((state) => state.scene);

  const templateOptions = scene.entityIds
    .map((entityId) => scene.entities[entityId])
    .filter((entity) => entity?.components.modelAsset)
    .map((entity) => ({ value: entity!.id, label: entity!.name }));
  const templateMissing = Boolean(
    component.templateEntityId && !templateOptions.some((option) => option.value === component.templateEntityId),
  );

  /** 提交完整不可变组件，由 Store 统一校验并写入撤销历史。 */
  function commitComponent(patch: Partial<DeviceSpawnerComponent>, label: string): void {
    if (disabled) return;
    updateSelectedDeviceSpawner({ ...component, ...patch }, label);
  }

  return (
    <fieldset className="transform-fieldset">
      <legend>设备产生器</legend>
      <label className="inspector-row">
        <span>产生器ID</span>
        <input
          type="text"
          disabled={disabled}
          value={component.spawnerCode}
          onChange={(event) => commitComponent({ spawnerCode: event.target.value }, '更新设备产生器')}
        />
      </label>
      <label className="inspector-row">
        <span>模板实体</span>
        <SearchableSelect
          disabled={disabled}
          missingLabel={(value) => `已删除实体（${value}）`}
          options={[{ value: '__none__', label: '未绑定' }, ...templateOptions]}
          value={component.templateEntityId || '__none__'}
          onChange={(value) => commitComponent({ templateEntityId: value !== '__none__' ? value : null }, '更新设备产生器模板')}
        />
      </label>
      <label className="number-row">
        <span>离线超时(秒)</span>
        <input
          type="number"
          disabled={disabled}
          min={DEVICE_SPAWNER_MIN_TIMEOUT_SECONDS}
          max={DEVICE_SPAWNER_MAX_TIMEOUT_SECONDS}
          step="1"
          value={component.timeoutSeconds}
          onChange={(event) => commitComponent({ timeoutSeconds: Number(event.target.value) }, '更新设备产生器超时')}
        />
      </label>
      {templateMissing ? <p className="telemetry-runtime-error">绑定的模板实体已被删除，运行时该产生器不生效。</p> : null}
      <p className="muted">
        运行预览时收到携带产生器ID的 dataspawn 消息即克隆模板生成设备实例（assetCode 取消息 e 字段）；
        超过离线时间无消息或收到 p=status、v=offline 消息时销毁实例。
      </p>
    </fieldset>
  );
}
