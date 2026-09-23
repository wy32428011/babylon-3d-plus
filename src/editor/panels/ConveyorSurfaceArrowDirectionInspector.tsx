import { useEffect, useState } from 'react';
import { getConveyorSurfaceArrowDirectionError, type ConveyorSurfaceArrowsConfig } from '../model/conveyorSurfaceArrows';

type DirectionBinding = ConveyorSurfaceArrowsConfig['directionBinding'];
type Props = {
  value: DirectionBinding;
  disabled: boolean;
  onChange: (binding: DirectionBinding) => void;
};

/** 多个方向值作为一个草稿提交，避免交换正反编码时把中间冲突状态写进场景。 */
export function ConveyorSurfaceArrowDirectionInspector(props: Props) {
  const [draft, setDraft] = useState<DirectionBinding>(() => ({ ...props.value }));
  const savedSignature = JSON.stringify(props.value);
  useEffect(() => { setDraft({ ...props.value }); }, [savedSignature]);
  const error = getConveyorSurfaceArrowDirectionError(draft);
  const changed = JSON.stringify(draft) !== savedSignature;

  function update(patch: Partial<DirectionBinding>): void {
    setDraft((value) => ({ ...value, ...patch }));
  }

  return (
    <details data-testid="conveyor-surface-arrow-direction">
      <summary>MQTT 箭头方向</summary>
      <label className="inspector-row">
        <span>方向来源</span>
        <select aria-label="方向来源" disabled={props.disabled} value={draft.mode} onChange={(event) => update({ mode: event.target.value as DirectionBinding['mode'] })}>
          <option value="model">继承模型映射</option>
          <option value="point">指定 MQTT 点位(p)</option>
        </select>
      </label>
      {draft.mode === 'point' ? (
        <>
          <label className="inspector-row"><span>方向点位(p)</span><input disabled={props.disabled} maxLength={512} value={draft.field} onChange={(event) => update({ field: event.target.value })} placeholder="例如 movement_x" /></label>
          <label className="inspector-row"><span>正向值</span><input disabled={props.disabled} maxLength={128} value={draft.forwardValue} onChange={(event) => update({ forwardValue: event.target.value })} /></label>
          <label className="inspector-row"><span>反向值</span><input disabled={props.disabled} maxLength={128} value={draft.reverseValue} onChange={(event) => update({ reverseValue: event.target.value })} /></label>
          <label className="inspector-row"><span>停止值</span><input disabled={props.disabled} maxLength={128} value={draft.stopValue} onChange={(event) => update({ stopValue: event.target.value })} /></label>
          <p className="muted">精确读取本设备的点位名，三个值不能重复。收到的数值和布尔值转成文本，字符串保留前导零后精确匹配；未匹配、缺数据、故障或过期时隐藏。此配置仅改变箭头，不改变货物运动。</p>
        </>
      ) : (
        <p className="muted">沿用模型声明的方向字段和编码；常用默认值为 movement_x：1 正向、2 反向、0 停止。</p>
      )}
      {error ? <p className="telemetry-runtime-error" role="alert">{error}</p> : null}
      <div className="model-generator-inline-actions">
        <button type="button" disabled={props.disabled || !changed || Boolean(error)} onClick={() => {
          if (!props.disabled && changed && !getConveyorSurfaceArrowDirectionError(draft)) props.onChange({ ...draft });
        }}>应用方向绑定</button>
        <button type="button" disabled={props.disabled || !changed} onClick={() => setDraft({ ...props.value })}>还原未应用修改</button>
      </div>
      {changed ? <p className="muted">方向绑定有未应用修改。</p> : null}
    </details>
  );
}
