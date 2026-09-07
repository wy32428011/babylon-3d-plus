/** 下载字节是已落盘的完整文件偏移，包含有效续传前缀；与场景渲染完成状态独立。 */
export type RemoteDownloadProgress = {
  downloadedBytes: number;
  totalBytes: number | null;
  activeFiles: number;
  currentFile: string | null;
  currentFileDownloadedBytes: number;
  currentFileTotalBytes: number | null;
};

export type FileDownloadProgress = { downloadedBytes: number; totalBytes: number | null };
type Entry = FileDownloadProgress & { fileName: string; expectedBytes: number | null; done: boolean };

/** O(1)汇总并行文件进度，最多每200ms广播一次，全部下载完成时立即广播。 */
export class RemoteDownloadTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Set<string>();
  private downloadedBytes = 0;
  private knownTotalBytes = 0;
  private unknownTotals = 0;
  private remainingFiles: number;
  private currentId: string | null = null;
  private lastPublishedAt = -Infinity;
  private closed = false;
  private trailingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly notify: (progress: RemoteDownloadProgress) => void;
  private readonly now: () => number;

  constructor(files: Array<{ id: string; fileName: string; totalBytes?: number | null }>,
    notify: (progress: RemoteDownloadProgress) => void, now = () => performance.now()) {
    this.notify = notify;
    this.now = now;
    this.remainingFiles = files.length;
    for (const file of files) {
      if (this.entries.has(file.id)) throw new Error('下载进度文件标识重复');
      const totalBytes = validBytes(file.totalBytes) ? file.totalBytes : null;
      this.entries.set(file.id, { fileName: file.fileName, expectedBytes: totalBytes, totalBytes, downloadedBytes: 0, done: false });
      if (totalBytes === null) this.unknownTotals += 1;
      else this.knownTotalBytes += totalBytes;
    }
  }

  start(id: string): void {
    if (this.closed || !this.entries.has(id)) return;
    this.active.add(id);
    this.currentId = id;
    this.publish();
  }

  update(id: string, progress: FileDownloadProgress): void {
    if (this.closed) return;
    const entry = this.entries.get(id);
    if (!entry || !validBytes(progress.downloadedBytes)) return;
    const total = validBytes(progress.totalBytes) ? progress.totalBytes : entry.expectedBytes;
    this.downloadedBytes += progress.downloadedBytes - entry.downloadedBytes;
    entry.downloadedBytes = progress.downloadedBytes;
    if (entry.totalBytes === null) this.unknownTotals -= 1;
    else this.knownTotalBytes -= entry.totalBytes;
    entry.totalBytes = total !== null && total >= entry.downloadedBytes ? total : null;
    if (entry.totalBytes === null) this.unknownTotals += 1;
    else this.knownTotalBytes += entry.totalBytes;
    if (this.active.has(id)) this.currentId = id;
    this.publish();
  }

  finish(id: string, actualBytes: number): void {
    if (this.closed) return;
    this.update(id, { downloadedBytes: actualBytes, totalBytes: actualBytes });
    const entry = this.entries.get(id);
    if (entry && !entry.done) { entry.done = true; this.remainingFiles -= 1; }
    this.stop(id);
  }

  stop(id: string): void {
    if (this.closed) return;
    this.active.delete(id);
    if (this.currentId === id) this.currentId = this.active.values().next().value ?? null;
    this.publish(this.remainingFiles === 0);
  }

  close(): void {
    this.closed = true;
    if (this.trailingTimer !== null) clearTimeout(this.trailingTimer);
    this.trailingTimer = null;
  }

  snapshot(): RemoteDownloadProgress {
    const current = this.currentId === null ? null : this.entries.get(this.currentId);
    return { downloadedBytes: this.downloadedBytes, totalBytes: this.unknownTotals ? null : this.knownTotalBytes,
      activeFiles: this.active.size, currentFile: current?.fileName ?? null,
      currentFileDownloadedBytes: current?.downloadedBytes ?? 0, currentFileTotalBytes: current?.totalBytes ?? null };
  }

  private publish(force = false): void {
    if (this.closed) return;
    const now = this.now();
    if (!force && now - this.lastPublishedAt < 200) {
      if (this.trailingTimer === null) {
        this.trailingTimer = setTimeout(() => {
          this.trailingTimer = null;
          this.publish(true);
        }, 200 - (now - this.lastPublishedAt));
      }
      return;
    }
    if (this.trailingTimer !== null) clearTimeout(this.trailingTimer);
    this.trailingTimer = null;
    this.lastPublishedAt = now;
    this.notify(this.snapshot());
  }
}

function validBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
