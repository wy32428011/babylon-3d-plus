import { CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET, type CadReferenceParseResult } from './cadReference';
import { parseLargeCadReferenceDxf } from './cadReferenceLargeDxf';
import type { CadReferenceDxfWorkerMessage, CadReferenceDxfWorkerRequest } from './cadReferenceWorkerMessages';

/** 向主线程发送 CAD 大文件解析进度；完成消息会转移紧凑几何缓冲区，避免复制数十 MB 数据。 */
function postCadWorkerMessage(message: CadReferenceDxfWorkerMessage, transferables: Transferable[] = []): void {
  const workerScope = self as unknown as {
    postMessage: (payload: CadReferenceDxfWorkerMessage, transfer: Transferable[]) => void;
  };
  workerScope.postMessage(message, transferables);
}

/** 收集解析结果中的 TypedArray 缓冲区，供 Worker 以零拷贝方式交给主线程。 */
function collectCadGeometryTransferables(result: CadReferenceParseResult): Transferable[] {
  const transferables: Transferable[] = [];
  for (const layer of result.layers) {
    if (layer.positions.buffer instanceof ArrayBuffer) transferables.push(layer.positions.buffer);
    if (layer.polylinePointCounts.buffer instanceof ArrayBuffer) transferables.push(layer.polylinePointCounts.buffer);
  }
  return transferables;
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
    const bytes = new Uint8Array(await response.arrayBuffer());
    postCadWorkerMessage({ id, type: 'progress', percent: 68, detail: '后台线程已完成 CAD 文件读取。' });
    return decodeCadDxfBytes(bytes);
  }

  const totalBytes = Number(response.headers.get('content-length') ?? 0);
  let contiguousBytes = totalBytes > 0 ? new Uint8Array(totalBytes) : null;
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    if (contiguousBytes && receivedBytes + value.byteLength <= contiguousBytes.byteLength) {
      contiguousBytes.set(value, receivedBytes);
    } else {
      if (contiguousBytes) {
        chunks.push(contiguousBytes.slice(0, receivedBytes));
        contiguousBytes = null;
      }
      chunks.push(value.slice());
    }
    receivedBytes += value.byteLength;

    const readRatio = totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : 0;
    const percent = totalBytes > 0 ? 20 + readRatio * 48 : Math.min(68, 20 + Math.log2(receivedBytes + 1) * 3);
    const detail = totalBytes > 0
      ? '后台线程已读取 ' + Math.round(readRatio * 100) + '%。'
      : '后台线程已读取 ' + (receivedBytes / 1024 / 1024).toFixed(1) + ' MB。';
    postCadWorkerMessage({ id, type: 'progress', percent, detail });
  }

  const bytes = contiguousBytes
    ? (receivedBytes === contiguousBytes.byteLength ? contiguousBytes : contiguousBytes.slice(0, receivedBytes))
    : concatenateCadDxfChunks(chunks, receivedBytes);
  postCadWorkerMessage({ id, type: 'progress', percent: 68, detail: '后台线程已完成 CAD 文件读取。' });
  return decodeCadDxfBytes(bytes);
}

/** 将未知数量的读取块合并为一个连续字节数组，仅在服务器未提供长度时使用。 */
function concatenateCadDxfChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** 按 DXF 声明的中文代码页解码图层/块名称，几何数值仍保持 ASCII 兼容。 */
function decodeCadDxfBytes(bytes: Uint8Array): string {
  const headerPreview = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 16 * 1024)));
  const encoding = /\$DWGCODEPAGE[\s\S]{0,80}ANSI_936/i.test(headerPreview) ? 'gb18030' : 'utf-8';
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** 执行单次 CAD 大文件完整扫描，并用高水位安全预算防止异常文件耗尽内存。 */
async function parseCadDxfInWorker(request: CadReferenceDxfWorkerRequest): Promise<void> {
  const budget = request.geometryBudget ?? CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET;
  const content = await readCadDxfTextInWorker(request.id, request.sourceUrl);
  postCadWorkerMessage({
    id: request.id,
    type: 'progress',
    percent: 76,
    detail: '后台线程正在完整解析 CAD（安全上限 ' + budget.maxPolylines + ' 条折线 / ' + budget.maxPoints + ' 个点）...',
  });
  const result = parseLargeCadReferenceDxf(content, budget, { unitScaleToMeters: request.unitScaleToMeters });
  postCadWorkerMessage({ id: request.id, type: 'done', result }, collectCadGeometryTransferables(result));
}

/** 接收主线程解析请求；Worker 串行处理单个文件以避免同一进程内存叠加。 */
self.onmessage = (event: MessageEvent<CadReferenceDxfWorkerRequest>) => {
  parseCadDxfInWorker(event.data).catch((error: unknown) => {
    postCadWorkerMessage({ id: event.data.id, type: 'error', message: readCadWorkerErrorMessage(error) });
  });
};
