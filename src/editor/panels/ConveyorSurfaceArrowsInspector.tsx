import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  createDefaultConveyorSurfaceArrowsConfig,
  normalizeConveyorSurfaceArrowsConfig,
  type ConveyorSurfaceArrowsConfig,
} from '../model/conveyorSurfaceArrows';
import { useEditorStore } from '../store/editorStore';
import { conveyorSurfaceArrowSession, type ConveyorSurfaceArrowPreview } from '../../runtime/conveyorSurfaceArrowSession';

type Props = {
  entityId: string;
  config: ConveyorSurfaceArrowsConfig | undefined;
  disabled: boolean;
  trajectoryDirection: 'x' | '-x' | 'z' | '-z';
  onChange: (config: ConveyorSurfaceArrowsConfig) => void;
};

type NumberFieldProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled: boolean;
  onChange: (value: number) => void;
};

function NumberField(props: NumberFieldProps) {
  return (
    <label className="number-row">
      <span>{props.label}</span>
      <input
        type="number" min={props.min} max={props.max} step={props.step ?? 0.01}
        disabled={props.disabled} value={props.value}
        onChange={(event) => {
          if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber)) props.onChange(event.target.valueAsNumber);
        }}
      />
    </label>
  );
}

/** 参数走原遥测绑定编辑命令；临时预览及诊断使用独立会话，不污染场景快照。 */
export function ConveyorSurfaceArrowsInspector(props: Props) {
  const config = props.config ?? createDefaultConveyorSurfaceArrowsConfig();
  const runtimeMode = useEditorStore((state) => state.runtimeMode);
  const sceneId = useEditorStore((state) => state.scene.id);
  const preview = useSyncExternalStore(
    conveyorSurfaceArrowSession.subscribe,
    () => conveyorSurfaceArrowSession.getPreview(props.entityId),
    () => null,
  );
  const diagnostic = useSyncExternalStore(
    conveyorSurfaceArrowSession.subscribe,
    () => conveyorSurfaceArrowSession.getDiagnostic(props.entityId),
    () => '',
  );
  const [surfaceNode, setSurfaceNode] = useState(config.surfaceNode);

  useEffect(() => { setSurfaceNode(config.surfaceNode); }, [props.entityId, config.surfaceNode]);
  useEffect(() => {
    conveyorSurfaceArrowSession.setPreview(props.entityId, null);
    return () => { conveyorSurfaceArrowSession.setPreview(props.entityId, null); };
  }, [props.entityId, sceneId, runtimeMode, config.enabled]);

  function commit(patch: Partial<ConveyorSurfaceArrowsConfig>): void {
    const next = normalizeConveyorSurfaceArrowsConfig({ ...config, ...patch });
    if (next) props.onChange(next);
  }

  function choosePreview(direction: ConveyorSurfaceArrowPreview): void {
    if (runtimeMode === 'edit' && config.enabled && !props.disabled) {
      conveyorSurfaceArrowSession.setPreview(props.entityId, direction);
    }
  }

  const disabled = props.disabled || !config.enabled;
  const previewDisabled = disabled || runtimeMode !== 'edit';
  const numberProps = { disabled };

  return (
    <fieldset className="transform-fieldset" data-testid="conveyor-surface-arrows">
      <legend>表面箭头</legend>
      <label className="mqtt-config-dialog-checkbox">
        <input type="checkbox" disabled={props.disabled} checked={config.enabled} onChange={(event) => commit({ enabled: event.target.checked })} />
        启用表面箭头
      </label>
      <p className="muted">正向校准：模型局部 {props.trajectoryDirection.startsWith('-') ? props.trajectoryDirection : `+${props.trajectoryDirection}`}。行走轴以模型声明为准，“轨迹方向”应与行走轴匹配。运行时继承本模型设备绑定和方向映射，停止、故障或数据过期时隐藏。</p>
      {config.enabled ? (
        <>
          <label className="inspector-row">
            <span>输送面部件</span>
            <input
              disabled={disabled} value={surfaceNode} placeholder="自动识别，可填部件节点名"
              onChange={(event) => setSurfaceNode(event.target.value)}
              onBlur={() => commit({ surfaceNode })}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
            />
          </label>
          <p className="muted">留空优先使用模型输送面信息及输送节点范围；指定节点时沿该部件局部顶面放置。护栏或电机高于输送面时，请指定输送部件并校准范围。尺寸使用模型局部米，随模型缩放。</p>
          <NumberField {...numberProps} label="表面上浮(m)" value={config.surfaceOffset} min={0} max={10} step={0.005} onChange={(surfaceOffset) => commit({ surfaceOffset })} />
          <details>
            <summary>覆盖范围与位置</summary>
            <p className="muted">长宽为 0 时自动适配；长度沿轨迹方向、宽度沿横向。首尾留白使箭头避开输送线端部。</p>
            <NumberField {...numberProps} label="长度(m，0自动)" value={config.length} min={0} max={10000} onChange={(length) => commit({ length })} />
            <NumberField {...numberProps} label="宽度(m，0自动)" value={config.width} min={0} max={10000} onChange={(width) => commit({ width })} />
            <NumberField {...numberProps} label="首尾留白(m)" value={config.endMargin} min={0} max={10000} onChange={(endMargin) => commit({ endMargin })} />
            <NumberField {...numberProps} label="沿线偏移(m)" value={config.offsetAlong} min={-10000} max={10000} onChange={(offsetAlong) => commit({ offsetAlong })} />
            <NumberField {...numberProps} label="横向偏移(m)" value={config.offsetAcross} min={-10000} max={10000} onChange={(offsetAcross) => commit({ offsetAcross })} />
          </details>
          <details>
            <summary>箭头外观与动画</summary>
            <label className="inspector-row"><span>箭头颜色</span><input type="color" disabled={disabled} value={config.color} onChange={(event) => commit({ color: event.target.value })} /></label>
            <NumberField {...numberProps} label="透明度" value={config.opacity} min={0} max={1} step={0.05} onChange={(opacity) => commit({ opacity })} />
            <NumberField {...numberProps} label="箭头长度(m)" value={config.arrowLength} min={0.02} max={100} onChange={(arrowLength) => commit({ arrowLength })} />
            <NumberField {...numberProps} label="箭头宽度(m)" value={config.arrowWidth} min={0.02} max={100} onChange={(arrowWidth) => commit({ arrowWidth })} />
            <NumberField {...numberProps} label="中心间距(m)" value={config.spacing} min={config.arrowLength + 0.02} max={10000} onChange={(spacing) => commit({ spacing })} />
            <NumberField {...numberProps} label="流动速度(m/s)" value={config.speed} min={0} max={100} onChange={(speed) => commit({ speed })} />
            <p className="muted">中心间距至少比箭头长度大 0.02 米。速度仅影响视觉动画，0 为静止显示；设备停止时仍隐藏。</p>
          </details>
          <div className="telemetry-runtime-diagnostics">
            <strong>编辑预览</strong>
            <div className="model-generator-inline-actions" role="group" aria-label="表面箭头编辑预览">
              <button type="button" disabled={previewDisabled} aria-pressed={preview === 1} onClick={() => choosePreview(1)}>正向</button>
              <button type="button" disabled={previewDisabled} aria-pressed={preview === -1} onClick={() => choosePreview(-1)}>反向</button>
              <button type="button" disabled={previewDisabled} aria-pressed={preview === 0} onClick={() => choosePreview(0)}>停止</button>
              <button type="button" disabled={previewDisabled || preview === null} onClick={() => choosePreview(null)}>结束预览</button>
            </div>
            <p className="muted">仅主动预览时显示；切换模型或运行模式后结束，不保存到场景。运行预览和 Viewer 使用真实设备状态。</p>
          </div>
        </>
      ) : null}
      <p className="muted" role="status" aria-live="polite">箭头状态：{diagnostic || (config.enabled ? '等待预览或运行数据' : '未启用')}</p>
      <p className="muted">旧 YZJ 模型可保留自带箭头；若检测到已有方向箭头，将优先保留原显示并给出诊断，避免重复叠加。</p>
    </fieldset>
  );
}
