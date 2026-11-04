import { useCallback, useEffect, useState } from 'react';
import type { HistoryOperationResult } from '../../../electron/shared/historyServiceContract';
import { invokeHistoryService, isHistoryRequestCancelled } from './historyServiceClient';

const LABELS = { pending: '等待处理', running: '正在处理', succeeded: '已完成', failed: '失败', cancelled: '已取消' } as const;

/** 仅查询已显式提交的任务；打开配置窗口不创建探测、采集或准备任务。 */
export function HistoryOperationView({ projectId, operation, onChange }: {
  projectId: string; operation: HistoryOperationResult; onChange: (value: HistoryOperationResult) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(operation.status);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await invokeHistoryService(projectId, 'getOperation', { operationId: operation.operationId }, { signal });
      setError(null); onChange(value);
    } catch (reason) { if (!isHistoryRequestCancelled(reason)) setError(reason instanceof Error ? reason.message : '无法读取任务状态。'); }
  }, [projectId, operation.operationId, onChange]);
  useEffect(() => {
    if (terminal || error) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void refresh(controller.signal); }, 2000);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [terminal, error, operation, refresh]);
  return <section className="history-settings-task" aria-label="历史管理任务">
    <strong>{LABELS[operation.status]}</strong><p>{operation.message ?? '任务状态由服务器确认。'}</p>
    <small>请求标识：{operation.requestId}</small>
    {error && <p role="alert" className="history-settings-error">{error}</p>}
    <div className="history-settings-row">
      <button type="button" onClick={() => { void refresh(); }}>刷新任务</button>
      {!terminal && <button type="button" onClick={async () => {
        try { onChange(await invokeHistoryService(projectId, 'cancelOperation', { operationId: operation.operationId })); }
        catch (reason) { setError(reason instanceof Error ? reason.message : '无法取消任务。'); }
      }}>请求取消任务</button>}
    </div>
    <small>关闭弹窗只取消本机等待。已提交的远端操作不会因此回滚。</small>
  </section>;
}
