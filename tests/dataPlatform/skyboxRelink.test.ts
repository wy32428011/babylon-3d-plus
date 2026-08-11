import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectSkyboxAssetEntry } from '../../src/editor/assets/AssetDatabase.ts';
import type { SceneSkyboxSettings } from '../../src/editor/model/SceneDocument.ts';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';


const [{ createSceneSkyboxFromAsset, findOrphanedSkyboxForSettings, findSkyboxAssetForSettings }] =
  await importIsolatedTypeScriptModules<[
    typeof import('../../src/editor/assets/skyboxAssets'),
  ]>(['src/editor/assets/skyboxAssets.ts']);

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const RESOURCE_ID = '2052912068767571969';
const PACKAGE_PATH = String.raw`C:\Project\Assets\Skyboxes\factory.hdr`;
const SOURCE_PATH = String.raw`C:\Project\Assets\Skyboxes\factory.hdr\factory.hdr`;
const SOURCE_URL = `editor-asset://local/${encodeURIComponent(SOURCE_PATH)}`;

function createAsset(overrides: Partial<ProjectSkyboxAssetEntry> = {}): ProjectSkyboxAssetEntry {
  return {
    id: SOURCE_PATH,
    name: 'factory.hdr',
    displayName: 'factory',
    path: SOURCE_PATH,
    sourceUrl: SOURCE_URL,
    assetRevision: SHA_A,
    packagePath: PACKAGE_PATH,
    kind: 'skybox',
    libraryKind: 'skybox',
    format: 'hdr',
    fileSizeBytes: 1024,
    source: 'project',
    availability: 'active',
    ...overrides,
  };
}

function createSettings(overrides: Partial<SceneSkyboxSettings> = {}): SceneSkyboxSettings {
  return {
    packagePath: PACKAGE_PATH,
    sourcePath: SOURCE_PATH,
    sourceUrl: SOURCE_URL,
    assetRevision: SHA_A,
    format: 'hdr',
    rotationDegrees: 30,
    intensity: 1.5,
    resolution: 1024,
    ...overrides,
  };
}

test('稳定资源 ID 优先于错误路径和本地精确路径，只匹配 active 数据中台资源', () => {
  const settings = createSettings({
    dataPlatformResourceId: RESOURCE_ID,
    sourcePath: String.raw`D:\Old\wrong.hdr`,
    sourceUrl: `editor-asset://local/${encodeURIComponent(String.raw`D:\Old\wrong.hdr`)}`,
  });
  const localExactPath = createAsset({
    id: 'local-exact',
    path: settings.sourcePath,
    sourceUrl: settings.sourceUrl,
  });
  const remoteById = createAsset({
    id: `data-platform-skybox:${RESOURCE_ID}`,
    path: String.raw`E:\Synced\renamed.hdr\renamed.hdr`,
    sourceUrl: `editor-asset://local/${encodeURIComponent(String.raw`E:\Synced\renamed.hdr\renamed.hdr`)}`,
    packagePath: String.raw`E:\Synced\renamed.hdr`,
    source: 'data-platform',
    availability: 'active',
    dataPlatformResourceId: RESOURCE_ID,
    dataPlatformRevision: '9',
    fileSha256: SHA_A,
  });

  assert.equal(findSkyboxAssetForSettings(settings, [localExactPath, remoteById]), remoteById);
});

test('稳定资源 ID 为零个或多个候选时拒绝匹配且绝不回退路径', () => {
  const settings = createSettings({ dataPlatformResourceId: RESOURCE_ID });
  const exactLocal = createAsset({ id: 'local-exact' });
  const first = createAsset({
    id: `data-platform-skybox:${RESOURCE_ID}:1`,
    path: String.raw`E:\Remote\first.hdr\first.hdr`,
    sourceUrl: 'editor-asset://local/remote-first.hdr',
    source: 'data-platform',
    dataPlatformResourceId: RESOURCE_ID,
    dataPlatformRevision: '1',
    fileSha256: SHA_A,
  });
  const second = createAsset({
    id: `data-platform-skybox:${RESOURCE_ID}:2`,
    path: String.raw`F:\Remote\second.hdr\second.hdr`,
    sourceUrl: 'editor-asset://local/remote-second.hdr',
    source: 'data-platform',
    dataPlatformResourceId: RESOURCE_ID,
    dataPlatformRevision: '2',
    fileSha256: SHA_B,
  });

  assert.equal(findSkyboxAssetForSettings(settings, [exactLocal]), null);
  assert.equal(findSkyboxAssetForSettings(settings, [exactLocal, first, second]), null);
});

