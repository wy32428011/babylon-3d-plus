import type { RefObject } from 'react';
import type { ScenePerformanceMonitor } from '../../../runtime/babylon/ScenePerformanceMonitor';
import type { EditorPerformanceRunSession } from '../../runtime/editorPerformanceRunSession';
import { getScenePreparationTimings } from '../../loading/scenePreparationProgress';

type Options = {
  performanceMonitorRef: RefObject<ScenePerformanceMonitor | null>;
  performanceRunSessionRef: RefObject<EditorPerformanceRunSession | null>;
  pushLog: (message: string) => void;
  getErrorMessage: (error: unknown) => string;
};

async function copyScenePerformanceReport(report: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(report);
      return;
    } catch {
      // Electron 权限或非安全上下文会进入同步 fallback。
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = report;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  let copied: boolean;
  try {
    textarea.focus();
    textarea.select();
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
  }
  if (!copied) throw new Error('系统剪贴板拒绝复制。');
}

/** 复制报告不新增采样，也不改变报告中的完整精度与准备阶段时间。 */
export function createScenePerformanceReportHandlers({
  performanceMonitorRef, performanceRunSessionRef, pushLog, getErrorMessage,
}: Options) {
  async function handleCopyPerformanceReport(): Promise<void> {
    const monitor = performanceMonitorRef.current;
    if (!monitor) {
      pushLog('Scene View 性能报告尚未就绪。');
      return;
    }

    try {
      const report = JSON.parse(monitor.createReport());
      report.scenePreparation = getScenePreparationTimings();
      await copyScenePerformanceReport(JSON.stringify(report, null, 2));
      pushLog('Scene View 性能报告已复制到剪贴板。');
    } catch (error) {
      pushLog(`Scene View 性能报告复制失败：${getErrorMessage(error)}`);
    }
  }

  async function handleCopyPerformanceRunReport(): Promise<void> {
    const session = performanceRunSessionRef.current;
    if (!session) {
      pushLog('性能运行报告尚未就绪。');
      return;
    }
    try {
      await copyScenePerformanceReport(session.createReport());
      pushLog('性能运行报告已复制到剪贴板。');
    } catch (error) {
      pushLog(`性能运行报告复制失败：${getErrorMessage(error)}`);
    }
  }

  return { handleCopyPerformanceReport, handleCopyPerformanceRunReport };
}
