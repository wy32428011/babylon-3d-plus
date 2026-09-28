import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import electron from 'electron';

const require = createRequire(import.meta.url), { app } = electron;
const root = await mkdtemp(path.resolve('node_modules/.opening-plugin-packages-'));
app.setPath('userData', path.join(root, 'user-data'));
app.getAppPath = () => process.cwd();
const controller = new AbortController();
const timeout = setTimeout(() => { controller.abort(); console.error('开场插件实际双包验证超时'); app.exit(1); }, 180_000);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n3AAAAAASUVORK5CYII=', 'base64');

async function modules() {
  const entry = path.join(root, 'entry.mjs');
  await writeFile(entry, "export { createEmptySceneDocument } from '../../src/editor/model/SceneDocument.ts';\nexport { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';");
  const { build } = await import('vite');
  await build({ configFile: false, publicDir: false, logLevel: 'silent', build: { ssr: entry, outDir: path.join(root, 'modules'), rolldownOptions: { output: { entryFileNames: 'scene.mjs' } } } });
  return import(pathToFileURL(path.join(root, 'modules/scene.mjs')).href);
}
async function entryText(archive, name) {
  const entry = archive.files.find(file => file.path === name); assert.ok(entry, name);
  return (await entry.buffer()).toString('utf8');
}
async function extract(archive, target) {
  await mkdir(target, { recursive: true });
  for (const entry of archive.files) {
    const file = path.resolve(target, entry.path), relative = path.relative(target, file);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    if (entry.type === 'Directory') await mkdir(file, { recursive: true });
    else { await mkdir(path.dirname(file), { recursive: true }); await pipeline(entry.stream(), createWriteStream(file)); }
  }
}

