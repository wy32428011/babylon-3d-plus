import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// 新客户端接入 v3 后，继续执行实现前冻结的旧客户端源；拒绝合同不能改成新客户端成功。
const repository = fileURLToPath(new URL('../../', import.meta.url));
const fixtureBytes = readFileSync(new URL('./fixtures/phase2GammaLegacyClient.json', import.meta.url));
const frozen = JSON.parse(fixtureBytes);
const frozenModules = new Map(frozen.modules.map(module => [new URL('../../' + module.path, import.meta.url).href, module]));
const loadedFrozen = new Set();
for (const module of frozen.modules) assert.equal(createHash('sha256').update(module.source).digest('hex'), module.sha256);
assert.equal(frozen.modules.find(module => module.path === 'electron/shared/sceneLightingConfig.ts').sha256, '7dfc6d1e9d85a58c769f75e4b68b1cc297eb957768d57acef719e11436e654ca');
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (/^@babylonjs\/(?:core|loaders)\//.test(specifier) && !specifier.endsWith('.js')) return next(specifier + '.js', context);
  if (specifier.startsWith('.') && context.parentURL?.startsWith(new URL('../../', import.meta.url).href)
    && !context.parentURL.includes('/node_modules/')) {
    const target = new URL(specifier, context.parentURL);
    const candidates = specifier.endsWith('.js') ? [target.href.slice(0, -3) + '.ts']
      : path.extname(target.pathname) ? [] : [target.href + '.ts', target.href + '.tsx'];
    for (const candidate of candidates) if (existsSync(new URL(candidate))) return next(candidate, context);
  }
  return next(specifier, context);
}, load(url, context, next) {
  const legacy = frozenModules.get(url);
  if (legacy) {
    loadedFrozen.add(legacy.path);
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(legacy.source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    } }).outputText };
  }
  // 与 Vite 的静态图片导入一样只提供资源 URL；本测试不使用或解码这些无关 UI 图片。
  if (url.startsWith(new URL('../../src/', import.meta.url).href) && /\.(?:png|jpg|svg)$/.test(url)) {
    return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
  }
  return next(url, context);
} });
let config, data, serializer, transport, model, signature;
try {
  [config, data, serializer, transport, model, signature] = await Promise.all([
    import('../../electron/shared/sceneLightingConfig.ts'),
    import('../../electron/shared/sceneLightingBakeData.ts'),
    import('../../src/editor/project/SceneSerializer.ts'),
    import('../../electron/ipc/sceneLightingBakeResources.ts'),
    import('../../src/editor/model/SceneDocument.ts'),
    import('../../electron/shared/sceneLightingBakeContract.ts'),
  ]);
} finally { hooks.deregister(); }

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-codec-contract-'));
const projectRoot = path.join(root, 'original');
const jobRoot = path.join(projectRoot, 'Assets', 'LightingBakes', 'codec-fixture');
await fs.mkdir(jobRoot, { recursive: true });
// 1×1 PNG 文件 fixture；本测试只核文件/配置合同，不执行图像解码或宣称 GPU 验收。
const contents = [
  ['geometry', 'geometry', 'mesh.json', Buffer.from('{"version":1,"positions":[0,0,0,1,0,0,0,1,0],"indices":[0,1,2]}')],
  ['lightmap', 'lightmap', 'map.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')],
  ['probes', 'probes', 'probes.json', Buffer.from('{"version":1,"probes":[]}')],
];
const assets = [];
for (const [id, kind, filename, bytes] of contents) {
  const destination = path.join(jobRoot, filename);
  await fs.writeFile(destination, bytes);
  assets.push({ id, kind, url: 'editor-asset://local/' + encodeURIComponent(destination), byteLength: bytes.length,
    sha256: sha(bytes), ...(kind === 'lightmap' ? { rgbmRange: 8 } : {}) });
}
const scene = model.createEmptySceneDocument('Phase 2 codec compatibility fixture');
scene.id = 'scene_codec_fixture';
const cube = model.createMeshEntity('cube');
cube.id = 'entity_codec_fixture';
scene.entityIds = [cube.id]; scene.entities = { [cube.id]: cube };
scene.sceneSettings.lighting = config.normalizeSceneLightingConfig(undefined);
scene.sceneSettings.lighting.result = { version: 1, signature: signature.getSceneLightingBakeSignature(scene),
  createdAt: '2026-10-25T00:00:00Z', engineVersion: 'compatibility-fixture', assets,
  surfaces: [{ key: `${cube.id}/root`, entityId: cube.id, nodeKey: 'root', geometryAssetId: 'geometry', lightmapAssetId: 'lightmap' }],
  probeAssetId: 'probes', statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 0, textureBytes: 4, durationMs: 0 } };
