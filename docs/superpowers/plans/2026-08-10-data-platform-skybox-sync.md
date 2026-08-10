# 数字孪生编辑器数据中台天空盒同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让数字孪生编辑器在打开数据中台项目时后台同步全局天空盒资源，并在现有天空盒 Tab 中同时提供项目本地和数据中台资源、手动同步、失败重试、稳定 ID 重关联、远端删除兼容和离线发布。

**Architecture:** 新增独立 `dataPlatformSkyboxContract`、`dataPlatformSkyboxIndex` 和 `dataPlatformSkyboxSync` 三层：契约层只负责远端响应规范化和唯一性检查，索引层负责稳定路径、active/orphaned 清单和纯增量计划，同步层负责有界分页、并发 2 下载、流式 SHA-256、HDR/EXR 复检和整批原子推广。项目本地天空盒继续扫描当前项目目录；数据中台天空盒从独立共享清单读取，以稳定资源 ID 参与场景重关联，远端删除只隐藏卡片并保留兼容缓存。

**Tech Stack:** Electron 42、Node.js 22、TypeScript 6、React 19、Babylon.js 9、Node test、Playwright Electron、现有 `dataPlatformTransfer`、`skyboxAssetStore`、命令/撤销系统和部署导出链路。

---

## 前置依赖和固定契约

实施本计划前，数据中台计划必须已经提供：

```text
POST /api/v1/skyboxes/query
```

响应中的 `id/fileSize/revision/total/pageNum/pageSize` 均为十进制字符串。编辑器只接受以下资源项：

```ts
export type DataPlatformSkyboxRecord = {
  id: string;
  displayName: string;
  fileName: string;
  fileUrl: string;
  format: 'hdr' | 'exr';
  fileSizeBytes: number;
  sha256: string;
  revision: string;
  updatedAt: string | null;
};
```

安全上限固定为：

```ts
export const MAX_SKYBOX_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_SKYBOX_SYNC_DOWNLOAD_BYTES = 8 * 1024 * 1024 * 1024;
export const SKYBOX_SYNC_DOWNLOAD_CONCURRENCY = 2;
export const SKYBOX_QUERY_PAGE_SIZE = 100;
export const MAX_SKYBOX_QUERY_PAGES = 1_000;
export const MAX_SKYBOX_RECORDS = 100_000;
```

共享缓存固定布局：

```text
SharedResources/
├─ Assets/Skyboxes/DataPlatform/Skybox-<resourceId>/skybox.hdr|skybox.exr
└─ .babylon-editor/data-platform-skybox-index.json
```

## 文件职责映射

### 新建文件

```text
electron/ipc/dataPlatformSkyboxContract.ts
electron/ipc/dataPlatformSkyboxIndex.ts
electron/ipc/dataPlatformSkyboxSync.ts
tests/dataPlatform/skyboxContract.test.ts
tests/dataPlatform/skyboxIndex.test.ts
tests/dataPlatform/skyboxRelink.test.ts
tests/digitalTwin/dataPlatformSkyboxSync.test.ts
scripts/smoke-data-platform-skybox.mjs
```

### 修改 Electron 主进程和桥接文件

```text
electron/types.ts
electron/preload.ts
electron/preload.cts
electron/ipc/dataPlatformTransfer.ts
electron/ipc/dataPlatformIpc.ts
electron/ipc/dataPlatformProjectService.ts
electron/ipc/projectIpc.ts
electron/ipc/projectAssetStore.ts
electron/ipc/skyboxAssetStore.ts
electron/ipc/deploymentExportScene.ts
src/vite-env.d.ts
```

### 修改 renderer、场景和测试文件

```text
src/editor/home/HomePage.tsx
src/editor/assets/AssetDatabase.ts
src/editor/assets/projectLibrary.ts
src/editor/assets/skyboxAssets.ts
src/editor/model/SceneDocument.ts
src/editor/model/components.ts
src/editor/project/SceneSerializer.ts
src/editor/panels/ProjectPanel.tsx
src/editor/panels/SceneSettingsPanel.tsx
tests/telemetry/skyboxSettings.test.ts
tests/digitalTwin/projectLibraryTabs.test.ts
tests/digitalTwin/digitalTwinPublish.integration.mjs
package.json
README.md
```

---

## 执行前预检

- 实施时先使用 `superpowers:using-git-worktrees` 创建隔离工作区，再从当前 HEAD 执行本计划。
- 运行 `git status --short --branch`，确认当前已有提交和用户改动都被保留。
- 部分工作树源码曾在普通 `Get-Content` 下显示乱码；修改前先执行 `git show HEAD:<path>` 和 `git check-attr -a -- <path>`。如果工作树内容与 Git blob 的文本编码不一致，先定位 filter/工作树转换原因，不得把乱码覆盖回源码。
- 本计划不修改现有模型、环境、组合模型或图片同步语义；公共下载工具只增加向后兼容的可选 `onChunk`。

---

### Task 1: 以测试驱动锁定远端天空盒契约和重复检查

**Files:**
- Create: `electron/ipc/dataPlatformSkyboxContract.ts`
- Create: `tests/dataPlatform/skyboxContract.test.ts`

- [ ] **Step 1: 写字符串线类型和正常响应失败测试**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeSkyboxQueryResponse } from '../../electron/ipc/dataPlatformSkyboxContract.ts';

describe('dataPlatformSkyboxContract', () => {
  it('把字符串 long 字段规范化为安全的远端记录', () => {
    const page = normalizeSkyboxQueryResponse({
      success: true,
      data: {
        records: [{
          id: '2052912068767571969',
          skyboxName: '晴朗草原',
          fileName: 'meadow.hdr',
          fileUrl: '/api/v1/files/meadow.hdr',
          fileFormat: 'HDR',
          fileSize: '134217728',
          fileSha256: 'a'.repeat(64),
          revision: '3',
          updatedAt: '2026-08-10T11:00:00',
        }],
        total: '1',
        pageNum: '1',
        pageSize: '100',
      },
    });

    assert.equal(page.records[0].id, '2052912068767571969');
    assert.equal(page.records[0].fileSizeBytes, 134217728);
    assert.equal(page.records[0].revision, '3');
    assert.equal(page.records[0].format, 'hdr');
    assert.equal(page.total, 1);
  });
});
```

- [ ] **Step 2: 写非法字段和重复资源失败测试**

分别断言拒绝：超出 512 MiB 的 `fileSize`、超出安全范围的页字段、零/负 revision、非 64 位小写 SHA、扩展名与 `fileFormat` 不一致、空 URL、重复 ID、名称不区分大小写重复和重复 SHA。测试 builder 使用：

```ts
function remoteRecord(overrides: Partial<DataPlatformSkyboxRecord> = {}): DataPlatformSkyboxRecord {
  return {
    id: '123',
    displayName: 'Studio',
    fileName: 'studio.hdr',
    fileUrl: '/api/v1/files/studio.hdr',
    format: 'hdr',
    fileSizeBytes: 1024,
    sha256: 'a'.repeat(64),
    revision: '1',
    updatedAt: '2026-08-10T10:00:00',
    ...overrides,
  };
}
```

```ts
it('拒绝名称大小写重复和重复 SHA', () => {
  const first = remoteRecord({ id: '1', displayName: 'Studio', sha256: 'a'.repeat(64) });
  const second = remoteRecord({ id: '2', displayName: 'studio', sha256: 'b'.repeat(64) });
  assert.throws(() => assertUniqueSkyboxRecords([first, second]), /重复名称/);
  assert.throws(
    () => assertUniqueSkyboxRecords([first, remoteRecord({ id: '3', displayName: 'Forest', sha256: first.sha256 })]),
    /重复 SHA-256/,
  );
});
```

- [ ] **Step 3: 运行测试并确认失败**

Run:

```powershell
node --experimental-strip-types --test tests/dataPlatform/skyboxContract.test.ts
```

Expected: 因契约模块尚不存在而失败。

- [ ] **Step 4: 实现严格的十进制字符串转换**

```ts
export function parseBoundedDecimalString(
  value: unknown,
  options: { label: string; min: bigint; max: bigint },
): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new Error(`数据中台天空盒${options.label}必须是十进制字符串。`);
  }
  const parsed = BigInt(value.trim());
  if (parsed < options.min || parsed > options.max) {
    throw new Error(`数据中台天空盒${options.label}超出允许范围。`);
  }
  return Number(parsed);
}

export function normalizePositiveIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,63}$/.test(value.trim())) {
    throw new Error(`数据中台天空盒${label}无效。`);
  }
  return value.trim();
}
```

revision 使用独立 `normalizePositiveDecimalString` 返回规范化字符串，不转换成 number。

- [ ] **Step 5: 实现查询页规范化**

```ts
export function normalizeSkyboxQueryResponse(value: unknown): DataPlatformSkyboxPage {
  const envelope = requirePlainObject(value, '响应');
  if (envelope.success !== true) {
    const message = typeof envelope.message === 'string' && envelope.message.trim()
      ? envelope.message.trim()
      : '查询天空盒失败';
    throw new Error(message);
  }
  const data = requirePlainObject(envelope.data, 'data');
  if (!Array.isArray(data.records)) throw new Error('数据中台天空盒 records 不是数组。');
  const records = data.records.map(normalizeSkyboxRecord);
  assertUniqueSkyboxRecords(records);
  return {
    records,
    total: parseBoundedDecimalString(data.total, { label: '总数', min: 0n, max: 100_000n }),
    pageNum: parseBoundedDecimalString(data.pageNum, { label: '页码', min: 1n, max: 1_000n }),
    pageSize: parseBoundedDecimalString(data.pageSize, { label: '每页条数', min: 1n, max: 100n }),
  };
}
```

`normalizeSkyboxRecord` 把 `HDR/EXR` 转为小写，校验文件名扩展名、URL 非空、大小 1–512 MiB、SHA 小写、revision 正整数和时间可空。

- [ ] **Step 6: 实现重复检查**

```ts
export function assertUniqueSkyboxRecords(records: DataPlatformSkyboxRecord[]): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  const hashes = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`数据中台天空盒存在重复 ID：${record.id}`);
    const nameKey = record.displayName.normalize('NFKC').trim().toLowerCase();
    if (names.has(nameKey)) throw new Error(`数据中台天空盒存在重复名称：${record.displayName}`);
    if (hashes.has(record.sha256)) throw new Error(`数据中台天空盒存在重复 SHA-256：${record.sha256}`);
    ids.add(record.id);
    names.add(nameKey);
    hashes.add(record.sha256);
  }
}
```

- [ ] **Step 7: 重新运行契约测试**

Run:

```powershell
node --experimental-strip-types --test tests/dataPlatform/skyboxContract.test.ts
```

Expected: 所有契约、边界和重复检查测试通过。

- [ ] **Step 8: 提交契约层**

```powershell
git add electron/ipc/dataPlatformSkyboxContract.ts tests/dataPlatform/skyboxContract.test.ts
git commit -m "feat: validate data platform skybox contract"
```

---

### Task 2: 以测试驱动实现共享索引、稳定路径和纯增量计划

**Files:**
- Create: `electron/ipc/dataPlatformSkyboxIndex.ts`
- Create: `tests/dataPlatform/skyboxIndex.test.ts`

- [ ] **Step 1: 写首次同步、零下载和孤立记录失败测试**

```ts
it('首次同步为每个稳定 ID 生成下载项和稳定路径', () => {
  const remote = [remoteRecord({ id: '123', format: 'hdr', sha256: 'a'.repeat(64) })];
  const plan = buildDataPlatformSkyboxPlan(remote, emptyIndex(), new Set());
  assert.deepEqual(plan.downloads.map((item) => item.relativePath), [
    'Assets/Skyboxes/DataPlatform/Skybox-123/skybox.hdr',
  ]);
  assert.equal(plan.nextIndex.entries[0].status, 'active');
});

