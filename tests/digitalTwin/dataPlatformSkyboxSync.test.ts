import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before, type TestContext } from 'node:test';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import {
  getDataPlatformSkyboxIndexPath,
  getDataPlatformSkyboxRelativePath,
  readDataPlatformSkyboxIndex,
  resolveSkyboxIndexEntryPath,
  writeDataPlatformSkyboxIndexFile,
  type DataPlatformSkyboxIndex,
  type DataPlatformSkyboxIndexEntry,
} from '../../electron/ipc/dataPlatformSkyboxIndex.ts';
import {
  normalizeSkyboxQueryResponse,
  type DataPlatformSkyboxRecord,
} from '../../electron/ipc/dataPlatformSkyboxContract.ts';

type SyncPhase = 'querying' | 'downloading' | 'validating' | 'promoting' | 'completed' | 'failed';

type SyncProgress = {
  runId: string;
  phase: SyncPhase;
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

type RequestJsonOptions = {
  baseUrl: string;
  endpointPath: string;
  body: unknown;
  signal: AbortSignal;
  timeoutMs: number;
  context: string;
};

type DownloadFileOptions = {
  baseUrl: string;
  remoteUrl: string;
  destinationPath: string;
  maxBytes: number;
  signal: AbortSignal;
  timeoutMs: number;
  context: string;
  onChunk?: (chunk: Uint8Array) => void;
  onBytes?: (bytes: number) => void;
};

type DownloadFileResult = {
  bytes: number;
  contentType: string;
  finalUrl: string;
};

type SyncDependencies = {
  requestJson: (options: RequestJsonOptions) => Promise<unknown>;
  downloadFile: (options: DownloadFileOptions) => Promise<DownloadFileResult>;
  validateFile: (filePath: string) => Promise<{ format: 'hdr' | 'exr'; fileSizeBytes: number }>;
  now: () => Date;
  randomId: () => string;
};

type SyncModule = {
  DataPlatformRollbackError: new (message: string) => Error;
  executeDataPlatformSkyboxSync(options: {
    baseUrl: string;
    editorRoot: string;
    signal?: AbortSignal;
    dependencies?: Partial<SyncDependencies>;
    runId?: string;
  }): Promise<void>;
  startDataPlatformSkyboxSync(baseUrl: string, editorRoot: string): boolean;
  retryDataPlatformSkyboxSync(): boolean;
  getLatestDataPlatformSkyboxSyncProgress(): SyncProgress | null;
  clearDataPlatformSkyboxSyncRetryContext(): void;
  disposeDataPlatformSkyboxSync(): Promise<void>;
};

type ElectronTestWindow = {
  isDestroyed(): boolean;
  webContents: { send(channel: string, progress: SyncProgress): void };
};

type ElectronTestState = {
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  windows?: ElectronTestWindow[];
};

const ELECTRON_STATE_KEY = '__babylonSkyboxSyncElectronTestState';
const BASE_URL = 'https://platform.example.test/root';
const FIXED_NOW = new Date('2026-08-11T12:00:00.000Z');
const SECOND_NOW = new Date('2026-08-11T12:05:00.000Z');
let server: ViteDevServer;

const electronStubPlugin: Plugin = {
  name: 'data-platform-skybox-electron-stub',
  enforce: 'pre',
  resolveId(source) {
    return source === 'electron' ? '\0data-platform-skybox-electron-stub' : null;
  },
  load(id) {
    if (id !== '\0data-platform-skybox-electron-stub') return null;
    return `
      const getState = () => globalThis[${JSON.stringify(ELECTRON_STATE_KEY)}] ?? {};
      export const net = {
        fetch(input, init) {
          const fetchImpl = getState().fetch;
          if (typeof fetchImpl !== 'function') throw new Error('测试 Electron net.fetch 未配置。');
          return fetchImpl(input, init);
        },
      };
      export const BrowserWindow = {
        getAllWindows() {
          return getState().windows ?? [];
        },
      };
    `;
  },
};

before(async () => {
  server = await createServer({
    appType: 'custom',
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['electron'] },
    plugins: [electronStubPlugin],
  });
});

after(async () => {
  delete (globalThis as Record<string, unknown>)[ELECTRON_STATE_KEY];
  await server?.close();
});

async function loadSyncModule(): Promise<SyncModule> {
  return await server.ssrLoadModule('/electron/ipc/dataPlatformSkyboxSync.ts') as SyncModule;
}

async function loadSkyboxStoreModule(): Promise<{
  inspectSkyboxAssetFile(filePath: string): Promise<{ format: 'hdr' | 'exr'; fileSizeBytes: number }>;
  validateSkyboxSourceFile(filePath: string): Promise<{ format: 'hdr' | 'exr'; fileSizeBytes: number }>;
  listSkyboxAssetsInRoot(root: string): Promise<Array<{ path: string; format: 'hdr' | 'exr' }>>;
}> {
  return await server.ssrLoadModule('/electron/ipc/skyboxAssetStore.ts') as never;
}

async function loadTransferModule(): Promise<{
  downloadRemoteFile(options: DownloadFileOptions): Promise<DownloadFileResult>;
}> {
  return await server.ssrLoadModule('/electron/ipc/dataPlatformTransfer.ts') as never;
}

function setElectronTestState(state: ElectronTestState): void {
  (globalThis as Record<string, unknown>)[ELECTRON_STATE_KEY] = state;
}

async function createEditorRoot(t: TestContext, label = 'babylon-skybox-sync-'): Promise<string> {
  const editorRoot = await fs.mkdtemp(path.join(tmpdir(), label));
  t.after(async () => {
    await fs.rm(editorRoot, { recursive: true, force: true });
  });
  return editorRoot;
}

function createHdrFixture(comment = 'fixture', baseValue = 32): Buffer {
  const header = Buffer.from(`#?RADIANCE\nCOMMENT=${comment}\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n`, 'ascii');
  const scanline = [Buffer.from([2, 2, 0, 8])];
  for (let channel = 0; channel < 4; channel += 1) {
    scanline.push(Buffer.from([8]), Buffer.alloc(8, baseValue + channel));
  }
  return Buffer.concat([header, ...scanline]);
}

function createCorruptHdrFixture(): Buffer {
  const header = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n', 'ascii');
  return Buffer.concat([header, Buffer.from([2, 2, 0, 8, 137, 10])]);
}