// 以真正序列化器产出的单位/场景外壳作为基线，避免手写外壳造成无关失败。
const baseline = JSON.parse(serializer.serializeScene(scene));
assert.equal(baseline.version, 6);
const sourceFiles = [
  'electron/shared/sceneFileVersion.ts', 'electron/shared/sceneLightingBakeData.ts',
  'electron/shared/sceneLightingConfig.ts', 'src/editor/project/SceneSerializer.ts',
  'electron/ipc/sceneLightingBakeResources.ts',
];
const sourceSha256 = Object.fromEntries(frozen.modules.map(module => [module.path, module.sha256]));
const liveSourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, sha(await fs.readFile(path.join(repository, name)))])));
const report = { version: 1, measuredAt: new Date().toISOString(), node: process.version,
  scope: 'Actual frozen pre-gamma v2 client source API contract; tiny local fixture only; no shader, GPU, bake or server.',
  oldClientFrozenAt: frozen.frozenAt, oldClientFixtureSha256: sha(fixtureBytes), loadedFrozenModules: [...loadedFrozen], liveSourceSha256,
  fixture: { outerVersion: baseline.version, lightingVersion: scene.sceneSettings.lighting.version,
    snapshotVersion: 1, assetCount: 3, pngBytes: contents[1][3].length, textureBytes: 4 }, sourceSha256, cases: [] };

function state(value) {
  const lighting = value.sceneSettings?.lighting ?? value;
  const result = lighting.result;
  return { lightingVersion: lighting.version, resultPresent: result !== null && result !== undefined,
    ...(result ? { snapshotVersion: result.version, assetCount: result.assets.length,
      encoding: result.assets.find(asset => asset.kind === 'lightmap')?.encoding ?? null,
      extensionCodec: result.assets.find(asset => asset.kind === 'lightmap')?.lightmapCodec ?? null } : {}) };
}
async function observe(name, operation) {
  try { return { name, accepted: true, ...await operation() }; }
  catch (error) { return { name, accepted: false, error: error instanceof Error ? error.message : String(error) }; }
}
async function inspectVariant(id, change) {
  const document = structuredClone(baseline); change(document);
  const before = JSON.stringify(document);
  const observations = [];
  observations.push(await observe('validateSnapshot', () => ({ valid: data.validateSceneLightingBakeSnapshot(document.scene.sceneSettings.lighting.result) !== null })));
  observations.push(await observe('normalizeSceneLightingConfig', () => state(config.normalizeSceneLightingConfig(document.scene.sceneSettings.lighting))));
  observations.push(await observe('deserializeScene', () => state(serializer.deserializeScene(before))));
  observations.push(await observe('serializeScene', () => state(JSON.parse(serializer.serializeScene(document.scene)).scene)));
  observations.push(await observe('resolveRawAssets', async () => ({ files: (await transport.resolveSceneLightingBakeAssets(document.scene, { projectRoot })).length })));
  for (const [name, prepare] of [['prepareLightingSceneContent', transport.prepareLightingSceneContent], ['prepareLightingSceneSave', transport.prepareLightingSceneSave]]) {
    observations.push(await observe(name, async () => {
      const target = path.join(root, id, name, 'Scenes', 'fixture.scene.json');
      await fs.mkdir(path.dirname(target), { recursive: true });
      const result = await prepare(before, target, { projectRoot });
      return { ...state(JSON.parse(result.content).scene), files: result.files.length };
    }));
  }
  assert.equal(JSON.stringify(document), before, '真实入口不能修改传入文档对象');
  const entry = { id, inputSha256: sha(before), observations };
  report.cases.push(entry);
  return Object.fromEntries(observations.map(observation => [observation.name, observation]));
}

test('现有无encoding光照结果在真实配置、编辑器与主进程文件入口完整保留', async () => {
  const before = serializer.serializeScene(scene);
  const reopened = serializer.deserializeScene(before);
  assert.equal(JSON.stringify(reopened.sceneSettings.lighting), JSON.stringify(scene.sceneSettings.lighting));
  // 已存在的实体规范化会为 createMeshEntity 首次打开补 isFolder=false（SceneSerializer:547）。
  // 保留此既有行为的精确反例，完整字节回归固定在实际旧入口已经规范化的文档上。
  const withExistingNormalization = structuredClone(baseline);
  withExistingNormalization.scene.entities[cube.id] = { ...withExistingNormalization.scene.entities[cube.id], isFolder: false };
  assert.deepEqual(JSON.parse(serializer.serializeScene(reopened)), withExistingNormalization);
  report.existingFirstOpenNormalization = { path: `scene.entities.${cube.id}.isFolder`, addedValue: false,
    source: 'src/editor/project/SceneSerializer.ts:547', lightingByteIdentical: true };
  const canonicalBefore = serializer.serializeScene(reopened);
  assert.equal(serializer.serializeScene(serializer.deserializeScene(canonicalBefore)), canonicalBefore, '旧规范化无codec v2完整文件往返不能漂移');
  report.legacyRoundTripByteIdentical = true;
  const result = await inspectVariant('legacy-unchanged', () => {});
  assert.equal(result.validateSnapshot.valid, true);
  for (const name of ['normalizeSceneLightingConfig', 'deserializeScene', 'serializeScene', 'prepareLightingSceneContent', 'prepareLightingSceneSave']) {
    assert.equal(result[name].accepted, true, name);
    assert.equal(result[name].resultPresent, true, name);
    assert.equal(result[name].encoding, null, name);
  }
  assert.equal(result.resolveRawAssets.files, 3);
  assert.equal(result.prepareLightingSceneContent.files, 3);
  assert.equal(result.prepareLightingSceneSave.files, 3);
});