it('相同 hash、格式、大小且文件存在时零下载，只刷新元数据', () => {
  const current = indexWithEntry({
    resourceId: '123',
    displayName: '旧名称',
    revision: '2',
    sha256: 'a'.repeat(64),
    format: 'hdr',
    fileSizeBytes: 1024,
    relativePath: 'Assets/Skyboxes/DataPlatform/Skybox-123/skybox.hdr',
    status: 'active',
  });
  const remote = [remoteRecord({ id: '123', displayName: '新名称', revision: '3', sha256: 'a'.repeat(64), fileSizeBytes: 1024 })];
  const plan = buildDataPlatformSkyboxPlan(remote, current, new Set([current.entries[0].relativePath]));
  assert.equal(plan.downloads.length, 0);
  assert.equal(plan.nextIndex.entries[0].displayName, '新名称');
});

it('远端缺失记录变为 orphaned 且保留原路径', () => {
  const current = indexWithEntry(activeEntry('123'));
  const plan = buildDataPlatformSkyboxPlan([], current, new Set([current.entries[0].relativePath]));
  assert.equal(plan.nextIndex.entries[0].status, 'orphaned');
  assert.equal(plan.nextIndex.entries[0].relativePath, current.entries[0].relativePath);
});
```

再覆盖：hash 变化、格式互换、文件物理缺失、累计下载超过 8 GiB、索引重复 ID、非法 relativePath、未知版本和 JSON 损坏。索引测试 builder 使用：

```ts
function emptyIndex(): DataPlatformSkyboxIndex {
  return { version: 1, entries: [] };
}

function activeEntry(resourceId: string): DataPlatformSkyboxIndexEntry {
  return {
    resourceId,
    displayName: 'Studio',
    revision: '1',
    sha256: 'a'.repeat(64),
    format: 'hdr',
    fileSizeBytes: 1024,
    relativePath: `Assets/Skyboxes/DataPlatform/Skybox-${resourceId}/skybox.hdr`,
    status: 'active',
    syncedAt: '2026-08-10T10:00:00.000Z',
  };
}

function indexWithEntry(entry: DataPlatformSkyboxIndexEntry): DataPlatformSkyboxIndex {
  return { version: 1, entries: [entry] };
}
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
node --experimental-strip-types --test tests/dataPlatform/skyboxIndex.test.ts
```

Expected: 索引模块尚不存在导致失败。

- [ ] **Step 3: 定义索引和计划类型**

```ts
export type DataPlatformSkyboxIndexEntry = {
  resourceId: string;
  displayName: string;
  revision: string;
  sha256: string;
  format: 'hdr' | 'exr';
  fileSizeBytes: number;
  relativePath: string;
  status: 'active' | 'orphaned';
  syncedAt: string;
};

export type DataPlatformSkyboxIndex = {
  version: 1;
  entries: DataPlatformSkyboxIndexEntry[];
};

export type DataPlatformSkyboxDownloadPlan = {
  record: DataPlatformSkyboxRecord;
  relativePath: string;
};

export type DataPlatformSkyboxPlan = {
  downloads: DataPlatformSkyboxDownloadPlan[];
  nextIndex: DataPlatformSkyboxIndex;
  changedResourceIds: string[];
  orphanedResourceIds: string[];
};
```

- [ ] **Step 4: 实现稳定路径函数和越界防护**

```ts
export function getDataPlatformSkyboxIndexPath(editorRoot: string): string {
  return path.join(editorRoot, '.babylon-editor', 'data-platform-skybox-index.json');
}

export function getDataPlatformSkyboxRelativePath(resourceId: string, format: 'hdr' | 'exr'): string {
  if (!/^[1-9]\d{0,63}$/.test(resourceId)) throw new Error('天空盒资源 ID 无效。');
  return path.posix.join('Assets', 'Skyboxes', 'DataPlatform', `Skybox-${resourceId}`, `skybox.${format}`);
}

export function resolveSkyboxIndexEntryPath(editorRoot: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized.startsWith('Assets/Skyboxes/DataPlatform/')) throw new Error('天空盒索引路径无效。');
  const target = path.resolve(editorRoot, ...normalized.split('/'));
  assertPathInside(editorRoot, target, '天空盒索引文件');
  return target;
}
```

- [ ] **Step 5: 实现索引读写和规范化**

`readDataPlatformSkyboxIndex` 在文件不存在时返回 `{ version: 1, entries: [] }`；存在时严格校验版本、数组、字段、重复 ID 和路径。`writeDataPlatformSkyboxIndexFile` 只写调用方指定的目标文件，供同步服务把下一版索引先写到 staging：

```ts
export async function writeDataPlatformSkyboxIndexFile(targetPath: string, index: DataPlatformSkyboxIndex): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}
```

- [ ] **Step 6: 实现纯增量计划**

```ts
export function buildDataPlatformSkyboxPlan(
  remoteRecords: DataPlatformSkyboxRecord[],
  currentIndex: DataPlatformSkyboxIndex,
  existingRelativePaths: ReadonlySet<string>,
  syncedAt = new Date().toISOString(),
): DataPlatformSkyboxPlan {
  assertUniqueSkyboxRecords(remoteRecords);
  const currentById = new Map(currentIndex.entries.map((entry) => [entry.resourceId, entry]));
  const remoteIds = new Set(remoteRecords.map((record) => record.id));
  const downloads: DataPlatformSkyboxDownloadPlan[] = [];
  const nextEntries = remoteRecords.map((record) => {
    const current = currentById.get(record.id);
    const relativePath = getDataPlatformSkyboxRelativePath(record.id, record.format);
    const unchanged = current?.sha256 === record.sha256
      && current.format === record.format
      && current.fileSizeBytes === record.fileSizeBytes
      && existingRelativePaths.has(current.relativePath);
    if (!unchanged) downloads.push({ record, relativePath });
    return {
      resourceId: record.id,
      displayName: record.displayName,
      revision: record.revision,
      sha256: record.sha256,
      format: record.format,
      fileSizeBytes: record.fileSizeBytes,
      relativePath,
      status: 'active' as const,
      syncedAt,
    };
  });
  for (const entry of currentIndex.entries) {
    if (!remoteIds.has(entry.resourceId)) nextEntries.push({ ...entry, status: 'orphaned', syncedAt });
  }
  const downloadBytes = downloads.reduce((total, item) => total + item.record.fileSizeBytes, 0);
  if (downloadBytes > MAX_SKYBOX_SYNC_DOWNLOAD_BYTES) throw new Error('单次天空盒同步下载总量超过 8 GiB。');
  const changedResourceIds = nextEntries
    .filter((entry) => hasSkyboxEntryChanged(currentById.get(entry.resourceId), entry))
    .map((entry) => entry.resourceId);
  const orphanedResourceIds = nextEntries
    .filter((entry) => entry.status === 'orphaned')
    .map((entry) => entry.resourceId);
  return {
    downloads,
    nextIndex: {
      version: 1,
      entries: nextEntries.sort((left, right) => left.resourceId.localeCompare(right.resourceId, 'en')),
    },
    changedResourceIds,
    orphanedResourceIds,
  };
}

function hasSkyboxEntryChanged(
  current: DataPlatformSkyboxIndexEntry | undefined,
  next: DataPlatformSkyboxIndexEntry,
): boolean {
  return !current
    || current.displayName !== next.displayName
    || current.revision !== next.revision
    || current.sha256 !== next.sha256
    || current.format !== next.format
    || current.fileSizeBytes !== next.fileSizeBytes
    || current.relativePath !== next.relativePath
    || current.status !== next.status;
}
```

格式互换时 `relativePath` 改为新扩展名，但旧扩展名文件不进入删除计划。

- [ ] **Step 7: 重新运行索引测试**

Run:

```powershell
node --experimental-strip-types --test tests/dataPlatform/skyboxIndex.test.ts
```

Expected: 计划、索引、路径和上限测试全部通过。

- [ ] **Step 8: 提交索引层**

```powershell
git add electron/ipc/dataPlatformSkyboxIndex.ts tests/dataPlatform/skyboxIndex.test.ts
git commit -m "feat: plan incremental skybox synchronization"
```

---

### Task 3: 以测试驱动实现下载、校验和整批原子同步引擎

**Files:**
- Create: `electron/ipc/dataPlatformSkyboxSync.ts`
- Create: `tests/digitalTwin/dataPlatformSkyboxSync.test.ts`
- Modify: `electron/ipc/dataPlatformTransfer.ts`
- Modify: `electron/ipc/skyboxAssetStore.ts`

- [ ] **Step 1: 写首次同步和零下载失败测试**

测试通过依赖注入使用临时目录，不访问真实数据中台：

```ts
it('首次同步下载、计算 hash、校验并提交索引', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'skybox-sync-'));
  const bytes = createValidHdr(8, 2);
  const record = remoteRecord({
    id: '123',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    fileSizeBytes: bytes.length,
  });
  const downloads: string[] = [];

  await executeDataPlatformSkyboxSync({
    baseUrl: 'http://127.0.0.1:8086',
    editorRoot: root,
    dependencies: fakeDependencies({
      records: [record],
      download: async (options) => {
        downloads.push(record.id);
        await mkdir(path.dirname(options.destinationPath), { recursive: true });
        await writeFile(options.destinationPath, bytes);
        options.onChunk?.(bytes);
        options.onBytes?.(bytes.length);
        return { bytes: bytes.length, contentType: 'application/octet-stream', finalUrl: record.fileUrl };
      },
    }),
  });

  assert.deepEqual(downloads, ['123']);
  const index = await readDataPlatformSkyboxIndex(root);
  assert.equal(index.entries[0].status, 'active');
  assert.deepEqual(await readFile(resolveSkyboxIndexEntryPath(root, index.entries[0].relativePath)), bytes);
});
```

第二次使用相同索引和文件运行，断言下载函数调用数为 0；仅名称/revision 变化也必须为 0。同步测试使用以下真实格式夹具：

```ts
function createValidHdr(width = 8, height = 2, fill = 1): Buffer {
  const header = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, 'ascii');
  return Buffer.concat([header, Buffer.alloc(width * height * 4, fill)]);
}

