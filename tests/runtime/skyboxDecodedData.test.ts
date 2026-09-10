import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSkyboxData } from '../../src/runtime/babylon/skyboxDecodedData.ts';
import { hashSkyboxCubeFaces, planSkyboxCacheWrite, validateSkyboxCacheEntry, validateSkyboxCubeData } from '../../src/runtime/babylon/skyboxDecodedCache.ts';
import { validateSkyboxDecodeInput, validateSkyboxSourceDimensions } from '../../src/runtime/babylon/skyboxDecodedValidation.ts';

const cube = (size = 2) => ({ size, type: 1, format: 4, gammaSpace: false,
  ...Object.fromEntries(['front', 'back', 'left', 'right', 'up', 'down'].map(face => [face, new Float32Array(size * size * 3)])) });

class TestWorker {
  static workers: TestWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  payload: unknown;
  terminated = 0;
  constructor() { TestWorker.workers.push(this); }
  postMessage(payload: unknown) { this.payload = payload; }
  terminate() { this.terminated++; }
}

test('天空盒准备在 Worker 中处理 Blob，结果返回后释放 Worker', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  TestWorker.workers = [];
  try {
    const blob = new Blob(['original bytes']);
    const result = prepareSkyboxData(blob, 'exr', 2, new AbortController().signal);
    const worker = TestWorker.workers[0];
    assert.equal((worker.payload as { blob: Blob }).blob, blob);
    const expected = cube();
    worker.onmessage?.({ data: { kind: 'result', cube: expected, metrics: { cache: 'miss' } } });
    assert.equal(await result, expected);
    assert.equal(worker.terminated, 1);
  } finally { globalThis.Worker = previous; }
});

test('取消加载立即终止 Worker，迟到数据不会变为成功', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  TestWorker.workers = [];
  try {
    const controller = new AbortController();
    const result = prepareSkyboxData(new Blob(['large EXR']), 'exr', 2, controller.signal);
    const worker = TestWorker.workers[0];
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
    worker.onmessage?.({ data: { kind: 'result', cube: cube() } });
    assert.equal(worker.terminated, 1);
  } finally { globalThis.Worker = previous; }
});

test('Worker 解码失败显示原始错误并释放，兼容性返回 null 不冒充成功数据', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  TestWorker.workers = [];
  try {
    const failed = prepareSkyboxData(new Blob(['bad']), 'exr', 2);
    const worker = TestWorker.workers[0];
    worker.onmessage?.({ data: { kind: 'error', message: 'EXR 文件已损坏' } });
    await assert.rejects(failed, /EXR 文件已损坏/);
    assert.equal(worker.terminated, 1);
    const compatible = prepareSkyboxData(new Blob(['zip']), 'exr', 2);
    TestWorker.workers[1].onmessage?.({ data: { kind: 'result', cube: null, metrics: { cache: 'unsupported' } } });
    assert.equal(await compatible, null);
  } finally { globalThis.Worker = previous; }
});

test('大纹理解码最多同时启动两个 Worker，排队取消不再创建 Worker', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  TestWorker.workers = [];
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  const requests = controllers.map(controller => prepareSkyboxData(new Blob(['large']), 'exr', 2, controller.signal));
  try {
    assert.equal(TestWorker.workers.length, 2);
    controllers[2].abort();
    await assert.rejects(requests[2], { name: 'AbortError' });
    TestWorker.workers[0].onmessage?.({ data: { kind: 'result', cube: cube() } });
    TestWorker.workers[1].onmessage?.({ data: { kind: 'result', cube: cube() } });
    await Promise.all(requests.slice(0, 2));
    assert.equal(TestWorker.workers.length, 2);
    assert.deepEqual(TestWorker.workers.map(worker => worker.terminated), [1, 1]);
  } finally {
    controllers.forEach(controller => controller.abort());
    await Promise.allSettled(requests);
    globalThis.Worker = previous;
  }
});

