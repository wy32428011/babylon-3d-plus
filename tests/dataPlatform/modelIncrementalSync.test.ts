import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{ executeDataPlatformModelSync, createDataPlatformModelSourceKey }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/dataPlatformModelIncrementalSync'),
]>(['electron/ipc/dataPlatformModelIncrementalSync.ts']);

const SOURCE_URL = 'https://example.com/platform';
const OTHER_SOURCE_URL = 'https://other.example.com/platform';
const SYNCED_AT = '2026-08-28T08:00:00.000Z';

function createGlb(marker = 0): Buffer {
  const document = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 4 }],
    meshes: [{ primitives: [{}], extras: { marker } }],
  };
  const json = Buffer.from(JSON.stringify(document), 'utf8');
  const jsonChunk = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(jsonChunk);
  const binaryChunk = Buffer.alloc(4, marker);
  const body = Buffer.alloc(8 + jsonChunk.length + 8 + binaryChunk.length);
  body.writeUInt32LE(jsonChunk.length, 0);
  body.writeUInt32LE(0x4e4f534a, 4);
  jsonChunk.copy(body, 8);
  const binaryHeaderOffset = 8 + jsonChunk.length;
  body.writeUInt32LE(binaryChunk.length, binaryHeaderOffset);
  body.writeUInt32LE(0x004e4942, binaryHeaderOffset + 4);
  binaryChunk.copy(body, binaryHeaderOffset + 8);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(header.length + body.length, 8);
  return Buffer.concat([header, body]);
}

type RemoteModel = {
  id: string;
  name: string;
  url: string;
  revision?: string;
  thumbnailUrl?: string;
  thumbnailRevision?: string;
};

function createRequestJson(models: readonly RemoteModel[]) {
  return async (options: { endpointPath: string; body: unknown }) => {
    const pageNum = (options.body as { pageNum?: number }).pageNum ?? 1;
    if (options.endpointPath.includes('combo-models')) {
      return { success: true, data: { records: [], total: 0, pageNum, pageSize: 100 } };
    }
    return {
      success: true,
      data: {
        records: pageNum === 1
          ? models.map((model) => ({
              id: model.id,
              modelName: model.name,
              fileName: `model-${model.id}.glb`,
              fileUrl: model.url,
              ...(model.revision ? { revision: model.revision } : {}),
              ...(model.thumbnailUrl ? { thumbnailUrl: model.thumbnailUrl } : {}),
              ...(model.thumbnailRevision ? { thumbnailRevision: model.thumbnailRevision } : {}),
            }))
          : [],
        total: models.length,
        pageNum,
        pageSize: 100,
      },
    };
  };
}

function createDownload(bytesByUrl: ReadonlyMap<string, Buffer>, calls: string[]) {
  return async (options: import('../../electron/ipc/dataPlatformTransfer').DownloadRemoteFileOptions) => {
    const bytes = bytesByUrl.get(options.remoteUrl);
    if (!bytes) throw new Error(`缺少测试文件：${options.remoteUrl}`);
    calls.push(options.remoteUrl);
    await fs.mkdir(path.dirname(options.destinationPath), { recursive: true });
    await fs.writeFile(options.destinationPath, bytes);
    options.onBytes?.(bytes.byteLength);
    return {
      bytes: bytes.byteLength,
      contentType: 'model/gltf-binary',
      finalUrl: options.remoteUrl,
      etag: '"fixture"',
      resumedBytes: 0,
    };
  };
}

async function withEditorRoot(run: (editorRoot: string) => Promise<void>): Promise<void> {
  const editorRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'model-incremental-sync-'));
  try {
    await run(editorRoot);
  } finally {
    await fs.rm(editorRoot, { recursive: true, force: true });
  }
}

async function readAssetIndex(editorRoot: string) {
  return JSON.parse(await fs.readFile(path.join(editorRoot, '.babylon-editor', 'asset-index.json'), 'utf8')) as {
    assets: Array<{ assetRevision?: string; displayName?: string; path: string }>;
  };
}

async function readProjectAssetIndexForTest(editorRoot: string) {
  try {
    return JSON.parse(await fs.readFile(
      path.join(editorRoot, '.babylon-editor', 'asset-index.json'),
      'utf8',
    )) as import('../../electron/types').ProjectAssetIndex;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { version: 2 as const, assets: [] };
    }
    throw error;
  }
}