test('无稳定 ID 时先按规范化路径或 sourceUrl 唯一精确匹配，多个候选拒绝', () => {
  const settings = createSettings();
  const byPath = createAsset({
    id: 'path',
    path: 'c:/project/assets/skyboxes/FACTORY.hdr/factory.hdr',
    sourceUrl: 'editor-asset://local/path-only.hdr',
  });
  const byUrl = createAsset({
    id: 'url',
    path: String.raw`E:\Other\other.hdr`,
    sourceUrl: settings.sourceUrl,
  });

  assert.equal(findSkyboxAssetForSettings(settings, [byPath]), byPath);
  assert.equal(findSkyboxAssetForSettings(settings, [byUrl]), byUrl);
  assert.equal(findSkyboxAssetForSettings(settings, [byPath, byUrl]), null);
});

test('无稳定 ID 时按包目录主文件 portable key 兼容跨 Windows 路径，歧义拒绝', () => {
  const settings = createSettings({
    packagePath: String.raw`D:\Legacy\Skyboxes\factory.hdr`,
    sourcePath: String.raw`D:\Legacy\Skyboxes\factory.hdr\factory.hdr`,
    sourceUrl: 'editor-asset://local/legacy-factory.hdr',
  });
  const portable = createAsset({
    id: 'portable-1',
    packagePath: String.raw`E:\Workspace\Skyboxes\FACTORY.HDR`,
    path: String.raw`E:\Workspace\Skyboxes\FACTORY.HDR\FACTORY.HDR`,
    sourceUrl: 'editor-asset://local/portable-1.hdr',
  });
  const duplicate = createAsset({
    id: 'portable-2',
    packagePath: String.raw`F:\Workspace\factory.hdr`,
    path: String.raw`F:\Workspace\factory.hdr\factory.hdr`,
    sourceUrl: 'editor-asset://local/portable-2.hdr',
  });

  assert.equal(findSkyboxAssetForSettings(settings, [portable]), portable);
  assert.equal(findSkyboxAssetForSettings(settings, [portable, duplicate]), null);
});

test('选择本地资源主动清除旧 ID，选择 active 数据中台资源写入 trim 后 ID 并保留显示参数', () => {
  const current = createSettings({ dataPlatformResourceId: '77' });
  const currentSnapshot = structuredClone(current);
  const local = createAsset({ assetRevision: SHA_B });
  const remote = createAsset({
    id: `data-platform-skybox:${RESOURCE_ID}`,
    source: 'data-platform',
    dataPlatformResourceId: `  ${RESOURCE_ID}  `,
    dataPlatformRevision: '3',
    fileSha256: SHA_B,
    assetRevision: SHA_B,
  });
  const localSnapshot = structuredClone(local);
  const remoteSnapshot = structuredClone(remote);

  const localSettings = createSceneSkyboxFromAsset(local, current);
  const remoteSettings = createSceneSkyboxFromAsset(remote, current);

  assert.equal('dataPlatformResourceId' in localSettings, false);
  assert.equal(remoteSettings.dataPlatformResourceId, RESOURCE_ID);
  assert.equal(remoteSettings.assetRevision, SHA_B);
  assert.equal(remoteSettings.rotationDegrees, current.rotationDegrees);
  assert.equal(remoteSettings.intensity, current.intensity);
  assert.equal(remoteSettings.resolution, current.resolution);
  assert.deepEqual(current, currentSnapshot);
  assert.deepEqual(local, localSnapshot);
  assert.deepEqual(remote, remoteSnapshot);
});

test('远端仅改名或业务 revision 且 sha/path 不变时设置引用完全不变', () => {
  const asset = createAsset({
    id: `data-platform-skybox:${RESOURCE_ID}`,
    source: 'data-platform',
    dataPlatformResourceId: RESOURCE_ID,
    dataPlatformRevision: '1',
    fileSha256: SHA_A,
  });
  const current = createSceneSkyboxFromAsset(asset, createSettings({ rotationDegrees: 210, intensity: 2.4 }));
  const renamed = {
    ...asset,
    name: 'factory-renamed.hdr',
    displayName: 'factory renamed',
    dataPlatformRevision: '2',
  };

  assert.deepEqual(createSceneSkyboxFromAsset(renamed, current), current);
});


