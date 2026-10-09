import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import type { ProjectSkyboxAssetEntry } from '../../src/editor/assets/AssetDatabase.ts';

const server = await createServer({ configFile: false, logLevel: 'error',
  server: { watch: null }, optimizeDeps: { noDiscovery: true } });
test.after(() => server.close());
const { decodeSkyboxAssetDragPayload } = await server.ssrLoadModule('/src/editor/assets/AssetDatabase.ts');
const { createSkyboxLibraryItems } = await server.ssrLoadModule('/src/editor/assets/projectLibrary.ts');
const { createSceneSkyboxFromAsset } = await server.ssrLoadModule('/src/editor/assets/skyboxAssets.ts');

const hash = 'b35653ca75a00d75392649d29cd27001e5af79dcc6412aa557241bb3ecda1420';
function builtinPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'builtin-skybox:partly-cloudy-light',
    name: 'partly-cloudy-light.hdr',
    displayName: '多云天空（轻量）',
    path: 'C:/Editor/resources/builtin-skyboxes/partly-cloudy-light/partly-cloudy-light.hdr',
    packagePath: 'C:/Editor/resources/builtin-skyboxes/partly-cloudy-light',
    sourceUrl: 'editor-asset://local/C%3A%2FEditor%2Fresources%2Fbuiltin-skyboxes%2Fpartly-cloudy-light%2Fpartly-cloudy-light.hdr',
    assetRevision: hash,
    kind: 'skybox',
    libraryKind: 'skybox',
    format: 'hdr',
    fileSizeBytes: 1441554,
    source: 'builtin',
    availability: 'active',
    ...overrides,
  };
}

test('内置天空盒拖拽保持来源和资源哈希，并可创建天空盒设置', () => {
  const decoded = decodeSkyboxAssetDragPayload(JSON.stringify(builtinPayload()));
  assert.ok(decoded, '内置天空盒必须能从真实卡片拖拽载荷解码');
  assert.equal(decoded.source, 'builtin');
  assert.equal(decoded.assetRevision, hash);
  const settings = createSceneSkyboxFromAsset(decoded);
  assert.equal(settings.sourcePath, decoded.path);
  assert.equal(settings.assetRevision, hash);
  assert.equal(settings.format, 'hdr');
  assert.equal(settings.resolution, 512);
  assert.equal(settings.dataPlatformResourceId, undefined);
});

test('天空盒卡片明确显示内置来源，项目和中台资源仍保持原来源', () => {
  const builtin = builtinPayload() as unknown as ProjectSkyboxAssetEntry;
  const project = { ...builtin, id: 'project-local', source: 'project' } as ProjectSkyboxAssetEntry;
  const remote = { ...builtin, id: 'data-platform-skybox:123', source: 'data-platform' } as ProjectSkyboxAssetEntry;
  const items = createSkyboxLibraryItems([builtin, project, remote]);
  assert.equal(items.length, 3);
  assert.match(items[0].subtitle ?? '', /^内置 · HDR · /);
  assert.match(items[1].subtitle ?? '', /^项目本地 · HDR · /);
  assert.match(items[2].subtitle ?? '', /^数据中台 · HDR · /);
});

test('内置来源拒绝冒用中台元数据、普通项目ID或缺失哈希', () => {
  for (const overrides of [
    { dataPlatformResourceId: '123' },
    { dataPlatformRevision: '1' },
    { fileSha256: hash },
    { id: 'project-local' },
    { id: 'data-platform-skybox:123' },
    { assetRevision: 'local-revision' },
  ]) {
    assert.equal(decodeSkyboxAssetDragPayload(JSON.stringify(builtinPayload(overrides))), null);
  }
});
