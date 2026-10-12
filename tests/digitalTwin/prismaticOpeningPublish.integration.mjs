import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import electron from 'electron';

const require = createRequire(import.meta.url), { app } = electron;
const root = await mkdtemp(path.resolve('node_modules/.prismatic-publish-'));
const output = path.resolve('output/playwright/prismatic-opening');
app.setPath('userData', path.join(root, 'user-data'));
app.getAppPath = () => process.cwd();
const controller = new AbortController();
const deadline = setTimeout(() => { controller.abort(); console.error('棱光创生发布验证超时'); app.exit(1); }, 120_000);

async function sceneApi() {
  const entry = path.join(root, 'entry.mjs');
  await writeFile(entry, "export { createEmptySceneDocument } from '../../src/editor/model/SceneDocument.ts';\nexport { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';");
  const { build } = await import('vite');
  await build({ configFile: false, publicDir: false, logLevel: 'silent', build: { ssr: entry,
    outDir: path.join(root, 'modules'), rolldownOptions: { output: { entryFileNames: 'scene.mjs' } } } });
  return import(pathToFileURL(path.join(root, 'modules/scene.mjs')).href);
}
const entryJson = async (archive, name) => {
  const entry = archive.files.find(file => file.path === name); assert.ok(entry, name);
  return JSON.parse((await entry.buffer()).toString('utf8'));
};

