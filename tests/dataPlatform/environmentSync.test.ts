import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{ executeDataPlatformEnvironmentSync, createDataPlatformSourceKey, getLatestDataPlatformEnvironmentSyncProgress }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/dataPlatformEnvironmentSync'),
]>(['electron/ipc/dataPlatformEnvironmentSync.ts'], { deferCleanup: (cleanup) => after(cleanup) });
const [{ listIndexedDataPlatformEnvironments }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/dataPlatformEnvironmentIndex'),
]>(['electron/ipc/dataPlatformEnvironmentIndex.ts'], { deferCleanup: (cleanup) => after(cleanup) });

const SOURCE_URL = 'https://example.com/platform';
const SOURCE_KEY = createDataPlatformSourceKey(SOURCE_URL);
const SYNCED_AT = '2026-08-12T07:30:00.000Z';

function createGlb(): Buffer {
  const document = { asset: { version: '2.0' }, buffers: [{ byteLength: 4 }], meshes: [{ primitives: [{}] }] };
  const json = Buffer.from(JSON.stringify(document), 'utf8');
  const jsonChunk = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(jsonChunk);
  const binaryChunk = Buffer.alloc(4);
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

function readyRecord(id: string, bytes: Buffer, revision = '1') {
  return {
    id,
    modelName: `环境-${id}`,
    fileStatus: 'GLB_READY',
    fileName: `environment-${id}.glb`,
    fileSizeBytes: String(bytes.byteLength),
    fileSha256: createHash('sha256').update(bytes).digest('hex'),
    lengthUnit: 'meter',
    fileRevision: revision,
    runtimeRevision: revision,
    downloadUrl: `/api/v1/env-models/${id}/file?fileRevision=${revision}`,
    updatedAt: SYNCED_AT,
  };
}

function manifest(records: unknown[], revision = '1') {
  return { success: true, data: { protocolVersion: '1', manifestRevision: revision, records, nextCursorId: null, hasMore: false } };
}

async function withEditorRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'environment-sync-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function createDownload(bytesByUrl: ReadonlyMap<string, Buffer>, failures = new Set<string>()) {
  return async (options: import('../../electron/ipc/dataPlatformTransfer').DownloadRemoteFileOptions) => {
    if (failures.has(options.remoteUrl)) throw new Error('模拟下载失败');
    const bytes = bytesByUrl.get(options.remoteUrl);
    if (!bytes) throw new Error(`缺少测试文件：${options.remoteUrl}`);
    await mkdir(path.dirname(options.destinationPath), { recursive: true });
    await writeFile(options.destinationPath, bytes);
    options.onBytes?.(bytes.byteLength);
    const contentType = options.remoteUrl.endsWith('.png') ? 'image/png' : 'model/gltf-binary';
    return { bytes: bytes.byteLength, contentType, finalUrl: options.remoteUrl, etag: '"fixture"', resumedBytes: 0 };
  };
}

test('同步清单修订变化时只重启一次并提交稳定快照', async () => {
  await withEditorRoot(async (editorRoot) => {
    const bytes = createGlb();
    const record = readyRecord('1', bytes);
    let call = 0;
    const revisions: Array<string | null> = [];
    await executeDataPlatformEnvironmentSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      contextKey: 'workspace:test',
      runId: 'revision-retry',
      dependencies: {
        requestJson: async (options) => {
          if (options.endpointPath === 'api/v1/env-models/query') {
            return { success: true, data: { records: [record], total: 1, pageNum: 1, pageSize: 100 } };
          }
          revisions.push((options.body as { manifestRevision: string | null }).manifestRevision);
          call += 1;
          if (call === 1) return { success: true, data: { protocolVersion: '1', manifestRevision: '1', records: [], nextCursorId: '1', hasMore: true } };
          if (call === 2) return { success: true, data: { protocolVersion: '1', manifestRevision: '2', records: [], nextCursorId: null, hasMore: false } };
          return manifest([record], '2');
        },
        downloadFile: createDownload(new Map([[record.downloadUrl, bytes]])),
        now: () => new Date(SYNCED_AT),
      },
    });
    assert.deepEqual(revisions, [null, '1', '2']);
    const index = JSON.parse(await readFile(path.join(editorRoot, '.babylon-editor', 'data-platform-environment-index.json'), 'utf8'));
    assert.equal(index.manifestRevision, '2');
    assert.equal(index.entries[0].status, 'active');
  });
});

