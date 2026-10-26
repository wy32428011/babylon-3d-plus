import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { encodeModelGlb } from '../../scripts/lib/phase2AssetSemantics.mjs';

function model(triangles = 20_001) {
  const positions = Buffer.from(new Float32Array([-10, -10, -10, 10, -10, 10, 10, 10, -10]).buffer);
  const indices = new Uint16Array(triangles * 3);
  for (let index = 0; index < indices.length; index++) indices[index] = index % 3;
  const binary = Buffer.concat([positions, Buffer.from(indices.buffer)]);
  return encodeModelGlb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ name: '高密度源网格', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-10, -10, -10], max: [10, 10, 10] },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: indices.byteLength }],
    buffers: [{ byteLength: binary.length }] }, binary);
}

if (process.argv.includes('--density-child')) {
  const index = process.argv.indexOf('--density-child'), [bundleRoot, fixtureRoot, workspace, mode] = process.argv.slice(index + 1);
  const { app } = await import('electron');
  await fs.mkdir(path.join(fixtureRoot, 'userdata'), { recursive: true });
  app.setPath('userData', path.join(fixtureRoot, 'userdata'));
  app.getAppPath = () => workspace;
  app.whenReady().then(async () => {
    const store = await import(pathToFileURL(path.join(bundleRoot, 'store.mjs')).href);
    const root = path.join(fixtureRoot, 'project'), packageRoot = path.join(root, 'Assets', 'Models', 'original');
    const file = path.join(packageRoot, 'main.glb');
    store.setCurrentProjectRoot(root);
    if (mode === 'reopen') {
      const listed = await store.listProjectAssets(), asset = listed.assets.find(asset => asset.path === file);
      assert.equal(asset.sourceModelDensity.unitScaleToMeters, 0.01); assert.equal(asset.sourceModelDensity.findings.length, 1);
      console.log(JSON.stringify({ status: 'PASS', checks: ['new-process-index-reopen'] }));
      app.exit(0); return;
    }
    await fs.mkdir(packageRoot, { recursive: true }); await fs.writeFile(file, model());
    const asset = { id: file, name: 'main.glb', path: file, sourceUrl: 'editor-asset://local/' + encodeURIComponent(file),
      kind: 'model', libraryKind: 'model', packagePath: packageRoot, lengthUnit: 'meter', unitScaleToMeters: 1 };
    await store.writeProjectAssetIndex(root, { version: 2, assets: [asset] });
    const before = await fs.readFile(store.getProjectAssetIndexPath(root));
    const meter = (await store.listProjectAssets()).assets.find(item => item.path === file);
    assert.equal(meter.sourceModelDensity.findings.length, 0);
    assert.deepEqual(await fs.readFile(store.getProjectAssetIndexPath(root)), before, '只读列表不得重写旧索引');
    await store.writeProjectAssetIndex(root, { version: 2, assets: [{ ...asset, lengthUnit: 'centimeter', unitScaleToMeters: 0.01 }] });
    const centimeters = (await store.listProjectAssets()).assets.find(item => item.path === file);
    assert.equal(centimeters.sourceModelDensity.findings.length, 1);
    assert.equal(centimeters.sourceModelDensity.unitScaleToMeters, 0.01);
    const source = path.join(fixtureRoot, 'source-environment.glb'); await fs.writeFile(source, model());
    const imported = await store.importEnvironmentModelFileIntoProject(source);
    assert.equal(imported.importedAsset.unitScaleToMeters, 0.01);
    assert.equal(imported.importedAsset.sourceModelDensity.unitScaleToMeters, 0.01);
    assert.equal(imported.importedAsset.sourceModelDensity.findings.length, 1, '本地环境的厘米覆盖必须重算，不能沿用扫描器米制结果');
    await fs.writeFile(path.join(fixtureRoot, 'density.json'), JSON.stringify(centimeters.sourceModelDensity));
    console.log(JSON.stringify({ status: 'PASS', checks: ['old-index-readonly-diagnosis', 'unit-change-invalidates-cache', 'environment-centimeter-import'] }));
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  test('实际资源索引重开/环境导入与ResourceCard只在真实finding时显示源高模提示', async t => {
    const workspace = process.cwd(), modulesRoot = await fs.mkdtemp(path.resolve('node_modules/.phase2-density-test-'));
    const fixtureRoot = await fs.mkdtemp(path.join(tmpdir(), 'phase2-density-integration-'));
    t.after(async () => {
      assert.equal(path.dirname(modulesRoot), path.resolve('node_modules')); assert.ok(path.basename(modulesRoot).startsWith('.phase2-density-test-'));
      assert.equal(path.dirname(fixtureRoot), path.resolve(tmpdir())); assert.ok(path.basename(fixtureRoot).startsWith('phase2-density-integration-'));
      await fs.rm(modulesRoot, { recursive: true, force: true }); await fs.rm(fixtureRoot, { recursive: true, force: true });
    });
    const { build } = await import('vite');
    await build({ configFile: false, root: workspace, publicDir: false, logLevel: 'error',
      build: { ssr: true, outDir: modulesRoot, rollupOptions: { input: {
        store: 'electron/ipc/projectAssetStore.ts', card: 'src/editor/ui/ResourceCard.tsx', assetRegistry: 'electron/ipc/assetRegistry.ts',
      }, output: { entryFileNames: chunk => chunk.name === 'assetRegistry' ? 'assetRegistry.js' : '[name].mjs' } } } });
    const electron = createRequire(import.meta.url)('electron'), logs = [];
    for (const mode of ['initial', 'reopen']) await new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron, [path.resolve('tests/runtime/phase2ModelDensity.integration.mjs'), '--density-child', modulesRoot, fixtureRoot, workspace, mode],
        { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; const append = chunk => { output += String(chunk); };
      child.stdout.on('data', append); child.stderr.on('data', append); child.once('error', reject);
      child.once('close', code => { logs.push({ mode, code, output }); code === 0 ? resolve() : reject(new Error(output)); });
    });
    const { createElement } = await import('react'), { renderToStaticMarkup } = await import('react-dom/server');
    const { ResourceCard } = await import(pathToFileURL(path.join(modulesRoot, 'card.mjs')).href);
    const density = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'density.json'), 'utf8'));
    const asset = { id: 'source', name: 'source.glb', path: 'source.glb', sourceUrl: 'editor-asset://local/source.glb', kind: 'model', sourceModelDensity: density };
    const item = { id: 'source', name: '诊断模型', icon: 'cube', asset }, library = { key: 'model', label: '模型库', items: [item] };
    const render = () => renderToStaticMarkup(createElement(ResourceCard, { item, library, title: '源资产' }));
    const high = render(); assert.match(high, /源模型高密度/); assert.match(high, /小尺寸高面数/); assert.match(high, /源 GLB JSON/);
    asset.sourceModelDensity = { ...density, findings: [], findingCount: 0 };
    assert.doesNotMatch(render(), /源模型高密度/);
    asset.sourceModelDensity = { ...density, status: 'unavailable', triangles: null, findings: [], findingCount: 0, unknownReasons: ['未计算：源几何尺寸未知。'] };
    const unknown = render(); assert.doesNotMatch(unknown, /源模型高密度/); assert.match(unknown, /面数未知/); assert.match(unknown, /未计算/);
    const output = path.resolve('output/phase2-completion-20261025'); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'model-density-integration.json'), JSON.stringify({ status: 'PASS', logs, checks: ['ResourceCard-positive', 'ResourceCard-no-false-warning', 'unknown-is-not-zero'] }, null, 2));
    const fixtureOutput = path.join(output, 'model-density-ui-fixtures');
    for (const [name, triangles] of [['high', 20_001], ['normal', 1]]) {
      const directory = path.join(fixtureOutput, name); await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'main.glb'), model(triangles));
      await fs.writeFile(path.join(directory, 'meta.json'), JSON.stringify({ lengthUnit: 'centimeter', name: name === 'high' ? '高密度源模型提示验收' : '普通源模型对照' }));
    }
  });
}
