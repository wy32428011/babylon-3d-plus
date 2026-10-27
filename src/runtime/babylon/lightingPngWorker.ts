import { encodeLightingPixels } from './lightingPngEncode.ts';
import { assertLightingRendererHeadroom, assertLightingWorkingBytes } from '../../../electron/shared/sceneLightingBakeResources.ts';

let workerActive = false;

class LightingPngDataError extends Error {}

/** 单 Worker 上限不改变捕获顺序；额外副本不满足预算时使用原线程路径。 */
export async function encodeLightingPng(pixels: ArrayBufferView, width: number, height: number, name: string,
  signal?: AbortSignal, workingBytes?: number): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (typeof Worker === 'undefined' || workerActive || workingBytes === undefined) {
    return encodeLightingPixels(pixels, width, height, name, signal);
  }
  try {
    const reserved = width * height * 4 * 12 + pixels.byteLength;
    assertLightingWorkingBytes(reserved, workingBytes, `纹理「${name}」`);
    assertLightingRendererHeadroom(reserved);
  } catch {
    return encodeLightingPixels(pixels, width, height, name, signal);
  }
  workerActive = true;
  try {
    // 复制 GPU 读回结果，禁止转移可能仍由调用方持有的原始缓冲区。
    const copy = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength).slice();
    const kind = pixels instanceof Float32Array ? 'float32' : pixels instanceof Float64Array ? 'float64' : 'bytes';
    const png = await new Promise<Uint8Array>((resolve, reject) => {
      let worker: Worker | undefined;
      let finished = false;
      const finish = (error?: unknown, result?: Uint8Array) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', abort);
        worker?.terminate();
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => finish(signal?.reason ?? new DOMException('操作已取消。', 'AbortError'));
      try {
        worker = new Worker(new URL('./lightingPngEncode.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ png?: Uint8Array; kind?: 'data-error' | 'infrastructure-error'; error?: string }>) => {
          if (event.data?.error !== undefined) {
            finish(event.data.kind === 'data-error' ? new LightingPngDataError(event.data.error) : new Error(event.data.error)); return;
          }
          if (!(event.data?.png instanceof Uint8Array)) { finish(new Error('烘焙 PNG Worker 返回了无效数据。')); return; }
          finish(undefined, event.data.png);
        };
        worker.onerror = event => { event.preventDefault(); finish(new Error(`烘焙 PNG Worker 执行失败：${event.message}`)); };
        worker.onmessageerror = () => finish(new Error('烘焙 PNG Worker 数据传输失败。'));
        signal?.addEventListener('abort', abort, { once: true });
        worker.postMessage({ bytes: copy.buffer, kind, width, height, name }, [copy.buffer]);
        if (signal?.aborted) abort();
      } catch (error) { finish(error); }
    });
    signal?.throwIfAborted();
    return png;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LightingPngDataError) throw error;
    // 不同运行环境可能无法启动 Worker；保留原始像素并沿原路径处理。
    return encodeLightingPixels(pixels, width, height, name, signal);
  } finally {
    workerActive = false;
  }
}