test('稳定远端版本第二次同步零下载且不触发场景刷新', async () => {
  await withEditorRoot(async (editorRoot) => {
    const model = { id: '1', name: '水泵', url: '/files/model-1.glb', revision: '1' };
    const bytes = createGlb(1);
    const firstCalls: string[] = [];
    const first = await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'first-versioned-sync',
      dependencies: {
        requestJson: createRequestJson([model]),
        downloadFile: createDownload(new Map([[model.url, bytes]]), firstCalls),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date(SYNCED_AT),
      },
    });
    const firstAssetRevision = (await readAssetIndex(editorRoot)).assets[0]?.assetRevision;
    assert.equal(first.libraryChanged, true);
    assert.deepEqual(first.runtimeChangedResourceKeys, ['model:1']);
    assert.deepEqual(firstCalls, [model.url]);

    const secondCalls: string[] = [];
    const second = await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'second-versioned-sync',
      dependencies: {
        requestJson: createRequestJson([model]),
        downloadFile: createDownload(new Map([[model.url, bytes]]), secondCalls),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date('2026-08-28T08:05:00.000Z'),
      },
    });
    assert.deepEqual(secondCalls, []);
    assert.equal(second.libraryChanged, false);
    assert.deepEqual(second.runtimeChangedResourceKeys, []);
    assert.equal((await readAssetIndex(editorRoot)).assets[0]?.assetRevision, firstAssetRevision);
  });
});

test('分页未取完 total 时拒绝提交，避免把缺失页误判为远端删除', async () => {
  await withEditorRoot(async (editorRoot) => {
    const model = { id: '1', name: '水泵', url: '/files/model-1.glb', revision: '1' };
    await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'pagination-baseline-sync',
      dependencies: {
        requestJson: createRequestJson([model]),
        downloadFile: createDownload(new Map([[model.url, createGlb(1)]]), []),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date(SYNCED_AT),
      },
    });
    const assetIndexPath = path.join(editorRoot, '.babylon-editor', 'asset-index.json');
    const modelIndexPath = path.join(editorRoot, '.babylon-editor', 'data-platform-model-index.json');
    const assetIndexBefore = await fs.readFile(assetIndexPath, 'utf8');
    const modelIndexBefore = await fs.readFile(modelIndexPath, 'utf8');

    await assert.rejects(
      executeDataPlatformModelSync({
        baseUrl: SOURCE_URL,
        editorRoot,
        runId: 'pagination-truncated-sync',
        dependencies: {
          requestJson: async (options: { endpointPath: string; body: unknown }) => {
            const pageNum = (options.body as { pageNum?: number }).pageNum ?? 1;
            if (options.endpointPath.includes('combo-models')) {
              return { success: true, data: { records: [], total: 0, pageNum, pageSize: 100 } };
            }
            return { success: true, data: { records: [], total: 1, pageNum, pageSize: 100 } };
          },
          downloadFile: async () => {
            throw new Error('分页不完整时不得下载。');
          },
          readAssetIndex: readProjectAssetIndexForTest,
          now: () => new Date('2026-08-28T08:05:00.000Z'),
        },
      }),
      /未取完 total=1/,
    );
    assert.equal(await fs.readFile(assetIndexPath, 'utf8'), assetIndexBefore);
    assert.equal(await fs.readFile(modelIndexPath, 'utf8'), modelIndexBefore);
  });
});

test('缩略图独立修订变化会重新校验包，但不标记运行时模型变化', async () => {
  await withEditorRoot(async (editorRoot) => {
    const model = {
      id: '1',
      name: '水泵',
      url: '/files/model-1.glb',
      revision: '1',
      thumbnailUrl: '/files/model-1.png',
      thumbnailRevision: '1',
    };
    const modelBytes = createGlb(1);
    await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'thumbnail-first-sync',
      dependencies: {
        requestJson: createRequestJson([model]),
        downloadFile: createDownload(new Map([
          [model.url, modelBytes],
          [model.thumbnailUrl, Buffer.from('thumbnail-v1')],
        ]), []),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date(SYNCED_AT),
      },
    });

    const calls: string[] = [];
    const changed = { ...model, thumbnailRevision: '2' };
    const result = await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'thumbnail-second-sync',
      dependencies: {
        requestJson: createRequestJson([changed]),
        downloadFile: createDownload(new Map([
          [model.url, modelBytes],
          [model.thumbnailUrl, Buffer.from('thumbnail-v2')],
        ]), calls),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date('2026-08-28T08:05:00.000Z'),
      },
    });

    assert.deepEqual(calls.sort(), [model.thumbnailUrl, model.url].sort());
    assert.equal(result.libraryChanged, true);
    assert.deepEqual(result.runtimeChangedResourceKeys, []);
  });
});

