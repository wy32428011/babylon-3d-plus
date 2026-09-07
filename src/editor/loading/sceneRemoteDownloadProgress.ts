import type { RemoteDownloadProgress } from '../../../electron/shared/remoteDownloadProgress';

export type RemoteSyncProgress = {
  runId: string;
  phase: string;
  completed: number;
  total: number;
  message: string;
  error: string | null;
  download?: RemoteDownloadProgress;
};

type DownloadKind = 'model' | 'environment';
type ActiveDownload = { runId: string; download: RemoteDownloadProgress };
type DownloadSnapshot = {
  sceneSessionId: string;
  model: ActiveDownload | null;
  environment: ActiveDownload | null;
};

function formatKilobytes(bytes: number): string {
  return `${(Math.max(0, Number.isFinite(bytes) ? bytes : 0) / 1024).toFixed(1)} KB`;
}

function formatBytes(downloaded: number, total: number | null, withPercent: boolean): string {
  if (total === null || !Number.isFinite(total) || total < 0 || (total === 0 && downloaded > 0)) {
    return `已下载 ${formatKilobytes(downloaded)}（总大小未知）`;
  }
  const percent = total > 0 ? Math.min(100, Math.max(0, downloaded / total * 100)) : null;
  return `${withPercent ? '已下载 ' : ''}${formatKilobytes(downloaded)} / ${formatKilobytes(total)}${withPercent && percent !== null ? `（${percent.toFixed(1)}%）` : ''}`;
}

export function formatRemoteDownloadProgress(download: RemoteDownloadProgress): {
  summary: string;
  currentFile: string | null;
} {
  return {
    summary: formatBytes(download.downloadedBytes, download.totalBytes, true),
    currentFile: download.currentFile
      ? `${download.currentFile}：${formatBytes(download.currentFileDownloadedBytes, download.currentFileTotalBytes, false)}`
      : null,
  };
}

/** 字节流只更新进度，不重复写入 Console 的业务阶段日志。 */
export function remoteSyncLogKey(progress: RemoteSyncProgress): string {
  return JSON.stringify([progress.runId, progress.phase, progress.completed, progress.total, progress.message, progress.error]);
}

export function isRemoteDownloadVisible(progress: RemoteSyncProgress): boolean {
  return Boolean(progress.download && (
    progress.phase === 'downloading'
    // 一个文件进入校验时，其他并行文件可能仍在下载。
    || (progress.phase === 'validating' && progress.download.activeFiles > 0)
  ));
}

/** 仅承载下载展示；不参与场景首帧和 100% 完成条件。 */
export function createSceneRemoteDownloadStore() {
  let snapshot: DownloadSnapshot = { sceneSessionId: '', model: null, environment: null };
  const listeners = new Set<() => void>();
  const runIds: Record<DownloadKind, string | null> = { model: null, environment: null };
  const retiredRuns = new Set<string>();
  const retire = (kind: DownloadKind) => {
    if (runIds[kind]) retiredRuns.add(`${kind}:${runIds[kind]}`);
    // 仅保留近期任务，避免长期编辑会话累积历史。
    while (retiredRuns.size > 64) retiredRuns.delete(retiredRuns.values().next().value!);
    runIds[kind] = null;
  };
  const publish = (next: DownloadSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const begin = (sceneSessionId: string) => {
    if (snapshot.sceneSessionId === sceneSessionId) return;
    // 项目共用在途资源同步任务；清除上一场景展示，但允许新订阅继续接收同一run。
    runIds.model = null;
    runIds.environment = null;
    publish({ sceneSessionId, model: null, environment: null });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    begin,
    clear: (sceneSessionId: string) => {
      if (snapshot.sceneSessionId === sceneSessionId) begin('');
    },
    receive: (sceneSessionId: string, kind: DownloadKind, progress: RemoteSyncProgress): boolean => {
      if (snapshot.sceneSessionId !== sceneSessionId || retiredRuns.has(`${kind}:${progress.runId}`)) return false;
      if (runIds[kind] !== progress.runId) {
        retire(kind);
        runIds[kind] = progress.runId;
      }
      const next = isRemoteDownloadVisible(progress) && progress.download
        ? { runId: progress.runId, download: progress.download }
        : null;
      if (snapshot[kind] !== next) publish({ ...snapshot, [kind]: next });
      if (progress.phase === 'completed' || progress.phase === 'failed') retire(kind);
      return true;
    },
  };
}

export const sceneRemoteDownloadStore = createSceneRemoteDownloadStore();
