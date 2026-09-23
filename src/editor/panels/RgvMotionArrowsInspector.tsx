import { useEffect, useState, useSyncExternalStore } from 'react';
import { isConveyorArrowEffectKind } from '../model/conveyorArrowEffect';
import { CONVEYOR_SURFACE_ARROW_STYLES, isConveyorSurfaceArrowStyle } from '../model/conveyorSurfaceArrows';
import {
  createDefaultRgvMotionArrowsConfig, normalizeRgvMotionArrowsConfig,
  RGV_MOTION_ARROW_CHANNELS, type RgvMotionArrowChannel,
  type RgvMotionArrowChannelConfig, type RgvMotionArrowsConfig,
} from '../model/rgvMotionArrows';
import { useEditorStore } from '../store/editorStore';
import { rgvMotionArrowSession, type RgvMotionArrowPreview } from '../../runtime/rgvMotionArrowSession';
import { BUILT_IN_ASSET_DRAG_MIME_TYPE } from '../assets/AssetDatabase';
import { readConveyorSurfaceArrowStyleDrop } from '../assets/conveyorSurfaceArrowDrag';
import { getPoiEffectDefinition } from '../model/poiEffect';

type Props = {
  entityId: string;
  config: RgvMotionArrowsConfig | undefined;
  disabled: boolean;
  onChange: (config: RgvMotionArrowsConfig) => void;
};

const CHANNEL_LABELS: Record<RgvMotionArrowChannel, string> = {
  travel: '行走', front: '前工位', back: '后工位',
};

function NumberField(props: {
  label: string; value: number; min: number; max: number; step?: number;
  disabled: boolean; onChange: (value: number) => void;
}) {
  return <label className="number-row"><span>{props.label}</span><input
    type="number" min={props.min} max={props.max} step={props.step ?? 0.01}
    disabled={props.disabled} value={props.value}
    onChange={(event) => {
      if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber)) props.onChange(event.target.valueAsNumber);
    }}
  /></label>;
}

function ChannelInspector(props: {
  entityId: string;
  channel: RgvMotionArrowChannel;
  config: RgvMotionArrowChannelConfig;
  disabled: boolean;
  onChange: (patch: Partial<RgvMotionArrowChannelConfig>) => void;
}) {
  const { entityId, channel, config } = props;
  const label = CHANNEL_LABELS[channel];
  const [surfaceNode, setSurfaceNode] = useState(config.surfaceNode);
  const preview = useSyncExternalStore(rgvMotionArrowSession.subscribe,
    () => rgvMotionArrowSession.getPreview(entityId, channel), () => null);
  const diagnostic = useSyncExternalStore(rgvMotionArrowSession.subscribe,
    () => rgvMotionArrowSession.getDiagnostic(entityId, channel), () => '');
  useEffect(() => { setSurfaceNode(config.surfaceNode); }, [config.surfaceNode]);
  useEffect(() => {
    if (!config.enabled || props.disabled) rgvMotionArrowSession.setPreview(entityId, channel, null);
    return () => { rgvMotionArrowSession.setPreview(entityId, channel, null); };
  }, [entityId, channel, config.enabled, props.disabled]);
  const disabled = props.disabled || !config.enabled;
  const numberProps = { disabled };
  function choosePreview(direction: RgvMotionArrowPreview): void {
    if (!disabled) rgvMotionArrowSession.setPreview(entityId, channel, direction);
  }
  return (
    <div className="model-generator-rule-card" data-testid={`rgv-motion-arrow-${channel}`}>
      <label className="mqtt-config-dialog-checkbox"><input type="checkbox" disabled={props.disabled}
        checked={config.enabled} onChange={(event) => props.onChange({ enabled: event.target.checked })} />启用{label}箭头</label>
      <details>
        <summary>{label}挂点与范围</summary>
        <label className="inspector-row"><span>{label}部件</span><input disabled={disabled}
          value={surfaceNode} placeholder={channel === 'travel' ? '自动识别固定轨道，可填轨道节点名' : '自动识别，可填部件节点名'}
          onChange={(event) => setSurfaceNode(event.target.value)}
          onBlur={() => { if (surfaceNode !== config.surfaceNode) props.onChange({ surfaceNode }); }}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
        {channel !== 'travel' && <label className="inspector-row"><span>显示面</span><select disabled={disabled} value={config.face}
          onChange={(event) => props.onChange({ face: event.target.value === 'side' ? 'side' : 'top' })}>
          <option value="top">顶面</option><option value="side">侧面</option>
        </select></label>}
        {channel === 'travel' ? <p className="muted">行走箭头位于轨道正上方，沿两条轨道之间的中心线覆盖全长，不随车体平移；车体经过时正常遮挡。长度和中心位置自动匹配固定轨道，可调整宽度与离面距离。未声明固定轨道时可填写轨道节点校准。</p>
          : <p className="muted">挂点留空时自动识别对应工位台面并随车移动。顶面被货物遮挡时，可调整横向偏移，或切换侧面校准。</p>}
        <NumberField {...numberProps} label="离面距离(m)" value={config.surfaceOffset} min={0} max={10} step={0.005} onChange={(surfaceOffset) => props.onChange({ surfaceOffset })} />
        {channel !== 'travel' && <NumberField {...numberProps} label="长度(m，0自动)" value={config.length} min={0} max={10000} onChange={(length) => props.onChange({ length })} />}
        <NumberField {...numberProps} label="宽度(m，0自动)" value={config.width} min={0} max={10000} onChange={(width) => props.onChange({ width })} />
        {channel !== 'travel' && <NumberField {...numberProps} label="沿运动偏移(m)" value={config.offsetAlong} min={-10000} max={10000} onChange={(offsetAlong) => props.onChange({ offsetAlong })} />}
        {channel !== 'travel' && <NumberField {...numberProps} label="横向偏移(m)" value={config.offsetAcross} min={-10000} max={10000} onChange={(offsetAcross) => props.onChange({ offsetAcross })} />}
        <label className="mqtt-config-dialog-checkbox"><input type="checkbox" disabled={disabled} checked={config.reverse}
          onChange={(event) => props.onChange({ reverse: event.target.checked })} />反转箭头方向</label>
        <p className="muted">尺寸使用模型局部米并随模型缩放。反转仅用于校准箭头，不改变设备运动。</p>
      </details>
      <div className="model-generator-inline-actions" role="group" aria-label={`${label}箭头编辑预览`}>
        <button type="button" disabled={disabled} aria-pressed={preview === 1} onClick={() => choosePreview(1)}>正向</button>
        <button type="button" disabled={disabled} aria-pressed={preview === -1} onClick={() => choosePreview(-1)}>反向</button>
        <button type="button" disabled={disabled} aria-pressed={preview === 0} onClick={() => choosePreview(0)}>停止</button>
        <button type="button" disabled={disabled || preview === null} onClick={() => choosePreview(null)}>结束预览</button>
      </div>
      <p className="muted" role="status" aria-live="polite">{label}状态：{diagnostic || (config.enabled ? '等待预览或运行数据' : '未启用')}</p>
    </div>
  );
}