test('远端删除模型时从资产索引移除并报告运行时变化键', async () => {
  await withEditorRoot(async (editorRoot) => {
    const model = { id: '1', name: '水泵', url: '/files/model-1.glb', revision: '1' };
    await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'remove-first-sync',
      dependencies: {
        requestJson: createRequestJson([model]),
        downloadFile: createDownload(new Map([[model.url, createGlb(1)]]), []),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date(SYNCED_AT),
      },
    });
    const result = await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'remove-second-sync',
      dependencies: {
        requestJson: createRequestJson([]),
        downloadFile: async () => { throw new Error('删除同步不得下载。'); },
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date('2026-08-28T08:05:00.000Z'),
      },
    });
    assert.equal(result.libraryChanged, true);
    assert.deepEqual(result.runtimeChangedResourceKeys, ['model:1']);
    assert.deepEqual((await readAssetIndex(editorRoot)).assets, []);
  });
});

test('旧接口再次下载相同内容时保持稳定 revision 且不刷新场景', async () => {
  await withEditorRoot(async (editorRoot) => {
    const model = { id: '1', name: '水泵', url: '/files/model-1.glb' };
    const bytes = createGlb(1);
    const firstCalls: string[] = [];
    await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'first-unversioned-sync',
      dependencies: {
        requestJson: createRequestJson([model]),
        downloadFile: createDownload(new Map([[model.url, bytes]]), firstCalls),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date(SYNCED_AT),
      },
    });
    const firstRevision = (await readAssetIndex(editorRoot)).assets[0]?.assetRevision;

    const secondCalls: string[] = [];
    const second = await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'second-unversioned-sync',
      dependencies: {
        requestJson: createRequestJson([model]),
        downloadFile: createDownload(new Map([[model.url, bytes]]), secondCalls),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date('2026-08-28T08:05:00.000Z'),
      },
    });
    assert.deepEqual(secondCalls, [model.url]);
    assert.equal(second.libraryChanged, false);
    assert.deepEqual(second.runtimeChangedResourceKeys, []);
    assert.equal((await readAssetIndex(editorRoot)).assets[0]?.assetRevision, firstRevision);
  });
});

test('单个模型版本变化时只下载并替换该模型', async () => {
  await withEditorRoot(async (editorRoot) => {
    const firstModel = { id: '1', name: '水泵', url: '/files/model-1.glb', revision: '1' };
    const secondModel = { id: '2', name: '阀门', url: '/files/model-2.glb', revision: '1' };
    const bytes1 = createGlb(1);
    const bytes2 = createGlb(2);
    await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'two-model-first-sync',
      dependencies: {
        requestJson: createRequestJson([firstModel, secondModel]),
        downloadFile: createDownload(new Map([[firstModel.url, bytes1], [secondModel.url, bytes2]]), []),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date(SYNCED_AT),
      },
    });
    const before = await readAssetIndex(editorRoot);
    const secondAssetBefore = before.assets.find((asset) => asset.displayName === '阀门');
    assert.ok(secondAssetBefore);
    const secondMtimeBefore = (await fs.stat(secondAssetBefore.path)).mtimeMs;

    const changedFirst = { ...firstModel, revision: '2' };
    const calls: string[] = [];
    const result = await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'two-model-incremental-sync',
      dependencies: {
        requestJson: createRequestJson([changedFirst, secondModel]),
        downloadFile: createDownload(new Map([[firstModel.url, createGlb(3)], [secondModel.url, bytes2]]), calls),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date('2026-08-28T08:05:00.000Z'),
      },
    });
    assert.deepEqual(calls, [firstModel.url]);
    assert.deepEqual(result.runtimeChangedResourceKeys, ['model:1']);
    const after = await readAssetIndex(editorRoot);
    const secondAssetAfter = after.assets.find((asset) => asset.displayName === '阀门');
    assert.ok(secondAssetAfter);
    assert.equal((await fs.stat(secondAssetAfter.path)).mtimeMs, secondMtimeBefore);
  });
});