function createExrFixture(width = 8, height = 1): Buffer {
  const version = Buffer.alloc(4);
  version.writeUInt32LE(2);
  const dataWindowSize = Buffer.alloc(4);
  dataWindowSize.writeUInt32LE(16);
  const dataWindow = Buffer.alloc(16);
  dataWindow.writeInt32LE(0, 0);
  dataWindow.writeInt32LE(0, 4);
  dataWindow.writeInt32LE(width - 1, 8);
  dataWindow.writeInt32LE(height - 1, 12);
  return Buffer.concat([
    Buffer.from([0x76, 0x2f, 0x31, 0x01]),
    version,
    Buffer.from('dataWindow\0box2i\0', 'ascii'),
    dataWindowSize,
    dataWindow,
    Buffer.from([0]),
    Buffer.from('EXR-DATA'),
  ]);
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function shaForId(id: string): string {
  return sha256(`skybox-${id}`);
}

function createRawRecord(options: {
  id?: string;
  displayName?: string;
  format?: 'hdr' | 'exr';
  data?: Uint8Array;
  fileSizeBytes?: number;
  sha?: string;
  revision?: string;
  fileUrl?: string;
} = {}): Record<string, unknown> {
  const id = options.id ?? '1';
  const format = options.format ?? 'hdr';
  const data = options.data ?? createHdrFixture(`record-${id}`, 32 + Number(id) % 20);
  return {
    id,
    skyboxName: options.displayName ?? `天空盒 ${id}`,
    fileName: `skybox-${id}.${format}`,
    fileUrl: options.fileUrl ?? `/files/skybox-${id}.${format}`,
    fileFormat: format.toUpperCase(),
    fileSize: String(options.fileSizeBytes ?? data.byteLength),
    fileSha256: options.sha ?? sha256(data),
    revision: options.revision ?? '1',
    updatedAt: '2026-08-11T10:20:30Z',
  };
}

function createPageResponse(
  records: unknown[],
  options: { total?: number; pageNum?: number; pageSize?: number } = {},
): Record<string, unknown> {
  return {
    success: true,
    message: 'ok',
    data: {
      records,
      total: String(options.total ?? records.length),
      pageNum: String(options.pageNum ?? 1),
      pageSize: String(options.pageSize ?? 100),
    },
  };
}

function normalizedRecord(raw: Record<string, unknown>): DataPlatformSkyboxRecord {
  return normalizeSkyboxQueryResponse(createPageResponse([raw])).records[0];
}

function createIndexEntry(
  raw: Record<string, unknown>,
  overrides: Partial<DataPlatformSkyboxIndexEntry> = {},
): DataPlatformSkyboxIndexEntry {
  const record = normalizedRecord(raw);
  return {
    resourceId: record.id,
    displayName: record.displayName,
    relativePath: getDataPlatformSkyboxRelativePath(record.id, record.format),
    format: record.format,
    fileSizeBytes: record.fileSizeBytes,
    sha256: record.sha256,
    revision: record.revision,
    status: 'active',
    syncedAt: '2026-08-11T11:00:00.000Z',
    ...overrides,
  };
}

async function writeCurrentIndex(editorRoot: string, entries: DataPlatformSkyboxIndexEntry[]): Promise<void> {
  await writeDataPlatformSkyboxIndexFile(getDataPlatformSkyboxIndexPath(editorRoot), {
    version: 1,
    entries,
  });
}

async function writeAsset(editorRoot: string, entry: DataPlatformSkyboxIndexEntry, data: Uint8Array): Promise<string> {
  const targetPath = resolveSkyboxIndexEntryPath(editorRoot, entry.relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, data);
  return targetPath;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
  }
  return value;
}

function singlePageRequest(
  records: Record<string, unknown>[],
  calls: RequestJsonOptions[] = [],
): { requestJson: SyncDependencies['requestJson']; response: Record<string, unknown> } {
  const response = deepFreeze(createPageResponse(records));
  return {
    response,
    requestJson: async (options) => {
      calls.push(options);
      return response;
    },
  };
}

async function writeBufferFully(
  handle: Awaited<ReturnType<typeof fs.open>>,
  buffer: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.write(buffer, offset, buffer.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error('测试写入未产生进度。');
    offset += result.bytesWritten;
  }
}

