import { type ScenePerformanceSnapshot } from '../../../runtime/babylon/ScenePerformanceMonitor';
import { type EditorPerformanceRunSnapshot } from '../../runtime/editorPerformanceRunSession';
import type { Dispatch, SetStateAction } from 'react';
type Props = {
  showPerformanceHud: boolean;
  hasStoppedPerformanceReport: boolean;
  isPerformanceHudExpanded: boolean;
  performanceSnapshot: ScenePerformanceSnapshot | null;
  isPerformanceRun: boolean;
  setPerformanceRunHudExpanded: Dispatch<SetStateAction<boolean>>;
  setPerformanceHudExpanded: Dispatch<SetStateAction<boolean>>;
  performanceRunSnapshot: EditorPerformanceRunSnapshot | null;
  handleCopyPerformanceRunReport: () => Promise<void>;
  handleCopyPerformanceReport: () => Promise<void>;
  adaptiveResolutionEnabled?: boolean;
  onAdaptiveResolutionChange?: (enabled: boolean) => void;
};

/** HUD 只展示两位以内的稳定数字，原始报告仍保留完整精度。 */
function formatPerformanceMetric(value: number | null, digits = 1): string {
  return value !== null && Number.isFinite(value) ? value.toFixed(digits) : 'N/A';
}

