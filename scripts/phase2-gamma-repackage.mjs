import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { verifyGiSourceReadback } from '../tests/helpers/phase2GiArtifacts.mjs';
import { verifyBusinessGiViewer } from '../tests/helpers/phase2GiViewer.mjs';

const args = { previous: 'output/phase2-completion-20261025/b8-gamma-business-6/report.json', verify: false };
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--previous') args.previous = process.argv[++index];
  else if (process.argv[index] === '--output') args.output = process.argv[++index];
  else if (process.argv[index] === '--verify') args.verify = true;
  else throw new Error('未知repackage-only参数：' + process.argv[index]);
}
assert.ok(args.output, '必须指定全新--output，--verify才启动实际Viewer');
const repository = process.cwd(), output = path.resolve(args.output), base = path.resolve('output');
assert.ok(output.startsWith(base + path.sep) && output !== base);
await fs.mkdir(output);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const previousBytes = await fs.readFile(args.previous), previous = JSON.parse(previousBytes.toString('utf8'));
const sceneFile = previous.preparation.scenePath, sceneBytes = await fs.readFile(sceneFile), saved = JSON.parse(sceneBytes.toString('utf8'));
assert.equal(saved.scene.sceneSettings.lighting.version, 3); assert.equal(saved.scene.sceneSettings.lighting.bake.lightmapEncoding, 'rgbm-gamma');
assert.equal(saved.scene.sceneSettings.modelEntrance.enabled, true, '不能关闭原入场来追绿');
const report = { status: 'RUNNING', scope: 'repackage exact already-baked case6 scene/assets with current Viewer; no Cycles, no scene rewrite, no publish',
  startedAt: new Date().toISOString(), previousReport: path.resolve(args.previous), previousReportSha256: sha(previousBytes),
  savedScenePath: sceneFile, savedSceneSha256: sha(sceneBytes), originalEntrance: saved.scene.sceneSettings.modelEntrance,
  previousSourceSha256: sha(await fs.readFile(previous.packages.source.filePath)), previousDistSha256: sha(await fs.readFile(previous.packages.dist.filePath)),
  sourceHashes: {}, buildHashes: {}, cleanup: [] };
const sourceFiles = ['src/runtime/babylon/lightingMaterialOverrides.ts', 'src/runtime/babylon/ModelEntranceRuntime.ts', 'src/runtime/babylon/BakedLightingMaterialPlugin.ts',
  'src/runtime/babylon/lightingRuntimeCapture.ts', 'src/runtime/babylon/lightingGeometry.ts', 'src/runtime/babylon/SceneLightingRuntime.ts',
  'src/runtime/babylon/scene-runtime/ScenePoiAndEffectsController.ts', 'src/runtime/babylon/lightingClassificationRuntime.ts',
  'src/runtime/babylon/lightingEntranceGeometryUpdates.ts', 'tests/helpers/phase2GiViewer.mjs', 'scripts/phase2-gamma-repackage.mjs'];
