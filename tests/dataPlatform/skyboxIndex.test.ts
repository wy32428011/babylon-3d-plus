import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DATA_PLATFORM_SKYBOX_INDEX_VERSION,
  MAX_SKYBOX_SYNC_DOWNLOAD_BYTES,
  buildDataPlatformSkyboxPlan,
  getDataPlatformSkyboxIndexPath,
  getDataPlatformSkyboxRelativePath,
  readDataPlatformSkyboxIndex,
  resolveSkyboxIndexEntryPath,
  writeDataPlatformSkyboxIndexFile,
  type DataPlatformSkyboxDownloadPlan,
  type DataPlatformSkyboxIndex,
  type DataPlatformSkyboxIndexEntry,
  type DataPlatformSkyboxPlan,
} from '../../electron/ipc/dataPlatformSkyboxIndex.ts';
import {
  MAX_SKYBOX_FILE_BYTES,
  type DataPlatformSkyboxRecord,
} from '../../electron/ipc/dataPlatformSkyboxContract.ts';

const SYNCED_AT = '2026-08-11T12:34:56.789Z';
const NEXT_SYNCED_AT = '2026-08-11T13:34:56Z';

function shaForId(id: string): string {
  return BigInt(id).toString(16).padStart(64, '0');
}

function createRecord(
  id = '1',
  overrides: Partial<DataPlatformSkyboxRecord> = {},
): DataPlatformSkyboxRecord {
  const format = overrides.format ?? 'hdr';
  return {
    id,
    displayName: `天空盒 ${id}`,
    fileName: `skybox-${id}.${format}`,
    fileUrl: `https://cdn.example.com/skyboxes/${id}.${format}`,
    format,
    fileSizeBytes: 1024,
    sha256: shaForId(id),
    revision: id,
    updatedAt: '2026-08-11T10:20:30Z',
    ...overrides,
  };
}

function createEntry(
  record: DataPlatformSkyboxRecord = createRecord(),
  overrides: Partial<DataPlatformSkyboxIndexEntry> = {},
): DataPlatformSkyboxIndexEntry {
  return {
    resourceId: record.id,
    displayName: record.displayName,
    relativePath: getDataPlatformSkyboxRelativePath(record.id, record.format),
    format: record.format,
    fileSizeBytes: record.fileSizeBytes,
    sha256: record.sha256,
    revision: record.revision,
    status: 'active',
    syncedAt: SYNCED_AT,
    ...overrides,
  };
}

function createIndex(entries: DataPlatformSkyboxIndexEntry[] = []): DataPlatformSkyboxIndex {
  return { version: 1, entries };
}

function assertPlanType(plan: DataPlatformSkyboxPlan): DataPlatformSkyboxPlan {
  return plan;
}

function assertDownloadType(download: DataPlatformSkyboxDownloadPlan): DataPlatformSkyboxDownloadPlan {
  return download;
}

async function createEditorRoot(t: test.TestContext): Promise<string> {
  const editorRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skybox-index-'));
  t.after(async () => {
    await fs.rm(editorRoot, { recursive: true, force: true });
  });
  return editorRoot;
}