/** 通过原遥测绑定命令保存外观和挂点；三路预览独立存放在当前编辑会话。 */
export function RgvMotionArrowsInspector(props: Props) {
  const config = props.config ?? createDefaultRgvMotionArrowsConfig();
  const runtimeMode = useEditorStore((state) => state.runtimeMode);
  const sceneSessionId = useEditorStore((state) => state.sceneSessionId);
  const [dragActive, setDragActive] = useState(false);
  const [dropMessage, setDropMessage] = useState('');
  useEffect(() => { setDragActive(false); setDropMessage(''); }, [props.entityId, sceneSessionId]);
  useEffect(() => {
    const clearPreview = () => {
      for (const channel of RGV_MOTION_ARROW_CHANNELS) rgvMotionArrowSession.setPreview(props.entityId, channel, null);
    };
    clearPreview();
    return clearPreview;
  }, [props.entityId, sceneSessionId, runtimeMode, config.enabled]);

  const editingDisabled = props.disabled || runtimeMode !== 'edit';
  const disabled = editingDisabled || !config.enabled;
  function commit(patch: Partial<RgvMotionArrowsConfig>): void {
    if (editingDisabled) return;
    const next = normalizeRgvMotionArrowsConfig({ ...config, ...patch });
    if (next) props.onChange(next);
  }
  const fullStripStyle = isConveyorArrowEffectKind(config.style);
  const repeatedStyle = !fullStripStyle || ['conveyor-arrow-chevron', 'conveyor-arrow-segmented', 'conveyor-arrow-double'].includes(config.style);
  const numberProps = { disabled };

  return (
    <fieldset className="transform-fieldset" data-testid="rgv-motion-arrows">
      <legend>RGV 运动箭头</legend>
      <label className="mqtt-config-dialog-checkbox"><input type="checkbox" disabled={editingDisabled} checked={config.enabled}
        onChange={(event) => commit({ enabled: event.target.checked })} />启用运动箭头</label>
      <p className="muted">行走、前工位、后工位三路箭头继承当前设备绑定。行走按车体实际连续运动显示，固定在轨道正上方；工位按已确定的取放货方向显示并随车移动。正常停止后淡出，故障、数据过期或绑定冲突时立即隐藏。</p>
      {config.enabled ? <>
        <div data-testid="rgv-motion-arrow-style-drop"
          className={dragActive ? 'model-generator-target-slot model-generator-target-slot-active' : 'model-generator-target-slot'}
          aria-label="RGV箭头样式拖放区"
          onDragOver={(event) => {
            event.preventDefault(); event.stopPropagation();
            const accepted = !disabled && event.dataTransfer.types.includes(BUILT_IN_ASSET_DRAG_MIME_TYPE)
              && !event.dataTransfer.types.includes('Files');
            event.dataTransfer.dropEffect = accepted ? 'copy' : 'none';
            setDragActive(accepted);
          }}
          onDragLeave={(event) => {
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragActive(false);
          }}
          onDrop={(event) => {
            event.preventDefault(); event.stopPropagation(); setDragActive(false);
            const style = readConveyorSurfaceArrowStyleDrop(event.dataTransfer, disabled);
            if (style) { commit({ style }); setDropMessage(`已应用${getPoiEffectDefinition(style).name}样式`); }
            else if (!disabled) setDropMessage('仅接受特效库中的箭头样式。');
          }}>
          <span className="model-generator-target-text" style={{ gridColumn: '1 / -1' }}><strong>箭头样式：{getPoiEffectDefinition(config.style).name}</strong><small>从特效库拖入箭头卡片；三路共用样式，保留颜色、尺寸与挂点</small></span>
        </div>
        <label className="inspector-row"><span>箭头样式</span><select disabled={disabled} value={config.style}
          onChange={(event) => { if (isConveyorSurfaceArrowStyle(event.target.value)) commit({ style: event.target.value }); }}>
          {CONVEYOR_SURFACE_ARROW_STYLES.map(style => <option key={style} value={style}>{getPoiEffectDefinition(style).name}</option>)}
        </select></label>
        {dropMessage ? <p className="muted" role="status">{dropMessage}</p> : null}
        <details>
          <summary>共用外观与动画</summary>
          <label className="inspector-row"><span>箭头颜色</span><input type="color" disabled={disabled} value={config.color} onChange={(event) => commit({ color: event.target.value })} /></label>
          <NumberField {...numberProps} label="发光强度" value={config.intensity} min={0} max={10} step={0.1} onChange={(intensity) => commit({ intensity })} />
          <NumberField {...numberProps} label="透明度" value={config.opacity} min={0} max={1} step={0.05} onChange={(opacity) => commit({ opacity })} />
          {!fullStripStyle && <NumberField {...numberProps} label="箭头长度(m)" value={config.arrowLength} min={0.02} max={100} onChange={(arrowLength) => commit({ arrowLength })} />}
          <NumberField {...numberProps} label="箭头宽度(m)" value={config.arrowWidth} min={0.02} max={100} onChange={(arrowWidth) => commit({ arrowWidth })} />
          {repeatedStyle && <NumberField {...numberProps} label={fullStripStyle ? '目标间距(m)' : '中心间距(m)'} value={config.spacing} min={fullStripStyle ? 0.04 : config.arrowLength + 0.02} max={10000} onChange={(spacing) => commit({ spacing })} />}
          <NumberField {...numberProps} label={fullStripStyle ? '流动速度（倍率）' : '流动速度(m/s)'} value={config.speed} min={0} max={100} onChange={(speed) => commit({ speed })} />
          <label className="mqtt-config-dialog-checkbox"><input type="checkbox" disabled={disabled} checked={config.breathingEnabled} onChange={(event) => commit({ breathingEnabled: event.target.checked })} />启用呼吸效果</label>
          <NumberField {...numberProps} disabled={disabled || !config.breathingEnabled} label="呼吸周期(s)" value={config.breathingPeriod} min={0.25} max={30} step={0.05} onChange={(breathingPeriod) => commit({ breathingPeriod })} />
          <NumberField {...numberProps} disabled={disabled || !config.breathingEnabled} label="呼吸强度" value={config.breathingStrength} min={0} max={1} step={0.05} onChange={(breathingStrength) => commit({ breathingStrength })} />
          <p className="muted">流动速度只影响视觉动画；为 0 时停止流动。默认关闭呼吸，设备停止后箭头仍会隐藏。</p>
        </details>
        <p className="muted">预览只显示箭头，不移动模型。三路可以同时预览；切换模型、场景或运行模式后结束，不保存到场景。</p>
        {RGV_MOTION_ARROW_CHANNELS.map(channel => <ChannelInspector key={`${sceneSessionId}:${props.entityId}:${channel}`}
          entityId={props.entityId} channel={channel} config={config.channels[channel]} disabled={disabled}
          onChange={(patch) => commit({ channels: { ...config.channels, [channel]: { ...config.channels[channel], ...patch } } })} />)}
      </> : null}
    </fieldset>
  );
}

