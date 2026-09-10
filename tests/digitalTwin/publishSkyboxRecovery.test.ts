import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { test, type TestContext } from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';
const [{ recoverPublishSkyboxReference }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/publishSkyboxRecovery'),
]>(['electron/ipc/publishSkyboxRecovery.ts']);
const hdr = Buffer.concat([Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n'), Buffer.alloc(32, 1)]);
const hash = createHash('sha256').update(hdr).digest('hex');
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-skybox-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sharedResourcesRoot = path.join(root, 'SharedResources'); await fs.mkdir(sharedResourcesRoot);
  return { root, sharedResourcesRoot, baseUrl: 'http://127.0.0.1:8765', signal: new AbortController().signal, isAuthorizedLocalFile: () => true };
}
test('已授权外部天空盒复制进受管缓存，保留参数和原文件', async t => {
  const f = await fixture(t); const sourcePath = path.join(f.root, 'old.hdr'); await fs.writeFile(sourcePath, hdr);
  const skybox = { sourcePath, sourceUrl: 'old', packagePath: f.root, format: 'hdr', intensity: 0.5, resolution: 512 };
  const result = await recoverPublishSkyboxReference({ ...f, skybox });
  assert.ok(result.sourcePath.startsWith(f.sharedResourcesRoot + path.sep));
  assert.equal(result.skybox.intensity, 0.5); assert.equal(result.skybox.resolution, 512);
  assert.equal(result.skybox.assetRevision, hash); assert.deepEqual(await fs.readFile(result.sourcePath), hdr);
  assert.deepEqual(await fs.readFile(sourcePath), hdr); assert.equal(skybox.sourceUrl, 'old');
});
test('未授权外部文件不能复制', async t => {
  const f = await fixture(t); const sourcePath = path.join(f.root, 'old.hdr'); await fs.writeFile(sourcePath, hdr);
  await assert.rejects(recoverPublishSkyboxReference({ ...f, isAuthorizedLocalFile: () => false, skybox: { sourcePath, format: 'hdr' } }), /授权/);
});
test('缺失但无稳定身份不能凭文件名下载', async t => {
  const f = await fixture(t);
  await assert.rejects(recoverPublishSkyboxReference({ ...f, skybox: { sourcePath: path.join(f.root, '天空盒.hdr'), format: 'hdr' } }), /身份|对应/);
});
test('稳定资源缺失可从同源接口下载并校验SHA', async t => {
  const f = await fixture(t); let downloads = 0;
  const record = { id: '12', displayName: '天空', fileName: 'sky.hdr', fileUrl: '/files/12', format: 'hdr', fileSizeBytes: hdr.length, sha256: hash, revision: '1', updatedAt: null };
  const dependencies = {
    queryRecords: async () => [record as any], syncSkyboxes: async (_base: string, root: string) => {
      downloads++;
      const relativePath = 'Assets/Skyboxes/DataPlatform/Skybox-12/skybox.hdr';
      await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true }); await fs.writeFile(path.join(root, relativePath), hdr);
      await fs.mkdir(path.join(root, '.babylon-editor'), { recursive: true });
      await fs.writeFile(path.join(root, '.babylon-editor', 'data-platform-skybox-index.json'), JSON.stringify({ version: 1, entries: [{ resourceId: '12', displayName: '天空', relativePath, format: 'hdr', fileSizeBytes: hdr.length, sha256: hash, revision: '1', status: 'active', syncedAt: new Date().toISOString() }] }));
    },
  };
  const result = await recoverPublishSkyboxReference({ ...f, skybox: { sourcePath: path.join(f.root, 'missing.hdr'), dataPlatformResourceId: '12', format: 'hdr' }, dependencies });
  assert.equal(downloads, 1); assert.equal(result.skybox.dataPlatformResourceId, '12'); assert.deepEqual(await fs.readFile(result.sourcePath), hdr);
  const remote = await recoverPublishSkyboxReference({ ...f, skybox: { sourceUrl: 'http://127.0.0.1:8765/files/12', dataPlatformResourceId: '12', format: 'hdr' }, dependencies });
  assert.equal(remote.sourcePath, result.sourcePath);
  const withoutId = { ...result.skybox }; delete (withoutId as Record<string, unknown>).dataPlatformResourceId;
  const inferred = await recoverPublishSkyboxReference({ ...f, skybox: withoutId, dependencies });
  assert.equal(inferred.recovered, true); assert.equal(inferred.skybox.dataPlatformResourceId, '12');
  assert.equal(downloads, 1, '内容匹配的已完整校验缓存不得再次触发全库同步');
});
test('重复稳定ID和不符合旧SHA的远端版本均拒绝', async t => {
  const f = await fixture(t); const record = { id: '12', displayName: '天空', fileName: 'sky.hdr', fileUrl: '/files/12', format: 'hdr', fileSizeBytes: hdr.length, sha256: hash, revision: '1', updatedAt: null };
  for (const [records, assetRevision] of [[[record, record], undefined], [[record], 'a'.repeat(64)]] as const) {
    await assert.rejects(recoverPublishSkyboxReference({ ...f, skybox: { sourcePath: path.join(f.root, 'missing.hdr'), dataPlatformResourceId: '12', format: 'hdr', assetRevision }, dependencies: { queryRecords: async () => records as any } }));
  }
});
test('已取消恢复和损坏本地文件不得产生缓存', async t => {
  const f = await fixture(t); const sourcePath = path.join(f.root, 'broken.hdr'); await fs.writeFile(sourcePath, 'bad');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(recoverPublishSkyboxReference({ ...f, signal: controller.signal, skybox: { sourcePath, format: 'hdr' } }), { name: 'AbortError' });
  await assert.rejects(recoverPublishSkyboxReference({ ...f, skybox: { sourcePath, format: 'hdr' } }), /HDR|天空盒/);
  assert.deepEqual(await fs.readdir(f.sharedResourcesRoot), []);
});
test('缓存目录junction越界不允许写入', async t => {
  const f = await fixture(t); const sourcePath = path.join(f.root, 'old.hdr'); await fs.writeFile(sourcePath, hdr);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.sharedResourcesRoot, '.babylon-editor'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(recoverPublishSkyboxReference({ ...f, skybox: { sourcePath, format: 'hdr' } }), /越界/);
  assert.deepEqual(await fs.readdir(outside), []);
});
test('授权路径祖先junction仍拒绝导入，已受管文件可无写入重复复用', async t => {
  const f = await fixture(t); const original = path.join(f.root, 'original'); await fs.mkdir(original);
  await fs.writeFile(path.join(original, 'sky.hdr'), hdr);
  const link = path.join(f.root, 'linked'); await fs.symlink(original, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(recoverPublishSkyboxReference({ ...f, skybox: { sourcePath: path.join(link, 'sky.hdr'), format: 'hdr' } }), /junction/);
  const first = await recoverPublishSkyboxReference({ ...f, skybox: { sourcePath: path.join(original, 'sky.hdr'), format: 'hdr' } });
  const before = await fs.stat(first.sourcePath);
  const second = await recoverPublishSkyboxReference({ ...f, skybox: first.skybox });
  assert.equal(second.recovered, false); assert.equal((await fs.stat(first.sourcePath)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readdir(path.dirname(first.sourcePath)), ['skybox.hdr']);
});
test('真实外部EXR仅导入临时缓存并验证原字节保持一致', { skip: !process.env.PUBLISH_SKYBOX_REAL_FILE }, async t => {
  const f = await fixture(t); const sourcePath = process.env.PUBLISH_SKYBOX_REAL_FILE!;
  const before = createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex');
  const result = await recoverPublishSkyboxReference({ ...f, skybox: { sourcePath, format: 'exr', intensity: 0.5, resolution: 512 } });
  assert.equal(result.skybox.assetRevision, before);
  assert.equal(createHash('sha256').update(await fs.readFile(result.sourcePath)).digest('hex'), before);
  assert.equal(createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex'), before);
});
