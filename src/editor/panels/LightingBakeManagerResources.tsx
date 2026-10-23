import type { SceneLightingBakeSnapshot } from '../../../electron/shared/sceneLightingBakeContract';
import { LightingManagerBadge, LightingManagerIcon, LIGHTING_MANAGER_PHASE_LABELS, formatLightingBytes } from './LightingBakeManagerWidgets';

type TaskStatus = { phase: string; message: string | null; progress?: number; source?: 'runtime' };
export function LightingBakeManagerResources({ result, status, resultLabel, busy, disabled, dirty, onCancel, onClear, issues }: {
  result: SceneLightingBakeSnapshot | null; status: TaskStatus; resultLabel: string; busy: boolean;
  disabled: boolean; dirty: boolean; onCancel: () => void; onClear: () => void; issues: string[];
}) {
  const progress = Number.isFinite(status.progress) ? Math.max(0, Math.min(1, status.progress!)) : undefined;
  return <div className="lighting-manager-resources">
    <section className="lighting-manager-card lighting-manager-job" aria-labelledby="lighting-task-title">
      <div className="lighting-manager-card-heading"><h3 id="lighting-task-title">当前任务</h3>
        <LightingManagerBadge tone={busy ? 'dynamic' : status.phase === 'error' ? 'warning' : 'neutral'}>
          {status.source === 'runtime' ? '需要检查' : LIGHTING_MANAGER_PHASE_LABELS[status.phase] ?? status.phase}
        </LightingManagerBadge>
      </div>
      {busy && <><progress aria-label="光照烘焙进度" max={1} value={progress} /><p aria-live="polite">{status.message ?? '正在准备烘焙…'}
        {progress !== undefined && <strong> {Math.round(progress * 100)}%</strong>}</p>
        <button type="button" className="lighting-manager-danger" onClick={onCancel}>取消本次烘焙</button></>}
      {!busy && <p className={status.phase === 'error' ? 'lighting-manager-warning' : 'lighting-manager-note'}
        role={status.phase === 'error' ? 'alert' : 'status'}>{status.message ?? '当前没有运行中的烘焙任务。'}</p>}
      <p className="lighting-manager-note">关闭管理器不会取消后台任务。取消或失败会保留上次有效结果。</p>
    </section>
    <section className="lighting-manager-card" aria-labelledby="lighting-assets-title">
      <div className="lighting-manager-card-heading"><h3 id="lighting-assets-title">结果与资产</h3><LightingManagerBadge tone={resultLabel === '可用' ? 'success' : 'neutral'}>{resultLabel}</LightingManagerBadge></div>
      {result ? <>
        <dl className="lighting-manager-resource-summary">
          <div><dt>烘焙表面</dt><dd>{result.surfaces.length}</dd></div><div><dt>光照图集</dt><dd>{result.statistics.atlasCount}</dd></div>
          <div><dt>探针</dt><dd>{result.statistics.probeCount}</dd></div><div><dt>纹理占用</dt><dd>{formatLightingBytes(result.statistics.textureBytes)}</dd></div>
          <div><dt>生成时间</dt><dd>{new Date(result.createdAt).toLocaleString()}</dd></div><div><dt>耗时</dt><dd>{(result.statistics.durationMs / 1000).toFixed(1)} 秒</dd></div>
        </dl>
        <p className="lighting-manager-note">以下为已保存资源清单；摘要记录不等于当前文件已重新读取。缺失或失效诊断显示在下方。</p>
        <div className="lighting-manager-asset-scroll"><table className="lighting-manager-table">
          <thead><tr><th>资产</th><th>类型</th><th>磁盘大小</th><th>校验记录</th></tr></thead>
          <tbody>{result.assets.map((asset, index) => <tr key={asset.id}><td title={asset.url}>{asset.kind === 'lightmap' ? '光照图集' : asset.kind === 'geometry' ? '派生几何' : '间接光探针'} {index + 1}</td>
            <td>{asset.kind === 'lightmap' ? 'PNG' : 'JSON'}</td><td>{formatLightingBytes(asset.byteLength)}</td><td>{asset.sha256 ? '已记录摘要' : '无摘要'}</td></tr>)}</tbody>
        </table></div>
        <div className="lighting-manager-resource-actions"><p className="lighting-manager-note">清除只解除关联，保留独立资产以支持撤销及其他场景引用。</p>
          <button type="button" disabled={disabled || dirty || busy} onClick={onClear}>清除烘焙结果</button></div>
        {dirty && <p className="lighting-manager-note">请先应用或放弃草稿，再清除已有结果。</p>}
      </> : <div className="lighting-manager-empty"><LightingManagerIcon name="layers" size={32} /><p>还没有光照资产</p><p>在“总览与烘焙”应用配置并开始烘焙。</p></div>}
    </section>
    <section className="lighting-manager-card" aria-labelledby="lighting-diagnostics-title">
      <h3 id="lighting-diagnostics-title">需要检查</h3>
      {issues.length ? <ul className="lighting-manager-diagnostics">{issues.map((issue, index) => <li key={`${index}:${issue}`}><LightingManagerIcon name="warning" size={16} /><span>{issue}</span></li>)}</ul>
        : <p className="lighting-manager-note with-icon"><LightingManagerIcon name="check" size={16} />当前没有报告光照错误或失配规则。</p>}
    </section>
  </div>;
}
