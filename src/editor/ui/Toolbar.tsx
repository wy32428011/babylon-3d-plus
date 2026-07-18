import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import type {
  EditorGridCellSize,
  EditorGridSettings,
} from '../../runtime/babylon/createEngine';
import { EDITOR_GRID_CELL_SIZES } from '../../runtime/babylon/createEngine';
import {
  STACKER_SIMULATION_SCENARIOS,
  createMqttAddressFromIp,
  sanitizeMqttConfig,
  type FetchConfig,
  type MqttConfig,
  type MqttSubscriptionConfig,
  type StackerSimulationScenario,
} from '../model/SceneDocument';
import { reindexRecordAfterRemoval } from '../model/mqttConfigUtils';
import { parseDeviceTelemetryMessage } from '../../runtime/mqtt/deviceTelemetry';
import { mqttRuntimeStatusStore } from '../../runtime/mqtt/mqttRuntimeStatus';
import type { EditorRuntimeMode } from '../model/editorRuntimeMode';
import type {
  CadImportProgress,
  TransformSnapSettingKey,
  TransformSnapSettings,
  TransformSpace,
  TransformTool,
} from '../store/editorStore';
import { SCENE_LENGTH_UNIT_SYMBOL } from '../model/sceneUnits';

const TRANSFORM_TOOL_LABELS: Record<TransformTool, string> = {
  translate: '移动',
  rotate: '旋转',
  scale: '缩放',
};

const TRANSFORM_SPACE_LABELS: Record<TransformSpace, string> = {
  local: '局部',
  global: '全局',
};

const TOOLBAR_ICONS = {
  translate: '↔',
  rotate: '⟳',
  scale: '⛶',
  local: '⌖',
  global: '◎',
  topView: '俯',
  delete: '⌫',
  undo: '↶',
  redo: '↷',
  save: '💾',
  load: '📂',
  cad: '▧',
  mqtt: 'MQ',
  fetch: '⤓',
} as const;

const STACKER_SIMULATION_SCENARIO_LABELS: Record<StackerSimulationScenario, string> = {
  cycle: '循环',
  target: '目标位',
  movement: '全0运动',
  fault: '急停',
  generic: '通用设备',
};

const MQTT_STATUS_LABELS = {
  disabled: '未启用',
  simulating: '本地模拟',
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
  error: '错误',
} as const;

type MqttPreviewResult = {
  topic: string;
  deviceType: string;
  assetCode: string;
  sourceId: string;
  sourceTimestamp: number | null;
  sequence: number | null;
  faulted: boolean;
  message: string;
  fields: Record<string, unknown>;
};

/** 把订阅通配符物化为可供 EPV 样例解析的具体 topic，不改变真实订阅配置。 */
function createPreviewTopic(topicFilter: string, config: MqttConfig, subscription?: MqttSubscriptionConfig): string {
  const topic = topicFilter.trim();
  if (!topic) return '';
  const assetCode = config.simulatorAssetCode.split(',').map((item) => item.trim()).find(Boolean) ?? 'SAMPLE-01';
  const configuredDeviceType = subscription?.adapter.kind === 'epv' ? subscription.adapter.deviceType?.trim() : undefined;
  const deviceType = configuredDeviceType || 'generic-device';
  const levels = topic.split('/');
  return levels.map((level, index) => {
    if (level !== '+' && level !== '#') return level;
    if (levels[0] === 'dt' && levels[1] === 'factory' && levels[2] === 'logistics') {
      if (index === 3) return deviceType;
      if (index === 4) return assetCode;
    }
    return level === '#' ? 'sample' : `sample-${index}`;
  }).join('/');
}

