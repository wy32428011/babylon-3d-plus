import { useSyncExternalStore } from 'react';
import type { ModelDataDrivenConfig, TelemetryBindingComponent } from '../model/telemetryBinding';
import {
  createDefaultTelemetryBinding,
  normalizeTelemetryBindingComponent,
} from '../model/telemetryBinding';
import { deviceTelemetryStore } from '../../runtime/mqtt/deviceTelemetry';
import { telemetryRuntimeDiagnosticsStore, type TelemetryRuntimeDiagnosticSnapshot } from '../../runtime/mqtt/telemetryRuntimeDiagnostics';
import { useEditorStore } from '../store/editorStore';

type Props = {
  entityId: string;
  binding: TelemetryBindingComponent | undefined;
  dataDrivenConfig: ModelDataDrivenConfig | null;
  disabled: boolean;
  modelAssetCode: string;
  onChange: (binding: TelemetryBindingComponent | null) => void;
  onRestoreDefault: () => void;
};

/** 克隆绑定，避免 Inspector 表单直接修改 Zustand 状态引用。 */
function cloneBinding(binding: TelemetryBindingComponent): TelemetryBindingComponent {
  return JSON.parse(JSON.stringify(binding)) as TelemetryBindingComponent;
}

/** 摘要渲染用的宽松对象守卫，不要求原型纯净。 */
function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把单条 specialized motion 配置压成一行只读摘要：数值平铺，短数组列内容，长数组只报数量。 */
function formatSpecializedMotionEntry(config: unknown): string {
  if (!isPlainObjectLike(config)) return '—';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    // 兜底正则信息量低且长，摘要不展示
    if (key === 'fallbackPattern') continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      parts.push(`${key} ${value}`);
    } else if (typeof value === 'string' && value.length > 0) {
      parts.push(`${key} ${value}`);
    } else if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
      if (items.length === 0) continue;
      parts.push(items.length <= 4 ? `${key} [${items.join(', ')}]` : `${key} ${items.length} 项`);
    } else if (isPlainObjectLike(value) && ('min' in value || 'max' in value)) {
      parts.push(`${key} ${String(value.min ?? '-∞')}~${String(value.max ?? '+∞')}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** specialized 模型的 dataDriven 只读摘要：配置真源在模型包 .model.ts，Inspector 不提供编辑。 */
function SpecializedMotionSummary(props: { config: ModelDataDrivenConfig | null }) {
  const motion = props.config?.specializedMotion ?? {};
  const device = props.config?.device;
  const deviceParts: string[] = [];
  if (typeof device?.calibrationRate === 'number') deviceParts.push(`calibrationRate ${device.calibrationRate}`);
  if (typeof device?.rpmToMetersPerSecond === 'number') deviceParts.push(`rpmToMetersPerSecond ${device.rpmToMetersPerSecond}`);
  const motionEntries = Object.entries(motion);

  return (
    <div className="telemetry-specialized-summary">
      <p className="muted">
        专用 {device?.devType ?? ''} 驱动接管：通道映射由模型包 dataDriven 声明，此处只读；修改请编辑模型包 .model.ts。
      </p>
      {motionEntries.map(([key, value]) => (
        <p className="muted" key={key}>{key}：{formatSpecializedMotionEntry(value)}</p>
      ))}
      {deviceParts.length > 0 ? <p className="muted">device：{deviceParts.join(' · ')}</p> : null}
    </div>
  );
}

/** 货箱生成器绑定：独立于遥测绑定入口，所有模型都可选择货箱模板来源。 */
export function CargoGeneratorInspector(props: {
  binding: TelemetryBindingComponent | undefined;
  modelDevType: string | undefined;
  disabled: boolean;
  onChange: (binding: TelemetryBindingComponent | null) => void;
}) {
  const scene = useEditorStore((state) => state.scene);
  const generatorOptions = scene.entityIds
    .map((entityId) => scene.entities[entityId])
    .filter((entity) => entity?.components.modelGenerator)
    .map((entity) => ({ id: entity!.id, name: entity!.name }));
  const cargoGeneratorMissing = Boolean(
    props.binding?.cargoGeneratorId && !generatorOptions.some((option) => option.id === props.binding?.cargoGeneratorId),
  );

  /** 无遥测绑定的模型直接创建默认绑定再写入 cargoGeneratorId。 */
  function handleGeneratorChange(generatorId: string | undefined): void {
    const merged = cloneBinding(props.binding ?? createDefaultTelemetryBinding(props.modelDevType ?? 'device'));
    if (generatorId) merged.cargoGeneratorId = generatorId;
    else delete merged.cargoGeneratorId;
    const next = normalizeTelemetryBindingComponent(merged);
    if (next) props.onChange(next);
  }

  return (
    <fieldset className="transform-fieldset">
      <legend>货箱生成器</legend>
      <label className="inspector-row">
        <span>模板来源</span>
        <select
          disabled={props.disabled}
          value={props.binding?.cargoGeneratorId || '__none__'}
          onChange={(event) => handleGeneratorChange(event.target.value !== '__none__' ? event.target.value : undefined)}
        >
          <option value="__none__">未绑定（内置立方体）</option>
          {generatorOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>
      </label>
      {cargoGeneratorMissing ? <p className="telemetry-runtime-error">绑定的模型生成器已被删除，运行时将回退内置立方体。</p> : null}
      <p className="muted">堆垛机/输送线/RGV 取放货时按所选模型生成器渲染货箱。</p>
    </fieldset>
  );
}

/** 格式化运行时毫秒时间戳，缺失时展示占位符。 */
function formatTimestamp(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Date(value).toLocaleString();
}

/** 将标准化字段压缩为只读 JSON 文本，避免 Inspector 写回文档状态。 */
function formatFields(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields);
  return keys.length === 0 ? '—' : JSON.stringify(fields, null, 2);
}

/** 根据诊断布尔值生成用户可读状态。 */
function formatDiagnosticStatus(diagnostic: TelemetryRuntimeDiagnosticSnapshot | null): string {
  if (!diagnostic) return '等待运行时';
  if (diagnostic.conflict) return '绑定冲突';
  if (diagnostic.stale) return '断流 / stale';
  if (diagnostic.faulted) return '故障';
  if (diagnostic.online) return '在线';
  return '离线';
}

/** 订阅运行时诊断和设备遥测，显示最新只读闭环状态。 */
function TelemetryRuntimeDiagnosticsView(props: Pick<Props, 'entityId' | 'binding' | 'modelAssetCode'>) {
  const effectiveAssetCode = props.binding?.assetCode ?? props.modelAssetCode;
  const diagnostic = useSyncExternalStore(
    telemetryRuntimeDiagnosticsStore.subscribe.bind(telemetryRuntimeDiagnosticsStore),
    () => telemetryRuntimeDiagnosticsStore.getSnapshot(props.entityId),
    () => telemetryRuntimeDiagnosticsStore.getSnapshot(props.entityId),
  );
  const deviceSnapshot = useSyncExternalStore(
    deviceTelemetryStore.subscribe.bind(deviceTelemetryStore),
    () => (props.binding ? deviceTelemetryStore.getSnapshot(effectiveAssetCode, props.binding.deviceType, props.binding.sourceId) : null),
    () => null,
  );
  const diagnosticFields = diagnostic?.fields ?? {};
  const fields = Object.keys(diagnosticFields).length > 0 ? diagnosticFields : deviceSnapshot?.fields ?? {};
  const errors = diagnostic?.errors ?? [];

  return (
    <div className="telemetry-runtime-diagnostics">
      <strong>运行时诊断</strong>
      <p className="muted">状态：{formatDiagnosticStatus(diagnostic)}</p>
      <p className="muted">sourceId：{diagnostic?.sourceId ?? props.binding?.sourceId ?? '—'} / deviceType：{diagnostic?.deviceType ?? props.binding?.deviceType ?? '—'} / assetCode：{diagnostic?.assetCode ?? effectiveAssetCode ?? '—'}</p>
      <p className="muted">最后接收：{formatTimestamp(diagnostic?.lastReceivedAt ?? deviceSnapshot?.receivedAt)}</p>
      <p className="muted">topic：{diagnostic?.topic ?? deviceSnapshot?.topic ?? '—'}</p>
      <p className="muted">sequence：{diagnostic?.sequence ?? deviceSnapshot?.sequence ?? '—'} / sourceTimestamp：{formatTimestamp(diagnostic?.sourceTimestamp ?? deviceSnapshot?.sourceTimestamp)}</p>
      <div className="telemetry-runtime-fields-wrap"><span>标准化 fields</span><pre className="telemetry-runtime-fields">{formatFields(fields)}</pre></div>
      {(diagnostic?.message || deviceSnapshot?.message) ? <p className="muted">设备 message：{diagnostic?.message || deviceSnapshot?.message}</p> : null}
      {diagnostic?.conflict ? <p className="telemetry-runtime-error">重复绑定冲突：同一 sourceId/deviceType/assetCode 命中多个模型，运行时已停止驱动。</p> : null}
      {errors.length > 0 ? <p className="telemetry-runtime-error">映射错误：{errors.join('；')}</p> : null}
    </div>
  );
}

/** RGV 列绑定编辑：协议列号(front_y/back_y) → 场景实体，运行时把实体位姿投影到车体行走轴。 */
function RgvColumnBindingsEditor(props: {
  entityId: string;
  binding: TelemetryBindingComponent;
  disabled: boolean;
  commit: (patch: Partial<TelemetryBindingComponent>) => void;
}) {
  const scene = useEditorStore((state) => state.scene);
  const entityOptions = scene.entityIds
    .filter((entityId) => {
      if (entityId === props.entityId) return false;
      const entity = scene.entities[entityId];
      return entity?.components.telemetryBinding?.deviceType === 'conveyor';
    })
    .map((entityId) => ({ id: entityId, name: scene.entities[entityId]?.name ?? entityId }));
  const entries = Object.entries(props.binding.columnBindings ?? {})
    .map(([column, targetId]) => ({ column: Number(column), targetId }))
    .filter((entry) => Number.isInteger(entry.column) && entry.column > 0)
    .sort((a, b) => a.column - b.column);
  const hasMissingTarget = entries.some((entry) => !entityOptions.some((option) => option.id === entry.targetId));

  /** 以完整表提交，统一走 normalize 丢弃非法行；空表按删除字段处理。 */
  function commitEntries(next: { column: number; targetId: string }[]): void {
    const columnBindings: Record<string, string> = {};
    for (const entry of next) {
      if (!Number.isInteger(entry.column) || entry.column <= 0 || !entry.targetId) continue;
      columnBindings[String(entry.column)] = entry.targetId;
    }
    props.commit({ columnBindings: Object.keys(columnBindings).length > 0 ? columnBindings : undefined });
  }

  function handleColumnChange(index: number, column: number): void {
    if (!Number.isInteger(column) || column <= 0) return;
    if (entries.some((entry, other) => other !== index && entry.column === column)) return;
    commitEntries(entries.map((entry, other) => (other === index ? { ...entry, column } : entry)));
  }

  function handleTargetChange(index: number, targetId: string): void {
    commitEntries(entries.map((entry, other) => (other === index ? { ...entry, targetId } : entry)));
  }

  function handleRemove(index: number): void {
    commitEntries(entries.filter((_, other) => other !== index));
  }

  function handleAdd(): void {
    const firstOption = entityOptions[0];
    if (!firstOption) return;
    let column = 1;
    while (entries.some((entry) => entry.column === column)) column += 1;
    commitEntries([...entries, { column, targetId: firstOption.id }]);
  }

  return (
    <div className="rgv-column-bindings">
      <p className="muted">协议列号(front_y/back_y) → 场景实体，运行时把实体位姿投影到 RGV 行走轴并作为货箱交接点。</p>

      <div className="model-generator-section-header">
        <span>列绑定</span>
        <button
          disabled={props.disabled || entityOptions.length === 0}
          onClick={handleAdd}
          title="添加列绑定"
          type="button"
        >
          +
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="muted model-generator-empty-hint">暂无列绑定，点击 + 添加。</p>
      ) : null}

      {entries.map((entry, index) => {
        const missing = !entityOptions.some((option) => option.id === entry.targetId);
        return (
          <div className="model-generator-rule-card" key={entry.column}>
            <div className="model-generator-card-header">
              <span>列 {entry.column}</span>
              <span className="model-generator-inline-actions">
                <button disabled={props.disabled} onClick={() => handleRemove(index)} title="删除列绑定" type="button">−</button>
              </span>
            </div>
            <label className="inspector-row">
              <span>列号</span>
              <input
                type="number"
                min="1"
                step="1"
                disabled={props.disabled}
                value={entry.column}
                onChange={(event) => handleColumnChange(index, Number(event.target.value))}
              />
            </label>
            <label className="inspector-row">
              <span>目标设备</span>
              <select disabled={props.disabled} value={entry.targetId} onChange={(event) => handleTargetChange(index, event.target.value)}>
                {missing ? <option value={entry.targetId}>已删除实体（{entry.targetId}）</option> : null}
                {entityOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
            </label>
          </div>
        );
      })}

      {hasMissingTarget ? <p className="telemetry-runtime-error">存在指向已删除实体的列绑定，运行时对应列信号将被忽略。</p> : null}
    </div>
  );
}

/** 数据驱动 Inspector：编辑实体级 telemetryBinding 基础字段，驱动映射由模型包 .model.ts 声明。 */export function TelemetryBindingInspector(props: Props) {
  const binding = props.binding;
  if (!binding) {
    return (
      <fieldset className="transform-fieldset">
        <legend>数据驱动</legend>
        <p className="muted">当前模型没有启用遥测绑定。</p>
        <button type="button" disabled={props.disabled} onClick={props.onRestoreDefault}>恢复模型默认绑定</button>
        <TelemetryRuntimeDiagnosticsView entityId={props.entityId} binding={props.binding} modelAssetCode={props.modelAssetCode} />
      </fieldset>
    );
  }

  const activeBinding = binding;

  /** 提交绑定补丁前统一归一化。 */
  function commit(patch: Partial<TelemetryBindingComponent>): void {
    const merged = { ...cloneBinding(activeBinding) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete (merged as Record<string, unknown>)[key];
      } else {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
    const next = normalizeTelemetryBindingComponent(merged);
    if (next) props.onChange(next);
  }

  return (
    <fieldset className="transform-fieldset telemetry-binding-inspector">
      <legend>数据驱动</legend>
      <label className="mqtt-config-dialog-checkbox">
        <input type="checkbox" disabled={props.disabled} checked={binding.enabled} onChange={(event) => commit({ enabled: event.target.checked })} />
        启用绑定
      </label>
      <label className="inspector-row"><span>sourceId</span><input disabled={props.disabled} value={binding.sourceId} onChange={(event) => commit({ sourceId: event.target.value })} /></label>
      <label className="inspector-row"><span>assetCode 覆盖</span><input disabled={props.disabled} value={binding.assetCode ?? ''} onChange={(event) => commit({ assetCode: event.target.value || undefined })} /></label>
      <label className="number-row"><span>expected(ms)</span><input type="number" disabled={props.disabled} min="1" value={binding.expectedIntervalMs} onChange={(event) => commit({ expectedIntervalMs: Number(event.target.value) })} /></label>
      <label className="number-row"><span>stale(ms)</span><input type="number" disabled={props.disabled} min="1" value={binding.staleAfterMs} onChange={(event) => commit({ staleAfterMs: Number(event.target.value) })} /></label>
      <p className="muted">deviceType：{binding.deviceType}（由模型包 dataDriven 声明，只读）</p>
      <button type="button" disabled={props.disabled} onClick={props.onRestoreDefault}>恢复模型默认绑定</button>
      {binding.deviceType === 'rgv' ? (
        <RgvColumnBindingsEditor entityId={props.entityId} binding={binding} disabled={props.disabled} commit={commit} />
      ) : null}
      {binding.deviceType === 'conveyor' ? (
        <>
          <label className="inspector-row">
            <span>轨迹方向</span>
            <select
              disabled={props.disabled}
              value={binding.trajectoryDirection ?? 'x'}
              onChange={(event) => commit({ trajectoryDirection: event.target.value as TelemetryBindingComponent['trajectoryDirection'] })}
            >
              <option value="x">+x</option>
              <option value="-x">-x</option>
              <option value="z">+z</option>
              <option value="-z">-z</option>
            </select>
          </label>
          <label className="mqtt-config-dialog-checkbox">
            <input
              type="checkbox"
              disabled={props.disabled}
              checked={binding.cargoAutoDispose ?? true}
              onChange={(event) => commit({ cargoAutoDispose: event.target.checked })}
            />
            货物自动销毁（mode=2 且光电无货时）
          </label>
        </>
      ) : null}
      <TelemetryRuntimeDiagnosticsView entityId={props.entityId} binding={binding} modelAssetCode={props.modelAssetCode} />
      <SpecializedMotionSummary config={props.dataDrivenConfig} />
    </fieldset>
  );
}
