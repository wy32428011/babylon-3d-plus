import { memo, useRef, useState } from 'react';
import type { LightingManagerPreflightState } from '../store/lightingManagementState';
import type { LightingBakeTaskHistory } from '../../../electron/shared/sceneLightingBakeTasks';
import type { LightingShadowMetrics } from '../../runtime/babylon/lightingShadowCosts';
import { areLightingManagerPagePropsEqual } from './lightingBakeManagerModel';
import { LightingManagerBadge, formatLightingBytes } from './LightingBakeManagerWidgets';

type Props = {
  active?: boolean;
  preflight: LightingManagerPreflightState;
  currentSignature: string;
  costs: LightingShadowMetrics | null;
  history: LightingBakeTaskHistory | null;
  historyError: string | null;
  disabled: boolean;
  dirty: boolean;
  onCheck: () => void;
  onRefreshHistory: () => Promise<void> | void;
  onCleanup: (ids: string[]) => Promise<void> | void;
  onReadLog: (id: string) => Promise<string>;
};
const TASK_LABELS: Record<string, string> = { preparing: '准备中', baking: '烘焙中', applying: '应用中', completed: '已完成', cancelled: '已取消', error: '失败', interrupted: '已中断' };

/** 预检与历史均来自宿主数据；估算、已保存统计和实际运行成本使用独立口径。 */
function LightingBakeManagerTaskToolsPage({ preflight, currentSignature, costs, history, historyError, disabled, dirty, onCheck, onRefreshHistory, onCleanup, onReadLog }: Props) {
  const [log, setLog] = useState<{ taskId: string; text: string } | null>(null);
  const [loadingLog, setLoadingLog] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const logGeneration = useRef(0);
  const report = preflight.report;
  const stale = Boolean(report && (dirty || report.signature !== currentSignature));
  const checkLabel = preflight.phase === 'checking' ? '正在检查…' : dirty ? '应用并检查' : '烘焙前检查';
  async function readLog(taskId: string) {
    const generation = ++logGeneration.current;
    setLoadingLog(taskId); setActionError(null);
    try { const text = await onReadLog(taskId); if (generation === logGeneration.current) setLog({ taskId, text }); }
    catch (error) { if (generation === logGeneration.current) setActionError(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === logGeneration.current) setLoadingLog(null); }
  }
  async function cleanup(taskId: string) {
    setCleaning(taskId); setActionError(null);
    try { await onCleanup([taskId]); if (log?.taskId === taskId) setLog(null); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setCleaning(null); }
  }
  return <>
    <section className="lighting-manager-card" aria-labelledby="lighting-preflight-title">
      <div className="lighting-manager-card-heading"><h3 id="lighting-preflight-title">烘焙前检查</h3>
        <button type="button" disabled={disabled || preflight.phase === 'checking'} onClick={onCheck}>{checkLabel}</button></div>
      <p className="lighting-manager-note">先按对象、纹理尺寸和探针范围检查资源预算，不读回纹理像素、不导出整场景几何，也不启动 Cycles。{dirty ? '先应用草稿后检查。' : ''}</p>
      {preflight.message && <p className="lighting-manager-warning" role="status">{preflight.message}</p>}
      {stale && <p className="lighting-manager-warning" role="status">配置已变化，以下检查结果仅供参考，请重新检查。</p>}
      {report ? <>
        <dl className="lighting-manager-resource-summary">
          <div><dt>静态几何 / 接收表面</dt><dd>{report.meshCount} / {report.receiverCount}</dd></div>
          <div><dt>三角形</dt><dd>{report.triangleCount.toLocaleString()}</dd></div>
          <div><dt>接收面积</dt><dd>{report.metadataOnly ? '捕获后精确复验' : `${report.receiverArea.toFixed(1)} m²`}</dd></div>
          <div><dt>图集面积下界</dt><dd>{report.metadataOnly ? '捕获后精确复验' : `至少 ${report.minAtlasCount} 张 / ${formatLightingBytes(report.minTextureBytes)}`}</dd></div>
          <div><dt>探针 / 上限</dt><dd>{report.probeCountExact === false ? '至少 ' : ''}{report.probeCount.toLocaleString()} / {report.probeLimit}</dd></div>
          <div><dt>探针覆盖范围（世界米）</dt><dd>{(['X', 'Y', 'Z'] as const).map((axis, index) => axis + ' ' + report.bounds.min[index].toFixed(2) + ' ～ ' + report.bounds.max[index].toFixed(2)).join(' · ')}</dd></div>
          <div><dt>几何数字数据</dt><dd>{formatLightingBytes(report.geometryBytes)}</dd></div>
          <div><dt>二进制输入估算</dt><dd>{formatLightingBytes(report.estimatedInputBytes)}</dd></div>
          <div><dt>派生数字数据估算</dt><dd>{report.estimatedDerivedNumericBytes === undefined ? '未测' : formatLightingBytes(report.estimatedDerivedNumericBytes)}</dd></div>
          <div><dt>源纹理（编码字节）</dt><dd>{report.sourceTextureCount} 项{report.sourceTextureBytes !== undefined ? ' / ' + formatLightingBytes(report.sourceTextureBytes) : ' · 未测字节'}</dd></div>
          {report.largestCaptureBytes !== undefined && <div><dt>最大单项准备估计</dt><dd>{formatLightingBytes(report.largestCaptureBytes)} / {formatLightingBytes(report.resourceBudget?.workingBytes ?? 0)}</dd></div>}
          {report.sourceTextureDecodedBytes !== undefined && <div><dt>源纹理基础像素估计</dt><dd>{formatLightingBytes(report.sourceTextureDecodedBytes)}</dd></div>}
        </dl>
        <p className="lighting-manager-note">图集数是面积下界，最终以 UV 排版为准。派生数字数据按裁切前逐三角角点展开估算，不含 JSON 文本、额外分片或引擎开销，不是内存上界。贴图预算不能代表总内存；IPC、源纹理和 Cycles 还会产生额外开销。</p>
        {report.issues.length ? <ul className="lighting-manager-preflight-issues">{report.issues.map(issue => <li key={issue.code} className={issue.severity === 'error' ? 'lighting-manager-warning' : ''}>
          <strong>{issue.severity === 'error' ? '阻止烘焙：' : '提醒：'}</strong>{issue.message}</li>)}</ul>
          : <p className="lighting-manager-note">当前输入未报告预算或探针阻止项。</p>}
      </> : <p className="lighting-manager-note">尚无本场景的检查结果。开始烘焙时也会执行相同检查。</p>}
    </section>
    <section className="lighting-manager-card" aria-labelledby="lighting-cost-title">
      <h3 id="lighting-cost-title">实时阴影成本</h3>
      {costs ? <>
        <dl className="lighting-manager-resource-summary"><div><dt>阴影图估算</dt><dd>{formatLightingBytes(costs.shadowMapBytes)}</dd></div><div><dt>静态缓存估算</dt><dd>{formatLightingBytes(costs.cacheBytes)}</dd></div>
          <div><dt>静态 / 动态绘制累计</dt><dd>{costs.staticRenders} / {costs.dynamicRenders}</dd></div><div><dt>缓存命中累计</dt><dd>{costs.cacheHits}</dd></div></dl>
        <div className="lighting-manager-asset-scroll"><table className="lighting-manager-table"><thead><tr><th>光源</th><th>阴影结构</th><th>阴影图</th><th>静态缓存</th></tr></thead>
          <tbody>{costs.lights.map(light => <tr key={light.lightId}><td>{light.name}</td><td>{light.type === 'point' ? '点光源 · ' + light.cubeFaces + ' 面' : light.type === 'directional' ? '方向光 · ' + light.cascades + ' 级联' : '聚光灯'} · {light.mapWidth} × {light.mapHeight}</td><td>{formatLightingBytes(light.shadowMapBytes)}</td><td>{formatLightingBytes(light.cacheBytes)}</td></tr>)}</tbody></table></div>
        <p className="lighting-manager-note">按当前纹理形状估算，不等于驱动实际分配显存。绘制与命中是运行累计值，不代表 FPS。</p>
        {costs.samplerDiagnostics.map(issue => <p key={issue.materialId} className="lighting-manager-warning">{issue.materialName}：纹理采样器 {issue.requiredSamplers} / {issue.limit}，{issue.severity === 'over-limit' ? '已超出设备上限' : '接近设备上限'}。涉及 {issue.meshNames.slice(0, 3).join('、')}{issue.meshNames.length > 3 ? ' 等' + issue.meshNames.length + ' 个网格' : ''}。</p>)}
      </> : <p className="lighting-manager-note">场景渲染就绪后显示当前运行时统计。</p>}
    </section>
    <section className="lighting-manager-card" aria-labelledby="lighting-history-title">
      <div className="lighting-manager-card-heading"><h3 id="lighting-history-title">本机任务历史</h3><button type="button" onClick={() => void onRefreshHistory()}>刷新任务记录</button></div>
      <p className="lighting-manager-note">历史来自本机任务记录，不会自动恢复或重跑任务。清理只处理任务临时文件，已保存光照资产继续保留。</p>
      {(historyError || actionError) && <p className="lighting-manager-warning" role="alert">{historyError ?? actionError}</p>}
      {history ? <><p className="lighting-manager-note">任务临时占用：{formatLightingBytes(history.totalStagingBytes)}</p>
        {history.tasks.length ? <div className="lighting-manager-history-list">{history.tasks.map(task => <article key={task.taskId}>
          <div className="lighting-manager-card-heading"><strong>{task.sceneName}</strong><LightingManagerBadge tone={task.status === 'completed' ? 'success' : task.status === 'error' || task.status === 'interrupted' ? 'warning' : 'neutral'}>{TASK_LABELS[task.status]}</LightingManagerBadge></div>
          <p>{new Date(task.startedAt).toLocaleString()} · 后台 {(task.durationMs / 1000).toFixed(1)} 秒 · 临时 {formatLightingBytes(task.stagingBytes)} · 输出 {formatLightingBytes(task.outputBytes)}</p>
          {task.captureMetrics && <p>视口准备 {task.captureMetrics.durationMs === null ? '未测' : (task.captureMetrics.durationMs / 1000).toFixed(1) + ' 秒'} · JS 堆最大观察 {task.captureMetrics.rendererHeapMaxObservedBytes === null ? '未测' : formatLightingBytes(task.captureMetrics.rendererHeapMaxObservedBytes)}（不代表进程 RSS 或显存）</p>}
          <p>{task.error ?? task.message}</p>
          <p>引擎 {task.engineVersion || '未记录'} · {task.device ? task.device.actual + ' · ' + task.device.name + ' (' + task.device.backend + ')' : '实际设备未记录'}</p>
          {task.device?.fallbackReason && <p className="lighting-manager-warning">设备回退：{task.device.fallbackReason}</p>}
          <details className="lighting-manager-task-metrics"><summary>阶段耗时与内存采样</summary>
            <p>二进制输入：{task.inputBytes === undefined ? '未测' : formatLightingBytes(task.inputBytes)} · 展开几何：{task.expandedGeometryBytes === undefined ? '未测' : formatLightingBytes(task.expandedGeometryBytes)}</p>
            {task.phaseMetrics?.length ? <div className="lighting-manager-asset-scroll"><table className="lighting-manager-table"><thead><tr><th>阶段</th><th>耗时</th><th>主进程 RSS / Heap</th><th>Cycles 生命周期峰值</th></tr></thead>
              <tbody>{task.phaseMetrics.map((metric, index) => <tr key={metric.phase + ':' + index}><td>{metric.phase}</td><td>{(metric.durationMs / 1000).toFixed(2)} 秒</td><td>{metric.mainRssBytes === null ? '未测' : formatLightingBytes(metric.mainRssBytes)} / {metric.mainHeapUsedBytes === null ? '未测' : formatLightingBytes(metric.mainHeapUsedBytes)}</td><td>{metric.cyclesPeakRssBytes === null ? '未测' : formatLightingBytes(metric.cyclesPeakRssBytes)}</td></tr>)}</tbody></table></div>
              : <p>该历史任务未记录阶段采样。</p>}
            <p>主进程指标是阶段采样，Cycles 是子进程生命周期峰值；均不代表总内存或 GPU 显存。</p>
          </details>
          <div className="lighting-manager-diagnostic-actions"><button type="button" disabled={!task.logAvailable || loadingLog === task.taskId} onClick={() => void readLog(task.taskId)}>{loadingLog === task.taskId ? '正在读取…' : '查看日志'}</button>
            <button type="button" disabled={Boolean(cleaning) || ['preparing', 'baking', 'applying'].includes(task.status) || task.stagingBytes === 0} onClick={() => void cleanup(task.taskId)}>{cleaning === task.taskId ? '正在清理…' : '清理临时文件'}</button></div>
        </article>)}</div> : <p className="lighting-manager-note">暂无本机烘焙任务记录。</p>}
      </> : <p className="lighting-manager-note">刷新以读取本机任务记录。</p>}
      {log && <div className="lighting-manager-task-log"><div className="lighting-manager-card-heading"><strong>任务日志 · {log.taskId}</strong><button type="button" onClick={() => { logGeneration.current++; setLog(null); setLoadingLog(null); }}>收起日志</button></div><pre tabIndex={0}>{log.text || '暂无日志内容。'}</pre></div>}
    </section>
  </>;
}
export const LightingBakeManagerTaskTools = memo(LightingBakeManagerTaskToolsPage, areLightingManagerPagePropsEqual);