async function writeRawIndex(editorRoot: string, value: unknown): Promise<void> {
  const indexPath = getDataPlatformSkyboxIndexPath(editorRoot);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const content = typeof value === 'string' ? value : JSON.stringify(value);
  await fs.writeFile(indexPath, content, 'utf8');
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

test('索引版本和同步下载总量上限固定', () => {
  assert.equal(DATA_PLATFORM_SKYBOX_INDEX_VERSION, 1);
  assert.equal(MAX_SKYBOX_SYNC_DOWNLOAD_BYTES, 8 * 1024 ** 3);
});

test('索引路径固定在 .babylon-editor/data-platform-skybox-index.json', () => {
  const editorRoot = path.join(os.tmpdir(), 'editor-root');
  assert.equal(
    getDataPlatformSkyboxIndexPath(editorRoot),
    path.join(editorRoot, '.babylon-editor', 'data-platform-skybox-index.json'),
  );
});

test('资源相对路径固定为 POSIX 结构并支持 HDR/EXR', () => {
  assert.equal(
    getDataPlatformSkyboxRelativePath('1', 'hdr'),
    'Assets/Skyboxes/DataPlatform/Skybox-1/skybox.hdr',
  );
  assert.equal(
    getDataPlatformSkyboxRelativePath('2052912068767571969', 'exr'),
    'Assets/Skyboxes/DataPlatform/Skybox-2052912068767571969/skybox.exr',
  );
});

test('资源相对路径只接受规范正 ID 和小写 HDR/EXR 格式', () => {
  for (const id of ['0', '00', '01', '-1', '+1', '1.0', '1e2', ' 1', '1 ', '', '9'.repeat(65)]) {
    assert.throws(
      () => getDataPlatformSkyboxRelativePath(id, 'hdr'),
      /ID|标识符|resource/i,
    );
  }

  for (const format of ['HDR', 'EXR', 'png', '', ' hdr'] as const) {
    assert.throws(
      () => getDataPlatformSkyboxRelativePath('1', format as 'hdr'),
      /format|格式/i,
    );
  }
});

test('索引条目路径解析为 editorRoot 内的稳定目标', async (t) => {
  const editorRoot = await createEditorRoot(t);
  const relativePath = 'Assets/Skyboxes/DataPlatform/Skybox-10/skybox.exr';

  assert.equal(
    resolveSkyboxIndexEntryPath(editorRoot, relativePath),
    path.resolve(editorRoot, 'Assets', 'Skyboxes', 'DataPlatform', 'Skybox-10', 'skybox.exr'),
  );
});

test('索引条目路径拒绝 traversal、Windows 混淆和非精确稳定结构', async (t) => {
  const editorRoot = await createEditorRoot(t);
  const invalidPaths = [
    '/Assets/Skyboxes/DataPlatform/Skybox-1/skybox.hdr',
    'C:/Assets/Skyboxes/DataPlatform/Skybox-1/skybox.hdr',
    'C:\\Assets\\Skyboxes\\DataPlatform\\Skybox-1\\skybox.hdr',
    '\\\\server\\share\\Assets\\Skyboxes\\DataPlatform\\Skybox-1\\skybox.hdr',
    'Assets\\Skyboxes\\DataPlatform\\Skybox-1\\skybox.hdr',
    '../Assets/Skyboxes/DataPlatform/Skybox-1/skybox.hdr',
    'Assets/../Skyboxes/DataPlatform/Skybox-1/skybox.hdr',
    'Assets/./Skyboxes/DataPlatform/Skybox-1/skybox.hdr',
    'prefix/Assets/Skyboxes/DataPlatform/Skybox-1/skybox.hdr',
    'Assets/Skyboxes/DataPlatformX/Skybox-1/skybox.hdr',
    'Assets/Skyboxes/DataPlatform/Skybox-0/skybox.hdr',
    'Assets/Skyboxes/DataPlatform/Skybox-01/skybox.hdr',
    'Assets/Skyboxes/DataPlatform/Skybox--1/skybox.hdr',
    'Assets/Skyboxes/DataPlatform/Skybox-%31/skybox.hdr',
    'Assets/%53kyboxes/DataPlatform/Skybox-1/skybox.hdr',
    'Assets/Skyboxes/DataPlatform/Skybox-1/other.hdr',
    'Assets/Skyboxes/DataPlatform/Skybox-1/skybox.HDR',
    'Assets/Skyboxes/DataPlatform/Skybox-1/skybox.png',
    'Assets/Skyboxes/DataPlatform/Skybox-1/skybox.hdr/extra',
    'Assets/Skyboxes/DataPlatform/Skybox-1/skybox.hdr%2f..%2fescape',
    'Assets//Skyboxes/DataPlatform/Skybox-1/skybox.hdr',
    'Assets/Skyboxes/DataPlatform/Skybox-1//skybox.hdr',
  ];

  for (const relativePath of invalidPaths) {
    assert.throws(
      () => resolveSkyboxIndexEntryPath(editorRoot, relativePath),
      /路径|relativePath|稳定|允许目录/,
      relativePath,
    );
  }
});

test('索引不存在时返回空的 v1 索引', async (t) => {
  const editorRoot = await createEditorRoot(t);
  assert.deepEqual(await readDataPlatformSkyboxIndex(editorRoot), { version: 1, entries: [] });
});

test('索引写入指定 staging 目标并可读回，JSON 使用两空格和结尾换行', async (t) => {
  const editorRoot = await createEditorRoot(t);
  const stagingPath = path.join(editorRoot, '.staging', 'nested', 'skybox-index.json');
  const canonicalPath = getDataPlatformSkyboxIndexPath(editorRoot);
  const index = createIndex([createEntry()]);

  await writeDataPlatformSkyboxIndexFile(stagingPath, index);

  assert.equal(await fs.stat(stagingPath).then((stat) => stat.isFile()), true);
  await assert.rejects(fs.stat(canonicalPath), { code: 'ENOENT' });
  const content = await fs.readFile(stagingPath, 'utf8');
  assert.equal(content, `${JSON.stringify(index, null, 2)}\n`);

  await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
  await fs.copyFile(stagingPath, canonicalPath);
  assert.deepEqual(await readDataPlatformSkyboxIndex(editorRoot), index);
});

test('读取拒绝损坏 JSON、未知版本、非普通对象和未知字段', async (t) => {
  const editorRoot = await createEditorRoot(t);

  for (const value of [
    '{broken',
    'null',
    '[]',
    JSON.stringify({}),
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: 'not-an-array' }),
    JSON.stringify({ version: 1, entries: [], extra: true }),
  ]) {
    await writeRawIndex(editorRoot, value);
    await assert.rejects(
      readDataPlatformSkyboxIndex(editorRoot),
      /JSON|索引|版本|结构|字段/,
      value,
    );
  }
});