test('active 数据中台资源缺失、非法、继承或 accessor ID 时 fail-closed 且不执行 getter', () => {
  const baseRemote = {
    source: 'data-platform' as const,
    availability: 'active' as const,
    dataPlatformRevision: '1',
    fileSha256: SHA_A,
  };
  const missing = createAsset({ ...baseRemote });
  delete missing.dataPlatformResourceId;
  const invalid = createAsset({ ...baseRemote, dataPlatformResourceId: '01' });
  const inherited = createAsset({ ...baseRemote });
  delete inherited.dataPlatformResourceId;
  Object.setPrototypeOf(inherited, { dataPlatformResourceId: RESOURCE_ID });
  let getterReads = 0;
  const accessor = createAsset({ ...baseRemote });
  Object.defineProperty(accessor, 'dataPlatformResourceId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return RESOURCE_ID;
    },
  });

  for (const asset of [missing, invalid, inherited, accessor]) {
    assert.throws(() => createSceneSkyboxFromAsset(asset), /天空盒资源元数据无效/);
  }
  assert.equal(getterReads, 0);

  const nonEnumerable = createAsset({ ...baseRemote });
  Object.defineProperty(nonEnumerable, 'dataPlatformResourceId', {
    configurable: true,
    enumerable: false,
    value: RESOURCE_ID,
  });
  assert.equal(createSceneSkyboxFromAsset(nonEnumerable).dataPlatformResourceId, RESOURCE_ID);
});

test('orphaned 数据中台资源不可选择且不匹配，project 伪带稳定 ID 也不匹配', () => {
  const settings = createSettings({ dataPlatformResourceId: RESOURCE_ID });
  const orphaned = createAsset({
    id: `data-platform-skybox:${RESOURCE_ID}`,
    source: 'data-platform',
    availability: 'orphaned',
    dataPlatformResourceId: RESOURCE_ID,
    dataPlatformRevision: '1',
    fileSha256: SHA_A,
  });
  const fakeProject = createAsset({
    id: 'project-with-fake-id',
    source: 'project',
    dataPlatformResourceId: RESOURCE_ID,
  });

  assert.equal(findSkyboxAssetForSettings(settings, [orphaned, fakeProject]), null);
  assert.equal(findSkyboxAssetForSettings(createSettings(), [orphaned]), null);
  assert.throws(() => createSceneSkyboxFromAsset(orphaned), /天空盒资源元数据无效/);
});

test('稳定 ID 候选只读取自有数据属性，继承/accessor 均不匹配且 getter 不执行', () => {
  const settings = createSettings({ dataPlatformResourceId: RESOURCE_ID });
  const inheritedCandidate = createAsset({ source: 'data-platform' });
  delete inheritedCandidate.dataPlatformResourceId;
  Object.setPrototypeOf(inheritedCandidate, { dataPlatformResourceId: RESOURCE_ID });

  let getterReads = 0;
  const accessorCandidate = createAsset({ source: 'data-platform' });
  Object.defineProperty(accessorCandidate, 'dataPlatformResourceId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return RESOURCE_ID;
    },
  });

  assert.equal(findSkyboxAssetForSettings(settings, [inheritedCandidate]), null);
  assert.equal(findSkyboxAssetForSettings(settings, [accessorCandidate]), null);
  assert.equal(getterReads, 0);

  const accessorSettings = createSettings();
  Object.defineProperty(accessorSettings, 'dataPlatformResourceId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return RESOURCE_ID;
    },
  });
  assert.equal(findSkyboxAssetForSettings(accessorSettings, [createAsset({ id: 'exact-local' })]), null);
  assert.equal(getterReads, 0);
});

