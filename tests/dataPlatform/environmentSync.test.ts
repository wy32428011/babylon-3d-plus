import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{ executeDataPlatformEnvironmentSync, createDataPlatformSourceKey }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/dataPlatformEnvironmentSync'),
]>(['electron/ipc/dataPlatformEnvironmentSync.ts']);

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
    return { bytes: bytes.byteLength, contentType: 'model/gltf-binary', finalUrl: options.remoteUrl, etag: '"fixture"', resumedBytes: 0 };
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