test('读取和写入都不信任原型字段或自定义原型对象', { concurrency: false }, async (t) => {
  const editorRoot = await createEditorRoot(t);
  const originalVersion = Object.getOwnPropertyDescriptor(Object.prototype, 'version');
  const originalEntries = Object.getOwnPropertyDescriptor(Object.prototype, 'entries');

  try {
    Object.defineProperty(Object.prototype, 'version', { configurable: true, value: 1 });
    Object.defineProperty(Object.prototype, 'entries', { configurable: true, value: [] });
    await writeRawIndex(editorRoot, '{}');
    await assert.rejects(readDataPlatformSkyboxIndex(editorRoot), /索引|结构|字段/);
  } finally {
    if (originalVersion) Object.defineProperty(Object.prototype, 'version', originalVersion);
    else delete (Object.prototype as Record<string, unknown>).version;
    if (originalEntries) Object.defineProperty(Object.prototype, 'entries', originalEntries);
    else delete (Object.prototype as Record<string, unknown>).entries;
  }

  const inheritedIndex = Object.assign(
    Object.create({ version: 1, entries: [] }) as Record<string, unknown>,
    {},
  ) as unknown as DataPlatformSkyboxIndex;
  const targetPath = path.join(editorRoot, 'staging', 'index.json');
  await assert.rejects(
    writeDataPlatformSkyboxIndexFile(targetPath, inheritedIndex),
    /索引|普通对象|结构|字段/,
  );
  await assert.rejects(fs.stat(targetPath), { code: 'ENOENT' });
});

