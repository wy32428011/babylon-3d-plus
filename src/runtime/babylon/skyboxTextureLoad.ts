import { MAX_SKYBOX_DECODE_SOURCE_BYTES } from './skyboxDecodedValidation.ts';

type DisposableTexture = { dispose(): void; onDisposeObservable: { addOnce(callback: () => void): unknown } };
type TextureLoadOptions<T> = {
  create: (url: string, onLoad: () => void, onError: (message?: string, cause?: unknown) => void) => T;
  prepare?: (texture: T) => Promise<void>;
  read?: (url: string, signal: AbortSignal) => Promise<Blob>;
  transformBlob?: (blob: Blob, signal: AbortSignal) => Promise<Blob>;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void;
  onStage?: (stage: SkyboxLoadStage, durationMs: number | null) => void;
};
export type SkyboxLoadStage = 'reading' | 'decoding' | 'prefiltering';

function abortError(): Error {
  const error = new Error('天空盒加载已取消。');
  error.name = 'AbortError';
  return error;
}

/** 可指定更小的读取额度；任何调用都不能放宽 512 MiB 的天空盒文件上限。 */
export async function readSkyboxTextureBlob(url: string, signal: AbortSignal,
  maxBytes = MAX_SKYBOX_DECODE_SOURCE_BYTES,
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void): Promise<Blob> {
  const limit = Math.min(maxBytes, MAX_SKYBOX_DECODE_SOURCE_BYTES);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('天空盒读取上限必须是正整数。');
  if (signal.aborted) throw abortError();
  const response = await fetch(url, { signal });
  const tooLarge = () => new Error(`天空盒文件超过读取上限（${limit === MAX_SKYBOX_DECODE_SOURCE_BYTES ? '512 MiB' : `${limit} 字节`}）。`);
  const lengthHeader = response.headers.get('content-length')?.trim();
  const declaredLength = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  const earlyError = !response.ok ? new Error(`天空盒文件读取失败：HTTP ${response.status}`)
    : declaredLength !== null && declaredLength > limit ? tooLarge() : null;
  if (earlyError) {
    // 读取已被判定失败时归还上游；即使取消也失败，仍保留原始 HTTP/体积错误。
    try { await response.body?.cancel(earlyError); } finally { throw earlyError; }
  }
  onProgress?.(0, declaredLength);
  if (url.startsWith('editor-asset://local/') && declaredLength !== null && declaredLength <= limit) {
    // 此协议的长度由主进程对已授权本地文件 stat 得到；原生 Blob 读取不经过繁忙的渲染线程逐块回调。
    const blob = await response.blob();
    if (signal.aborted) throw abortError();
    if (blob.size > limit) throw tooLarge();
    onProgress?.(blob.size, declaredLength);
    return blob;
  }
  if (!response.body) return response.blob();
  let receivedBytes = 0;
  const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > limit) throw tooLarge();
      onProgress?.(receivedBytes, declaredLength);
      controller.enqueue(chunk);
    },
  }), { signal });
  try {
    // 交给浏览器维护 Blob，不把全部下载块留在 JavaScript 数组中；流错误会取消上游。
    return await new Response(counted, { headers: { 'Content-Type': response.headers.get('content-type') ?? '' } }).blob();
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error;
  }
}

/** 下载可取消；纹理及预过滤使用引擎资源，不向 Scene 注入无法随取消回收的隐式等待项。 */
export async function loadSkyboxTexture<T extends DisposableTexture>(url: string, signal: AbortSignal, options: TextureLoadOptions<T>): Promise<T> {
  if (signal.aborted) throw abortError();
  const readStartedAt = performance.now();
  options.onStage?.('reading', null);
  let blob = await (options.read ? options.read(url, signal)
    : readSkyboxTextureBlob(url, signal, MAX_SKYBOX_DECODE_SOURCE_BYTES, options.onProgress));
  options.onProgress?.(blob.size, blob.size);
  options.onStage?.('reading', performance.now() - readStartedAt);
  if (signal.aborted) throw abortError();
  const decodeStartedAt = performance.now();
  options.onStage?.('decoding', null);
  if (options.transformBlob) blob = await options.transformBlob(blob, signal);
  if (signal.aborted) throw abortError();
  const objectURL = (options.createObjectURL ?? URL.createObjectURL)(blob);
  const revoke = options.revokeObjectURL ?? URL.revokeObjectURL;
  return new Promise<T>((resolve, reject) => {
    let texture: T | undefined;
    let completed = false;
    let processing = false;
    let revoked = false;
    const releaseURL = () => {
      if (revoked) return;
      revoked = true;
      revoke(objectURL);
    };
    const finish = (failure?: { cause: unknown }) => {
      if (completed) return;
      completed = true;
      signal.removeEventListener('abort', onAbort);
      if (failure || signal.aborted) texture?.dispose();
      if (failure || signal.aborted) releaseURL();
      if (signal.aborted) reject(abortError());
      else if (failure) reject(failure.cause);
      else resolve(texture!);
    };
    const onAbort = () => {
      if (!processing) { finish({ cause: abortError() }); return; }
      signal.removeEventListener('abort', onAbort);
      releaseURL();
      reject(abortError());
      // 已启动的 GPU 预过滤不能在途中释放输入纹理；回调结束后统一销毁，不再提交给场景。
    };
    const onLoad = () => queueMicrotask(async () => {
      if (completed || processing) return;
      processing = true;
      try {
        options.onStage?.('decoding', performance.now() - decodeStartedAt);
        if (!signal.aborted) {
          const prepareStartedAt = performance.now();
          options.onStage?.('prefiltering', null);
          await options.prepare?.(texture!);
          options.onStage?.('prefiltering', performance.now() - prepareStartedAt);
        }
        finish();
      } catch (cause) { finish({ cause }); }
    });
    const onError = (message?: string, cause?: unknown) => queueMicrotask(() => {
      finish({ cause: cause instanceof Error ? cause : new Error(message || '天空盒纹理解码失败。') });
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    try {
      texture = options.create(objectURL, onLoad, onError);
      // 反射材质 clone 可能仍读取原 URL，保留到所属纹理释放；不提前撤销有效资源。
      texture.onDisposeObservable.addOnce(releaseURL);
    }
    catch (cause) { finish({ cause }); }
  });
}