test('仅模型名称变化时更新资产库但不重新加载 Babylon 模型', async () => {
  await withEditorRoot(async (editorRoot) => {
    const model = { id: '1', name: '水泵', url: '/files/model-1.glb', revision: '1' };
    const bytes = createGlb(1);
    await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'name-first-sync',
      dependencies: {
        requestJson: createRequestJson([model]),
        downloadFile: createDownload(new Map([[model.url, bytes]]), []),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date(SYNCED_AT),
      },
    });
    const calls: string[] = [];
    const result = await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'name-only-sync',
      dependencies: {
        requestJson: createRequestJson([{ ...model, name: '循环水泵' }]),
        downloadFile: createDownload(new Map([[model.url, bytes]]), calls),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date('2026-08-28T08:05:00.000Z'),
      },
    });
    assert.deepEqual(calls, []);
    assert.equal(result.libraryChanged, true);
    assert.deepEqual(result.runtimeChangedResourceKeys, []);
    assert.equal((await readAssetIndex(editorRoot)).assets[0]?.displayName, '循环水泵');
  });
});

test('切换数据中台来源后不复用相同 ID 和 revision 的旧模型', async () => {
  await withEditorRoot(async (editorRoot) => {
    const model = { id: '1', name: '水泵', url: '/files/model-1.glb', revision: '1' };
    const bytes = createGlb(1);
    await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'source-first-sync',
      dependencies: {
        requestJson: createRequestJson([model]),
        downloadFile: createDownload(new Map([[model.url, bytes]]), []),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date(SYNCED_AT),
      },
    });
    const calls: string[] = [];
    const result = await executeDataPlatformModelSync({
      baseUrl: OTHER_SOURCE_URL,
      editorRoot,
      runId: 'source-switch-sync',
      dependencies: {
        requestJson: createRequestJson([model]),
        downloadFile: createDownload(new Map([[model.url, bytes]]), calls),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date('2026-08-28T08:05:00.000Z'),
      },
    });
    assert.deepEqual(calls, [model.url]);
    assert.equal(result.libraryChanged, true);
    const sidecar = JSON.parse(await fs.readFile(
      path.join(editorRoot, '.babylon-editor', 'data-platform-model-index.json'),
      'utf8',
    )) as { sourceKey: string };
    assert.equal(sidecar.sourceKey, createDataPlatformModelSourceKey(OTHER_SOURCE_URL));
  });
});

test('普通模型推广失败时回滚已替换的模型包并保留旧索引', async () => {
  await withEditorRoot(async (editorRoot) => {
    const model = { id: '1', name: '水泵', url: '/files/model-1.glb', revision: '1' };
    await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'promotion-rollback-first-sync',
      dependencies: {
        requestJson: createRequestJson([model]),
        downloadFile: createDownload(new Map([[model.url, createGlb(1)]]), []),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date(SYNCED_AT),
      },
    });

    const assetIndexPath = path.join(editorRoot, '.babylon-editor', 'asset-index.json');
    const modelIndexPath = path.join(editorRoot, '.babylon-editor', 'data-platform-model-index.json');
    const assetIndexBefore = await fs.readFile(assetIndexPath, 'utf8');
    const modelIndexBefore = await fs.readFile(modelIndexPath, 'utf8');
    const modelPath = (JSON.parse(assetIndexBefore) as {
      assets: Array<{ path: string }>;
    }).assets[0]?.path;
    assert.ok(modelPath);
    const modelBytesBefore = await fs.readFile(modelPath);

    const runId = 'promotion-rollback-failed-sync';
    const backupCollisionPath = path.join(
      editorRoot,
      '.babylon-editor',
      `data-platform-model-sync-${runId}`,
      'rollback',
      '.babylon-editor',
      'asset-index.json',
    );
    const downloadChangedModel = createDownload(new Map([[model.url, createGlb(2)]]), []);
    await assert.rejects(
      executeDataPlatformModelSync({
        baseUrl: SOURCE_URL,
        editorRoot,
        runId,
        dependencies: {
          requestJson: createRequestJson([{ ...model, revision: '2' }]),
          downloadFile: async (options) => {
            const result = await downloadChangedModel(options);
            await fs.mkdir(backupCollisionPath, { recursive: true });
            await fs.writeFile(path.join(backupCollisionPath, 'collision'), 'force promotion failure');
            return result;
          },
          readAssetIndex: readProjectAssetIndexForTest,
          now: () => new Date('2026-08-28T08:05:00.000Z'),
        },
      }),
    );

    assert.deepEqual(await fs.readFile(modelPath), modelBytesBefore);
    assert.equal(await fs.readFile(assetIndexPath, 'utf8'), assetIndexBefore);
    assert.equal(await fs.readFile(modelIndexPath, 'utf8'), modelIndexBefore);
    await assert.rejects(
      fs.access(path.join(editorRoot, '.babylon-editor', `data-platform-model-sync-${runId}`)),
      { code: 'ENOENT' },
    );
  });
});