test('缓存淘汰同时满足字节和数量限制，覆盖原 key 不重复计费', () => {
  const entries = [{ key: 'old', byteLength: 40, lastUsed: 1 }, { key: 'new', byteLength: 40, lastUsed: 2 }];
  assert.deepEqual(planSkyboxCacheWrite(entries, { key: 'next', byteLength: 40, lastUsed: 3 }, 2, 100),
    { write: true, deleteKeys: ['old'] });
  assert.deepEqual(planSkyboxCacheWrite(entries, { key: 'new', byteLength: 50, lastUsed: 3 }, 2, 100),
    { write: true, deleteKeys: [] });
  assert.deepEqual(planSkyboxCacheWrite(entries, { key: 'large', byteLength: 101, lastUsed: 3 }, 2, 100),
    { write: false, deleteKeys: [] });
  assert.deepEqual(planSkyboxCacheWrite(entries, { key: 'next', byteLength: 80, lastUsed: 3 }, 2, 100),
    { write: true, deleteKeys: ['old', 'new'] });
});

test('只接收六面完整同尺寸的 Float32 线性 RGB 缓存记录', () => {
  const valid = cube();
  assert.equal(validateSkyboxCubeData(valid, 2), true);
  assert.equal(validateSkyboxCubeData({ ...valid, front: new Float32Array(3) }, 2), false);
  assert.equal(validateSkyboxCubeData({ ...valid, back: new Uint16Array(12) }, 2), false);
  assert.equal(validateSkyboxCubeData({ ...valid, gammaSpace: true }, 2), false);
  assert.equal(validateSkyboxCubeData(valid, 4), false);
});

test('创建 Worker 前拒绝超限源文件与超过 1024 的立方体面', async () => {
  await assert.rejects(prepareSkyboxData(new Blob(['small']), 'hdr', 1025), /1024/);
  await assert.rejects(prepareSkyboxData({ size: 512 * 1024 * 1024 + 1 } as Blob, 'exr', 512), /512 MiB/);
});

test('LRU 淘汰先清理负数或非有限元数据，不让错误大小抵消有效缓存', () => {
  const entries = [{ key: 'invalid-size', byteLength: -1000, lastUsed: 1 },
    { key: 'invalid-time', byteLength: 40, lastUsed: Number.NaN },
    { key: 'valid', byteLength: 40, lastUsed: 2 }];
  assert.deepEqual(planSkyboxCacheWrite(entries, { key: 'next', byteLength: 80, lastUsed: 3 }, 8, 100),
    { write: true, deleteKeys: ['invalid-size', 'invalid-time', 'valid'] });
});

test('源宽高与文件大小边界在像素解码前检查', () => {
  assert.doesNotThrow(() => validateSkyboxDecodeInput(512 * 1024 * 1024, 1024));
  assert.doesNotThrow(() => validateSkyboxSourceDimensions(8192, 4096));
  assert.throws(() => validateSkyboxSourceDimensions(8192, 4097), /32 Mi/);
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
    assert.throws(() => validateSkyboxSourceDimensions(invalid, 1024), /正整数/);
    assert.throws(() => validateSkyboxSourceDimensions(1024, invalid), /正整数/);
  }
  assert.equal(validateSkyboxCacheEntry({ key: 'a', byteLength: Number.POSITIVE_INFINITY, lastUsed: 1 }), false);
  assert.equal(validateSkyboxCacheEntry({ key: 'a', byteLength: 1, lastUsed: -1 }), false);
});

test('六面 SHA-256 能识别同尺寸同类型的浮点内容篡改', async () => {
  const data = cube() as unknown as Parameters<typeof hashSkyboxCubeFaces>[0];
  const before = await hashSkyboxCubeFaces(data);
  (data.front as Float32Array)[0] = 0.25;
  assert.equal(validateSkyboxCubeData(data, 2), true);
  const after = await hashSkyboxCubeFaces(data);
  assert.notEqual(after.front, before.front);
  for (const face of ['back', 'left', 'right', 'up', 'down'] as const) assert.equal(after[face], before[face]);
});