function createValidExr(width = 16, height = 8): Buffer {
  const name = Buffer.from('dataWindow\0', 'ascii');
  const type = Buffer.from('box2i\0', 'ascii');
  const box = Buffer.alloc(16);
  box.writeInt32LE(0, 0);
  box.writeInt32LE(0, 4);
  box.writeInt32LE(width - 1, 8);
  box.writeInt32LE(height - 1, 12);
  const size = Buffer.alloc(4);
  size.writeInt32LE(16, 0);
  return Buffer.concat([
    Buffer.from([0x76, 0x2f, 0x31, 0x01, 0x02, 0x00, 0x00, 0x00]),
    name,
    type,
    size,
    box,
    Buffer.from([0]),
  ]);
}
```

- [ ] **Step 2: 写失败原子性、格式互换、孤立和并发失败测试**

覆盖：

```ts
it('任一下载 hash 不匹配时旧索引和旧文件保持不变', async () => {
  const beforeIndex = await seedActiveSkybox(root, activeEntry('123'));
  await assert.rejects(
    executeDataPlatformSkyboxSync({
      baseUrl,
      editorRoot: root,
      dependencies: fakeDependencies({ records: [changedRemoteRecord('123')], downloadedBytes: Buffer.from('corrupt') }),
    }),
    /SHA-256 不匹配/,
  );
  assert.deepEqual(await readDataPlatformSkyboxIndex(root), beforeIndex);
  assert.equal(await readFile(resolveSkyboxIndexEntryPath(root, beforeIndex.entries[0].relativePath), 'utf8'), 'old-valid-file');
});
```

另写测试：格式由 HDR 变 EXR 时新扩展名成为 active 且旧 HDR 文件保留；远端删除只改 `orphaned`；累计下载超过 8 GiB 在任何下载前失败；并发计数峰值不超过 2；推广中途失败可完整回滚；回滚不完整抛 `DataPlatformRollbackError` 并保留恢复目录；AbortSignal 取消后无句柄和 staging 残留；重复触发复用同一 promise。依赖 builder 固定返回一页 `ApiResult`，并让 fake 下载主动调用 `onChunk/onBytes`：

```ts
function toWireSkybox(record: DataPlatformSkyboxRecord) {
  return {
    id: record.id,
    skyboxName: record.displayName,
    fileName: record.fileName,
    fileUrl: record.fileUrl,
    fileFormat: record.format.toUpperCase(),
    fileSize: String(record.fileSizeBytes),
    fileSha256: record.sha256,
    revision: record.revision,
    updatedAt: record.updatedAt,
  };
}

function fakeDependencies(options: {
  records: DataPlatformSkyboxRecord[];
  downloadedBytes?: Buffer;
  download?: DataPlatformSkyboxSyncDependencies['downloadFile'];
}): DataPlatformSkyboxSyncDependencies {
  return {
    requestJson: async () => ({
      success: true,
      data: {
        records: options.records.map(toWireSkybox),
        total: String(options.records.length),
        pageNum: '1',
        pageSize: '100',
      },
    }),
    downloadFile: options.download ?? (async (downloadOptions) => {
      const bytes = options.downloadedBytes ?? createValidHdr();
      await mkdir(path.dirname(downloadOptions.destinationPath), { recursive: true });
      await writeFile(downloadOptions.destinationPath, bytes);
      downloadOptions.onChunk?.(bytes);
      downloadOptions.onBytes?.(bytes.length);
      return { bytes: bytes.length, contentType: 'application/octet-stream', finalUrl: downloadOptions.remoteUrl };
    }),
    validateFile: validateSkyboxSourceFile,
    now: () => '2026-08-10T10:00:00.000Z',
    randomId: () => 'test-run',
  };
}

function activeEntry(resourceId: string): DataPlatformSkyboxIndexEntry {
  return {
    resourceId,
    displayName: 'Studio',
    revision: '1',
    sha256: 'a'.repeat(64),
    format: 'hdr',
    fileSizeBytes: 14,
    relativePath: `Assets/Skyboxes/DataPlatform/Skybox-${resourceId}/skybox.hdr`,
    status: 'active',
    syncedAt: '2026-08-10T09:00:00.000Z',
  };
}

async function seedActiveSkybox(root: string, entry: DataPlatformSkyboxIndexEntry) {
  const index = { version: 1 as const, entries: [entry] };
  const filePath = resolveSkyboxIndexEntryPath(root, entry.relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, 'old-valid-file', 'utf8');
  await writeDataPlatformSkyboxIndexFile(getDataPlatformSkyboxIndexPath(root), index);
  return index;
}

function changedRemoteRecord(resourceId: string): DataPlatformSkyboxRecord {
  const bytes = createValidHdr(8, 2, 2);
  return {
    id: resourceId,
    displayName: 'Studio',
    fileName: 'studio.hdr',
    fileUrl: '/files/studio.hdr',
    format: 'hdr',
    fileSizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    revision: '2',
    updatedAt: '2026-08-10T10:00:00',
  };
}
```

- [ ] **Step 3: 运行同步测试并确认失败**

Run:

```powershell
node --experimental-strip-types --test tests/digitalTwin/dataPlatformSkyboxSync.test.ts
```

Expected: 同步模块尚不存在导致失败。

- [ ] **Step 4: 给下载工具增加流式 chunk 观察器**

`DownloadRemoteFileOptions` 增加：

```ts
onChunk?: (chunk: Uint8Array) => void;
```

在 `downloadRemoteFile` 的写盘循环中，写入成功后按以下顺序通知：

```ts
await writeBufferFully(handle, chunk);
options.onChunk?.(chunk);
options.onBytes?.(chunk.byteLength);
```

`onChunk` 不得保留 Buffer 引用，不得改变现有大小限制、超时、取消和 partial 文件清理语义。

- [ ] **Step 5: 复用现有天空盒内容校验器**

保持 `validateSkyboxSourceFile(filePath)` 为唯一 Electron 端 HDR/EXR 完整内容校验入口；确认它已经导出并返回：

```ts
Promise<{ format: SkyboxAssetFormat; fileSizeBytes: number }>
```

同时新增只读取 stat/头部的轻量包装，供资源列表避免反复扫描 512 MiB HDR 像素区：

```ts
export async function inspectSkyboxAssetFile(
  filePath: string,
): Promise<{ format: SkyboxAssetFormat; fileSizeBytes: number }> {
  const metadata = await inspectSkyboxSourceFile(filePath);
  return { format: metadata.format, fileSizeBytes: metadata.fileSizeBytes };
}
```

同步服务下载后必须调用完整 `validateSkyboxSourceFile`；资源列表只调用 `inspectSkyboxAssetFile`。不要复制第二套 HDR/EXR 解析器。

- [ ] **Step 6: 定义同步状态、依赖和生命周期**

```ts
export type DataPlatformSkyboxSyncContext = {
  baseUrl: string;
  editorRoot: string;
};

export type DataPlatformSkyboxSyncDependencies = {
  requestJson: typeof requestDataPlatformJson;
  downloadFile: typeof downloadRemoteFile;
  validateFile: typeof validateSkyboxSourceFile;
  now: () => string;
  randomId: () => string;
};

