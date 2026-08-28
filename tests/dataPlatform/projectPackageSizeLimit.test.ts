import { ZipArchive } from 'archiver';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  assertDiskWriteCapacity,
  downloadRemoteFile,
  extractZipSecurely,
} from '../../electron/ipc/dataPlatformTransfer.ts';

const LEGACY_ENTRY_LIMIT_BYTES = 100 * 1024 * 1024;
const LARGE_ENTRY_BYTES = LEGACY_ENTRY_LIMIT_BYTES + 1;
const LARGE_ENTRY_PATH = 'Assets/Environments/large-environment/model.glb';

async function createLargeEntryArchive(archivePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(archivePath, { flags: 'wx' });
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const zeroChunk = Buffer.alloc(1024 * 1024);

    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.pipe(output);
    archive.append(Readable.from((function* createChunks() {
      let remaining = LARGE_ENTRY_BYTES;
      while (remaining > 0) {
        const chunkSize = Math.min(remaining, zeroChunk.byteLength);
        yield chunkSize === zeroChunk.byteLength ? zeroChunk : zeroChunk.subarray(0, chunkSize);
        remaining -= chunkSize;
      }
    })()), { name: LARGE_ENTRY_PATH });
    void archive.finalize().catch(reject);
  });
}

test('打开数据中台工程包时允许单个资源文件超过旧版 100 MB 阈值', async () => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), 'data-platform-large-package-'));
  const archivePath = path.join(testRoot, 'project-package.zip');
  const extractedRoot = path.join(testRoot, 'extracted');

  try {
    await createLargeEntryArchive(archivePath);
    await extractZipSecurely(archivePath, extractedRoot, new AbortController().signal);

    const extractedFile = await stat(path.join(extractedRoot, ...LARGE_ENTRY_PATH.split('/')));
    assert.equal(extractedFile.size, LARGE_ENTRY_BYTES);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('工程包下载未提供 maxBytes 时不做字节上限校验', async () => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), 'data-platform-unlimited-download-'));
  const destinationPath = path.join(testRoot, 'project-package.zip');
  const payload = new Uint8Array([1, 2, 3, 4]);

  try {
    const result = await downloadRemoteFile({
      baseUrl: 'https://example.com/platform',
      remoteUrl: '/files/project-package.zip',
      destinationPath,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      context: '下载测试工程包',
      fetchImpl: async () => new Response(payload, {
        status: 200,
      }),
    });

    assert.equal(result.bytes, payload.byteLength);
    assert.deepEqual(await readFile(destinationPath), Buffer.from(payload));
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('显式提供 maxBytes 时仍拒绝超过上限的下载内容', async () => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), 'data-platform-limited-download-'));
  const destinationPath = path.join(testRoot, 'image.bin');
  const payload = new Uint8Array([1, 2, 3, 4]);

  try {
    await assert.rejects(downloadRemoteFile({
      baseUrl: 'https://example.com/platform',
      remoteUrl: '/files/image.bin',
      destinationPath,
      maxBytes: payload.byteLength - 1,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      context: '下载限额测试文件',
      fetchImpl: async () => new Response(payload, {
        status: 200,
        headers: { 'content-length': String(payload.byteLength) },
      }),
    }), /超过允许大小/);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('工程包磁盘容量保护基于目标文件系统的实时可用空间', async () => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), 'data-platform-disk-capacity-'));

  try {
    await assertDiskWriteCapacity(testRoot, 0n, '磁盘容量测试');

    const fileSystem = await statfs(testRoot, { bigint: true });
    const totalFileSystemBytes = fileSystem.blocks * fileSystem.bsize;
    await assert.rejects(
      assertDiskWriteCapacity(testRoot, totalFileSystemBytes, '磁盘容量测试'),
      /所需磁盘空间不足/,
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('工程包场景完成读取和重写后才移动 Assets 目录', async () => {
  const serviceSource = await readFile(
    new URL('../../electron/ipc/dataPlatformProjectService.ts', import.meta.url),
    'utf-8',
  );
  const rewriteIndex = serviceSource.indexOf('rewriteSceneForEditorRoot(sceneSourcePath, options.editorRoot)');
  const moveAssetsIndex = serviceSource.indexOf('await fs.rename(sourceAssetsRoot, stagedAssetsRoot)');

  assert.notEqual(rewriteIndex, -1, '应先生成编辑器场景内容');
  assert.notEqual(moveAssetsIndex, -1, '应通过同盘移动物化 Assets');
  assert.ok(rewriteIndex < moveAssetsIndex, '场景读取不得发生在 Assets 被移走之后');
});

test('工程包容量错误不会被误判为不兼容包并降级为空项目', async () => {
  const serviceSource = await readFile(
    new URL('../../electron/ipc/dataPlatformProjectService.ts', import.meta.url),
    'utf-8',
  );
  const capacityRethrows = serviceSource.match(
    /catch \(error\) \{\s*if \(error instanceof ProjectPackageCapacityError\) throw error;/g,
  ) ?? [];

  assert.ok(capacityRethrows.length >= 2, '场景与 manifest 的容量错误都应继续向上抛出');
});

test('工程包解压磁盘预算包含文件系统条目开销', async () => {
  const transferSource = await readFile(
    new URL('../../electron/ipc/dataPlatformTransfer.ts', import.meta.url),
    'utf-8',
  );

  assert.match(transferSource, /FILE_SYSTEM_ENTRY_OVERHEAD_BYTES = 16n \* 1024n/);
  assert.match(
    transferSource,
    /declaredTotal\s*\+\s*BigInt\(normalizedEntries\.length\) \* FILE_SYSTEM_ENTRY_OVERHEAD_BYTES/,
  );
});

test('工程包场景与资产索引写入前按实际 UTF-8 字节检查磁盘容量', async () => {
  const serviceSource = await readFile(
    new URL('../../electron/ipc/dataPlatformProjectService.ts', import.meta.url),
    'utf-8',
  );

  assert.match(
    serviceSource,
    /const rewrittenSceneContent = await rewriteSceneForEditorRoot[\s\S]*?assertDiskWriteCapacity\([\s\S]*?Buffer\.byteLength\(rewrittenSceneContent, 'utf8'\)[\s\S]*?fs\.writeFile\(stagedScenePath, rewrittenSceneContent, 'utf-8'\)/,
  );
  assert.match(
    serviceSource,
    /const indexContent = [\s\S]*?assertDiskWriteCapacity\([\s\S]*?Buffer\.byteLength\(indexContent, 'utf8'\)[\s\S]*?fs\.writeFile\(stagedIndexPath, indexContent, 'utf-8'\)/,
  );
});

test('模型包元数据与脚本扫描前执行动态堆容量保护', async () => {
  const serviceSource = await readFile(
    new URL('../../electron/ipc/dataPlatformProjectService.ts', import.meta.url),
    'utf-8',
  );

  assert.match(
    serviceSource,
    /await assertModelPackageScanCapacity\(candidate\.packagePath\);\s*const result = await scanModelPackage\(candidate\.packagePath\);/,
  );
  assert.match(
    serviceSource,
    /catch \(error\) \{\s*if \(error instanceof ProjectPackageCapacityError\) throw error;\s*skipped\.push/,
  );
});
