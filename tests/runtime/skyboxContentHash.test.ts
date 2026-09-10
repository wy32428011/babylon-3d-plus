import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { hashSkyboxContent, createSkyboxCacheGeneration } from '../../src/runtime/babylon/skyboxContentHash.ts';

test('HTTP fallback SHA-256 matches native digest for padding boundaries and large inputs', async () => {
  for (const length of [0, 1, 3, 55, 56, 63, 64, 65, 127, 128, 1_000_000]) {
    const backing = Uint8Array.from({ length: length + 17 }, (_, index) => index % 251);
    const bytes = backing.subarray(7, 7 + length);
    const expected = createHash('sha256').update(bytes).digest('hex');
    assert.equal(await hashSkyboxContent(bytes, null), expected, `length=${length}`);
    assert.equal(await hashSkyboxContent(bytes, webcrypto.subtle as SubtleCrypto), expected);
  }
});

test('SHA-256 preserves the exact Float32 bytes and detects changed content', async () => {
  const data = new Float32Array([0, -0, 1.125, Infinity, NaN]);
  const bytes = new Uint8Array(data.buffer);
  const before = bytes.slice();
  const first = await hashSkyboxContent(bytes, null);
  assert.deepEqual(bytes, before);
  bytes[0] = 1;
  assert.notEqual(await hashSkyboxContent(bytes, null), first);
});

test('cache generations work without secure-context randomUUID', () => {
  const first = createSkyboxCacheGeneration();
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.notEqual(createSkyboxCacheGeneration(), first);
});
