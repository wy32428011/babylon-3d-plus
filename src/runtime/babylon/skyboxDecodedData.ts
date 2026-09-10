import type { CubeMapInfo } from '@babylonjs/core/Misc/HighDynamicRange/panoramaToCubemap';
import { validateSkyboxCubeData } from './skyboxDecodedCache.ts';
import { validateSkyboxDecodeInput } from './skyboxDecodedValidation.ts';

export type SkyboxDecodeStage = 'read' | 'hash' | 'cache-read' | 'decode' | 'convert' | 'cache-write';
export type SkyboxDecodeMetrics = {
  cache: 'hit' | 'miss' | 'unavailable' | 'unsupported';
  stages: Partial<Record<SkyboxDecodeStage, number>>;
  sourceBytes: number;
  outputBytes: number;
  workerMs: number;
  decoderVersion: string;
  warnings: string[];
};
export type SkyboxDecodeRequest = { blob: Blob; format: 'exr' | 'hdr'; size: number };
export type SkyboxDecodeResponse =
  | { kind: 'stage'; stage: SkyboxDecodeStage }
  | { kind: 'result'; cube: CubeMapInfo | null; metrics: SkyboxDecodeMetrics }
  | { kind: 'error'; message: string };

type QueuedSkyboxPreparation = { start: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void };
const waiting: QueuedSkyboxPreparation[] = [];
const MAX_SKYBOX_WORKERS = 2;
const MAX_WAITING_PREPARATIONS = 8;
let activeWorkers = 0;
let lastMetrics: SkyboxDecodeMetrics | null = null;

export function getSkyboxDecodeMetrics(): SkyboxDecodeMetrics | null {
  return lastMetrics ? { ...lastMetrics, stages: { ...lastMetrics.stages }, warnings: [...lastMetrics.warnings] } : null;
}

/**
 * 原始 Blob 直接交给 Worker，主线程不展开 EXR、不做 SHA 或立方体转换。
 * 无 Worker 或需要额外 EXR 解码依赖时返回 null，由原加载器按既有行为处理。
 */
export function prepareSkyboxData(blob: Blob, format: 'exr' | 'hdr', size: number, signal?: AbortSignal,
  options: { onStage?: (stage: SkyboxDecodeStage) => void; onMetrics?: (metrics: SkyboxDecodeMetrics) => void } = {}): Promise<CubeMapInfo | null> {
  if (signal?.aborted) return Promise.reject(cancelled());
  try { validateSkyboxDecodeInput(blob.size, size); } catch (error) { return Promise.reject(error); }
  if (typeof Worker === 'undefined') return Promise.resolve(null);
  if (waiting.length >= MAX_WAITING_PREPARATIONS) return Promise.reject(new Error('天空盒预处理队列已满，请取消旧加载后重试。'));
  return new Promise((resolve, reject) => {
    const job: QueuedSkyboxPreparation = { signal, reject, abort: () => {
      const index = waiting.indexOf(job);
      if (index < 0) return;
      waiting.splice(index, 1); signal?.removeEventListener('abort', job.abort); reject(cancelled());
    }, start: () => {
      signal?.removeEventListener('abort', job.abort);
      activeWorkers++;
      let worker: Worker | null = null;
      let finished = false;
      const finish = (error?: unknown, cube: CubeMapInfo | null = null) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', abort);
        worker?.terminate();
        activeWorkers--;
        if (error) reject(error); else resolve(cube);
        drainQueue();
      };
      const abort = () => finish(cancelled());
      try {
        worker = new Worker(new URL('./skyboxDecodedData.worker.ts', import.meta.url), { type: 'module' });
        signal?.addEventListener('abort', abort, { once: true });
        worker.onmessage = (event: MessageEvent<SkyboxDecodeResponse>) => {
          if (finished) return;
          const data = event.data;
          if (data.kind === 'stage') { options.onStage?.(data.stage); return; }
          if (data.kind === 'error') { finish(new Error(data.message)); return; }
          if (data.cube !== null && !validateSkyboxCubeData(data.cube, size)) {
            finish(new Error('天空盒 Worker 返回了不完整的立方体数据。')); return;
          }
          if (data.metrics) {
            lastMetrics = data.metrics;
            for (const warning of data.metrics.warnings ?? []) console.warn(`天空盒预处理缓存：${warning}`);
            options.onMetrics?.(data.metrics);
          }
          finish(undefined, data.cube);
        };
        worker.onerror = event => { event.preventDefault(); finish(new Error(`天空盒 Worker 执行失败：${event.message}`)); };
        worker.onmessageerror = () => finish(new Error('天空盒 Worker 数据传输失败。'));
        worker.postMessage({ blob, format, size } satisfies SkyboxDecodeRequest);
        if (signal?.aborted) abort();
      } catch (error) { finish(error); }
    } };
    waiting.push(job);
    signal?.addEventListener('abort', job.abort, { once: true });
    drainQueue();
  });
}

function cancelled(): DOMException { return new DOMException('天空盒预处理已取消。', 'AbortError'); }

function drainQueue(): void {
  while (activeWorkers < MAX_SKYBOX_WORKERS && waiting.length > 0) waiting.shift()!.start();
}
