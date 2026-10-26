import type { IDecodedData, ICompressedFormatCapabilities, IKTX2DecoderOptions } from '@babylonjs/core/Materials/Textures/ktx2decoderTypes.js';
import type { LocalKtx2DecoderUrls } from './ktx2DecoderConfiguration';

type Request = { data: Uint8Array; caps: ICompressedFormatCapabilities; options: IKTX2DecoderOptions };
type Job = { request: Request; resolve: (value: IDecodedData) => void; reject: (error: unknown) => void };
type Slot = { worker: Worker; job: Job | null; ready: boolean; idleTimer?: ReturnType<typeof setTimeout>; bootTimer?: ReturnType<typeof setTimeout> };

/** 仅基础设施故障回到同一主线程执行器；文件解析/转码错误原样拒绝。 */
export class Ktx2WorkerInfrastructureError extends Error {}

/** 原生9.12 WorkerPool的初始化reject不会收束任务；此队列显式覆盖该失败路径。 */
export class Ktx2DecodeWorkerPool {
  private readonly queue: Job[] = [];
  private readonly slots = new Set<Slot>();
  private failed: Ktx2WorkerInfrastructureError | null = null;
  private disposed = false;

  constructor(private readonly urls: LocalKtx2DecoderUrls, private readonly concurrency: number,
    private readonly createWorker: () => Worker = () => new Worker(new URL('./ktx2Decode.worker.ts', import.meta.url))) {
    this.concurrency = Math.min(4, Math.max(1, Math.floor(concurrency) || 1));
  }

  decode(request: Request): Promise<IDecodedData> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.disposed) return Promise.reject(new Ktx2WorkerInfrastructureError('KTX2 worker queue disposed'));
    return new Promise((resolve, reject) => {
      // 与引擎原生worker入口一致，在提交时冻结源字节；调用者buffer保持所有权。
      const copy = new Uint8Array(request.data.byteLength); copy.set(request.data);
      this.queue.push({ request: { ...request, data: copy }, resolve, reject }); this.pump();
    });
  }

  private fail(error: unknown): void {
    if (this.failed || this.disposed) return;
    this.failed = new Ktx2WorkerInfrastructureError('本地KTX2 worker不可用：' + (error instanceof Error ? error.message : String(error)));
    const jobs = this.queue.splice(0);
    for (const slot of this.slots) { if (slot.job) jobs.push(slot.job); this.close(slot); }
    for (const job of jobs) job.reject(this.failed);
  }

  private close(slot: Slot): void {
    clearTimeout(slot.bootTimer); clearTimeout(slot.idleTimer); slot.worker.terminate(); this.slots.delete(slot);
  }

  private pump(): void {
    if (this.failed || this.disposed) return;
    for (const slot of this.slots) if (slot.ready && !slot.job && this.queue.length) this.dispatch(slot);
    while (this.queue.length > [...this.slots].filter(slot => !slot.ready).length && this.slots.size < this.concurrency) {
      let worker: Worker;
      try { worker = this.createWorker(); } catch (error) { this.fail(error); return; }
      const slot: Slot = { worker, ready: false, job: null };
      this.slots.add(slot);
      worker.addEventListener('error', event => this.fail(event.message || 'worker error'));
      worker.addEventListener('messageerror', () => this.fail('worker message could not be deserialized'));
      worker.addEventListener('message', event => {
        if (this.disposed || this.failed || !this.slots.has(slot)) return;
        const data = event.data;
        if (!slot.ready && data?.action === 'init') {
          clearTimeout(slot.bootTimer); slot.ready = true;
          this.pump(); return;
        }
        if (data?.action !== 'decoded' || !slot.job) { this.fail('unexpected KTX2 worker response'); return; }
        const job = slot.job; slot.job = null;
        if (data.success) job.resolve(data.decodedData);
        else job.reject(data.msg);
        slot.idleTimer = setTimeout(() => { if (!slot.job) this.close(slot); }, 10000);
        this.pump();
      });
      slot.bootTimer = setTimeout(() => this.fail('worker initialization timed out'), 10000);
      try { worker.postMessage({ action: 'init', urls: this.urls }); } catch (error) { this.fail(error); return; }
    }
  }

  private dispatch(slot: Slot): void {
    const job = this.queue.shift()!; slot.job = job;
    clearTimeout(slot.idleTimer);
    try {
      const copy = job.request.data;
      slot.worker.postMessage({ action: 'setDefaultDecoderOptions', options: job.request.options });
      slot.worker.postMessage({ action: 'decode', data: copy, caps: job.request.caps }, [copy.buffer]);
    } catch (error) { this.fail(error); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const jobs = this.queue.splice(0);
    for (const slot of this.slots) { if (slot.job) jobs.push(slot.job); this.close(slot); }
    for (const job of jobs) job.reject(new Ktx2WorkerInfrastructureError('KTX2 worker queue disposed'));
  }
}
