import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';
import { hashSha256 } from '../../electron/shared/sha256.ts';
import { digestModelScriptText } from '../../electron/shared/modelScriptCompilation.ts';
import { hashSkyboxContent } from '../../src/runtime/babylon/skyboxContentHash.ts';

test('标准 SHA-256 向量在 Web Crypto 与 HTTP fallback 中保持一致', async () => {
  const vectors = [
    { source: '', digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    { source: 'abc', digest: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
  ];
  for (const { source, digest } of vectors) {
    const bytes = new TextEncoder().encode(source);
    assert.equal(await hashSha256(bytes, null), digest);
    assert.equal(await hashSha256(bytes, webcrypto.subtle), digest);
    assert.equal(await hashSkyboxContent(bytes, null), digest);
  }
});

test('SHA-256 fallback 覆盖填充分界、非零字节偏移和中文 UTF-8', async () => {
  for (const size of [55, 56, 63, 64, 65, 127, 128, 4096]) {
    const storage = Uint8Array.from({ length: size + 10 }, (_, index) => index % 256);
    const bytes = storage.subarray(3, size + 3);
    const expected = createHash('sha256').update(bytes).digest('hex');
    assert.equal(await hashSha256(bytes, null), expected, String(size));
    assert.equal(await hashSha256(bytes, webcrypto.subtle), expected, String(size));
  }
  const source = '参数脚本\u0000😺';
  assert.equal(await digestModelScriptText(source), createHash('sha256').update(source, 'utf8').digest('hex'));
});

test('脚本和天空盒在没有 crypto/subtle 的 HTTP 宿主仍计算相同标准摘要', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    const source = 'export default class RuntimeComponent {}';
    const bytes = new TextEncoder().encode(source);
    const expected = createHash('sha256').update(bytes).digest('hex');
    assert.equal(await digestModelScriptText(source), expected);
    assert.equal(await hashSkyboxContent(bytes), expected);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});
