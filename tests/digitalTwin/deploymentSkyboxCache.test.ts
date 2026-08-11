import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  createDeploymentSkyboxValidationCache,
  loadDeploymentSkyboxCacheContext,
  resolveDeploymentSkyboxReference,
} from '../../electron/ipc/deploymentSkyboxCache.ts';

const RESOURCE_ID = '2054201280000000401';
const FILE_SHA256 = 'a'.repeat(64);
const ENTRY = {
  resourceId: RESOURCE_ID,
  displayName: '晨曦天空',
  relativePath: `Assets/Skyboxes/DataPlatform/Skybox-${RESOURCE_ID}/skybox.hdr`,
  format: 'hdr' as const,
  fileSizeBytes: 128,
  sha256: FILE_SHA256,
  revision: '1',
  status: 'active' as const,
  syncedAt: '2026-08-10T08:00:00.000Z',
};

function createFsError(code: string, leakedPath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation failed, open '${leakedPath}'`), { code });
}

for (const code of ['EACCES', 'EPERM', 'EIO', 'EMFILE']) {
  test(`共享天空盒根 ${code} 错误脱敏`, async () => {
    const leakedRoot = path.resolve('C:/private/cache-root');
    await assert.rejects(
      loadDeploymentSkyboxCacheContext(new AbortController().signal, {
        getSharedProjectSkyboxRoot: () => leakedRoot,
        assertSafeDirectory: async () => { throw createFsError(code, leakedRoot); },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /数据中台天空盒缓存根目录不可访问/);
        assert.equal(error.message.includes(leakedRoot), false);
        return true;
      },
    );
  });

  test(`共享天空盒索引 ${code} 错误脱敏`, async () => {
    const leakedRoot = path.resolve('C:/private/cache-root');
    const leakedIndex = path.join(leakedRoot, '.babylon-editor', 'data-platform-skybox-index.json');
    await assert.rejects(
      loadDeploymentSkyboxCacheContext(new AbortController().signal, {
        getSharedProjectSkyboxRoot: () => leakedRoot,
        assertSafeDirectory: async () => leakedRoot,
        readDataPlatformSkyboxIndex: async () => { throw createFsError(code, leakedIndex); },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /数据中台天空盒索引不可访问/);
        assert.equal(error.message.includes(leakedRoot), false);
        assert.equal(error.message.includes(leakedIndex), false);
        return true;
      },
    );
  });
}

test('天空盒索引业务格式错误保留安全上下文', async () => {
  const leakedRoot = path.resolve('C:/private/cache-root');
  await assert.rejects(
    loadDeploymentSkyboxCacheContext(new AbortController().signal, {
      getSharedProjectSkyboxRoot: () => leakedRoot,
      assertSafeDirectory: async () => leakedRoot,
      readDataPlatformSkyboxIndex: async () => { throw new Error('天空盒索引 JSON 已损坏：Unexpected token'); },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /天空盒索引 JSON 已损坏：Unexpected token/);
      assert.equal(error.message.includes(leakedRoot), false);
      return true;
    },
  );
});

test('单次导出相同 resourceId 复用完整校验 Promise', async () => {
  const cacheRoot = path.resolve('C:/safe/skybox-cache');
  const sourcePath = path.resolve(cacheRoot, ...ENTRY.relativePath.split('/'));
  const packageRoot = path.dirname(sourcePath);
  let validateCount = 0;
  let sha256Count = 0;
  let lstatCount = 0;
  const context = {
    dataPlatformSkyboxRoot: cacheRoot,
    dataPlatformSkyboxesById: new Map([[RESOURCE_ID, ENTRY]]),
  };
  const validationCache = createDeploymentSkyboxValidationCache();
  const dependencies = {
    resolveSkyboxIndexEntryPath: () => sourcePath,
    assertSafeDirectory: async () => packageRoot,
    validateSkyboxSourceFile: async () => {
      validateCount += 1;
      return { format: 'hdr' as const, fileSizeBytes: ENTRY.fileSizeBytes };
    },
    sha256File: async () => {
      sha256Count += 1;
      return ENTRY.sha256;
    },
    realpath: async () => sourcePath,
    lstat: async () => {
      lstatCount += 1;
      return {
        isSymbolicLink: () => false,
        isFile: () => true,
        size: ENTRY.fileSizeBytes,
        mtimeMs: 1234,
      };
    },
  };

  const [first, second] = await Promise.all([
    resolveDeploymentSkyboxReference(
      { format: 'hdr', dataPlatformResourceId: RESOURCE_ID },
      context,
      validationCache,
      new AbortController().signal,
      dependencies,
    ),
    resolveDeploymentSkyboxReference(
      { format: 'hdr', dataPlatformResourceId: RESOURCE_ID },
      context,
      validationCache,
      new AbortController().signal,
      dependencies,
    ),
  ]);

  assert.equal(first?.sourcePath, sourcePath);
  assert.equal(second?.sourcePath, sourcePath);
  assert.equal(validateCount, 1);
  assert.equal(sha256Count, 1);
  assert.equal(lstatCount, 2, '完整校验只允许一组前后文件快照。');
  assert.equal(validationCache.size, 1);
});