function mappedDownloader(
  files: ReadonlyMap<string, Uint8Array>,
  calls: DownloadFileOptions[] = [],
): SyncDependencies['downloadFile'] {
  return async (options) => {
    calls.push(options);
    if (options.signal.aborted) throw new Error('数据中台任务已取消。');
    const data = files.get(options.remoteUrl);
    if (!data) throw new Error(`测试缺少下载夹具：${options.remoteUrl}`);
    await fs.mkdir(path.dirname(options.destinationPath), { recursive: true });
    const handle = await fs.open(options.destinationPath, 'wx');
    try {
      const split = Math.max(1, Math.floor(data.byteLength / 2));
      for (const chunk of [data.subarray(0, split), data.subarray(split)]) {
        if (chunk.byteLength === 0) continue;
        await writeBufferFully(handle, chunk);
        options.onChunk?.(chunk);
        options.onBytes?.(chunk.byteLength);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    return {
      bytes: data.byteLength,
      contentType: 'application/octet-stream',
      finalUrl: new URL(options.remoteUrl, `${options.baseUrl.replace(/\/+$/, '')}/`).toString(),
    };
  };
}

function fixedDependencies(
  requestJson: SyncDependencies['requestJson'],
  downloadFile: SyncDependencies['downloadFile'],
  validateFile: SyncDependencies['validateFile'],
  now = FIXED_NOW,
): SyncDependencies {
  return {
    requestJson,
    downloadFile,
    validateFile,
    now: () => new Date(now),
    randomId: () => 'dependency-run-id',
  };
}

function stagingRootFor(editorRoot: string, runId: string): string {
  return path.join(editorRoot, '.babylon-editor', `data-platform-skybox-sync-${runId}`);
}

async function assertMissing(targetPath: string): Promise<void> {
  await assert.rejects(fs.lstat(targetPath), { code: 'ENOENT' });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待测试条件超时。');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
test('导出 Task 3 核心执行器、回滚错误和完整生命周期 API', async () => {
  const sync = await loadSyncModule();

  assert.equal(typeof sync.executeDataPlatformSkyboxSync, 'function');
  assert.equal(typeof sync.startDataPlatformSkyboxSync, 'function');
  assert.equal(typeof sync.retryDataPlatformSkyboxSync, 'function');
  assert.equal(typeof sync.getLatestDataPlatformSkyboxSyncProgress, 'function');
  assert.equal(typeof sync.clearDataPlatformSkyboxSyncRetryContext, 'function');
  assert.equal(typeof sync.disposeDataPlatformSkyboxSync, 'function');
  assert.equal(typeof sync.DataPlatformRollbackError, 'function');
});

test('downloadRemoteFile 写盘后按 onChunk 再 onBytes 的顺序回调', async (t) => {
  const transfer = await loadTransferModule();
  const editorRoot = await createEditorRoot(t, 'babylon-transfer-chunk-');
  const destinationPath = path.join(editorRoot, 'download.bin');
  const events: string[] = [];
  const chunks = [Buffer.from('abc'), Buffer.from('de')];

  setElectronTestState({
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-length': '5', 'content-type': 'application/octet-stream' },
    }),
  });

  const result = await transfer.downloadRemoteFile({
    baseUrl: BASE_URL,
    remoteUrl: '/files/download.bin',
    destinationPath,
    maxBytes: 10,
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    context: '下载测试文件',
    onChunk: (chunk) => events.push(`chunk:${chunk.byteLength}`),
    onBytes: (bytes) => events.push(`bytes:${bytes}`),
  });

  assert.deepEqual(events, ['chunk:3', 'bytes:3', 'chunk:2', 'bytes:2']);
  assert.equal(result.bytes, 5);
  assert.deepEqual(await fs.readFile(destinationPath), Buffer.from('abcde'));
});

test('天空盒 store 唯一复用轻量 inspect 与完整 HDR/EXR 内容校验', async (t) => {
  const store = await loadSkyboxStoreModule();
  const editorRoot = await createEditorRoot(t, 'babylon-skybox-store-');
  const sourceRoot = path.join(editorRoot, 'source');
  const libraryRoot = path.join(editorRoot, 'Assets', 'Skyboxes');
  await fs.mkdir(sourceRoot, { recursive: true });

  const hdr = createHdrFixture('real-hdr', 41);
  const exr = createExrFixture();
  const corruptHdr = createCorruptHdrFixture();
  const hdrPath = path.join(sourceRoot, 'valid.hdr');
  const exrPath = path.join(sourceRoot, 'valid.exr');
  const corruptPath = path.join(sourceRoot, 'corrupt.hdr');
  await fs.writeFile(hdrPath, hdr);
  await fs.writeFile(exrPath, exr);
  await fs.writeFile(corruptPath, corruptHdr);

  assert.deepEqual(await store.validateSkyboxSourceFile(hdrPath), { format: 'hdr', fileSizeBytes: hdr.byteLength });
  assert.deepEqual(await store.validateSkyboxSourceFile(exrPath), { format: 'exr', fileSizeBytes: exr.byteLength });
  const inspection = await store.inspectSkyboxAssetFile(corruptPath);
  assert.deepEqual(inspection, { format: 'hdr', fileSizeBytes: corruptHdr.byteLength });
  await assert.rejects(store.validateSkyboxSourceFile(corruptPath), /RLE 数据越界/);

  const packagePath = path.join(libraryRoot, 'CorruptHeaderOnly');
  await fs.mkdir(packagePath, { recursive: true });
  await fs.copyFile(corruptPath, path.join(packagePath, 'corrupt.hdr'));
  const listed = await store.listSkyboxAssetsInRoot(libraryRoot);
  assert.equal(listed.length, 1, '列表只做 stat/头部检查，不应重新执行完整 HDR payload 解码');
  assert.equal(listed[0].format, 'hdr');
});

test('首次同步下载 HDR/EXR，后续相同内容及仅名称/revision 变化均为零下载', async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();
  const editorRoot = await createEditorRoot(t);
  const hdr = createHdrFixture('initial-hdr', 33);
  const exr = createExrFixture();
  const firstRecords = [
    createRawRecord({ id: '1', data: hdr, format: 'hdr' }),
    createRawRecord({ id: '2', data: exr, format: 'exr' }),
  ];
  const requestCalls: RequestJsonOptions[] = [];
  const downloadCalls: DownloadFileOptions[] = [];
  const firstRequest = singlePageRequest(firstRecords, requestCalls);
  const responseSnapshot = structuredClone(firstRequest.response);
  const files = new Map<string, Uint8Array>([
    ['/files/skybox-1.hdr', hdr],
    ['/files/skybox-2.exr', exr],
  ]);

  await sync.executeDataPlatformSkyboxSync({
    baseUrl: BASE_URL,
    editorRoot,
    runId: 'first-run',
    dependencies: fixedDependencies(
      firstRequest.requestJson,
      mappedDownloader(files, downloadCalls),
      store.validateSkyboxSourceFile,
    ),
  });

  assert.deepEqual(firstRequest.response, responseSnapshot, '查询响应输入不得被修改');
  assert.equal(requestCalls.length, 1);
  assert.deepEqual(requestCalls[0].body, { pageNum: 1, pageSize: 100, skyboxName: '' });
  assert.match(requestCalls[0].endpointPath, /skybox/i);
  assert.equal(downloadCalls.length, 2);
  assert.ok(downloadCalls.every((call) => call.maxBytes === 512 * 1024 * 1024));
  assert.ok(downloadCalls.every((call) => call.timeoutMs > 0));

  const firstIndex = await readDataPlatformSkyboxIndex(editorRoot);
  assert.deepEqual(firstIndex.entries.map((entry) => [entry.resourceId, entry.format, entry.status]), [
    ['1', 'hdr', 'active'],
    ['2', 'exr', 'active'],
  ]);
  assert.deepEqual(
    await fs.readFile(resolveSkyboxIndexEntryPath(editorRoot, firstIndex.entries[0].relativePath)),
    hdr,
  );
  assert.deepEqual(
    await fs.readFile(resolveSkyboxIndexEntryPath(editorRoot, firstIndex.entries[1].relativePath)),
    exr,
  );
  const firstProgress = sync.getLatestDataPlatformSkyboxSyncProgress();
  assert.deepEqual({
    runId: firstProgress?.runId,
    phase: firstProgress?.phase,
    completed: firstProgress?.completed,
    total: firstProgress?.total,
    error: firstProgress?.error,
  }, { runId: 'first-run', phase: 'completed', completed: 2, total: 2, error: null });
  assert.equal(typeof firstProgress?.message, 'string');
  await assertMissing(stagingRootFor(editorRoot, 'first-run'));

  const unchangedRequest = singlePageRequest(firstRecords);
  await sync.executeDataPlatformSkyboxSync({
    baseUrl: BASE_URL,
    editorRoot,
    runId: 'second-run',
    dependencies: fixedDependencies(
      unchangedRequest.requestJson,
      mappedDownloader(files, downloadCalls),
      store.validateSkyboxSourceFile,
      SECOND_NOW,
    ),
  });
  assert.equal(downloadCalls.length, 2, '第二次相同内容同步不得重复下载');
  const secondProgress = sync.getLatestDataPlatformSkyboxSyncProgress();
  assert.deepEqual({
    runId: secondProgress?.runId,
    phase: secondProgress?.phase,
    completed: secondProgress?.completed,
    total: secondProgress?.total,
    error: secondProgress?.error,
  }, { runId: 'second-run', phase: 'completed', completed: 0, total: 0, error: null });
  assert.equal(typeof secondProgress?.message, 'string');

  const renamedRecords = [
    createRawRecord({ id: '1', data: hdr, format: 'hdr', displayName: '改名后的 HDR', revision: '9' }),
    createRawRecord({ id: '2', data: exr, format: 'exr', displayName: '改名后的 EXR', revision: '10' }),
  ];
  const renamedRequest = singlePageRequest(renamedRecords);
  await sync.executeDataPlatformSkyboxSync({
    baseUrl: BASE_URL,
    editorRoot,
    runId: 'metadata-only-run',
    dependencies: fixedDependencies(
      renamedRequest.requestJson,
      mappedDownloader(files, downloadCalls),
      store.validateSkyboxSourceFile,
      new Date('2026-08-11T12:10:00.000Z'),
    ),
  });

  assert.equal(downloadCalls.length, 2, '仅名称/revision 变化不得下载内容');
  const renamedIndex = await readDataPlatformSkyboxIndex(editorRoot);
  assert.deepEqual(renamedIndex.entries.map((entry) => [entry.displayName, entry.revision]), [
    ['改名后的 HDR', '9'],
    ['改名后的 EXR', '10'],
  ]);
});

