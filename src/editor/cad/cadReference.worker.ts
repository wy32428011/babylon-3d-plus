import { CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET } from './cadReference';
import { parseLargeCadReferenceDxf } from './cadReferenceLargeDxf';
import type { CadReferenceDxfWorkerMessage, CadReferenceDxfWorkerRequest } from './cadReferenceWorkerMessages';

/** 向主线程发送 CAD 大文件解析进度，所有文案保持中文可直接展示。 */
function postCadWorkerMessage(message: CadReferenceDxfWorkerMessage): void {
  self.postMessage(message);
}

/** 从未知错误中提取中文错误说明，避免 UI 暴露英文异常前缀。 */
function readCadWorkerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'CAD/DXF 后台解析失败：' + String(error);
}

/** 在 Worker 内读取 DXF 文本，避免超大字符串占用 UI 主线程内存。 */
async function readCadDxfTextInWorker(
  id: string,
  sourceUrl: string,
): Promise<string> {
  postCadWorkerMessage({ id, type: 'progress', percent: 20, detail: '后台线程正在打开 CAD 文件...' });

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error('读取 CAD 文件失败：HTTP ' + response.status);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    postCadWorkerMessage({ id, type: 'progress', percent: 38, detail: '后台线程正在读取 CAD 文件...' });
    const content = await response.text();
    postCadWorkerMessage({ id, type: 'progress', percent: 68, detail: '后台线程已完成 CAD 文件读取。' });
    return content;
  }

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const totalBytes = Number(response.headers.get('content-length') ?? 0);
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    receivedBytes += value.byteLength;
    chunks.push(decoder.decode(value, { stream: true }));

    const readRatio = totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : 0;
    const percent = totalBytes > 0 ? 20 + readRatio * 48 : Math.min(68, 20 + Math.log2(receivedBytes + 1) * 3);
    const detail = totalBytes > 0
      ? '后台线程已读取 ' + Math.round(readRatio * 100) + '%。'
      : '后台线程已读取 ' + (receivedBytes / 1024 / 1024).toFixed(1) + ' MB。';
    postCadWorkerMessage({ id, type: 'progress', percent, detail });
  }

  chunks.push(decoder.decode());
  postCadWorkerMessage({ id, type: 'progress', percent: 68, detail: '后台线程已完成 CAD 文件读取。' });
  return chunks.join('');
}

/** 执行单次 CAD 大文件后台预算扫描，并用固定预算限制返回几何规模。 */
async function parseCadDxfInWorker(request: CadReferenceDxfWorkerRequest): Promise<void> {
  const budget = request.geometryBudget ?? CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET;
  const content = await readCadDxfTextInWorker(request.id, request.sourceUrl);
  postCadWorkerMessage({
    id: request.id,
    type: 'progress',
    percent: 76,
    detail: '后台线程正在解析 CAD，最多返回 ' + budget.maxPolylines + ' 条折线 / ' + budget.maxPoints + ' 个点...',
  });
  const result = parseLargeCadReferenceDxf(content, budget, { unitScaleToMeters: request.unitScaleToMeters });
  postCadWorkerMessage({ id: request.id, type: 'done', result });
}

/** 接收主线程解析请求；Worker 串行处理单个文件以避免同一进程内存叠加。 */
self.onmessage = (event: MessageEvent<CadReferenceDxfWorkerRequest>) => {
  parseCadDxfInWorker(event.data).catch((error: unknown) => {
    postCadWorkerMessage({ id: event.data.id, type: 'error', message: readCadWorkerErrorMessage(error) });
  });
};
