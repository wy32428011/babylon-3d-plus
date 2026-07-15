import {
  CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET,
  CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES,
  parseCadReferenceDxf,
  type CadReferenceParseResult,
} from './cadReference';
import type { CadReferenceDxfWorkerMessage, CadReferenceDxfWorkerRequest } from './cadReferenceWorkerMessages';

export type CadReferenceLargeDxfProgress = {
  percent: number;
  detail: string;
};

export type ParseCadReferenceDxfForImportOptions = {
  sourceUrl: string;
  fileSizeBytes: number;
  readSmallFileText: (onProgress: (percent: number, detail: string) => void) => Promise<string>;
  onProgress: (progress: CadReferenceLargeDxfProgress) => void;
};

/** 判断当前导入是否应转入 Worker，避免 UI 主线程读取和同步解析超大 DXF。 */
export function shouldParseCadReferenceDxfInWorker(fileSizeBytes: number): boolean {
  return fileSizeBytes >= CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES && typeof Worker !== 'undefined';
}

/** 判断文件大小是否已经超过必须后台解析的阈值。 */
function isCadReferenceLargeDxfFile(fileSizeBytes: number): boolean {
  return fileSizeBytes >= CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES;
}

/** 统一 CAD 导入解析入口：普通文件保持精确解析，大文件切换到带预算的后台解析。 */
export async function parseCadReferenceDxfForImport(
  options: ParseCadReferenceDxfForImportOptions,
): Promise<CadReferenceParseResult> {
  if (isCadReferenceLargeDxfFile(options.fileSizeBytes)) {
    if (!shouldParseCadReferenceDxfInWorker(options.fileSizeBytes)) {
      throw new Error('当前环境不支持 CAD 后台解析，无法安全导入超大 DXF。');
    }

    return parseCadReferenceDxfInWorker(options.sourceUrl, options.onProgress);
  }

  const content = await options.readSmallFileText((percent, detail) => options.onProgress({ percent, detail }));
  options.onProgress({ percent: 76, detail: '正在精确解析 CAD 图元...' });
  await waitForCadImportFrame();
  return parseCadReferenceDxf(content);
}

export type CadReferenceDxfWorkerTask = {
  promise: Promise<CadReferenceParseResult>;
  cancel: () => void;
};

/** 创建可取消的一次性 Worker 任务，场景切换或删除 CAD 时可立即释放后台资源。 */
export function createCadReferenceDxfWorkerTask(
  sourceUrl: string,
  onProgress: (progress: CadReferenceLargeDxfProgress) => void = () => undefined,
  unitScaleToMeters?: number,
): CadReferenceDxfWorkerTask {
  const id = crypto.randomUUID();
  const worker = new Worker(new URL('./cadReference.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let rejectTask: (reason: Error) => void = () => undefined;

  const promise = new Promise<CadReferenceParseResult>((resolve, reject) => {
    rejectTask = reject;
    worker.onmessage = (event: MessageEvent<CadReferenceDxfWorkerMessage>) => {
      const message = event.data;
      if (settled || message.id !== id) return;

      if (message.type === 'progress') {
        onProgress({ percent: message.percent, detail: message.detail });
        return;
      }

      settled = true;
      worker.terminate();
      if (message.type === 'done') {
        resolve(message.result);
        return;
      }

      reject(new Error(message.message));
    };

    worker.onerror = (event) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error('CAD/DXF 后台解析线程失败：' + (event.message || '未知错误')));
    };
  });

  const request: CadReferenceDxfWorkerRequest = {
    id,
    sourceUrl,
    geometryBudget: CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET,
    unitScaleToMeters,
  };
  onProgress({
    percent: 18,
    detail: 'CAD 文件较大，已切换后台解析（预算 ' + request.geometryBudget.maxPolylines + ' 条折线 / ' + request.geometryBudget.maxPoints + ' 个点）。',
  });
  worker.postMessage(request);

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectTask(new Error('CAD/DXF 后台解析已取消。'));
    },
  };
}

/** 创建一次性 Worker 完成大 DXF 解析，适用于无需外部取消句柄的导入流程。 */
export function parseCadReferenceDxfInWorker(
  sourceUrl: string,
  onProgress: (progress: CadReferenceLargeDxfProgress) => void = () => undefined,
  unitScaleToMeters?: number,
): Promise<CadReferenceParseResult> {
  return createCadReferenceDxfWorkerTask(sourceUrl, onProgress, unitScaleToMeters).promise;
}

/** 给浏览器一帧更新导入进度，避免解析阶段提示被同步任务遮挡。 */
function waitForCadImportFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }

    setTimeout(resolve, 0);
  });
}
