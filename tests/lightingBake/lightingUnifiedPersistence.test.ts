import assert from 'node:assert/strict';
import { CURRENT_SCENE_FILE_VERSION } from '../../electron/shared/sceneFileVersion.ts';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';
import { migrateSceneLightingDocument, normalizeSceneAppearanceConfig, normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';

const host = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-unified-host-'));
after(() => cleanup(host));
const electronStub = 'data:text/javascript,' + encodeURIComponent(
  'export const app={isPackaged:false,getPath:()=>'+JSON.stringify(host)+',getAppPath:()=>process.cwd()}; export const dialog={},ipcMain={},net={},shell={},BrowserWindow={},protocol={},session={};',
);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'electron') return next(electronStub, context);
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/electron/')) {
    const target = new URL(specifier, context.parentURL), source = new URL(target.href.slice(0, -3) + '.ts');
    if (!existsSync(target) && existsSync(source)) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { buildDigitalTwinSourcePackage } = await import('../../electron/ipc/digitalTwinSourcePackage.ts');
const { prepareDeploymentExport } = await import('../../electron/ipc/deploymentExportScene.ts');
const { copyDeploymentFiles } = await import('../../electron/ipc/deploymentExportFileSystem.ts');
const { relocateDataPlatformScene } = await import('../../electron/ipc/dataPlatformSceneRelocation.ts');
const { recoverLocalSceneResourcePaths } = await import('../../electron/ipc/localSceneResourceRecovery.ts');
const { recoverLocalSceneResourceTransaction } = await import('../../electron/ipc/localSceneRecoveryService.ts');
const { recoverSceneCompositions } = await import('../../electron/ipc/compositionSceneRecovery.ts');
const { stripCadReferencesFromSceneFile } = await import('../../electron/ipc/sceneCadReferenceSanitizer.ts');
const registry = await import('../../electron/ipc/assetRegistry.ts');
hooks.deregister();
const unzipper = createRequire(import.meta.url)('unzipper');
const url = (file: string) => 'editor-asset://local/' + encodeURIComponent(file);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function legacyScene(): any {
  return { id: 'legacy-unified', name: '旧文件无损迁移', entityIds: ['cube'], entities: {
    cube: { id: 'cube', name: '方块', parentId: null, childrenIds: [], components: {
      meshRenderer: { meshKind: 'cube' }, customBusiness: { enabled: true, amount: 0, values: [false, 'keep'] },
    } },
  }, sceneSettings: { extension: { keep: 'settings' },
    shadows: { mode: 'baked', enabled: false, sunAzimuthDegrees: 270, sunElevationDegrees: 30, sunIntensity: 1.2, fillIntensity: .4, iblIntensityMax: .8, darkness: .35,
      bake: { signature: 'retired-solar-signature', extension: 'must-not-drive-new-lighting' } },
    theme: { version: 1, presetId: 'tech-blue-night', environmentLighting: 'scene', backgroundColor: '#123456', mainColor: '#ffcc88',
      fillColor: '#aabbcc', groundColor: '#223344', environmentIntensity: .6, skyboxVisible: false,
      exposure: 1.35, contrast: 1.1, glowIntensity: .4, bloomEnabled: true, bloomWeight: .2,
      fogEnabled: true, fogColor: '#334455', fogStart: 150, fogEnd: 900 },
    lightingBake: { enabled: false },
    lightingPolicy: { version: 1, defaults: { castShadows: false }, rules: [], extension: { keep: 'policy' } },
  }, mqttConfig: { enabled: true, address: 'wss://example.invalid/mqtt', topic: 'factory/state',
    subscriptions: [{ id: 'fixture', topic: 'factory/state', enabled: true, qos: 0, adapter: { kind: 'epv' } }], extension: { keep: 'mqtt' } } };
}
async function attachOldResult(scene: any, projectRoot: string) {
  const assets = [];
  for (const [id, kind, file] of [['g', 'geometry', 'g.json'], ['l', 'lightmap', 'l.png'], ['p', 'probes', 'p.json']]) {
    const absolute = path.join(projectRoot, 'Assets', 'LightingBakes', 'old-job', file), content = Buffer.from('existing-' + kind);
    await fs.mkdir(path.dirname(absolute), { recursive: true }); await fs.writeFile(absolute, content);
    assets.push({ id, kind, url: url(absolute), byteLength: content.length, sha256: sha(content), extension: { keep: id } });
  }
  scene.sceneSettings.lightingBakeResult = { version: 1, signature: 'lighting-v1-0123456789abcdef', createdAt: '2026-10-20T00:00:00Z', engineVersion: 'legacy',
    assets, surfaces: [{ key: 'cube/root', entityId: 'cube', nodeKey: 'root', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
    statistics: { meshCount: 1, triangleCount: 12, atlasCount: 1, probeCount: 1, textureBytes: 16, durationMs: 2 }, extension: { keep: 'result' } };
}
function assertCanonical(scene: any, expected = legacyScene(), checkOriginalMqtt = true) {
  const settings = scene.sceneSettings;
  for (const old of ['theme', 'shadows', 'lightingBake', 'lightingPolicy', 'lightingBakeResult']) assert.equal(Object.hasOwn(settings, old), false, old);
  assert.equal(settings.lighting.version, 2); assert.equal(settings.appearance.version, 1);
  assert.equal(settings.lighting.main.color, '#ffcc88'); assert.equal(settings.lighting.main.azimuthDegrees, 270);
  assert.equal(settings.lighting.environmentIntensity, .6); assert.equal(settings.lighting.allowDayNightCycle, false);
  assert.equal(settings.appearance.backgroundColor, '#123456'); assert.equal(settings.appearance.exposure, 1.35);
  assert.equal(settings.appearance.toneMappingEnabled, true);
  assert.deepEqual(settings.extension, expected.sceneSettings.extension);
  assert.deepEqual(settings.lighting.policy.extension, { keep: 'policy' });
  assert.deepEqual(scene.entities.cube.components.customBusiness, expected.entities.cube.components.customBusiness);
  if (checkOriginalMqtt) assert.deepEqual(scene.mqttConfig, expected.mqttConfig);
}

test('旧文件SOURCE与DIST只输出统一配置并保留旧GI过期标记，源文件和业务数据不变', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-unified-package-')); t.after(() => cleanup(root));
  const projectRoot = path.join(root, 'project'), scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const scene = legacyScene(); await attachOldResult(scene, projectRoot);
  await fs.mkdir(path.dirname(scenePath), { recursive: true });
  const original = JSON.stringify({ version: 5, extension: 'envelope', scene }); await fs.writeFile(scenePath, original);
  registry.authorizeAssetRoot(projectRoot);
  const signal = new AbortController().signal;
  const sourceOptions = { projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath: scenePath,
    outputRoot: path.join(root, 'source'), manifest: { projectId: '42', projectName: '统一照明', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
    signal, isPlatformImageReference: () => false, findSyncedImageForReference: async () => null, skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } };
  const packaged = await buildDigitalTwinSourcePackage(sourceOptions);
  const archive = await unzipper.Open.file(packaged.filePath);
  const portable = JSON.parse((await archive.files.find((file: any) => file.path === 'Scenes/main.scene.json').buffer()).toString());
  assert.equal(portable.version, CURRENT_SCENE_FILE_VERSION, '统一配置需要新文件版本，避免旧编辑器静默忽略照明');
  assertCanonical(portable.scene, scene); assert.equal(portable.extension, 'envelope');
  assert.equal(portable.scene.sceneSettings.lighting.result.signature, 'lighting-v1-0123456789abcdef');
  assert.notEqual(portable.scene.sceneSettings.lighting.result.signature, getSceneLightingBakeSignature(portable.scene));
  for (const asset of portable.scene.sceneSettings.lighting.result.assets) {
    const member = decodeURIComponent(new URL(asset.url).pathname.slice(1));
    assert.equal(sha(await archive.files.find((file: any) => file.path === member).buffer()), asset.sha256);
    assert.deepEqual(asset.extension, { keep: asset.id });
  }
  const prepared = await prepareDeploymentExport(original, 'unified-legacy', [], signal, () => {});
  const deployed = JSON.parse(prepared.sceneContent);
  assert.equal(deployed.version, CURRENT_SCENE_FILE_VERSION);
  assertCanonical(deployed.scene, scene, false); assert.equal(deployed.extension, 'envelope');
  // DIST 既有契约把连接设置放到 runtime-config，场景文档中只保留禁用占位配置。
  assert.equal(deployed.scene.mqttConfig.enabled, false); assert.equal(deployed.scene.mqttConfig.address, '');
  const runtimeMqtt = JSON.parse(prepared.runtimeConfigContent).mqtt;
  assert.equal(runtimeMqtt.enabled, true); assert.equal(runtimeMqtt.address, scene.mqttConfig.address);
  assert.equal(runtimeMqtt.subscriptions[0].topic, scene.mqttConfig.subscriptions[0].topic);
  assert.equal(deployed.scene.sceneSettings.lighting.result.signature, 'lighting-v1-0123456789abcdef');
  assert.deepEqual(deployed.scene.sceneSettings.lighting.result.extension, { keep: 'result' });
  const output = path.join(root, 'dist'); await fs.mkdir(output);
  await copyDeploymentFiles(prepared.assetFiles, output, 2, signal, () => {});
  for (const asset of deployed.scene.sceneSettings.lighting.result.assets) {
    const member = decodeURIComponent(new URL(asset.url).pathname.slice(1));
    assert.equal(sha(await fs.readFile(path.join(output, member))), asset.sha256);
  }
  const canonicalInput = JSON.stringify({ version: CURRENT_SCENE_FILE_VERSION, scene: migrateSceneLightingDocument(scene) });
  const nextScenePath = path.join(projectRoot, 'Scenes', 'new-format.scene.json');
  await fs.writeFile(nextScenePath, canonicalInput);
  const nextPackage = await buildDigitalTwinSourcePackage({ ...sourceOptions, entrySceneFilePath: nextScenePath, outputRoot: path.join(root, 'source-v6') });
  const nextArchive = await unzipper.Open.file(nextPackage.filePath);
  assert.equal(JSON.parse((await nextArchive.files.find((file: any) => file.path === 'Scenes/new-format.scene.json').buffer()).toString()).version, CURRENT_SCENE_FILE_VERSION);
  const nextDeployment = await prepareDeploymentExport(canonicalInput, 'unified-v6', [], signal, () => {});
  assert.equal(JSON.parse(nextDeployment.sceneContent).version, CURRENT_SCENE_FILE_VERSION);
  assert.equal(sha(await fs.readFile(scenePath)), sha(original));
  assert.equal(JSON.stringify({ version: 5, extension: 'envelope', scene }), original);
});

test('没有资源改址时本地、事务、组合和SOURCE打开入口仍迁移旧配置且不修改调用方对象', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-unified-recovery-')); t.after(() => cleanup(root));
  const scene = legacyScene(), envelope = { version: 5, scene }, content = JSON.stringify(envelope), signal = new AbortController().signal;
  const local = await recoverLocalSceneResourcePaths({ sceneContent: content, workspaceRoot: root });
  assert.equal(JSON.parse(local.sceneContent).version, CURRENT_SCENE_FILE_VERSION);
  assertCanonical(JSON.parse(local.sceneContent).scene, scene); assert.equal(local.restoredReferenceCount, 0);
  const transaction = await recoverLocalSceneResourceTransaction({ request: { sceneContent: content }, baseUrl: '', workspaceRoot: root,
    projectRoot: null, signal, isOriginalPathAllowed: () => false });
  assert.equal(JSON.parse(transaction.recoveredSceneContent).version, CURRENT_SCENE_FILE_VERSION);
  assertCanonical(JSON.parse(transaction.recoveredSceneContent).scene, scene); assert.deepEqual(transaction.issues, []);
  const composition = await recoverSceneCompositions(scene, path.join(root, 'shared'), null, '', signal);
  assertCanonical(composition.scene, scene); assert.deepEqual(composition.issues, []);
  const relocated = relocateDataPlatformScene(envelope, root) as any;
  assert.equal(relocated.version, CURRENT_SCENE_FILE_VERSION);
  assertCanonical(relocated.scene, scene);
  assert.equal(JSON.stringify(envelope), content);
});