type ActiveSkyboxSync = {
  runId: string;
  controller: AbortController;
  promise: Promise<void>;
};
```

公开函数固定为；其中 `executeDataPlatformSkyboxSync` 是 start/retry 共用的可注入执行核心，不是测试专用分支：

```ts
executeDataPlatformSkyboxSync(options: { baseUrl: string; editorRoot: string; signal?: AbortSignal; dependencies?: DataPlatformSkyboxSyncDependencies; runId?: string }): Promise<void>
startDataPlatformSkyboxSync(baseUrl: string, editorRoot: string): boolean
retryDataPlatformSkyboxSync(): boolean
getLatestDataPlatformSkyboxSyncProgress(): DataPlatformSkyboxSyncProgress | null
clearDataPlatformSkyboxSyncRetryContext(): void
disposeDataPlatformSkyboxSync(): Promise<void>
```

已有任务时 `start` 返回 `true` 但不创建第二个任务；退出时 abort 并等待 promise settle。

- [ ] **Step 7: 实现有界分页查询**

```ts
async function queryAllSkyboxes(context: DataPlatformSkyboxSyncContext, signal: AbortSignal) {
  const records: DataPlatformSkyboxRecord[] = [];
  let expectedTotal: number | null = null;
  for (let pageNum = 1; pageNum <= MAX_SKYBOX_QUERY_PAGES; pageNum += 1) {
    const response = await dependencies.requestJson({
      baseUrl: context.baseUrl,
      endpointPath: 'api/v1/skyboxes/query',
      body: { pageNum, pageSize: SKYBOX_QUERY_PAGE_SIZE, skyboxName: '' },
      signal,
      timeoutMs: QUERY_TIMEOUT_MS,
      context: '查询数据中台天空盒',
    });
    const page = normalizeSkyboxQueryResponse(response);
    if (page.pageNum !== pageNum || page.pageSize !== SKYBOX_QUERY_PAGE_SIZE) {
      throw new Error('数据中台天空盒分页响应与请求不一致。');
    }
    if (expectedTotal === null) expectedTotal = page.total;
    if (page.total !== expectedTotal) throw new Error('数据中台天空盒分页总数在查询过程中发生变化。');
    records.push(...page.records);
    if (records.length > MAX_SKYBOX_RECORDS) throw new Error('数据中台天空盒数量超过 100000 条限制。');
    if (records.length === expectedTotal) {
      assertUniqueSkyboxRecords(records);
      return records;
    }
    if (records.length > expectedTotal || page.records.length === 0) {
      throw new Error('数据中台天空盒分页响应不完整。');
    }
  }
  throw new Error('数据中台天空盒查询页数超过 1000 页限制。');
}
```

超过最大页数仍未取完时失败，且不修改旧库。

- [ ] **Step 8: 在规划前安全检查现有文件**

逐项解析当前索引路径并使用 `lstat`；只有“路径位于 editorRoot 内、不是符号链接、是普通文件”的记录才能加入 `existingRelativePaths`。缺失、目录或符号链接都视为需要重新下载，不删除旧索引或越界目标。

- [ ] **Step 9: 实现并发 2 下载、流式 hash 和内容复检**

```ts
async function downloadPlannedSkybox(job: DataPlatformSkyboxDownloadPlan, stagingRoot: string, signal: AbortSignal) {
  const stagedPath = path.join(stagingRoot, 'files', job.record.id, `skybox.${job.record.format}`);
  assertPathInside(stagingRoot, stagedPath, '天空盒下载暂存文件');
  const digest = createHash('sha256');
  const result = await dependencies.downloadFile({
    baseUrl: context.baseUrl,
    remoteUrl: job.record.fileUrl,
    destinationPath: stagedPath,
    maxBytes: MAX_SKYBOX_FILE_BYTES,
    signal,
    timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS,
    context: `下载天空盒“${job.record.displayName}”`,
    onChunk: (chunk) => digest.update(chunk),
    onBytes: (bytes) => addDownloadedBytes(bytes),
  });
  const sha256 = digest.digest('hex');
  if (result.bytes !== job.record.fileSizeBytes) throw new Error(`天空盒“${job.record.displayName}”文件大小不匹配。`);
  if (sha256 !== job.record.sha256) throw new Error(`天空盒“${job.record.displayName}”SHA-256 不匹配。`);
  const validation = await dependencies.validateFile(stagedPath);
  if (validation.format !== job.record.format || validation.fileSizeBytes !== job.record.fileSizeBytes) {
    throw new Error(`天空盒“${job.record.displayName}”内容校验结果与元数据不一致。`);
  }
  return { job, stagedPath };
}
```

使用与现有模型同步相同的有界 worker 模式，但并发常量为 2；第一个失败出现后不再领取新任务，并等待已领取任务释放资源。

- [ ] **Step 10: 实现整批原子推广和反向回滚**

推广项包含所有变化文件和最后一个索引文件：

```ts
type PromotionState = {
  targetPath: string;
  stagedPath: string;
  backupPath: string;
  previousMoved: boolean;
  stagedMoved: boolean;
};
```

执行顺序：

```ts
for (const state of states) {
  assertPathInside(editorRoot, state.targetPath, '天空盒推广目标');
  await fs.mkdir(path.dirname(state.targetPath), { recursive: true });
  if (await pathExists(state.targetPath)) {
    await fs.mkdir(path.dirname(state.backupPath), { recursive: true });
    await renamePathWithWindowsRetry(state.targetPath, state.backupPath);
    state.previousMoved = true;
  }
  await renamePathWithWindowsRetry(state.stagedPath, state.targetPath);
  state.stagedMoved = true;
}
```

索引必须最后推广。失败时逆序删除已推广新目标并恢复备份；回滚失败时抛：

```ts
throw new DataPlatformRollbackError(
  `${message}；天空盒库回滚不完整：${rollbackErrors.join('；')}；已保留恢复目录：${backupRoot}`,
);
```

格式互换没有同路径旧目标时，旧扩展名文件不进入 states，因此自然保留。

- [ ] **Step 11: 实现 staging 清理和进度广播**

阶段固定为：

```text
querying → downloading → validating → promoting → completed
                                                   ↘ failed
```

`completed/total` 表示计划下载文件数；元数据零下载时为 `0/0`。广播实现：

```ts
function updateSkyboxSyncProgress(progress: DataPlatformSkyboxSyncProgress): void {
  latestSkyboxSyncProgress = { ...progress };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('data-platform:skyboxSyncProgress', progress);
    }
  }
}
```

成功、取消或可安全失败后，仅当 staging 路径经 `assertPathInside(editorRoot, stagingRoot)` 验证后递归删除；`DataPlatformRollbackError` 保留恢复目录。

- [ ] **Step 12: 运行同步测试并确认通过**

Run:

```powershell
node --experimental-strip-types --test tests/digitalTwin/dataPlatformSkyboxSync.test.ts
```

Expected: 首次、零下载、更新、孤立、格式互换、并发、取消、回滚和重复触发测试全部通过。

- [ ] **Step 13: 提交同步引擎**

```powershell
git add electron/ipc/dataPlatformSkyboxSync.ts electron/ipc/dataPlatformTransfer.ts electron/ipc/skyboxAssetStore.ts tests/digitalTwin/dataPlatformSkyboxSync.test.ts
git commit -m "feat: synchronize data platform skyboxes atomically"
```

---

### Task 4: 接入 IPC、preload、项目打开和应用退出生命周期

**Files:**
- Modify: `electron/types.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/preload.cts`
- Modify: `src/vite-env.d.ts`
- Modify: `electron/ipc/dataPlatformIpc.ts`
- Modify: `electron/ipc/dataPlatformProjectService.ts`
- Modify: `electron/ipc/projectIpc.ts`
- Modify: `electron/ipc/projectAssetStore.ts`
- Modify: `src/editor/home/HomePage.tsx`

- [ ] **Step 1: 先扩展共享类型，运行 typecheck 验证调用方尚未实现**

在 `electron/types.ts` 和 `src/vite-env.d.ts` 同步增加：

```ts
type DataPlatformSkyboxSyncPhase =
  | 'querying'
  | 'downloading'
  | 'validating'
  | 'promoting'
  | 'completed'
  | 'failed';

type DataPlatformSkyboxSyncProgress = {
  runId: string;
  phase: DataPlatformSkyboxSyncPhase;
  completed: number;
  total: number;
  message: string;
  error: string | null;
};
```

`DataPlatformProjectOpenResult` 增加：

```ts
skyboxSyncStarted: boolean;
```

Run:

```powershell
npm run typecheck
```

Expected: preload/API 返回类型或项目打开结果缺少新成员而失败，证明类型扩展已经约束调用链。

- [ ] **Step 2: 在 projectAssetStore 增加独立共享天空盒根状态**

不要复用 `sharedProjectAssetRoot` 强行改变普通本地项目的模型合并行为：

```ts
let sharedProjectSkyboxRoot: string | null = null;

export function setSharedProjectSkyboxRoot(projectRoot: string | null): void {
  sharedProjectSkyboxRoot = projectRoot ? normalizeFilePath(projectRoot) : null;
}

export function getSharedProjectSkyboxRoot(): string | null {
  return sharedProjectSkyboxRoot;
}
```

选择普通项目目录时同时清空 `sharedProjectSkyboxRoot`；手动同步天空盒时只设置该状态，不创建数据中台 binding。

- [ ] **Step 3: 在 dataPlatformProjectService 暴露统一同步入口**

```ts
export async function syncDataPlatformSkyboxesForWorkspace(
  baseUrl: string,
  workspaceRoot: string,
): Promise<boolean> {
  if (dataPlatformProjectServiceShuttingDown) return false;
  const sharedResourcesRoot = resolveDataPlatformSharedResourcesRoot(workspaceRoot);
  await ensureWritableEditorRoot(sharedResourcesRoot);
  await ensureProjectDirectories(sharedResourcesRoot);
  setSharedProjectSkyboxRoot(sharedResourcesRoot);
  return startDataPlatformSkyboxSync(baseUrl, sharedResourcesRoot);
}

export function retryLatestDataPlatformSkyboxSync(): boolean {
  return retryDataPlatformSkyboxSync();
}

export function getCurrentDataPlatformSkyboxSyncProgress(): DataPlatformSkyboxSyncProgress | null {
  return getLatestDataPlatformSkyboxSyncProgress();
}
```

配置变化时调用 `clearDataPlatformSkyboxSyncRetryContext()`；`disposeDataPlatformProjectTasks()` 末尾等待 `disposeDataPlatformSkyboxSync()`。

- [ ] **Step 4: 在数据中台项目打开完成后后台启动天空盒同步**

`openDataPlatformProjectInternal` 在写完 binding 后：

```ts
setSharedProjectSkyboxRoot(sharedResourcesRoot);
const modelSyncStarted = startDataPlatformModelSync(baseUrl, sharedResourcesRoot);
const skyboxSyncStarted = startDataPlatformSkyboxSync(baseUrl, sharedResourcesRoot);
return {
  projectRoot,
  sceneFilePath,
  source,
  warning,
  conflictCopyPath,
  modelSyncStarted,
  skyboxSyncStarted,
  binding,
};
```

不得 `await` 天空盒同步 promise；项目和场景打开不能被网络查询阻塞。

- [ ] **Step 5: 最近数据中台项目恢复 binding 后自动启动天空盒同步**

`project:openRecent` 读取到 binding 后：

```ts
const workspaceRoot = resolveWorkspaceRootFromDataPlatformProject(openRequest.projectRoot, binding.projectId);
const sharedResourcesRoot = resolveDataPlatformSharedResourcesRoot(workspaceRoot);
setSharedProjectAssetRoot(sharedResourcesRoot);
setSharedProjectSkyboxRoot(sharedResourcesRoot);
setCurrentDataPlatformBinding(openRequest.projectRoot, binding);
startDataPlatformSkyboxSync(binding.baseUrl, sharedResourcesRoot);
return listProjectAssets();
```

普通 recent project 没有 binding 时清空当前 binding 和共享天空盒根，不自动联网。

- [ ] **Step 6: 更新首页打开结果和后台同步日志**

`HomePage.tsx` 的局部 `DataPlatformProjectOpenResult` 增加 `skyboxSyncStarted: boolean`。状态提示在模型或天空盒任一任务启动时使用“共享资源同步已开始”，并分别记录：

```tsx
if (result.modelSyncStarted) {
  useEditorStore.getState().pushLog('数据中台全局模型同步已在后台启动。');
}
if (result.skyboxSyncStarted) {
  useEditorStore.getState().pushLog('数据中台全局天空盒同步已在后台启动。');
}
```

- [ ] **Step 7: 注册独立 IPC 通道**

`dataPlatformIpc.ts` 增加：

```ts
ipcMain.handle('data-platform:syncSkyboxes', async (): Promise<boolean> => {
  const config = await readDataPlatformConfig();
  if (!config.baseUrl) throw new Error('尚未配置数据中台地址。');
  return syncDataPlatformSkyboxesForWorkspace(config.baseUrl, config.workspaceRoot);
});

ipcMain.handle('data-platform:retrySkyboxSync', async (): Promise<boolean> => {
  return retryLatestDataPlatformSkyboxSync();
});

