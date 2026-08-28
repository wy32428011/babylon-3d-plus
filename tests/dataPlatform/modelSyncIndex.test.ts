import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildDataPlatformModelPlan,
  createDataPlatformModelRuntimeRevision,
  DATA_PLATFORM_MODEL_INDEX_VERSION,
  getDataPlatformModelIndexPath,
  readDataPlatformModelIndex,
  writeDataPlatformModelIndexFile,
  type DataPlatformModelIndex,
  type DataPlatformModelIndexEntry,
  type DataPlatformModelSyncDescriptor,
} from '../../electron/ipc/dataPlatformModelIndex.ts';

const SYNCED_AT = '2026-08-28T08:00:00.000Z';
const MODEL_FINGERPRINT = 'a'.repeat(64);
const THUMBNAIL_FINGERPRINT = 'b'.repeat(64);
const RUNTIME_REVISION = 'c'.repeat(64);
const FILE_REVISION = 'd'.repeat(64);
const METADATA_REVISION = 'e'.repeat(64);
const SCRIPT_REVISION = 'f'.repeat(64);
const SOURCE_KEY = '1'.repeat(64);
const OTHER_SOURCE_KEY = '2'.repeat(64);

function createDescriptor(
  overrides: Partial<DataPlatformModelSyncDescriptor> = {},
): DataPlatformModelSyncDescriptor {
  return {
    kind: 'model',
    resourceId: '1',
    displayName: '水泵',
    packageRelativePath: 'Assets/Models/Model-1-水泵',
    contentFingerprint: MODEL_FINGERPRINT,
    thumbnailFingerprint: THUMBNAIL_FINGERPRINT,
    ...overrides,
  };
}

function createEntry(
  overrides: Partial<DataPlatformModelIndexEntry> = {},
): DataPlatformModelIndexEntry {
  return {
    ...createDescriptor(),
    runtimeRevision: RUNTIME_REVISION,
    fileRevision: FILE_REVISION,
    metadataRevision: METADATA_REVISION,
    scriptRevision: SCRIPT_REVISION,
    thumbnailRevision: THUMBNAIL_FINGERPRINT,
    syncedAt: SYNCED_AT,
    ...overrides,
  };
}

function createIndex(entries: DataPlatformModelIndexEntry[] = []): DataPlatformModelIndex {
  return { version: DATA_PLATFORM_MODEL_INDEX_VERSION, sourceKey: SOURCE_KEY, entries };
}

test('相同内容指纹且包和资产仍存在时不重复下载或触发运行时刷新', () => {
  const descriptor = createDescriptor();
  const entry = createEntry();
  const plan = buildDataPlatformModelPlan({
    sourceKey: SOURCE_KEY,
    remote: [descriptor],
    current: createIndex([entry]),
    existingPackagePaths: new Set([entry.packageRelativePath]),
    existingAssetKeys: new Set(['model:1']),
    syncedAt: SYNCED_AT,
  });

  assert.deepEqual(plan.downloads, []);
  assert.deepEqual(plan.runtimeChangedResourceKeys, []);
  assert.deepEqual(plan.metadataChangedResourceKeys, []);
  assert.deepEqual(plan.removed, []);
  assert.equal(plan.reused.length, 1);
});

test('仅展示名称变化时复用模型包，不触发 Babylon 模型重载', () => {
  const entry = createEntry();
  const plan = buildDataPlatformModelPlan({
    sourceKey: SOURCE_KEY,
    remote: [createDescriptor({ displayName: '循环水泵' })],
    current: createIndex([entry]),
    existingPackagePaths: new Set([entry.packageRelativePath]),
    existingAssetKeys: new Set(['model:1']),
    syncedAt: SYNCED_AT,
  });

  assert.deepEqual(plan.downloads, []);
  assert.deepEqual(plan.runtimeChangedResourceKeys, []);
  assert.deepEqual(plan.metadataChangedResourceKeys, ['model:1']);
  assert.equal(plan.reused[0]?.nextEntry.displayName, '循环水泵');
  assert.equal(plan.reused[0]?.nextEntry.runtimeRevision, RUNTIME_REVISION);
});

test('内容指纹变化、文件缺失或本地资产缺失时只下载受影响模型', () => {
  const modelEntry = createEntry();
  const comboEntry = createEntry({
    kind: 'combo',
    resourceId: '2',
    displayName: '泵组',
    packageRelativePath: 'Assets/Models/ComboModels/Combo-2-泵组',
  });
  const unchangedCombo = createDescriptor({
    kind: 'combo',
    resourceId: '2',
    displayName: '泵组',
    packageRelativePath: comboEntry.packageRelativePath,
  });

  const plan = buildDataPlatformModelPlan({
    sourceKey: SOURCE_KEY,
    remote: [
      createDescriptor({ contentFingerprint: '1'.repeat(64) }),
      unchangedCombo,
    ],
    current: createIndex([modelEntry, comboEntry]),
    existingPackagePaths: new Set([modelEntry.packageRelativePath, comboEntry.packageRelativePath]),
    existingAssetKeys: new Set(['model:1']),
    syncedAt: SYNCED_AT,
  });

  assert.deepEqual(plan.downloads.map((item) => `${item.kind}:${item.resourceId}`), ['combo:2', 'model:1']);
  assert.deepEqual(plan.runtimeChangedResourceKeys, ['combo:2', 'model:1']);
  assert.deepEqual(plan.reused, []);
});