test('本地恢复迁移尚无实例的路径规则，但完整identity不依赖过期缓存提示', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-unified-future-')); t.after(() => cleanup(root));
  const relative = 'Projects/42/Assets/Models/future/model.gltf', actual = path.join(root, relative);
  await fs.mkdir(path.dirname(actual), { recursive: true });
  await fs.writeFile(actual, JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }));
  const old = url('Z:/previous/' + relative), missingHint = url('Z:/retired/cache/model.glb');
  const scene: any = { entities: {}, sceneSettings: { lighting: normalizeSceneLightingConfig({ version: 2, bake: { enabled: false }, policy: {
    version: 1, defaults: {}, rules: [
      { id: 'future', enabled: false, target: { kind: 'resource', model: { sourceUrl: old } }, values: { castShadows: false } },
      { id: 'identity', enabled: true, target: { kind: 'resource', model: { identity: { sourceKey: 'a'.repeat(64), kind: 'model', resourceId: '42', modelPath: 'model.glb' }, sourceUrl: missingHint } }, values: {} },
    ],
  } }), appearance: normalizeSceneAppearanceConfig({}) } };
  const content = JSON.stringify({ version: 5, scene });
  const recovered = await recoverLocalSceneResourcePaths({ sceneContent: content, workspaceRoot: root });
  assert.deepEqual(recovered.issues, []); assert.equal(recovered.restoredReferenceCount, 1);
  const rules = JSON.parse(recovered.sceneContent).scene.sceneSettings.lighting.policy.rules;
  assert.equal(rules[0].target.model.sourceUrl, url(actual));
  assert.deepEqual(Object.keys(rules[0].target.model), ['sourceUrl']);
  assert.equal(rules[1].target.model.sourceUrl, missingHint);
  assert.equal(JSON.stringify({ version: 5, scene }), content);
});

