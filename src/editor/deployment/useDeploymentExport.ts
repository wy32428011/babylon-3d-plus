import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { serializeScene } from '../project/SceneSerializer';
import { useEditorStore } from '../store/editorStore';
import {
  createDeploymentSceneSummary,
  type DeploymentExportOutputType,
  type DeploymentExportViewProgress,
  type DeploymentExportViewResult,
  type DeploymentExportSnapshot,
  type DeploymentExportStatus,
} from './deploymentExport';

export type DeploymentExportState = {
  status: DeploymentExportStatus;
  progress: DeploymentExportViewProgress | null;
  result: DeploymentExportViewResult | null;
  snapshot: DeploymentExportSnapshot | null;
  error: string | null;
};

export type StartDeploymentExportOptions = {
  projectName: string;
  outputType: DeploymentExportOutputType;
};

export type DeploymentExportController = {
  state: DeploymentExportState;
  isBusy: boolean;
  start: (options: StartDeploymentExportOptions) => Promise<void>;
  cancel: () => Promise<void>;
  reveal: () => Promise<void>;
  reset: () => void;
};

const INITIAL_DEPLOYMENT_EXPORT_STATE: DeploymentExportState = {
  status: 'idle',
  progress: null,
  result: null,
  snapshot: null,
  error: null,
};

/** 把任意数值约束到可显示的百分比范围。 */
function clampPercent(value: unknown): number {
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) return 0;
  return Math.min(100, Math.max(0, Math.round(numericValue)));
}

/** 从 IPC 对象的多个兼容字段中读取第一个有效字符串。 */
function readString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** 从 IPC 对象的多个兼容字段中读取第一个非负数值。 */
function readNonNegativeNumber(source: Record<string, unknown>, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = source[key];
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numericValue) && numericValue >= 0) return numericValue;
  }
  return fallback;
}

/** 从 IPC 载荷中读取并清理警告列表。 */
function readWarnings(source: Record<string, unknown>): string[] {
  const warnings = source.warnings;
  if (!Array.isArray(warnings)) return [];
  return Array.from(new Set(warnings.filter((warning): warning is string => typeof warning === 'string' && Boolean(warning.trim())).map((warning) => warning.trim())));
}

/** 将 Electron worker 的进度载荷归一化，兼容字段扩展且不让异常数值污染 UI。 */
function normalizeExportProgress(payload: DeploymentExportProgress): DeploymentExportViewProgress {
  const source = payload as unknown as Record<string, unknown>;
  const stage = readString(source, ['stage', 'phase', 'status']) ?? 'exporting';
  const totalBytesValue = readNonNegativeNumber(source, ['totalBytes', 'bytesTotal'], Number.NaN);

  return {
    stage,
    percent: clampPercent(source.percent ?? source.progress),
    message: readString(source, ['message', 'detail', 'label']) ?? '',
    currentFile: readString(source, ['currentFile', 'filePath', 'file']),
    completedFiles: readNonNegativeNumber(source, ['completedFiles', 'processedFiles', 'filesCompleted']),
    totalFiles: readNonNegativeNumber(source, ['totalFiles', 'filesTotal']),
    completedBytes: readNonNegativeNumber(source, ['copiedBytes', 'completedBytes', 'processedBytes', 'bytesWritten', 'bytesCompleted']),
    totalBytes: Number.isFinite(totalBytesValue) ? totalBytesValue : null,
    warnings: readWarnings(source),
  };
}

/** 将 Electron worker 的完成结果归一化为对话框稳定展示结构。 */
function normalizeExportResult(payload: DeploymentExportResult): DeploymentExportViewResult | null {
  const source = payload as unknown as Record<string, unknown>;
  const outputPath = readString(source, ['outputPath', 'resultPath', 'filePath', 'path']);
  if (!outputPath) return null;

  return {
    outputPath,
    fileCount: readNonNegativeNumber(source, ['fileCount', 'completedFiles', 'totalFiles']),
    totalBytes: readNonNegativeNumber(source, ['totalBytes', 'copiedBytes', 'completedBytes', 'bytesWritten']),
    externalAssetCount: readNonNegativeNumber(source, ['externalAssetCount']),
    warnings: readWarnings(source),
  };
}

/** 判断异常是否来自用户主动取消，兼容 Electron AbortError 和 worker 自定义错误码。 */
function isCanceledError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const source = error as Error & { code?: unknown };
  const normalizedCode = typeof source.code === 'string' ? source.code.toLowerCase() : '';
  return source.name === 'AbortError' || normalizedCode.includes('cancel') || /取消|cancel(?:ed|led)?/iu.test(source.message);
}