test('hash、size、format 或物理文件缺失均触发重新下载，格式互换保留旧文件', async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();

  const scenarios: Array<{
    name: string;
    currentData: Buffer;
    remoteData: Buffer;
    currentFormat: 'hdr' | 'exr';
    remoteFormat: 'hdr' | 'exr';
    omitPhysical?: boolean;
  }> = [
    {
      name: 'hash changed',
      currentData: createHdrFixture('same-size-a', 31),
      remoteData: createHdrFixture('same-size-b', 47),
      currentFormat: 'hdr',
      remoteFormat: 'hdr',
    },
    {
      name: 'size changed',
      currentData: createHdrFixture('short', 31),
      remoteData: createHdrFixture('a-much-longer-comment', 31),
      currentFormat: 'hdr',
      remoteFormat: 'hdr',
    },
    {
      name: 'format changed',
      currentData: createHdrFixture('old-format', 31),
      remoteData: createExrFixture(),
      currentFormat: 'hdr',
      remoteFormat: 'exr',
    },
    {
      name: 'physical missing',
      currentData: createHdrFixture('missing', 31),
      remoteData: createHdrFixture('missing', 31),
      currentFormat: 'hdr',
      remoteFormat: 'hdr',
      omitPhysical: true,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const editorRoot = await createEditorRoot(subtest, 'babylon-skybox-change-');
      const currentRaw = createRawRecord({ id: '1', data: scenario.currentData, format: scenario.currentFormat });
      const currentEntry = createIndexEntry(currentRaw);
      await writeCurrentIndex(editorRoot, [currentEntry]);
      const oldTarget = resolveSkyboxIndexEntryPath(editorRoot, currentEntry.relativePath);
      if (!scenario.omitPhysical) await writeAsset(editorRoot, currentEntry, scenario.currentData);
      const remoteRaw = createRawRecord({ id: '1', data: scenario.remoteData, format: scenario.remoteFormat, revision: '2' });
      const request = singlePageRequest([remoteRaw]);
      const calls: DownloadFileOptions[] = [];

      await sync.executeDataPlatformSkyboxSync({
        baseUrl: BASE_URL,
        editorRoot,
        runId: `change-${scenario.name.replace(/\s+/g, '-')}`,
        dependencies: fixedDependencies(
          request.requestJson,
          mappedDownloader(new Map([[String(remoteRaw.fileUrl), scenario.remoteData]]), calls),
          store.validateSkyboxSourceFile,
        ),
      });

      assert.equal(calls.length, 1);
      const nextIndex = await readDataPlatformSkyboxIndex(editorRoot);
      const nextTarget = resolveSkyboxIndexEntryPath(editorRoot, nextIndex.entries[0].relativePath);
      assert.deepEqual(await fs.readFile(nextTarget), scenario.remoteData);
      if (scenario.currentFormat !== scenario.remoteFormat) {
        assert.deepEqual(await fs.readFile(oldTarget), scenario.currentData, '格式互换时旧扩展名文件必须保留');
        assert.notEqual(nextTarget, oldTarget);
      }
    });
  }
});
test('hash、size 或内容格式不匹配时整批保持原子不变并清理 staging', async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();
  const oldData = createHdrFixture('old-committed', 35);
  const validNewData = createHdrFixture('new-expected', 52);
  const invalidNewData = Buffer.from(createCorruptHdrFixture());

  const scenarios: Array<{
    name: string;
    metadataData: Buffer;
    downloadedData: Buffer;
    resultBytes?: number;
    expected: RegExp;
  }> = [
    {
      name: 'hash mismatch',
      metadataData: validNewData,
      downloadedData: createHdrFixture('new-expected', 53),
      expected: /SHA|hash/i,
    },
    {
      name: 'size mismatch',
      metadataData: validNewData,
      downloadedData: validNewData,
      resultBytes: validNewData.byteLength + 1,
      expected: /大小|字节|size/i,
    },
    {
      name: 'content mismatch',
      metadataData: invalidNewData,
      downloadedData: invalidNewData,
      expected: /RLE 数据越界|HDR/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const editorRoot = await createEditorRoot(subtest, 'babylon-skybox-atomic-');
      const currentRaw = createRawRecord({ id: '1', data: oldData, format: 'hdr' });
      const currentEntry = createIndexEntry(currentRaw);
      await writeCurrentIndex(editorRoot, [currentEntry]);
      const targetPath = await writeAsset(editorRoot, currentEntry, oldData);
      const indexPath = getDataPlatformSkyboxIndexPath(editorRoot);
      const oldIndexBytes = await fs.readFile(indexPath);
      const remoteRaw = createRawRecord({ id: '1', data: scenario.metadataData, format: 'hdr', revision: '2' });
      const request = singlePageRequest([remoteRaw]);
      const runId = `atomic-${scenario.name.replace(/\s+/g, '-')}`;
      const downloadFile: SyncDependencies['downloadFile'] = async (options) => {
        await mappedDownloader(new Map([[String(remoteRaw.fileUrl), scenario.downloadedData]]))(options);
        return {
          bytes: scenario.resultBytes ?? scenario.downloadedData.byteLength,
          contentType: 'application/octet-stream',
          finalUrl: new URL(options.remoteUrl, `${options.baseUrl}/`).toString(),
        };
      };

      await assert.rejects(
        sync.executeDataPlatformSkyboxSync({
          baseUrl: BASE_URL,
          editorRoot,
          runId,
          dependencies: fixedDependencies(request.requestJson, downloadFile, store.validateSkyboxSourceFile),
        }),
        scenario.expected,
      );

      assert.deepEqual(await fs.readFile(targetPath), oldData);
      assert.deepEqual(await fs.readFile(indexPath), oldIndexBytes);
      await assertMissing(stagingRootFor(editorRoot, runId));
      const progress = sync.getLatestDataPlatformSkyboxSyncProgress();
      assert.equal(progress?.phase, 'failed');
      assert.equal(typeof progress?.error, 'string');
    });
  }
});

test('远端删除只把索引标记为 orphaned，保留已同步文件', async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();
  const editorRoot = await createEditorRoot(t, 'babylon-skybox-orphan-');
  const data = createHdrFixture('orphaned', 34);
  const raw = createRawRecord({ id: '7', data });
  const entry = createIndexEntry(raw);
  await writeCurrentIndex(editorRoot, [entry]);
  const targetPath = await writeAsset(editorRoot, entry, data);
  const request = singlePageRequest([]);
  let downloadCalls = 0;

  await sync.executeDataPlatformSkyboxSync({
    baseUrl: BASE_URL,
    editorRoot,
    runId: 'orphan-run',
    dependencies: fixedDependencies(
      request.requestJson,
      async () => {
        downloadCalls += 1;
        throw new Error('不应下载');
      },
      store.validateSkyboxSourceFile,
    ),
  });

  assert.equal(downloadCalls, 0);
  const nextIndex = await readDataPlatformSkyboxIndex(editorRoot);
  assert.equal(nextIndex.entries.length, 1);
  assert.equal(nextIndex.entries[0].status, 'orphaned');
  assert.deepEqual(await fs.readFile(targetPath), data);
  const progress = sync.getLatestDataPlatformSkyboxSyncProgress();
  assert.deepEqual({
    runId: progress?.runId,
    phase: progress?.phase,
    completed: progress?.completed,
    total: progress?.total,
    error: progress?.error,
  }, { runId: 'orphan-run', phase: 'completed', completed: 0, total: 0, error: null });
  assert.equal(typeof progress?.message, 'string');
});

test('计划下载量超过 8 GiB 时在任何下载和 staging 创建前拒绝', async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();
  const editorRoot = await createEditorRoot(t, 'babylon-skybox-limit-');
  const records = Array.from({ length: 17 }, (_, index) => {
    const id = String(index + 1);
    return createRawRecord({
      id,
      fileSizeBytes: 512 * 1024 * 1024,
      sha: shaForId(id),
    });
  });
  const request = singlePageRequest(records);
  let downloadCalls = 0;

  await assert.rejects(
    sync.executeDataPlatformSkyboxSync({
      baseUrl: BASE_URL,
      editorRoot,
      runId: 'too-large-run',
      dependencies: fixedDependencies(
        request.requestJson,
        async () => {
          downloadCalls += 1;
          throw new Error('不应下载');
        },
        store.validateSkyboxSourceFile,
      ),
    }),
    /8 GiB|8 GB|下载总量/,
  );

  assert.equal(downloadCalls, 0);
  await assertMissing(stagingRootFor(editorRoot, 'too-large-run'));
  await assertMissing(getDataPlatformSkyboxIndexPath(editorRoot));
});