test('稳定版本模型文件缺失时重新下载并修复本地缓存', async () => {
  await withEditorRoot(async (editorRoot) => {
    const model = { id: '1', name: '水泵', url: '/files/model-1.glb', revision: '1' };
    const bytes = createGlb(1);
    await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'missing-file-first-sync',
      dependencies: {
        requestJson: createRequestJson([model]),
        downloadFile: createDownload(new Map([[model.url, bytes]]), []),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date(SYNCED_AT),
      },
    });

    const modelPath = (await readAssetIndex(editorRoot)).assets[0]?.path;
    assert.ok(modelPath);
    await fs.rm(modelPath);

    const calls: string[] = [];
    const result = await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'missing-file-repair-sync',
      dependencies: {
        requestJson: createRequestJson([model]),
        downloadFile: createDownload(new Map([[model.url, bytes]]), calls),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date('2026-08-28T08:05:00.000Z'),
      },
    });

    assert.deepEqual(calls, [model.url]);
    assert.equal(result.libraryChanged, true);
    assert.deepEqual(result.runtimeChangedResourceKeys, ['model:1']);
    assert.deepEqual(await fs.readFile(modelPath), bytes);
  });
});

test('稳定版本包内元数据、脚本或缩略图缺失时按影响范围修复缓存', async () => {
  await withEditorRoot(async (editorRoot) => {
    const modelUrl = '/files/model-1.glb';
    const metadataUrl = '/files/meta.json';
    const scriptUrl = '/files/runtime.ts';
    const thumbnailUrl = '/files/thumbnail.png';
    const bytesByUrl = new Map<string, Buffer>([
      [modelUrl, createGlb(1)],
      [metadataUrl, Buffer.from(JSON.stringify({ lengthUnit: 'meter' }))],
      [scriptUrl, Buffer.from('export const runtime = true;\n')],
      [thumbnailUrl, Buffer.from('thumbnail')],
    ]);
    const requestJson = async (options: { endpointPath: string; body: unknown }) => {
      const pageNum = (options.body as { pageNum?: number }).pageNum ?? 1;
      if (options.endpointPath.includes('combo-models')) {
        return { success: true, data: { records: [], total: 0, pageNum, pageSize: 100 } };
      }
      return {
        success: true,
        data: {
          records: pageNum === 1 ? [{
            id: '1',
            modelName: '水泵',
            fileName: 'model-1.glb',
            fileUrl: modelUrl,
            revision: '1',
            metaFileUrl: metadataUrl,
            thumbnailUrl,
            scriptFiles: [{ fileName: 'runtime.ts', fileUrl: scriptUrl, sortOrder: 1 }],
          }] : [],
          total: 1,
          pageNum,
          pageSize: 100,
        },
      };
    };
    const expectedDownloads = [...bytesByUrl.keys()].sort();

    await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'package-files-first-sync',
      dependencies: {
        requestJson,
        downloadFile: createDownload(bytesByUrl, []),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date(SYNCED_AT),
      },
    });
    const asset = (await readProjectAssetIndexForTest(editorRoot)).assets[0];
    assert.ok(asset?.metadataPath);
    assert.ok(asset.scriptPaths?.[0]);
    assert.ok(asset.thumbnailPath);

    const repairs = [
      { label: 'metadata', filePath: asset.metadataPath, runtimeChanged: true },
      { label: 'script', filePath: asset.scriptPaths[0], runtimeChanged: true },
      { label: 'thumbnail', filePath: asset.thumbnailPath, runtimeChanged: false },
    ] as const;
    for (const [index, repair] of repairs.entries()) {
      await fs.rm(repair.filePath);
      const calls: string[] = [];
      const result = await executeDataPlatformModelSync({
        baseUrl: SOURCE_URL,
        editorRoot,
        runId: `package-files-repair-${index + 1}`,
        dependencies: {
          requestJson,
          downloadFile: createDownload(bytesByUrl, calls),
          readAssetIndex: readProjectAssetIndexForTest,
          now: () => new Date(`2026-08-28T08:${10 + index}:00.000Z`),
        },
      });

      assert.deepEqual([...calls].sort(), expectedDownloads);
      assert.deepEqual(
        result.runtimeChangedResourceKeys,
        repair.runtimeChanged ? ['model:1'] : [],
      );
      if (repair.label === 'metadata') {
        const repairedMetadata = JSON.parse(await fs.readFile(repair.filePath, 'utf8')) as Record<string, unknown>;
        assert.equal(repairedMetadata.lengthUnit, 'meter');
        assert.equal(repairedMetadata.thumbnail, 'thumbnail.png');
      } else {
        const expectedBytes = bytesByUrl.get(repair.label === 'script' ? scriptUrl : thumbnailUrl);
        assert.ok(expectedBytes);
        assert.deepEqual(await fs.readFile(repair.filePath), expectedBytes);
      }
    }
  });
});