ipcMain.handle('data-platform:getSkyboxSyncProgress', async (): Promise<DataPlatformSkyboxSyncProgress | null> => {
  return getCurrentDataPlatformSkyboxSyncProgress();
});
```

进度事件名称固定为 `data-platform:skyboxSyncProgress`。

- [ ] **Step 8: 同步更新 preload.ts 和 preload.cts**

两个文件必须保持逐行同构：

```ts
syncDataPlatformSkyboxes: (): Promise<boolean> => ipcRenderer.invoke('data-platform:syncSkyboxes'),
retryDataPlatformSkyboxSync: (): Promise<boolean> => ipcRenderer.invoke('data-platform:retrySkyboxSync'),
onDataPlatformSkyboxSyncProgress: (handler: (progress: DataPlatformSkyboxSyncProgress) => void): (() => void) => {
  const listener = (_event: IpcRendererEvent, payload: DataPlatformSkyboxSyncProgress) => handler(payload);
  ipcRenderer.on('data-platform:skyboxSyncProgress', listener);
  void ipcRenderer.invoke('data-platform:getSkyboxSyncProgress').then((payload: DataPlatformSkyboxSyncProgress | null) => {
    if (payload) handler(payload);
  });
  return () => ipcRenderer.removeListener('data-platform:skyboxSyncProgress', listener);
},
```

`src/vite-env.d.ts` 的 `window.editorApi` 声明使用相同三个方法。

- [ ] **Step 9: 运行类型检查**

Run:

```powershell
npm run typecheck
```

Expected: TypeScript 通过；`preload.ts`、`preload.cts`、Electron types 和 renderer 声明一致。

- [ ] **Step 10: 提交 IPC 和生命周期接入**

```powershell
git add electron/types.ts electron/preload.ts electron/preload.cts src/vite-env.d.ts electron/ipc/dataPlatformIpc.ts electron/ipc/dataPlatformProjectService.ts electron/ipc/projectIpc.ts electron/ipc/projectAssetStore.ts src/editor/home/HomePage.tsx
git commit -m "feat: wire skybox sync into project lifecycle"
```

---

### Task 5: 以测试驱动合并项目本地与数据中台天空盒资源

**Files:**
- Modify: `electron/types.ts`
- Modify: `src/vite-env.d.ts`
- Modify: `electron/ipc/dataPlatformSkyboxIndex.ts`
- Modify: `electron/ipc/projectAssetStore.ts`
- Modify: `electron/ipc/skyboxAssetStore.ts`
- Modify: `src/editor/assets/AssetDatabase.ts`
- Modify: `src/editor/assets/projectLibrary.ts`
- Modify: `tests/digitalTwin/projectLibraryTabs.test.ts`
- Modify: `tests/dataPlatform/skyboxIndex.test.ts`

- [ ] **Step 1: 写数据中台资产转换和合并失败测试**

```ts
it('active 索引项转换为带来源元数据的可选天空盒', async () => {
  const assets = await listIndexedDataPlatformSkyboxes(root, indexWithEntry(activeEntry('123')));
  assert.equal(assets.active[0].source, 'data-platform');
  assert.equal(assets.active[0].dataPlatformResourceId, '123');
  assert.equal(assets.active[0].dataPlatformRevision, '3');
  assert.equal(assets.active[0].fileSha256, 'a'.repeat(64));
  assert.equal(assets.active[0].availability, 'active');
});

it('本地与数据中台同名资源都保留，本地排在前面', () => {
  const result = mergeSkyboxAssets(
    [localSkybox({ displayName: 'Studio' })],
    [dataPlatformSkybox({ displayName: 'Studio', dataPlatformResourceId: '123' })],
  );
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((asset) => asset.source), ['project', 'data-platform']);
});
```

再断言：数据中台按资源 ID 去重；同名不覆盖；orphaned 不进入 active 卡片；orphaned 文件存在时进入兼容集合；损坏/缺失 active 文件不暴露卡片且返回可诊断错误。该测试文件内定义最小资产 builder：

```ts
function localSkybox(overrides: Partial<ProjectSkyboxAssetEntry> = {}): ProjectSkyboxAssetEntry {
  const filePath = overrides.path ?? 'D:/Project/Assets/Skyboxes/Studio/studio.hdr';
  return {
    id: filePath,
    name: 'studio.hdr',
    displayName: 'Studio',
    path: filePath,
    sourceUrl: `editor-asset://local/${encodeURIComponent(filePath)}`,
    assetRevision: 'local-revision',
    packagePath: path.dirname(filePath),
    kind: 'skybox',
    libraryKind: 'skybox',
    format: 'hdr',
    fileSizeBytes: 1024,
    source: 'project',
    availability: 'active',
    ...overrides,
  };
}

function dataPlatformSkybox(overrides: Partial<ProjectSkyboxAssetEntry> = {}): ProjectSkyboxAssetEntry {
  const asset = localSkybox(overrides);
  return {
    ...asset,
    id: overrides.id ?? 'data-platform-skybox:123',
    source: 'data-platform',
    dataPlatformResourceId: overrides.dataPlatformResourceId ?? '123',
    dataPlatformRevision: overrides.dataPlatformRevision ?? '1',
    fileSha256: overrides.fileSha256 ?? 'a'.repeat(64),
  };
}
```

- [ ] **Step 2: 修改现有资源库结构测试**

在 `projectLibraryTabs.test.ts` 增加静态断言：

```ts
assert.ok(source.includes("asset.source === 'data-platform' ? '数据中台' : '项目本地'"));
assert.ok(source.includes('同步数据中台天空盒'));
assert.ok(source.includes('orphanedSkyboxes'));
```

- [ ] **Step 3: 运行相关测试并确认失败**

Run:

```powershell
node --experimental-strip-types --test tests/dataPlatform/skyboxIndex.test.ts tests/digitalTwin/projectLibraryTabs.test.ts
```

Expected: 来源字段、合并函数和 UI 文案尚不存在导致失败。

- [ ] **Step 4: 扩展 ProjectSkyboxAssetEntry 和列表结果类型**

在 `electron/types.ts`、`src/vite-env.d.ts`、`src/editor/assets/AssetDatabase.ts` 保持一致：

```ts
export type ProjectSkyboxAssetEntry = {
  id: string;
  name: string;
  displayName: string;
  path: string;
  sourceUrl: string;
  assetRevision: string;
  packagePath: string;
  kind: 'skybox';
  libraryKind: 'skybox';
  format: SkyboxAssetFormat;
  fileSizeBytes: number;
  source: 'project' | 'data-platform';
  availability: 'active' | 'orphaned';
  dataPlatformResourceId?: string;
  dataPlatformRevision?: string;
  fileSha256?: string;
};
```

`ProjectListAssetsResult` 增加：

```ts
orphanedSkyboxes: ProjectSkyboxAssetEntry[];
```

没有当前项目时的返回值同步改为 `{ projectRoot: null, assets: [], skyboxes: [], orphanedSkyboxes: [] }`。

- [ ] **Step 5: 给项目本地天空盒显式标注来源**

`skyboxAssetStore.createSkyboxAsset` 返回值增加：

```ts
source: 'project',
availability: 'active',
```

拖拽解码器接受旧 payload 缺少这两个字段时回退为项目本地 active；数据中台 payload 必须带合法正整数 ID、revision、SHA 和 `availability: 'active'`，orphaned payload 一律拒绝。

- [ ] **Step 6: 从共享索引转换 active/orphaned 资产**

`dataPlatformSkyboxIndex.ts` 增加：

```ts
export async function listIndexedDataPlatformSkyboxes(
  editorRoot: string,
  index = await readDataPlatformSkyboxIndex(editorRoot),
): Promise<{ active: ProjectSkyboxAssetEntry[]; orphaned: ProjectSkyboxAssetEntry[] }> {
  const active: ProjectSkyboxAssetEntry[] = [];
  const orphaned: ProjectSkyboxAssetEntry[] = [];
  for (const entry of index.entries) {
    const filePath = resolveSkyboxIndexEntryPath(editorRoot, entry.relativePath);
    const inspection = await inspectSkyboxAssetFile(filePath).catch(() => null);
    if (!inspection || inspection.format !== entry.format || inspection.fileSizeBytes !== entry.fileSizeBytes) continue;
    const asset: ProjectSkyboxAssetEntry = {
      id: `data-platform-skybox:${entry.resourceId}`,
      name: path.basename(filePath),
      displayName: entry.displayName,
      path: filePath,
      sourceUrl: encodeAssetUrl(filePath),
      assetRevision: entry.sha256,
      packagePath: path.dirname(filePath),
      kind: 'skybox',
      libraryKind: 'skybox',
      format: entry.format,
      fileSizeBytes: entry.fileSizeBytes,
      source: 'data-platform',
      availability: entry.status,
      dataPlatformResourceId: entry.resourceId,
      dataPlatformRevision: entry.revision,
      fileSha256: entry.sha256,
    };
    (entry.status === 'active' ? active : orphaned).push(asset);
  }
  return { active, orphaned };
}
```

- [ ] **Step 7: 合并资源并授权兼容文件**

`listProjectAssets()` 调整为：

```ts
const localSkyboxes = await listSkyboxAssetsInRoot(getProjectSkyboxesRoot(projectRoot));
let activeSharedSkyboxes: ProjectSkyboxAssetEntry[] = [];
let orphanedSkyboxes: ProjectSkyboxAssetEntry[] = [];
if (sharedProjectSkyboxRoot) {
  const indexed = await listIndexedDataPlatformSkyboxes(sharedProjectSkyboxRoot);
  activeSharedSkyboxes = indexed.active;
  orphanedSkyboxes = indexed.orphaned;
}
const skyboxes = mergeSkyboxAssets(localSkyboxes, activeSharedSkyboxes);
for (const skybox of [...skyboxes, ...orphanedSkyboxes]) authorizeAssetFile(skybox.path);
return { projectRoot, assets, skyboxes, orphanedSkyboxes };
```

`mergeSkyboxAssets` 对数据中台按 `dataPlatformResourceId` 去重，不按名称去重；排序为名称、项目本地优先、稳定 ID。

- [ ] **Step 8: 在资源卡片副标题展示来源**

```ts
const sourceLabel = asset.source === 'data-platform' ? '数据中台' : '项目本地';
subtitle: `${sourceLabel} · ${asset.format.toUpperCase()} · ${formatSkyboxFileSize(asset.fileSizeBytes)}`,
```

`orphanedSkyboxes` 不传给 `createSkyboxLibraryItems`，因此不能被新拖拽或选择。

- [ ] **Step 9: 重新运行测试和 typecheck**

Run:

```powershell
node --experimental-strip-types --test tests/dataPlatform/skyboxIndex.test.ts tests/digitalTwin/projectLibraryTabs.test.ts
npm run typecheck
```

Expected: 合并、来源、孤立过滤和类型检查通过。

- [ ] **Step 10: 提交资源合并**

```powershell
git add electron/types.ts src/vite-env.d.ts electron/ipc/dataPlatformSkyboxIndex.ts electron/ipc/projectAssetStore.ts electron/ipc/skyboxAssetStore.ts src/editor/assets/AssetDatabase.ts src/editor/assets/projectLibrary.ts tests/dataPlatform/skyboxIndex.test.ts tests/digitalTwin/projectLibraryTabs.test.ts
git commit -m "feat: merge local and synced skybox assets"
```

---

### Task 6: 以测试驱动增加稳定资源 ID、序列化和重关联顺序

**Files:**
- Modify: `src/editor/model/SceneDocument.ts`
- Modify: `src/editor/model/components.ts`
- Modify: `src/editor/project/SceneSerializer.ts`
- Modify: `src/editor/assets/skyboxAssets.ts`
- Create: `tests/dataPlatform/skyboxRelink.test.ts`
- Modify: `tests/telemetry/skyboxSettings.test.ts`

- [ ] **Step 1: 写稳定 ID 优先匹配失败测试**

```ts
it('存在 dataPlatformResourceId 时优先按稳定 ID 匹配', () => {
  const settings = sceneSkybox({
    dataPlatformResourceId: '123',
    sourcePath: 'D:/old/skybox.hdr',
    sourceUrl: localAssetUrl('D:/old/skybox.hdr'),
  });
  const expected = dataPlatformSkybox({ dataPlatformResourceId: '123', path: 'D:/new/skybox.hdr' });
  const wrongPathMatch = localSkybox({ path: 'D:/old/skybox.hdr' });
  assert.equal(findSkyboxAssetForSettings(settings, [wrongPathMatch, expected]), expected);
});

