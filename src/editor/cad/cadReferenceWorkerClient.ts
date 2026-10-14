import { CAD_REFERENCE_MAX_GEOMETRY_BYTES } from './cadReferenceGeometryPolicy';
import {
  CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES,
  parseCadReferenceDxf,
  type CadReferenceParseResult,
} from './cadReference';
import type { CadReferenceDxfWorkerMessage, CadReferenceDxfWorkerRequest } from './cadReferenceWorkerMessages';

export type CadReferenceLargeDxfProgress = { percent: number; detail: string };
export type CadReferenceDxfLoadOptions = {
  importMode?: string;
  contentLengthBytes?: number;
  preferSafeUnknownSize?: boolean;
};
export type CadReferenceDxfWorkerOptions = { signal?: AbortSignal; maxGeometryBytes?: number };

export type ParseCadReferenceDxfForImportOptions = CadReferenceDxfLoadOptions & CadReferenceDxfWorkerOptions & {
  sourceUrl: string;
  fileSizeBytes?: number;
  unitScaleToMeters?: number;
  readSmallFileText: (onProgress: (percent: number, detail: string) => void) => Promise<string>;
  onProgress: (progress: CadReferenceLargeDxfProgress) => void;
};

function requiresCadWorker(fileSizeBytes: number | undefined, options: CadReferenceDxfLoadOptions): boolean {
  if (options.importMode === 'large-preview') return true;
  const sizes = [fileSizeBytes, options.contentLengthBytes];
  if (sizes.some((size) => typeof size === 'number' && size >= CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES)) return true;
  const hasKnownSize = sizes.some((size) => typeof size === 'number' && Number.isFinite(size) && size > 0);
  return !hasKnownSize && options.preferSafeUnknownSize !== false;
}

/** 大文件、旧后台导入及长度未知的资源统一采用安全流式后台路径。 */
export function shouldParseCadReferenceDxfInWorker(fileSizeBytes?: number, options: CadReferenceDxfLoadOptions = {}): boolean {
  return requiresCadWorker(fileSizeBytes, options) && typeof Worker !== 'undefined';
}

function createCadAbortError(): Error {
  const error = new Error('CAD/DXF 导入已取消。');
  error.name = 'AbortError';
  return error;
}

function throwIfCadImportAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createCadAbortError();
}

/** 普通文件保持精确解析，大文件与未知长度禁止回退到 UI 主线程聚合读取。 */
export async function parseCadReferenceDxfForImport(options: ParseCadReferenceDxfForImportOptions): Promise<CadReferenceParseResult> {
  throwIfCadImportAborted(options.signal);
  if (requiresCadWorker(options.fileSizeBytes, options)) {
    if (typeof Worker === 'undefined') throw new Error('当前环境不支持 CAD 后台解析，无法安全导入超大或长度未知的 DXF。');
    return parseCadReferenceDxfInWorker(options.sourceUrl, options.onProgress, options.unitScaleToMeters, options);
  }
  const content = await options.readSmallFileText((percent, detail) => options.onProgress({ percent, detail }));
  throwIfCadImportAborted(options.signal);
  options.onProgress({ percent: 76, detail: '正在精确解析 CAD 图元...' });
  await waitForCadImportFrame();
  throwIfCadImportAborted(options.signal);
  return parseCadReferenceDxf(content, { unitScaleToMeters: options.unitScaleToMeters });
}

export type CadReferenceDxfWorkerTask = { promise: Promise<CadReferenceParseResult>; cancel: () => void };

/** 创建一次性可取消任务，所有完成与异常路径都释放线程及 AbortSignal 监听。 */
export function createCadReferenceDxfWorkerTask(
  sourceUrl: string,
  onProgress: (progress: CadReferenceLargeDxfProgress) => void = () => undefined,
  unitScaleToMeters?: number,
  options: CadReferenceDxfWorkerOptions = {},
): CadReferenceDxfWorkerTask {
  if (options.signal?.aborted) return { promise: Promise.reject(createCadAbortError()), cancel: () => undefined };
  const id = crypto.randomUUID();
  const worker = new Worker(new URL('./cadReference.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let rejectTask: (reason: Error) => void = () => undefined;
  const cancel = () => finishWithError(createCadAbortError());
  const cleanup = () => {
    options.signal?.removeEventListener('abort', cancel);
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  };
  const finishWithError = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectTask(error);
  };
  const promise = new Promise<CadReferenceParseResult>((resolve, reject) => {
    rejectTask = reject;
    worker.onmessage = (event: MessageEvent<CadReferenceDxfWorkerMessage>) => {
      const message = event.data;
      if (settled || message.id !== id) return;
      if (message.type === 'progress') {
        try { onProgress({ percent: message.percent, detail: message.detail }); }
        catch (error) { finishWithError(error instanceof Error ? error : new Error(String(error))); }
        return;
      }
      if (message.type === 'error') { finishWithError(new Error(message.message)); return; }
      settled = true;
      cleanup();
      resolve(message.result);
    };
    worker.onerror = (event) => finishWithError(new Error('CAD/DXF 后台解析线程失败：' + (event.message || '未知错误')));
    worker.onmessageerror = () => finishWithError(new Error('CAD/DXF 后台解析结果传输失败。'));
  });
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  if (!settled) {
    const request: CadReferenceDxfWorkerRequest = {
      id, sourceUrl, unitScaleToMeters,
      maxGeometryBytes: options.maxGeometryBytes ?? CAD_REFERENCE_MAX_GEOMETRY_BYTES,
    };
    try {
      onProgress({ percent: 18, detail: '已切换后台流式解析 CAD，保留全部受支持线稿。' });
      if (!settled) worker.postMessage(request);
    } catch (error) {
      finishWithError(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return { promise, cancel };
}

export function parseCadReferenceDxfInWorker(
  sourceUrl: string,
  onProgress: (progress: CadReferenceLargeDxfProgress) => void = () => undefined,
  unitScaleToMeters?: number,
  options: CadReferenceDxfWorkerOptions = {},
): Promise<CadReferenceParseResult> {
  return createCadReferenceDxfWorkerTask(sourceUrl, onProgress, unitScaleToMeters, options).promise;
}

/** 给浏览器一帧更新导入进度，避免解析阶段提示被同步任务遮挡。 */
function waitForCadImportFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}
