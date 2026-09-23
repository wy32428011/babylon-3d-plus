import { ENVIRONMENT_EFFECT_TARGET_ID, isEnvironmentBuildingEffectKind } from '../model/environmentBuildingEffect';
import './DigitalTwinEffectInspector.css';
import { useEffect, useMemo, useState } from 'react';
import type { PoiEffectComponent } from '../model/components';
import {
  AREA_EFFECT_KINDS,
  DATA_EFFECT_KINDS,
  DIGITAL_TWIN_EFFECT_DEFINITIONS,
  DIGITAL_TWIN_EFFECT_NUMBER_LIMITS,
  sanitizeDigitalTwinEffectConfig,
  validateDigitalTwinEffectConfig,
  type DigitalTwinEffectConfig,
  type DigitalTwinEffectKind,
} from '../model/digitalTwinEffect';
import { useEditorStore } from '../store/editorStore';

type Props = {
  component: PoiEffectComponent;
  disabled: boolean;
  onChange: (component: PoiEffectComponent, label: string) => void;
};

type NumberKey = keyof typeof DIGITAL_TWIN_EFFECT_NUMBER_LIMITS;
const NUMBER_LABELS: Record<NumberKey, string> = {
  radius: '范围半径 (m)', height: '高度 (m)', width: '线宽 (m)', opacity: '不透明度 (%)',
  duration: '周期时长 (s)', progress: '进度 (%)', amount: '展开距离 (m)',
};

function numberLabel(kind: DigitalTwinEffectKind, key: NumberKey): string {
  if (kind === 'dissolve' && key === 'progress') return '显示上限 (%)';
  if (kind === 'dissolve' && key === 'duration') return '生长时长 (s)';
  if (key === 'radius') {
    if (kind === 'target-follow') return '跟随距离 (m)';
    if (kind === 'environment-fog') return '起雾距离 (m)';
    if (kind === 'camera-frustum') return '覆盖范围半宽 (m)';
    if (kind === 'region-level') return '单区半径 (m)';
  }
  if (key === 'height') {
    if (kind === 'target-follow') return '跟随高度 (m)';
    if (kind === 'environment-fog') return '雾过渡距离 (m)';
    if (kind === 'camera-frustum') return '安装高度 (m)';
    if (kind === 'fly-line') return '飞线拱高 (m)';
    if (kind === 'data-bars') return '最大柱高 (m)';
  }
  if (key === 'amount') {
    if (kind === 'floor-expand') return '楼层展开间距 (m)';
    if (kind === 'radar-sector') return '扫描扇角 (°)';
    if (kind === 'motion-trail') return '轨迹采样点数';
    if (kind === 'ripple-ring') return '扩散光圈数量';
    if (['rain', 'snow', 'flame', 'smoke-plume'].includes(kind)) return '粒子数量基数';
    if (['flow-arrows', 'pipe-flow'].includes(kind)) return '流动物数量基数';
    if (['flow-path', 'fly-line', 'boundary-flow'].includes(kind)) return '流光波段数量';
  }
  if (key === 'width') {
    if (kind === 'heatmap') return '热区影响半径 (m)';
    if (kind === 'data-bars') return '柱体宽度 (m)';
    if (kind === 'snow') return '雪片大小 (m)';
    if (kind === 'light-pillar' || kind === 'energy-dome') return '底圈线宽 (m)';
  }
  return NUMBER_LABELS[key];
}

function parsePointDraft(text: string): DigitalTwinEffectConfig['points'] {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 128) throw new Error('请填写 1–128 行坐标，每行 X, Y, Z。');
  return lines.map((line, index) => {
    const tokens = line.split(/[,，]/).map(token => token.trim());
    if (tokens.length !== 3 || tokens.some(token => !token || !Number.isFinite(Number(token)))) {
      throw new Error(`第 ${index + 1} 行坐标无效，请填写三个有限数值：X, Y, Z。`);
    }
    return { x: Number(tokens[0]), y: Number(tokens[1]), z: Number(tokens[2]) };
  });
}

function parseValueDraft(text: string): number[] {
  const values = text.trim().replace(/\r\n/g, '\n').split(/[,，\n]/).map(value => value.trim());
  if (!text.trim() || values.length > 64 || values.some(value => !value || !Number.isFinite(Number(value)))) {
    throw new Error('数值需要 1–64 项有限数值，每行一项或使用逗号分隔。');
  }
  return values.map(Number);
}

function DraftArea({ label, value, onChange, disabled, maxLength, rows = 5 }: {
  label: string; value: string; onChange: (value: string) => void; disabled: boolean; maxLength: number; rows?: number;
}) {
  return <label className="digital-twin-effect-draft">
    <span>{label}</span>
    <textarea aria-label={label} value={value} rows={rows} maxLength={maxLength} disabled={disabled}
      spellCheck={false} onChange={event => onChange(event.target.value)} />
  </label>;
}