async function run() {
  let code = 1;
  try {
    for (const dependency of ['dist-electron/ipc/openingPackageStore.js', 'dist-viewer-template/index.html',
      'output/opening-packages/prismatic-genesis-1.0.0.dtopening', 'output/playwright/prismatic-opening/warehouse.glb']) await access(dependency);
    const [{ importOpeningPackageArchive }, { buildDigitalTwinSourcePackage }, { buildDigitalTwinDistPackage },
      { ensureProjectDirectories, setCurrentProjectRoot }, { authorizeAssetFile }, api] = await Promise.all([
      import('../../dist-electron/ipc/openingPackageStore.js'), import('../../dist-electron/ipc/digitalTwinSourcePackage.js'),
      import('../../dist-electron/ipc/digitalTwinDistPackage.js'), import('../../dist-electron/ipc/projectAssetStore.js'),
      import('../../dist-electron/ipc/assetRegistry.js'), sceneApi(),
    ]);
    const projectRoot = path.join(root, 'project'); await ensureProjectDirectories(projectRoot); setCurrentProjectRoot(projectRoot);
    const binding = await importOpeningPackageArchive(projectRoot, path.resolve('output/opening-packages/prismatic-genesis-1.0.0.dtopening'));
    const glb = path.join(projectRoot, 'Assets/Environments/warehouse.glb'); await mkdir(path.dirname(glb), { recursive: true });
    await copyFile(path.join(output, 'warehouse.glb'), glb); authorizeAssetFile(glb);
    const assetUrl = 'editor-asset://local/' + encodeURIComponent(glb);
    const scene = api.createEmptySceneDocument('棱光创生发布验收');
    scene.sceneSettings.shadows = { ...scene.sceneSettings.shadows, mode: 'realtime' };
    scene.sceneSettings.openingAnimation = { enabled: true, template: 'package', allowSkip: true, motionPreference: 'normal', package: binding };
    binding.config.values.brandName = '发布仓储验收'; binding.config.values.accentGold = '#ffc866';
    scene.sceneSettings.environment = { packagePath: glb, activeVariantUrl: assetUrl, variants: [{ name: '仓库', sourcePath: glb, sourceUrl: assetUrl }],
      lengthUnit: 'meter', unitScaleToMeters: 1, placementMode: 'scene-base', transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 }, visible: true, opacity: 1 };
    const content = api.serializeScene(scene), scenePath = path.join(projectRoot, 'Scenes/main.scene.json');
    assert.ok(api.deserializeScene(content).sceneSettings.environment, '导出前环境配置满足场景反序列化契约');
    await mkdir(path.dirname(scenePath), { recursive: true }); await writeFile(scenePath, content);
    const source = await buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath: scenePath,
      outputRoot: path.join(root, 'source'), signal: controller.signal,
      manifest: { projectId: '123', projectName: '棱光创生验收', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
      isPlatformImageReference: () => false, findSyncedImageForReference: async () => null, skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
    assert.equal(source.sceneCount, 1); assert.equal(source.omittedResources.length, 0);
    const { Open } = require('unzipper'), sourceArchive = await Open.file(source.filePath);
    assert.ok(sourceArchive.files.some(file => file.path.endsWith('warehouse.glb')), 'SOURCE携带环境模型');
    assert.equal(sourceArchive.files.filter(file => /^Assets\/OpeningPackages\/.+\/manifest.json$/.test(file.path)).length, 1);
    const portable = await entryJson(sourceArchive, 'Scenes/main.scene.json');
    assert.deepEqual(portable.scene.sceneSettings.openingAnimation.package.config, binding.config);
    const dist = await buildDigitalTwinDistPackage({ projectId: '123', publishName: '棱光创生验收', sceneContent: source.entrySceneContent,
      sourceResourceFiles: source.resourceFiles, outputRoot: path.join(root, 'dist'), signal: controller.signal });
    assert.deepEqual(dist.warnings, []);
    const archive = await Open.file(dist.filePath), published = await entryJson(archive, 'project/scene.json');
    assert.equal(published.scene.sceneSettings.openingAnimation.package.definition.manifest.renderer, 'prismatic-genesis');
    assert.deepEqual(published.scene.sceneSettings.openingAnimation.package.config, binding.config);
    assert.ok(published.scene.sceneSettings.environment.activeVariantUrl);
    const assets = archive.files.filter(file => file.type === 'File' && file.path.startsWith('project/assets/'));
    assert.equal(assets.filter(file => file.path.startsWith('project/assets/openings/') && file.path.endsWith('/manifest.json')).length, 1);
    assert.ok(assets.some(file => file.path.endsWith('.glb')), 'DIST携带实际环境GLB');
    const cache = await entryJson(archive, 'release-cache-manifest.json');
    for (const asset of assets) {
      const cached = cache.files.find(file => decodeURIComponent(file.path) === asset.path); assert.ok(cached, asset.path);
      assert.equal(cached.storage, 'asset'); assert.equal(cached.sha256, createHash('sha256').update(await asset.buffer()).digest('hex'));
    }
    assert.equal(await readFile(scenePath, 'utf8'), content, '原场景文件保持不变');
    assert.ok(!JSON.stringify(published).includes(encodeURIComponent(projectRoot)), 'DIST不保留本机路径');
    const viewerRoot = path.join(output, 'published-viewer'); await mkdir(viewerRoot, { recursive: true });
    for (const entry of archive.files) {
      const destination = path.resolve(viewerRoot, entry.path), relative = path.relative(viewerRoot, destination);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      if (entry.type === 'Directory') await mkdir(destination, { recursive: true });
      else { await mkdir(path.dirname(destination), { recursive: true }); await pipeline(entry.stream(), createWriteStream(destination)); }
    }
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, sourceScenes: source.sceneCount, distFiles: dist.fileCount,
      cachedAssets: assets.length, viewerRoot, checks: ['real-import', 'source-environment-and-package', 'dist-environment-and-package', 'cache-hashes', 'parameters-preserved', 'source-not-mutated'] }, null, 2));
    console.log(JSON.stringify({ passed: true, viewerRoot, cachedAssets: assets.length })); code = 0;
  } catch (error) { console.error(error); }
  finally {
    clearTimeout(deadline);
    if (path.dirname(root) !== path.resolve('node_modules') || !path.basename(root).startsWith('.prismatic-publish-')) throw new Error('临时目录范围无效');
    await rm(root, { recursive: true, force: true }); app.exit(code);
  }
}
app.whenReady().then(run).catch(error => { console.error(error); app.exit(1); });
