import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';
import { normalizeSceneAppearanceConfig, normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';

const host = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-policy-host-'));
after(() => cleanup(host));
const electronStub = 'data:text/javascript,' + encodeURIComponent(
  'export const app={isPackaged:false,getPath:()=>'+JSON.stringify(host)+',getAppPath:()=>process.cwd()}; export const dialog={},ipcMain={},net={},shell={},BrowserWindow={},protocol={},session={};',
);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return next(electronStub, context);
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/electron/')) {
      const target = new URL(specifier, context.parentURL), source = new URL(target.href.slice(0, -3) + '.ts');
      if (!existsSync(target) && existsSync(source)) return next(source.href, context);
    }
    return next(specifier, context);
  },
});
const { captureSceneLightingBakeRelocation, restoreSceneLightingBakeAfterMappedRewrite } = await import('../../electron/shared/sceneLightingBakeRelocation.ts');
const { relocateDataPlatformScene } = await import('../../electron/ipc/dataPlatformSceneRelocation.ts');
const { buildDigitalTwinSourcePackage } = await import('../../electron/ipc/digitalTwinSourcePackage.ts');
const { prepareDeploymentExport } = await import('../../electron/ipc/deploymentExportScene.ts');
const registry = await import('../../electron/ipc/assetRegistry.ts');
hooks.deregister();
const unzipper = createRequire(import.meta.url)('unzipper');
const url = (file: string) => 'editor-asset://local/' + encodeURIComponent(file);

function sceneFixture(root = 'C:/before'): any {
  const model = root + '/Assets/Models/pump/model.glb';
  return { id: 'policy-scene', name: '集中规则迁移', entityIds: ['pump'], entities: {
    pump: { id: 'pump', name: 'pump', parentId: null, childrenIds: [], components: {
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      modelAsset: { sourcePath: model, sourceUrl: url(model), assetRevision: 'r1' },
    } },
  }, sceneSettings: { lighting: normalizeSceneLightingConfig({ version: 2, bake: { enabled: false }, policy: { version: 1, defaults: {}, rules: [{
    id: 'pump-rule', enabled: true, target: { kind: 'resource', model: { sourceUrl: url(model), sourcePath: model } },
    values: { castShadows: false }, nodeRules: [{ id: 'part', enabled: true,
      target: { kind: 'node', nodeKey: 'frame[0]', resourceIdentity: 'geometry-v1' }, values: { receiveShadows: false } }],
  }] } }), appearance: normalizeSceneAppearanceConfig({}) }, mqttConfig: { enabled: false } };
}

function attachResult(scene: ReturnType<typeof sceneFixture>, root = 'C:/before') {
  scene.sceneSettings.lighting.result = { version: 1, signature: getSceneLightingBakeSignature(scene),
    createdAt: '2026-10-21T00:00:00Z', engineVersion: 'fixture', probeAssetId: 'p',
    assets: [
      { id: 'g', kind: 'geometry', url: url(root + '/Assets/LightingBakes/job/g.json'), byteLength: 1, sha256: 'a'.repeat(64) },
      { id: 'l', kind: 'lightmap', url: url(root + '/Assets/LightingBakes/job/l.png'), byteLength: 1, sha256: 'b'.repeat(64) },
      { id: 'p', kind: 'probes', url: url(root + '/Assets/LightingBakes/job/p.json'), byteLength: 1, sha256: 'c'.repeat(64) },
    ], surfaces: [{ key: 'pump/frame[0]/primitive:0', entityId: 'pump', nodeKey: 'frame[0]', geometryAssetId: 'g', lightmapAssetId: 'l' }],
    statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 1 },
  };
  return scene;
}

test('规则路径等价迁移保留有效GI，但改规则值或已有过期结果不能被重签掩盖', () => {
  const original = attachResult(sceneFixture());
  const restore = captureSceneLightingBakeRelocation(original)!;
  const moved = JSON.parse(JSON.stringify(original).replaceAll('C:/before', 'D:/after').replaceAll('C%3A%2Fbefore', 'D%3A%2Fafter'));
  assert.equal(restore(moved), true);
  assert.equal(moved.sceneSettings.lighting.result.signature, getSceneLightingBakeSignature(moved));
  const changed = structuredClone(original);
  changed.sceneSettings.lighting.policy.rules[0].values.castShadows = true;
  assert.equal(restore(changed), false);
  assert.equal(changed.sceneSettings.lighting.result.signature, original.sceneSettings.lighting.result.signature);
  const stale = structuredClone(original);
  stale.sceneSettings.lighting.result.signature = 'already-stale';
  assert.equal(captureSceneLightingBakeRelocation(stale), null);
  const relocated = relocateDataPlatformScene({ scene: stale }, 'D:/after') as any;
  assert.equal(relocated.scene.sceneSettings.lighting.result.signature, 'already-stale');
});