test('有界分页完整读取多页并要求请求与响应 pageNum/pageSize 一致', async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();
  const editorRoot = await createEditorRoot(t, 'babylon-skybox-pages-');
  const records = Array.from({ length: 101 }, (_, index) => {
    const id = String(index + 1);
    return createRawRecord({ id, fileSizeBytes: 1, sha: shaForId(id) });
  });
  const normalized = records.map(normalizedRecord);
  const entries = records.map((record) => createIndexEntry(record));
  await writeCurrentIndex(editorRoot, entries);
  for (let index = 0; index < entries.length; index += 1) {
    await writeAsset(editorRoot, entries[index], Buffer.from([index % 251]));
  }

  const calls: Array<{ pageNum: number; pageSize: number; skyboxName: string }> = [];
  const requestJson: SyncDependencies['requestJson'] = async (options) => {
    const body = options.body as { pageNum: number; pageSize: number; skyboxName: string };
    calls.push({ ...body });
    const start = (body.pageNum - 1) * body.pageSize;
    return createPageResponse(records.slice(start, start + body.pageSize), {
      total: records.length,
      pageNum: body.pageNum,
      pageSize: body.pageSize,
    });
  };
  let downloadCalls = 0;

  await sync.executeDataPlatformSkyboxSync({
    baseUrl: BASE_URL,
    editorRoot,
    runId: 'multi-page-run',
    dependencies: fixedDependencies(
      requestJson,
      async () => {
        downloadCalls += 1;
        throw new Error('不应下载');
      },
      store.validateSkyboxSourceFile,
    ),
  });

  assert.deepEqual(calls, [
    { pageNum: 1, pageSize: 100, skyboxName: '' },
    { pageNum: 2, pageSize: 100, skyboxName: '' },
  ]);
  assert.equal(downloadCalls, 0);
  const nextIndex = await readDataPlatformSkyboxIndex(editorRoot);
  assert.equal(nextIndex.entries.length, normalized.length);
});

test('分页异常全部失败且不修改旧库', async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();

  const one = createRawRecord({ id: '1', fileSizeBytes: 1, sha: shaForId('1') });
  const two = createRawRecord({ id: '2', fileSizeBytes: 1, sha: shaForId('2') });
  const three = createRawRecord({ id: '3', fileSizeBytes: 1, sha: shaForId('3') });
  const cases: Array<{
    name: string;
    expected: RegExp;
    requestJson: SyncDependencies['requestJson'];
    expectedCalls?: number;
  }> = [
    {
      name: 'pageNum mismatch',
      expected: /pageNum|页码|请求/,
      requestJson: async () => createPageResponse([], { total: 0, pageNum: 2, pageSize: 100 }),
    },
    {
      name: 'pageSize mismatch',
      expected: /pageSize|每页|请求/,
      requestJson: async () => createPageResponse([], { total: 0, pageNum: 1, pageSize: 99 }),
    },
    {
      name: 'unstable total',
      expected: /total|总数|稳定/,
      requestJson: async (options) => {
        const pageNum = (options.body as { pageNum: number }).pageNum;
        return pageNum === 1
          ? createPageResponse([one], { total: 2, pageNum, pageSize: 100 })
          : createPageResponse([two], { total: 3, pageNum, pageSize: 100 });
      },
    },
    {
      name: 'empty before total',
      expected: /空页|未取完|total|总数/,
      requestJson: async () => createPageResponse([], { total: 1, pageNum: 1, pageSize: 100 }),
    },
    {
      name: 'accumulated over total',
      expected: /超过.*total|总数|记录数/,
      requestJson: async (options) => {
        const pageNum = (options.body as { pageNum: number }).pageNum;
        return pageNum === 1
          ? createPageResponse([one], { total: 2, pageNum, pageSize: 100 })
          : createPageResponse([two, three], { total: 2, pageNum, pageSize: 100 });
      },
    },
    {
      name: 'duplicate across pages',
      expected: /重复/,
      requestJson: async (options) => {
        const pageNum = (options.body as { pageNum: number }).pageNum;
        return createPageResponse([one], { total: 2, pageNum, pageSize: 100 });
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const editorRoot = await createEditorRoot(subtest, 'babylon-skybox-page-error-');
      const oldData = createHdrFixture('old-page-index', 38);
      const oldRaw = createRawRecord({ id: '99', data: oldData, sha: sha256(oldData) });
      const oldEntry = createIndexEntry(oldRaw);
      await writeCurrentIndex(editorRoot, [oldEntry]);
      const oldTarget = await writeAsset(editorRoot, oldEntry, oldData);
      const indexPath = getDataPlatformSkyboxIndexPath(editorRoot);
      const oldIndexBytes = await fs.readFile(indexPath);
      let downloadCalls = 0;

      await assert.rejects(
        sync.executeDataPlatformSkyboxSync({
          baseUrl: BASE_URL,
          editorRoot,
          runId: `page-error-${item.name.replace(/\s+/g, '-')}`,
          dependencies: fixedDependencies(
            item.requestJson,
            async () => {
              downloadCalls += 1;
              throw new Error('不应下载');
            },
            store.validateSkyboxSourceFile,
          ),
        }),
        item.expected,
      );

      assert.equal(downloadCalls, 0);
      assert.deepEqual(await fs.readFile(indexPath), oldIndexBytes);
      assert.deepEqual(await fs.readFile(oldTarget), oldData);
    });
  }

  await t.test('超过 1000 页', async (subtest) => {
    const editorRoot = await createEditorRoot(subtest, 'babylon-skybox-page-cap-');
    let calls = 0;
    const requestJson: SyncDependencies['requestJson'] = async (options) => {
      const pageNum = (options.body as { pageNum: number }).pageNum;
      calls += 1;
      const id = String(pageNum);
      return createPageResponse([
        createRawRecord({ id, fileSizeBytes: 1, sha: shaForId(id) }),
      ], { total: 100_000, pageNum, pageSize: 100 });
    };
    let downloadCalls = 0;

    await assert.rejects(
      sync.executeDataPlatformSkyboxSync({
        baseUrl: BASE_URL,
        editorRoot,
        runId: 'page-cap-run',
        dependencies: fixedDependencies(
          requestJson,
          async () => {
            downloadCalls += 1;
            throw new Error('不应下载');
          },
          store.validateSkyboxSourceFile,
        ),
      }),
      /1000 页|分页.*上限/,
    );

    assert.equal(calls, 1_000);
    assert.equal(downloadCalls, 0);
    await assertMissing(getDataPlatformSkyboxIndexPath(editorRoot));
  });
});
test('下载并发峰值严格为 2，首个失败后不再领取新任务并等待已领取任务释放', async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();
  const editorRoot = await createEditorRoot(t, 'babylon-skybox-concurrency-');
  const records = Array.from({ length: 5 }, (_, index) => {
    const id = String(index + 1);
    const data = createHdrFixture(`concurrency-${id}`, 30 + index);
    return { raw: createRawRecord({ id, data }), data };
  });
  const request = singlePageRequest(records.map((item) => item.raw));
  const started: string[] = [];
  let active = 0;
  let peak = 0;
  let releaseSecond: (() => void) | null = null;
  const secondRelease = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let twoStarted: (() => void) | null = null;
  const twoStartedPromise = new Promise<void>((resolve) => {
    twoStarted = resolve;
  });

  const downloadFile: SyncDependencies['downloadFile'] = async (options) => {
    const id = /skybox-(\d+)\./.exec(options.remoteUrl)?.[1] ?? 'unknown';
    started.push(id);
    active += 1;
    peak = Math.max(peak, active);
    if (started.length === 2) twoStarted?.();
    try {
      if (id === '1') {
        await twoStartedPromise;
        throw new Error('injected first download failure');
      }
      if (id === '2') {
        await secondRelease;
        return await mappedDownloader(new Map([[options.remoteUrl, records[1].data]]))(options);
      }
      return await mappedDownloader(new Map([[options.remoteUrl, records[Number(id) - 1].data]]))(options);
    } finally {
      active -= 1;
    }
  };

  const execution = sync.executeDataPlatformSkyboxSync({
    baseUrl: BASE_URL,
    editorRoot,
    runId: 'concurrency-run',
    dependencies: fixedDependencies(request.requestJson, downloadFile, store.validateSkyboxSourceFile),
  });
  await twoStartedPromise;
  await waitFor(() => sync.getLatestDataPlatformSkyboxSyncProgress()?.phase === 'downloading');
  releaseSecond?.();

  await assert.rejects(execution, /injected first download failure/);
  assert.equal(peak, 2);
  assert.deepEqual(started, ['1', '2']);
  assert.equal(active, 0);
  await assertMissing(stagingRootFor(editorRoot, 'concurrency-run'));
  await assertMissing(getDataPlatformSkyboxIndexPath(editorRoot));
});