test('增量同步保留多个非数据中台资产且不会把本地路径当作数字 ID 排序', async () => {
  await withEditorRoot(async (editorRoot) => {
    const localPackageA = path.join(editorRoot, 'Assets', 'Models', 'Local-A');
    const localPackageB = path.join(editorRoot, 'Assets', 'Models', 'Local-B');
    const localPathA = path.join(localPackageA, 'local-a.glb');
    const localPathB = path.join(localPackageB, 'local-b.glb');
    await fs.mkdir(path.join(editorRoot, '.babylon-editor'), { recursive: true });
    await fs.mkdir(localPackageA, { recursive: true });
    await fs.mkdir(localPackageB, { recursive: true });
    await fs.writeFile(localPathA, createGlb(10));
    await fs.writeFile(localPathB, createGlb(11));
    await fs.writeFile(
      path.join(editorRoot, '.babylon-editor', 'asset-index.json'),
      `${JSON.stringify({
        version: 2,
        assets: [
          {
            id: localPathB,
            path: localPathB,
            sourceUrl: `editor-asset://local/${encodeURIComponent(localPathB)}`,
            name: 'local-b.glb',
            displayName: '本地 B',
            packagePath: localPackageB,
            kind: 'model',
            libraryKind: 'model',
          },
          {
            id: localPathA,
            path: localPathA,
            sourceUrl: `editor-asset://local/${encodeURIComponent(localPathA)}`,
            name: 'local-a.glb',
            displayName: '本地 A',
            packagePath: localPackageA,
            kind: 'model',
            libraryKind: 'model',
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    );

    const model = { id: '1', name: '水泵', url: '/files/model-1.glb', revision: '1' };
    const result = await executeDataPlatformModelSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      runId: 'preserve-unmanaged-assets-sync',
      dependencies: {
        requestJson: createRequestJson([model]),
        downloadFile: createDownload(new Map([[model.url, createGlb(1)]]), []),
        readAssetIndex: readProjectAssetIndexForTest,
        now: () => new Date(SYNCED_AT),
      },
    });

    assert.equal(result.libraryChanged, true);
    const paths = (await readAssetIndex(editorRoot)).assets.map((asset) => asset.path);
    assert.ok(paths.includes(localPathA));
    assert.ok(paths.includes(localPathB));
    assert.equal(paths.length, 3);
  });
});