let code = 1;
try {
  for (const dependency of ['dist-electron/ipc/openingPackageStore.js', 'dist-viewer-template/index.html',
    'output/opening-packages/reference-huishan-1.0.0.opening.zip', 'output/opening-packages/campus-network-1.0.0.opening.zip']) {
    try { await access(dependency); } catch { throw new Error(`缺少 ${dependency}，请先构建 Electron/Viewer 并运行 scripts/build-opening-packages.mjs。`); }
  }
  const [{ importOpeningPackageArchive }, { importOpeningImage }, { collectOpeningSourceBundles, resolveOpeningPackageResources, prepareOpeningSceneContent },
    { buildDigitalTwinSourcePackage }, { buildDigitalTwinDistPackage }, { relocateDataPlatformScene }, { setCurrentProjectRoot, ensureProjectDirectories }, sceneApi] = await Promise.all([
    import('../../dist-electron/ipc/openingPackageStore.js'), import('../../dist-electron/ipc/openingAssetStore.js'),
    import('../../dist-electron/ipc/openingPackageResources.js'), import('../../dist-electron/ipc/digitalTwinSourcePackage.js'),
    import('../../dist-electron/ipc/digitalTwinDistPackage.js'), import('../../dist-electron/ipc/dataPlatformSceneRelocation.js'),
    import('../../dist-electron/ipc/projectAssetStore.js'), modules(),
  ]);
  const { serializeScene, deserializeScene, createEmptySceneDocument } = sceneApi;
  const projectRoot = path.join(root, 'project'); await ensureProjectDirectories(projectRoot); setCurrentProjectRoot(projectRoot);
  await mkdir(path.join(projectRoot, 'Scenes'));
  const a = await importOpeningPackageArchive(projectRoot, path.resolve('output/opening-packages/reference-huishan-1.0.0.opening.zip'));
  const b = await importOpeningPackageArchive(projectRoot, path.resolve('output/opening-packages/campus-network-1.0.0.opening.zip'));
  await writeFile(path.join(root, 'override.png'), png);
  const override = await importOpeningImage(projectRoot, path.join(root, 'override.png'));
  // 使用真实主进程处理器，仅替换原生文件选择对话框；renderer 无法自行指定任意导入路径。
  const handlers = new Map(), oldHandle = electron.ipcMain.handle, oldOpen = electron.dialog.showOpenDialog, oldSave = electron.dialog.showSaveDialog;
  try {
    electron.ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
    const { registerOpeningPackageIpc } = await import('../../dist-electron/ipc/openingPackageIpc.js'); registerOpeningPackageIpc();
    assert.equal((await handlers.get('opening:listPackages')()).packages.length, 2);
    electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.resolve('output/opening-packages/campus-network-1.0.0.opening.zip')] });
    assert.equal((await handlers.get('opening:importPackage')()).package.id, b.id);
    electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(root, 'override.png')] });
    assert.equal((await handlers.get('opening:importAsset')()).sha256, override.sha256);
    electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(root, 'exported.opening.zip') });
    assert.equal((await handlers.get('opening:exportPackage')({}, b)).canceled, false);
    electron.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    assert.equal((await handlers.get('opening:importPackage')()).canceled, true);
    assert.equal((await handlers.get('opening:importAsset')()).canceled, true);
  } finally { electron.ipcMain.handle = oldHandle; electron.dialog.showOpenDialog = oldOpen; electron.dialog.showSaveDialog = oldSave; }
  const scenes = [a, a, b].map((binding, i) => {
    const scene = createEmptySceneDocument(`包场景 ${i + 1}`);
    scene.sceneSettings.openingAnimation = { ...scene.sceneSettings.openingAnimation, enabled: true, template: 'package', package: structuredClone(binding) };
    const own = scene.sceneSettings.openingAnimation.package;
    const textKey = Object.entries(own.definition.schema.properties).find(([, field]) => field.type === 'string' && !field.format)?.[0];
    if (textKey) own.config.values[textKey] = `独立文案 ${i + 1}`;
    if (i === 0) own.config.assetOverrides = { [own.definition.manifest.assets.find(asset => asset.type === 'image').id]: { assetUrl: override.assetUrl, size: override.size, sha256: override.sha256 } };
    if (i === 1) { own.config.stages[2].durationSeconds = 0; own.config.stages[2].routes = []; }
    return scene;
  });
  const legacy = createEmptySceneDocument('旧场景'); const legacyFile = JSON.parse(serializeScene(legacy)); delete legacyFile.scene.sceneSettings.openingAnimation;
  const contents = [...scenes.map(serializeScene), JSON.stringify(legacyFile)];
  for (let i = 0; i < contents.length; i++) await writeFile(path.join(projectRoot, 'Scenes', `${i}.scene.json`), contents[i]);
  const source = await buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath: path.join(projectRoot, 'Scenes/0.scene.json'),
    outputRoot: path.join(root, 'source'), signal: controller.signal, manifest: { projectId: '123', projectName: '开场插件包验收', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
    isPlatformImageReference: () => false, findSyncedImageForReference: async () => null, skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
  assert.equal(source.sceneCount, 4); assert.equal(source.omittedResources.length, 0);
  const unzipper = require('unzipper'), sourceZip = await unzipper.Open.file(source.filePath);
  assert.equal(sourceZip.files.filter(file => /^Assets\/OpeningPackages\/[^/]+\/[^/]+\/manifest\.json$/.test(file.path)).length, 2);
  assert.equal(sourceZip.files.filter(file => file.type === 'File' && file.path.startsWith('Assets/OpeningAssets/')).length, 1);
  const movedRoot = path.join(root, 'moved'); await extract(sourceZip, movedRoot);
  for (let i = 0; i < contents.length; i++) {
    const portable = await entryText(sourceZip, `Scenes/${i}.scene.json`);
    assert.ok(!portable.includes(encodeURIComponent(projectRoot)) && !portable.includes(projectRoot.replace(/\\/g, '\\\\')), 'SOURCE 不保留本机资源路径');
    assert.equal(await readFile(path.join(projectRoot, `Scenes/${i}.scene.json`), 'utf8'), contents[i]);
    const relocated = relocateDataPlatformScene(JSON.parse(portable), movedRoot);
    if (i < 3) {
      const binding = deserializeScene(JSON.stringify(relocated)).sceneSettings.openingAnimation.package;
      assert.deepEqual(binding.config.values, scenes[i].sceneSettings.openingAnimation.package.config.values);
      assert.deepEqual(binding.config.stages, scenes[i].sceneSettings.openingAnimation.package.config.stages);
      assert.ok(await resolveOpeningPackageResources(relocated, movedRoot));
      assert.ok(await resolveOpeningPackageResources(JSON.parse(await prepareOpeningSceneContent(contents[i], path.join(movedRoot, `Scenes/${i}.scene.json`))), movedRoot));
    } else assert.equal(deserializeScene(JSON.stringify(relocated)).sceneSettings.openingAnimation.enabled, false);
  }
  const distRoots = [];
  for (const index of [0, 2, 3]) {
    const dist = await buildDigitalTwinDistPackage({ projectId: '123', publishName: `开场 ${index}`, sceneContent: contents[index], outputRoot: path.join(root, `dist-${index}`), sourceResourceFiles: source.resourceFiles, signal: controller.signal });
    const archive = await unzipper.Open.file(dist.filePath), sceneText = await entryText(archive, 'project/scene.json');
    assert.ok(!sceneText.includes(encodeURIComponent(projectRoot)) && !sceneText.includes(projectRoot.replace(/\\/g, '\\\\')), 'DIST 不保留本机资源路径');
    const parsed = deserializeScene(sceneText);
    const packageFiles = archive.files.filter(file => file.type === 'File' && file.path.startsWith('project/assets/openings/'));
    assert.equal(packageFiles.filter(file => file.path.endsWith('/manifest.json')).length, index === 3 ? 0 : 1);
    if (index < 3) assert.deepEqual(parsed.sceneSettings.openingAnimation.package.config.values, scenes[index].sceneSettings.openingAnimation.package.config.values);
    const cache = JSON.parse(await entryText(archive, 'release-cache-manifest.json'));
    for (const file of archive.files.filter(file => file.type === 'File' && file.path.startsWith('project/assets/'))) {
      const item = cache.files.find(value => decodeURIComponent(value.path) === file.path); assert.ok(item, `缓存清单包含 ${file.path}`);
      const bytes = await file.buffer(); assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(item.storage, 'asset');
    }
    const output = path.resolve('output/opening-packages', `viewer-${index === 0 ? 'reference' : index === 2 ? 'campus' : 'legacy'}`);
    await mkdir(output, { recursive: true });
    await extract(archive, output); distRoots.push(output);
  }
  const invalid = JSON.parse(contents[0]); invalid.scene.sceneSettings.openingAnimation.package.definition.defaults = { ...invalid.scene.sceneSettings.openingAnimation.package.definition.defaults };
  invalid.scene.sceneSettings.openingAnimation.package.definition.timeline.stages[0].durationSeconds += 1;
  await assert.rejects(collectOpeningSourceBundles([invalid], projectRoot, controller.signal), /校验失败/);
  await writeFile(path.resolve('output/opening-packages/packages-result.json'), JSON.stringify({ sourceScenes: 4, distinctPackages: 2, overrideImages: 1, distRoots, checked: ['real-main-process-ipc', 'source-dist-integrity', 'multi-scene-isolation', 'moved-project-reopen', 'legacy-scene', 'release-cache-coverage', 'definition-mismatch-blocking'] }, null, 2));
  console.log(JSON.stringify({ passed: true, sourceScenes: 4, distinctPackages: 2, overrideImages: 1, distRoots })); code = 0;
} catch (error) { console.error(error); }
finally {
  clearTimeout(timeout);
  if (path.dirname(root) !== path.resolve('node_modules') || !path.basename(root).startsWith('.opening-plugin-packages-')) throw new Error('拒绝清理测试目录外路径');
  await rm(root, { recursive: true, force: true }); app.exit(code);
}