/** 性能 HUD 保持使用主面板的原有采样快照与展开状态。 */
export function ScenePerformanceHud({ showPerformanceHud, hasStoppedPerformanceReport, isPerformanceHudExpanded, performanceSnapshot, isPerformanceRun, setPerformanceRunHudExpanded, setPerformanceHudExpanded, performanceRunSnapshot, handleCopyPerformanceRunReport, handleCopyPerformanceReport, adaptiveResolutionEnabled, onAdaptiveResolutionChange }: Props) {
  return <>
        {showPerformanceHud || hasStoppedPerformanceReport ? (
          <div className={showPerformanceHud && isPerformanceHudExpanded ? 'scene-performance-hud expanded' : 'scene-performance-hud'}>
            {performanceSnapshot && showPerformanceHud ? <>
            <button
              aria-expanded={isPerformanceHudExpanded}
              className="scene-performance-summary"
              onClick={() => isPerformanceRun
                ? setPerformanceRunHudExpanded((expanded) => !expanded)
                : setPerformanceHudExpanded((expanded) => !expanded)}
              title="展开或收起 Scene View 性能指标"
              type="button"
            >
              <strong>{formatPerformanceMetric(performanceSnapshot.fps, 0)} FPS</strong>
              <span>{formatPerformanceMetric(performanceSnapshot.frameTimeMs)} ms</span>
              <span>{formatPerformanceMetric(performanceSnapshot.drawCalls, 0)} DC</span>
            </button>
            {isPerformanceHudExpanded ? (
              <div className="scene-performance-details" role="status">
                {isPerformanceRun ? (
                  <p className="scene-performance-run-status">
                    {performanceRunSnapshot?.phase === 'running'
                      ? `性能运行 · 已保留 ${performanceRunSnapshot!.sampleCount} 个样本`
                      : '性能运行 · 等待完整采样窗口（约 2 秒）'}
                  </p>
                ) : null}
                <dl>
                  <div><dt>Frame / Render</dt><dd>{formatPerformanceMetric(performanceSnapshot.frameTimeMs)} / {formatPerformanceMetric(performanceSnapshot.renderTimeMs)} ms</dd></div>
                  <div><dt>GPU frame</dt><dd>{performanceSnapshot.gpuFrameTimeMs === null ? 'N/A' : `${formatPerformanceMetric(performanceSnapshot.gpuFrameTimeMs)} ms`}</dd></div>
                  <div><dt>Active eval</dt><dd>{formatPerformanceMetric(performanceSnapshot.activeMeshesEvaluationMs)} ms</dd></div>
                  <div><dt>Draw Calls</dt><dd>{formatPerformanceMetric(performanceSnapshot.drawCalls, 0)}</dd></div>
                  <div><dt>Meshes</dt><dd>{performanceSnapshot.activeMeshes} / {performanceSnapshot.totalMeshes}</dd></div>
                  <div><dt>Vertices</dt><dd>{performanceSnapshot.totalVertices.toLocaleString()}</dd></div>
                  <div><dt>Thin instances</dt><dd>{performanceSnapshot.thinInstances.toLocaleString()}</dd></div>
                  <div><dt>Active thin</dt><dd>{performanceSnapshot.activeThinInstances.toLocaleString()}</dd></div>
                  <div><dt>GPU vertex calls</dt><dd>{performanceSnapshot.estimatedActiveVertexInvocations.toLocaleString()}</dd></div>
                  <div><dt>GPU triangle calls</dt><dd>{performanceSnapshot.estimatedActiveTriangleInvocations.toLocaleString()}</dd></div>
                  <div><dt>双面顶点</dt><dd>{performanceSnapshot.gpuMaterialTotals.doubleSidedVertexInvocations.toLocaleString()}</dd></div>
                  <div><dt>Alpha test / blend</dt><dd>{performanceSnapshot.gpuMaterialTotals.alphaTestedVertexInvocations.toLocaleString()} / {performanceSnapshot.gpuMaterialTotals.alphaBlendedVertexInvocations.toLocaleString()}</dd></div>
                  <div><dt>原模型 / 代理</dt><dd>{performanceSnapshot.runtime.modelArrayDetailedEntityCount.toLocaleString()} / {performanceSnapshot.runtime.modelArrayProxyEntityCount.toLocaleString()}</dd></div>
                  <div><dt>完整同步</dt><dd>{formatPerformanceMetric(performanceSnapshot.runtime.lastFullSyncDurationMs)} ms</dd></div>
                  <div><dt>选择同步</dt><dd>{formatPerformanceMetric(performanceSnapshot.runtime.lastSelectionSyncDurationMs)} ms / {performanceSnapshot.runtime.lastSelectionChangedEntityCount} 个</dd></div>
                  <div><dt>编辑态分组</dt><dd>{formatPerformanceMetric(performanceSnapshot.editThinInstancePlan.lastDurationMs)} ms / {performanceSnapshot.editThinInstancePlan.entityCount.toLocaleString()} 个</dd></div>
                  <div><dt>Long Task</dt><dd>{performanceSnapshot.longTaskCount} / {formatPerformanceMetric(performanceSnapshot.longTaskDurationMs)} ms</dd></div>
                  {isPerformanceRun && performanceRunSnapshot ? <>
                    <div><dt>遥测帧 / 峰值</dt><dd>{performanceRunSnapshot.telemetry.lastFrameTimeMs === null ? 'N/A' : formatPerformanceMetric(performanceRunSnapshot.telemetry.lastFrameTimeMs, 2)} / {performanceRunSnapshot.telemetry.maxFrameTimeMs === null ? 'N/A' : formatPerformanceMetric(performanceRunSnapshot.telemetry.maxFrameTimeMs, 2)} ms</dd></div>
                    <div><dt>候选重建（本次）</dt><dd>{performanceRunSnapshot.telemetry.candidateRebuilds.toLocaleString()}</dd></div>
                    <div><dt>签名计算（本次）</dt><dd>{performanceRunSnapshot.telemetry.contextSignatureBuilds.toLocaleString()}</dd></div>
                    <div><dt>诊断写入（本次）</dt><dd>{performanceRunSnapshot.telemetry.diagnosticWrites.toLocaleString()}</dd></div>
                  </> : null}
                </dl>
                {onAdaptiveResolutionChange ? <label className="scene-performance-adaptive-option"
                  title="相机移动时临时降低分辨率，静止0.5秒后恢复；仅本次编辑器会话，不修改场景文件。">
                  <input type="checkbox" checked={adaptiveResolutionEnabled === true}
                    onChange={event => onAdaptiveResolutionChange(event.target.checked)} />
                  移动时降低分辨率（本次会话）
                </label> : null}
                {isPerformanceRun ? <p className="scene-performance-run-note">1 Hz 采样，CPU 为秒级均值；报告保留本次最近一分钟。</p> : null}
                <button className="scene-performance-copy" onClick={() => void (isPerformanceRun ? handleCopyPerformanceRunReport() : handleCopyPerformanceReport())} type="button">
                  {isPerformanceRun ? '复制本次性能运行报告' : '复制最近一分钟报告'}
                </button>
              </div>
            ) : null}
            </> : null}
            {hasStoppedPerformanceReport ? (
              <button className="scene-performance-copy scene-performance-retained-report" onClick={() => void handleCopyPerformanceRunReport()} type="button">
                复制上次性能运行报告（{performanceRunSnapshot!.sampleCount} 个样本）
              </button>
            ) : null}
          </div>
        ) : null}
  </>;
}
