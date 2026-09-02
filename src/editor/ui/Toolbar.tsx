import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import type {
  CameraOrientation,
  CameraProjection,
  StandardCameraOrientation,
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
import {
  startMqttConnectionTest,
  type MqttConnectionTestHandle,
  type MqttConnectionTestResult,
} from '../../runtime/mqtt/MqttConnectionTest';
import { resolveMqttStackerSubscriptions } from '../../runtime/mqtt/MqttStackerTelemetryConfig';
import type { EditorRuntimeMode } from '../model/editorRuntimeMode';
import type {
  CadImportProgress,
  TransformSnapSettingKey,
  TransformSnapSettings,
  TransformSpace,
  TransformTool,
} from '../store/editorStore';
import { SCENE_LENGTH_UNIT_SYMBOL } from '../model/sceneUnits';
import {
  createDeploymentToolbarDetail,
  getDeploymentStageLabel,
  type DeploymentExportStatus,
  type DeploymentExportViewProgress,
} from '../deployment/deploymentExport';
import { ToolbarTaskProgress } from '../deployment/ToolbarTaskProgress';
import { APPLICATION_NAME, BrandLogo } from './BrandLogo';
import { RETURN_TO_HOME_PAGE_LABEL } from '../home/returnToHomePage';
import { FullscreenGlyph } from '../../shared/ui/FullscreenGlyph';

const TRANSFORM_TOOL_LABELS: Record<TransformTool, string> = {
  translate: '移动 (E)',
  rotate: '旋转 (R)',
  scale: '缩放 (T)',
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
  orthographic: '正',
  delete: '⌫',
  undo: '↶',
  redo: '↷',
  save: '💾',
  load: '📂',
  publish: '☁',
  deployment: '📦',
  cad: '▧',
  mqtt: 'MQ',
  fetch: '⤓',
  home: '←',
} as const;

const STACKER_SIMULATION_SCENARIO_LABELS: Record<StackerSimulationScenario, string> = {
  cycle: '循环',
  target: '目标位',
  movement: '全0运动',
  fault: '急停',
};

const MQTT_STATUS_LABELS = {
  disabled: '未启用',
  simulating: '本地模拟',
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
  error: '错误',
} as const;

type MqttConnectionTestViewState = {
  state: 'idle' | 'testing' | 'success' | 'error';
  message: string;
};

const MQTT_CONNECTION_TEST_IDLE: MqttConnectionTestViewState = {
  state: 'idle',
  message: '未测试',
};

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
  onBackToHome: () => void;
  transformTool: TransformTool;
  transformSpace: TransformSpace;
  snapSettings: TransformSnapSettings;
  gridSettings: EditorGridSettings;
  performanceHudVisible: boolean;
  onSetPerformanceHudVisible: (visible: boolean) => void;
  trajectoryVisible: boolean;
  onSetTrajectoryVisible: (visible: boolean) => void;
  onSetTransformTool: (tool: TransformTool) => void;
  onSetTransformSpace: (space: TransformSpace) => void;
  onSetSnapEnabled: (enabled: boolean) => void;
  onUpdateSnapSetting: (key: TransformSnapSettingKey, value: number) => void;
  onSetGridVisible: (visible: boolean) => void;
  onSetGridCellSize: (cellSizeMeters: EditorGridCellSize) => void;
  cameraOrientation: CameraOrientation;
  cameraProjection: CameraProjection;
  onToggleCameraStandardView: (orientation: StandardCameraOrientation) => void;
  onSetCameraProjection: (projection: CameraProjection) => void;
  onDeleteSelectedEntity: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSaveScene: () => void;
  onLoadScene: () => void;
  onOpenDigitalTwinPublish: () => void;
  digitalTwinPublishBusy: boolean;
  digitalTwinPublishProgress: DigitalTwinPublishProgress | null;
  onOpenDeploymentExport: () => void;
  deploymentExportStatus: DeploymentExportStatus;
  deploymentExportProgress: DeploymentExportViewProgress | null;
  deploymentExportBusy: boolean;
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
  /** 当前是否处于场景全屏（系统全屏或窗口内最大化）。 */
  sceneFullscreen: boolean;
  /** 切换 Scene 画布全屏显示。 */
  onToggleSceneFullscreen: () => void;
};

type ToolbarIconButtonProps = {
  active?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
};

