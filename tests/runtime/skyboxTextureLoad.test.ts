import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSkyboxTexture, readSkyboxTextureBlob } from '../../src/runtime/babylon/skyboxTextureLoad.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let resolveRead!: (blob: Blob) => void;
  let onLoad!: () => void;
  let onError!: (message?: string, cause?: unknown) => void;
  let resolvePrepare!: () => void;
  const events: string[] = [];
  const controller = new AbortController();
  const disposers: Array<() => void> = [];
  const texture = { onDisposeObservable: { addOnce: (callback: () => void) => disposers.push(callback) },
    dispose: () => { events.push('dispose'); for (const callback of disposers.splice(0)) callback(); } };
  const promise = loadSkyboxTexture('editor-asset://sky.exr', controller.signal, {
    read: (_url, signal) => new Promise((resolve, reject) => {
      resolveRead = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    createObjectURL: () => { events.push('url'); return 'blob:skybox'; },
    revokeObjectURL: () => events.push('revoke'),
    create: (_url, loaded, failed) => { onLoad = loaded; onError = failed; events.push('create'); return texture; },
    prepare: async () => { events.push('prepare'); await new Promise<void>(resolve => { resolvePrepare = resolve; }); },
  });
  return { promise, controller, events, texture, read: () => resolveRead(new Blob(['EXR'])),
    loaded: () => onLoad(), failed: () => onError('invalid EXR'), prepared: () => resolvePrepare() };
}

test('天空盒读取、解码和预过滤全部完成才提交，临时URL只释放一次', async () => {
  const f = fixture(); let finished = false;
  void f.promise.then(() => { finished = true; });
  f.read(); await tick(); f.loaded(); await tick();
  assert.equal(finished, false);
  f.prepared(); assert.equal(await f.promise, f.texture);
  assert.deepEqual(f.events, ['url', 'create', 'prepare']);
  f.texture.dispose();
  assert.deepEqual(f.events, ['url', 'create', 'prepare', 'dispose', 'revoke']);
});

test('取消下载不会创建纹理或留下待处理资源', async () => {
  const f = fixture(); const failed = assert.rejects(f.promise, { name: 'AbortError' });
  f.controller.abort(); await failed;
  assert.deepEqual(f.events, []);
});

test('取消预过滤立即结束调用，但等GPU操作退出后才释放纹理', async () => {
  const f = fixture(); const failed = assert.rejects(f.promise, { name: 'AbortError' });
  f.read(); await tick(); f.loaded(); await tick();
  f.controller.abort(); await failed;
  assert.equal(f.events.includes('dispose'), false);
  f.prepared(); await tick();
  assert.equal(f.events.filter(event => event === 'dispose').length, 1);
  assert.equal(f.events.filter(event => event === 'revoke').length, 1);
});

test('纹理创建后但尚未开始预过滤时取消，立即释放并忽略迟到解码回调', async () => {
  const f = fixture(); const failed = assert.rejects(f.promise, { name: 'AbortError' });
  f.read(); await tick();
  f.controller.abort(); await failed;
  assert.deepEqual(f.events, ['url', 'create', 'dispose', 'revoke']);
  f.loaded(); await tick();
  assert.deepEqual(f.events, ['url', 'create', 'dispose', 'revoke']);
});

test('解码失败释放纹理并保留错误原因', async () => {
  const f = fixture(); const failed = assert.rejects(f.promise, /invalid EXR/);
  f.read(); await tick(); f.failed(); await failed;
  assert.deepEqual(f.events, ['url', 'create', 'dispose', 'revoke']);
});

test('Content-Length 超过 512 MiB 时立即取消响应，不读取数据', async () => {
  const previousFetch = globalThis.fetch;
  let pulled = 0, cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    pulled++; controller.enqueue(new Uint8Array([1]));
  }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  globalThis.fetch = async () => new Response(stream, { headers: { 'Content-Length': String(512 * 1024 * 1024 + 1) } });
  try {
    await assert.rejects(readSkyboxTextureBlob('editor-asset://sky.exr', new AbortController().signal), /512 MiB/);
    assert.equal(pulled, 0);
    assert.equal(cancelled, 1);
  } finally { globalThis.fetch = previousFetch; }
});

