import { open, type FileHandle } from 'node:fs/promises';

const CHUNK_BYTES = 256 * 1024;

/**
 * 授权检查由 editor-asset 协议入口完成。每个块独占其 ArrayBuffer，避免 Node→Web
 * 通用适配器为 Buffer 再复制一次；字节队列最多预取一个块，取消后关闭同一文件句柄。
 */
export function createAssetFileByteStream(filePath: string, signal?: AbortSignal, sizeHint?: number): ReadableStream<Uint8Array> {
  let opening: Promise<FileHandle> | null = null;
  let closing: Promise<void> | null = null;
  let stopped = false;
  let abort: (() => void) | null = null;
  let position = 0;
  const detach = () => { if (abort) signal?.removeEventListener('abort', abort); };
  const close = (): Promise<void> => {
    closing ??= (opening ?? Promise.resolve(null)).then(handle => handle?.close(), () => undefined);
    return closing;
  };
  return new ReadableStream({
    type: 'bytes',
    start(controller) {
      abort = () => {
        if (stopped) return;
        stopped = true;
        detach();
        controller.error(signal?.reason ?? new DOMException('资源读取已取消', 'AbortError'));
        void close().catch(error => console.warn('取消本地资源读取时关闭文件失败。', (error as NodeJS.ErrnoException).code));
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      opening = open(filePath, 'r');
      return opening.then(() => {
        if (stopped) return close();
      }, error => {
        stopped = true;
        detach();
        throw error;
      });
    },
    async pull(controller) {
      if (stopped || !opening) return;
      try {
        const handle = await opening;
        if (stopped) return;
        // 入口已有 stat 时，小文件不保留整块 backing buffer；提示长度不作为提前 EOF 的依据。
        const remaining = sizeHint !== undefined && Number.isSafeInteger(sizeHint) ? sizeHint - position : -1;
        const chunk = new Uint8Array(remaining >= 0 ? Math.min(CHUNK_BYTES, Math.max(1, remaining)) : CHUNK_BYTES);
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
        if (stopped) return;
        if (bytesRead === 0) {
          detach();
          await close();
          if (stopped) return;
          stopped = true;
          const request = controller.byobRequest;
          controller.close();
          request?.respond(0);
          return;
        }
        position += bytesRead;
        controller.enqueue(bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead));
      } catch (error) {
        if (stopped) return;
        stopped = true;
        detach();
        controller.error(error);
        await close();
      }
    },
    cancel() {
      stopped = true;
      detach();
      return close();
    },
  }, { highWaterMark: CHUNK_BYTES });
}
