import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { hashPublishedBlob } from '../../src/runtime/assets/publishedBlobHash.ts';

test('分块 SHA-256 与标准实现一致，覆盖尾块和跨块边界', async () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1_000_003]) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
    assert.equal(await hashPublishedBlob(new Blob([bytes]), undefined, 137), createHash('sha256').update(bytes).digest('hex'), String(size));
  }
});

test('取消内容校验后立即停止读取', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(hashPublishedBlob(new Blob(['model']), controller.signal), { name: 'AbortError' });
});
