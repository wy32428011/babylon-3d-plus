import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import electron from 'electron';

const require = createRequire(import.meta.url), { app } = electron;
const output = path.resolve('output/stacker-motion-arrows');
const inputPath = path.join(output, 'scene.scene.json');
const root = await mkdtemp(path.resolve('node_modules/.stacker-motion-arrow-packages-'));
app.setPath('userData', path.join(root, 'user-data')); app.getAppPath = () => process.cwd();
const abortController = new AbortController();
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    assert.equal(path.dirname(root), path.resolve('node_modules'));
    assert.ok(path.basename(root).startsWith('.stacker-motion-arrow-packages-'));
    await rm(root, { recursive: true, force: true });
  })();
}
const deadline = setTimeout(() => {
  console.error('堆垛机箭头 SOURCE/DIST 验证超时'); abortController.abort();
  void cleanup().catch(console.error).finally(() => app.exit(1));
}, 180000);
const snapshot = scene => Object.values(scene.entities).filter(entity => entity.components.telemetryBinding?.deviceType === 'stacker')
  .map(entity => ({ id: entity.id, transform: entity.components.transform, binding: entity.components.telemetryBinding }));

async function run() {
  let code = 1;
  try {
    for (const file of [inputPath, 'dist-electron/ipc/digitalTwinSourcePackage.js', 'dist-electron/ipc/digitalTwinDistPackage.js', 'dist-viewer-template/index.html']) {
      try { await access(file); } catch { throw new Error('缺少 ' + file + '；先完成编辑器 smoke 和统一构建。'); }
    }
    const original = await readFile(inputPath, 'utf8'), document = JSON.parse(original);
    assert.ok(snapshot(document.scene).every(value => value.binding.stackerMotionArrows.enabled));
    const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
    const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
    const { authorizeAssetFile } = await import('../../dist-electron/ipc/assetRegistry.js');
    const entry = path.join(root, 'entry.mjs');
    await writeFile(entry, "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';\nexport { createDefaultStackerMotionArrowsConfig } from '../../src/editor/model/stackerMotionArrows.ts';\n");
    const { build } = await import('vite');
    await build({ configFile: false, publicDir: false, logLevel: 'silent', build: { ssr: entry, outDir: path.join(root, 'modules'), rolldownOptions: { output: { entryFileNames: 'serializer.mjs' } } } });
    const { serializeScene, deserializeScene, createDefaultStackerMotionArrowsConfig } = await import(pathToFileURL(path.join(root, 'modules/serializer.mjs')).href);
    assert.equal(createDefaultStackerMotionArrowsConfig().enabled, false, '堆垛机旧场景不应自动新增箭头');
    const projectRoot = path.join(root, 'project'), modelRoot = path.join(projectRoot, 'Assets/Models/arrow-stacker');
    await mkdir(modelRoot, { recursive: true });
    const assetUrl = file => 'editor-asset://local/' + encodeURIComponent(file);
    for (const entity of Object.values(document.scene.entities)) {
      const asset = entity.components.modelAsset;
      if (!asset) continue;
      assert.equal(path.dirname(path.resolve(asset.sourcePath)), path.join(output, 'model'), '只复制本验收自产的模型');
      const modelPath = path.join(modelRoot, path.basename(asset.sourcePath));
      await copyFile(asset.sourcePath, modelPath); authorizeAssetFile(modelPath);
      asset.sourcePath = modelPath; asset.sourceUrl = assetUrl(modelPath);
      for (const script of asset.scriptAssets ?? []) {
        assert.equal(path.dirname(path.resolve(script.path)), path.join(output, 'model'));
        const target = path.join(modelRoot, path.basename(script.path)); await copyFile(script.path, target); authorizeAssetFile(target);
        script.path = target; script.sourceUrl = assetUrl(target);
      }
    }
    const variants = ['main', 'disabled', 'legacy', 'zero'].map(key => {
      const scene = structuredClone(document.scene); scene.name = '堆垛机箭头-' + key;
      for (const entity of Object.values(scene.entities)) {
        const binding = entity.components.telemetryBinding;
        if (binding?.deviceType !== 'stacker') continue;
        if (key === 'legacy') delete binding.stackerMotionArrows;
        if (key === 'disabled') binding.stackerMotionArrows.enabled = false;
        if (key === 'zero') Object.assign(binding.stackerMotionArrows, { speed: 0, opacity: 0, intensity: 0, breathingStrength: 0 });
      }
      const content = serializeScene(scene);
      return { key, scene, content, expected: snapshot(deserializeScene(content)) };
    });
    assert.ok(variants.find(item => item.key === 'legacy').expected.every(value => !value.binding.stackerMotionArrows?.enabled));
    const scenesRoot = path.join(projectRoot, 'Scenes'); await mkdir(scenesRoot, { recursive: true });
    for (const variant of variants) await writeFile(path.join(scenesRoot, variant.key + '.scene.json'), variant.content);
    const source = await buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath: path.join(scenesRoot, 'main.scene.json'),
      outputRoot: path.join(root, 'source'), signal: abortController.signal,
      manifest: { projectId: '123', projectName: '堆垛机运动箭头验收', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
      isPlatformImageReference: () => false, findSyncedImageForReference: async () => null, skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
    assert.equal(source.sceneCount, variants.length);
    const unzipper = require('unzipper'), sourceArchive = await unzipper.Open.file(source.filePath), viewers = {};
    const readEntry = async (archive, filename) => { const file = archive.files.find(item => item.path.replace(/\\/g, '/') === filename); assert.ok(file, filename); return (await file.buffer()).toString('utf8'); };
    for (const variant of variants) {
      const sourceContent = await readEntry(sourceArchive, 'Scenes/' + variant.key + '.scene.json');
      assert.deepEqual(snapshot(JSON.parse(sourceContent).scene), snapshot(variant.scene), variant.key + ' SOURCE 配置');
      assert.deepEqual(snapshot(deserializeScene(sourceContent)), variant.expected, variant.key + ' SOURCE 重开');
      const dist = await buildDigitalTwinDistPackage({ projectId: '123', publishName: variant.scene.name, sceneContent: variant.content,
        sourceResourceFiles: source.resourceFiles, outputRoot: path.join(root, 'dist-' + variant.key), signal: abortController.signal });
      const archive = await unzipper.Open.file(dist.filePath), distContent = await readEntry(archive, 'project/scene.json');
      assert.deepEqual(snapshot(JSON.parse(distContent).scene), snapshot(variant.scene), variant.key + ' DIST 配置');
      assert.deepEqual(snapshot(deserializeScene(distContent)), variant.expected, variant.key + ' DIST 重开');
      assert.ok(archive.files.some(file => file.path === 'index.html'));
      assert.ok(archive.files.some(file => /arrow-stacker\.glb$/.test(file.path)));
      assert.ok(archive.files.some(file => /arrow-stacker\.model\.(ts|js)$/.test(file.path)));
      if (variant.key === 'zero') continue;
      const viewerRoot = path.join(output, 'viewer-' + variant.key + '-' + Date.now());
      for (const file of archive.files) {
        const target = path.resolve(viewerRoot, file.path), relative = path.relative(viewerRoot, target);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '拒绝 ZIP 越界条目');
        if (file.type === 'Directory') await mkdir(target, { recursive: true });
        else { await mkdir(path.dirname(target), { recursive: true }); await pipeline(file.stream(), createWriteStream(target)); }
      }
      viewers[variant.key] = viewerRoot;
      assert.equal(await readFile(path.join(scenesRoot, variant.key + '.scene.json'), 'utf8'), variant.content);
    }
    assert.equal(await readFile(inputPath, 'utf8'), original);
    await writeFile(path.join(output, 'packages-result.json'), JSON.stringify({ ok: true, viewers, sourceScenes: variants.length, distScenes: variants.length,
      checks: ['four-channel-config', 'SOURCE-DIST-reopen', 'legacy-default-off', 'explicit-disabled', 'zero-values', 'model-and-motion-script', 'source-not-mutated'] }, null, 2));
    console.log('PASS: 堆垛机箭头 SOURCE/DIST 四场景配置/重开/旧场景关闭/显式关闭/零值/模型脚本'); code = 0;
  } catch (error) { console.error(error); }
  finally { clearTimeout(deadline); try { await cleanup(); } catch (error) { console.error(error); code = 1; } app.exit(code); }
}
app.whenReady().then(run).catch(error => { console.error(error); clearTimeout(deadline); void cleanup().catch(console.error).finally(() => app.exit(1)); });
