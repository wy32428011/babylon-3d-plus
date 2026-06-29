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

type ToolbarProps = {
  transformTool: TransformTool;
  transformSpace: TransformSpace;
  snapSettings: TransformSnapSettings;
  onSetTransformTool: (tool: TransformTool) => void;
  onSetTransformSpace: (space: TransformSpace) => void;
  onSetSnapEnabled: (enabled: boolean) => void;
  onUpdateSnapSetting: (key: TransformSnapSettingKey, value: number) => void;
  onCreateCube: () => void;
  onCreateSphere: () => void;
  onCreatePlane: () => void;
  onCreateHemisphericLight: () => void;
  onCreateDirectionalLight: () => void;
  onCreatePointLight: () => void;
  onDeleteSelectedEntity: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSaveScene: () => void;
  onLoadScene: () => void;
  canDelete: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

export function Toolbar(props: ToolbarProps) {
  /** 将数字输入转为有效吸附步长，非法输入交由 store 保持原值。 */
  function handleSnapSettingChange(key: TransformSnapSettingKey, rawValue: string): void {
    if (rawValue === '') return;

    const nextValue = Number(rawValue);
    if (!Number.isFinite(nextValue)) return;

    props.onUpdateSnapSetting(key, nextValue);
  }

  return (
    <header className="toolbar">
      <strong className="toolbar-title">Babylon Unity-like Editor</strong>
      <button
        className={props.transformTool === 'translate' ? 'toolbar-button active' : 'toolbar-button'}
        onClick={() => props.onSetTransformTool('translate')}
      >
        {TRANSFORM_TOOL_LABELS.translate}
      </button>
      <button
        className={props.transformTool === 'rotate' ? 'toolbar-button active' : 'toolbar-button'}
        onClick={() => props.onSetTransformTool('rotate')}
      >
        {TRANSFORM_TOOL_LABELS.rotate}
      </button>
      <button
        className={props.transformTool === 'scale' ? 'toolbar-button active' : 'toolbar-button'}
        onClick={() => props.onSetTransformTool('scale')}
      >
        {TRANSFORM_TOOL_LABELS.scale}
      </button>
      <div className="toolbar-segment" aria-label="变换坐标空间">
        <button
          className={props.transformSpace === 'local' ? 'toolbar-button active' : 'toolbar-button'}
          onClick={() => props.onSetTransformSpace('local')}
        >
          {TRANSFORM_SPACE_LABELS.local}
        </button>
        <button
          className={props.transformSpace === 'global' ? 'toolbar-button active' : 'toolbar-button'}
          onClick={() => props.onSetTransformSpace('global')}
        >
          {TRANSFORM_SPACE_LABELS.global}
        </button>
      </div>
      <label className="toolbar-checkbox">
        <input
          type="checkbox"
          checked={props.snapSettings.enabled}
          onChange={(event) => props.onSetSnapEnabled(event.target.checked)}
        />
        吸附
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
      <button onClick={props.onCreateCube}>创建立方体</button>
      <button onClick={props.onCreateSphere}>创建球体</button>
      <button onClick={props.onCreatePlane}>创建平面</button>
      <button onClick={props.onCreateHemisphericLight}>创建半球光</button>
      <button onClick={props.onCreateDirectionalLight}>创建方向光</button>
      <button onClick={props.onCreatePointLight}>创建点光源</button>
      <button onClick={props.onDeleteSelectedEntity} disabled={!props.canDelete}>删除</button>
      <button onClick={props.onUndo} disabled={!props.canUndo}>撤销</button>
      <button onClick={props.onRedo} disabled={!props.canRedo}>重做</button>
      <button onClick={props.onSaveScene}>保存场景</button>
      <button onClick={props.onLoadScene}>加载场景</button>
    </header>
  );
}
