import type { Readable, Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { HistoryPrivateProtocol } from './privateProtocol.ts';
import { HistoryQueryError } from './types.ts';

const MAX_REQUEST_BYTES = 262_144;
const MAX_BUFFERED_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 32;

/**
 * 只为已有的受保护双向字节流提供换行分帧；不创建端口、进程、密钥或授权。
 * 监督者必须先证明进程身份、持久 owner/fencing 和句柄私密性，再创建专用 protocol。
 * 一个 stream 独占一个查询服务；断连后关闭该服务的租约，不能以旧实例或密钥重连。
 */
export class HistoryPrivateStream {
  readonly finished: Promise<void>;
  readonly #buffer = Buffer.allocUnsafe(MAX_REQUEST_BYTES);
  readonly #watchdog: ReturnType<typeof setInterval>;
  #partBytes = 0; #pending = 0; #outputBytes = 0; #closing = false; #lastFrameAt = performance.now();
  #resolve!: () => void; #reject!: (error: unknown) => void;

  constructor(readonly protocol: HistoryPrivateProtocol, readonly input: Readable, readonly output: Writable) {
    if (!protocol || !input || !output || input.destroyed || output.destroyed)
      throw new HistoryQueryError('CHANNEL_REQUIRED', '缺少受保护的私有查询流。');
    this.finished = new Promise<void>((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
    // 监督者仍可 await finished 获取错误；此处避免断连时产生未处理的拒绝。
    void this.finished.catch(() => {});
    // Java 每 15 秒发送认证保活；失联时不能永久保留查询服务与旧通道密钥。
    this.#watchdog = setInterval(() => { if (performance.now() - this.#lastFrameAt >= 45_000) this.#fail(); }, 5000);
    this.#watchdog.unref();
    input.on('data', this.#onData);
    input.once('end', this.#onEnd);
    input.once('close', this.#onEnd);
    input.on('error', this.#onError);
    output.once('close', this.#onEnd);
    output.on('error', this.#onError);
  }

  #onData = (chunk: unknown): void => {
    if (this.#closing) return;
    if (!(chunk instanceof Uint8Array)) { this.#fail(); return; }
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < bytes.length && !this.#closing) {
      const end = bytes.indexOf(10, offset), stop = end < 0 ? bytes.length : end;
      const length = stop - offset;
      if (this.#partBytes + length > MAX_REQUEST_BYTES) { this.#fail(); return; }
      if (length) { bytes.copy(this.#buffer, this.#partBytes, offset, stop); this.#partBytes += length; }
      if (end < 0) return;
      const line = this.#buffer.subarray(0, this.#partBytes);
      this.#partBytes = 0; offset = end + 1;
      if (!line.length || !line.every(byte => byte >= 32 && byte <= 126) || this.#pending >= MAX_PENDING) { this.#fail(); return; }
      this.#lastFrameAt = performance.now(); this.#pending += 1;
      // handle 在首个 await 前验证并登记序号；响应可乱序，但不可乱序接收请求。
      void this.protocol.handle(line.toString('ascii')).then(response => this.#write(response))
        .catch(() => this.#fail()).finally(() => { this.#pending -= 1; });
    }
  };

  #write(response: string): void {
    if (this.#closing) return;
    const line = `${response}\n`, size = Buffer.byteLength(line, 'utf8');
    if (this.#outputBytes + size > MAX_BUFFERED_RESPONSE_BYTES) { this.#fail(); return; }
    this.#outputBytes += size;
    try {
      this.output.write(line, 'utf8', error => {
        this.#outputBytes -= size;
        if (error) this.#fail();
      });
    } catch { this.#fail(); }
  }

  #onEnd = (): void => { this.#fail(); };
  #onError = (): void => { this.#fail(); };
  #fail(): void { this.#finish(new HistoryQueryError('CHANNEL_CLOSED', '私有查询流断开、超限或认证失败。')); }

  #finish(error?: Error): void {
    if (this.#closing) return;
    this.#closing = true; clearInterval(this.#watchdog); this.protocol.close();
    this.input.removeListener('data', this.#onData);
    this.#buffer.fill(0); this.#partBytes = 0;
    this.input.destroy(); this.output.destroy();
    void this.protocol.service.close().then(() => {
      if (error) this.#reject(error); else this.#resolve();
    }, cleanupError => this.#reject(cleanupError));
  }

  close(): Promise<void> { this.#finish(); return this.finished; }
}
