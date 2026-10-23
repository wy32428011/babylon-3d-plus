import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspaceDefault = path.resolve(import.meta.dirname, '../..');
function inside(root, file) { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
async function hashFile(file) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { path: file, byteLength: (await fs.stat(file)).size, sha256: hash.digest('hex') };
}
async function hashTree(root) {
  const files = [];
  async function walk(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name), stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('哈希守护范围存在链接：' + file);
      if (stat.isDirectory()) await walk(file); else if (stat.isFile()) files.push(file); else throw new Error('哈希守护范围包含非普通文件。');
    }
  }
  await walk(root); return Promise.all(files.sort().map(hashFile));
}
function archiveChild(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':')) throw new Error('SOURCE清单路径无效。');
  const target = path.resolve(root, ...relative.split('/'));
  if (!inside(root, target) || target === root) throw new Error('SOURCE清单路径越界。');
  return target;
}
async function verifyLightingAssets(scene, allowedRoot, modules) {
  const lighting = modules.getSceneLightingConfig(scene), snapshot = lighting.result;
  assert.equal(modules.getSceneLightingBakeError(scene), null, '场景必须具有当前有效GI，不能把过期资源当作SOURCE成功');
  assert.ok(snapshot?.surfaces.length && snapshot.assets.length, '必须使用真实已保存的Cycles结果');
  const checked = [];
  for (const asset of snapshot.assets) {
    const file = modules.decodeAssetUrl(asset.url);
    if (!inside(allowedRoot, file)) throw new Error('光照资产不在本轮真实项目内：' + asset.id);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('光照资产不是普通文件：' + asset.id);
    const actual = await hashFile(file);
    assert.equal(actual.byteLength, asset.byteLength, '光照文件字节数：' + asset.id);
    assert.equal(actual.sha256, asset.sha256, '光照文件摘要：' + asset.id);
    const bytes = await fs.readFile(file);
    if (asset.kind === 'geometry') modules.validateLightingGeometry(JSON.parse(bytes.toString('utf8')));
    else if (asset.kind === 'probes') modules.validateLightingProbes(JSON.parse(bytes.toString('utf8')));
    else modules.validateLightingPng(bytes, lighting.bake.atlasSize ** 2);
    checked.push({ id: asset.id, kind: asset.kind, ...actual });
  }
  return { signature: modules.getSceneLightingBakeSignature(scene), resultSignature: snapshot.signature,
    geometrySignature: snapshot.geometrySignature, surfaceCount: snapshot.surfaces.length, assetCount: snapshot.assets.length, assets: checked };
}