it('稳定 ID 出现多个候选时拒绝猜测', () => {
  const settings = sceneSkybox({ dataPlatformResourceId: '123' });
  assert.equal(findSkyboxAssetForSettings(settings, [
    dataPlatformSkybox({ id: 'a', dataPlatformResourceId: '123' }),
    dataPlatformSkybox({ id: 'b', dataPlatformResourceId: '123' }),
  ]), null);
});
```

再覆盖无 ID 的精确路径匹配、包目录 + 主文件名兼容匹配、多个旧候选拒绝猜测、选择本地资源清除数据中台 ID、选择数据中台资源写入 ID，以及远端仅改名且 SHA/路径不变时生成的场景设置与当前设置完全相同。测试 builder 使用：

```ts
function localAssetUrl(filePath: string): string {
  return `editor-asset://local/${encodeURIComponent(filePath)}`;
}

function sceneSkybox(overrides: Partial<SceneSkyboxSettings> = {}): SceneSkyboxSettings {
  const sourcePath = overrides.sourcePath ?? 'D:/Skyboxes/studio.hdr';
  return {
    packagePath: 'D:/Skyboxes',
    sourcePath,
    sourceUrl: overrides.sourceUrl ?? localAssetUrl(sourcePath),
    assetRevision: 'a'.repeat(64),
    format: 'hdr',
    rotationDegrees: 30,
    intensity: 0.65,
    resolution: 1024,
    ...overrides,
  };
}

function dataPlatformSkybox(
  overrides: Partial<ProjectSkyboxAssetEntry> = {},
): ProjectSkyboxAssetEntry {
  const filePath = overrides.path ?? 'D:/Shared/Assets/Skyboxes/DataPlatform/Skybox-123/skybox.hdr';
  return {
    id: 'data-platform-skybox:123',
    name: 'skybox.hdr',
    displayName: 'Studio',
    path: filePath,
    sourceUrl: localAssetUrl(filePath),
    assetRevision: 'a'.repeat(64),
    packagePath: path.dirname(filePath),
    kind: 'skybox',
    libraryKind: 'skybox',
    format: 'hdr',
    fileSizeBytes: 1024,
    source: 'data-platform',
    availability: 'active',
    dataPlatformResourceId: '123',
    dataPlatformRevision: '1',
    fileSha256: 'a'.repeat(64),
    ...overrides,
  };
}

function localSkybox(overrides: Partial<ProjectSkyboxAssetEntry> = {}): ProjectSkyboxAssetEntry {
  const asset = dataPlatformSkybox(overrides);
  return {
    ...asset,
    id: overrides.id ?? asset.path,
    source: 'project',
    availability: 'active',
    dataPlatformResourceId: undefined,
    dataPlatformRevision: undefined,
    fileSha256: undefined,
  };
}
```

- [ ] **Step 2: 写场景序列化和 sanitization 失败测试**

在 `skyboxSettings.test.ts` 增加：

```ts
assert.equal(parsed.scene.entities[skyboxEntityId].components.skybox.dataPlatformResourceId, '2052912068767571969');
assert.equal(loaded.entities[skyboxEntityId].components.skybox?.dataPlatformResourceId, '2052912068767571969');
```

并断言空字符串、0、负数、指数形式和超过 64 位的 ID 被拒绝；没有该字段的旧 v1/v2/v3 场景仍能加载，不提高场景文件版本。

- [ ] **Step 3: 运行测试并确认失败**

Run:

```powershell
node --experimental-strip-types --test tests/dataPlatform/skyboxRelink.test.ts tests/telemetry/skyboxSettings.test.ts
```

Expected: 场景和资产类型尚无稳定 ID，测试失败。

- [ ] **Step 4: 扩展场景设置和实体组件**

```ts
export type SceneSkyboxSettings = {
  packagePath: string;
  sourcePath: string;
  sourceUrl: string;
  assetRevision?: string;
  dataPlatformResourceId?: string;
  format: SceneSkyboxFormat;
  rotationDegrees: number;
  intensity: number;
  resolution: SceneSkyboxResolution;
};
```

`SkyboxComponent` 增加相同可选字段。`sanitizeSceneSkybox` 使用：

```ts
const dataPlatformResourceId = skybox.dataPlatformResourceId?.trim();
if (dataPlatformResourceId && !/^[1-9]\d{0,63}$/.test(dataPlatformResourceId)) return null;
```

返回对象仅在合法且存在时保留该字段；`createSkyboxComponent`、`createSceneSkyboxSettingsFromEntity` 和旧 sceneSettings 迁移链都原样传递。

- [ ] **Step 5: 更新 SceneSerializer，不提高 version**

在 `normalizeSceneSkyboxSettings` 和 `normalizeSkyboxComponent` 传入：

```ts
...(skybox.dataPlatformResourceId === undefined
  ? {}
  : { dataPlatformResourceId: assertString(skybox.dataPlatformResourceId) }),
```

保存仍使用：

```ts
return JSON.stringify({ version: 3, units: { length: SCENE_LENGTH_UNIT }, scene }, null, 2);
```

- [ ] **Step 6: 让资源选择写入或清除稳定 ID**

`createSceneSkyboxFromAsset` 增加；`assetRevision` 来自 SHA-256，因此仅改名或仅 revision 变化不会改写场景或重载纹理：

```ts
...(asset.source === 'data-platform' && asset.dataPlatformResourceId
  ? { dataPlatformResourceId: asset.dataPlatformResourceId }
  : {}),
```

不要从 `current` 继承旧 ID；这样用户从数据中台切换到项目本地资源时会主动清除 ID。rotation、intensity 和 resolution 继续从 `current` 保留。

- [ ] **Step 7: 实现重关联顺序**

```ts
export function findSkyboxAssetForSettings(
  skybox: SceneSkyboxSettings,
  assets: ProjectSkyboxAssetEntry[],
): ProjectSkyboxAssetEntry | null {
  if (skybox.dataPlatformResourceId) {
    const idCandidates = assets.filter((asset) =>
      asset.source === 'data-platform'
      && asset.dataPlatformResourceId === skybox.dataPlatformResourceId,
    );
    return idCandidates.length === 1 ? idCandidates[0] : null;
  }

  const sourcePathKey = normalizePortablePath(skybox.sourcePath);
  const exactCandidates = assets.filter((asset) =>
    normalizePortablePath(asset.path) === sourcePathKey || asset.sourceUrl === skybox.sourceUrl,
  );
  if (exactCandidates.length === 1) return exactCandidates[0];
  if (exactCandidates.length > 1) return null;

  const portableKey = createPortableSkyboxKey(skybox.packagePath, skybox.sourcePath);
  const portableCandidates = assets.filter((asset) =>
    createPortableSkyboxKey(asset.packagePath, asset.path) === portableKey,
  );
  return portableCandidates.length === 1 ? portableCandidates[0] : null;
}
```

- [ ] **Step 8: 重新运行重关联和场景测试**

Run:

```powershell
node --experimental-strip-types --test tests/dataPlatform/skyboxRelink.test.ts tests/telemetry/skyboxSettings.test.ts
npm run typecheck
```

Expected: 稳定 ID 优先、旧场景兼容、类型检查和 v3 序列化全部通过。

- [ ] **Step 9: 提交场景稳定 ID**

```powershell
git add src/editor/model/SceneDocument.ts src/editor/model/components.ts src/editor/project/SceneSerializer.ts src/editor/assets/skyboxAssets.ts tests/dataPlatform/skyboxRelink.test.ts tests/telemetry/skyboxSettings.test.ts
git commit -m "feat: persist stable skybox resource identity"
```

---

### Task 7: 在现有天空盒 Tab 中加入同步状态、手动同步、重试和孤立警告

**Files:**
- Modify: `src/editor/panels/ProjectPanel.tsx`
- Modify: `src/editor/panels/SceneSettingsPanel.tsx`
- Modify: `src/editor/assets/skyboxAssets.ts`
- Modify: `tests/dataPlatform/skyboxRelink.test.ts`
- Modify: `tests/digitalTwin/projectLibraryTabs.test.ts`

- [ ] **Step 1: 写孤立资源判断失败测试**

```ts
it('按稳定 ID 找到当前场景的 orphaned 兼容记录', () => {
  const settings = sceneSkybox({ dataPlatformResourceId: '123' });
  const orphaned = dataPlatformSkybox({
    dataPlatformResourceId: '123',
    availability: 'orphaned',
  });
  assert.equal(findOrphanedSkyboxForSettings(settings, [orphaned]), orphaned);
});
```

多个 orphaned 候选时返回 null；没有稳定 ID 的旧本地场景不按名称猜测为孤立资源。

- [ ] **Step 2: 扩展 ProjectPanel 结构测试**

`projectLibraryTabs.test.ts` 增加：

```ts
assert.ok(source.includes('onDataPlatformSkyboxSyncProgress'));
assert.ok(source.includes('syncDataPlatformSkyboxes'));
assert.ok(source.includes('retryDataPlatformSkyboxSync'));
assert.ok(source.includes('同步数据中台天空盒'));
assert.ok(source.includes('资源已从数据中台删除'));
assert.ok(!source.includes('syncDataPlatformSkyboxesAfterLocalSceneLoad'));
```

最后一项锁定普通本地场景不会自动联网。

- [ ] **Step 3: 运行测试并确认失败**

Run:

```powershell
node --experimental-strip-types --test tests/dataPlatform/skyboxRelink.test.ts tests/digitalTwin/projectLibraryTabs.test.ts
```

Expected: 孤立判断和 UI 同步入口尚不存在导致失败。

- [ ] **Step 4: 实现孤立资源判断**

```ts
export function findOrphanedSkyboxForSettings(
  skybox: SceneSkyboxSettings | null,
  orphanedAssets: ProjectSkyboxAssetEntry[],
): ProjectSkyboxAssetEntry | null {
  if (!skybox?.dataPlatformResourceId) return null;
  const candidates = orphanedAssets.filter((asset) =>
    asset.source === 'data-platform'
    && asset.availability === 'orphaned'
    && asset.dataPlatformResourceId === skybox.dataPlatformResourceId,
  );
  return candidates.length === 1 ? candidates[0] : null;
}
```

- [ ] **Step 5: 在 ProjectPanel 定义 API 边界并保存同步和孤立状态**

沿用现有模型/图片同步的局部 API 适配模式：

```tsx
type DataPlatformSkyboxSyncApi = {
  syncDataPlatformSkyboxes?: () => Promise<boolean>;
  retryDataPlatformSkyboxSync?: () => Promise<boolean>;
  onDataPlatformSkyboxSyncProgress?: (
    listener: (progress: DataPlatformSkyboxSyncProgress) => void,
  ) => () => void;
};

