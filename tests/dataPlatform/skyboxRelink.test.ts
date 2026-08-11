import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

import type { ProjectSkyboxAssetEntry } from '../../src/editor/assets/AssetDatabase.ts';
import type { SceneSkyboxSettings } from '../../src/editor/model/SceneDocument.ts';

function registerExtensionlessTypeScriptResolver(): void {
  const loaderSource = `
    import { existsSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';

    export async function resolve(specifier, context, nextResolve) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
        const targetUrl = new URL(specifier, context.parentURL);
        if (!/\\.[^/]+$/.test(targetUrl.pathname)) {
          for (const extension of ['.js', '.ts']) {
            const candidate = new URL(targetUrl.href + extension);
            if (existsSync(fileURLToPath(candidate))) return nextResolve(specifier + extension, context);
          }
        }
      }
      return nextResolve(specifier, context);
    }

    export async function load(url, context, nextLoad) {
      if (/\\.(png|jpe?g|webp|gif|svg|glb|gltf)$/.test(new URL(url).pathname)) {
        return { format: 'module', source: 'export default "";', shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  `;
  register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);
}

registerExtensionlessTypeScriptResolver();

const { createSceneSkyboxFromAsset, findSkyboxAssetForSettings } = await import(
  '../../src/editor/assets/skyboxAssets'
);

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
    source: 'data-platform',
    dataPlatformResourceId: RESOURCE_ID,
    dataPlatformRevision: '1',
    fileSha256: SHA_A,
  });
  const second = createAsset({
    id: `data-platform-skybox:${RESOURCE_ID}:2`,
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
