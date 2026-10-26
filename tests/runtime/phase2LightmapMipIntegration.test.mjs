import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import 'react/jsx-runtime';
import { NullEngine, Scene } from '@babylonjs/core';
import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';
import { validateSceneLightingBakeSnapshot } from '../../electron/shared/sceneLightingBakeData.ts';
import { getLightingAtlasDimensions, validateLightingPng, validateLightingProbes } from '../../electron/shared/sceneLightingBakeArtifacts.ts';
import { encodeLightingLightmapMips, validateLightingLightmapMipAsset } from '../../electron/shared/sceneLightingLightmapMips.ts';
import { LIGHTING_LIGHTMAP_MIP_RECIPE, isLightingLightmapRecipeCompatible, getLightingLightmapTextureBytes } from '../../electron/shared/sceneLightingTextureCodec.ts';
import { safeLightingBakeChildPath, matchLightingBakeSurfaceSources } from '../../electron/ipc/lightingBakeValidation.ts';
import { decodeLightingGeometryResource } from '../../electron/shared/sceneLightingBakeGeometryBinary.ts';

const repository = new URL('../../', import.meta.url), prefix = 'phase2-mip-legacy:';
const frozen = JSON.parse(readFileSync(new URL('./fixtures/phase2GammaLegacyClient.json', import.meta.url), 'utf8'));
const modules = new Map(frozen.modules.map(module => [module.path, module.source]));
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(prefix)) return { url: specifier, shortCircuit: true };
  let target;
  if (context.parentURL?.startsWith(prefix) && specifier.startsWith('.')) target = new URL(specifier, new URL(context.parentURL.slice(prefix.length), repository));
  else if (specifier.startsWith('.') && context.parentURL?.startsWith(repository.href) && !context.parentURL.includes('/node_modules/')) target = new URL(specifier, context.parentURL);
  if (target) {
    const choices = [target, ...(target.href.endsWith('.js') ? [new URL(target.href.slice(0, -3) + '.ts')]
      : path.extname(target.pathname) ? [] : [new URL(target.href + '.ts'), new URL(target.href + '.tsx')])];
    const candidate = choices.find(value => existsSync(value)) ?? target, name = candidate.href.slice(repository.href.length);
    if (context.parentURL?.startsWith(prefix) && modules.has(name)) return { url: prefix + name, shortCircuit: true };
    return next(candidate.href, { ...context, parentURL: repository.href });
  }
  if (/^@babylonjs\/(?:core|loaders)\//.test(specifier) && !specifier.endsWith('.js')) return next(specifier + '.js', context);
  return next(specifier, context);
}, load(url, context, next) {
  if (url.startsWith(prefix) || url.startsWith(repository.href) && url.endsWith('.tsx')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(url.startsWith(prefix) ? modules.get(url.slice(prefix.length)) : readFileSync(new URL(url), 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText };
  if (url.startsWith(repository.href) && /\.(png|jpg|webp|svg)$/.test(url)) return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
  return next(url, context);
} });
let serializer, legacySerializer, legacyConfig, model, loader, runtime, ui;
try {
  [serializer, legacySerializer, legacyConfig, model, loader, runtime, ui] = await Promise.all([
    import('../../src/editor/project/SceneSerializer.ts'), import(prefix + 'src/editor/project/SceneSerializer.ts'), import(prefix + 'electron/shared/sceneLightingConfig.ts'),
    import('../../src/editor/model/SceneDocument.ts'), import('../../src/runtime/babylon/lightingRuntimeResources.ts'), import('../../src/runtime/babylon/SceneLightingRuntime.ts'),
    import('../../src/editor/panels/LightingBakeManagerOverview.tsx'),
  ]);
} finally { hooks.deregister(); }

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const size = 64, rgba = (dimension, value) => new Uint8Array(dimension * dimension * 4).fill(value);
const binary = encodeLightingLightmapMips({ baseEncoding: 'rgbm', rgbmRange: 4, maxTextureBytes: 1 << 20,
  levels: [{ width: size, height: size, rgba: rgba(size, 128) }, { width: size / 2, height: size / 2, rgba: rgba(size / 2, 64) }] });
