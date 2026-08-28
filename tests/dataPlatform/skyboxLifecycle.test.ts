import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { createServer, type Plugin, type ViteDevServer } from 'vite';

type IpcHandler = (event: unknown, request?: unknown) => unknown;

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

type HarnessState = {
  appPath: string;
  userDataRoot: string;
  handlers: Map<string, IpcHandler>;
  binding: Record<string, unknown> | null;
  currentBinding: Record<string, unknown> | null;
  currentProjectRoot: string | null;
  currentSharedAssetRoot: string | null;
  currentSharedEnvironmentRoot: string | null;
  currentSharedSkyboxRoot: string | null;
  projectActivationFailure: Error | null;
  listAssetsFailure: Error | null;
  rememberRecentFailure: Error | null;
  events: string[];
  sharedAssetRoots: Array<string | null>;
  sharedEnvironmentRoots: Array<string | null>;
  sharedSkyboxRoots: Array<string | null>;
  modelStarts: Array<{ baseUrl: string; editorRoot: string }>;
  skyboxStarts: Array<{ baseUrl: string; editorRoot: string; contextKey: string | null }>;
  ipcSkyboxSyncCalls: Array<{ baseUrl: string; workspaceRoot: string }>;
  recentSkyboxSyncCalls: Array<{ baseUrl: string; workspaceRoot: string }>;
  recentSkyboxSyncPromise: Promise<boolean> | null;
  skyboxDisposePromise: Promise<void> | null;
  directoryPrepareGates: Map<string, Promise<void>>;
  networkCalls: number;
  listAssetsResult: {
    projectRoot: string | null;
    skyboxSyncContextKey: string | null;
    assets: unknown[];
    skyboxes: unknown[];
  };
};

