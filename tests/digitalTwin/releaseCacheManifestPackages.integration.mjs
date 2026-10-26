import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import unzipper from 'unzipper';
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { deploymentGlbFixture } from '../helpers/deploymentGlbFixture.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'zending-release-cache-package-'));
await mkdir(path.join(root, 'user-data'));
app.setPath('userData', path.join(root, 'user-data'));
const originalGetAppPath = app.getAppPath;
app.getAppPath = () => root;

async function readArchive(filePath) {
  const archive = await unzipper.Open.file(filePath);
  const files=new Map(await Promise.all(archive.files.filter((entry) => entry.type === 'File')
    .map(async (entry) => [entry.path.replaceAll('\\', '/'), await entry.buffer()])));
  files.archiveEntryCount=archive.files.length;
  return files;
}

async function run() {
  const templateRoot = path.join(root, 'dist-viewer-template');
  const templateFiles = {
    'index.html': '<!doctype html><script type="module" src="./assets/main.js"></script>',
    'assets/main.js': 'console.log("fixture viewer");\n'.repeat(2048),
    'assets/main.js.gz': gzipSync('console.log("fixture viewer");\n'.repeat(2048)),
    'assets/main.css': 'body{margin:0}\n'.repeat(2048),
    'fixtures/GI几何.json': JSON.stringify({ positions: Array(4096).fill(0.125) }),
    'fixtures/环境模型 #1.glb': deploymentGlbFixture('ZIP-GLB'),
    'decoders/draco.wasm': Buffer.concat([Buffer.from([0, 97, 115, 109]), Buffer.alloc(65536, 1)]),
    'icons/工厂 #1.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'published-cache-worker.js': 'self.addEventListener("fetch",()=>{});',
    'release-cache-manifest.json': 'must be replaced',
    'runtime-config.json': 'must be replaced',
    'README.md': 'must be replaced',
  };
  for (const [relativePath, content] of Object.entries(templateFiles)) {
    await mkdir(path.dirname(path.join(templateRoot, relativePath)), { recursive: true });
    await writeFile(path.join(templateRoot, relativePath), content);
  }
  const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
  const sceneContent = JSON.stringify({ version: 3, scene: {
    id: 'release-cache-scene', name: '缓存打包验证', entityIds: [], entities: {}, selectedEntityId: null,
    sceneSettings: { camera: { savedPose: null, viewDistance: 5000 }, environment: null },
  } });
  const options = { projectId: '123', publishName: '缓存打包验证', sceneContent, signal: new AbortController().signal };
  const first = await buildDigitalTwinDistPackage({ ...options, outputRoot: path.join(root, 'first') });
  const entries = await readArchive(first.filePath);
  const runtime = JSON.parse(entries.get('runtime-config.json').toString());
  const manifest = JSON.parse(entries.get('release-cache-manifest.json').toString());
  assert.equal(runtime.cacheManifest, 'release-cache-manifest.json');
  assert.equal(manifest.cacheRevision, runtime.cacheRevision);
  assert.equal(manifest.version, 1);
  assert.equal(first.fileCount, entries.size);
  assert.equal(first.precompression.budget.finalEntries,entries.archiveEntryCount);
  assert.equal(first.precompression.budget.originalEntries,first.precompression.budget.originalFiles+first.precompression.budget.originalDirectories);
  const excluded = new Set(['README.md', 'runtime-config.json', 'release-cache-manifest.json', 'published-cache-worker.js']);
  assert.deepEqual(manifest.files.map((entry) => decodeURIComponent(entry.path)).sort(),
    [...entries.keys()].filter((entry) => !excluded.has(entry) && (!/\.(?:br|gz)$/.test(entry) || Object.hasOwn(templateFiles, entry))).sort());
  const sidecars = [...entries.keys()].filter(entry => /\.(?:br|gz)$/.test(entry) && !Object.hasOwn(templateFiles, entry));
  assert.ok(sidecars.length >= 10, 'JS/CSS/JSON/WASM/GLB均提供有效传输侧车');
  const glbPath = 'fixtures/环境模型 #1.glb';
  assert.deepEqual(entries.get(glbPath), templateFiles[glbPath]);
  const glbEntry = manifest.files.find(entry => decodeURIComponent(entry.path) === glbPath);
  assert.equal(glbEntry.contentType, 'model/gltf-binary');
  for (const extension of ['br', 'gz']) assert.ok(entries.has(glbPath + '.' + extension));
  // 用真实 Babylon glTF loader 核对几何，避免仅有 glTF magic 的运输伪夹具掩盖格式错误。
  const { NullEngine, Scene, ImportMeshAsync, VertexBuffer } = await import('@babylonjs/core');
  await import('@babylonjs/loaders/glTF/index.js');
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const loaded = await ImportMeshAsync(new Uint8Array(entries.get(glbPath)), scene, { pluginExtension: '.glb' });
    const mesh = loaded.meshes.find(mesh => mesh.name === 'ZIP-GLB');
    assert.ok(mesh); assert.equal(mesh.getTotalVertices(), 3); assert.equal(mesh.getTotalIndices(), 6144);
    assert.deepEqual(Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  } finally { scene.dispose(); engine.dispose(); }
  for (const sidecar of sidecars) { const bytes = entries.get(sidecar), original = entries.get(sidecar.replace(/\.(?:br|gz)$/, '')); assert.ok(original, sidecar); assert.ok(bytes.length < original.length); assert.deepEqual(sidecar.endsWith('.br') ? brotliDecompressSync(bytes) : gunzipSync(bytes), original); }
  for (const control of ['runtime-config.json', 'release-cache-manifest.json', 'published-cache-worker.js']) assert.ok(!sidecars.some(file => file === control + '.br' || file === control + '.gz'));
  let totalBytes = 0;
  for (const entry of manifest.files) {
    const bytes = entries.get(decodeURIComponent(entry.path));
    assert.equal(entry.size, bytes.length);
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
    totalBytes += bytes.length;
  }
  assert.equal(manifest.totalBytes, totalBytes);
  assert.ok(entries.has('published-cache-worker.js'), 'worker 保留在 ZIP 中但不纳入清单');
  const assetManifest = JSON.parse(entries.get('project/asset-manifest.json').toString());
  assert.equal(assetManifest.version, 1, '原资产清单版本保持兼容');
  assert.ok(Array.isArray(assetManifest.assets), '原资产清单 assets 保持兼容');
  const second = await buildDigitalTwinDistPackage({ ...options, precompress: false, outputRoot: path.join(root, 'second') });
  const secondEntries = await readArchive(second.filePath);
  const secondManifest = JSON.parse(secondEntries.get('release-cache-manifest.json').toString());
  assert.ok(![...secondEntries.keys()].some(file => /\.(?:br|gz)$/.test(file) && !Object.hasOwn(templateFiles, file)), '内部回退路径保留原包');
  assert.notEqual(secondManifest.cacheRevision, manifest.cacheRevision, '每次发布产生独立缓存版本');
  assert.deepEqual(secondManifest.files, manifest.files, '相同静态内容保持相同字节描述');
  assert.ok(first.fileSize > second.fileSize, 'ZIP包含传输侧车的真实额外开销');
  const packageBudget = Math.floor((first.fileSize + second.fileSize) / 2);
  const budgeted = await buildDigitalTwinDistPackage({ ...options, maxPackageBytes: packageBudget, outputRoot: path.join(root, 'budgeted') });
  const budgetedEntries = await readArchive(budgeted.filePath);
  assert.ok(budgeted.fileSize <= packageBudget); assert.ok(![...budgetedEntries.keys()].some(file => /\.(?:br|gz)$/.test(file) && !Object.hasOwn(templateFiles, file)));
  assert.ok(budgeted.warnings.some(value => /ZIP.*回退/.test(value)));
  assert.equal(budgeted.fileCount, budgetedEntries.size);
  assert.deepEqual(budgetedEntries.get('assets/main.js.gz'),templateFiles['assets/main.js.gz'],'ZIP回退只删除本次侧车，保留原同名文件');
  assert.equal(budgeted.precompression.zipBudgetFallback,true); assert.equal(budgeted.precompression.generatedFiles,0);
  assert.equal(budgeted.precompression.budget.finalFiles,budgetedEntries.size);
  assert.equal(budgeted.precompression.budget.finalEntries,budgetedEntries.archiveEntryCount);
  const controller = new AbortController();
  const cancelledRoot = path.join(root, 'cancelled');
  await assert.rejects(buildDigitalTwinDistPackage({ ...options, outputRoot: cancelledRoot, signal: controller.signal,
    onProgress: (_detail, percent) => { if (percent === 83) controller.abort(); },
  }), { name: 'AbortError' });
  assert.deepEqual(await readdir(cancelledRoot), [], '取消后 ZIP 和 staging 全部回收');
  for (const [phase,predicate] of [['compressing',percent=>percent>84&&percent<=85],['zip-fallback',percent=>percent===90]]) {
    const aborted=new AbortController(),target=path.join(root,'cancelled-'+phase);
    await assert.rejects(buildDigitalTwinDistPackage({...options,outputRoot:target,signal:aborted.signal,
      ...(phase==='zip-fallback'?{maxPackageBytes:packageBudget}:{}),
      onProgress:(_detail,percent)=>{if(predicate(percent))aborted.abort();}}));
    assert.equal(aborted.signal.aborted,true,phase+'实际到达取消入口');
    assert.deepEqual(await readdir(target),[],phase+'取消后全部本任务产物回收');
  }
  console.log(JSON.stringify({ status: 'PASS', files: first.fileCount, archiveEntries:entries.archiveEntryCount, cachedFiles: manifest.files.length, sidecars:sidecars.length, zip:{withSidecars:first.fileSize,original:second.fileSize,tightenedBudget:packageBudget,fallback:budgeted.fileSize}, precompression:first.precompression,
    checks: ['zip-complete-file-hashes', 'runtime-revision-consistent', 'control-files-excluded',
      'legacy-asset-manifest', 'new-publication-revision', 'precompression-byte-roundtrip', 'glb-mime-and-babylon-geometry', 'zip-budget-original-fallback', 'existing-sidecar-preserved', 'cancel-cleanup', 'mid-compression-cancel-cleanup', 'zip-fallback-cancel-cleanup'] }));
}

async function finish(code) {
  app.getAppPath = originalGetAppPath;
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('zending-release-cache-package-')) {
    throw new Error('拒绝清理测试临时目录之外的路径。');
  }
  await rm(resolved, { recursive: true, force: true });
  app.exit(code);
}

app.whenReady().then(run).then(() => finish(0), async (error) => { console.error(error); await finish(1); });