type ToolbarProps = {
  transformTool: TransformTool;
  transformSpace: TransformSpace;
  snapSettings: TransformSnapSettings;
  gridSettings: EditorGridSettings;
  onSetTransformTool: (tool: TransformTool) => void;
  onSetTransformSpace: (space: TransformSpace) => void;
  onSetSnapEnabled: (enabled: boolean) => void;
  onUpdateSnapSetting: (key: TransformSnapSettingKey, value: number) => void;
  onSetGridVisible: (visible: boolean) => void;
  onSetGridCellSize: (cellSizeMeters: EditorGridCellSize) => void;
  onSetTopView: () => void;
  onDeleteSelectedEntity: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSaveScene: () => void;
  onLoadScene: () => void;
  onImportCadReference: () => void;
  mqttConfig: MqttConfig;
  mqttConfigDialogOpen: boolean;
  onOpenMqttConfig: () => void;
  onCloseMqttConfig: () => void;
  onSaveMqttConfig: (config: MqttConfig) => void;
  fetchConfig: FetchConfig;
  onSaveFetchConfig: (config: FetchConfig) => void;
  cadImportProgress: CadImportProgress | null;
  canDelete: boolean;
  canUndo: boolean;
  canRedo: boolean;
  runtimeMode: EditorRuntimeMode;
  runtimePreviewError: string | null;
  readOnly: boolean;
  onStartRuntimePreview: () => void;
  onStopRuntimePreview: () => void;
};

type ToolbarIconButtonProps = {
  active?: boolean;
  disabled?: boolean;
  icon: string;
  label: string;
  onClick: () => void;
};

function ToolbarIconButton(props: ToolbarIconButtonProps) {
  return (
    <button
      aria-label={props.label}
      className={props.active ? 'toolbar-button toolbar-icon-button active' : 'toolbar-button toolbar-icon-button'}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.label}
      type="button"
    >
      <span aria-hidden="true">{props.icon}</span>
    </button>
  );
}

