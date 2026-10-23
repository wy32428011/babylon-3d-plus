import type { LightingManagerChangeSummary } from './lightingBakeManagerModel';

export function LightingBakeManagerChanges({ summary, impact }: { summary: LightingManagerChangeSummary;
  impact: { affectedEntityCount: number; affectedNodeCount: number; preservedExceptionCount: number; pendingCount: number } }) {
  if (!summary.categories.length) return null;
  return <section className="lighting-manager-change-summary" aria-label="待应用变更摘要" aria-live="polite">
    <div><strong>待应用变更</strong><span>{summary.categories.join(' · ')}</span></div>
    <p>{summary.giMessage}</p>
    {(summary.rulesChanged || summary.exceptionsChanged) && <p>规则与例外影响 {impact.affectedEntityCount} 个对象 / {impact.affectedNodeCount} 个部件 · 保留 {impact.preservedExceptionCount} 项例外
      {impact.pendingCount > 0 && <span> · {impact.pendingCount} 项等待完整分类事实</span>}</p>}
  </section>;
}
