import { useEffect, useState, type FormEvent } from 'react';
import type {
  EditorCameraSettings,
  EditorCameraViewRangeKey,
  EditorGridCellSize,
  EditorGridSettings,
} from '../../runtime/babylon/createEngine';
import { EDITOR_CAMERA_VIEW_RANGES, EDITOR_GRID_CELL_SIZES } from '../../runtime/babylon/createEngine';
import {
  STACKER_SIMULATION_SCENARIOS,
  createMqttAddressFromIp,
  sanitizeMqttConfig,
  type MqttConfig,
  type StackerSimulationScenario,
} from '../model/SceneDocument';
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
  delete: '⌫',
  undo: '↶',
  redo: '↷',
  save: '💾',
  load: '📂',
  cad: '▧',
  mqtt: 'MQ',
} as const;

const STACKER_SIMULATION_SCENARIO_LABELS: Record<StackerSimulationScenario, string> = {
  cycle: '循环',
  target: '目标位',
  movement: '全0运动',
  fault: '急停',
};

type ToolbarProps = {
  transformTool: TransformTool;
  transformSpace: TransformSpace;
  snapSettings: TransformSnapSettings;
  gridSettings: EditorGridSettings;
  cameraSettings: EditorCameraSettings;
  onSetTransformTool: (tool: TransformTool) => void;
  onSetTransformSpace: (space: TransformSpace) => void;
  onSetSnapEnabled: (enabled: boolean) => void;
  onUpdateSnapSetting: (key: TransformSnapSettingKey, value: number) => void;
  onSetGridVisible: (visible: boolean) => void;
  onSetGridCellSize: (cellSizeMeters: EditorGridCellSize) => void;
  onSetCameraViewRange: (viewRangeKey: EditorCameraViewRangeKey) => void;
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
  cadImportProgress: CadImportProgress | null;
  canDelete: boolean;
  canUndo: boolean;
  canRedo: boolean;
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

  useEffect(() => {
    if (props.mqttConfigDialogOpen) {
      setMqttDraft(props.mqttConfig);
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

  /** 将下拉框字符串转换为受支持的相机视野档位，避免 Toolbar 传出未知档位。 */
  function handleCameraViewRangeChange(rawValue: string): void {
    const nextRange = EDITOR_CAMERA_VIEW_RANGES.find((range) => range.key === rawValue);
    if (!nextRange) return;

    props.onSetCameraViewRange(nextRange.key);
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

  /** 保存前再次归一化，保证只填 IP 时也能落成完整 MQTT over WebSocket 地址。 */
  function handleMqttConfigSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    props.onSaveMqttConfig(sanitizeMqttConfig(mqttDraft));
    props.onCloseMqttConfig();
  }

  return (
    <header className="toolbar">
      <strong className="toolbar-title">Babylon Unity-like Editor</strong>
      <ToolbarIconButton
        active={props.transformTool === 'translate'}
        icon={TOOLBAR_ICONS.translate}
        label={TRANSFORM_TOOL_LABELS.translate}
        onClick={() => props.onSetTransformTool('translate')}
      />
      <ToolbarIconButton
        active={props.transformTool === 'rotate'}
        icon={TOOLBAR_ICONS.rotate}
        label={TRANSFORM_TOOL_LABELS.rotate}
        onClick={() => props.onSetTransformTool('rotate')}
      />
      <ToolbarIconButton
        active={props.transformTool === 'scale'}
        icon={TOOLBAR_ICONS.scale}
        label={TRANSFORM_TOOL_LABELS.scale}
        onClick={() => props.onSetTransformTool('scale')}
      />
      <div className="toolbar-segment" aria-label="变换坐标空间">
        <ToolbarIconButton
          active={props.transformSpace === 'local'}
          icon={TOOLBAR_ICONS.local}
          label={TRANSFORM_SPACE_LABELS.local}
          onClick={() => props.onSetTransformSpace('local')}
        />
        <ToolbarIconButton
          active={props.transformSpace === 'global'}
          icon={TOOLBAR_ICONS.global}
          label={TRANSFORM_SPACE_LABELS.global}
          onClick={() => props.onSetTransformSpace('global')}
        />
      </div>
      <label className="toolbar-checkbox">
        <input
          type="checkbox"
          checked={props.snapSettings.enabled}
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
      <label className="toolbar-select">
        <span>视野</span>
        <select
          value={props.cameraSettings.viewRangeKey}
          onChange={(event) => handleCameraViewRangeChange(event.target.value)}
        >
          {EDITOR_CAMERA_VIEW_RANGES.map((range) => (
            <option key={range.key} value={range.key}>
              {range.label}
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
          onChange={(event) => handleSnapSettingChange('scale', event.target.value)}
        />
      </label>
      <ToolbarIconButton disabled={!props.canDelete} icon={TOOLBAR_ICONS.delete} label="删除" onClick={props.onDeleteSelectedEntity} />
      <ToolbarIconButton disabled={!props.canUndo} icon={TOOLBAR_ICONS.undo} label="撤销" onClick={props.onUndo} />
      <ToolbarIconButton disabled={!props.canRedo} icon={TOOLBAR_ICONS.redo} label="重做" onClick={props.onRedo} />
      <ToolbarIconButton
        disabled={Boolean(props.cadImportProgress?.active)}
        icon={TOOLBAR_ICONS.cad}
        label="导入CAD参考图"
        onClick={props.onImportCadReference}
      />
      <ToolbarIconButton
        active={props.mqttConfig.enabled}
        icon={TOOLBAR_ICONS.mqtt}
        label="配置 MQTT 与本地模拟"
        onClick={props.onOpenMqttConfig}
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
      <ToolbarIconButton icon={TOOLBAR_ICONS.save} label="保存场景" onClick={props.onSaveScene} />
      <ToolbarIconButton icon={TOOLBAR_ICONS.load} label="加载场景" onClick={props.onLoadScene} />
      {props.mqttConfigDialogOpen ? (
        <div
          className="mqtt-config-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) props.onCloseMqttConfig();
          }}
        >
          <form
            aria-label="MQTT 地址配置"
            className="mqtt-config-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={handleMqttConfigSubmit}
            role="dialog"
          >
            <h3>MQTT 配置</h3>
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
                step="100"
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
              <span>Topic</span>
              <input
                placeholder="dt/factory/logistics/stacker/+/twindatadriven/joint"
                value={mqttDraft.topic}
                onChange={(event) => setMqttDraft((current) => ({ ...current, topic: event.target.value }))}
              />
            </label>
            <div className="mqtt-config-dialog-actions">
              <button type="button" onClick={props.onCloseMqttConfig}>取消</button>
              <button className="mqtt-config-dialog-primary" type="submit">保存</button>
            </div>
          </form>
        </div>
      ) : null}
    </header>
  );
}