export function Toolbar(props: ToolbarProps) {
  const [mqttDraft, setMqttDraft] = useState<MqttConfig>(props.mqttConfig);
  const [jsonFieldsDrafts, setJsonFieldsDrafts] = useState<Record<number, string>>({});
  const [jsonFieldsErrors, setJsonFieldsErrors] = useState<Record<number, string>>({});
  const [previewSubscriptionIndex, setPreviewSubscriptionIndex] = useState(0);
  const [previewTopic, setPreviewTopic] = useState(props.mqttConfig.topic);
  const [previewPayload, setPreviewPayload] = useState('');
  const [previewResult, setPreviewResult] = useState<MqttPreviewResult | null>(null);
  const [fetchConfigDialogOpen, setFetchConfigDialogOpen] = useState(false);
  const [fetchDraft, setFetchDraft] = useState<FetchConfig>(props.fetchConfig);
  const isPreview = props.runtimeMode === 'preview';
  const [previewError, setPreviewError] = useState('');
  const mqttRuntimeStatus = useSyncExternalStore(
    mqttRuntimeStatusStore.subscribe,
    mqttRuntimeStatusStore.getSnapshot,
    mqttRuntimeStatusStore.getSnapshot,
  );

  useEffect(() => {
    if (props.mqttConfigDialogOpen) {
      setMqttDraft(props.mqttConfig);
      setJsonFieldsDrafts(Object.fromEntries((props.mqttConfig.subscriptions ?? []).map((subscription, index) => [index, subscription.adapter.kind === 'json-path' ? JSON.stringify(subscription.adapter.fields ?? {}, null, 2) : '{}'])));
      setJsonFieldsErrors({});
      setPreviewSubscriptionIndex(0);
      const firstSubscription = props.mqttConfig.subscriptions[0];
      setPreviewTopic(createPreviewTopic(firstSubscription?.topic ?? props.mqttConfig.topic, props.mqttConfig, firstSubscription));
      setPreviewPayload('');
      setPreviewResult(null);
      setPreviewError('');
    }
  }, [props.mqttConfig, props.mqttConfigDialogOpen]);

  useEffect(() => {
    if (!props.mqttConfigDialogOpen) return;

    /** 弹窗打开后允许按 Esc 关闭，避免键盘用户被困在遮罩内。 */
    function handleWindowKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') props.onCloseMqttConfig();
    }

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => window.removeEventListener('keydown', handleWindowKeyDown);
  }, [props]);

  /** 将数字输入转为有效吸附步长，非法输入交由 store 保持原值。 */
  function handleSnapSettingChange(key: TransformSnapSettingKey, rawValue: string): void {
    if (rawValue === '') return;

    const nextValue = Number(rawValue);
    if (!Number.isFinite(nextValue)) return;

    props.onUpdateSnapSetting(key, nextValue);
  }

  /** 将下拉框字符串转换为受支持的米制格子大小，避免 Toolbar 传出任意数字。 */
  function handleGridCellSizeChange(rawValue: string): void {
    const nextValue = Number(rawValue);
    if (!EDITOR_GRID_CELL_SIZES.includes(nextValue as EditorGridCellSize)) return;

    props.onSetGridCellSize(nextValue as EditorGridCellSize);
  }

  /** 将模拟场景选择限制在 Stacker 支持的场景集合内。 */
  function handleStackerSimulationScenarioChange(rawValue: string): void {
    if (!STACKER_SIMULATION_SCENARIOS.includes(rawValue as StackerSimulationScenario)) return;

    setMqttDraft((current) => ({
      ...current,
      simulatorScenario: rawValue as StackerSimulationScenario,
    }));
  }

  /** 将模拟间隔转换为稳定正整数，避免异常输入创建高频定时器。 */
  function handleStackerSimulationIntervalChange(rawValue: string): void {
    if (rawValue === '') return;

    const intervalMs = Number(rawValue);
    if (!Number.isFinite(intervalMs)) return;

    setMqttDraft((current) => ({
      ...current,
      simulatorIntervalMs: Math.max(100, Math.trunc(intervalMs)),
    }));
  }

  /** IP 变化时，如果地址仍是旧 IP 自动生成值，就同步生成新的默认 WebSocket 地址。 */
  function handleMqttIpChange(ip: string): void {
    setMqttDraft((current) => {
      const previousGeneratedAddress = createMqttAddressFromIp(current.ip);
      const shouldRefreshAddress = !current.address.trim() || current.address.trim() === previousGeneratedAddress;

      return {
        ...current,
        ip,
        address: shouldRefreshAddress ? createMqttAddressFromIp(ip) : current.address,
      };
    });
  }


  /** 新增一条 EPV 订阅，保持旧 topic 输入只作为兼容字段。 */
  function handleAddSubscription(): void {
    setMqttDraft((current) => {
      const nextIndex = current.subscriptions?.length ?? 0;
      setJsonFieldsDrafts((drafts) => ({ ...drafts, [nextIndex]: '{}' }));
      setJsonFieldsErrors((errors) => ({ ...errors, [nextIndex]: '' }));
      return {
        ...current,
        subscriptions: [...(current.subscriptions ?? []), { topic: current.topic || 'dt/factory/logistics/+/+/twindatadriven/joint', qos: 0, adapter: { kind: 'epv' } }],
      };
    });
  }

  /** 删除指定订阅，保存时 sanitizer 会在空列表时回退 legacy topic。 */
  function handleRemoveSubscription(index: number): void {
    setMqttDraft((current) => ({ ...current, subscriptions: (current.subscriptions ?? []).filter((_, itemIndex) => itemIndex !== index) }));
    setJsonFieldsDrafts((current) => reindexRecordAfterRemoval(current, index));
    setJsonFieldsErrors((current) => reindexRecordAfterRemoval(current, index));
  }

  /** 更新指定订阅并立即归一化局部字段。 */
  function handleSubscriptionChange(index: number, patch: Partial<MqttSubscriptionConfig>): void {
    if (patch.adapter?.kind === 'json-path') {
      const fields = patch.adapter.fields;
      setJsonFieldsDrafts((current) => ({ ...current, [index]: JSON.stringify(fields ?? {}, null, 2) }));
      setJsonFieldsErrors((current) => ({ ...current, [index]: '' }));
    }
    if (patch.adapter?.kind === 'epv') {
      setJsonFieldsDrafts((current) => ({ ...current, [index]: '{}' }));
      setJsonFieldsErrors((current) => ({ ...current, [index]: '' }));
    }
    setMqttDraft((current) => ({
      ...current,
      subscriptions: (current.subscriptions ?? []).map((subscription, itemIndex) => itemIndex === index ? { ...subscription, ...patch } : subscription),
    }));
  }


  /** 仅在 JSON Path 适配器已选中时更新路径字段，避免 EPV 分支混入非法属性。 */
  function handleJsonPathAdapterChange(
    index: number,
    adapter: MqttSubscriptionConfig['adapter'],
    patch: Partial<Extract<MqttSubscriptionConfig['adapter'], { kind: 'json-path' }>>,
  ): void {
    if (adapter.kind !== 'json-path') return;
    handleSubscriptionChange(index, { adapter: { ...adapter, ...patch } });
  }

  /** 更新 JSON Path fields 草稿，只有完整合法对象才写入 MQTT 草稿。 */
  function handleSubscriptionFieldsChange(index: number, rawValue: string): void {
    setJsonFieldsDrafts((current) => ({ ...current, [index]: rawValue }));
    try {
      const fields = JSON.parse(rawValue) as unknown;
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
        setJsonFieldsErrors((current) => ({ ...current, [index]: 'fields 必须是 JSON 对象。' }));
        return;
      }
      setJsonFieldsErrors((current) => ({ ...current, [index]: '' }));
      setMqttDraft((current) => ({
        ...current,
        subscriptions: (current.subscriptions ?? []).map((subscription, itemIndex) => itemIndex === index && subscription.adapter.kind === 'json-path'
          ? { ...subscription, adapter: { ...subscription.adapter, fields: fields as Record<string, string> } }
          : subscription),
      }));
    } catch {
      setJsonFieldsErrors((current) => ({ ...current, [index]: 'fields JSON 格式不完整或不合法。' }));
    }
  }

  /** 本地解析样例 payload，仅生成预览结果，不写入 deviceTelemetryStore。 */
  function handlePreviewPayload(): void {
    const subscription = mqttDraft.subscriptions[previewSubscriptionIndex];
    if (!subscription) {
      setPreviewResult(null);
      setPreviewError('请选择一条订阅配置。');
      return;
    }

    try {
      const snapshot = parseDeviceTelemetryMessage(previewTopic, previewPayload, subscription.adapter);
      if (!snapshot) {
        setPreviewResult(null);
        setPreviewError('payload 已解析，但未生成设备快照。');
        return;
      }

      setPreviewResult({
        topic: snapshot.topic,
        deviceType: snapshot.deviceType,
        assetCode: snapshot.assetCode,
        sourceId: snapshot.sourceId,
        sourceTimestamp: snapshot.sourceTimestamp,
        sequence: snapshot.sequence,
        faulted: snapshot.faulted,
        message: snapshot.message,
        fields: snapshot.fields,
      });
      setPreviewError('');
    } catch (error) {
      setPreviewResult(null);
      setPreviewError(error instanceof Error ? error.message : String(error));
    }
  }

  /** 保存前再次归一化，保证只填 IP 时也能落成完整 MQTT over WebSocket 地址。 */
  function handleMqttConfigSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (props.readOnly) return;
    if (Object.values(jsonFieldsErrors).some(Boolean)) return;
    props.onSaveMqttConfig(sanitizeMqttConfig(mqttDraft));
    props.onCloseMqttConfig();
  }

  return (
    <header className="toolbar">
      <strong className="toolbar-title">Babylon Unity-like Editor</strong>
      <ToolbarIconButton
        active={props.transformTool === 'translate'}
        disabled={props.readOnly}
        icon={TOOLBAR_ICONS.translate}
        label={TRANSFORM_TOOL_LABELS.translate}
        onClick={() => props.onSetTransformTool('translate')}
      />
      <ToolbarIconButton
        active={props.transformTool === 'rotate'}
        disabled={props.readOnly}
        icon={TOOLBAR_ICONS.rotate}
        label={TRANSFORM_TOOL_LABELS.rotate}
        onClick={() => props.onSetTransformTool('rotate')}
      />
      <ToolbarIconButton
        active={props.transformTool === 'scale'}
        disabled={props.readOnly}
        icon={TOOLBAR_ICONS.scale}
        label={TRANSFORM_TOOL_LABELS.scale}
        onClick={() => props.onSetTransformTool('scale')}
      />
      <div className="toolbar-segment" aria-label="变换坐标空间">
        <ToolbarIconButton
          active={props.transformSpace === 'local'}
          disabled={props.readOnly}
          icon={TOOLBAR_ICONS.local}
          label={TRANSFORM_SPACE_LABELS.local}
          onClick={() => props.onSetTransformSpace('local')}
        />
        <ToolbarIconButton
          active={props.transformSpace === 'global'}
          disabled={props.readOnly}
          icon={TOOLBAR_ICONS.global}
          label={TRANSFORM_SPACE_LABELS.global}
          onClick={() => props.onSetTransformSpace('global')}
        />
      </div>
      <ToolbarIconButton
        icon={TOOLBAR_ICONS.topView}
        label="切换为俯视视角"
        onClick={props.onSetTopView}
      />
      <label className="toolbar-checkbox">
        <input
          type="checkbox"
          checked={props.snapSettings.enabled}
          disabled={props.readOnly}
          onChange={(event) => props.onSetSnapEnabled(event.target.checked)}
        />
        吸附
      </label>
      <label className="toolbar-checkbox">
        <input
          type="checkbox"
          checked={props.gridSettings.visible}
          onChange={(event) => props.onSetGridVisible(event.target.checked)}
        />
        网格
      </label>
      <label className="toolbar-select">
        <span>格子</span>
        <select
          value={props.gridSettings.cellSizeMeters}
          onChange={(event) => handleGridCellSizeChange(event.target.value)}
        >
          {EDITOR_GRID_CELL_SIZES.map((cellSizeMeters) => (
            <option key={cellSizeMeters} value={cellSizeMeters}>
              {`${cellSizeMeters} ${SCENE_LENGTH_UNIT_SYMBOL}`}
            </option>
          ))}
        </select>
      </label>
      <label className="toolbar-number">
        <span>{`位置 (${SCENE_LENGTH_UNIT_SYMBOL})`}</span>
        <input
          type="number"
          min="0.01"
          step="0.1"
          value={props.snapSettings.position}
          disabled={props.readOnly}
          onChange={(event) => handleSnapSettingChange('position', event.target.value)}
        />
      </label>
      <label className="toolbar-number">
        <span>旋转</span>
        <input
          type="number"
          min="1"
          step="1"
          value={props.snapSettings.rotationDegrees}
          disabled={props.readOnly}
          onChange={(event) => handleSnapSettingChange('rotationDegrees', event.target.value)}
        />
      </label>
      <label className="toolbar-number">
        <span>缩放</span>
        <input
          type="number"
          min="0.01"
          step="0.05"
          value={props.snapSettings.scale}
          disabled={props.readOnly}
          onChange={(event) => handleSnapSettingChange('scale', event.target.value)}
        />
      </label>
      <ToolbarIconButton disabled={!props.canDelete} icon={TOOLBAR_ICONS.delete} label="删除" onClick={props.onDeleteSelectedEntity} />
      <ToolbarIconButton disabled={!props.canUndo} icon={TOOLBAR_ICONS.undo} label="撤销" onClick={props.onUndo} />
      <ToolbarIconButton disabled={!props.canRedo} icon={TOOLBAR_ICONS.redo} label="重做" onClick={props.onRedo} />
      <ToolbarIconButton
        disabled={isPreview || Boolean(props.cadImportProgress?.active)}
        icon="▶"
        label="运行"
        onClick={props.onStartRuntimePreview}
      />
      <ToolbarIconButton disabled={!isPreview} icon="■" label="停止" onClick={props.onStopRuntimePreview} />
      <span
        aria-live="polite"
        className={isPreview ? `mqtt-runtime-status mqtt-runtime-status-${mqttRuntimeStatus.state}` : 'mqtt-runtime-status'}
        role="status"
      >
        {isPreview ? MQTT_STATUS_LABELS[mqttRuntimeStatus.state] : '编辑中'}
      </span>
      <ToolbarIconButton
        disabled={props.readOnly || Boolean(props.cadImportProgress?.active)}
        icon={TOOLBAR_ICONS.cad}
        label="导入CAD参考图"
        onClick={props.onImportCadReference}
      />
      <ToolbarIconButton
        active={props.mqttConfig.enabled}
        disabled={props.readOnly}
        icon={TOOLBAR_ICONS.mqtt}
        label="配置 MQTT 与本地模拟"
        onClick={props.onOpenMqttConfig}
      />
      <ToolbarIconButton
        disabled={props.readOnly}
        icon={TOOLBAR_ICONS.fetch}
        label="配置 Fetch 请求"
        onClick={() => {
          setFetchDraft(props.fetchConfig);
          setFetchConfigDialogOpen(true);
        }}
      />
      {props.cadImportProgress ? (
        <div className="cad-import-progress" role="status" aria-live="polite">
          <div className="cad-import-progress-header">
            <strong>{props.cadImportProgress.label}</strong>
            <span>{props.cadImportProgress.percent}%</span>
          </div>
          <div className="cad-import-progress-track" aria-hidden="true">
            <div
              className="cad-import-progress-fill"
              style={{ width: `${props.cadImportProgress.percent}%` }}
            />
          </div>
          <p title={props.cadImportProgress.detail}>{props.cadImportProgress.detail}</p>
        </div>
      ) : null}
      <ToolbarIconButton disabled={props.readOnly} icon={TOOLBAR_ICONS.save} label="保存场景" onClick={props.onSaveScene} />
      <ToolbarIconButton disabled={props.readOnly} icon={TOOLBAR_ICONS.load} label="加载场景" onClick={props.onLoadScene} />
      {props.mqttConfigDialogOpen ? (
        <div
          className="mqtt-config-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) props.onCloseMqttConfig();
          }}
        >
          <form
            aria-label="MQTT 地址配置"
            aria-labelledby="mqtt-config-dialog-title"
            aria-modal="true"
            className="mqtt-config-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={handleMqttConfigSubmit}
            role="dialog"
          >
            <h3 id="mqtt-config-dialog-title">MQTT 配置</h3>
            <p className={`mqtt-runtime-status mqtt-runtime-status-${mqttRuntimeStatus.state}`}>
              当前状态：{MQTT_STATUS_LABELS[mqttRuntimeStatus.state]}
              {mqttRuntimeStatus.lastError ? `；最近错误：${mqttRuntimeStatus.lastError}` : ''}
            </p>
            {props.runtimePreviewError ? (
              <p className="mqtt-config-dialog-error" role="alert">{props.runtimePreviewError}</p>
            ) : null}
            <label className="mqtt-config-dialog-checkbox">
              <input
                checked={mqttDraft.enabled}
                onChange={(event) => setMqttDraft((current) => ({ ...current, enabled: event.target.checked }))}
                type="checkbox"
              />
              启用配置
            </label>
            <label className="mqtt-config-dialog-checkbox">
              <input
                checked={mqttDraft.simulatorEnabled}
                onChange={(event) => setMqttDraft((current) => ({ ...current, simulatorEnabled: event.target.checked }))}
                type="checkbox"
              />
              本地模拟
            </label>
            <label className="mqtt-config-dialog-row">
              <span>模拟资产</span>
              <input
                placeholder="DDJ2"
                value={mqttDraft.simulatorAssetCode}
                onChange={(event) => setMqttDraft((current) => ({ ...current, simulatorAssetCode: event.target.value }))}
              />
            </label>
            <label className="mqtt-config-dialog-row">
              <span>模拟场景</span>
              <select
                value={mqttDraft.simulatorScenario}
                onChange={(event) => handleStackerSimulationScenarioChange(event.target.value)}
              >
                {STACKER_SIMULATION_SCENARIOS.map((scenario) => (
                  <option key={scenario} value={scenario}>
                    {STACKER_SIMULATION_SCENARIO_LABELS[scenario]}
                  </option>
                ))}
              </select>
            </label>
            <label className="mqtt-config-dialog-row">
              <span>间隔(ms)</span>
              <input
                min="100"
                step="1"
                type="number"
                value={mqttDraft.simulatorIntervalMs}
                onChange={(event) => handleStackerSimulationIntervalChange(event.target.value)}
              />
            </label>
            <label className="mqtt-config-dialog-row">
              <span>IP/域名</span>
              <input
                autoFocus
                placeholder="192.168.60.154"
                value={mqttDraft.ip}
                onChange={(event) => handleMqttIpChange(event.target.value)}
              />
            </label>
            <label className="mqtt-config-dialog-row">
              <span>地址</span>
              <input
                placeholder="ws://192.168.60.154:8083/mqtt"
                value={mqttDraft.address}
                onChange={(event) => setMqttDraft((current) => ({ ...current, address: event.target.value }))}
              />
            </label>
            <label className="mqtt-config-dialog-row">
              <span>Legacy Topic</span>
              <input
                placeholder="dt/factory/logistics/stacker/+/twindatadriven/joint"
                value={mqttDraft.topic}
                onChange={(event) => setMqttDraft((current) => ({ ...current, topic: event.target.value }))}
              />
            </label>
            <div className="mqtt-subscription-list">
              <div className="mqtt-subscription-list-header">
                <strong>订阅列表</strong>
                <button type="button" onClick={handleAddSubscription}>新增订阅</button>
              </div>
              {(mqttDraft.subscriptions ?? []).map((subscription, index) => (
                <div className="mqtt-subscription-item" key={index}>
                  <label className="mqtt-config-dialog-row">
                    <span>Topic</span>
                    <input value={subscription.topic} onChange={(event) => handleSubscriptionChange(index, { topic: event.target.value })} />
                  </label>
                  <label className="mqtt-config-dialog-row">
                    <span>QoS</span>
                    <select value={subscription.qos} onChange={(event) => handleSubscriptionChange(index, { qos: Number(event.target.value) === 1 ? 1 : 0 })}>
                      <option value={0}>0</option>
                      <option value={1}>1</option>
                    </select>
                  </label>
                  <label className="mqtt-config-dialog-row">
                    <span>Adapter</span>
                    <select
                      value={subscription.adapter.kind}
                      onChange={(event) => handleSubscriptionChange(index, { adapter: event.target.value === 'json-path' ? { kind: 'json-path', fields: {} } : { kind: 'epv' } })}
                    >
                      <option value="epv">EPV</option>
                      <option value="json-path">JSON Path</option>
                    </select>
                  </label>
                  {subscription.adapter.kind === 'json-path' ? (
                    <>
                      <label className="mqtt-config-dialog-row"><span>deviceTypePath</span><input value={subscription.adapter.deviceTypePath ?? ''} onChange={(event) => handleJsonPathAdapterChange(index, subscription.adapter, { deviceTypePath: event.target.value })} /></label>
                      <label className="mqtt-config-dialog-row"><span>assetCodePath</span><input value={subscription.adapter.assetCodePath ?? ''} onChange={(event) => handleJsonPathAdapterChange(index, subscription.adapter, { assetCodePath: event.target.value })} /></label>
                      <label className="mqtt-config-dialog-row"><span>timestampPath</span><input value={subscription.adapter.timestampPath ?? ''} onChange={(event) => handleJsonPathAdapterChange(index, subscription.adapter, { timestampPath: event.target.value })} /></label>
                      <label className="mqtt-config-dialog-row"><span>sequencePath</span><input value={subscription.adapter.sequencePath ?? ''} onChange={(event) => handleJsonPathAdapterChange(index, subscription.adapter, { sequencePath: event.target.value })} /></label>
                      <label className="mqtt-config-dialog-row"><span>fields JSON</span><textarea value={jsonFieldsDrafts[index] ?? JSON.stringify(subscription.adapter.fields ?? {}, null, 2)} onChange={(event) => handleSubscriptionFieldsChange(index, event.target.value)} /></label>
                      {jsonFieldsErrors[index] ? <p className="mqtt-config-dialog-error">{jsonFieldsErrors[index]}</p> : null}
                    </>
                  ) : null}
                  <button type="button" onClick={() => handleRemoveSubscription(index)}>删除订阅</button>
                </div>
              ))}
            </div>
            <div className="mqtt-subscription-list">
              <div className="mqtt-subscription-list-header">
                <strong>样例 payload 解析预览</strong>
                <button type="button" onClick={handlePreviewPayload}>解析预览</button>
              </div>
              <label className="mqtt-config-dialog-row">
                <span>订阅选择</span>
                <select
                  value={previewSubscriptionIndex}
                  onChange={(event) => {
                    const index = Number(event.target.value);
                    setPreviewSubscriptionIndex(index);
                    const subscription = mqttDraft.subscriptions[index];
                    setPreviewTopic(createPreviewTopic(subscription?.topic ?? mqttDraft.topic, mqttDraft, subscription));
                    setPreviewResult(null);
                    setPreviewError('');
                  }}
                >
                  {(mqttDraft.subscriptions ?? []).map((subscription, index) => (
                    <option key={index} value={index}>{subscription.topic || `订阅 ${index + 1}`}</option>
                  ))}
                </select>
              </label>
              <label className="mqtt-config-dialog-row">
                <span>样例 Topic</span>
                <input value={previewTopic} onChange={(event) => setPreviewTopic(event.target.value)} />
              </label>
              <label className="mqtt-config-dialog-row">
                <span>payload</span>
                <textarea value={previewPayload} onChange={(event) => setPreviewPayload(event.target.value)} />
              </label>
              {previewError ? <p className="mqtt-config-dialog-error">解析失败：{previewError}</p> : null}
              {previewResult ? (
                <pre className="mqtt-preview-result">{JSON.stringify(previewResult, null, 2)}</pre>
              ) : null}
            </div>
            <div className="mqtt-config-dialog-actions">
              <button type="button" onClick={props.onCloseMqttConfig}>取消</button>
              <button className="mqtt-config-dialog-primary" type="submit">保存</button>
            </div>
          </form>
        </div>
      ) : null}
      {fetchConfigDialogOpen ? (
        <div
          className="fetch-config-dialog-backdrop"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setFetchConfigDialogOpen(false); }}
        >
          <form
            aria-label="Fetch 请求配置"
            aria-modal="true"
            className="fetch-config-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              props.onSaveFetchConfig(fetchDraft);
              setFetchConfigDialogOpen(false);
            }}
          >
            <h3>Fetch 配置</h3>
            <p className="muted">配置 fetch 数据源的基础请求地址和 API Key。</p>
            <label className="fetch-config-dialog-row">
              <span>请求地址</span>
              <input
                type="text"
                value={fetchDraft.url}
                maxLength={2048}
                placeholder="https://api.example.com/cargo"
                onChange={(event) => setFetchDraft({ ...fetchDraft, url: event.target.value })}
              />
            </label>
            <label className="fetch-config-dialog-row">
              <span>API Key</span>
              <input
                type="text"
                value={fetchDraft.apiKey}
                maxLength={256}
                placeholder="sk-..."
                onChange={(event) => setFetchDraft({ ...fetchDraft, apiKey: event.target.value })}
              />
            </label>
            <div className="fetch-config-dialog-actions">
              <button type="button" onClick={() => setFetchConfigDialogOpen(false)}>取消</button>
              <button className="fetch-config-dialog-primary" type="submit">保存</button>
            </div>
          </form>
        </div>
      ) : null}
    </header>
  );
}
