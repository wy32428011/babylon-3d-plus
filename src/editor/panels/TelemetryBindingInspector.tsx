import { useSyncExternalStore } from 'react';
import type { TelemetryBindingComponent, TelemetryMotionChannel, TelemetryTargetKind } from '../model/telemetryBinding';
import { normalizeTelemetryBindingComponent, normalizeTelemetryMotionChannel } from '../model/telemetryBinding';
import { deviceTelemetryStore } from '../../runtime/mqtt/deviceTelemetry';
import { telemetryRuntimeDiagnosticsStore, type TelemetryRuntimeDiagnosticSnapshot } from '../../runtime/mqtt/telemetryRuntimeDiagnostics';
import { useEditorStore } from '../store/editorStore';

type Props = {
  entityId: string;
  binding: TelemetryBindingComponent | undefined;
  defaultChannels: Record<string, TelemetryMotionChannel>;
  disabled: boolean;
  modelAssetCode: string;
  onChange: (binding: TelemetryBindingComponent | null) => void;
  onRestoreDefault: () => void;
};

const targetKinds: TelemetryTargetKind[] = ['root', 'node', 'bone', 'animation'];
const modes: TelemetryMotionChannel['mode'][] = ['absolute', 'velocity', 'state'];
const properties: Array<NonNullable<TelemetryMotionChannel['property']>> = ['position', 'rotation', 'scaling'];
const axes: Array<NonNullable<TelemetryMotionChannel['axis']>> = ['x', 'y', 'z'];

/** 克隆绑定，避免 Inspector 表单直接修改 Zustand 状态引用。 */
function cloneBinding(binding: TelemetryBindingComponent): TelemetryBindingComponent {
  return JSON.parse(JSON.stringify(binding)) as TelemetryBindingComponent;
}

/** 生成可编辑通道列表，默认通道和实例覆盖通道都会展示。 */
function collectChannels(binding: TelemetryBindingComponent | undefined, defaultChannels: Record<string, TelemetryMotionChannel>) {
  return Object.entries({ ...defaultChannels, ...(binding?.channelOverrides ?? {}) });
}