/** 使用真实成功工程执行正式SOURCE构建/安全提取/重定位；本函数不启动Editor、Viewer或烘焙。 */
export async function prepareLightingOptimizationSourceRoundTrip({ smokeReportPath, scenePath, outputRoot,
  workspace = workspaceDefault, compiledRoot = path.join(workspace, 'dist-electron'), sharedResourcesRoot, signal = new AbortController().signal,
  onProgress = () => {} }) {
  const inputReportPath = await fs.realpath(smokeReportPath), inputReportHash = await hashFile(inputReportPath);
  const smoke = JSON.parse(await fs.readFile(inputReportPath, 'utf8'));
  assert.equal(smoke.status, 'PASS', 'SOURCE只能基于最新实际成功的smoke工程');
  const sourceProjectRoot = await fs.realpath(smoke.projectRoot);
  const sourceScenePath = await fs.realpath(scenePath ?? smoke.scenePath ?? path.join(sourceProjectRoot, 'Scenes/hybrid.scene.json'));
  if (!inside(sourceProjectRoot, sourceScenePath)) throw new Error('输入场景不属于成功smoke工程。');
  const evidenceRoot = path.resolve(workspace, 'output/lighting-optimization');
  const runRoot = path.resolve(outputRoot ?? path.join(evidenceRoot, 'source-roundtrip-' + new Date().toISOString().replace(/[:.]/g, '-')));
  if (path.dirname(runRoot) !== evidenceRoot || !path.basename(runRoot).startsWith('source-roundtrip-')) throw new Error('输出必须为output/lighting-optimization/source-roundtrip-*全新直接子目录。');
  if (inside(sourceProjectRoot, runRoot) || inside(runRoot, sourceProjectRoot)) throw new Error('SOURCE证据目录与来源工程不能重叠。');
  const sourceHashesBefore = await hashTree(sourceProjectRoot);
  await fs.mkdir(evidenceRoot, { recursive: true }); await fs.mkdir(runRoot);
  const reportPath = path.join(runRoot, 'source-roundtrip-report.json');
  const extractedRoot = path.join(runRoot, 'extracted-project');
  const report = { version: 1, status: 'RUNNING', stage: 'source-package-extract-relocate', startedAt: new Date().toISOString(),
    smokeReportPath: inputReportPath, inputReportHash, sourceProjectRoot, sourceScenePath, sourceHashesBefore, projectRoot: extractedRoot,
    editorReopen: { status: 'NOT_RUN', reason: '本报告只证明SOURCE文件链，真实Editor重开由独立reopen smoke执行。' } };
  try {
    const load = relative => import(pathToFileURL(path.join(compiledRoot, relative)).href);
    const [sourceApi, transferApi, relocationApi, contract, config, assets, artifacts, images] = await Promise.all([
      load('ipc/digitalTwinSourcePackage.js'), load('ipc/dataPlatformTransfer.js'), load('ipc/dataPlatformSceneRelocation.js'),
      load('shared/sceneLightingBakeContract.js'), load('shared/sceneLightingConfig.js'), load('ipc/assetRegistry.js'),
      load('shared/sceneLightingBakeArtifacts.js'), load('ipc/dataPlatformImageSync.js'),
    ]);
    const modules = { ...contract, ...config, ...assets, ...artifacts };
    const sourceDocument = JSON.parse(await fs.readFile(sourceScenePath, 'utf8'));
    report.sourceLighting = await verifyLightingAssets(sourceDocument.scene, sourceProjectRoot, modules);
    const archive = await sourceApi.buildDigitalTwinSourcePackage({ projectRoot: sourceProjectRoot,
      sharedResourcesRoot: sharedResourcesRoot ? await fs.realpath(sharedResourcesRoot) : sourceProjectRoot,
      entrySceneFilePath: sourceScenePath, outputRoot: path.join(runRoot, 'archive'), signal,
      manifest: { projectId: 'lighting-optimization', projectName: sourceDocument.scene.name, editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
      isPlatformImageReference: images.isPlatformImageReference, findSyncedImageForReference: images.findSyncedImageForReference,
      onProgress });
    assert.deepEqual(archive.omittedResources, [], '真实SOURCE验收不能省略任何引用资产');
    assert.deepEqual(await hashTree(sourceProjectRoot), sourceHashesBefore, '正式SOURCE构建不能修改来源工程');
    const archiveHash = await hashFile(archive.filePath); assert.equal(archiveHash.sha256, archive.sha256); assert.equal(archiveHash.byteLength, archive.fileSize);
    await fs.mkdir(extractedRoot);
    await transferApi.extractZipSecurely(archive.filePath, extractedRoot, signal);
    assert.deepEqual(await hashFile(archive.filePath), archiveHash, '安全提取不能修改SOURCE归档');
    const manifestPath = path.join(extractedRoot, '.babylon-editor/digital-twin-source-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assert.deepEqual(manifest, JSON.parse(archive.manifestJson), '提取后的正式清单必须与构建结果一致');
    const sceneProofs = [];
    for (const entry of manifest.scenes) {
      signal.throwIfAborted();
      const file = archiveChild(extractedRoot, entry.path), portableHash = await hashFile(file);
      assert.equal(portableHash.sha256, entry.sha256, '归档场景SHA：' + entry.path); assert.equal(portableHash.byteLength, entry.size);
      const portableDocument = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(contract.getSceneLightingBakeError(portableDocument.scene), null, '便携场景不能产生过期GI');
      const relocated = relocationApi.relocateDataPlatformScene(portableDocument, extractedRoot);
      const lighting = await verifyLightingAssets(relocated.scene, extractedRoot, modules);
      if (entry.path === manifest.entryScenePath) {
        const original = report.sourceLighting.assets.map(({ id, kind, sha256, byteLength }) => ({ id, kind, sha256, byteLength }));
        assert.deepEqual(lighting.assets.map(({ id, kind, sha256, byteLength }) => ({ id, kind, sha256, byteLength })), original, 'SOURCE往返必须逐资产保留真实内容');
        assert.deepEqual(config.getSceneLightingConfig(relocated.scene).result.surfaces, config.getSceneLightingConfig(sourceDocument.scene).result.surfaces, 'SOURCE往返必须保留全部原始表面映射');
        assert.deepEqual(config.getSceneLightingConfig(relocated.scene).bake, config.getSceneLightingConfig(sourceDocument.scene).bake, '不能改变计算设备、覆盖区域或其它烘焙参数');
      }
      const content = JSON.stringify(relocated, null, 2) + '\n';
      await fs.writeFile(file, content);
      sceneProofs.push({ relativePath: entry.path, portableHash, relocatedHash: await hashFile(file), lighting });
    }
    const reopenedScenePath = archiveChild(extractedRoot, manifest.entryScenePath);
    const after = await hashTree(sourceProjectRoot); assert.deepEqual(after, sourceHashesBefore, '构建/提取/重定位后来源工程必须逐文件不变');
    assert.deepEqual(await hashFile(inputReportPath), inputReportHash, '输入smoke报告必须保持不变');
    Object.assign(report, { status: 'SOURCE_ROUND_TRIP_PASS', completedAt: new Date().toISOString(), scenePath: reopenedScenePath,
      sourceHashesAfter: after, sourceUnchanged: true, archive: { filePath: archive.filePath, fileSize: archive.fileSize, sha256: archive.sha256,
        entryScenePath: archive.entryScenePath, sceneCount: archive.sceneCount, resourceFileCount: archive.resourceFileCount, warnings: archive.warnings, omittedResources: archive.omittedResources },
      manifest, sceneProofs, extractedHashes: await hashTree(extractedRoot),
      reopenEnvironment: { LIGHTING_SMOKE_STAGE: 'reopen', LIGHTING_SMOKE_REOPEN_REPORT: reportPath, LIGHTING_SMOKE_REOPEN_SCENE: reopenedScenePath } });
  } catch (error) {
    Object.assign(report, { status: 'FAIL', completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    try { report.sourceHashesAfter = await hashTree(sourceProjectRoot); report.sourceUnchanged = JSON.stringify(report.sourceHashesAfter) === JSON.stringify(sourceHashesBefore); }
    catch (integrityError) { report.integrityError = integrityError.message; }
    throw Object.assign(error, { reportPath, report });
  } finally { await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' }); }
  return { reportPath, report };
}

function cliOptions(args) {
  const options = {}; let input;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (['--scene', '--output-root', '--compiled-root', '--shared-root'].includes(key)) {
      const value = args[++index]; if (!value) throw new Error('缺少参数：' + key);
      options[{ '--scene': 'scenePath', '--output-root': 'outputRoot', '--compiled-root': 'compiledRoot', '--shared-root': 'sharedResourcesRoot' }[key]] = value;
    } else if (key.startsWith('--') || input) throw new Error('未知或重复参数：' + key); else input = key;
  }
  if (!input) throw new Error('用法：electron tests/helpers/lightingOptimizationSourceRoundTrip.mjs <successful-electron-result.json> [--scene <scene>] [--output-root <new-root>]');
  return { ...options, smokeReportPath: input };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  let app, userData;
  try {
    const options = cliOptions(process.argv.slice(2));
    ({ app } = await import('electron'));
    if (!app) throw new Error('请通过Electron主进程运行此工具；它使用正式本地图片解析器，不注入模拟资产。');
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-source-roundtrip-user-'));
    app.setPath('userData', userData); await app.whenReady();
    const result = await prepareLightingOptimizationSourceRoundTrip({ ...options, onProgress: (detail, completed, total) => console.log('[source-roundtrip]', completed + '/' + total, detail) });
    console.log(JSON.stringify({ status: result.report.status, reportPath: result.reportPath, scenePath: result.report.scenePath, reopenEnvironment: result.report.reopenEnvironment, editorReopen: result.report.editorReopen }, null, 2));
  } catch (error) { console.error(JSON.stringify({ status: 'FAIL', error: error.message, reportPath: error.reportPath }, null, 2)); process.exitCode = 1; }
  finally {
    if (userData && path.dirname(userData) === path.resolve(os.tmpdir()) && path.basename(userData).startsWith('lighting-source-roundtrip-user-')) await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
    app?.exit(process.exitCode ?? 0);
  }
}
