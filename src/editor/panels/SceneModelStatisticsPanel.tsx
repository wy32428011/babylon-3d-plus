import { useId, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import './SceneModelStatisticsPanel.css';

const triangleNumberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** 仅展示运行时统计；展开说明和明细不会修改场景或撤销历史。 */
export function SceneModelStatisticsPanel() {
  const sceneId = useEditorStore(state => state.scene.id);
  const snapshot = useEditorStore(state => state.sceneModelStatistics);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [helpExpanded, setHelpExpanded] = useState(false);
  const detailsId = useId();
  const helpId = useId();
  const phase = snapshot?.sceneId === sceneId ? snapshot.phase : 'loading';
  const ready = phase === 'ready' && snapshot !== null;
  const total = ready
    ? triangleNumberFormat.format(snapshot.modelTriangleCount + snapshot.environmentTriangleCount)
    : phase === 'error' ? '— · 统计未完成' : '— · 统计中…';

  return <section className="scene-model-statistics" aria-label="场景模型面数统计">
    <div className="scene-model-statistics-main">
      <span className="scene-model-statistics-label">模型总面数
        <button type="button" className="scene-model-statistics-info" aria-label="面数统计说明"
          aria-expanded={helpExpanded} aria-controls={helpId}
          onClick={() => setHelpExpanded(expanded => !expanded)}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="6.5" />
            <path d="M8 7v4M8 4.5v.5" />
          </svg>
        </button>
      </span>
      <span className={`scene-model-statistics-value${ready ? '' : ' is-pending'}`}
        role="status" aria-live="polite" aria-atomic="true">{total}</span>
    </div>
    <div className="scene-model-statistics-footer">
      <span>三角面 · 包含隐藏模型</span>
      <button type="button" className="scene-model-statistics-toggle" aria-expanded={detailsExpanded}
        aria-controls={detailsId} onClick={() => setDetailsExpanded(expanded => !expanded)}>
        <span>{detailsExpanded ? '收起明细' : '统计明细'}</span>
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
          <path d="m2 3.5 3 3 3-3" />
        </svg>
      </button>
    </div>
    <p id={helpId} className="scene-model-statistics-help" hidden={!helpExpanded}>
      统计当前场景的三角面，包含环境模型、隐藏模型和当前已生成的货箱。双面材质不会重复计数。
      资源加载完成后显示完整统计；统计未完成时不显示部分结果。
    </p>
    <div id={detailsId} hidden={!detailsExpanded}>
      <dl className="scene-model-statistics-breakdown">
        <dt>场景模型</dt><dd>{ready ? triangleNumberFormat.format(snapshot.modelTriangleCount) : '—'}</dd>
        <dt>环境模型</dt><dd>{ready ? triangleNumberFormat.format(snapshot.environmentTriangleCount) : '—'}</dd>
      </dl>
      <p className="scene-model-statistics-scope">
        按模型实际实例数累计，相机移动不影响总数。<br />
        不包含编辑辅助、天空盒和 CAD 线稿。
      </p>
    </div>
  </section>;
}