const HARNESS_STATE_KEY = '__task4SkyboxLifecycleHarness';
let server: ViteDevServer;

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForEvent(state: HarnessState, event: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (state.events.includes(event)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待测试事件超时：${event}`);
}

function resetHarness(root: string): HarnessState {
  const state: HarnessState = {
    appPath: root,
    userDataRoot: root,
    handlers: new Map(),
    binding: null,
    currentBinding: null,
    currentProjectRoot: null,
    currentSharedAssetRoot: null,
    currentSharedEnvironmentRoot: null,
    currentSharedSkyboxRoot: null,
    projectActivationFailure: null,
    listAssetsFailure: null,
    rememberRecentFailure: null,
    events: [],
    sharedAssetRoots: [],
    sharedEnvironmentRoots: [],
    sharedSkyboxRoots: [],
    modelStarts: [],
    skyboxStarts: [],
    ipcSkyboxSyncCalls: [],
    recentSkyboxSyncCalls: [],
    recentSkyboxSyncPromise: null,
    skyboxDisposePromise: null,
    directoryPrepareGates: new Map(),
    networkCalls: 0,
    listAssetsResult: { projectRoot: root, skyboxSyncContextKey: null, assets: [], skyboxes: [] },
  };
  (globalThis as Record<string, unknown>)[HARNESS_STATE_KEY] = state;
  return state;
}

const harnessPlugin: Plugin = {
  name: 'task4-skybox-lifecycle-harness',
  enforce: 'pre',
  resolveId(source, importer) {
    const normalizedImporter = importer?.replace(/\\/g, '/') ?? '';

    if (normalizedImporter.includes('/electron/ipc/dataPlatformProjectService.ts')) {
      if (source === './assetRegistry.js') return '\0task4-asset-registry';
      if (source === './projectAssetStore.js') return '\0task4-project-store';
      if (source === './dataPlatformBindingStore.js') return '\0task4-binding-store';
      if (source === './dataPlatformModelIncrementalSync.js') return '\0task4-model-sync';
      if (source === './dataPlatformImageSync.js') return '\0task4-image-sync';
      if (source === './dataPlatformSkyboxSync.js') return '\0task4-skybox-sync';
      if (source === './dataPlatformTransfer.js') return '\0task4-transfer';
    }

    if (normalizedImporter.includes('/electron/ipc/projectIpc.ts')) {
      if (source === './projectAssetStore.js') return '\0task4-project-store';
      if (source === './dataPlatformBindingStore.js') return '\0task4-binding-store';
      if (source === './dataPlatformProjectService.js') return '\0task4-recent-project-service';
    }

    if (
      normalizedImporter.includes('/electron/ipc/dataPlatformIpc.ts')
      && source === './dataPlatformProjectService.js'
    ) {
      return '\0task4-ipc-project-service';
    }
    return null;
  },
  load(id) {
    const stateLookup = `globalThis[${JSON.stringify(HARNESS_STATE_KEY)}]`;
    if (id === '\0task4-asset-registry') {
      return `export const encodeAssetUrl = (filePath) => 'editor-asset://local/' + encodeURIComponent(filePath);`;
    }
    if (id === '\0task4-project-store') {
      return `
        import path from 'node:path';
        const getState = () => ${stateLookup};
        export async function activateProjectRoot(projectRoot) {
          getState().events.push('activateProject:' + projectRoot);
          return getState().listAssetsResult;
        }
        export async function ensureProjectDirectories(projectRoot) {
          const normalizedRoot = path.resolve(projectRoot);
          getState().events.push('ensureDirectories:' + normalizedRoot);
          const gate = getState().directoryPrepareGates.get(normalizedRoot);
          if (gate) await gate;
        }
        export const getProjectAssetIndexPath = (root) => path.join(root, '.babylon-editor', 'asset-index.json');
        export const getProjectModelsRoot = (root) => path.join(root, 'Assets', 'Models');
        export const getProjectEnvironmentsRoot = (root) => path.join(root, 'Assets', 'Environments');
        export async function rememberRecentSceneFile(filePath) {
          getState().events.push('rememberScene:' + filePath);
        }
        export async function rememberRecentProjectRoot(projectRoot) {
          getState().events.push('rememberRecent:' + projectRoot);
          if (getState().rememberRecentFailure) throw getState().rememberRecentFailure;
        }
        export async function getRecentWorkspaceStateSnapshot() { return { version: 1, projects: [], scenes: [] }; }
        export async function restoreRecentWorkspaceStateSnapshot() { getState().events.push('restoreRecentState'); }
        export function setSharedProjectAssetRoot(root) {
          getState().currentSharedAssetRoot = root;
          getState().sharedAssetRoots.push(root);
          getState().events.push('setAsset:' + root);
        }
        export function setSharedProjectEnvironmentRoot(root) {
          getState().currentSharedEnvironmentRoot = root;
          getState().sharedEnvironmentRoots.push(root);
          getState().events.push('setEnvironment:' + root);
        }
        export function setSharedProjectSkyboxRoot(root) {
          getState().currentSharedSkyboxRoot = root;
          getState().sharedSkyboxRoots.push(root);
          getState().events.push('setSkybox:' + root);
        }
        export async function writeProjectAssetIndex(root) {
          getState().events.push('writeIndex:' + root);
        }
        export async function assertRecentSceneFile(filePath) { return filePath; }
        export async function getRecentWorkspaces() { return { projects: [], scenes: [] }; }
        export async function listProjectAssets() {
          getState().events.push('listAssets');
          if (getState().listAssetsFailure) throw getState().listAssetsFailure;
          return { ...getState().listAssetsResult, projectRoot: getState().currentProjectRoot };
        }
        export async function validateRecentProjectRoot(projectRoot) {
          getState().events.push('validateRecent:' + projectRoot);
          return path.resolve(projectRoot);
        }
        export function getProjectAssetStoreStateSnapshot() {
          return {
            currentProjectRoot: getState().currentProjectRoot,
            sharedProjectAssetRoot: getState().currentSharedAssetRoot,
            sharedProjectEnvironmentRoot: getState().currentSharedEnvironmentRoot,
            sharedProjectSkyboxRoot: getState().currentSharedSkyboxRoot,
          };
        }
        export function restoreProjectAssetStoreState(snapshot) {
          getState().currentProjectRoot = snapshot.currentProjectRoot;
          getState().currentSharedAssetRoot = snapshot.sharedProjectAssetRoot;
          getState().currentSharedEnvironmentRoot = snapshot.sharedProjectEnvironmentRoot;
          getState().currentSharedSkyboxRoot = snapshot.sharedProjectSkyboxRoot;
          getState().events.push('restoreProjectState');
        }
        export async function commitRecentProjectActivation(projectRoot) {
          getState().events.push('commitRecent:' + projectRoot);
          if (getState().projectActivationFailure) throw getState().projectActivationFailure;
          getState().currentProjectRoot = path.resolve(projectRoot);
        }
        export async function openRecentProject(projectRoot) {
          getState().events.push('openRecent:' + projectRoot);
          return getState().listAssetsResult;
        }
        export async function removeRecentWorkspaceItem() {}
        export async function selectCurrentProjectRootWithDialog() { return null; }
      `;
    }
    if (id === '\0task4-binding-store') {
      return `
        import path from 'node:path';
        const getState = () => ${stateLookup};
        export function createDataPlatformBinding(input) { return { version: 1, ...input }; }
        export function getCurrentDataPlatformBinding() { return getState().currentBinding; }
        export async function readDataPlatformBinding() { return getState().binding; }
        export const resolveDataPlatformProjectRoot = (root, projectId) => path.resolve(root, 'Projects', projectId);
        export const resolveDataPlatformSharedResourcesRoot = (root) => path.resolve(root, 'SharedResources');
        export function resolveDataPlatformBindingWorkspaceRoot(projectRoot, metadata) {
          if (metadata?.workspaceRoot) return path.resolve(metadata.workspaceRoot);
          return path.dirname(path.dirname(path.resolve(projectRoot)));
        }
        export function resolveDataPlatformBindingSharedResourcesRoot(projectRoot, metadata) {
          return path.resolve(resolveDataPlatformBindingWorkspaceRoot(projectRoot, metadata), 'SharedResources');
        }
        export function setCurrentDataPlatformBinding(projectRoot, metadata) {
          getState().currentBinding = { projectRoot, metadata };
          getState().events.push('setCurrentBinding:' + projectRoot);
        }
        export async function writeDataPlatformBinding(projectRoot, metadata) {
          getState().events.push('writeBinding:' + projectRoot);
          return metadata;
        }
        export function clearCurrentDataPlatformBinding() {
          getState().currentBinding = null;
          getState().events.push('clearBinding');
        }
      `;
    }
    if (id === '\0task4-model-sync') {
      return `
        const getState = () => ${stateLookup};
        export function clearDataPlatformModelSyncRetryContext() { getState().events.push('clearModelRetry'); }
        export async function disposeDataPlatformModelSync() { getState().events.push('disposeModel'); }
        export function getLatestDataPlatformModelSyncProgress() { return null; }
        export function retryDataPlatformModelSync() { return false; }
        export function startDataPlatformModelSync(baseUrl, editorRoot) {
          getState().modelStarts.push({ baseUrl, editorRoot });
          getState().events.push('startModel:' + editorRoot);
          return true;
        }
      `;
    }
    if (id === '\0task4-image-sync') {
      return `
        const getState = () => ${stateLookup};
        export function clearDataPlatformImageSyncRetryContext() { getState().events.push('clearImageRetry'); }
        export async function disposeDataPlatformImageSync() { getState().events.push('disposeImage'); }
        export function getLatestDataPlatformImageSyncProgress() { return null; }
        export async function listSyncedImages() { return []; }
        export function retryDataPlatformImageSync() { return false; }
        export function startDataPlatformImageSync() { return false; }
      `;
    }
    if (id === '\0task4-skybox-sync') {
      return `
        const getState = () => ${stateLookup};
        export function clearDataPlatformSkyboxSyncRetryContext() { getState().events.push('clearSkyboxRetry'); }
        export async function disposeDataPlatformSkyboxSync() {
          getState().events.push('disposeSkybox');
          if (getState().skyboxDisposePromise) await getState().skyboxDisposePromise;
        }
        export function getLatestDataPlatformSkyboxSyncProgress() { return null; }
        export function retryDataPlatformSkyboxSync() { return false; }
        export function startDataPlatformSkyboxSync(baseUrl, editorRoot, contextKey = null) {
          getState().skyboxStarts.push({ baseUrl, editorRoot, contextKey });
          getState().events.push('startSkybox:' + editorRoot);
          return true;
        }
      `;
    }
    if (id === '\0task4-transfer') {
      return `
        export class DataPlatformRollbackError extends Error {}
        export async function assertDiskWriteCapacity() {}
        export function assertPathInside() {}
        export function isPathInside() { return true; }
        export const MAX_ARCHIVE_COMPRESSED_BYTES = 1024;
        export async function downloadRemoteFile() { throw new Error('unexpected download'); }
        export async function extractZipSecurely() { throw new Error('unexpected extract'); }
      `;
    }
    if (id === '\0task4-recent-project-service') {
      return `
        const getState = () => ${stateLookup};
        export function getCurrentDataPlatformSkyboxSyncContextKey() {
          return getState().currentBinding?.metadata?.projectId ?? null;
        }
        export function invalidateDataPlatformSkyboxSyncPrepareContext() {
          getState().events.push('invalidateSkyboxPrepare');
        }
        export function syncDataPlatformSkyboxesForWorkspace(baseUrl, workspaceRoot) {
          getState().recentSkyboxSyncCalls.push({ baseUrl, workspaceRoot });
          getState().events.push('recentSkyboxSync:' + workspaceRoot);
          return getState().recentSkyboxSyncPromise ?? Promise.resolve(true);
        }
      `;
    }
    if (id === '\0task4-ipc-project-service') {
      return `
        import path from 'node:path';
        const getState = () => ${stateLookup};
        export function clearDataPlatformProjectServiceRetryContext() {}
        export async function ensureWritableEditorRoot() {}
        export function getCurrentDataPlatformModelSyncProgress() { return null; }
        export function getCurrentDataPlatformImageSyncProgress() { return null; }
        export function getCurrentDataPlatformSkyboxSyncProgress() { return null; }
        export function getDataPlatformEditorRoot(root) { return root ? path.resolve(root) : getState().appPath; }
        export async function openDataPlatformProject() { throw new Error('unexpected open'); }
        export async function listSyncedImagesForWorkspace() { return []; }
        export function retryLatestDataPlatformModelSync() { return false; }
        export function retryLatestDataPlatformImageSync() { return false; }
        export function retryLatestDataPlatformSkyboxSync() { return false; }
        export async function syncDataPlatformImagesForWorkspace() { return false; }
        export async function syncDataPlatformModelsForWorkspace() { return false; }
        export async function syncDataPlatformSkyboxesForWorkspace(baseUrl, workspaceRoot) {
          getState().ipcSkyboxSyncCalls.push({ baseUrl, workspaceRoot });
          return true;
        }
      `;
    }
    return null;
  },
};

before(async () => {
  server = await createServer({
    appType: 'custom',
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    resolve: {
      alias: {
        electron: path.resolve(process.cwd(), 'tests/dataPlatform/fixtures/electronStub.mjs'),
        './modelPackageScanner.js': path.resolve(process.cwd(), 'tests/dataPlatform/fixtures/modelPackageScannerStub.mjs'),
        './dataPlatformEnvironmentIndex.js': path.resolve(process.cwd(), 'tests/dataPlatform/fixtures/dataPlatformEnvironmentIndexStub.mjs'),
        '../modelUnits.js': path.resolve(process.cwd(), 'tests/dataPlatform/fixtures/modelUnitsStub.mjs'),
      },
    },
    plugins: [harnessPlugin],
  });
});

after(async () => {
  delete (globalThis as Record<string, unknown>)[HARNESS_STATE_KEY];
  await server?.close();
});

test('共享类型、IPC 通道和两份 preload 保持天空盒同步契约一致', async () => {
  const [electronTypes, rendererTypes, ipcSource, preloadTs, preloadCts, homeSource] = await Promise.all([
    fs.readFile('electron/types.ts', 'utf8'),
    fs.readFile('src/vite-env.d.ts', 'utf8'),
    fs.readFile('electron/ipc/dataPlatformIpc.ts', 'utf8'),
    fs.readFile('electron/preload.ts', 'utf8'),
    fs.readFile('electron/preload.cts', 'utf8'),
    fs.readFile('src/editor/home/HomePage.tsx', 'utf8'),
  ]);

  for (const source of [electronTypes, rendererTypes]) {
    assert.match(source, /DataPlatformSkyboxSyncPhase[\s\S]*?'querying'[\s\S]*?'downloading'[\s\S]*?'validating'[\s\S]*?'promoting'[\s\S]*?'completed'[\s\S]*?'failed'/);
    assert.match(source, /DataPlatformSkyboxSyncProgress[\s\S]*?runId: string;[\s\S]*?contextKey: string \| null;[\s\S]*?completed: number;[\s\S]*?total: number;[\s\S]*?message: string;[\s\S]*?error: string \| null;/);
    assert.match(source, /skyboxSyncStarted: boolean;/);
  }

  for (const channel of [
    'data-platform:syncSkyboxes',
    'data-platform:retrySkyboxSync',
    'data-platform:getSkyboxSyncProgress',
  ]) {
    assert.match(ipcSource, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(ipcSource, /尚未配置数据中台地址。/);

  for (const preloadSource of [preloadTs, preloadCts]) {
    assert.match(preloadSource, /syncDataPlatformSkyboxes:[\s\S]*?invoke\('data-platform:syncSkyboxes'\)/);
    assert.match(preloadSource, /retryDataPlatformSkyboxSync:[\s\S]*?invoke\('data-platform:retrySkyboxSync'\)/);
    assert.match(preloadSource, /onDataPlatformSkyboxSyncProgress:[\s\S]*?ipcRenderer\.on\('data-platform:skyboxSyncProgress', listener\)/);
    assert.match(preloadSource, /invoke\('data-platform:getSkyboxSyncProgress'\)[\s\S]*?if \(active && payload\) handler\(payload\);[\s\S]*?catch\(\(\) => undefined\)/);
    assert.match(preloadSource, /active = false;[\s\S]*?removeListener\('data-platform:skyboxSyncProgress', listener\)/);
  }

  const bodyMarker = 'const dataPlatformDeepLinkHandlers';
  assert.equal(preloadTs.slice(preloadTs.indexOf(bodyMarker)), preloadCts.slice(preloadCts.indexOf(bodyMarker)));
  assert.match(homeSource, /result\.modelSyncStarted \|\| result\.skyboxSyncStarted/);
  assert.match(homeSource, /共享资源同步已开始/);
  assert.match(homeSource, /数据中台全局天空盒同步已在后台启动。/);
});

test('projectAssetStore 独立归一化共享天空盒根且不改变模型共享根', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task4-store-'));
  resetHarness(root);
  const store = await server.ssrLoadModule('/electron/ipc/projectAssetStore.ts') as {
    setSharedProjectAssetRoot(root: string | null): void;
    getSharedProjectAssetRoot(): string | null;
    setSharedProjectSkyboxRoot(root: string | null): void;
    getSharedProjectSkyboxRoot(): string | null;
  };

  const modelRoot = path.join(root, 'models');
  const skyboxRoot = path.join(root, 'nested', '..', 'skyboxes');
  store.setSharedProjectAssetRoot(modelRoot);
  store.setSharedProjectSkyboxRoot(skyboxRoot);

  assert.equal(store.getSharedProjectAssetRoot(), path.normalize(modelRoot));
  assert.equal(store.getSharedProjectSkyboxRoot(), path.normalize(skyboxRoot));
  store.setSharedProjectSkyboxRoot(null);
  assert.equal(store.getSharedProjectSkyboxRoot(), null);
  assert.equal(store.getSharedProjectAssetRoot(), path.normalize(modelRoot));
  store.setSharedProjectAssetRoot(null);
  await fs.rm(root, { recursive: true, force: true });
});

test('设置共享天空盒根后仍只列出当前项目本地天空盒，不把 DataPlatform 目录当普通包', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task4-local-skybox-'));
  resetHarness(root);
  const store = await server.ssrLoadModule('/electron/ipc/projectAssetStore.ts') as {
    setCurrentProjectRoot(root: string): void;
    setSharedProjectSkyboxRoot(root: string | null): void;
    getSharedProjectSkyboxRoot(): string | null;
    listProjectAssets(): Promise<{
      projectRoot: string | null;
      skyboxes: Array<{ path: string; packagePath: string }>;
    }>;
  };

  const projectRoot = path.join(root, 'project');
  const sharedRoot = path.join(root, 'SharedResources');
  const localPackageRoot = path.join(projectRoot, 'Assets', 'Skyboxes', 'local-skybox');
  const dataPlatformPackageRoot = path.join(sharedRoot, 'Assets', 'Skyboxes', 'DataPlatform-42');
  const hdrPayload = Buffer.concat([
    Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n', 'ascii'),
    Buffer.alloc(32, 1),
  ]);
  await Promise.all([
    fs.mkdir(localPackageRoot, { recursive: true }),
    fs.mkdir(dataPlatformPackageRoot, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(localPackageRoot, 'local.hdr'), hdrPayload),
    fs.writeFile(path.join(dataPlatformPackageRoot, 'remote.hdr'), hdrPayload),
  ]);

  store.setCurrentProjectRoot(projectRoot);
  store.setSharedProjectSkyboxRoot(sharedRoot);
  const result = await store.listProjectAssets();

  assert.equal(store.getSharedProjectSkyboxRoot(), path.normalize(sharedRoot));
  assert.deepEqual(result.skyboxes.map((asset) => path.basename(asset.path)), ['local.hdr']);
  assert.equal(result.skyboxes[0]?.packagePath, path.resolve(localPackageRoot));
  assert.equal(result.skyboxes.some((asset) => asset.packagePath.includes('DataPlatform-42')), false);

  store.setSharedProjectSkyboxRoot(null);
  await fs.rm(root, { recursive: true, force: true });
});

test('导入本地天空盒后复用共享合并逻辑并返回 active/orphaned 且完成授权', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-import-merged-skybox-'));
  resetHarness(root);
  const store = await server.ssrLoadModule('/electron/ipc/projectAssetStore.ts') as {
    setCurrentProjectRoot(root: string): void;
    setSharedProjectSkyboxRoot(root: string | null): void;
    importSkyboxFileIntoProject(sourceFilePath: string): Promise<{
      importedAsset: { path: string; source: string };
      skyboxes: Array<{ id: string; displayName: string; path: string; source: string }>;
      orphanedSkyboxes: Array<{ id: string; path: string; availability: string }>;
    }>;
  };
  const registry = await server.ssrLoadModule('/electron/ipc/assetRegistry.ts') as {
    isAuthorizedAssetFile(filePath: string): boolean;
  };

  const projectRoot = path.join(root, 'project');
  const sharedRoot = path.join(root, 'SharedResources');
  const sourceRoot = path.join(root, 'source');
  const sourceFilePath = path.join(sourceRoot, 'same-name.hdr');
  const hdrPayload = Buffer.concat([
    Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n', 'ascii'),
    Buffer.alloc(32, 1),
  ]);
  const createEntry = (resourceId: string, status: 'active' | 'orphaned') => ({
    resourceId,
    displayName: status === 'active' ? 'same-name' : '已删除天空盒',
    relativePath: `Assets/Skyboxes/DataPlatform/Skybox-${resourceId}/skybox.hdr`,
    format: 'hdr',
    fileSizeBytes: hdrPayload.length,
    sha256: resourceId.padStart(64, '0'),
    revision: resourceId,
    status,
    syncedAt: '2026-08-11T12:00:00Z',
  });
  const activeEntry = createEntry('42', 'active');
  const orphanedEntry = createEntry('43', 'orphaned');
  const missingEntry = createEntry('44', 'active');
  const activePath = path.join(sharedRoot, ...activeEntry.relativePath.split('/'));
  const orphanedPath = path.join(sharedRoot, ...orphanedEntry.relativePath.split('/'));
  await Promise.all([
    fs.mkdir(sourceRoot, { recursive: true }),
    fs.mkdir(path.dirname(activePath), { recursive: true }),
    fs.mkdir(path.dirname(orphanedPath), { recursive: true }),
    fs.mkdir(path.join(sharedRoot, '.babylon-editor'), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(sourceFilePath, hdrPayload),
    fs.writeFile(activePath, hdrPayload),
    fs.writeFile(orphanedPath, hdrPayload),
    fs.writeFile(
      path.join(sharedRoot, '.babylon-editor', 'data-platform-skybox-index.json'),
      `${JSON.stringify({ version: 1, entries: [activeEntry, orphanedEntry, missingEntry] }, null, 2)}\n`,
      'utf8',
    ),
  ]);

  store.setCurrentProjectRoot(projectRoot);
  store.setSharedProjectSkyboxRoot(sharedRoot);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(' '));
  try {
    const result = await store.importSkyboxFileIntoProject(sourceFilePath);

    assert.equal(result.importedAsset.source, 'project');
    assert.deepEqual(result.skyboxes.map((asset) => asset.source), ['project', 'data-platform']);
    assert.deepEqual(result.skyboxes.map((asset) => asset.displayName), ['same-name', 'same-name']);
    assert.equal(result.skyboxes[0].path, result.importedAsset.path);
    assert.deepEqual(result.orphanedSkyboxes.map((asset) => asset.id), ['data-platform-skybox:43']);
    assert.equal(result.orphanedSkyboxes[0].availability, 'orphaned');
    assert.equal(registry.isAuthorizedAssetFile(result.importedAsset.path), true);
    assert.equal(registry.isAuthorizedAssetFile(activePath), true);
    assert.equal(registry.isAuthorizedAssetFile(orphanedPath), true);
    assert.ok(warnings.some((warning) => warning.includes('44') && warning.includes('缺失')));
  } finally {
    console.warn = originalWarn;
    store.setSharedProjectSkyboxRoot(null);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('无效 recent 项目打开失败时保持原 project 与 shared roots 状态', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task4-invalid-recent-'));
  resetHarness(root);
  const store = await server.ssrLoadModule('/electron/ipc/projectAssetStore.ts') as {
    setCurrentProjectRoot(root: string): void;
    getCurrentProjectRoot(): string | null;
    setSharedProjectAssetRoot(root: string | null): void;
    getSharedProjectAssetRoot(): string | null;
    setSharedProjectSkyboxRoot(root: string | null): void;
    getSharedProjectSkyboxRoot(): string | null;
    openRecentProject(root: string): Promise<unknown>;
  };

  const previousProjectRoot = path.join(root, 'previous-project');
  const previousAssetRoot = path.join(root, 'previous-assets');
  const previousSkyboxRoot = path.join(root, 'previous-skyboxes');
  await fs.mkdir(previousProjectRoot, { recursive: true });
  store.setCurrentProjectRoot(previousProjectRoot);
  store.setSharedProjectAssetRoot(previousAssetRoot);
  store.setSharedProjectSkyboxRoot(previousSkyboxRoot);

  await assert.rejects(
    store.openRecentProject(path.join(root, 'missing-project')),
    /只能打开最近记录中的项目目录。/,
  );

  assert.equal(store.getCurrentProjectRoot(), path.normalize(previousProjectRoot));
  assert.equal(store.getSharedProjectAssetRoot(), path.normalize(previousAssetRoot));
  assert.equal(store.getSharedProjectSkyboxRoot(), path.normalize(previousSkyboxRoot));

  store.setSharedProjectAssetRoot(null);
  store.setSharedProjectSkyboxRoot(null);
  await fs.rm(root, { recursive: true, force: true });
});

test('合法本地 B 激活不读取旧项目 A 的损坏 shared 模型索引', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task4-recent-isolation-'));
  resetHarness(root);
  const store = await server.ssrLoadModule('/electron/ipc/projectAssetStore.ts') as {
    setCurrentProjectRoot(root: string): void;
    setSharedProjectAssetRoot(root: string | null): void;
    setSharedProjectSkyboxRoot(root: string | null): void;
    rememberRecentProjectRoot(root: string): Promise<void>;
    openRecentProject(root: string): Promise<{ projectRoot: string | null; assets: unknown[] }>;
  };

  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const sharedA = path.join(root, 'shared-a');
  await Promise.all([
    fs.mkdir(projectA, { recursive: true }),
    fs.mkdir(projectB, { recursive: true }),
    fs.mkdir(path.join(sharedA, '.babylon-editor'), { recursive: true }),
  ]);
  await fs.writeFile(path.join(sharedA, '.babylon-editor', 'asset-index.json'), '{broken', 'utf8');
  await store.rememberRecentProjectRoot(projectB);
  store.setCurrentProjectRoot(projectA);
  store.setSharedProjectAssetRoot(sharedA);
  store.setSharedProjectSkyboxRoot(sharedA);

  const result = await store.openRecentProject(projectB);
  assert.equal(result.projectRoot, path.normalize(projectB));
  assert.deepEqual(result.assets, []);

  await fs.rm(root, { recursive: true, force: true });
});

test('B 索引损坏失败后重启仍加载 A 且 recent-workspaces 顺序不变', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task4-recent-restart-'));
  resetHarness(root);
  type StoreModule = {
    setCurrentProjectRoot(root: string): void;
    setSharedProjectAssetRoot(root: string | null): void;
    setSharedProjectSkyboxRoot(root: string | null): void;
    rememberRecentProjectRoot(root: string): Promise<void>;
    getRecentWorkspaces(): Promise<{ projects: Array<{ projectRoot: string }> }>;
    openRecentProject(root: string): Promise<unknown>;
    listProjectAssets(): Promise<{ projectRoot: string | null }>;
  };
  const store = await server.ssrLoadModule('/electron/ipc/projectAssetStore.ts') as StoreModule;
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  await Promise.all([
    fs.mkdir(projectA, { recursive: true }),
    fs.mkdir(path.join(projectB, '.babylon-editor'), { recursive: true }),
  ]);
  await fs.writeFile(path.join(projectB, '.babylon-editor', 'asset-index.json'), '{broken', 'utf8');
  await store.rememberRecentProjectRoot(projectB);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  await store.rememberRecentProjectRoot(projectA);
  store.setCurrentProjectRoot(projectA);
  store.setSharedProjectAssetRoot(null);
  store.setSharedProjectSkyboxRoot(null);
  const beforeOrder = (await store.getRecentWorkspaces()).projects.map((entry) => entry.projectRoot);

  await assert.rejects(store.openRecentProject(projectB), /项目资产索引格式不正确。/);

  const restarted = await server.ssrLoadModule(`/electron/ipc/projectAssetStore.ts?restart=${Date.now()}`) as StoreModule;
  assert.equal((await restarted.listProjectAssets()).projectRoot, path.normalize(projectA));
  const afterOrder = (await restarted.getRecentWorkspaces()).projects.map((entry) => entry.projectRoot);
  assert.deepEqual(afterOrder, beforeOrder);

  await fs.rm(root, { recursive: true, force: true });
});

test('天空盒 prepare 在项目切换与 dispose 竞态中失效并被等待，项目打开仍不阻塞网络同步', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task4-service-'));
  const state = resetHarness(root);
  const service = await server.ssrLoadModule('/electron/ipc/dataPlatformProjectService.ts') as {
    syncDataPlatformSkyboxesForWorkspace(baseUrl: string, workspaceRoot: string): Promise<boolean>;
    openDataPlatformProject(project: Record<string, unknown>, baseUrl: string, workspaceRoot: string): Promise<Record<string, unknown>>;
    disposeDataPlatformProjectTasks(): Promise<void>;
  };

  const baseUrl = 'https://platform.example.test';
  const workspaceRoot = path.join(root, 'workspace');
  const sharedRoot = path.resolve(workspaceRoot, 'SharedResources');
  assert.equal(await service.syncDataPlatformSkyboxesForWorkspace(baseUrl, workspaceRoot), true);
  assert.deepEqual(state.sharedSkyboxRoots, [sharedRoot]);
  assert.deepEqual(state.skyboxStarts, [{ baseUrl, editorRoot: sharedRoot, contextKey: null }]);
  assert.equal(state.currentBinding, null);

  state.events.length = 0;
  state.sharedSkyboxRoots.length = 0;
  state.skyboxStarts.length = 0;
  const staleBaseUrl = 'https://stale.example.test';
  const staleWorkspaceRoot = path.join(root, 'stale-workspace');
  const staleSharedRoot = path.resolve(staleWorkspaceRoot, 'SharedResources');
  const stalePrepareGate = createDeferred();
  state.directoryPrepareGates.set(staleSharedRoot, stalePrepareGate.promise);
  const stalePrepare = service.syncDataPlatformSkyboxesForWorkspace(staleBaseUrl, staleWorkspaceRoot);
  await waitForEvent(state, `ensureDirectories:${staleSharedRoot}`);

  const currentBaseUrl = 'https://current.example.test';
  const currentWorkspaceRoot = path.join(root, 'current-workspace');
  const currentSharedRoot = path.resolve(currentWorkspaceRoot, 'SharedResources');
  assert.equal(await service.syncDataPlatformSkyboxesForWorkspace(currentBaseUrl, currentWorkspaceRoot), true);
  assert.deepEqual(state.sharedSkyboxRoots, [currentSharedRoot]);
  assert.deepEqual(state.skyboxStarts, [{
    baseUrl: currentBaseUrl,
    editorRoot: currentSharedRoot,
    contextKey: null,
  }]);

  stalePrepareGate.resolve();
  assert.equal(await stalePrepare, false);
  assert.deepEqual(state.sharedSkyboxRoots, [currentSharedRoot]);
  assert.equal(state.skyboxStarts.some((entry) => entry.baseUrl === staleBaseUrl), false);
  state.directoryPrepareGates.delete(staleSharedRoot);

  state.events.length = 0;
  state.sharedSkyboxRoots.length = 0;
  state.modelStarts.length = 0;
  state.skyboxStarts.length = 0;
  const project = {
    id: '42',
    projectName: '测试项目',
    sceneCount: 0,
    screenCount: 0,
    modelCount: 0,
    envModelCount: 0,
    comboModelCount: 0,
    poiCount: 0,
    chartCount: 0,
    themeCount: 0,
    latestEditorProjectId: null,
    latestEditorProjectVersionId: null,
    latestEditorProjectVersionNumber: null,
    latestEditorProjectName: null,
    latestEditorProjectPackageUrl: null,
    latestEditorProjectPackageFileName: null,
    currentResourceRevision: '0',
    publishedResourceRevision: '0',
    digitalTwinStatus: null,
    onlineDigitalTwinVersionId: null,
    onlineDigitalTwinVersionNumber: null,
    onlineDigitalTwinPublishId: null,
    onlineProjectPublishId: null,
    digitalTwinStableUrl: null,
    digitalTwinReleaseUrl: null,
    digitalTwinLastPublishedAt: null,
    updatedAt: null,
  };

  const openResult = await service.openDataPlatformProject(project, baseUrl, workspaceRoot);
  assert.equal(openResult.modelSyncStarted, true);
  assert.equal(openResult.skyboxSyncStarted, true);
  assert.equal(state.networkCalls, 0);
  assert.ok(state.events.indexOf(`writeBinding:${path.resolve(workspaceRoot, 'Projects', '42')}`) < state.events.indexOf(`setSkybox:${sharedRoot}`));
  assert.ok(state.events.indexOf(`setSkybox:${sharedRoot}`) < state.events.indexOf(`startSkybox:${sharedRoot}`));
  assert.match(state.skyboxStarts.at(-1)?.contextKey ?? '', /^[a-f0-9]{64}$/);

  state.events.length = 0;
  state.sharedSkyboxRoots.length = 0;
  state.skyboxStarts.length = 0;
  state.currentBinding = null;
  const disposeWorkspaceRoot = path.join(root, 'dispose-workspace');
  const disposeSharedRoot = path.resolve(disposeWorkspaceRoot, 'SharedResources');
  const disposePrepareGate = createDeferred();
  const skyboxDisposeGate = createDeferred();
  state.directoryPrepareGates.set(disposeSharedRoot, disposePrepareGate.promise);
  state.skyboxDisposePromise = skyboxDisposeGate.promise;
  const disposePrepare = service.syncDataPlatformSkyboxesForWorkspace(
    'https://dispose.example.test',
    disposeWorkspaceRoot,
  );
  await waitForEvent(state, `ensureDirectories:${disposeSharedRoot}`);

  let disposed = false;
  const disposePromise = service.disposeDataPlatformProjectTasks().then(() => {
    disposed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposed, false);
  assert.equal(state.events.includes('disposeModel'), false);

  disposePrepareGate.resolve();
  assert.equal(await disposePrepare, false);
  await waitForEvent(state, 'disposeSkybox');
  assert.equal(disposed, false);
  assert.deepEqual(state.events.slice(-3), ['disposeModel', 'disposeImage', 'disposeSkybox']);
  assert.equal(state.sharedSkyboxRoots.includes(disposeSharedRoot), false);
  assert.equal(state.skyboxStarts.some((entry) => entry.baseUrl === 'https://dispose.example.test'), false);

  skyboxDisposeGate.resolve();
  await disposePromise;
  assert.equal(disposed, true);
  await fs.rm(root, { recursive: true, force: true });
});

test('数据中台天空盒 IPC 无配置时报错，有配置时使用 workspaceRoot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task4-ipc-'));
  const state = resetHarness(root);
  const ipcModule = await server.ssrLoadModule('/electron/ipc/dataPlatformIpc.ts') as {
    registerDataPlatformIpc(): void;
  };
  ipcModule.registerDataPlatformIpc();

  const handler = state.handlers.get('data-platform:syncSkyboxes');
  assert.ok(handler);
  await assert.rejects(Promise.resolve(handler(undefined)), /尚未配置数据中台地址。/);

  const workspaceRoot = path.join(root, 'configured-workspace');
  await fs.writeFile(
    path.join(root, 'data-platform-config.json'),
    `${JSON.stringify({ version: 2, baseUrl: 'https://platform.example.test', workspaceRoot }, null, 2)}\n`,
    'utf8',
  );
  assert.equal(await handler(undefined), true);
  assert.deepEqual(state.ipcSkyboxSyncCalls, [{
    baseUrl: 'https://platform.example.test',
    workspaceRoot: path.resolve(workspaceRoot),
  }]);
  assert.equal(state.networkCalls, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test('recent 激活持久化或列表失败时恢复 project/shared roots/binding 快照', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task4-recent-rollback-'));
  const state = resetHarness(root);
  const projectIpc = await server.ssrLoadModule('/electron/ipc/projectIpc.ts') as {
    registerProjectIpc(): void;
  };
  projectIpc.registerProjectIpc();
  const openHandler = state.handlers.get('project:openRecent');
  const listHandler = state.handlers.get('project:listAssets');
  assert.ok(openHandler);
  assert.ok(listHandler);

  const projectA = path.resolve(root, 'project-a');
  const projectB = path.resolve(root, 'project-b');
  const sharedAssetA = path.resolve(root, 'shared-models-a');
  const sharedSkyboxA = path.resolve(root, 'shared-skyboxes-a');
  const bindingA = {
    projectRoot: projectA,
    metadata: {
      version: 1,
      baseUrl: 'https://a.example.test',
      projectId: '1',
      projectName: 'A',
      editorProjectId: null,
      latestVersionId: null,
      latestVersionNumber: null,
      resourceRevision: '0',
      entryScenePath: null,
      syncedAt: '2026-08-11T00:00:00.000Z',
    },
  };
  const assertSnapshotRestored = async (): Promise<void> => {
    assert.equal(state.currentProjectRoot, projectA);
    assert.equal(state.currentSharedAssetRoot, sharedAssetA);
    assert.equal(state.currentSharedSkyboxRoot, sharedSkyboxA);
    assert.deepEqual(state.currentBinding, bindingA);
    const listed = await listHandler(undefined) as { projectRoot: string | null };
    assert.equal(listed.projectRoot, projectA);
  };
  const resetSnapshot = (): void => {
    state.currentProjectRoot = projectA;
    state.currentSharedAssetRoot = sharedAssetA;
    state.currentSharedSkyboxRoot = sharedSkyboxA;
    state.currentBinding = structuredClone(bindingA);
    state.binding = null;
    state.listAssetsFailure = null;
    state.projectActivationFailure = null;
    state.rememberRecentFailure = null;
  };

  resetSnapshot();
  state.projectActivationFailure = new Error('persist failed');
  await assert.rejects(Promise.resolve(openHandler(undefined, { projectRoot: projectB })), /persist failed/);
  state.projectActivationFailure = null;
  await assertSnapshotRestored();

  resetSnapshot();
  state.listAssetsFailure = new Error('list failed');
  await assert.rejects(Promise.resolve(openHandler(undefined, { projectRoot: projectB })), /list failed/);
  state.listAssetsFailure = null;
  await assertSnapshotRestored();

  resetSnapshot();
  state.rememberRecentFailure = new Error('remember failed');
  await assert.rejects(Promise.resolve(openHandler(undefined, { projectRoot: projectB })), /remember failed/);
  state.rememberRecentFailure = null;
  await assertSnapshotRestored();
  assert.ok(state.events.includes('restoreRecentState'));

  await fs.rm(root, { recursive: true, force: true });
});

test('recent 普通项目不启动网络同步，binding 项目挂载共享根并后台启动天空盒', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task4-recent-'));
  const state = resetHarness(root);
  const projectIpc = await server.ssrLoadModule('/electron/ipc/projectIpc.ts') as {
    registerProjectIpc(): void;
  };
  projectIpc.registerProjectIpc();
  const handler = state.handlers.get('project:openRecent');
  assert.ok(handler);

  const localRoot = path.join(root, 'local-project');
  await handler(undefined, { projectRoot: localRoot });
  assert.equal(state.recentSkyboxSyncCalls.length, 0);
  assert.equal(state.sharedSkyboxRoots.at(-1), null);
  assert.ok(state.events.indexOf(`validateRecent:${localRoot}`) < state.events.indexOf('invalidateSkyboxPrepare'));
  assert.ok(state.events.indexOf('invalidateSkyboxPrepare') < state.events.indexOf('clearBinding'));

  state.events.length = 0;
  state.sharedAssetRoots.length = 0;
  state.sharedSkyboxRoots.length = 0;
  const workspaceRoot = path.join(root, 'workspace');
  const projectRoot = path.join(workspaceRoot, 'Projects', '42');
  const sharedRoot = path.resolve(workspaceRoot, 'SharedResources');
  state.binding = {
    version: 1,
    baseUrl: 'https://platform.example.test',
    projectId: '42',
    projectName: '绑定项目',
    editorProjectId: null,
    latestVersionId: null,
    latestVersionNumber: null,
    resourceRevision: '0',
    entryScenePath: null,
    syncedAt: '2026-08-11T00:00:00.000Z',
  };
  const syncGate = createDeferred();
  state.recentSkyboxSyncPromise = syncGate.promise.then(() => true);

  const result = await Promise.race([
    Promise.resolve(handler(undefined, { projectRoot })).then((value) => ({ kind: 'result' as const, value })),
    new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 100)),
  ]);
  assert.equal(result.kind, 'result');
  assert.deepEqual(state.sharedAssetRoots, [null, sharedRoot]);
  assert.deepEqual(state.sharedSkyboxRoots, [null, sharedRoot]);
  assert.deepEqual(state.recentSkyboxSyncCalls, [{
    baseUrl: 'https://platform.example.test',
    workspaceRoot: path.resolve(workspaceRoot),
  }]);
  assert.ok(state.events.indexOf('invalidateSkyboxPrepare') < state.events.indexOf(`setAsset:${sharedRoot}`));
  assert.ok(state.events.indexOf(`setAsset:${sharedRoot}`) < state.events.indexOf(`setSkybox:${sharedRoot}`));
  assert.ok(state.events.indexOf(`setSkybox:${sharedRoot}`) < state.events.indexOf('listAssets'));
  assert.ok(state.events.indexOf('listAssets') < state.events.indexOf(`rememberRecent:${projectRoot}`));
  assert.ok(state.events.indexOf(`rememberRecent:${projectRoot}`) < state.events.indexOf(`setCurrentBinding:${projectRoot}`));
  assert.ok(state.events.indexOf(`setCurrentBinding:${projectRoot}`) < state.events.indexOf(`recentSkyboxSync:${path.resolve(workspaceRoot)}`));
  syncGate.resolve();
  await fs.rm(root, { recursive: true, force: true });
});