test('首个完整 validate 失败后不再领取后续下载任务并等待已领取任务释放', async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();
  const editorRoot = await createEditorRoot(t, 'babylon-skybox-validate-stop-');
  const records = Array.from({ length: 5 }, (_, index) => {
    const id = String(index + 1);
    const data = createHdrFixture(`validate-stop-${id}`, 40 + index);
    return { raw: createRawRecord({ id, data }), data };
  });
  const request = singlePageRequest(records.map((item) => item.raw));
  const started: string[] = [];
  let twoStarted: (() => void) | null = null;
  const twoStartedPromise = new Promise<void>((resolve) => {
    twoStarted = resolve;
  });
  const downloadFile: SyncDependencies['downloadFile'] = async (options) => {
    const id = /skybox-(\d+)\./.exec(options.remoteUrl)?.[1] ?? 'unknown';
    started.push(id);
    if (started.length === 2) twoStarted?.();
    if (id === '2') await new Promise<void>((resolve) => setTimeout(resolve, 50));
    return await mappedDownloader(new Map([[options.remoteUrl, records[Number(id) - 1].data]]))(options);
  };
  const validateFile: SyncDependencies['validateFile'] = async (filePath) => {
    if (filePath.endsWith(`${path.sep}Skybox-1${path.sep}skybox.hdr`)) {
      await twoStartedPromise;
      throw new Error('injected validate failure');
    }
    return await store.validateSkyboxSourceFile(filePath);
  };

  await assert.rejects(
    sync.executeDataPlatformSkyboxSync({
      baseUrl: BASE_URL,
      editorRoot,
      runId: 'validate-stop-run',
      dependencies: fixedDependencies(request.requestJson, downloadFile, validateFile),
    }),
    /injected validate failure/,
  );

  assert.deepEqual(started, ['1', '2']);
  await assertMissing(stagingRootFor(editorRoot, 'validate-stop-run'));
  await assertMissing(getDataPlatformSkyboxIndexPath(editorRoot));
});

test('推广中途失败时逆序删除新目标并完整恢复备份，随后清理 staging', { concurrency: false }, async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();
  const editorRoot = await createEditorRoot(t, 'babylon-skybox-rollback-');
  const oldOne = createHdrFixture('old-one', 31);
  const oldTwo = createHdrFixture('old-two', 32);
  const newOne = createHdrFixture('new-one', 51);
  const newTwo = createHdrFixture('new-two', 52);
  const currentRecords = [
    createRawRecord({ id: '1', data: oldOne }),
    createRawRecord({ id: '2', data: oldTwo }),
  ];
  const currentEntries = currentRecords.map((record) => createIndexEntry(record));
  await writeCurrentIndex(editorRoot, currentEntries);
  const targetOne = await writeAsset(editorRoot, currentEntries[0], oldOne);
  const targetTwo = await writeAsset(editorRoot, currentEntries[1], oldTwo);
  const indexPath = getDataPlatformSkyboxIndexPath(editorRoot);
  const oldIndexBytes = await fs.readFile(indexPath);
  const remoteRecords = [
    createRawRecord({ id: '1', data: newOne, revision: '2' }),
    createRawRecord({ id: '2', data: newTwo, revision: '2' }),
  ];
  const request = singlePageRequest(remoteRecords);
  const originalRename = fs.rename;
  (fs as unknown as { rename: typeof fs.rename }).rename = async (source, target) => {
    const sourcePath = String(source);
    const targetPath = String(target);
    if (targetPath === targetTwo && sourcePath.includes(`${path.sep}downloads${path.sep}`)) {
      throw new Error('injected promotion failure');
    }
    return await originalRename(source, target);
  };

  try {
    await assert.rejects(
      sync.executeDataPlatformSkyboxSync({
        baseUrl: BASE_URL,
        editorRoot,
        runId: 'rollback-complete-run',
        dependencies: fixedDependencies(
          request.requestJson,
          mappedDownloader(new Map([
            ['/files/skybox-1.hdr', newOne],
            ['/files/skybox-2.hdr', newTwo],
          ])),
          store.validateSkyboxSourceFile,
        ),
      }),
      (error: unknown) => {
        assert.equal(error instanceof sync.DataPlatformRollbackError, false);
        assert.match(error instanceof Error ? error.message : String(error), /injected promotion failure/);
        return true;
      },
    );
  } finally {
    (fs as unknown as { rename: typeof fs.rename }).rename = originalRename;
  }

  assert.deepEqual(await fs.readFile(targetOne), oldOne);
  assert.deepEqual(await fs.readFile(targetTwo), oldTwo);
  assert.deepEqual(await fs.readFile(indexPath), oldIndexBytes);
  await assertMissing(stagingRootFor(editorRoot, 'rollback-complete-run'));
  const progress = sync.getLatestDataPlatformSkyboxSyncProgress();
  assert.equal(progress?.phase, 'failed');
  assert.match(progress?.message ?? '', /原资源库|旧库|完整恢复/);
});

test('回滚不完整时抛 DataPlatformRollbackError，包含全部错误并保留恢复目录', { concurrency: false }, async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();
  const editorRoot = await createEditorRoot(t, 'babylon-skybox-rollback-incomplete-');
  const oldOne = createHdrFixture('old-one-preserve', 31);
  const oldTwo = createHdrFixture('old-two-preserve', 32);
  const newOne = createHdrFixture('new-one-preserve', 51);
  const newTwo = createHdrFixture('new-two-preserve', 52);
  const currentRecords = [
    createRawRecord({ id: '1', data: oldOne }),
    createRawRecord({ id: '2', data: oldTwo }),
  ];
  const currentEntries = currentRecords.map((record) => createIndexEntry(record));
  await writeCurrentIndex(editorRoot, currentEntries);
  const targetOne = await writeAsset(editorRoot, currentEntries[0], oldOne);
  const targetTwo = await writeAsset(editorRoot, currentEntries[1], oldTwo);
  const indexPath = getDataPlatformSkyboxIndexPath(editorRoot);
  const oldIndexBytes = await fs.readFile(indexPath);
  const request = singlePageRequest([
    createRawRecord({ id: '1', data: newOne, revision: '2' }),
    createRawRecord({ id: '2', data: newTwo, revision: '2' }),
  ]);
  const originalRename = fs.rename;
  (fs as unknown as { rename: typeof fs.rename }).rename = async (source, target) => {
    const sourcePath = String(source);
    const targetPath = String(target);
    if (targetPath === targetTwo && sourcePath.includes(`${path.sep}downloads${path.sep}`)) {
      throw new Error('promotion-two-failed');
    }
    if (sourcePath.includes(`${path.sep}backup${path.sep}`) && targetPath === targetOne) {
      throw new Error('restore-one-failed');
    }
    if (sourcePath.includes(`${path.sep}backup${path.sep}`) && targetPath === targetTwo) {
      throw new Error('restore-two-failed');
    }
    return await originalRename(source, target);
  };

  let captured: unknown;
  try {
    await assert.rejects(
      sync.executeDataPlatformSkyboxSync({
        baseUrl: BASE_URL,
        editorRoot,
        runId: 'rollback-incomplete-run',
        dependencies: fixedDependencies(
          request.requestJson,
          mappedDownloader(new Map([
            ['/files/skybox-1.hdr', newOne],
            ['/files/skybox-2.hdr', newTwo],
          ])),
          store.validateSkyboxSourceFile,
        ),
      }),
      (error: unknown) => {
        captured = error;
        return true;
      },
    );
  } finally {
    (fs as unknown as { rename: typeof fs.rename }).rename = originalRename;
  }

  assert.ok(captured instanceof sync.DataPlatformRollbackError);
  const message = captured instanceof Error ? captured.message : String(captured);
  assert.match(message, /promotion-two-failed/);
  assert.match(message, /restore-one-failed/);
  assert.match(message, /restore-two-failed/);
  assert.match(message, /保留恢复目录/);
  const stagingRoot = stagingRootFor(editorRoot, 'rollback-incomplete-run');
  assert.equal((await fs.lstat(stagingRoot)).isDirectory(), true);
  assert.equal((await fs.lstat(path.join(stagingRoot, 'backup'))).isDirectory(), true);
  assert.deepEqual(await fs.readFile(indexPath), oldIndexBytes);
  await assertMissing(targetOne);
  await assertMissing(targetTwo);
  const progress = sync.getLatestDataPlatformSkyboxSyncProgress();
  assert.equal(progress?.phase, 'failed');
  assert.match(progress?.message ?? '', /回滚不完整|恢复材料/);
  assert.doesNotMatch(progress?.message ?? '', /已保留原资源库|旧库完整/);
});