/** 文本坐标和数据按一次事务应用，外观修改不会覆盖尚未提交的草稿。 */
export function DigitalTwinEffectInspector({ component, disabled, onChange }: Props) {
  const entities = useEditorStore(state => state.scene.entities);
  const environment = useEditorStore(state => state.scene.sceneSettings.environment);
  const selectedEntityId = useEditorStore(state => state.scene.selectedEntityId);
  const definition = DIGITAL_TWIN_EFFECT_DEFINITIONS.find(item => item.kind === component.effectKind)
    ?? DIGITAL_TWIN_EFFECT_DEFINITIONS[0];
  const config = sanitizeDigitalTwinEffectConfig(component.visual, definition.kind);
  const fields: readonly string[] = definition.fields;
  const savedPoints = config.points.map(point => `${point.x}, ${point.y}, ${point.z}`).join('\n');
  const savedValues = config.values.join('\n');
  const savedLabels = config.labels.join('\n');
  const [pointDraft, setPointDraft] = useState(savedPoints);
  const [valueDraft, setValueDraft] = useState(savedValues);
  const [labelDraft, setLabelDraft] = useState(savedLabels);
  const [error, setError] = useState('');

  useEffect(() => { setPointDraft(savedPoints); setError(''); }, [savedPoints]);
  useEffect(() => { setValueDraft(savedValues); setError(''); }, [savedValues]);
  useEffect(() => { setLabelDraft(savedLabels); setError(''); }, [savedLabels]);

  const targets = useMemo(() => Object.values(entities).filter(entity => entity.id !== selectedEntityId
    && !entity.components.poiEffect && !!(entity.components.modelAsset || entity.components.meshRenderer)),
  [entities, selectedEntityId]);
  const environmentTarget = config.targetEntityId === ENVIRONMENT_EFFECT_TARGET_ID;
  const supportsEnvironment = isEnvironmentBuildingEffectKind(component.effectKind);
  const missingTarget = environmentTarget ? !environment || !supportsEnvironment : !!config.targetEntityId && !targets.some(entity => entity.id === config.targetEntityId);
  const isArea = AREA_EFFECT_KINDS.has(definition.kind);
  const isData = DATA_EFFECT_KINDS.has(definition.kind);
  const hasDraftFields = fields.includes('points') || fields.includes('values') || fields.includes('labels');
  const hasChanges = (fields.includes('points') && pointDraft !== savedPoints)
    || (fields.includes('values') && valueDraft !== savedValues) || (fields.includes('labels') && labelDraft !== savedLabels);

  function commit(patch: Partial<DigitalTwinEffectConfig>, label: string): void {
    if (disabled) return;
    onChange({ ...component, visual: sanitizeDigitalTwinEffectConfig({ ...config, ...patch }, definition.kind) }, label);
  }

  function applyDrafts(): void {
    if (disabled) return;
    try {
      const next = {
        ...config,
        ...(fields.includes('points') ? { points: parsePointDraft(pointDraft) } : {}),
        ...(fields.includes('values') ? { values: parseValueDraft(valueDraft) } : {}),
        ...(fields.includes('labels') ? { labels: labelDraft.trim() ? labelDraft.replace(/\r/g, '').split('\n').map(label => label.trim()) : [] } : {}),
      };
      validateDigitalTwinEffectConfig(next, definition.kind);
      onChange({ ...component, visual: next }, isData ? '更新特效空间数据' : isArea ? '更新特效区域轮廓' : '更新特效路径');
      setPointDraft(next.points.map(point => `${point.x}, ${point.y}, ${point.z}`).join('\n'));
      setValueDraft(next.values.join('\n'));
      setLabelDraft(next.labels.join('\n'));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '特效配置无效，请检查坐标与数值。');
    }
  }

  return <div className="digital-twin-effect-inspector">
    <p className="muted">{definition.category} · {definition.description}</p>
    {!component.configuration && fields.includes('targetEntityId') && <>
      <label className="inspector-row"><span>绑定目标</span>
        <select aria-label="特效绑定目标" disabled={disabled} value={config.targetEntityId ?? ''}
          onChange={event => commit({ targetEntityId: event.target.value || null }, '更新特效绑定目标')}>
          <option value="">未绑定</option>
          {supportsEnvironment && <option value={ENVIRONMENT_EFFECT_TARGET_ID} disabled={!environment}>环境模型{environment ? (environment.displayName ? ` · ${environment.displayName}` : '') : '（尚未配置）'}</option>}
          {missingTarget && !(environmentTarget && supportsEnvironment) && <option value={config.targetEntityId ?? ''}>{environmentTarget ? '环境模型（此类型不支持）' : `目标已缺失 / 不可绑定（${config.targetEntityId}）`}</option>}
          {targets.map(entity => <option key={entity.id} value={entity.id}>{entity.name || entity.id}</option>)}
        </select>
      </label>
      {environmentTarget && !missingTarget && <p className="muted">已绑定当前环境模型；替换环境资源后自动作用于新环境。环境隐藏时暂停效果。</p>}
      {missingTarget && <p className="digital-twin-effect-error" role="status">{environmentTarget ? '当前场景尚未配置适用的环境模型；添加环境后此绑定会自动恢复。' : '绑定目标已删除或不再适用，请重新选择。原绑定 ID 已保留。'}</p>}
      {!config.targetEntityId && <p className="muted">{definition.kind === 'motion-trail' ? '未绑定目标时沿下方配置路径演示；绑定后记录目标实际运动轨迹。' : supportsEnvironment ? '请选择环境模型、独立模型或基础网格。' : '请先绑定场景中的独立模型或基础网格。'}</p>}
    </>}
    {(Object.keys(DIGITAL_TWIN_EFFECT_NUMBER_LIMITS) as NumberKey[]).filter(key => fields.includes(key)).map(key => {
      const multiplier = key === 'opacity' || key === 'progress' ? 100 : 1;
      const limits = DIGITAL_TWIN_EFFECT_NUMBER_LIMITS[key];
      return <label className="number-row" key={key}><span>{numberLabel(definition.kind, key)}</span>
        <input type="number" aria-label={numberLabel(definition.kind, key)} disabled={disabled}
          value={Number((config[key] * multiplier).toFixed(5))} min={limits.min * multiplier} max={limits.max * multiplier}
          step={multiplier === 100 || key === 'amount' && definition.kind !== 'floor-expand' && definition.kind !== 'explode' ? 1 : key === 'width' ? 0.01 : 0.1}
          onChange={event => {
            if (!event.target.value || !Number.isFinite(Number(event.target.value))) return;
            commit({ [key]: Number(event.target.value) / multiplier }, `更新特效${numberLabel(definition.kind, key)}`);
          }} />
      </label>;
    })}
    {fields.includes('axis') && <label className="inspector-row"><span>效果轴向</span>
      <select aria-label="效果轴向" disabled={disabled} value={config.axis}
        onChange={event => commit({ axis: event.target.value as DigitalTwinEffectConfig['axis'] }, '更新特效轴向')}>
        <option value="x">X 轴</option><option value="y">Y 轴（高度）</option><option value="z">Z 轴</option>
      </select>
    </label>}
    {fields.includes('loop') && <label className="mqtt-config-dialog-checkbox">
      <input type="checkbox" disabled={disabled} checked={config.loop}
        onChange={event => commit({ loop: event.target.checked }, '更新特效循环播放')} />循环播放
    </label>}
    {hasDraftFields && <details open>
      <summary>{isData ? '空间采样数据' : isArea ? '区域轮廓' : '路径坐标'}</summary>
      <p className="muted">{isData ? '每个采样点对应一个数值，数量一致，最多 64 项。数值是当前场景配置，不会自动读取业务遥测。'
        : isArea ? '在局部 X/Z 平面按顺序填写 3–128 个顶点，首尾自动闭合；不支持自交、折返或共线轮廓。'
        : '按行填写 2–128 个路径点；相邻点至少间隔 0.001 米。'}</p>
      {fields.includes('points') && <>
        <DraftArea label="局部坐标 (X, Y, Z / m)" value={pointDraft} disabled={disabled} maxLength={16384}
          onChange={value => { setPointDraft(value); setError(''); }} />
        <p className="muted">每行三个坐标，用逗号分隔，例如 0, 0.05, 3。坐标相对于特效实体，旋转和缩放由 Transform 控制。</p>
      </>}
      {fields.includes('values') && <DraftArea label="采样数值（每行一项）" value={valueDraft} disabled={disabled} maxLength={2048}
        onChange={value => { setValueDraft(value); setError(''); }} />}
      {fields.includes('labels') && <>
        <DraftArea label="数据标签（每行一项，可留空）" value={labelDraft} disabled={disabled} maxLength={5184} rows={3}
          onChange={value => { setLabelDraft(value); setError(''); }} />
        <p className="muted">标签按顺序对应数据，最多 64 项，每项不超过 80 字。</p>
      </>}
      <button type="button" disabled={disabled || !hasChanges} onClick={applyDrafts}>{isData ? '应用空间数据' : isArea ? '应用区域轮廓' : '应用路径'}</button>
      {error && <p className="digital-twin-effect-error" role="alert">{error}</p>}
      {hasChanges && !error && <p className="muted">有未应用的坐标或数据修改。</p>}
    </details>}
  </div>;
}