test('只有本次精确路径映射允许部署规则改名，node身份或规则语义改变仍拒绝', () => {
  const original = attachResult(sceneFixture());
  const modelBefore = original.entities.pump.components.modelAsset.sourceUrl;
  const mapped = url('project/assets/models/pump-content/model.glb');
  const mapping = new Map([[modelBefore, mapped], [original.entities.pump.components.modelAsset.sourcePath, mapped]]);
  const rewrite = (value: any): any => typeof value === 'string' ? mapping.get(value) ?? value
    : Array.isArray(value) ? value.map(rewrite)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)])) : value;
  const deployed = rewrite(original);
  assert.equal(restoreSceneLightingBakeAfterMappedRewrite(original, deployed, mapping), true);
  const changed = rewrite(original);
  changed.sceneSettings.lighting.policy.rules[0].nodeRules[0].target.resourceIdentity = 'other-geometry';
  assert.equal(restoreSceneLightingBakeAfterMappedRewrite(original, changed, mapping), false);
});

test('没有GI结果时SOURCE和DIST仍迁移集中规则的资源路径，保存规则和稳定part身份', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-policy-package-'));
  t.after(() => cleanup(root));
  const projectRoot = path.join(root, 'project'), scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const scene = sceneFixture(projectRoot.replace(/\\/g, '/'));
  const model = scene.entities.pump.components.modelAsset.sourcePath;
  const futureModel = path.join(projectRoot, 'Assets', 'Models', 'future-pump', 'model.glb');
  await fs.mkdir(path.dirname(model), { recursive: true });
  await fs.writeFile(model, 'fixture-model');
  await fs.writeFile(path.join(path.dirname(model), 'meta.json'), '{}');
  await fs.mkdir(path.dirname(futureModel), { recursive: true });
  await fs.writeFile(futureModel, 'future-model');
  await fs.writeFile(path.join(path.dirname(futureModel), 'meta.json'), '{}');
  (scene.sceneSettings.lighting.policy.rules as any[]).push({
    id: 'future-rule', enabled: false, target: { kind: 'resource', model: { sourceUrl: url(futureModel) } }, values: { receiveShadows: false },
  });
  await fs.mkdir(path.dirname(scenePath), { recursive: true });
  await fs.writeFile(scenePath, JSON.stringify({ version: 5, scene }));
  registry.authorizeAssetRoot(projectRoot);
  const sourceOptions = {
    projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath: scenePath, outputRoot: path.join(root, 'output'),
    manifest: { projectId: '42', projectName: '规则迁移', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
    signal: new AbortController().signal, isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
    skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null },
  };
  const source = await buildDigitalTwinSourcePackage(sourceOptions);
  const archive = await unzipper.Open.file(source.filePath);
  const portable = JSON.parse((await archive.files.find((entry: any) => entry.path === 'Scenes/main.scene.json').buffer()).toString());
  const portableTarget = portable.scene.sceneSettings.lighting.policy.rules[0].target.model;
  assert.match(decodeURIComponent(new URL(portableTarget.sourceUrl).pathname.slice(1)), /^Assets\/Models\//);
  assert.deepEqual(portable.scene.sceneSettings.lighting.policy.rules[0].nodeRules, scene.sceneSettings.lighting.policy.rules[0].nodeRules);
  const portableFuture = decodeURIComponent(new URL(portable.scene.sceneSettings.lighting.policy.rules[1].target.model.sourceUrl).pathname.slice(1));
  assert.ok(archive.files.some((entry: any) => entry.path === portableFuture), '尚无实例的规则资源也必须进入SOURCE快照');
  const reopenedRoot = path.join(root, 'reopened');
  const reopened = relocateDataPlatformScene(portable, reopenedRoot) as any;
  assert.ok(reopened.scene.sceneSettings.lighting.policy.rules[0].target.model.sourcePath.startsWith(reopenedRoot));

  const prepared = await prepareDeploymentExport(JSON.stringify({ version: 5, scene }), 'policy-factory', [],
    new AbortController().signal, () => {});
  const deployed = JSON.parse(prepared.sceneContent).scene;
  const deployedTarget = deployed.sceneSettings.lighting.policy.rules[0].target.model;
  assert.match(decodeURIComponent(new URL(deployedTarget.sourceUrl).pathname.slice(1)), /^project\/assets\/models\//);
  assert.equal(deployedTarget.sourceUrl, deployed.entities.pump.components.modelAsset.sourceUrl);
  assert.equal(deployed.sceneSettings.lighting.result, null);
  assert.deepEqual(deployed.sceneSettings.lighting.policy.rules[0].nodeRules, scene.sceneSettings.lighting.policy.rules[0].nodeRules);
  assert.ok(prepared.assetFiles.some(file => path.resolve(file.sourcePath) === path.resolve(model)));
  assert.ok(prepared.assetFiles.some(file => path.resolve(file.sourcePath) === path.resolve(futureModel)));
  assert.deepEqual(Object.keys(deployed.sceneSettings.lighting.policy.rules[1].target.model), ['sourceUrl'], '迁移不得扩写原规则未提供的引用字段');

  attachResult(scene, projectRoot.replace(/\\/g, '/'));
  for (const asset of scene.sceneSettings.lighting.result.assets) {
    const file = decodeURIComponent(new URL(asset.url).pathname.slice(1));
    const bytes = Buffer.from(asset.kind === 'lightmap' ? 'fixture-png' : '{"fixture":true}');
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
    asset.byteLength = bytes.length; asset.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  await fs.writeFile(scenePath, JSON.stringify({ version: 5, scene }));
  const withGi = await buildDigitalTwinSourcePackage({ ...sourceOptions, outputRoot: path.join(root, 'output-gi') });
  const withGiArchive = await unzipper.Open.file(withGi.filePath);
  const withGiScene = JSON.parse((await withGiArchive.files.find((entry: any) => entry.path === 'Scenes/main.scene.json').buffer()).toString()).scene;
  assert.equal(withGiScene.sceneSettings.lighting.result.signature, getSceneLightingBakeSignature(withGiScene));
  const validDeployment = JSON.parse((await prepareDeploymentExport(JSON.stringify({ version: 5, scene }), 'policy-with-gi', [],
    new AbortController().signal, () => {})).sceneContent).scene;
  assert.equal(validDeployment.sceneSettings.lighting.result.signature, getSceneLightingBakeSignature(validDeployment));
  const previousSignature = scene.sceneSettings.lighting.result.signature;
  scene.sceneSettings.lighting.policy.rules[0].values.castShadows = true;
  const staleDeployment = JSON.parse((await prepareDeploymentExport(JSON.stringify({ version: 5, scene }), 'policy-stale-gi', [],
    new AbortController().signal, () => {})).sceneContent).scene;
  assert.equal(staleDeployment.sceneSettings.lighting.result.signature, previousSignature);
  assert.notEqual(staleDeployment.sceneSettings.lighting.result.signature, getSceneLightingBakeSignature(staleDeployment));
});

test('完整identity规则不依赖已不存在的旧缓存路径，SOURCE和DIST保留扩展字段与有效GI', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-policy-identity-'));
  t.after(() => cleanup(root));
  const projectRoot = path.join(root, 'project'), scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const scene = sceneFixture(projectRoot.replace(/\\/g, '/'));
  const model = scene.entities.pump.components.modelAsset.sourcePath;
  await fs.mkdir(path.dirname(model), { recursive: true }); await fs.writeFile(model, 'current-resource');
  await fs.writeFile(path.join(path.dirname(model), 'meta.json'), '{}');
  const identity = { sourceKey: 'd'.repeat(64), kind: 'model', resourceId: '42', modelPath: 'model.glb' };
  Object.assign(scene.entities.pump.components.modelAsset, { dataPlatformModel: identity });
  const missing = path.join(projectRoot, 'Assets', 'Models', 'retired-cache', 'model.glb');
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  const rule = scene.sceneSettings.lighting.policy.rules[0] as any;
  rule.target.model = { identity, sourcePath: missing, sourceUrl: url(missing), extension: { keep: 'model-reference' } };
  rule.extension = { keep: 'rule' };
  (scene.sceneSettings.lighting.policy as any).extension = { keep: 'policy' };
  attachResult(scene, projectRoot.replace(/\\/g, '/'));
  for (const asset of scene.sceneSettings.lighting.result.assets) {
    const file = decodeURIComponent(new URL(asset.url).pathname.slice(1)), bytes = Buffer.from('identity-fixture-' + asset.kind);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
    asset.byteLength = bytes.length; asset.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  await fs.mkdir(path.dirname(scenePath), { recursive: true }); await fs.writeFile(scenePath, JSON.stringify({ version: 5, scene }));
  registry.authorizeAssetRoot(projectRoot);
  const packaged = await buildDigitalTwinSourcePackage({
    projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath: scenePath, outputRoot: path.join(root, 'source'),
    manifest: { projectId: '42', projectName: '身份规则', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
    signal: new AbortController().signal, isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
    skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null },
  });
  const archive = await unzipper.Open.file(packaged.filePath);
  const portable = JSON.parse((await archive.files.find((entry: any) => entry.path === 'Scenes/main.scene.json').buffer()).toString()).scene;
  const deployed = JSON.parse((await prepareDeploymentExport(JSON.stringify({ version: 5, scene }), 'identity-rule', [],
    new AbortController().signal, () => {})).sceneContent).scene;
  for (const rewritten of [portable, deployed]) {
    const policy = rewritten.sceneSettings.lighting.policy, target = policy.rules[0].target.model;
    assert.deepEqual(target.identity, identity);
    assert.equal(Object.hasOwn(target, 'sourcePath'), false); assert.equal(Object.hasOwn(target, 'sourceUrl'), false);
    assert.deepEqual(target.extension, { keep: 'model-reference' });
    assert.deepEqual(policy.rules[0].extension, { keep: 'rule' }); assert.deepEqual(policy.extension, { keep: 'policy' });
    assert.deepEqual(policy.rules[0].nodeRules, rule.nodeRules);
    assert.equal(rewritten.sceneSettings.lighting.result.signature, getSceneLightingBakeSignature(rewritten));
  }
  assert.equal(rule.target.model.sourcePath, missing, '导出准备不能改写调用方的场景对象');
});

async function cleanup(root: string): Promise<void> {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('lighting-policy-')) {
    throw new Error('测试目录清理范围无效。');
  }
  await fs.rm(root, { recursive: true, force: true });
}