function getDataPlatformSkyboxSyncApi(): DataPlatformSkyboxSyncApi {
  return (window.editorApi ?? {}) as DataPlatformSkyboxSyncApi;
}

const DATA_PLATFORM_SKYBOX_SYNC_PHASE_LABELS: Record<DataPlatformSkyboxSyncProgress['phase'], string> = {
  querying: '查询天空盒',
  downloading: '下载天空盒',
  validating: '校验天空盒',
  promoting: '写入天空盒库',
  completed: '同步完成',
  failed: '同步失败',
};

const [skyboxSyncProgress, setSkyboxSyncProgress] = useState<DataPlatformSkyboxSyncProgress | null>(null);
const [isStartingSkyboxSync, setIsStartingSkyboxSync] = useState(false);
const [isRetryingSkyboxSync, setIsRetryingSkyboxSync] = useState(false);
const [orphanedSkyboxes, setOrphanedSkyboxes] = useState<ProjectSkyboxAssetEntry[]>([]);
```

`loadProjectAssets` 成功时：

```tsx
setSkyboxAssets(result.skyboxes);
setOrphanedSkyboxes(result.orphanedSkyboxes ?? []);
if (refreshSceneAssets) refreshCurrentSkyboxFromAssets(result.skyboxes);
```

现有 `updateSkyboxConfig` 走命令系统、撤销历史和 dirty 标记；不要直接修改 store scene 对象。由于 `createSceneSkyboxFromAsset` 从当前设置保留显示参数，远端替换会保留 rotation、intensity、resolution 和天空盒实体 Transform。

- [ ] **Step 6: 订阅同步进度并在完成时刷新资产**

```tsx
useEffect(() => {
  const api = getDataPlatformSkyboxSyncApi();
  if (!api.onDataPlatformSkyboxSyncProgress) return undefined;
  return api.onDataPlatformSkyboxSyncProgress((progress) => {
    setSkyboxSyncProgress(progress);
    if (progress.phase === 'completed') void loadProjectAssets(true);
  });
}, [loadProjectAssets]);
```

失败保留旧资源列表，只更新状态卡；completed 后的 `loadProjectAssets(true)` 才触发稳定 ID 重关联和纹理更新。

- [ ] **Step 7: 实现手动同步和失败重试**

```tsx
function createLocalSkyboxSyncFailure(error: unknown): DataPlatformSkyboxSyncProgress {
  const message = error instanceof Error ? error.message : String(error);
  return {
    runId: `renderer-skybox-sync-${Date.now()}`,
    phase: 'failed',
    completed: 0,
    total: 0,
    message: '天空盒同步失败',
    error: message,
  };
}

const handleSyncDataPlatformSkyboxes = async () => {
  const api = getDataPlatformSkyboxSyncApi();
  if (!api.syncDataPlatformSkyboxes) return;
  setIsStartingSkyboxSync(true);
  try {
    const started = await api.syncDataPlatformSkyboxes();
    if (!started) throw new Error('天空盒同步未启动');
  } catch (error) {
    setSkyboxSyncProgress(createLocalSkyboxSyncFailure(error));
  } finally {
    setIsStartingSkyboxSync(false);
  }
};

const handleRetryDataPlatformSkyboxSync = async () => {
  const api = getDataPlatformSkyboxSyncApi();
  if (!api.retryDataPlatformSkyboxSync) return;
  setIsRetryingSkyboxSync(true);
  try {
    const started = await api.retryDataPlatformSkyboxSync();
    if (!started) throw new Error('没有可重试的天空盒同步任务');
  } finally {
    setIsRetryingSkyboxSync(false);
  }
};
```

天空盒 Tab 工具栏显示“同步数据中台天空盒”；任务 active 时禁用重复点击。失败状态显示“重试同步”和“关闭”。

- [ ] **Step 8: 渲染进度和孤立警告**

只在 `activeLibrary.key === 'skybox'` 时渲染天空盒同步卡。阶段文案：查询天空盒、下载天空盒、校验天空盒、写入天空盒库、同步完成、同步失败。

```tsx
const orphanedCurrentSkybox = findOrphanedSkyboxForSettings(currentSkybox, orphanedSkyboxes);
```

存在时显示：

```tsx
<div className="library-sync-status library-sync-status-warning" role="status">
  <strong>资源已从数据中台删除</strong>
  <p>“{orphanedCurrentSkybox.displayName}”（ID {orphanedCurrentSkybox.dataPlatformResourceId}）继续使用本地兼容缓存，但不能用于新场景。</p>
</div>
```

不把 orphaned 记录传给卡片列表或拖拽入口。

- [ ] **Step 9: 让 SceneSettingsPanel 使用合并后的 active 列表**

保留现有 `listProjectAssets()` 调用并读取 `result.skyboxes`；卡片副标题已经由 `createSkyboxLibraryItems` 显示来源。不要把 `result.orphanedSkyboxes` 加入选择列表。

- [ ] **Step 10: 运行 UI 结构测试和 typecheck**

Run:

```powershell
node --experimental-strip-types --test tests/dataPlatform/skyboxRelink.test.ts tests/digitalTwin/projectLibraryTabs.test.ts
npm run typecheck
```

Expected: 手动同步、重试、完成刷新、孤立警告和“不自动同步本地场景”断言通过。

- [ ] **Step 11: 提交天空盒 Tab 同步交互**

```powershell
git add src/editor/panels/ProjectPanel.tsx src/editor/panels/SceneSettingsPanel.tsx src/editor/assets/skyboxAssets.ts tests/dataPlatform/skyboxRelink.test.ts tests/digitalTwin/projectLibraryTabs.test.ts
git commit -m "feat: add skybox sync controls and status"
```

---

### Task 8: 以测试驱动补齐发布预检、孤立警告和离线打包

**Files:**
- Modify: `electron/ipc/deploymentExportScene.ts`
- Modify: `tests/digitalTwin/digitalTwinPublish.integration.mjs`

- [ ] **Step 1: 写发布集成失败测试**

在发布集成夹具中准备两个数据中台天空盒，但场景只引用一个：

```js
const referencedSkybox = await seedDataPlatformSkybox(sharedRoot, {
  resourceId: '123',
  displayName: '发布天空盒',
  status: 'active',
});
await seedDataPlatformSkybox(sharedRoot, {
  resourceId: '456',
  displayName: '未引用天空盒',
  status: 'active',
});
scene.scene.entities.skybox.components.skybox = {
  packagePath: referencedSkybox.packagePath,
  sourcePath: referencedSkybox.path,
  sourceUrl: referencedSkybox.sourceUrl,
  assetRevision: referencedSkybox.assetRevision,
  dataPlatformResourceId: '123',
  format: 'hdr',
  intensity: 1,
  resolution: 512,
};
```

断言发布包只包含资源 123 的 HDR/EXR，重写后的 `sourceUrl` 为包内 URL，Viewer 不需要数据中台地址，`dataPlatformResourceId` 可保留。

- [ ] **Step 2: 写孤立缓存与缓存缺失失败测试**

```js
assert.match(result.warnings.join('\n'), /已从数据中台删除/);
assert.match(result.warnings.join('\n'), /ID 123/);
```

删除孤立资源本地文件后再次发布：

```js
await assert.rejects(
  exportScene(),
  /数据中台天空盒“已删除天空盒”（ID 123）兼容缓存缺失/,
);
```

- [ ] **Step 3: 运行发布集成并确认失败**

Run:

```powershell
npm run test:digital-twin:integration
```

Expected: 当前发布链路没有读取数据中台天空盒索引，孤立警告或明确缺失错误断言失败。

- [ ] **Step 4: 把共享天空盒索引加入发布上下文**

`ProjectAssetContext` 增加：

```ts
dataPlatformSkyboxRoot: string | null;
dataPlatformSkyboxesById: Map<string, DataPlatformSkyboxIndexEntry>;
```

`loadProjectAssetContext` 通过 `getSharedProjectSkyboxRoot()` 获取独立天空盒共享根，而不是只依赖数据中台 binding；这样普通本地项目手动同步并选用数据中台天空盒后也能识别孤立状态。共享根存在时先用 `assertSafeDirectory` 校验，再读取 `data-platform-skybox-index.json`；不存在时使用空 Map。索引读取失败必须使发布预检失败，不能忽略损坏索引。

- [ ] **Step 5: 在解析天空盒时识别稳定 ID 和 orphaned 状态**

把 `warnings` 传入 `resolveSkyboxReference`：

```ts
const resourceId = normalizeOptionalDataPlatformResourceId(reference.skybox.dataPlatformResourceId);
const indexed = resourceId ? projectContext?.dataPlatformSkyboxesById.get(resourceId) : undefined;
if (indexed?.status === 'orphaned') {
  warnings.push(`数据中台天空盒“${indexed.displayName}”（ID ${indexed.resourceId}）已删除，发布包将使用本地兼容缓存。`);
}
```

稳定 ID 只接受 `/^[1-9]\d{0,63}$/`；字段存在但非法时发布失败。

- [ ] **Step 6: 缓存缺失时给出完整上下文**

在 `resolveLocalAssetPath` 或授权检查失败时包裹错误：

```ts
try {
  const sourcePath = resolveLocalAssetPath(reference.skybox.sourcePath, reference.skybox.sourceUrl, '天空盒资源');
  await assertReadableFile(sourcePath, '天空盒资源');
  return await resolveValidatedSkyboxReference(reference, sourcePath, projectContext, bundles);
} catch (error) {
  if (resourceId && indexed) {
    throw new Error(
      `数据中台天空盒“${indexed.displayName}”（ID ${resourceId}）兼容缓存缺失：${toErrorMessage(error)}`,
    );
  }
  throw error;
}
```

已有正常资源继续按场景实际引用收集，不能把整个共享天空盒目录加入 bundle。

- [ ] **Step 7: 保留来源元数据但运行时不依赖**

`rewriteSkyboxReferences` 只重写 `packagePath/sourcePath/sourceUrl`，不删除 `dataPlatformResourceId`。发布后的 URL 指向包内 `editor-asset://deployment/assets/skyboxes/Skybox-123/skybox.hdr`，Viewer 不发数据中台请求。