/** Toolbar 图标按钮：完成后立刻失焦，避免快捷键被按钮抢走。 */
function ToolbarIconButton(props: ToolbarIconButtonProps) {
  return (
    <button
      aria-label={props.label}
      aria-pressed={props.active}
      className={props.active ? 'toolbar-button toolbar-icon-button active' : 'toolbar-button toolbar-icon-button'}
      disabled={props.disabled}
      onClick={(event) => {
        props.onClick();
        // 操作完成后把焦点交还画布，WASD/鼠标机位控制立即可用；
        // 弹窗类按钮打开后由弹窗自管焦点，弹窗关闭后焦点自然落回 body 而非按钮。
        event.currentTarget.blur();
      }}
      title={props.label}
      type="button"
    >
      <span aria-hidden="true">{props.icon}</span>
    </button>
  );
}

export function Toolbar(props: ToolbarProps) {
  const [mqttDraft, setMqttDraft] = useState<MqttConfig>(props.mqttConfig);
  const [mqttConnectionTestState, setMqttConnectionTestState] = useState<MqttConnectionTestViewState>(MQTT_CONNECTION_TEST_IDLE);
  const mqttConnectionTestHandleRef = useRef<MqttConnectionTestHandle | null>(null);
  const mqttConnectionTestCleanupRef = useRef<Promise<void>>(Promise.resolve());
  const mqttConnectionTestGenerationRef = useRef(0);
  const [jsonFieldsDrafts, setJsonFieldsDrafts] = useState<Record<number, string>>({});
  const [jsonFieldsErrors, setJsonFieldsErrors] = useState<Record<number, string>>({});
  const [previewSubscriptionIndex, setPreviewSubscriptionIndex] = useState(0);
  const [previewTopic, setPreviewTopic] = useState(props.mqttConfig.topic);
  const [previewPayload, setPreviewPayload] = useState('');
  const [previewResult, setPreviewResult] = useState<MqttPreviewResult | null>(null);
  const [fetchConfigDialogOpen, setFetchConfigDialogOpen] = useState(false);
  const [fetchDraft, setFetchDraft] = useState<FetchConfig>(props.fetchConfig);
  const isPreview = props.runtimeMode === 'preview';
  const deploymentExportProgress = props.deploymentExportProgress;
  const [previewError, setPreviewError] = useState('');
  const mqttRuntimeStatus = useSyncExternalStore(
    mqttRuntimeStatusStore.subscribe,
    mqttRuntimeStatusStore.getSnapshot,
    mqttRuntimeStatusStore.getSnapshot,
  );

  useEffect(() => {
    if (props.mqttConfigDialogOpen) {
      resetMqttConnectionTest();
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

  useEffect(() => () => {
    mqttConnectionTestGenerationRef.current += 1;
    void queueMqttConnectionTestCancellation();
  }, []);

  useEffect(() => {
    if (!props.mqttConfigDialogOpen) return;

    /** 弹窗打开后允许按 Esc 关闭，避免键盘用户被困在遮罩内。 */
    function handleWindowKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') handleCloseMqttConfigDialog();
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

  /** 将当前测试的物理清理串行化，供字段变化后的快速重测等待。 */
  function queueMqttConnectionTestCancellation(): Promise<void> {
    const previousHandle = mqttConnectionTestHandleRef.current;
    mqttConnectionTestHandleRef.current = null;
    if (!previousHandle) return mqttConnectionTestCleanupRef.current;

    const previousCleanup = mqttConnectionTestCleanupRef.current;
    const cleanup = (async () => {
      await previousCleanup;
      await previousHandle.cancel();
    })();
    mqttConnectionTestCleanupRef.current = cleanup.catch(() => undefined);
    return mqttConnectionTestCleanupRef.current;
  }

  /** 取消旧连接测试并恢复未测试状态，防止延迟结果覆盖新草稿。 */
  function resetMqttConnectionTest(): void {
    mqttConnectionTestGenerationRef.current += 1;
    void queueMqttConnectionTestCancellation();
    setMqttConnectionTestState(MQTT_CONNECTION_TEST_IDLE);
  }

  /** 关闭弹窗前取消临时连接，保证遮罩、Esc、取消和保存路径行为一致。 */
  function handleCloseMqttConfigDialog(): void {
    resetMqttConnectionTest();
    props.onCloseMqttConfig();
  }

  /** 使用未保存草稿测试 Broker 会话与全部有效 Topic 的 SUBACK。 */
  async function handleTestMqttConnection(): Promise<void> {
    if (props.readOnly) return;
    const generation = mqttConnectionTestGenerationRef.current + 1;
    mqttConnectionTestGenerationRef.current = generation;
    const config = sanitizeMqttConfig(mqttDraft);
    setMqttConnectionTestState({ state: 'testing', message: '连接测试中…' });

    await queueMqttConnectionTestCancellation();
    if (generation !== mqttConnectionTestGenerationRef.current) return;

    const handle = startMqttConnectionTest({
      requestId: crypto.randomUUID(),
      address: config.address,
      subscriptions: resolveMqttStackerSubscriptions(config).map(({ topic, qos }) => ({ topic, qos })),
    });
    if (generation !== mqttConnectionTestGenerationRef.current) {
      await handle.cancel();
      return;
    }
    mqttConnectionTestHandleRef.current = handle;

    const result: MqttConnectionTestResult = await handle.result;
    if (
      generation !== mqttConnectionTestGenerationRef.current
      || mqttConnectionTestHandleRef.current !== handle
    ) return;
    mqttConnectionTestHandleRef.current = null;
    if (result.status === 'success') {
      const message = result.message.startsWith('连接成功') ? result.message : `连接成功：${result.message}`;
      setMqttConnectionTestState({ state: 'success', message });
    } else if (result.status === 'error') {
      setMqttConnectionTestState({ state: 'error', message: `连接失败：${result.message}` });
    }
  }

  /** IP 变化时，如果地址仍是旧 IP 自动生成值，就同步生成新的默认 WebSocket 地址。 */
  function handleMqttIpChange(ip: string): void {
    resetMqttConnectionTest();
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


  /** 更新真实 Broker 地址并让旧测试结果失效。 */
  function handleMqttAddressChange(address: string): void {
    resetMqttConnectionTest();
    setMqttDraft((current) => ({ ...current, address }));
  }

  /** 更新兼容 Topic 并让旧测试结果失效。 */
  function handleMqttLegacyTopicChange(topic: string): void {
    resetMqttConnectionTest();
    setMqttDraft((current) => ({ ...current, topic }));
  }

  /** 新增一条 EPV 订阅，保持旧 topic 输入只作为兼容字段。 */
  function handleAddSubscription(): void {
    resetMqttConnectionTest();
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
    resetMqttConnectionTest();
    setMqttDraft((current) => ({ ...current, subscriptions: (current.subscriptions ?? []).filter((_, itemIndex) => itemIndex !== index) }));
    setJsonFieldsDrafts((current) => reindexRecordAfterRemoval(current, index));
    setJsonFieldsErrors((current) => reindexRecordAfterRemoval(current, index));
  }

  /** 更新指定订阅并立即归一化局部字段。 */
  function handleSubscriptionChange(index: number, patch: Partial<MqttSubscriptionConfig>): void {
    if (Object.hasOwn(patch, 'topic') || Object.hasOwn(patch, 'qos')) resetMqttConnectionTest();
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
    handleCloseMqttConfigDialog();
  }

  return (
    <header className="toolbar">
      <button
        aria-label={RETURN_TO_HOME_PAGE_LABEL}
        className="toolbar-button toolbar-home-button"
        onClick={(event) => {
          props.onBackToHome();
          event.currentTarget.blur();
        }}
        title={RETURN_TO_HOME_PAGE_LABEL}
        type="button"
      >
        <span aria-hidden="true">{TOOLBAR_ICONS.home}</span>
        返回
      </button>
      <strong aria-label={APPLICATION_NAME} className="toolbar-title">
        <BrandLogo className="toolbar-brand-logo" surface="dark" />
        <span className="toolbar-product-name">3D EDITOR</span>
      </strong>
      <div className="toolbar-scroll">
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
      <div className="toolbar-segment" aria-label="视图模式">
        <ToolbarIconButton
          active={props.cameraOrientation === 'top'}
          icon={TOOLBAR_ICONS.topView}
          label={props.cameraOrientation === 'top' ? '退出俯视视角' : '进入俯视视角'}
          onClick={() => props.onToggleCameraStandardView('top')}
        />
        <ToolbarIconButton
          active={props.cameraProjection === 'orthographic'}
          icon={TOOLBAR_ICONS.orthographic}
          label={props.cameraProjection === 'orthographic' ? '切换为透视投影' : '切换为正交投影'}
          onClick={() => props.onSetCameraProjection(props.cameraProjection === 'orthographic' ? 'perspective' : 'orthographic')}
        />
      </div>
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
      <label className="toolbar-checkbox" title="显示或隐藏 Scene View 性能监控">
        <input
          aria-label="性能监控"
          type="checkbox"
          checked={props.performanceHudVisible}
          onChange={(event) => props.onSetPerformanceHudVisible(event.target.checked)}
        />
        性能
      </label>
      <label className="toolbar-checkbox" title="显示输送线货物运行轨迹">
        <input
          type="checkbox"
          checked={props.trajectoryVisible}
          onChange={(event) => props.onSetTrajectoryVisible(event.target.checked)}
        />
        动画
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
      <ToolbarIconButton disabled={!props.canUndo} icon={TOOLBAR_ICONS.undo} label="撤销 (Ctrl+Z)" onClick={props.onUndo} />
      <ToolbarIconButton disabled={!props.canRedo} icon={TOOLBAR_ICONS.redo} label="重做" onClick={props.onRedo} />
      <ToolbarIconButton
        disabled={isPreview || Boolean(props.cadImportProgress?.active) || props.deploymentExportBusy}
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
        active={props.sceneFullscreen}
        icon={<FullscreenGlyph exit={props.sceneFullscreen} />}
        label={props.sceneFullscreen ? '退出全屏 (F11)' : '全屏显示场景 (F11)'}
        onClick={props.onToggleSceneFullscreen}
      />
      <ToolbarIconButton
        disabled={props.readOnly || Boolean(props.cadImportProgress?.active) || props.deploymentExportBusy}
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
        <ToolbarTaskProgress
          detail={props.cadImportProgress.detail}
          label={props.cadImportProgress.label}
          percent={props.cadImportProgress.percent}
        />
      ) : null}
      <ToolbarIconButton disabled={props.readOnly || props.digitalTwinPublishBusy} icon={TOOLBAR_ICONS.save} label="保存场景" onClick={props.onSaveScene} />
      <ToolbarIconButton disabled={props.readOnly || props.digitalTwinPublishBusy} icon={TOOLBAR_ICONS.load} label="加载场景" onClick={props.onLoadScene} />
      <ToolbarIconButton
        disabled={isPreview || Boolean(props.cadImportProgress?.active) || props.deploymentExportBusy || props.digitalTwinPublishBusy}
        icon={TOOLBAR_ICONS.publish}
        label="发布到数据中台"
        onClick={props.onOpenDigitalTwinPublish}
      />
      {props.digitalTwinPublishBusy && props.digitalTwinPublishProgress ? (
        <ToolbarTaskProgress
          detail={props.digitalTwinPublishProgress.detail}
          label="数字孪生发布"
          percent={props.digitalTwinPublishProgress.percent}
        />
      ) : null}
      <ToolbarIconButton
        disabled={isPreview || Boolean(props.cadImportProgress?.active) || props.deploymentExportBusy || props.digitalTwinPublishBusy}
        icon={TOOLBAR_ICONS.deployment}
        label="导出离线部署包"
        onClick={props.onOpenDeploymentExport}
      />
      {props.deploymentExportBusy && deploymentExportProgress ? (
        <ToolbarTaskProgress
          detail={createDeploymentToolbarDetail(deploymentExportProgress)}
          label={getDeploymentStageLabel(deploymentExportProgress.stage, props.deploymentExportStatus)}
          percent={deploymentExportProgress.percent}
        />
      ) : null}
      </div>
      {props.mqttConfigDialogOpen ? (
        <div
          className="mqtt-config-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) handleCloseMqttConfigDialog();
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
            <p
              aria-live="polite"
              className={`mqtt-connection-test-status mqtt-connection-test-status-${mqttConnectionTestState.state}`}
              role="status"
            >
              当前连接状态：{mqttConnectionTestState.message}
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
                onChange={(event) => handleMqttAddressChange(event.target.value)}
              />
            </label>
            <label className="mqtt-config-dialog-row">
              <span>Legacy Topic</span>
              <input
                placeholder="dt/factory/logistics/stacker/+/twindatadriven/joint"
                value={mqttDraft.topic}
                onChange={(event) => handleMqttLegacyTopicChange(event.target.value)}
              />
            </label>
            <div className="mqtt-connection-test-actions">
              <button
                aria-label="测试 MQTT 连接"
                disabled={props.readOnly || mqttConnectionTestState.state === 'testing'}
                onClick={handleTestMqttConnection}
                type="button"
              >
                {mqttConnectionTestState.state === 'testing' ? '测试中…' : '测试连接'}
              </button>
            </div>
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
              <button type="button" onClick={handleCloseMqttConfigDialog}>取消</button>
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
