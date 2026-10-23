import type { CadReferenceParseResult } from './cadReferenceCore';
import { CAD_REFERENCE_MAX_GEOMETRY_BYTES } from './cadReferenceGeometryPolicy';
import { parseCadReferenceDxfStream } from './cadReferenceLargeDxf';
import type { CadReferenceDxfWorkerMessage, CadReferenceDxfWorkerRequest } from './cadReferenceWorkerMessages';

/** 完成消息转移共享几何缓冲区，避免 Worker 与渲染线程重复持有整图数据。 */
function postCadWorkerMessage(message: CadReferenceDxfWorkerMessage, transferables: Transferable[] = []): void {
  const workerScope = self as unknown as {
    postMessage: (payload: CadReferenceDxfWorkerMessage, transfer: Transferable[]) => void;
  };
  workerScope.postMessage(message, transferables);
}

/** 多个显示组可共享同一原型，transfer 列表必须对缓冲区去重。 */
function collectCadGeometryTransferables(result: CadReferenceParseResult): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const layer of result.layers) {
    if (layer.positions.buffer instanceof ArrayBuffer) buffers.add(layer.positions.buffer);
    if (layer.polylinePointCounts.buffer instanceof ArrayBuffer) buffers.add(layer.polylinePointCounts.buffer);
    if (layer.instanceMatrices?.buffer instanceof ArrayBuffer) buffers.add(layer.instanceMatrices.buffer);
  }
  return [...buffers];
}

async function parseCadDxfInWorker(request: CadReferenceDxfWorkerRequest): Promise<void> {
  let lastProgressAt = -Infinity;
  const result = await parseCadReferenceDxfStream(
    () => fetch(request.sourceUrl),
    {
      unitScaleToMeters: request.unitScaleToMeters,
      maxGeometryBytes: request.maxGeometryBytes ?? CAD_REFERENCE_MAX_GEOMETRY_BYTES,
      onProgress: ({ percent, detail }) => {
        const now = performance.now();
        if (now - lastProgressAt < 100 && percent < 100) return;
        lastProgressAt = now;
        postCadWorkerMessage({ id: request.id, type: 'progress', percent, detail });
      },
    },
  );
  postCadWorkerMessage({ id: request.id, type: 'done', result }, collectCadGeometryTransferables(result));
}

/** 一个 Worker 只承接一个任务，客户端取消时终止线程会同时终止文件读取。 */
self.onmessage = (event: MessageEvent<CadReferenceDxfWorkerRequest>) => {
  self.onmessage = null;
  parseCadDxfInWorker(event.data).catch((error: unknown) => {
    const message = error instanceof Error && error.message ? error.message : 'CAD/DXF 后台解析失败：' + String(error);
    postCadWorkerMessage({ id: event.data.id, type: 'error', message });
  });
};