test('全库同步补齐缩略图，换封面失败后保留旧图且再次同步仅下载图片', async () => {
  await withEditorRoot(async (editorRoot) => {
    const bytes = createGlb();
    const record = readyRecord('1', bytes);
    let thumbnailUrl: string | null = '/thumbnail.png';
    let servesLoginPage = false;
    const downloads: string[] = [];
    let directoryRequests = 0;
    const oldThumbnail = Buffer.from('first thumbnail');
    const newThumbnail = Buffer.from('second thumbnail');
    const download = createDownload(new Map([
      [record.downloadUrl, bytes], ['/thumbnail.png', oldThumbnail], ['/new-thumbnail.png', newThumbnail],
    ]));
    const sync = () => executeDataPlatformEnvironmentSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      contextKey: 'workspace:thumbnails',
      dependencies: {
        requestJson: async (options) => {
          if (options.endpointPath === 'api/v1/env-models/sync-manifest/query') return manifest([record]);
          assert.equal(options.endpointPath, 'api/v1/env-models/query');
          directoryRequests += 1;
          return { success: true, data: { records: [{ ...record, thumbnailUrl }], total: 1, pageNum: 1, pageSize: 100 } };
        },
        downloadFile: async (options) => {
          downloads.push(options.remoteUrl);
          const result = await download(options);
          return servesLoginPage && options.remoteUrl === thumbnailUrl
            ? { ...result, contentType: 'text/html' }
            : result;
        },
      },
    });
    const loadAsset = async () => (await listIndexedDataPlatformEnvironments(editorRoot)).assets[0];

    await sync();
    const first = await loadAsset();
    assert.deepEqual(await readFile(first.thumbnailPath!), oldThumbnail);
    await sync();
    assert.equal(directoryRequests, 1, '时间和本地图片均一致时跳过目录及下载');
    assert.deepEqual(downloads, [record.downloadUrl, '/thumbnail.png']);

    record.updatedAt = '2026-08-12T08:00:00.000Z';
    thumbnailUrl = '/new-thumbnail.png';
    servesLoginPage = true;
    await sync();
    assert.match(getLatestDataPlatformEnvironmentSyncProgress()?.message ?? '', /1 个缩略图未更新/);
    assert.equal((await loadAsset()).thumbnailPath, first.thumbnailPath);
    servesLoginPage = false;
    await sync();
    const second = await loadAsset();
    assert.deepEqual(await readFile(second.thumbnailPath!), newThumbnail);
    assert.notEqual(second.thumbnailUrl, first.thumbnailUrl);
    assert.equal(second.assetRevision, first.assetRevision);
    assert.equal(second.path, first.path);
    assert.deepEqual(downloads.slice(2), [thumbnailUrl, thumbnailUrl]);

    record.updatedAt = '2026-08-12T09:00:00.000Z';
    thumbnailUrl = null;
    await sync();
    assert.equal((await loadAsset()).thumbnailPath, undefined);
    assert.equal(downloads.length, 4, '中台移除封面时不重新下载 GLB');
  });
});

test('单项下载失败时保留已有缓存为 stale，无旧缓存项不暴露', async () => {
  await withEditorRoot(async (editorRoot) => {
    const oldBytes = createGlb();
    const oldSha = createHash('sha256').update(oldBytes).digest('hex');
    const oldRelativePath = `.babylon-editor/data-platform-cache/environments/${SOURCE_KEY}/1/1/model.glb`;
    const oldFilePath = path.join(editorRoot, ...oldRelativePath.split('/'));
    await mkdir(path.dirname(oldFilePath), { recursive: true });
    await writeFile(oldFilePath, oldBytes);
    await mkdir(path.join(editorRoot, '.babylon-editor'), { recursive: true });
    await writeFile(path.join(editorRoot, '.babylon-editor', 'data-platform-environment-index.json'), `${JSON.stringify({
      version: 1,
      protocolVersion: '1',
      sourceKey: SOURCE_KEY,
      manifestRevision: '1',
      entries: [{
        sourceKey: SOURCE_KEY, resourceId: '1', displayName: '旧环境', relativePath: oldRelativePath,
        fileName: 'old.glb', fileSizeBytes: oldBytes.byteLength, fileSha256: oldSha, fileRevision: '1', runtimeRevision: '1',
        lengthUnit: 'meter', status: 'active', syncedAt: SYNCED_AT, lastUsedAt: SYNCED_AT, warning: null,
      }],
    }, null, 2)}
`, 'utf8');
    const nextBytes = createGlb();
    const records = [readyRecord('1', nextBytes, '2'), readyRecord('2', nextBytes, '1')];
    const failures = new Set(records.map((record) => record.downloadUrl));
    await executeDataPlatformEnvironmentSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      contextKey: 'workspace:test',
      runId: 'partial-failure',
      dependencies: {
        requestJson: async () => manifest(records, '2'),
        downloadFile: createDownload(new Map(), failures),
        now: () => new Date(SYNCED_AT),
      },
    });
    const index = JSON.parse(await readFile(path.join(editorRoot, '.babylon-editor', 'data-platform-environment-index.json'), 'utf8'));
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0].resourceId, '1');
    assert.equal(index.entries[0].status, 'stale');
    assert.match(index.entries[0].warning, /模拟下载失败/);
    assert.deepEqual(await readFile(oldFilePath), oldBytes);
  });
});

test('推广失败会回滚原缓存和 Sidecar 索引', async () => {
  await withEditorRoot(async (editorRoot) => {
    const bytes = createGlb();
    const record = readyRecord('1', bytes);
    const indexPath = path.join(editorRoot, '.babylon-editor', 'data-platform-environment-index.json');
    await mkdir(indexPath, { recursive: true });
    await assert.rejects(executeDataPlatformEnvironmentSync({
      baseUrl: SOURCE_URL,
      editorRoot,
      contextKey: 'workspace:test',
      runId: 'promotion-rollback',
      dependencies: {
        requestJson: async () => manifest([record]),
        downloadFile: createDownload(new Map([[record.downloadUrl, bytes]])),
        now: () => new Date(SYNCED_AT),
      },
    }));
    const promotedPath = path.join(editorRoot, '.babylon-editor', 'data-platform-cache', 'environments', SOURCE_KEY, '1', '1', 'model.glb');
    await assert.rejects(readFile(promotedPath));
    const indexStat = await (await import('node:fs/promises')).stat(indexPath);
    assert.equal(indexStat.isDirectory(), true);
  });
});