test('索引推广完成后触发 Abort 仍按已提交成功报告 completed', { concurrency: false }, async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();
  const editorRoot = await createEditorRoot(t, 'babylon-skybox-post-commit-abort-');
  const data = createHdrFixture('post-commit-abort', 61);
  const raw = createRawRecord({ id: '1', data });
  const request = singlePageRequest([raw]);
  const controller = new AbortController();
  const indexPath = getDataPlatformSkyboxIndexPath(editorRoot);
  const originalRename = fs.rename;
  (fs as unknown as { rename: typeof fs.rename }).rename = async (source, target) => {
    await originalRename(source, target);
    if (String(target) === indexPath) controller.abort();
  };

  try {
    await sync.executeDataPlatformSkyboxSync({
      baseUrl: BASE_URL,
      editorRoot,
      runId: 'post-commit-abort-run',
      signal: controller.signal,
      dependencies: fixedDependencies(
        request.requestJson,
        mappedDownloader(new Map([['/files/skybox-1.hdr', data]])),
        store.validateSkyboxSourceFile,
      ),
    });
  } finally {
    (fs as unknown as { rename: typeof fs.rename }).rename = originalRename;
  }

  assert.equal(controller.signal.aborted, true);
  assert.equal(sync.getLatestDataPlatformSkyboxSyncProgress()?.phase, 'completed');
  assert.equal((await readDataPlatformSkyboxIndex(editorRoot)).entries.length, 1);
});

test('索引提交后的 staging 清理失败只记录告警且保持 completed', { concurrency: false }, async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();
  const editorRoot = await createEditorRoot(t, 'babylon-skybox-post-commit-cleanup-');
  const data = createHdrFixture('post-commit-cleanup', 62);
  const raw = createRawRecord({ id: '1', data });
  const request = singlePageRequest([raw]);
  const runId = 'post-commit-cleanup-run';
  const stagingRoot = stagingRootFor(editorRoot, runId);
  const indexPath = getDataPlatformSkyboxIndexPath(editorRoot);
  const originalRename = fs.rename;
  const originalRm = fs.rm;
  let committed = false;
  (fs as unknown as { rename: typeof fs.rename }).rename = async (source, target) => {
    await originalRename(source, target);
    if (String(target) === indexPath) committed = true;
  };
  (fs as unknown as { rm: typeof fs.rm }).rm = async (target, options) => {
    if (committed && path.resolve(String(target)) === path.resolve(stagingRoot)) {
      throw new Error('injected post-commit cleanup failure');
    }
    return await originalRm(target, options);
  };

  try {
    await sync.executeDataPlatformSkyboxSync({
      baseUrl: BASE_URL,
      editorRoot,
      runId,
      dependencies: fixedDependencies(
        request.requestJson,
        mappedDownloader(new Map([['/files/skybox-1.hdr', data]])),
        store.validateSkyboxSourceFile,
      ),
    });
  } finally {
    (fs as unknown as { rename: typeof fs.rename }).rename = originalRename;
    (fs as unknown as { rm: typeof fs.rm }).rm = originalRm;
  }

  const progress = sync.getLatestDataPlatformSkyboxSyncProgress();
  assert.equal(progress?.phase, 'completed');
  assert.match(progress?.message ?? '', /清理|staging/i);
  assert.equal((await readDataPlatformSkyboxIndex(editorRoot)).entries.length, 1);
  assert.equal((await fs.lstat(stagingRoot)).isDirectory(), true);
});

test('Abort 会等待已领取下载释放并清理所有 staging/partial，不伪报 completed', async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();
  const editorRoot = await createEditorRoot(t, 'babylon-skybox-abort-');
  const records = Array.from({ length: 3 }, (_, index) => {
    const id = String(index + 1);
    const data = createHdrFixture(`abort-${id}`, 30 + index);
    return { raw: createRawRecord({ id, data }), data };
  });
  const request = singlePageRequest(records.map((item) => item.raw));
  const controller = new AbortController();
  let started = 0;
  let active = 0;
  const downloadFile: SyncDependencies['downloadFile'] = async (options) => {
    const id = /skybox-(\d+)\./.exec(options.remoteUrl)?.[1] ?? '1';
    const data = records[Number(id) - 1].data;
    started += 1;
    active += 1;
    await fs.mkdir(path.dirname(options.destinationPath), { recursive: true });
    const handle = await fs.open(options.destinationPath, 'wx');
    try {
      const chunk = data.subarray(0, Math.min(8, data.byteLength));
      await writeBufferFully(handle, chunk);
      options.onChunk?.(chunk);
      options.onBytes?.(chunk.byteLength);
      await new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(new Error('download aborted'));
        if (options.signal.aborted) rejectAbort();
        else options.signal.addEventListener('abort', rejectAbort, { once: true });
      });
    } finally {
      active -= 1;
      await handle.close();
    }
  };

  const execution = sync.executeDataPlatformSkyboxSync({
    baseUrl: BASE_URL,
    editorRoot,
    runId: 'abort-run',
    signal: controller.signal,
    dependencies: fixedDependencies(request.requestJson, downloadFile, store.validateSkyboxSourceFile),
  });
  await waitFor(() => started === 2);
  controller.abort();

  await assert.rejects(execution, /取消|abort/i);
  assert.equal(active, 0);
  await assertMissing(stagingRootFor(editorRoot, 'abort-run'));
  await assertMissing(getDataPlatformSkyboxIndexPath(editorRoot));
  const progress = sync.getLatestDataPlatformSkyboxSyncProgress();
  assert.notEqual(progress?.phase, 'completed');
  assert.equal(progress?.phase, 'failed');
});

