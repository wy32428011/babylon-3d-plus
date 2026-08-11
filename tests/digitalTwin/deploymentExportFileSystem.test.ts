import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyDeploymentFiles } from '../../electron/ipc/deploymentExportFileSystem.ts';

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

test('最终复制必须把 expectedSize/expectedSha256 绑定到实际输出并删除错误文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-deployment-copy-integrity-'));
  const sourcePath = path.join(root, 'source', 'skybox.hdr');
  const stagingRoot = path.join(root, 'staging');
  const expectedData = Buffer.from('expected-skybox-content');
  const replacementData = Buffer.from('tampered-skybox-content');
  assert.equal(replacementData.length, expectedData.length);
  try {
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await mkdir(stagingRoot, { recursive: true });
    await writeFile(sourcePath, replacementData);
    const snapshot = await stat(sourcePath);
    const destinationRelativePath = 'project/assets/skyboxes/Skybox-1/skybox.hdr';

    await assert.rejects(
      copyDeploymentFiles([{
        sourcePath,
        relativePath: 'skybox.hdr',
        size: snapshot.size,
        mtimeMs: snapshot.mtimeMs,
        destinationRelativePath,
        kind: 'texture',
        expectedSize: expectedData.length,
        expectedSha256: sha256(expectedData),
        integrityLabel: '数据中台天空盒“测试”（ID 1）兼容缓存',
      }], stagingRoot, 1, new AbortController().signal, () => undefined),
      /最终复制.*SHA-256|SHA-256.*最终复制/,
    );

    await assert.rejects(
      stat(path.join(stagingRoot, ...destinationRelativePath.split('/'))),
      (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