test('发布剔除纯CAD只保留原有效v2结果，旧v1和已有过期结果不能重新变成有效', () => {
  const scene: any = { entityIds: ['cube', 'cad'], entities: {
    cube: { id: 'cube', components: { meshRenderer: { meshKind: 'cube' } } },
    cad: { id: 'cad', components: { transform: { position: { x: 2, y: 0, z: 0 } }, cadReference: { sourceUrl: 'editor-asset://local/ref.dxf' } } },
  }, sceneSettings: { lighting: normalizeSceneLightingConfig({ version: 2, bake: { enabled: false } }), appearance: normalizeSceneAppearanceConfig({}) } };
  scene.sceneSettings.lighting.result = { version: 1, signature: getSceneLightingBakeSignature(scene), createdAt: '2026-10-20T00:00:00Z', engineVersion: 'test',
    assets: [{ id: 'g', kind: 'geometry', url: 'g.json', byteLength: 1 }, { id: 'l', kind: 'lightmap', url: 'l.png', byteLength: 1 }, { id: 'p', kind: 'probes', url: 'p.json', byteLength: 1 }],
    surfaces: [{ key: 'cube/root', entityId: 'cube', nodeKey: 'root', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
    statistics: { meshCount: 1, triangleCount: 12, atlasCount: 1, probeCount: 1, textureBytes: 1, durationMs: 1 }, extension: { keep: 'result' } };
  const original = JSON.stringify(scene), published = { version: 5, scene };
  assert.equal(stripCadReferencesFromSceneFile(published), 1);
  assert.equal(published.version, CURRENT_SCENE_FILE_VERSION);
  assert.equal(published.scene.sceneSettings.lighting.result.signature, getSceneLightingBakeSignature(published.scene));
  assert.deepEqual(published.scene.sceneSettings.lighting.result.extension, { keep: 'result' });
  assert.equal(JSON.stringify(scene), original, '发布副本不得改写调用方保留的本地场景');
  for (const stale of ['lighting-v1-0123456789abcdef', 'lighting-v2-already-stale']) {
    const copy = JSON.parse(original); copy.sceneSettings.lighting.result.signature = stale;
    const snapshot = { scene: copy }; assert.equal(stripCadReferencesFromSceneFile(snapshot), 1);
    assert.equal(snapshot.scene.sceneSettings.lighting.result.signature, stale);
    assert.notEqual(snapshot.scene.sceneSettings.lighting.result.signature, getSceneLightingBakeSignature(snapshot.scene));
  }
  const mixed = JSON.parse(original); mixed.entities.cad.components.meshRenderer = { meshKind: 'cube' };
  mixed.sceneSettings.lighting.result.signature = getSceneLightingBakeSignature(mixed);
  const before = mixed.sceneSettings.lighting.result.signature, snapshot = { scene: mixed };
  stripCadReferencesFromSceneFile(snapshot);
  assert.equal(snapshot.scene.sceneSettings.lighting.result.signature, before);
  assert.notEqual(before, getSceneLightingBakeSignature(snapshot.scene));
});

async function cleanup(root: string): Promise<void> {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('lighting-unified-')) throw new Error('测试目录清理范围无效。');
  await fs.rm(root, { recursive: true, force: true });
}