- [ ] **Step 8: 重新运行发布测试**

Run:

```powershell
npm run test:digital-twin:integration
```

Expected: 只打包引用资源；孤立有缓存可发布并警告；缓存缺失明确失败。

- [ ] **Step 9: 提交发布兼容**

```powershell
git add electron/ipc/deploymentExportScene.ts tests/digitalTwin/digitalTwinPublish.integration.mjs
git commit -m "feat: publish synced skyboxes from local cache"
```

---

### Task 9: 添加 Electron 真实链路冒烟测试和 package scripts

**Files:**
- Create: `scripts/smoke-data-platform-skybox.mjs`
- Modify: `package.json`

- [ ] **Step 1: 创建最小合法 HDR 和数据中台 HTTP 夹具**

脚本复用 `scripts/smoke-data-platform-project.mjs` 的 Playwright Electron、临时 storage root 和本地 HTTP server 模式。HDR 构造：

```js
function createValidHdr(width = 8, height = 2, fill = 1) {
  const header = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, 'ascii');
  return Buffer.concat([header, Buffer.alloc(width * height * 4, fill)]);
}
```

HTTP server 固定提供：

```js
if (request.url === '/api/v1/skyboxes/query') {
  return sendJson(response, {
    success: true,
    code: 'OK',
    message: '操作成功',
    data: {
      records: remoteSkyboxes.map(toWireSkybox),
      total: String(remoteSkyboxes.length),
      pageNum: '1',
      pageSize: '100',
    },
  });
}
```

文件下载路由按 `fileUrl` 返回当前 bytes，并设置 `Content-Length`。

- [ ] **Step 2: 启动隔离 Electron 应用并打开数据中台项目**

```js
const electronApp = await electron.launch({
  args: [workspaceRoot, `--user-data-dir=${userDataRoot}`],
  cwd: workspaceRoot,
  env: {
    ...process.env,
    OPEN_DEVTOOLS: 'false',
    VITE_DEV_SERVER_URL: '',
    ZENDING_EDITOR_STORAGE_ROOT: storageRoot,
    ZENDING_ALLOW_STORAGE_ROOT_OVERRIDE: '1',
  },
});
const window = await electronApp.firstWindow();
```

通过现有数据中台配置/项目打开 UI 设置本地 server URL 并打开夹具项目；天空盒查询响应延迟 1 秒，断言项目/场景在同步完成前已经可操作，证明同步不阻塞打开。

- [ ] **Step 3: 验证首次同步、来源卡片和零下载**

断言：

```js
await expect(window.getByText('数据中台 · HDR')).toBeVisible();
assert.equal(fileDownloadCounts.get('/files/skybox-123.hdr'), 1);
const index = JSON.parse(await readFile(path.join(sharedRoot, '.babylon-editor', 'data-platform-skybox-index.json'), 'utf8'));
assert.equal(index.entries[0].resourceId, '123');
assert.equal(index.entries[0].status, 'active');
```

点击“同步数据中台天空盒”再次同步，断言下载计数仍为 1。

- [ ] **Step 4: 验证远端替换自动刷新且保留场景参数**

先选择资源并设置非默认 rotation、intensity、resolution 和实体 Transform；随后把 server 中同 ID 资源替换为新 bytes、新 SHA、revision `2`，再次同步。断言：

```js
assert.equal(fileDownloadCounts.get('/files/skybox-123.hdr'), 2);
assert.equal(await readSceneValue('dataPlatformResourceId'), '123');
assert.equal(await readSceneValue('intensity'), 0.65);
assert.equal(await readSceneValue('resolution'), 1024);
```

并断言场景进入未保存状态，撤销一次可恢复同步前的天空盒引用。

- [ ] **Step 5: 验证远端删除隐藏卡片但保留兼容运行**

把 `remoteSkyboxes` 设为空并手动同步；断言数据中台卡片消失、出现“资源已从数据中台删除”警告、场景仍渲染天空盒，本地 HDR 文件仍存在，索引状态为 `orphaned`。

- [ ] **Step 6: 验证失败重试和旧库不变**

提供错误 SHA 触发失败；断言出现“重试同步”，旧 active/orphaned 索引内容不变。恢复正确响应后点击重试，断言进入 completed。

- [ ] **Step 7: 在 finally 中只清理由脚本创建的资源**

```js
finally {
  await electronApp?.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  await rm(testRoot, { recursive: true, force: true });
}
```

不得终止系统全部 Electron、Node 或浏览器进程。

- [ ] **Step 8: 增加 package scripts**

```json
"test:data-platform-skybox": "node --experimental-strip-types --test tests/dataPlatform/skyboxContract.test.ts tests/dataPlatform/skyboxIndex.test.ts tests/dataPlatform/skyboxRelink.test.ts tests/digitalTwin/dataPlatformSkyboxSync.test.ts",
"smoke:data-platform-skybox": "npm run build && node scripts/smoke-data-platform-skybox.mjs"
```

把现有 `smoke:data-platform` 末尾追加 `&& npm run smoke:data-platform-skybox`，保留原项目冒烟测试。

- [ ] **Step 9: 运行真实链路冒烟**

Run:

```powershell
npm run smoke:data-platform-skybox
```

Expected: 进程退出码 0；首次、零下载、替换、删除、失败重试全部通过；临时目录和 Electron 进程已清理。

- [ ] **Step 10: 提交冒烟测试**

```powershell
git add scripts/smoke-data-platform-skybox.mjs package.json
git commit -m "test: cover data platform skybox workflow"
```

---

### Task 10: 更新文档并执行完整相关验证

**Files:**
- Modify: `README.md`
- Review: all files changed by Tasks 1–9

- [ ] **Step 1: 更新 README 用户行为说明**

加入：

```markdown
### 数据中台天空盒同步

- 打开数据中台项目、数据中台深链或带有效数据中台 binding 的最近项目时，编辑器后台同步全局 HDR/EXR 天空盒，不阻塞项目和场景进入。
- 天空盒 Tab 同时显示“项目本地”和“数据中台”资源，并提供手动同步和失败重试；普通本地项目不会自动联网。
- 同步按稳定资源 ID、revision 和 SHA-256 增量下载，单文件上限 512 MiB、单次累计下载上限 8 GiB、并发 2；整批提交失败时旧资源库保持不变。
- 数据中台替换文件后，已有场景跟随最新资源并保留旋转、亮度、解析度和实体 Transform。
- 数据中台删除资源后，新选择列表隐藏该资源，但已有场景继续使用本地兼容缓存并显示警告；本期不自动清理孤立缓存。
- 发布只打包场景实际引用的天空盒；孤立缓存存在时允许发布并警告，缓存缺失时发布预检失败。
```

- [ ] **Step 2: 运行纯单元测试**

Run:

```powershell
npm run test:data-platform-skybox
npm run test:data-platform-relink
npm run test:digital-twin:unit
npm run test:telemetry
```

Expected: 契约、索引、重关联、同步、项目资源库和天空盒序列化测试全部通过。

- [ ] **Step 3: 运行 Electron/发布集成测试**

Run:

```powershell
npm run test:digital-twin:integration
npm run smoke:data-platform-skybox
```

Expected: 发布和真实 Electron 同步链路通过；没有残留进程或临时目录。

- [ ] **Step 4: 运行类型检查和生产构建**

Run:

```powershell
npm run typecheck
npm run build
```

Expected: renderer、Viewer 和 Electron 构建全部成功；preload 两份实现与类型声明一致。

- [ ] **Step 5: 按技能做专项审查**

实施者依次使用：

```text
code-reviewer
security-reviewer
frontend-dev-assistant
e2e-runner
```

审查重点：远端 URL 同源限制、路径越界、符号链接、下载/分页/并发上限、流式 hash、原子回滚、取消和句柄释放、重复任务复用、场景稳定 ID 兼容、orphaned 不可新选、撤销/dirty 语义和发布包不依赖数据中台。

- [ ] **Step 6: 检查两端契约字段完全一致**

Run:

```powershell
Select-String -Path electron/ipc/dataPlatformSkyboxContract.ts -Pattern 'fileSize|revision|fileSha256|fileFormat|skyboxName'
Select-String -Path docs/superpowers/specs/2026-08-10-data-platform-skybox-sync-design.md -Pattern 'fileSize|revision|fileSha256|fileFormat|skyboxName'
```

Expected: 编辑器读取的字段名与已确认规范一致，`fileSize/revision` 都按字符串输入处理。

- [ ] **Step 7: 检查最终差异、临时文件和进程**

Run:

```powershell
git diff --check
git status --short
Get-ChildItem -Recurse -Directory -Filter '*data-platform-skybox-sync-*' -ErrorAction SilentlyContinue
```

Expected: `git diff --check` 无输出；没有 staging/rollback 临时目录；Git 只包含本计划文件。仅清理由本任务启动且 PID、命令和工作目录可确认的进程。

- [ ] **Step 8: 提交 README**

```powershell
git add README.md
git commit -m "docs: explain data platform skybox sync"
```

- [ ] **Step 9: 最终验收清单**

逐项确认：

```text
数据中台项目打开不被同步阻塞
普通本地项目只手动同步
未变化资源零下载
任一失败旧库不变
本地和数据中台同名资源并存
替换后场景自动跟随并保留参数
远端删除隐藏卡片但旧场景可用
orphaned 不能新选择
发布只带引用资源且 Viewer 离线可用
退出后无任务、句柄、暂存目录或调试输出
```