test('仅加入新lightmap.encoding会静默移除结果；原始资源解析拒绝不能代表打开入口拒绝', async () => {
  for (const encoding of ['rgbm-gamma', 'rgbm-linear-mips-v1']) {
    const result = await inspectVariant(encoding, document => { document.scene.sceneSettings.lighting.result.assets[1].encoding = encoding; });
    assert.equal(result.validateSnapshot.valid, false);
    for (const name of ['normalizeSceneLightingConfig', 'deserializeScene', 'serializeScene', 'prepareLightingSceneContent', 'prepareLightingSceneSave']) {
      assert.equal(result[name].accepted, true, name);
      assert.equal(result[name].resultPresent, false, name);
    }
    assert.equal(result.resolveRawAssets.accepted, false);
    assert.equal(result.prepareLightingSceneContent.files, 0);
    assert.equal(result.prepareLightingSceneSave.files, 0);
  }
});

test('只提升snapshot.version同样静默移除结果，不是旧编辑器文件拒绝门', async () => {
  const result = await inspectVariant('snapshot-version-2', document => { document.scene.sceneSettings.lighting.result.version = 2; });
  assert.equal(result.validateSnapshot.valid, false);
  for (const name of ['normalizeSceneLightingConfig', 'deserializeScene', 'serializeScene', 'prepareLightingSceneContent', 'prepareLightingSceneSave']) {
    assert.equal(result[name].accepted, true, name);
    assert.equal(result[name].resultPresent, false, name);
  }
});

test('未知扩展字段被保留，不能用作要求旧客户端拒绝的新codec门', async () => {
  const result = await inspectVariant('unknown-extension-marker', document => { document.scene.sceneSettings.lighting.result.assets[1].lightmapCodec = 'rgbm-gamma'; });
  assert.equal(result.validateSnapshot.valid, true);
  for (const name of ['normalizeSceneLightingConfig', 'deserializeScene', 'serializeScene', 'prepareLightingSceneContent', 'prepareLightingSceneSave']) {
    assert.equal(result[name].accepted, true, name);
    assert.equal(result[name].resultPresent, true, name);
    assert.equal(result[name].encoding, null, name);
    assert.equal(result[name].extensionCodec, 'rgbm-gamma', name);
  }
});

test('现有lighting.version严格门足以拒绝新codec场景，外层版本可保持6', async () => {
  for (const version of [3, 4, '3', null]) {
    const result = await inspectVariant(`lighting-version-${typeof version}-${String(version)}`, document => {
      document.scene.sceneSettings.lighting.version = version;
      document.scene.sceneSettings.lighting.result.assets[1].encoding = 'rgbm-gamma';
    });
    for (const name of ['normalizeSceneLightingConfig', 'deserializeScene', 'serializeScene', 'prepareLightingSceneContent', 'prepareLightingSceneSave']) {
      assert.equal(result[name].accepted, false, name);
      assert.match(result[name].error, /场景光照配置版本不受支持/, name);
    }
  }
});

test('外层SceneFileVersion7也会拒绝，但范围大于已有lighting.version门', async () => {
  const result = await inspectVariant('outer-version-7', document => { document.version = 7; });
  // 单独的配置归一化及序列化不接收外层版本；所有实际读文件入口均明确拒绝。
  assert.equal(result.normalizeSceneLightingConfig.accepted, true);
  for (const name of ['deserializeScene', 'prepareLightingSceneContent', 'prepareLightingSceneSave']) {
    assert.equal(result[name].accepted, false, name);
    assert.match(result[name].error, /场景.*格式|场景.*版本/, name);
  }
});

after(async () => {
  assert.equal(loadedFrozen.size, frozen.modules.length);
  report.sourcesUnchanged = (await Promise.all(sourceFiles.map(async name => sha(await fs.readFile(path.join(repository, name))) === liveSourceSha256[name]))).every(Boolean);
  assert.equal(report.sourcesUnchanged, true);
  if (process.env.PHASE2_CODEC_COMPAT_REPORT) {
    const destination = path.resolve(process.env.PHASE2_CODEC_COMPAT_REPORT);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.match(path.basename(root), /^phase2-codec-contract-/);
  await fs.rm(root, { recursive: true, force: true });
});
