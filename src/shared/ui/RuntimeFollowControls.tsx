import { useState, useSyncExternalStore } from 'react';
import {
  getEffectDiagnostics,
  resumeEffectFollow,
  selectEffectFollowTarget,
  subscribeEffectDiagnostics,
} from '../../runtime/effects/effectDiagnostics';
import '../../styles/runtime-follow-controls.css';

const stateLabels: Record<string, string> = {
  loading: '加载中', ready: '就绪', hidden: '已隐藏', error: '加载失败',
};

/** 操作仅改变当前运行会话，编辑器预览锁定时也不写入场景和撤销历史。 */
export function RuntimeFollowControls() {
  const diagnostics = useSyncExternalStore(subscribeEffectDiagnostics, getEffectDiagnostics, getEffectDiagnostics);
  const [expanded, setExpanded] = useState(true);
  const effects = [...diagnostics].filter(([, value]) => value.effectKind === 'target-follow');
  if (!effects.length) return null;
  return <section className="runtime-follow-controls" aria-label="运行时目标跟随"
    onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <button type="button" className="runtime-follow-heading" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <strong>目标跟随</strong><span>{expanded ? '收起' : `展开（${effects.length}）`}</span>
    </button>
    {expanded && <div className="runtime-follow-content">
      {effects.map(([id, diagnostic]) => <div className="runtime-follow-item" key={id}>
        <strong>{diagnostic.effectName || '目标跟随'}</strong>
        <p role="status">{diagnostic.message}</p>
        <label><span>当前运行目标</span><select aria-label={`${diagnostic.effectName || '目标跟随'} 运行目标`}
          value={diagnostic.selectedTargetId ?? ''} onChange={event => selectEffectFollowTarget(id, event.target.value || null)}>
          <option value="">按配置等待 / 重新选择</option>
          {diagnostic.selectedTargetId && !diagnostic.candidates.some(candidate => candidate.id === diagnostic.selectedTargetId)
            && <option value={diagnostic.selectedTargetId}>已锁定目标，等待重新出现</option>}
          {diagnostic.candidates.slice(0, 64).map(candidate => <option key={candidate.id} value={candidate.id}
            disabled={!!candidate.state && candidate.state !== 'ready'}>
            {candidate.name} · {candidate.containerCode || candidate.assetCode || '无业务编号'}
            {candidate.origin === 'generated' ? ' · 运行时生成' : candidate.origin === 'scene' ? ' · 场景模型' : ''}
            {candidate.state && candidate.state !== 'ready' ? ` · ${stateLabels[candidate.state] || candidate.state}` : ''}
          </option>)}
        </select></label>
        <div className="runtime-follow-actions">
          <button type="button" disabled={!diagnostic.selectedTargetId} onClick={() => selectEffectFollowTarget(id, null)}>清除本次选择</button>
          <button type="button" onClick={() => resumeEffectFollow(id)}>恢复跟随</button>
        </div>
      </div>)}
      <p className="runtime-follow-hint">选择仅对本次运行有效。没有匹配实例时等待生成。</p>
    </div>}
  </section>;
}