test('索引严格校验每个条目字段', async (t) => {
  const editorRoot = await createEditorRoot(t);
  const valid = createEntry();
  const invalidEntries: Array<Record<string, unknown>> = [
    { ...valid, resourceId: 1 },
    { ...valid, resourceId: ' 1 ' },
    { ...valid, resourceId: '01' },
    { ...valid, displayName: '' },
    { ...valid, displayName: '   ' },
    { ...valid, relativePath: 1 },
    { ...valid, format: 'HDR' },
    { ...valid, format: 'png' },
    { ...valid, fileSizeBytes: 0 },
    { ...valid, fileSizeBytes: MAX_SKYBOX_FILE_BYTES + 1 },
    { ...valid, fileSizeBytes: 1.5 },
    { ...valid, fileSizeBytes: '1024' },
    { ...valid, sha256: 'A'.repeat(64) },
    { ...valid, sha256: 'a'.repeat(63) },
    { ...valid, revision: 1 },
    { ...valid, revision: '0' },
    { ...valid, revision: '01' },
    { ...valid, status: 'deleted' },
    { ...valid, syncedAt: '2026-08-11' },
    { ...valid, syncedAt: '2026-08-11T12:34:56' },
    { ...valid, syncedAt: '2026-02-29T12:34:56Z' },
    { ...valid, syncedAt: 'not-a-date' },
    { ...valid, unexpected: true },
  ];

  for (const entry of invalidEntries) {
    await writeRawIndex(editorRoot, { version: 1, entries: [entry] });
    await assert.rejects(
      readDataPlatformSkyboxIndex(editorRoot),
      /索引|条目|字段|resourceId|displayName|relativePath|format|fileSizeBytes|sha256|revision|status|syncedAt|时间/,
      JSON.stringify(entry),
    );
  }
});

test('索引路径必须与 resourceId 和 format 计算值完全一致', async (t) => {
  const editorRoot = await createEditorRoot(t);
  const valid = createEntry();

  for (const entry of [
    { ...valid, resourceId: '2' },
    { ...valid, format: 'exr' },
    { ...valid, relativePath: 'Assets/Skyboxes/DataPlatform/Skybox-1/skybox.exr' },
  ]) {
    await writeRawIndex(editorRoot, { version: 1, entries: [entry] });
    await assert.rejects(readDataPlatformSkyboxIndex(editorRoot), /relativePath|路径|resourceId|format/);
  }
});

test('索引拒绝重复 resourceId 和重复 relativePath', async (t) => {
  const editorRoot = await createEditorRoot(t);
  const first = createEntry(createRecord('1'));
  const second = createEntry(createRecord('2'));

  await writeRawIndex(editorRoot, { version: 1, entries: [first, { ...second, resourceId: '1' }] });
  await assert.rejects(readDataPlatformSkyboxIndex(editorRoot), /重复.*resourceId|resourceId.*重复|重复 ID/i);

  await writeRawIndex(editorRoot, { version: 1, entries: [first, { ...second, relativePath: first.relativePath }] });
  await assert.rejects(readDataPlatformSkyboxIndex(editorRoot), /重复.*relativePath|relativePath.*重复|重复路径/i);
});

test('写入前使用与读取相同的严格索引校验', async (t) => {
  const editorRoot = await createEditorRoot(t);
  const targetPath = path.join(editorRoot, 'staging', 'index.json');
  const invalid = createIndex([{ ...createEntry(), status: 'deleted' as 'active' }]);

  await assert.rejects(writeDataPlatformSkyboxIndexFile(targetPath, invalid), /status|状态|索引|条目/);
  await assert.rejects(fs.stat(targetPath), { code: 'ENOENT' });
});

test('首次同步每个远端 ID 都下载并按 1、2、10 稳定排序', () => {
  const remote = [createRecord('10'), createRecord('1'), createRecord('2')];
  const existingPaths = new Set(remote.map((record) => getDataPlatformSkyboxRelativePath(record.id, record.format)));

  const plan = assertPlanType(buildDataPlatformSkyboxPlan(
    remote,
    createIndex(),
    existingPaths,
    SYNCED_AT,
  ));

  assert.deepEqual(plan.downloads.map((download) => ({
    resourceId: assertDownloadType(download).record.id,
    relativePath: download.relativePath,
  })), [
    { resourceId: '1', relativePath: 'Assets/Skyboxes/DataPlatform/Skybox-1/skybox.hdr' },
    { resourceId: '2', relativePath: 'Assets/Skyboxes/DataPlatform/Skybox-2/skybox.hdr' },
    { resourceId: '10', relativePath: 'Assets/Skyboxes/DataPlatform/Skybox-10/skybox.hdr' },
  ]);
  assert.deepEqual(plan.nextIndex.entries.map((entry) => entry.resourceId), ['1', '2', '10']);
  assert.deepEqual(plan.nextIndex.entries.map((entry) => entry.status), ['active', 'active', 'active']);
  assert.deepEqual(plan.changedResourceIds, ['1', '2', '10']);
  assert.deepEqual(plan.orphanedResourceIds, []);
});

