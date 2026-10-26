import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import ts from 'typescript';
// CJS React runtime 先于 Node 自定义 TS loader 初始化，避免其被异步模块钩子重复实例化。
import 'react/jsx-runtime';
import { NullEngine, Scene, StandardMaterial, PBRMaterial } from '@babylonjs/core';
import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';
import { validateSceneLightingBakeSnapshot, getSceneLightingBakeSignature, getSceneLightingBakeError } from '../../electron/shared/sceneLightingBakeContract.ts';

const repository = new URL('../../', import.meta.url);
const frozen = JSON.parse(readFileSync(new URL('./fixtures/phase2GammaLegacyClient.json', import.meta.url), 'utf8'));
const legacyPrefix = 'phase2-gamma-legacy:';
const frozenSources = new Map(frozen.modules.map(module => [module.path, module.source]));
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(legacyPrefix)) return { url: specifier, shortCircuit: true };
  if (context.parentURL?.startsWith(legacyPrefix) && specifier.startsWith('.')) {
    const parent = new URL(context.parentURL.slice(legacyPrefix.length), repository);
    const target = new URL(specifier, parent);
    const choices = [target, ...(target.href.endsWith('.js') ? [new URL(target.href.slice(0, -3) + '.ts')]
      : path.extname(target.pathname) ? [] : [new URL(target.href + '.ts'), new URL(target.href + '.tsx')])];
    const candidate = choices.find(value => existsSync(value)) ?? target;
    const name = candidate.href.slice(repository.href.length);
    if (frozenSources.has(name)) return { url: legacyPrefix + name, shortCircuit: true };
    return next(candidate.href, { ...context, parentURL: parent.href });
  }
  if (/^@babylonjs\/(?:core|loaders)\//.test(specifier) && !specifier.endsWith('.js')) return next(specifier + '.js', context);
  if (specifier.startsWith('.') && context.parentURL?.startsWith(repository.href) && !context.parentURL.includes('/node_modules/')) {
    const target = new URL(specifier, context.parentURL);
    const candidates = specifier.endsWith('.js') ? [target.href.slice(0, -3) + '.ts']
      : path.extname(target.pathname) ? [] : [target.href + '.ts', target.href + '.tsx'];
    for (const candidate of candidates) if (existsSync(new URL(candidate))) return next(candidate, context);
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (url.startsWith(legacyPrefix)) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(frozenSources.get(url.slice(legacyPrefix.length)), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    } }).outputText };
  if (url.startsWith(repository.href) && url.endsWith('.tsx')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText };
  if (url.startsWith(repository.href) && /\.(?:png|jpg|svg)$/.test(url)) return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
  return next(url, context);
} });
let serializer, resources, model, capabilities, manager, overview, store, commands, plugin, runtime, legacyConfig, legacySerializer;
try {
  [serializer, resources, model, capabilities, manager, overview, store, commands, plugin, runtime, legacyConfig, legacySerializer] = await Promise.all([
    import('../../src/editor/project/SceneSerializer.ts'), import('../../electron/ipc/sceneLightingBakeResources.ts'),
    import('../../src/editor/model/SceneDocument.ts'), import('../../electron/ipc/viewerTemplateCapabilities.ts'),
    import('../../src/editor/panels/lightingBakeManagerModel.ts'), import('../../src/editor/panels/LightingBakeManagerOverview.tsx'),
    import('../../src/editor/store/slices/lightingManagerSlice.ts'), import('../../src/editor/commands/CommandHistory.ts'),
    import('../../src/runtime/babylon/BakedLightingMaterialPlugin.ts'), import('../../src/runtime/babylon/SceneLightingRuntime.ts'),
    import(legacyPrefix + 'electron/shared/sceneLightingConfig.ts'), import(legacyPrefix + 'src/editor/project/SceneSerializer.ts'),
  ]);
} finally { hooks.deregister(); }

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-gamma-integration-'));
after(async () => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.match(path.basename(root), /^phase2-gamma-integration-/);
  await fs.rm(root, { recursive: true, force: true });
});
const assets = [];
for (const [id, kind, filename, value] of [['g', 'geometry', 'mesh.json', '{}'], ['l', 'lightmap', 'map.png', 'PNG-file-fixture'], ['p', 'probes', 'probes.json', '{}']]) {
  const target = path.join(root, 'source', 'Assets', 'LightingBakes', 'gamma', filename);
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, value);
  assets.push({ id, kind, url: 'editor-asset://local/' + encodeURIComponent(target), byteLength: Buffer.byteLength(value), sha256: sha(value), ...(kind === 'lightmap' ? { rgbmRange: 4 } : {}) });
}
function fixture(gamma = false) {
  const scene = model.createEmptySceneDocument('Gamma contract'); scene.id = 'scene_gamma_contract';
  const cube = model.createMeshEntity('cube'); cube.id = 'entity_gamma_contract'; cube.isFolder = false;
  scene.entityIds = [cube.id]; scene.entities = { [cube.id]: cube };
  scene.sceneSettings.lighting = normalizeSceneLightingConfig(gamma ? { version: 3, bake: { lightmapEncoding: 'rgbm-gamma' } } : undefined);
  scene.sceneSettings.lighting.result = { version: 1, signature: getSceneLightingBakeSignature(scene), createdAt: '2026-10-25T00:00:00Z', engineVersion: 'fixture',
    assets: structuredClone(assets).map(asset => gamma && asset.kind === 'lightmap' ? { ...asset, encoding: 'rgbm-gamma' } : asset),
    surfaces: [{ key: 'entity_gamma_contract/root', entityId: cube.id, nodeKey: 'root', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
    statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 0, textureBytes: 4, durationMs: 0 } };
  // 固定在实际旧入口已经规范化的字段与键顺序上，排除既有 isFolder 插入位置差异。
  return serializer.deserializeScene(serializer.serializeScene(scene));
}

test('新客户端旧v2默认不补字段，完整规范化文件字节往返与旧物理摘要不漂移', () => {
  const scene = fixture(), before = serializer.serializeScene(scene);
  assert.equal(scene.sceneSettings.lighting.version, 2);
  assert.equal(Object.hasOwn(scene.sceneSettings.lighting.bake, 'lightmapEncoding'), false);
  assert.equal(JSON.stringify(normalizeSceneLightingConfig(undefined)), JSON.stringify(legacyConfig.normalizeSceneLightingConfig(undefined)));
  assert.equal(serializer.serializeScene(scene), legacySerializer.serializeScene(scene));
  assert.equal(serializer.serializeScene(serializer.deserializeScene(before)), legacySerializer.serializeScene(legacySerializer.deserializeScene(before)));
  assert.equal(serializer.serializeScene(serializer.deserializeScene(before)), before);
  const gamma = fixture(true);
  assert.equal(getSceneLightingBakeSignature(gamma), getSceneLightingBakeSignature(scene));
  const toggled = structuredClone(gamma); toggled.sceneSettings.lighting.bake.lightmapEncoding = 'rgbm';
  assert.equal(getSceneLightingBakeSignature(toggled), getSceneLightingBakeSignature(scene));
});

test('v3真实配置/保存/另存/打开保留codec；未知版本或codec必须抛错而非result=null', async () => {
  const scene = fixture(true), text = serializer.serializeScene(scene);
  assert.equal(validateSceneLightingBakeSnapshot(scene.sceneSettings.lighting.result)?.assets[1].encoding, 'rgbm-gamma');
  assert.equal(serializer.deserializeScene(text).sceneSettings.lighting.version, 3);
  for (const [name, prepare] of [['open', resources.prepareLightingSceneContent], ['save-as', resources.prepareLightingSceneSave]]) {
    const target = path.join(root, name, 'Scenes', 'gamma.scene.json'); await fs.mkdir(path.dirname(target), { recursive: true });
    const result = await prepare(text, target, { projectRoot: path.join(root, 'source') });
    const reopened = serializer.deserializeScene(result.content);
    assert.equal(result.files.length, 3);
    assert.equal(reopened.sceneSettings.lighting.result.assets[1].encoding, 'rgbm-gamma');
    assert.equal(getSceneLightingBakeError(reopened), null);
  }
  for (const change of [s => { s.sceneSettings.lighting.version = 4; },
    s => { s.sceneSettings.lighting.result.assets[1].encoding = 'unimplemented-codec'; },
    s => { s.sceneSettings.lighting.result.assets[1].encoding = 'rgbm-gamma-mips-v1'; },
    s => { s.sceneSettings.lighting.result.assets[1].rgbmRange = .5; },
    s => { s.sceneSettings.lighting.result.version = 2; }]) {
    const invalid = fixture(true); change(invalid);
    const content = JSON.stringify({ version: 6, scene: invalid });
    assert.throws(() => normalizeSceneLightingConfig(invalid.sceneSettings.lighting));
    assert.throws(() => serializer.deserializeScene(content));
    assert.throws(() => serializer.serializeScene(invalid));
    for (const prepare of [resources.prepareLightingSceneContent, resources.prepareLightingSceneSave]) {
      await assert.rejects(prepare(content, path.join(root, 'invalid.scene.json'), { projectRoot: path.join(root, 'source') }));
    }
  }
  const illicit = fixture(true); illicit.sceneSettings.lighting.version = 2;
  assert.throws(() => normalizeSceneLightingConfig(illicit.sceneSettings.lighting), /版本 3/);
});

test('换编码单独使结果过期，保留旧结果和资产；仅改变range或codec不会复用新状态key', () => {
  const old = fixture(), gamma = fixture(true), stale = fixture(true);
  stale.sceneSettings.lighting.result = old.sceneSettings.lighting.result;
  assert.equal(getSceneLightingBakeSignature(stale), old.sceneSettings.lighting.result.signature);
  assert.match(getSceneLightingBakeError(stale), /编码.*不匹配.*重新烘焙/);
  assert.ok(normalizeSceneLightingConfig(stale.sceneSettings.lighting).result);
  const key = snapshot => runtime.SceneLightingRuntime.prototype.snapshotKey.call({}, snapshot);
  const changed = structuredClone(gamma.sceneSettings.lighting.result); changed.assets[1].rgbmRange = 8;
  assert.notEqual(key(changed), key(gamma.sceneSettings.lighting.result));
  assert.notEqual(key(gamma.sceneSettings.lighting.result), key(old.sceneSettings.lighting.result));
});

test('真实管理器控件显式升v3，直接store与undo/redo保持版本；完成结果核对recipe', () => {
  const scene = fixture(); let updated;
  const draft = manager.createLightingManagerDraft(scene, 'session');
  const tree = overview.LightingBakeManagerOverview({ scene, lighting: draft.lighting, appearance: draft.appearance,
    disabled: false, busy: false, onLightingChange: value => { updated = value; } });
  function find(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.props?.label === '暗部精度（Gamma RGBM）') return node;
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) { const match = find(child); if (match) return match; }
    return null;
  }
  const toggle = find(tree); assert.ok(toggle); assert.equal(toggle.props.checked, false);
  toggle.props.onChange(true); assert.equal(updated.version, 3); assert.equal(updated.bake.lightmapEncoding, 'rgbm-gamma');
  const summary = manager.getLightingManagerChangeSummary({ ...draft, lighting: updated });
  assert.equal(summary.giInputChanged, false); assert.match(summary.giMessage, /编码.*重新烘焙/);
  let state = { scene, history: commands.createCommandHistory(), runtimeMode: 'edit', logs: [] };
  const set = patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  const actions = store.createLightingManagerSlice(set, () => state, {}); state = { ...state, ...actions };
  const original = JSON.stringify(state.scene);
  actions.updateLightingBakeSettings({ lightmapEncoding: 'rgbm-gamma' });
  assert.equal(state.scene.sceneSettings.lighting.version, 3);
  const after = JSON.stringify(state.scene);
  state = { ...state, ...commands.undoCommand(state.scene, state.history) }; assert.equal(JSON.stringify(state.scene), original);
  state = { ...state, ...commands.redoCommand(state.scene, state.history) }; assert.equal(JSON.stringify(state.scene), after);
  state.lightingBakeRequest = { id: 'mismatch' };
  const previous = state.scene.sceneSettings.lighting.result;
  actions.completeLightingBake('mismatch', fixture().sceneSettings.lighting.result);
  assert.equal(state.scene.sceneSettings.lighting.result, previous); assert.equal(state.lightingBakeStatus.phase, 'error');
  state.lightingBakeRequest = { id: 'match' };
  actions.completeLightingBake('match', fixture(true).sceneSettings.lighting.result);
  assert.equal(state.scene.sceneSettings.lighting.result.assets[1].encoding, 'rgbm-gamma');
});

