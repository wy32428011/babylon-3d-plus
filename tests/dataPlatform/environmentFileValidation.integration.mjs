import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateEnvironmentFile, disposeEnvironmentFileValidation } from '../../dist-electron/ipc/environmentFileValidation.js';

async function createGlb(filePath, binaryLength = 4) {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: binaryLength }], meshes: [{ primitives: [{}] }] }));
  const jsonSize = Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(28 + jsonSize);
  prefix.write('glTF'); prefix.writeUInt32LE(2, 4); prefix.writeUInt32LE(prefix.length + binaryLength, 8);
  prefix.writeUInt32LE(jsonSize, 12); prefix.writeUInt32LE(0x4e4f534a, 16);
  prefix.fill(0x20, 20, 20 + jsonSize); json.copy(prefix, 20);
  prefix.writeUInt32LE(binaryLength, 20 + jsonSize); prefix.writeUInt32LE(0x004e4942, 24 + jsonSize);
  const handle = await open(filePath, 'w');
  try { await handle.write(prefix); await handle.truncate(prefix.length + binaryLength); } finally { await handle.close(); }
}

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'environment-worker-'));
  try { await run(root); } finally { await disposeEnvironmentFileValidation(); await rm(root, { recursive: true, force: true }); }
}

test('工作线程验证哈希，重复缓存与返回副本不污染后续调用，文件变化重新校验', async () => {
  await withRoot(async (root) => {
    const filePath = path.join(root, 'model.glb');
    await createGlb(filePath);
    const bytes = await readFile(filePath);
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    const first = await validateEnvironmentFile(filePath, { expectedSize: bytes.length, expectedSha256 });
    assert.equal(first.fileSha256, expectedSha256);
    first.warnings.push('外部篡改');
    const cached = await validateEnvironmentFile(filePath, { expectedSha256 });
    assert.ok(!cached.warnings.includes('外部篡改'));
    await assert.rejects(validateEnvironmentFile(filePath, { expectedSha256: 'a'.repeat(64) }), /SHA-256/);
    await assert.rejects(validateEnvironmentFile(filePath, { expectedSize: bytes.length + 1 }), /大小/);
    bytes[bytes.length - 1] = 123;
    await writeFile(filePath, bytes);
    await assert.rejects(validateEnvironmentFile(filePath, { expectedSha256 }), /SHA-256/);
    const changed = await validateEnvironmentFile(filePath);
    assert.notEqual(changed.fileSha256, expectedSha256);
    bytes.write('bad!'); await writeFile(filePath, bytes);
    await assert.rejects(validateEnvironmentFile(filePath), /magic/);
    await createGlb(filePath);
    assert.equal((await validateEnvironmentFile(filePath)).fileSha256, expectedSha256);
  });
});

test('预取消、排队取消、活动线程取消均明确拒绝且后续任务可用', async () => {
  await withRoot(async (root) => {
    const filePath = path.join(root, 'large.glb');
    await createGlb(filePath, 128 * 1024 * 1024);
    const pre = AbortSignal.abort();
    await assert.rejects(validateEnvironmentFile(filePath, { signal: pre }), { name: 'AbortError' });
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = validateEnvironmentFile(filePath, { signal: activeController.signal });
    const queued = validateEnvironmentFile(filePath, { signal: queuedController.signal });
    const checked = Promise.all([
      assert.rejects(active, { name: 'AbortError' }),
      assert.rejects(queued, { name: 'AbortError' }),
    ]);
    queuedController.abort();
    setTimeout(() => activeController.abort(), 20);
    await checked;
    const small = path.join(root, 'small.glb'); await createGlb(small);
    assert.ok((await validateEnvironmentFile(small)).fileSha256);
  });
});

test('有界队列拒绝溢出，销毁拒绝待处理任务并支持后续重新使用', async () => {
  await withRoot(async (root) => {
    const filePath = path.join(root, 'large.glb');
    await createGlb(filePath, 128 * 1024 * 1024);
    const resultsPromise = Promise.allSettled(Array.from({ length: 67 }, () => validateEnvironmentFile(filePath)));
    await disposeEnvironmentFileValidation();
    const results = await resultsPromise;
    assert.ok(results.every((result) => result.status === 'rejected'));
    assert.equal(results.filter((result) => result.status === 'rejected' && /队列已满/.test(result.reason.message)).length, 2);
    const small = path.join(root, 'small.glb'); await createGlb(small);
    assert.ok((await validateEnvironmentFile(small)).fileSha256);
    await disposeEnvironmentFileValidation();
    await disposeEnvironmentFileValidation();
  });
});

test('不存在的文件和无效预期值明确拒绝，不启动无界后台重试', async () => {
  await withRoot(async (root) => {
    const filePath = path.join(root, 'missing.glb');
    await assert.rejects(validateEnvironmentFile(filePath), /ENOENT/);
    await assert.rejects(validateEnvironmentFile(filePath, { expectedSha256: 'invalid' }), /SHA-256 无效/);
    await assert.rejects(validateEnvironmentFile(filePath, { expectedSize: NaN }), /预期文件大小无效/);
  });
});

test('大文件哈希期间主线程定时器继续响应', async () => {
  await withRoot(async (root) => {
    const filePath = path.join(root, 'large.glb');
    await createGlb(filePath, 128 * 1024 * 1024);
    let ticks = 0;
    const heartbeat = setInterval(() => { ticks += 1; }, 5);
    try {
      const result = await validateEnvironmentFile(filePath);
      assert.ok(result.fileSizeBytes > 128 * 1024 * 1024);
      assert.ok(ticks >= 2, '工作线程校验时主线程必须继续处理消息循环');
    } finally { clearInterval(heartbeat); }
  });
});
