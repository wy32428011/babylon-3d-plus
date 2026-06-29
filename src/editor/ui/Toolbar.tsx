import type {
  EditorCameraSettings,
  EditorCameraViewRangeKey,
  EditorGridCellSize,
  EditorGridSettings,
} from '../../runtime/babylon/createEngine';
import { EDITOR_CAMERA_VIEW_RANGES, EDITOR_GRID_CELL_SIZES } from '../../runtime/babylon/createEngine';
import type {
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
} as const;

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
      <ToolbarIconButton icon={TOOLBAR_ICONS.save} label="保存场景" onClick={props.onSaveScene} />
      <ToolbarIconButton icon={TOOLBAR_ICONS.load} label="加载场景" onClick={props.onLoadScene} />
    </header>
  );
}