for (const file of sourceFiles) report.sourceHashes[file] = sha(await fs.readFile(file));
for (const file of ['dist-electron/main.js', 'dist-viewer-template/index.html', 'dist-viewer-template/viewer-capabilities.json']) report.buildHashes[file] = sha(await fs.readFile(file));
const save = async phase => { report.phase = phase; await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log('[gamma-repackage]', phase); };
let application, bootstrap;
try {
  const userData = path.join(output, 'user-data'); await fs.mkdir(userData);
  await fs.writeFile(path.join(userData, 'data-platform-config.json'), JSON.stringify({ version: 2, baseUrl: '', workspaceRoot: output }));
  const moduleUrl = name => pathToFileURL(path.join(repository, 'dist-electron/ipc', name + '.js')).href;
  bootstrap = path.join(repository, '.tmp-phase2-gamma-repackage-' + randomUUID() + '.mjs');
  await fs.writeFile(bootstrap, "import {app,BrowserWindow} from 'electron';\napp.setPath('userData'," + JSON.stringify(userData) + ');\napp.whenReady().then(async()=>{\n'
    + 'globalThis.phase2GammaPackageHost={source:await import(' + JSON.stringify(moduleUrl('digitalTwinSourcePackage')) + '),dist:await import(' + JSON.stringify(moduleUrl('digitalTwinDistPackage'))
    + '),images:await import(' + JSON.stringify(moduleUrl('dataPlatformImageSync')) + '),assets:await import(' + JSON.stringify(moduleUrl('projectAssetStore'))
    + '),registry:await import(' + JSON.stringify(moduleUrl('assetRegistry')) + ')};\n'
    + "const window=new BrowserWindow({show:false});await window.loadURL('data:text/html,<p>owned native packaging driver</p>');\n}).catch(error=>{console.error(error.stack??error);app.exit(1);});\n", { flag: 'wx' });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [bootstrap, '--user-data-dir=' + userData], cwd: repository, env, timeout: 60000 });
  report.packagerPid = application.process().pid;
  await application.firstWindow();
  report.packagerHost = await application.evaluate(({ app }) => ({ appPath: app.getAppPath(), userData: app.getPath('userData'), versions: process.versions }));
  assert.equal(path.resolve(report.packagerHost.appPath), repository); assert.equal(path.resolve(report.packagerHost.userData), userData);
  await save('native-packagers-ready');
  report.packages = await application.evaluate(async (_electron, setup) => {
    const host = globalThis.phase2GammaPackageHost;
    await host.assets.activateProjectRoot(setup.projectRoot); host.registry.authorizeAssetRoot(setup.projectRoot);
    const signal = new AbortController().signal;
    const source = await host.source.buildDigitalTwinSourcePackage({ projectRoot: setup.projectRoot, sharedResourcesRoot: setup.shared,
      entrySceneFilePath: setup.scene, outputRoot: setup.sourceOutput, signal,
      manifest: { projectId: '9000000000000000001', projectName: 'B8同一烘焙副本严格入口复验', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
      isPlatformImageReference: host.images.isPlatformImageReference, findSyncedImageForReference: host.images.findSyncedImageForReference,
      skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
    const dist = await host.dist.buildDigitalTwinDistPackage({ projectId: '9000000000000000001', publishName: 'B8同一烘焙副本严格入口复验',
      sceneContent: source.entrySceneContent, sourceResourceFiles: source.resourceFiles, outputRoot: setup.distOutput, signal });
    return { source: { filePath: source.filePath, fileSize: source.fileSize, sha256: source.sha256, entryScenePath: source.entryScenePath,
      warnings: source.warnings, omittedResources: source.omittedResources }, dist };
  }, { projectRoot: previous.preparation.projectRoot, shared: path.join(output, 'shared'), scene: sceneFile,
    sourceOutput: path.join(output, 'source-package'), distOutput: path.join(output, 'dist-package') });
  assert.equal(sha(await fs.readFile(report.packages.source.filePath)), report.packages.source.sha256);
  assert.equal(sha(await fs.readFile(report.packages.dist.filePath)), report.packages.dist.sha256);
  report.sourceReadback = await verifyGiSourceReadback({ root: report.packages.source.filePath, entryScenePath: report.packages.source.entryScenePath,
    expectedSnapshot: previous.snapshot, expectedScene: saved.scene });
  await application.close(); application = null; report.cleanup.push({ name: 'close-owned-packager', status: 'PASS' });
  await save('same-baked-source-dist-built-and-readback');
  if (args.verify) report.viewer = await verifyBusinessGiViewer({ root: report.packages.dist.filePath, snapshot: previous.snapshot, expectedScene: saved.scene,
    output, projectId: '9000000000000000001', gamma: true, iframe: true });
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  if (application) { await application.close(); report.cleanup.push({ name: 'close-owned-packager', status: 'PASS' }); }
  if (bootstrap) { await fs.unlink(bootstrap); report.cleanup.push({ name: 'remove-owned-bootstrap', status: 'PASS' }); }
  report.savedSceneUnchanged = sha(await fs.readFile(sceneFile)) === report.savedSceneSha256;
  report.previousSourceUnchanged = sha(await fs.readFile(previous.packages.source.filePath)) === report.previousSourceSha256;
  report.previousDistUnchanged = sha(await fs.readFile(previous.packages.dist.filePath)) === report.previousDistSha256;
  report.sourceVersionsStable = (await Promise.all(sourceFiles.map(async file => sha(await fs.readFile(file)) === report.sourceHashes[file]))).every(Boolean);
  report.bakedAssetsUnchanged = true;
  for (const asset of previous.snapshot.assets) {
    const filename = decodeURIComponent(new URL(asset.url).pathname.slice(1));
    if (sha(await fs.readFile(filename)) !== asset.sha256) report.bakedAssetsUnchanged = false;
  }
  if (![report.savedSceneUnchanged, report.previousSourceUnchanged, report.previousDistUnchanged, report.sourceVersionsStable, report.bakedAssetsUnchanged].every(Boolean)) { report.status = 'FAIL'; process.exitCode = 1; }
  await save('complete'); console.log(JSON.stringify({ status: report.status, output, error: report.error }));
}
