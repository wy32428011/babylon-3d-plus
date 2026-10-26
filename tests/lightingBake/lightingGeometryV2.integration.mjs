import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { getSceneLightingBakeSignature, getSceneLightingBakeError } from '../../electron/shared/sceneLightingBakeContract.ts';
import { normalizeSceneAppearanceConfig, normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';
import { validateLightingGeometry } from '../../electron/shared/sceneLightingBakeArtifacts.ts';

const output = path.resolve(process.env.LIGHTING_GEOMETRY_V2_OUTPUT ?? 'output/render-optimization-q1-20261024/b6/real-service');
await fs.mkdir(output, { recursive: true });
const host = path.join(output, 'host');
const stub = 'data:text/javascript,' + encodeURIComponent('export const app={isPackaged:false,getPath:()=>'
  + JSON.stringify(host) + ',getAppPath:()=>process.cwd()}; export const dialog={},ipcMain={},net={},shell={},BrowserWindow={},protocol={},session={};');
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'electron') return next(stub, context);
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/electron/')) {
    const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(source)) return next(source.href, context);
  }
  return next(specifier, context);
} });
// SOURCE 内部仍有同步 require，和同依赖的异步 import 并发会触发 Node 模块装载竞态。
const service = await import('../../electron/ipc/lightingBakeService.ts');
const transport = await import('../../electron/ipc/sceneLightingBakeResources.ts');
const deployment = await import('../../electron/ipc/deploymentExportScene.ts');
const copy = await import('../../electron/ipc/deploymentExportFileSystem.ts');
const source = await import('../../electron/ipc/digitalTwinSourcePackage.ts');
const registry = await import('../../electron/ipc/assetRegistry.ts');
hooks.deregister();
const input = JSON.parse(await fs.readFile('tests/lightingBake/fixtures/actual-seven-surfaces.json', 'utf8'));
input.jobId = 'b6-v2-' + Date.now();
const projectRoot = path.join(output, input.jobId), scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
await fs.mkdir(path.dirname(scenePath), { recursive: true });
const scene = { id: 'b6', name: 'B6 实际 Cycles 与运输', entityIds: input.meshes.map(mesh => mesh.entityId),
  entities: Object.fromEntries(input.meshes.map(mesh => [mesh.entityId, { id: mesh.entityId, parentId: null,
    components: { meshRenderer: { meshKind: 'cube' }, transform: { position: { x: 0, y: 0, z: 0 } } } }])),
  sceneSettings: { lighting: normalizeSceneLightingConfig({ version: 2, bake: input.settings }), appearance: normalizeSceneAppearanceConfig({}) }, mqttConfig: { enabled: false } };
input.signature = getSceneLightingBakeSignature(scene);
const engine = await service.findLightingBakeEngine(projectRoot);
assert.equal(engine.available, true, engine.message);
const authorized = new Set(), signal = new AbortController().signal;
const decode = url => decodeURIComponent(new URL(url).pathname.slice(1));
const snapshot = await service.runLightingBakeJob({ input, projectRoot, enginePath: engine.path, signal,
  isProjectCurrent: () => true, isAuthorizedAssetFile: file => authorized.has(file), decodeAssetUrl: decode,
  encodeAssetUrl: file => 'editor-asset://local/' + encodeURIComponent(file), authorizeAssetFile: file => authorized.add(file),
  onProgress: () => {}, timeoutMs: 180000 });
assert.equal(snapshot.surfaces.length, input.meshes.length);
assert.equal((await fs.readdir(path.join(projectRoot, 'Assets', 'LightingBakes'))).some(name => name.startsWith('.pending-')), false);
let vertices = 0, corners = 0;
for (const asset of snapshot.assets) {
  const bytes = await fs.readFile(decode(asset.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  if (asset.kind === 'geometry') {
    assert.equal(asset.geometryVersion, 2);
    const geometry = validateLightingGeometry(JSON.parse(bytes.toString('utf8')));
    assert.equal(geometry.version, 2); vertices += geometry.positions.length / 3; corners += geometry.indices.length;
  }
}
scene.sceneSettings.lighting.result = snapshot;
assert.equal(getSceneLightingBakeError(scene), null);
const content = JSON.stringify({ version: 6, scene });
await fs.writeFile(scenePath, content);
const saved = await transport.prepareLightingSceneSave(content, path.join(output, input.jobId + '-saved', 'Scenes', 'main.scene.json'), { projectRoot });
assert.deepEqual(JSON.parse(saved.content).scene.sceneSettings.lighting.result.assets.map(asset => asset.geometryVersion), snapshot.assets.map(asset => asset.geometryVersion));
registry.authorizeAssetRoot(projectRoot);
const prepared = await deployment.prepareDeploymentExport(content, 'b6-dist', [], signal, () => {});
const distRoot = path.join(output, input.jobId + '-dist');
await fs.mkdir(distRoot);
await copy.copyDeploymentFiles(prepared.assetFiles, distRoot, 2, signal, () => {});
const distScene = JSON.parse(prepared.sceneContent).scene;
assert.equal(getSceneLightingBakeError(distScene), null);
for (const asset of distScene.sceneSettings.lighting.result.assets) {
  const bytes = await fs.readFile(path.join(distRoot, decode(asset.url)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  if (asset.kind === 'geometry') assert.equal(asset.geometryVersion, 2);
}
const bundle = await source.buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot: path.join(output, 'shared'), entrySceneFilePath: scenePath,
  outputRoot: path.join(output, input.jobId + '-source'), manifest: { projectId: 'b6', projectName: 'B6', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
  signal, isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
  skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
const archive = await createRequire(import.meta.url)('unzipper').Open.file(bundle.filePath);
const portable = JSON.parse((await archive.files.find(file => file.path === 'Scenes/main.scene.json').buffer()).toString('utf8')).scene;
assert.equal(getSceneLightingBakeError(portable), null);
for (const asset of portable.sceneSettings.lighting.result.assets) {
  const bytes = await archive.files.find(file => file.path === decode(asset.url)).buffer();
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  if (asset.kind === 'geometry') assert.equal(asset.geometryVersion, 2);
}
const report = { status: 'PASS', blender: engine.version, device: 'CPU', projectRoot, vertices, corners,
  geometryAssets: snapshot.assets.filter(asset => asset.kind === 'geometry').length,
  saveAssets: saved.files.length, sourceAssets: portable.sceneSettings.lighting.result.assets.length,
  distAssets: distScene.sceneSettings.lighting.result.assets.length, allGeometryVersion: 2, sourceArchive: bundle.filePath };
await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log('LIGHTING_GEOMETRY_V2_INTEGRATION_PASS ' + JSON.stringify(report));