test('orphaned 天空盒只按场景稳定 ID 唯一匹配数据中台孤立缓存', () => {
  const settings = createSettings({
    dataPlatformResourceId: RESOURCE_ID,
    sourcePath: String.raw`D:\\Legacy\\renamed.hdr`,
    sourceUrl: 'editor-asset://local/legacy-renamed.hdr',
  });
  const matching = createAsset({
    id: `data-platform-skybox:${RESOURCE_ID}`,
    path: String.raw`E:\\Shared\\renamed.hdr\\renamed.hdr`,
    sourceUrl: 'editor-asset://local/shared-renamed.hdr',
    packagePath: String.raw`E:\\Shared\\renamed.hdr`,
    source: 'data-platform',
    availability: 'orphaned',
    dataPlatformResourceId: `  ${RESOURCE_ID}  `,
    dataPlatformRevision: '9',
    fileSha256: SHA_A,
  });
  const activeSameId = createAsset({
    id: 'active-same-id',
    source: 'data-platform',
    availability: 'active',
    dataPlatformResourceId: RESOURCE_ID,
    dataPlatformRevision: '9',
    fileSha256: SHA_A,
  });
  const projectSameId = createAsset({
    id: 'project-same-id',
    source: 'project',
    availability: 'orphaned',
    dataPlatformResourceId: RESOURCE_ID,
  });

  assert.equal(findOrphanedSkyboxForSettings(settings, [activeSameId, projectSameId, matching]), matching);
});

test('orphaned 天空盒稳定 ID 为零个或多个候选时拒绝匹配且不按旧路径或名称猜测', () => {
  const legacySettings = createSettings();
  const legacyNameMatch = createAsset({
    id: 'legacy-name-match',
    source: 'data-platform',
    availability: 'orphaned',
    dataPlatformResourceId: RESOURCE_ID,
    dataPlatformRevision: '1',
    fileSha256: SHA_A,
  });
  assert.equal(findOrphanedSkyboxForSettings(legacySettings, [legacyNameMatch]), null);

  const settings = createSettings({ dataPlatformResourceId: RESOURCE_ID });
  const first = createAsset({
    id: 'orphaned-first',
    source: 'data-platform',
    availability: 'orphaned',
    dataPlatformResourceId: RESOURCE_ID,
    dataPlatformRevision: '1',
    fileSha256: SHA_A,
  });
  const second = createAsset({
    id: 'orphaned-second',
    source: 'data-platform',
    availability: 'orphaned',
    dataPlatformResourceId: RESOURCE_ID,
    dataPlatformRevision: '2',
    fileSha256: SHA_B,
  });

  assert.equal(findOrphanedSkyboxForSettings(settings, []), null);
  assert.equal(findOrphanedSkyboxForSettings(settings, [first, second]), null);
});

test('orphaned 匹配只读取设置和候选的自有合法 ID，accessor getter 不执行', () => {
  let getterReads = 0;
  const accessorSettings = createSettings();
  Object.defineProperty(accessorSettings, 'dataPlatformResourceId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return RESOURCE_ID;
    },
  });
  const valid = createAsset({
    id: 'valid-orphaned',
    source: 'data-platform',
    availability: 'orphaned',
    dataPlatformResourceId: RESOURCE_ID,
    dataPlatformRevision: '1',
    fileSha256: SHA_A,
  });
  assert.equal(findOrphanedSkyboxForSettings(accessorSettings, [valid]), null);

  const settings = createSettings({ dataPlatformResourceId: RESOURCE_ID });
  const inherited = createAsset({ source: 'data-platform', availability: 'orphaned' });
  delete inherited.dataPlatformResourceId;
  Object.setPrototypeOf(inherited, { dataPlatformResourceId: RESOURCE_ID });
  const accessor = createAsset({ source: 'data-platform', availability: 'orphaned' });
  Object.defineProperty(accessor, 'dataPlatformResourceId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return RESOURCE_ID;
    },
  });
  const invalid = createAsset({
    source: 'data-platform',
    availability: 'orphaned',
    dataPlatformResourceId: '01',
  });

  assert.equal(findOrphanedSkyboxForSettings(settings, [inherited, accessor, invalid]), null);
  assert.equal(getterReads, 0);
});

test('extensionless 测试 bootstrap 清理后不影响 isolation none 的后续 import', async () => {
  await assert.rejects(
    import('../../src/editor/assets/modelAssetRelink'),
    /ERR_MODULE_NOT_FOUND|Cannot find module/,
  );
});