test('真实PBR/Standard插件按mesh选择新解码，旧线性shader表达式原样保留', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    for (const Material of [StandardMaterial, PBRMaterial]) {
      let binding = { texture: {}, rgbmRange: 4, enabled: true };
      const instance = new plugin.BakedLightingMaterialPlugin(new Material('gamma-contract', scene), () => binding);
      const mesh = { isVerticesDataPresent: () => true };
      const linear = {}; instance.prepareDefines(linear, scene, mesh); assert.equal(linear.BAKED_INDIRECT_GAMMA, false);
      binding = { ...binding, encoding: 'rgbm-gamma' };
      const gamma = {}; instance.prepareDefines(gamma, scene, mesh); assert.equal(gamma.BAKED_INDIRECT_GAMMA, true);
      const source = instance.getCustomCode('fragment').CUSTOM_FRAGMENT_DEFINITIONS;
      assert.match(source, /normalizedValue \* normalizedValue \* lightingBakeRange/);
      assert.match(source, /#else\s+return sampleValue\.rgb \* sampleValue\.a \* lightingBakeRange/);
    }
  } finally { scene.dispose(); engine.dispose(); }
});

test('v3无开场也须Viewer真实codec能力；旧模板明确拒绝，入口SHA仍受验证', async () => {
  const signal = new AbortController().signal;
  const scene = JSON.stringify({ version: 6, scene: fixture(true) });
  await assert.rejects(capabilities.assertViewerTemplateSupportsScene(scene, [], signal), /Viewer.*光照配置或贴图编码/);
  await capabilities.assertViewerTemplateSupportsScene(JSON.stringify({ version: 6, scene: fixture() }), [], signal);
  const entries = [{ path: 'index.html', content: '<script src="assets/index.js"></script>' }, { path: 'assets/index.js', content: 'gamma-runtime-capability-fixture' }];
  const images = Array.from({ length: 10 }, (_, index) => ({ id: `asset-${index + 1}`, path: `assets/asset-${index + 1}.webp`, content: 'image' }));
  const manifest = capabilities.createViewerTemplateCapabilities(entries, images);
  const files = [];
  for (const item of [...entries, { path: capabilities.VIEWER_TEMPLATE_CAPABILITIES_PATH, content: JSON.stringify(manifest) }]) {
    const destination = path.join(root, 'viewer', item.path); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, item.content);
    files.push({ sourcePath: destination, destinationRelativePath: item.path, size: Buffer.byteLength(item.content) });
  }
  await capabilities.assertViewerTemplateSupportsScene(scene, files, signal);
  delete manifest.lightingCodecs;
  const capabilityFile = files.find(file => file.destinationRelativePath === capabilities.VIEWER_TEMPLATE_CAPABILITIES_PATH);
  const oldContent = JSON.stringify(manifest); await fs.writeFile(capabilityFile.sourcePath, oldContent); capabilityFile.size = Buffer.byteLength(oldContent);
  await assert.rejects(capabilities.assertViewerTemplateSupportsScene(scene, files, signal), /不支持.*光照配置或贴图编码/);
});