/** 提取未知异常中的可读消息。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 管理部署导出的 IPC 订阅、场景快照、取消、重试结果和 Console 日志。 */
export function useDeploymentExport(): DeploymentExportController {
  const [state, setState] = useState<DeploymentExportState>(INITIAL_DEPLOYMENT_EXPORT_STATE);
  const mountedRef = useRef(true);
  const activeRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const attemptIdRef = useRef(0);
  const terminalLogStatusRef = useRef<DeploymentExportStatus | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const resultRequestIdRef = useRef<string | null>(null);
  const resultPathRef = useRef<string | null>(null);

  /** 仅在组件仍挂载时更新导出状态，避免异步 IPC 返回后写入已卸载页面。 */
  const updateState = useCallback((updater: (current: DeploymentExportState) => DeploymentExportState): void => {
    if (!mountedRef.current) return;
    setState(updater);
  }, []);

  /** 记录终态日志，同一次尝试只写入一次，避免取消事件和 Promise 结果重复输出。 */
  const pushTerminalLog = useCallback((status: DeploymentExportStatus, message: string): void => {
    if (terminalLogStatusRef.current === status) return;
    terminalLogStatusRef.current = status;
    useEditorStore.getState().pushLog(message);
  }, []);

  /** 将当前尝试切换到取消状态并回收活动标记。 */
  const finishCanceled = useCallback((attemptId: number): void => {
    if (attemptId !== attemptIdRef.current) return;
    activeRef.current = false;
    activeRequestIdRef.current = null;
    resultRequestIdRef.current = null;
    resultPathRef.current = null;
    updateState((current) => ({
      ...current,
      status: 'canceled',
      result: null,
      error: null,
      progress: current.progress
        ? { ...current.progress, stage: 'canceled', message: '已取消部署工程导出。' }
        : current.progress,
    }));
    pushTerminalLog('canceled', '已取消导出部署工程。');
  }, [pushTerminalLog, updateState]);

  /** 将当前尝试切换到失败状态并写入 Console。 */
  const finishError = useCallback((attemptId: number, error: unknown): void => {
    if (attemptId !== attemptIdRef.current) return;
    const message = getErrorMessage(error);
    activeRef.current = false;
    activeRequestIdRef.current = null;
    resultRequestIdRef.current = null;
    resultPathRef.current = null;
    updateState((current) => ({ ...current, status: 'error', result: null, error: message }));
    pushTerminalLog('error', `导出部署工程失败：${message}`);
  }, [pushTerminalLog, updateState]);

  /** 将当前尝试切换到成功状态并保存结果路径。 */
  const finishSuccess = useCallback((attemptId: number, result: DeploymentExportViewResult): void => {
    if (attemptId !== attemptIdRef.current) return;
    activeRef.current = false;
    resultRequestIdRef.current = activeRequestIdRef.current;
    activeRequestIdRef.current = null;
    resultPathRef.current = result.outputPath;
    updateState((current) => ({
      ...current,
      status: 'success',
      error: null,
      result,
      progress: current.progress
        ? { ...current.progress, stage: 'completed', percent: 100, message: '部署工程导出完成。' }
        : current.progress,
    }));
    pushTerminalLog('success', `部署工程已导出：${result.outputPath}`);
  }, [pushTerminalLog, updateState]);

  useEffect(() => {
    mountedRef.current = true;
    const subscribe = window.editorApi?.onWebProjectExportProgress;
    if (!subscribe) {
      return () => {
        mountedRef.current = false;
      };
    }

    /** 接收 worker 进度，只在当前存在活动任务时更新，避免旧事件覆盖终态。 */
    const unsubscribe = subscribe((payload) => {
      if (!activeRef.current || payload.requestId !== activeRequestIdRef.current) return;
      const progress = normalizeExportProgress(payload);
      updateState((current) => ({
        ...current,
        status: ['validating', 'selecting-destination'].includes(progress.stage.toLowerCase()) ? 'preparing' : 'exporting',
        progress,
        error: null,
      }));
    });

    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [updateState]);

  /** 点击开始时从 Zustand 读取最新场景并立即序列化，完全绕过 CommandHistory。 */
  const start = useCallback(async (options: StartDeploymentExportOptions): Promise<void> => {
    if (activeRef.current) return;

    const attemptId = attemptIdRef.current + 1;
    attemptIdRef.current = attemptId;
    activeRef.current = true;
    cancelRequestedRef.current = false;
    terminalLogStatusRef.current = null;
    resultRequestIdRef.current = null;
    resultPathRef.current = null;
    const requestId = crypto.randomUUID();
    activeRequestIdRef.current = requestId;

    const sceneSnapshot = useEditorStore.getState().scene;
    const snapshot: DeploymentExportSnapshot = {
      projectName: options.projectName.trim(),
      outputType: options.outputType,
      summary: createDeploymentSceneSummary(sceneSnapshot),
    };

    updateState(() => ({
      status: 'preparing',
      progress: {
        stage: 'preparing',
        percent: 0,
        message: '正在捕获当前场景快照…',
        currentFile: null,
        completedFiles: 0,
        totalFiles: 0,
        completedBytes: 0,
        totalBytes: null,
        warnings: [],
      },
      result: null,
      snapshot,
      error: null,
    }));

    try {
      const exportWebProject = window.editorApi?.exportWebProject;
      if (!exportWebProject) {
        throw new Error('当前环境未提供部署导出能力，请使用 Electron 桌面编辑器。');
      }

      const sceneContent = serializeScene(sceneSnapshot);
      const ipcResult = await exportWebProject({
        requestId,
        suggestedName: snapshot.projectName,
        format: snapshot.outputType,
        sceneContent,
      });

      if (attemptId !== attemptIdRef.current) return;
      const resultSource = ipcResult as unknown as Record<string, unknown>;
      if (resultSource.canceled === true) {
        finishCanceled(attemptId);
        return;
      }

      const result = normalizeExportResult(ipcResult);
      if (!result) throw new Error('部署导出未返回有效结果路径。');
      finishSuccess(attemptId, result);
    } catch (error) {
      if (cancelRequestedRef.current || isCanceledError(error)) {
        finishCanceled(attemptId);
        return;
      }
      finishError(attemptId, error);
    }
  }, [finishCanceled, finishError, finishSuccess, updateState]);

  /** 请求主进程取消当前导出，并等待原导出 Promise 完成清理后再解除 busy。 */
  const cancel = useCallback(async (): Promise<void> => {
    if (!activeRef.current) return;
    const attemptId = attemptIdRef.current;
    cancelRequestedRef.current = true;
    updateState((current) => ({
      ...current,
      progress: current.progress ? { ...current.progress, message: '正在取消并清理临时文件…' } : current.progress,
    }));

    try {
      const cancelWebProjectExport = window.editorApi?.cancelWebProjectExport;
      if (!cancelWebProjectExport) throw new Error('当前环境未提供部署导出取消能力。');
      const requestId = activeRequestIdRef.current;
      if (!requestId) throw new Error('未找到当前部署导出任务标识。');
      const accepted = await cancelWebProjectExport({ requestId });
      if (!accepted) {
        updateState((current) => ({
          ...current,
          progress: current.progress ? { ...current.progress, message: '任务已进入收尾，正在等待最终结果…' } : current.progress,
        }));
      }
    } catch (error) {
      cancelRequestedRef.current = false;
      finishError(attemptId, new Error(`取消部署导出失败：${getErrorMessage(error)}`));
    }
  }, [finishError, updateState]);

  /** 在系统文件管理器中定位成功导出的目录或 ZIP，不改变已有成功结果。 */
  const reveal = useCallback(async (): Promise<void> => {
    const outputPath = resultPathRef.current;
    const requestId = resultRequestIdRef.current;
    if (!outputPath || !requestId) return;

    try {
      const revealWebProjectExport = window.editorApi?.revealWebProjectExport;
      if (!revealWebProjectExport) throw new Error('当前环境未提供打开导出位置能力。');
      await revealWebProjectExport({ requestId });
      updateState((current) => ({ ...current, error: null }));
    } catch (error) {
      const message = getErrorMessage(error);
      updateState((current) => ({ ...current, error: `打开导出位置失败：${message}` }));
      useEditorStore.getState().pushLog(`打开部署工程位置失败：${message}`);
    }
  }, [updateState]);

  /** 关闭终态对话框时恢复初始状态；活动任务必须先取消，防止 UI 与 worker 脱节。 */
  const reset = useCallback((): void => {
    if (activeRef.current) return;
    attemptIdRef.current += 1;
    cancelRequestedRef.current = false;
    terminalLogStatusRef.current = null;
    activeRequestIdRef.current = null;
    resultRequestIdRef.current = null;
    resultPathRef.current = null;
    updateState(() => INITIAL_DEPLOYMENT_EXPORT_STATE);
  }, [updateState]);

  const isBusy = state.status === 'preparing' || state.status === 'exporting';

  return useMemo(() => ({ state, isBusy, start, cancel, reveal, reset }), [cancel, isBusy, reset, reveal, start, state]);
}