test('索引目标为 symlink 或目录时视为物理缺失，重下后不删除越界内容', async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();
  const editorRoot = await createEditorRoot(t, 'babylon-skybox-existing-types-');
  const outsideRoot = await fs.mkdtemp(path.join(tmpdir(), 'babylon-skybox-outside-'));
  t.after(async () => {
    await fs.rm(outsideRoot, { recursive: true, force: true });
  });
  const hdrOne = createHdrFixture('replace-link', 43);
  const hdrTwo = createHdrFixture('replace-directory', 44);
  const rawOne = createRawRecord({ id: '1', data: hdrOne });
  const rawTwo = createRawRecord({ id: '2', data: hdrTwo });
  const entryOne = createIndexEntry(rawOne);
  const entryTwo = createIndexEntry(rawTwo);
  await writeCurrentIndex(editorRoot, [entryOne, entryTwo]);
  const targetOne = resolveSkyboxIndexEntryPath(editorRoot, entryOne.relativePath);
  const targetTwo = resolveSkyboxIndexEntryPath(editorRoot, entryTwo.relativePath);
  await fs.mkdir(path.dirname(targetOne), { recursive: true });
  await fs.mkdir(path.dirname(targetTwo), { recursive: true });
  const outsideSentinel = path.join(outsideRoot, 'sentinel.txt');
  await fs.writeFile(outsideSentinel, 'keep-outside', 'utf8');
  await fs.symlink(outsideRoot, targetOne, 'junction');
  await fs.mkdir(targetTwo, { recursive: false });
  await fs.writeFile(path.join(targetTwo, 'old-directory-content.txt'), 'old', 'utf8');
  const calls: DownloadFileOptions[] = [];
  const request = singlePageRequest([rawOne, rawTwo]);

  await sync.executeDataPlatformSkyboxSync({
    baseUrl: BASE_URL,
    editorRoot,
    runId: 'existing-types-run',
    dependencies: fixedDependencies(
      request.requestJson,
      mappedDownloader(new Map([
        ['/files/skybox-1.hdr', hdrOne],
        ['/files/skybox-2.hdr', hdrTwo],
      ]), calls),
      store.validateSkyboxSourceFile,
    ),
  });

  assert.equal(calls.length, 2);
  assert.equal((await fs.lstat(targetOne)).isFile(), true);
  assert.equal((await fs.lstat(targetOne)).isSymbolicLink(), false);
  assert.equal((await fs.lstat(targetTwo)).isFile(), true);
  assert.deepEqual(await fs.readFile(targetOne), hdrOne);
  assert.deepEqual(await fs.readFile(targetTwo), hdrTwo);
  assert.equal(await fs.readFile(outsideSentinel, 'utf8'), 'keep-outside');
});

test('重复 start 复用活动任务，retry/clear/dispose 与进度广播遵守生命周期契约', { concurrency: false }, async (t) => {
  const sync = await loadSyncModule();
  const editorRoot = await createEditorRoot(t, 'babylon-skybox-lifecycle-');
  const sent: Array<{ channel: string; progress: SyncProgress }> = [];
  const destroyedSent: Array<{ channel: string; progress: SyncProgress }> = [];
  const windows: ElectronTestWindow[] = [
    {
      isDestroyed: () => false,
      webContents: { send: (channel, progress) => sent.push({ channel, progress: { ...progress } }) },
    },
    {
      isDestroyed: () => true,
      webContents: { send: (channel, progress) => destroyedSent.push({ channel, progress: { ...progress } }) },
    },
  ];
  let fetchCalls = 0;
  let resolveFirst: ((response: Response) => void) | null = null;
  const firstResponse = new Promise<Response>((resolve) => {
    resolveFirst = resolve;
  });
  let thirdStarted = false;
  const seenUrls: string[] = [];

  setElectronTestState({
    windows,
    fetch: async (input, init) => {
      fetchCalls += 1;
      seenUrls.push(String(input));
      if (fetchCalls === 1) return await firstResponse;
      if (fetchCalls === 2) {
        return new Response(JSON.stringify({ message: 'retry-safe-error' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      thirdStarted = true;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = () => reject(new DOMException('aborted', 'AbortError'));
        if (signal?.aborted) rejectAbort();
        else signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    },
  });

  assert.equal(sync.startDataPlatformSkyboxSync(BASE_URL, editorRoot), true);
  const firstRunId = sync.getLatestDataPlatformSkyboxSyncProgress()?.runId;
  assert.equal(typeof firstRunId, 'string');
  assert.equal(sync.startDataPlatformSkyboxSync('https://ignored.example.test', path.join(editorRoot, 'ignored')), true);
  assert.equal(sync.getLatestDataPlatformSkyboxSyncProgress()?.runId, firstRunId);
  await waitFor(() => fetchCalls === 1);
  assert.equal(fetchCalls, 1, '重复 start 不得创建第二次查询');

  resolveFirst?.(new Response(JSON.stringify(createPageResponse([], { total: 0, pageNum: 1, pageSize: 100 })), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  await waitFor(() => sync.getLatestDataPlatformSkyboxSyncProgress()?.phase === 'completed');
  const completed = sync.getLatestDataPlatformSkyboxSyncProgress();
  assert.deepEqual({ completed: completed?.completed, total: completed?.total }, { completed: 0, total: 0 });
  assert.deepEqual(
    [...new Set(sent.map((item) => item.progress.phase))],
    ['querying', 'downloading', 'validating', 'promoting', 'completed'],
  );
  assert.ok(sent.every((item) => item.channel === 'data-platform:skyboxSyncProgress'));
  assert.equal(destroyedSent.length, 0);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sync.retryDataPlatformSkyboxSync(), true);
  await waitFor(() => sync.getLatestDataPlatformSkyboxSyncProgress()?.phase === 'failed');
  const failed = sync.getLatestDataPlatformSkyboxSyncProgress();
  assert.match(failed?.error ?? '', /503|retry-safe-error/);
  assert.doesNotMatch(failed?.error ?? '', /\n\s*at\s/);
  assert.ok(seenUrls[1].startsWith(new URL(BASE_URL).origin), 'retry 必须复用最后一次有效 context');

  await new Promise<void>((resolve) => setImmediate(resolve));
  sync.clearDataPlatformSkyboxSyncRetryContext();
  assert.equal(sync.retryDataPlatformSkyboxSync(), false);

  assert.equal(sync.startDataPlatformSkyboxSync(BASE_URL, editorRoot), true);
  await waitFor(() => thirdStarted);
  await sync.disposeDataPlatformSkyboxSync();
  assert.notEqual(sync.getLatestDataPlatformSkyboxSyncProgress()?.phase, 'completed');
  assert.equal(sync.startDataPlatformSkyboxSync(BASE_URL, editorRoot), false);
  await assertMissing(stagingRootFor(editorRoot, sync.getLatestDataPlatformSkyboxSyncProgress()?.runId ?? 'missing'));
});

test('实际流式下载字节超过 8 GiB 上界时立即失败并保持旧库不变', async (t) => {
  const sync = await loadSyncModule();
  const store = await loadSkyboxStoreModule();
  const editorRoot = await createEditorRoot(t, 'babylon-skybox-actual-limit-');
  const data = createHdrFixture('actual-limit', 39);
  const raw = createRawRecord({ id: '1', data });
  const request = singlePageRequest([raw]);
  const runId = 'actual-limit-run';
  const downloadFile: SyncDependencies['downloadFile'] = async (options) => {
    await fs.mkdir(path.dirname(options.destinationPath), { recursive: true });
    await fs.writeFile(options.destinationPath, data);
    options.onChunk?.(data);
    options.onBytes?.(8 * 1024 ** 3 + 1);
    return {
      bytes: data.byteLength,
      contentType: 'application/octet-stream',
      finalUrl: new URL(options.remoteUrl, `${options.baseUrl}/`).toString(),
    };
  };

  await assert.rejects(
    sync.executeDataPlatformSkyboxSync({
      baseUrl: BASE_URL,
      editorRoot,
      runId,
      dependencies: fixedDependencies(request.requestJson, downloadFile, store.validateSkyboxSourceFile),
    }),
    /8 GiB|8 GB|下载总量/,
  );

  await assertMissing(getDataPlatformSkyboxIndexPath(editorRoot));
  await assertMissing(stagingRootFor(editorRoot, runId));
});