test('远端删除项从下一索引移除，并标记为运行时变化', () => {
  const removedEntry = createEntry({
    kind: 'combo',
    resourceId: '2',
    packageRelativePath: 'Assets/Models/ComboModels/Combo-2-泵组',
  });
  const plan = buildDataPlatformModelPlan({
    sourceKey: SOURCE_KEY,
    remote: [],
    current: createIndex([removedEntry]),
    existingPackagePaths: new Set([removedEntry.packageRelativePath]),
    existingAssetKeys: new Set(['combo:2']),
    syncedAt: SYNCED_AT,
  });

  assert.deepEqual(plan.removed, [removedEntry]);
  assert.deepEqual(plan.runtimeChangedResourceKeys, ['combo:2']);
  assert.deepEqual(plan.nextEntries, []);
});

test('旧接口缺少稳定版本指纹时必须下载，但下载后可继续比较稳定内容 revision', () => {
  const entry = createEntry({ contentFingerprint: null });
  const plan = buildDataPlatformModelPlan({
    sourceKey: SOURCE_KEY,
    remote: [createDescriptor({ contentFingerprint: null })],
    current: createIndex([entry]),
    existingPackagePaths: new Set([entry.packageRelativePath]),
    existingAssetKeys: new Set(['model:1']),
    syncedAt: SYNCED_AT,
  });

  assert.deepEqual(plan.downloads.map((item) => item.resourceId), ['1']);
  assert.deepEqual(plan.reused, []);
});

test('切换数据中台来源后不复用相同业务 ID 的旧缓存', () => {
  const entry = createEntry();
  const plan = buildDataPlatformModelPlan({
    sourceKey: OTHER_SOURCE_KEY,
    remote: [createDescriptor()],
    current: createIndex([entry]),
    existingPackagePaths: new Set([entry.packageRelativePath]),
    existingAssetKeys: new Set(['model:1']),
    syncedAt: SYNCED_AT,
  });

  assert.deepEqual(plan.downloads.map((item) => item.resourceId), ['1']);
  assert.deepEqual(plan.reused, []);
});

test('运行时 revision 由模型、去除 thumbnail 的 meta 与有序脚本内容稳定生成', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-runtime-revision-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const modelPath = path.join(root, 'model.glb');
  const metadataPath = path.join(root, 'meta.json');
  const scriptPath = path.join(root, 'main.ts');
  await fs.writeFile(modelPath, Buffer.from('MODEL-CONTENT'));
  await fs.writeFile(metadataPath, JSON.stringify({ thumbnail: 'old.png', lengthUnit: 'meter', nested: { b: 2, a: 1 } }));
  await fs.writeFile(scriptPath, 'export const value = 1;');

  const first = await createDataPlatformModelRuntimeRevision({ modelPath, metadataPath, scriptPaths: [scriptPath] });
  await fs.writeFile(metadataPath, JSON.stringify({ nested: { a: 1, b: 2 }, lengthUnit: 'meter', thumbnail: 'new.png' }));
  const thumbnailOnly = await createDataPlatformModelRuntimeRevision({ modelPath, metadataPath, scriptPaths: [scriptPath] });
  assert.deepEqual(thumbnailOnly, first);

  await fs.writeFile(scriptPath, 'export const value = 2;');
  const scriptChanged = await createDataPlatformModelRuntimeRevision({ modelPath, metadataPath, scriptPaths: [scriptPath] });
  assert.notEqual(scriptChanged.scriptRevision, first.scriptRevision);
  assert.notEqual(scriptChanged.runtimeRevision, first.runtimeRevision);
  assert.equal(scriptChanged.fileRevision, first.fileRevision);
  assert.equal(scriptChanged.thumbnailRevision, first.thumbnailRevision);
});

test('模型同步索引可往返读取，损坏或越界路径会明确失败', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-sync-index-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const indexPath = getDataPlatformModelIndexPath(root);
  await writeDataPlatformModelIndexFile(indexPath, createIndex([createEntry()]));
  assert.deepEqual(await readDataPlatformModelIndex(root), createIndex([createEntry()]));

  await fs.writeFile(indexPath, JSON.stringify(createIndex([createEntry({ packageRelativePath: '../outside' })])));
  await assert.rejects(readDataPlatformModelIndex(root), /packageRelativePath/);
});