test('受控本地协议采用原生Blob读取，仍校验读取后的实际体积', async () => {
  const previousFetch = globalThis.fetch;
  let nativeReads = 0;
  globalThis.fetch = async () => ({ ok: true, headers: new Headers({ 'Content-Length': '4' }),
    blob: async () => { nativeReads++; return new Blob(['1234']); },
    get body() { throw new Error('本地已知长度不应经过逐块JS管道'); },
  }) as unknown as Response;
  try {
    assert.equal((await readSkyboxTextureBlob('editor-asset://local/fixture.exr', new AbortController().signal, 4)).size, 4);
    assert.equal(nativeReads, 1);
    globalThis.fetch = async () => ({ ok: true, headers: new Headers({ 'Content-Length': '4' }),
      blob: async () => new Blob(['12345']),
    }) as unknown as Response;
    await assert.rejects(readSkyboxTextureBlob('editor-asset://local/fixture.exr', new AbortController().signal, 4), /超过.*读取上限/);
  } finally { globalThis.fetch = previousFetch; }
});

test('未知、非法或低报长度均按实际流量限制，超限后取消上游', async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const declared of [null, 'not-a-number', '1']) {
      let index = 0, cancelled = 0;
      const chunks = [new Uint8Array(6), new Uint8Array(3), new Uint8Array(2)];
      const stream = new ReadableStream<Uint8Array>({ pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close();
      }, cancel() { cancelled++; } }, { highWaterMark: 0 });
      globalThis.fetch = async () => new Response(stream, { headers: declared ? { 'Content-Length': declared } : {} });
      await assert.rejects(readSkyboxTextureBlob('editor-asset://sky.exr', new AbortController().signal, 8), /超过.*读取上限/);
      await tick();
      assert.equal(cancelled, 1, `长度 ${declared} 的超限流应取消上游`);
    }
  } finally { globalThis.fetch = previousFetch; }
});

test('流式读取保持实际字节和 MIME，边界大小允许通过', async () => {
  const previousFetch = globalThis.fetch;
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  let index = 0;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close();
  } }), { headers: { 'Content-Type': 'image/x-exr', 'Content-Length': '5' } });
  try {
    const blob = await readSkyboxTextureBlob('editor-asset://sky.exr', new AbortController().signal, 5);
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([1, 2, 3, 4, 5]));
    assert.equal(blob.type, 'image/x-exr');
  } finally { globalThis.fetch = previousFetch; }
});

test('读取响应体期间取消会立即中止流并返回 AbortError', async () => {
  const previousFetch = globalThis.fetch;
  let cancelled = 0;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull: () => new Promise(() => undefined), cancel() { cancelled++; },
  }));
  try {
    const controller = new AbortController();
    const reading = readSkyboxTextureBlob('editor-asset://sky.exr', controller.signal, 8);
    const assertion = assert.rejects(reading, { name: 'AbortError' });
    await tick(); controller.abort(); await assertion;
    assert.equal(cancelled, 1);
  } finally { globalThis.fetch = previousFetch; }
});


test('HTTP天空盒按实际字节上报进展，未知长度不伪造百分比', async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const known of [false, true]) {
      const progress: Array<[number, number | null]> = [];
      const chunks = [new Uint8Array(3), new Uint8Array(2)]; let index = 0;
      globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close();
      } }), { headers: known ? { 'Content-Length': '5' } : {} });
      const blob = await readSkyboxTextureBlob('http://example.test/sky.exr', new AbortController().signal, 10,
        (received, total) => progress.push([received, total]));
      assert.equal(blob.size, 5);
      assert.deepEqual(progress, [[0, known ? 5 : null], [3, known ? 5 : null], [5, known ? 5 : null]]);
    }
  } finally { globalThis.fetch = previousFetch; }
});