/** 从字段文本生成安全通道补丁。 */
function updateChannel(binding: TelemetryBindingComponent, channelId: string, patch: Partial<TelemetryMotionChannel>): TelemetryBindingComponent {
  const current = binding.channelOverrides[channelId] ?? { channel: channelId, fields: [channelId], mode: 'absolute', target: { kind: 'root' }, scale: 1, offset: 0, invert: false };
  const next = normalizeTelemetryMotionChannel({ ...current, ...patch }, channelId);
  if (!next) return binding;
  return { ...binding, channelOverrides: { ...binding.channelOverrides, [channelId]: next } };
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

/** 根据运行时模型目录为节点、骨骼和动画 selector 提供下拉建议，同时保留手工输入路径。 */
function TelemetryTargetSelector(props: {
  entityId: string;
  channelId: string;
  channel: TelemetryMotionChannel;
  disabled: boolean;
  onChange: (selector: string | undefined) => void;
}) {
  const diagnostic = useSyncExternalStore(
    telemetryRuntimeDiagnosticsStore.subscribe.bind(telemetryRuntimeDiagnosticsStore),
    () => telemetryRuntimeDiagnosticsStore.getSnapshot(props.entityId),
    () => telemetryRuntimeDiagnosticsStore.getSnapshot(props.entityId),
  );
  const options = props.channel.target.kind === 'animation'
    ? diagnostic?.animationTargets ?? []
    : props.channel.target.kind === 'bone'
      ? diagnostic?.boneTargets ?? []
      : props.channel.target.kind === 'node'
        ? diagnostic?.nodeTargets ?? []
        : [];
  const listId = `telemetry-target-${props.entityId}-${props.channelId}`.replace(/[^A-Za-z0-9_-]/g, '-');
  const selectorDisabled = props.disabled || props.channel.target.kind === 'root';

  return (
    <label className="inspector-row">
      <span>selector</span>
      <input
        disabled={selectorDisabled}
        list={options.length > 0 ? listId : undefined}
        placeholder={props.channel.target.kind === 'root' ? 'root 无需 selector' : '选择或输入目标'}
        value={props.channel.target.selector ?? ''}
        onChange={(event) => props.onChange(event.target.value || undefined)}
      />
      {options.length > 0 ? <datalist id={listId}>{options.map((option) => <option key={option} value={option} />)}</datalist> : null}
    </label>
  );
}

/** 独立数据驱动 Inspector，负责编辑实体级 telemetryBinding 覆盖。 */
export function TelemetryBindingInspector(props: Props) {
  const scene = useEditorStore((state) => state.scene);
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
    const next = normalizeTelemetryBindingComponent({ ...cloneBinding(activeBinding), ...patch });
    if (next) props.onChange(next);
  }

  const generatorOptions = scene.entityIds
    .map((entityId) => scene.entities[entityId])
    .filter((entity) => entity?.components.modelGenerator)
    .map((entity) => ({ id: entity.id, name: entity.name }));
  const cargoGeneratorMissing = Boolean(
    activeBinding.cargoGeneratorId && !generatorOptions.some((option) => option.id === activeBinding.cargoGeneratorId),
  );

  const selfAssetCode = activeBinding.assetCode ?? props.modelAssetCode;
  const deviceAssetCodeByEntityId = new Map<string, string>();
  for (const entityId of scene.entityIds) {
    if (entityId === props.entityId) continue;
    const entity = scene.entities[entityId];
    if (!entity || entity.isFolder) continue;
    const assetCode = entity.components.telemetryBinding?.assetCode ?? entity.components.modelAsset?.assetCode;
    if (assetCode && (entity.components.telemetryBinding || entity.components.modelAsset)) {
      deviceAssetCodeByEntityId.set(entityId, assetCode);
    }
  }
  const upstreamAssetCode = activeBinding.upstreamAssetCode ?? '';
  const upstreamListId = `upstream-asset-${props.entityId}`.replace(/[^A-Za-z0-9_-]/g, '-');
  const upstreamExists = upstreamAssetCode !== '' && [...deviceAssetCodeByEntityId.values()].includes(upstreamAssetCode);
  const upstreamWarnings: string[] = [];
  if (upstreamAssetCode && upstreamAssetCode === selfAssetCode) {
    upstreamWarnings.push('前置设备不能与自身相同。');
  }
  if (upstreamAssetCode && !upstreamExists) {
    upstreamWarnings.push(`场景中未找到资产编号为「${upstreamAssetCode}」的设备，运行时将按入口设备处理。`);
  }
  if (upstreamAssetCode && upstreamExists) {
    const upstreamByAssetCode = new Map<string, string>();
    for (const entityId of scene.entityIds) {
      const entity = scene.entities[entityId];
      if (!entity || entity.isFolder) continue;
      const assetCode = entity.components.telemetryBinding?.assetCode ?? entity.components.modelAsset?.assetCode;
      if (assetCode && !upstreamByAssetCode.has(assetCode)) {
        upstreamByAssetCode.set(assetCode, entity.components.telemetryBinding?.upstreamAssetCode ?? '');
      }
    }
    const visited = new Set<string>([selfAssetCode]);
    let cursor: string | undefined = upstreamAssetCode;
    while (cursor) {
      if (visited.has(cursor)) {
        upstreamWarnings.push('检测到前置设备环，运行时相关设备将停止货箱驱动。');
        break;
      }
      visited.add(cursor);
      cursor = upstreamByAssetCode.get(cursor) || undefined;
    }
  }

  return (
    <fieldset className="transform-fieldset telemetry-binding-inspector">
      <legend>数据驱动</legend>
      <label className="mqtt-config-dialog-checkbox">
        <input type="checkbox" disabled={props.disabled} checked={binding.enabled} onChange={(event) => commit({ enabled: event.target.checked })} />
        启用绑定
      </label>
      <label className="inspector-row"><span>sourceId</span><input disabled={props.disabled} value={binding.sourceId} onChange={(event) => commit({ sourceId: event.target.value })} /></label>
      <label className="inspector-row"><span>deviceType</span><input disabled={props.disabled} value={binding.deviceType} onChange={(event) => commit({ deviceType: event.target.value })} /></label>
      <label className="inspector-row"><span>assetCode 覆盖</span><input disabled={props.disabled} value={binding.assetCode ?? ''} onChange={(event) => commit({ assetCode: event.target.value || undefined })} /></label>
      <label className="inspector-row">
        <span>货箱生成器</span>
        <select
          disabled={props.disabled}
          value={cargoGeneratorMissing ? '' : (activeBinding.cargoGeneratorId ?? '')}
          onChange={(event) => commit({ cargoGeneratorId: event.target.value || undefined })}
        >
          <option value="">未绑定（内置立方体）</option>
          {generatorOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>
      </label>
      {cargoGeneratorMissing ? <p className="telemetry-runtime-error">绑定的模型生成器已被删除，运行时将回退内置立方体。</p> : null}
      <label className="inspector-row">
        <span>前置设备资产编号</span>
        <input
          disabled={props.disabled}
          list={upstreamListId}
          placeholder="留空表示入口设备"
          value={upstreamAssetCode}
          onChange={(event) => commit({ upstreamAssetCode: event.target.value || undefined })}
        />
        <datalist id={upstreamListId}>
          {[...deviceAssetCodeByEntityId.values()].map((assetCode) => <option key={assetCode} value={assetCode} />)}
        </datalist>
      </label>
      {upstreamWarnings.map((warning) => <p className="telemetry-runtime-error" key={warning}>{warning}</p>)}
      <label className="number-row"><span>expected(ms)</span><input type="number" disabled={props.disabled} min="1" value={binding.expectedIntervalMs} onChange={(event) => commit({ expectedIntervalMs: Number(event.target.value) })} /></label>
      <label className="number-row"><span>stale(ms)</span><input type="number" disabled={props.disabled} min="1" value={binding.staleAfterMs} onChange={(event) => commit({ staleAfterMs: Number(event.target.value) })} /></label>
      <button type="button" disabled={props.disabled} onClick={props.onRestoreDefault}>恢复模型默认绑定</button>
      <TelemetryRuntimeDiagnosticsView entityId={props.entityId} binding={binding} modelAssetCode={props.modelAssetCode} />
      {collectChannels(binding, props.defaultChannels).map(([channelId, channel]) => (
        <div className="telemetry-channel-editor" key={channelId}>
          <strong>{channelId}{binding.channelOverrides[channelId] ? '（覆盖）' : '（默认）'}</strong>
          <label className="inspector-row"><span>fields</span><input disabled={props.disabled} value={channel.fields.join(',')} onChange={(event) => props.onChange(updateChannel(binding, channelId, { fields: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) }))} /></label>
          <label className="inspector-row"><span>mode</span><select disabled={props.disabled} value={channel.mode} onChange={(event) => props.onChange(updateChannel(binding, channelId, { mode: event.target.value as TelemetryMotionChannel['mode'] }))}>{modes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label>
          <label className="inspector-row"><span>target</span><select disabled={props.disabled} value={channel.target.kind} onChange={(event) => props.onChange(updateChannel(binding, channelId, { target: { ...channel.target, kind: event.target.value as TelemetryTargetKind } }))}>{targetKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
          <TelemetryTargetSelector
            entityId={props.entityId}
            channelId={channelId}
            channel={channel}
            disabled={props.disabled}
            onChange={(selector) => props.onChange(updateChannel(binding, channelId, { target: { ...channel.target, selector } }))}
          />
          <label className="inspector-row"><span>property</span><select disabled={props.disabled} value={channel.property ?? 'position'} onChange={(event) => props.onChange(updateChannel(binding, channelId, { property: event.target.value as TelemetryMotionChannel['property'] }))}>{properties.map((property) => <option key={property} value={property}>{property}</option>)}</select></label>
          <label className="inspector-row"><span>axis</span><select disabled={props.disabled} value={channel.axis ?? 'x'} onChange={(event) => props.onChange(updateChannel(binding, channelId, { axis: event.target.value as TelemetryMotionChannel['axis'] }))}>{axes.map((axis) => <option key={axis} value={axis}>{axis}</option>)}</select></label>
          <label className="number-row"><span>scale</span><input type="number" disabled={props.disabled} value={channel.scale} onChange={(event) => props.onChange(updateChannel(binding, channelId, { scale: Number(event.target.value) }))} /></label>
          <label className="number-row"><span>offset</span><input type="number" disabled={props.disabled} value={channel.offset} onChange={(event) => props.onChange(updateChannel(binding, channelId, { offset: Number(event.target.value) }))} /></label>
          <label className="number-row"><span>min</span><input type="number" disabled={props.disabled} value={channel.min ?? ''} onChange={(event) => props.onChange(updateChannel(binding, channelId, { min: event.target.value === '' ? undefined : Number(event.target.value) }))} /></label>
          <label className="number-row"><span>max</span><input type="number" disabled={props.disabled} value={channel.max ?? ''} onChange={(event) => props.onChange(updateChannel(binding, channelId, { max: event.target.value === '' ? undefined : Number(event.target.value) }))} /></label>
          <label className="inspector-row"><span>smoothing</span><select disabled={props.disabled} value={channel.smoothing?.kind ?? ''} onChange={(event) => props.onChange(updateChannel(binding, channelId, { smoothing: event.target.value === 'linear' ? { kind: 'linear', durationMs: 200 } : event.target.value === 'ema' ? { kind: 'ema', alpha: 0.35 } : event.target.value === 'step' ? { kind: 'step' } : undefined }))}><option value="">none</option><option value="step">step</option><option value="linear">linear</option><option value="ema">ema</option></select></label>
          {channel.smoothing?.kind === 'linear' ? <label className="number-row"><span>duration</span><input type="number" disabled={props.disabled} value={channel.smoothing.durationMs ?? 200} onChange={(event) => props.onChange(updateChannel(binding, channelId, { smoothing: { kind: 'linear', durationMs: Number(event.target.value) } }))} /></label> : null}
          {channel.smoothing?.kind === 'ema' ? <label className="number-row"><span>alpha</span><input type="number" disabled={props.disabled} min="0" max="1" step="0.05" value={channel.smoothing.alpha ?? 0.35} onChange={(event) => props.onChange(updateChannel(binding, channelId, { smoothing: { kind: 'ema', alpha: Number(event.target.value) } }))} /></label> : null}
          <label className="inspector-row"><span>animation action</span><input disabled={props.disabled} value={channel.animation?.action ?? ''} onChange={(event) => props.onChange(updateChannel(binding, channelId, { animation: { ...(channel.animation ?? {}), action: event.target.value || undefined } }))} /></label>
          <label className="mqtt-config-dialog-checkbox"><input type="checkbox" disabled={props.disabled} checked={channel.animation?.loop ?? false} onChange={(event) => props.onChange(updateChannel(binding, channelId, { animation: { ...(channel.animation ?? {}), loop: event.target.checked } }))} />动画循环</label>
          <label className="number-row"><span>anim speed</span><input type="number" disabled={props.disabled} step="0.1" value={channel.animation?.speed ?? 1} onChange={(event) => props.onChange(updateChannel(binding, channelId, { animation: { ...(channel.animation ?? {}), speed: Number(event.target.value) } }))} /></label>
          <label className="number-row"><span>blend</span><input type="number" disabled={props.disabled} min="0" max="1" step="0.05" value={channel.animation?.blend ?? 0.2} onChange={(event) => props.onChange(updateChannel(binding, channelId, { animation: { ...(channel.animation ?? {}), blend: Number(event.target.value) } }))} /></label>
        </div>
      ))}
    </fieldset>
  );
}