const map = { id: 'l', kind: 'lightmap', encoding: 'rgbm-linear-mips-v1', url: 'lightmap-0.bin', byteLength: binary.length,
  rgbmRange: 4, width: size, height: size, levelCount: 2, textureBytes: 20480, mipRecipe: LIGHTING_LIGHTMAP_MIP_RECIPE, sha256: sha(binary) };
const geometry = { version: 1, key: 'ground', positions: [-1, 0, -1, 1, 0, -1, 0, 0, 1], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0],
  uvs: [0, 0, 1, 0, .5, 1], bakeUvs: [0, 0, 1, 0, .5, 1], indices: [0, 2, 1] };
const probes = { version: 1, encoding: 'ambient-cube', spacing: 4, probes: [{ position: [0, 0, 0], irradiance: new Array(18).fill(.1) }] };
const snapshot = () => ({ version: 1, signature: 'fixture-signature', createdAt: '2026-10-25T00:00:00Z', engineVersion: 'fixture',
  assets: [{ id: 'g', kind: 'geometry', url: 'geometry-0.json', byteLength: Buffer.byteLength(JSON.stringify(geometry)) }, { ...map },
    { id: 'p', kind: 'probes', url: 'probes.json', byteLength: Buffer.byteLength(JSON.stringify(probes)) }],
  surfaces: [{ key: 'ground', entityId: 'ground', nodeKey: 'root', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
  statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: 20480, durationMs: 1 } });

test('旧v2未知扩展含同名新metadata保持完整JSON/往返字节，真实冻结旧模块直接对照', () => {
  const old = { version: 2, userExtension: { keep: [1, 'x'] }, bake: { extension: { keep: true } }, result: snapshot() };
  delete old.result.assets[1].encoding;
  Object.assign(old.result.assets[1], { url: 'lightmap-0.png', width: { business: true }, height: 'opaque', levelCount: [1, 3], textureBytes: { keep: 1 }, mipRecipe: { oldUnknown: true } });
  old.result.statistics.textureBytes = size * size * 4;
  assert.equal(JSON.stringify(normalizeSceneLightingConfig(old)), JSON.stringify(legacyConfig.normalizeSceneLightingConfig(old)));
  const scene = model.createEmptySceneDocument('old extension oracle'); scene.id = 'legacy-extension'; scene.sceneSettings.lighting = normalizeSceneLightingConfig(old);
  const content = serializer.serializeScene(scene); assert.equal(content, legacySerializer.serializeScene(scene));
  assert.equal(serializer.serializeScene(serializer.deserializeScene(content)), legacySerializer.serializeScene(legacySerializer.deserializeScene(content)));
});

test('v3新mip metadata/header/全链预算/recipe严格相互匹配，换层数旧结果标stale不清空', () => {
  const result = snapshot(); assert.ok(validateSceneLightingBakeSnapshot(result));
  const config = normalizeSceneLightingConfig({ version: 3, bake: { lightmapMipLevels: 1 }, result });
  assert.equal(config.result.assets[1].mipRecipe, LIGHTING_LIGHTMAP_MIP_RECIPE);
  assert.deepEqual(getLightingAtlasDimensions(result), { width: size, height: size });
  assert.equal(getLightingLightmapTextureBytes(size, size, 1), 20480);
  assert.equal(isLightingLightmapRecipeCompatible(undefined, result.assets, 1), true);
  assert.equal(isLightingLightmapRecipeCompatible(undefined, result.assets, 2), false);
  assert.ok(normalizeSceneLightingConfig({ ...config, bake: { ...config.bake, lightmapMipLevels: 2 } }).result);
  assert.throws(() => normalizeSceneLightingConfig({ ...config, version: 2 }), /版本 3/);
  for (const mutate of [asset => { asset.levelCount = 3; }, asset => { asset.width = 32; }, asset => { asset.textureBytes = size * size * 4; },
    asset => { asset.encoding = 'rgbm-linear-mips-v2'; }, asset => { asset.mipRecipe = 'unknown'; }]) {
    const bad = snapshot(); mutate(bad.assets[1]); assert.throws(() => normalizeSceneLightingConfig({ version: 3, bake: { lightmapMipLevels: 1 }, result: bad }));
  }
  assert.throws(() => validateLightingLightmapMipAsset(map, binary, 20479), /预算/);
  const key = value => runtime.SceneLightingRuntime.prototype.snapshotKey.call({}, value);
  const other = snapshot(); other.assets[1].levelCount = 3; assert.notEqual(key(other), key(result));
});

test('实际管理器Mip选择升v3，关闭删除键且保留旧result/未知设置', () => {
  const scene = model.createEmptySceneDocument('mip-ui'); let changed;
  const lighting = normalizeSceneLightingConfig({ version: 2, bake: { custom: { keep: 1 } } });
  const tree = ui.LightingBakeManagerOverview({ scene, lighting, appearance: scene.sceneSettings.appearance, disabled: false, busy: false, onLightingChange: value => { changed = value; } });
  function find(node) { if (!node || typeof node !== 'object') return null; if (node.props?.['aria-label'] === '光照贴图Mip层级') return node;
    for (const child of [node.props?.children].flat(Infinity)) { const found = find(child); if (found) return found; } return null; }
  const select = find(tree); assert.ok(select); assert.equal(select.props.value, 0);
  select.props.onChange({ target: { value: '1' } }); assert.equal(changed.version, 3); assert.equal(changed.bake.lightmapMipLevels, 1); assert.deepEqual(changed.bake.custom, { keep: 1 });
  const enabled = changed;
  const enabledTree = ui.LightingBakeManagerOverview({ scene, lighting: enabled, appearance: scene.sceneSettings.appearance, disabled: false, busy: false, onLightingChange: value => { changed = value; } });
  find(enabledTree).props.onChange({ target: { value: '0' } });
  assert.equal(changed.version, 3); assert.equal(Object.hasOwn(changed.bake, 'lightmapMipLevels'), false); assert.deepEqual(changed.bake.custom, { keep: 1 });
});

test('真实loader校SHA/容器并将全链传递factory，坏容器/取消完整回收；mock不是GPU验收', async t => {
  const files = new Map([['/geometry-0.json', Buffer.from(JSON.stringify(geometry))], ['/lightmap-0.bin', Buffer.from(binary)], ['/probes.json', Buffer.from(JSON.stringify(probes))]]);
  const server = createServer((request, response) => { const data = files.get(request.url); response.writeHead(data ? 200 : 404); response.end(data); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const engine = new NullEngine(), scene = new Scene(engine); t.after(() => { scene.dispose(); engine.dispose(); });
  const value = snapshot(); for (const asset of value.assets) { asset.url = 'http://127.0.0.1:' + server.address().port + '/' + asset.url; asset.sha256 = sha(files.get(new URL(asset.url).pathname)); }
  let disposed = 0, passed;
  const factory = (_scene, decoded, options) => { passed = { decoded, options }; return { isReady: () => true, dispose: () => { disposed++; } }; };
  const resources = await loader.loadLightingResources(value, scene, undefined, { maxTextureBytes: 20480, mipTextureFactory: factory });
  assert.equal(passed.decoded.levelCount, 2); assert.equal(passed.decoded.totalTextureBytes, 20480); assert.equal(passed.options.maxTextureBytes, 20480);
  assert.equal(resources.textures.size, 1); resources.dispose(); assert.equal(disposed, 1);
  await assert.rejects(loader.loadLightingResources(value, scene, undefined, { maxTextureBytes: 20479, mipTextureFactory: factory }), /预算/);
  const corrupt = snapshot(); corrupt.assets = value.assets.map(asset => ({ ...asset })); corrupt.assets[1].sha256 = '0'.repeat(64);
  await assert.rejects(loader.loadLightingResources(corrupt, scene, undefined, { mipTextureFactory: factory }), /校验/);
  const controller = new AbortController(); controller.abort(new Error('stop fixture'));
  await assert.rejects(loader.loadLightingResources(value, scene, controller.signal, { mipTextureFactory: factory }), /stop fixture/);
});

test('实际后台promotion只接受匹配请求的完整mip资产，失败不覆盖旧资产', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-mip-promote-')); t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^phase2-mip-promote-/); await fs.rm(root, { recursive: true, force: true }); });
  const source = await fs.readFile(new URL('../../electron/ipc/lightingBakeService.ts', import.meta.url), 'utf8'), tree = ts.createSourceFile('service.ts', source, ts.ScriptTarget.Latest, true);
  const wanted = new Set(['assertActive', 'validateAndPromote']);
  const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node) && wanted.has(node.name?.text)).map(node => node.getText(tree).replace(/^export /, '')).join('\n');
  const codec = await import('../../electron/shared/sceneLightingTextureCodec.ts');
  const validate = runInNewContext(ts.transpileModule(functions + '\nvalidateAndPromote;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText,
    { fs, path, createHash, randomUUID, safeLightingBakeChildPath, matchLightingBakeSurfaceSources, decodeLightingGeometryResource, validateLightingPng, validateLightingProbes,
      validateLightingLightmapMipAsset, isLightingLightmapMipEncoding: value => value === 'rgbm-linear-mips-v1' || value === 'rgbm-gamma-mips-v1', ...codec,
      inside: (parent, file) => file.startsWith(parent + path.sep), Buffer, Date, Math, Number, Error, Map, Set });
  const assetsRoot = path.join(root, 'Assets', 'LightingBakes'), staging = path.join(root, 'staging'); await fs.mkdir(assetsRoot, { recursive: true }); await fs.mkdir(staging);
  await fs.writeFile(path.join(assetsRoot, 'old-asset.keep'), 'previous valid');
  await fs.writeFile(path.join(staging, 'geometry-0.json'), JSON.stringify(geometry)); await fs.writeFile(path.join(staging, 'lightmap-0.bin'), binary); await fs.writeFile(path.join(staging, 'probes.json'), JSON.stringify(probes));
  const result = { version: 1, signature: 'fixture-signature', engineVersion: 'fixture', atlases: [{ file: 'lightmap-0.bin', width: size, height: size,
    encoding: map.encoding, rgbmRange: 4, levelCount: 2, textureBytes: 20480, mipRecipe: LIGHTING_LIGHTMAP_MIP_RECIPE }],
    meshes: [{ key: 'ground', entityId: 'ground', nodeKey: 'root', geometryFile: 'geometry-0.json', geometryVersion: 1, atlasIndex: 0 }], probesFile: 'probes.json', statistics: snapshot().statistics };
  await fs.writeFile(path.join(staging, 'result.json'), JSON.stringify(result));
  const authorized = [], options = { input: { jobId: 'mip-promote', signature: 'fixture-signature', meshes: [{ key: 'ground', entityId: 'ground', nodeKey: 'root', indices: geometry.indices }],
    settings: { atlasSize: size, maxTextureMiB: 16, lightmapMipLevels: 1 } }, signal: new AbortController().signal, isProjectCurrent: () => true,
    encodeAssetUrl: file => 'editor-asset://local/' + encodeURIComponent(file), decodeAssetUrl: url => decodeURIComponent(new URL(url).pathname.slice(1)), authorizeAssetFile: file => authorized.push(file) };
  const promoted = await validate(options, staging, assetsRoot); assert.equal(promoted.assets.find(asset => asset.kind === 'lightmap').textureBytes, 20480); assert.equal(authorized.length, 3);
  result.atlases[0].levelCount = 3; await fs.writeFile(path.join(staging, 'result.json'), JSON.stringify(result));
  await assert.rejects(validate(options, staging, assetsRoot), /mip层级|预算|请求/);
  assert.equal(await fs.readFile(path.join(assetsRoot, 'old-asset.keep'), 'utf8'), 'previous valid');
  assert.equal((await fs.readdir(assetsRoot)).some(name => name.startsWith('.pending-')), false);
});
