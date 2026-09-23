import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import electron from 'electron';

const require = createRequire(import.meta.url);
const { app } = electron;
const output = path.resolve('output/conveyor-surface-arrows');
const inputPath = path.join(output, 'scene.scene.json');
const root = await mkdtemp(path.resolve('node_modules/.conveyor-surface-arrow-packages-'));
app.setPath('userData', path.join(root, 'user-data'));
app.getAppPath = () => process.cwd();
const abortController = new AbortController();
let cleanupPromise;
function cleanup() {
  cleanupPromise ??= (async () => {
    assert.equal(path.dirname(root), path.resolve('node_modules'), '清理范围必须位于 node_modules');
    assert.ok(path.basename(root).startsWith('.conveyor-surface-arrow-packages-'));
    await rm(root, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
const deadline = setTimeout(() => {
  console.error('输送线表面箭头 SOURCE/DIST 验证超时');
  abortController.abort();
  void cleanup().catch(console.error).finally(() => app.exit(1));
}, 180_000);

function snapshot(scene) {
  return Object.values(scene.entities)
    .filter(entity => entity.components.telemetryBinding?.deviceType === 'conveyor')
    .map(entity => ({ id: entity.id, transform: entity.components.transform, binding: entity.components.telemetryBinding }));
}

async function loadSceneSerializer() {
  // 构建到测试私有目录，不改写共享 Viewer 或 Electron 构建产物。
  const entry = path.join(root, 'entry.mjs');
  await writeFile(entry, [
    "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
    "export { createDefaultConveyorSurfaceArrowsConfig } from '../../src/editor/model/conveyorSurfaceArrows.ts';",
  ].join('\n'));
  const { build } = await import('vite');
  await build({
    configFile: false, publicDir: false, logLevel: 'silent',
    build: { ssr: entry, outDir: path.join(root, 'modules'), rolldownOptions: { output: { entryFileNames: 'serializer.mjs' } } },
  });
  return import(pathToFileURL(path.join(root, 'modules/serializer.mjs')).href);
}

async function localizeModelResources(document, projectRoot, authorizeAssetFile) {
  const modelRoot = path.join(projectRoot, 'Assets', 'Models', 'virtual-conveyor');
  await mkdir(modelRoot, { recursive: true });
  for (const name of ['virtual-conveyor.glb', 'virtual-conveyor.model.ts', 'meta.json']) {
    const file = path.join(modelRoot, name);
    await copyFile(path.resolve('public/builtin-model-packages/virtual-conveyor', name), file);
    authorizeAssetFile(file);
  }
  const assetUrl = file => 'editor-asset://local/' + encodeURIComponent(file);
  for (const entity of Object.values(document.scene.entities)) {
    const model = entity.components.modelAsset;
    if (!model) continue;
    assert.ok(/virtual-conveyor\.glb(?:$|[?#])/i.test(model.sourcePath ?? model.sourceUrl), '发布夹具只接受内置虚拟输送线模型');
    model.sourcePath = path.join(modelRoot, 'virtual-conveyor.glb');
    model.sourceUrl = assetUrl(model.sourcePath);
    const scriptPath = path.join(modelRoot, 'virtual-conveyor.model.ts');
    model.scriptAssets = [{ path: scriptPath, sourceUrl: assetUrl(scriptPath), name: path.basename(scriptPath) }];
    if (model.packagePath) model.packagePath = modelRoot;
    if (model.metadataPath) model.metadataPath = path.join(modelRoot, 'meta.json');
  }
}

async function run() {
  let code = 1;
  try {
    for (const file of [inputPath, 'dist-electron/ipc/digitalTwinSourcePackage.js', 'dist-electron/ipc/digitalTwinDistPackage.js', 'dist-viewer-template/index.html']) {
      try { await access(file); }
      catch { throw new Error('缺少 ' + file + '；先完成编辑器 smoke 和统一构建，再运行发布验证。'); }
    }
    const originalContent = await readFile(inputPath, 'utf8');
    const document = JSON.parse(originalContent);
    assert.ok(snapshot(document.scene).some(value => value.binding.surfaceArrows?.enabled), '编辑器场景必须启用表面箭头');
    assert.equal(document.scene.mqttConfig?.enabled, true, 'Viewer 夹具必须启用 MQTT');
    const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
    const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
    const { authorizeAssetFile } = await import('../../dist-electron/ipc/assetRegistry.js');
    const { serializeScene, deserializeScene, createDefaultConveyorSurfaceArrowsConfig } = await loadSceneSerializer();
    const defaults = createDefaultConveyorSurfaceArrowsConfig();
    assert.equal(defaults.enabled, true, '输送线箭头缺省开启');
    assert.equal(defaults.style, 'moving-double-arrow');
    assert.equal(defaults.breathingEnabled, false);
    assert.deepEqual(defaults.directionBinding, { mode: 'model', field: 'movement_x', forwardValue: '1', reverseValue: '2', stopValue: '0' });
    const projectRoot = path.join(root, 'project');
    await localizeModelResources(document, projectRoot, authorizeAssetFile);
    const zero = structuredClone(document.scene);
    zero.name = '零速度零透明度箭头';
    for (const entity of Object.values(zero.entities)) {
      const arrows = entity.components.telemetryBinding?.surfaceArrows;
      if (arrows) Object.assign(arrows, { speed: 0, opacity: 0, style: 'moving-double-arrow', breathingEnabled: false, breathingStrength: 0 });
    }
    const legacy = structuredClone(document.scene);
    legacy.name = '旧场景缺省箭头';
    for (const entity of Object.values(legacy.entities)) {
      if (entity.components.telemetryBinding) delete entity.components.telemetryBinding.surfaceArrows;
    }
    const variantScene = (name, values) => {
      const scene = structuredClone(document.scene);
      scene.name = name;
      for (const entity of Object.values(scene.entities)) {
        const binding = entity.components.telemetryBinding;
        if (binding?.deviceType === 'conveyor') binding.surfaceArrows = { ...defaults, ...binding.surfaceArrows, ...values };
      }
      return scene;
    };
    const disabled = variantScene('显式关闭箭头', { enabled: false, style: 'pipeline-flow-arrows', breathingEnabled: false });
    const model = variantScene('默认模型方向映射', { enabled: true, style: 'conveyor-direction', speed: 0.7, opacity: 0.9,
      directionBinding: defaults.directionBinding, breathingEnabled: true, breathingPeriod: 1.8, breathingStrength: 0.7 });
    const point = variantScene('点位映射与零速呼吸', { enabled: true, style: 'flow-arrows', speed: 0, opacity: 0.9, color: '#39d8ff',
      directionBinding: { mode: 'point', field: 'line.dir', forwardValue: '1', reverseValue: 'R', stopValue: 'S' },
      breathingEnabled: true, breathingPeriod: 1.8, breathingStrength: 0.7 });
    const fixtures = [
      { name: 'main.scene.json', scene: document.scene },
      { name: 'zero.scene.json', scene: zero },
      { name: 'legacy.scene.json', scene: legacy },
      { name: 'disabled.scene.json', scene: disabled },
      { name: 'model.scene.json', scene: model },
      { name: 'point.scene.json', scene: point },
    ].map(fixture => {
      const content = serializeScene(fixture.scene);
      return { ...fixture, content, expected: snapshot(deserializeScene(content)) };
    });
    const legacyExpected = fixtures.find(fixture => fixture.name === 'legacy.scene.json').expected;
    assert.ok(legacyExpected.every(value => value.binding.surfaceArrows?.enabled === true), '旧场景缺字段重开必须默认开启');
    assert.ok(fixtures.find(fixture => fixture.name === 'disabled.scene.json').expected.every(value => value.binding.surfaceArrows.enabled === false), '显式 false 必须保留');
    const scenesRoot = path.join(projectRoot, 'Scenes');
    await mkdir(scenesRoot, { recursive: true });
    for (const fixture of fixtures) await writeFile(path.join(scenesRoot, fixture.name), fixture.content);
    const source = await buildDigitalTwinSourcePackage({
      projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath: path.join(scenesRoot, 'main.scene.json'),
      outputRoot: path.join(root, 'source'), signal: abortController.signal,
      manifest: { projectId: '123', projectName: '输送线表面箭头验收', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
      isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
      skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null },
    });
    assert.equal(source.sceneCount, fixtures.length);
    const dist = await buildDigitalTwinDistPackage({
      projectId: '123', publishName: '输送线表面箭头验收', sceneContent: source.entrySceneContent,
      sourceResourceFiles: source.resourceFiles, outputRoot: path.join(root, 'dist'), signal: abortController.signal,
    });
    const unzipper = require('unzipper');
    const sourceArchive = await unzipper.Open.file(source.filePath);
    const distArchive = await unzipper.Open.file(dist.filePath);
    const viewers = {};
    const extractViewer = async (archive, key) => {
      const viewerRoot = path.join(output, 'viewer-' + key + '-' + Date.now());
      for (const entry of archive.files) {
        const target = path.resolve(viewerRoot, entry.path);
        const relative = path.relative(viewerRoot, target);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '拒绝 ZIP 越界条目');
        if (entry.type === 'Directory') await mkdir(target, { recursive: true });
        else { await mkdir(path.dirname(target), { recursive: true }); await pipeline(entry.stream(), createWriteStream(target)); }
      }
      viewers[key] = viewerRoot;
    };
    const readEntry = async (archive, name) => {
      const entry = archive.files.find(file => file.path.replace(/\\/g, '/') === name);
      assert.ok(entry, 'ZIP 应包含 ' + name);
      return (await entry.buffer()).toString('utf8');
    };
    for (const fixture of fixtures) {
      const content = await readEntry(sourceArchive, 'Scenes/' + fixture.name);
      assert.deepEqual(snapshot(JSON.parse(content).scene), snapshot(fixture.scene), fixture.name + ' SOURCE 配置');
      assert.deepEqual(snapshot(deserializeScene(content)), fixture.expected, fixture.name + ' SOURCE 重开');
      assert.equal(await readFile(path.join(scenesRoot, fixture.name), 'utf8'), fixture.content, '打包不能修改源文件');
      // 零值和旧场景也必须经过实际 DIST 导出，不能仅用 SOURCE 结果推断兼容性。
      if (fixture.name !== 'main.scene.json') {
        const variant = await buildDigitalTwinDistPackage({
          // SOURCE ZIP 内的便携路径需先由工程重开恢复；此处使用同一已授权本地快照，避免把相对包路径当成本机路径。
          projectId: '123', publishName: fixture.scene.name, sceneContent: fixture.content,
          sourceResourceFiles: source.resourceFiles, outputRoot: path.join(root, 'dist-' + fixture.name), signal: abortController.signal,
        });
        const archive = await unzipper.Open.file(variant.filePath);
        const variantContent = await readEntry(archive, 'project/scene.json');
        assert.deepEqual(snapshot(JSON.parse(variantContent).scene), snapshot(fixture.scene), fixture.name + ' DIST 配置');
        assert.deepEqual(snapshot(deserializeScene(variantContent)), fixture.expected, fixture.name + ' DIST 重开');
        if (fixture.name !== 'zero.scene.json') await extractViewer(archive, fixture.name.replace('.scene.json', ''));
      }
    }
    const distContent = await readEntry(distArchive, 'project/scene.json');
    assert.deepEqual(snapshot(JSON.parse(distContent).scene), snapshot(document.scene), 'DIST 箭头和绑定配置');
    assert.deepEqual(snapshot(deserializeScene(distContent)), fixtures[0].expected, 'DIST 重开');
    assert.ok(distArchive.files.some(file => file.path === 'index.html'), 'DIST 包含真实 Viewer 入口');
    assert.ok(distArchive.files.some(file => /\.glb$/i.test(file.path)), 'DIST 包含输送线模型');
    assert.ok(distArchive.files.some(file => /virtual-conveyor\.model\.(ts|js)$/i.test(file.path)), 'DIST 包含参数脚本');
    assert.equal(await readFile(inputPath, 'utf8'), originalContent, '原始编辑器验收场景不能被修改');
    await extractViewer(distArchive, 'main');
    await writeFile(path.join(output, 'packages-result.json'), JSON.stringify({
      ok: true, viewerRoot: viewers.main, viewers, sourceScenes: fixtures.length, distScenes: fixtures.length, conveyors: snapshot(document.scene).length,
      sourceBytes: source.fileSize, distBytes: dist.fileSize, distFiles: dist.fileCount,
      checks: ['source-main-new-fields', 'source-four-styles', 'source-zero-speed-opacity-breathing', 'source-legacy-default-enabled',
        'source-explicit-disabled', 'source-custom-point-mapping', 'source-reopen', 'dist-six-scenes-and-reopen', 'dist-model-script', 'source-not-mutated'],
    }, null, 2));
    console.log('PASS: 表面箭头 SOURCE/DIST 六场景，四种样式、呼吸、点位映射、旧场景默认开启、显式关闭和零值保留。');
    code = 0;
  } catch (error) { console.error(error); }
  finally {
    clearTimeout(deadline);
    try { await cleanup(); } catch (error) { console.error(error); code = 1; }
    app.exit(code);
  }
}
app.whenReady().then(run).catch(error => {
  console.error(error); clearTimeout(deadline);
  void cleanup().catch(console.error).finally(() => app.exit(1));
});