test('三参数调用使用当前时间生成合法 syncedAt', () => {
  const before = Date.now();
  const plan = buildDataPlatformSkyboxPlan(
    [createRecord('1')],
    createIndex(),
    new Set(),
  );
  const after = Date.now();
  const syncedAt = plan.nextIndex.entries[0].syncedAt;

  assert.match(syncedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const timestamp = Date.parse(syncedAt);
  assert.equal(Number.isFinite(timestamp), true);
  assert.equal(timestamp >= before && timestamp <= after, true);
});

test('内容相同且物理路径存在时零下载，只更新展示名、revision 和 syncedAt', () => {
  const oldRecord = createRecord('1', { displayName: '旧名称', revision: '1' });
  const currentEntry = createEntry(oldRecord);
  const remote = createRecord('1', { displayName: '新名称', revision: '2' });

  const plan = buildDataPlatformSkyboxPlan(
    [remote],
    createIndex([currentEntry]),
    new Set([currentEntry.relativePath]),
    NEXT_SYNCED_AT,
  );

  assert.deepEqual(plan.downloads, []);
  assert.deepEqual(plan.nextIndex.entries, [{
    ...currentEntry,
    displayName: '新名称',
    revision: '2',
    syncedAt: NEXT_SYNCED_AT,
  }]);
  assert.deepEqual(plan.changedResourceIds, ['1']);
  assert.deepEqual(plan.orphanedResourceIds, []);
});

test('仅 syncedAt 更新不属于资源语义变化', () => {
  const record = createRecord('1');
  const currentEntry = createEntry(record);

  const plan = buildDataPlatformSkyboxPlan(
    [record],
    createIndex([currentEntry]),
    new Set([currentEntry.relativePath]),
    NEXT_SYNCED_AT,
  );

  assert.deepEqual(plan.downloads, []);
  assert.equal(plan.nextIndex.entries[0].syncedAt, NEXT_SYNCED_AT);
  assert.deepEqual(plan.changedResourceIds, []);
});

test('hash 变化时计划重新下载并标记语义变化', () => {
  const currentRecord = createRecord('1');
  const currentEntry = createEntry(currentRecord);
  const remote = createRecord('1', { sha256: 'f'.repeat(64) });

  const plan = buildDataPlatformSkyboxPlan(
    [remote],
    createIndex([currentEntry]),
    new Set([currentEntry.relativePath]),
    NEXT_SYNCED_AT,
  );

  assert.deepEqual(plan.downloads.map((download) => download.record.id), ['1']);
  assert.equal(plan.nextIndex.entries[0].sha256, remote.sha256);
  assert.deepEqual(plan.changedResourceIds, ['1']);
});

test('format 互换生成新扩展名且计划中不删除旧文件', () => {
  const currentRecord = createRecord('1');
  const currentEntry = createEntry(currentRecord);
  const remote = createRecord('1', {
    format: 'exr',
    fileName: 'skybox-1.exr',
    fileUrl: 'https://cdn.example.com/skyboxes/1.exr',
  });
  const existingPaths = new Set([currentEntry.relativePath]);

  const plan = buildDataPlatformSkyboxPlan(
    [remote],
    createIndex([currentEntry]),
    existingPaths,
    NEXT_SYNCED_AT,
  );

  assert.deepEqual(plan.downloads.map((download) => download.relativePath), [
    'Assets/Skyboxes/DataPlatform/Skybox-1/skybox.exr',
  ]);
  assert.equal(plan.nextIndex.entries[0].relativePath, 'Assets/Skyboxes/DataPlatform/Skybox-1/skybox.exr');
  assert.equal(existingPaths.has(currentEntry.relativePath), true);
  assert.equal('deletions' in plan, false);
  assert.deepEqual(plan.changedResourceIds, ['1']);
});

test('文件大小变化时计划重新下载', () => {
  const currentRecord = createRecord('1');
  const currentEntry = createEntry(currentRecord);
  const remote = createRecord('1', { fileSizeBytes: currentRecord.fileSizeBytes + 1 });

  const plan = buildDataPlatformSkyboxPlan(
    [remote],
    createIndex([currentEntry]),
    new Set([currentEntry.relativePath]),
    NEXT_SYNCED_AT,
  );

  assert.deepEqual(plan.downloads.map((download) => download.record.id), ['1']);
  assert.equal(plan.nextIndex.entries[0].fileSizeBytes, remote.fileSizeBytes);
  assert.deepEqual(plan.changedResourceIds, ['1']);
});

test('索引内容相同但物理文件缺失时重新下载，不把 syncedAt 单独算作语义变化', () => {
  const record = createRecord('1');
  const currentEntry = createEntry(record);

  const plan = buildDataPlatformSkyboxPlan(
    [record],
    createIndex([currentEntry]),
    new Set(),
    NEXT_SYNCED_AT,
  );

  assert.deepEqual(plan.downloads.map((download) => download.record.id), ['1']);
  assert.equal(plan.nextIndex.entries[0].syncedAt, NEXT_SYNCED_AT);
  assert.deepEqual(plan.changedResourceIds, []);
});

test('远端缺失时保留原路径并列入 orphanedResourceIds', () => {
  const first = createEntry(createRecord('1'));
  const second = createEntry(createRecord('2'));

  const plan = buildDataPlatformSkyboxPlan(
    [createRecord('1')],
    createIndex([second, first]),
    new Set([first.relativePath, second.relativePath]),
    NEXT_SYNCED_AT,
  );

  assert.deepEqual(plan.downloads, []);
  assert.deepEqual(plan.nextIndex.entries.map((entry) => ({
    resourceId: entry.resourceId,
    relativePath: entry.relativePath,
    status: entry.status,
    syncedAt: entry.syncedAt,
  })), [
    { resourceId: '1', relativePath: first.relativePath, status: 'active', syncedAt: NEXT_SYNCED_AT },
    { resourceId: '2', relativePath: second.relativePath, status: 'orphaned', syncedAt: NEXT_SYNCED_AT },
  ]);
  assert.deepEqual(plan.changedResourceIds, ['2']);
  assert.deepEqual(plan.orphanedResourceIds, ['2']);
});

test('已 orphaned 且仍缺失时仍列入 nextIndex 的全部 orphaned ID', () => {
  const currentEntry = createEntry(createRecord('2'), { status: 'orphaned' });

  const plan = buildDataPlatformSkyboxPlan(
    [],
    createIndex([currentEntry]),
    new Set([currentEntry.relativePath]),
    NEXT_SYNCED_AT,
  );

  assert.equal(plan.nextIndex.entries[0].status, 'orphaned');
  assert.equal(plan.nextIndex.entries[0].syncedAt, NEXT_SYNCED_AT);
  assert.deepEqual(plan.changedResourceIds, []);
  assert.deepEqual(plan.orphanedResourceIds, ['2']);
});

test('远端重新出现时可从 orphaned 恢复 active', () => {
  const record = createRecord('2');
  const currentEntry = createEntry(record, { status: 'orphaned' });

  const plan = buildDataPlatformSkyboxPlan(
    [record],
    createIndex([currentEntry]),
    new Set([currentEntry.relativePath]),
    NEXT_SYNCED_AT,
  );

  assert.deepEqual(plan.downloads, []);
  assert.equal(plan.nextIndex.entries[0].status, 'active');
  assert.deepEqual(plan.changedResourceIds, ['2']);
  assert.deepEqual(plan.orphanedResourceIds, []);
});

test('远端记录使用 Task1 唯一性校验', () => {
  const first = createRecord('1');

  assert.throws(
    () => buildDataPlatformSkyboxPlan(
      [first, { ...createRecord('2'), id: '1' }],
      createIndex(),
      new Set(),
      SYNCED_AT,
    ),
    /重复 ID/,
  );
  assert.throws(
    () => buildDataPlatformSkyboxPlan(
      [first, { ...createRecord('2'), displayName: ` ${first.displayName} ` }],
      createIndex(),
      new Set(),
      SYNCED_AT,
    ),
    /重复名称/,
  );
  assert.throws(
    () => buildDataPlatformSkyboxPlan(
      [first, { ...createRecord('2'), sha256: first.sha256 }],
      createIndex(),
      new Set(),
      SYNCED_AT,
    ),
    /重复 SHA-256/,
  );
});

test('累计下载恰好 8GiB 通过，超过 8GiB 拒绝', () => {
  const createMaximumRecords = (count: number): DataPlatformSkyboxRecord[] => Array.from(
    { length: count },
    (_, index) => createRecord(String(index + 1), { fileSizeBytes: MAX_SKYBOX_FILE_BYTES }),
  );

  const exactPlan = buildDataPlatformSkyboxPlan(
    createMaximumRecords(16),
    createIndex(),
    new Set(),
    SYNCED_AT,
  );
  assert.equal(exactPlan.downloads.length, 16);
  assert.equal(
    exactPlan.downloads.reduce((total, download) => total + download.record.fileSizeBytes, 0),
    MAX_SKYBOX_SYNC_DOWNLOAD_BYTES,
  );

  assert.throws(
    () => buildDataPlatformSkyboxPlan(
      createMaximumRecords(17),
      createIndex(),
      new Set(),
      SYNCED_AT,
    ),
    /8\s*GiB|下载.*上限|下载.*过大/,
  );
});

test('计划函数不修改远端、当前索引或 existingPaths 输入', () => {
  const remote = deepFreeze([createRecord('10'), createRecord('1')]);
  const currentEntry = createEntry(createRecord('2'));
  const current = deepFreeze(createIndex([currentEntry]));
  const existingPaths = new Set([currentEntry.relativePath]);
  const remoteSnapshot = structuredClone(remote);
  const currentSnapshot = structuredClone(current);
  const pathsSnapshot = [...existingPaths];

  const plan = buildDataPlatformSkyboxPlan(
    remote,
    current,
    existingPaths,
    NEXT_SYNCED_AT,
  );

  assert.deepEqual(remote, remoteSnapshot);
  assert.deepEqual(current, currentSnapshot);
  assert.deepEqual([...existingPaths], pathsSnapshot);
  assert.notStrictEqual(plan.nextIndex, current);
  assert.notStrictEqual(plan.nextIndex.entries.find((entry) => entry.resourceId === '2'), currentEntry);
  assert.notStrictEqual(plan.downloads[0].record, remote[1]);
});

test('计划拒绝不完整或无效的 syncedAt', () => {
  for (const syncedAt of [
    '',
    '2026-08-11',
    '2026-08-11T12:34:56',
    '2026-02-29T12:34:56Z',
    '2026-08-11T24:00:00Z',
    'not-a-date',
  ]) {
    assert.throws(
      () => buildDataPlatformSkyboxPlan([], createIndex(), new Set(), syncedAt),
      /syncedAt|时间|ISO/,
      syncedAt,
    );
  }
});

test('写入拒绝 entries 数组上的隐藏自有字段', async (t) => {
  const editorRoot = await createEditorRoot(t);
  const targetPath = path.join(editorRoot, 'staging', 'index.json');
  const entries = [createEntry()];
  Object.defineProperty(entries, 'hidden', { value: true });

  await assert.rejects(
    writeDataPlatformSkyboxIndexFile(targetPath, createIndex(entries)),
    /entries.*字段|未知字段|索引/,
  );
  await assert.rejects(fs.stat(targetPath), { code: 'ENOENT' });
});
