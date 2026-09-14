import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAssetFileByteStream } from '../../electron/shared/assetFileByteStream.ts';

test('受控资源字节流保留完整字节和短尾块，慢消费者不能覆盖已交付的数据', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'asset-byte-stream-'));
  const file = path.join(root, 'fixture.bin');
  const bytes = Buffer.alloc(1024 * 1024 + 37);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
  try {
    await fs.writeFile(file, bytes);
    const reader = createAssetFileByteStream(file).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.ok(chunks.every(chunk => chunk.byteLength <= 256 * 1024));
    assert.equal(chunks.at(-1)!.length, 37);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('取消字节流关闭对应文件，未读取的取消和读取错误也能正常结束', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'asset-byte-cancel-'));
  const file = path.join(root, 'fixture.bin');
  try {
    await fs.writeFile(file, Buffer.alloc(1024 * 1024));
    const reader = createAssetFileByteStream(file).getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel();
    assert.equal((await reader.read()).done, true);
    await createAssetFileByteStream(file).cancel();
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(new Response(createAssetFileByteStream(file, abort.signal)).arrayBuffer(), { name: 'AbortError' });
    await assert.rejects(new Response(createAssetFileByteStream(path.join(root, 'missing'))).arrayBuffer(), { code: 'ENOENT' });
    await fs.rename(file, path.join(root, 'closed.bin'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('空文件与 BYOB 读取在 EOF 完成而不挂起', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'asset-byte-empty-'));
  const file = path.join(root, 'fixture.bin');
  try {
    await fs.writeFile(file, Buffer.alloc(0));
    assert.equal((await new Response(createAssetFileByteStream(file)).arrayBuffer()).byteLength, 0);
    await fs.writeFile(file, Buffer.from([1, 2, 3]));
    const reader = createAssetFileByteStream(file).getReader({ mode: 'byob' });
    const result = await reader.read(new Uint8Array(8));
    assert.deepEqual(Array.from(result.value!), [1, 2, 3]);
    assert.equal((await reader.read(new Uint8Array(8))).done, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('长度提示只减少分配，不截断真实文件内容', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'asset-byte-hint-'));
  const file = path.join(root, 'fixture.bin');
  try {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    await fs.writeFile(file, bytes);
    const stream = createAssetFileByteStream(file, undefined, bytes.length);
    const reader = stream.getReader();
    const first = await reader.read();
    assert.equal(first.value!.buffer.byteLength, bytes.length);
    assert.equal((await reader.read()).done, true);
    for (const size of [0, 2, 100, Number.NaN]) {
      assert.deepEqual(Buffer.from(await new Response(createAssetFileByteStream(file, undefined, size)).arrayBuffer()), bytes);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
