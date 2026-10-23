import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspaceDefault = path.resolve(import.meta.dirname, '../..');
const attributeFields = ['positions', 'normals', 'indices', 'uvs', 'uvs2', 'colors', 'tangents'];
const assetPrefix = 'editor-asset://local/';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizePath = value => path.resolve(value);

async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return { path: file, byteLength: (await fs.stat(file)).size, sha256: digest.digest('hex') };
}
async function directFile(root, name) {
  if (typeof name !== 'string' || !name || path.basename(name) !== name || name.includes('\\') || name.includes(':') || name.includes('\0')) throw new Error('捕获输入只允许任务目录的直接普通文件。');
  const file = path.join(root, name), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) throw new Error('捕获输入包含链接或非普通文件：' + name);
  return file;
}
async function loadSerializer(workspace) {
  const { build } = await import('vite');
  const base = path.join(workspace, 'node_modules');
  const temporary = await fs.mkdtemp(path.join(base, '.lighting-factory-replay-'));
  if (path.dirname(temporary) !== base || !path.basename(temporary).startsWith('.lighting-factory-replay-')) throw new Error('序列化辅助目录归属异常。');
  try {
    const entry = path.join(temporary, 'entry.mjs');
    await fs.writeFile(entry, [
      "export { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer.ts';",
      "export { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';",
    ].join('\n'));
    await build({ configFile: false, publicDir: false, logLevel: 'silent', build: { ssr: entry,
      outDir: path.join(temporary, 'ssr'), rolldownOptions: { output: { entryFileNames: 'serializer.mjs' } } } });
    return await import(pathToFileURL(path.join(temporary, 'ssr/serializer.mjs')).href);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

/** 只读捕获输入并核对正式签名；不调用引擎、不写证据工程、不重新读取 GPU。 */
export async function loadLightingFactoryBakeReplay({ taskDirectory, sourceScenePath, originalSourceScenePath, workspace = workspaceDefault,
  compiledRoot = path.join(workspace, 'dist-electron') }) {
  const capturedRoot = await fs.realpath(taskDirectory), source = await fs.realpath(sourceScenePath);
  const originalSource = originalSourceScenePath ? await fs.realpath(originalSourceScenePath) : source;
  const metadataFile = await directFile(capturedRoot, 'input.json');
  const metadataBytes = await fs.readFile(metadataFile), sourceBytes = await fs.readFile(source);
  const originalSourceBytes = originalSource === source ? sourceBytes : await fs.readFile(originalSource);
  const captured = JSON.parse(metadataBytes.toString('utf8'));
  if (captured.version !== 1 || !Array.isArray(captured.meshes) || !captured.meshes.length) throw new Error('捕获烘焙 metadata 版本或网格无效。');
  const [{ validateLightingBakeInput }, compiledContract, serializer] = await Promise.all([
    import(pathToFileURL(path.join(compiledRoot, 'ipc/lightingBakeValidation.js')).href),
    import(pathToFileURL(path.join(compiledRoot, 'shared/sceneLightingBakeContract.js')).href),
    loadSerializer(workspace),
  ]);
  const inputFiles = new Set([metadataFile, source, originalSource]), textureFiles = new Set(), geometry = [], meshMetadata = [];
  const accessFiles = new Set();
  async function textureFromCapture(texture) {
    if (!texture || typeof texture !== 'object' || typeof texture.file !== 'string') throw new Error('捕获材质缺少任务内纹理文件。');
    const file = await directFile(capturedRoot, texture.file); inputFiles.add(file); textureFiles.add(file); accessFiles.add(normalizePath(file));
    const next = { ...texture, url: assetPrefix + encodeURIComponent(file) }; delete next.file; return next;
  }
  for (const mesh of captured.meshes) {
    const binary = mesh.geometryBinary;
    if (!binary || binary.version !== 1 || !binary.attributes || !Number.isSafeInteger(binary.byteLength)) throw new Error('捕获几何必须具有版本化 geometryBinary 元数据。');
    const file = await directFile(capturedRoot, binary.file), bytes = await fs.readFile(file); inputFiles.add(file);
    if (bytes.length !== binary.byteLength) throw new Error('捕获几何字节数不符：' + binary.file);
    const item = structuredClone(mesh); delete item.geometryBinary;
    for (const field of attributeFields) if (Object.hasOwn(item, field)) throw new Error('捕获metadata混入数字数组，拒绝用替代输入覆盖二进制附件。');
    if (item.material?.textures) for (const [channel, texture] of Object.entries(item.material.textures)) item.material.textures[channel] = await textureFromCapture(texture);
    geometry.push({ key: item.key, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), attributes: structuredClone(binary.attributes) });
    meshMetadata.push(item);
  }
  const environment = structuredClone(captured.environment);
  if (environment.textureFile !== undefined) {
    const file = await directFile(capturedRoot, environment.textureFile); inputFiles.add(file); textureFiles.add(file); accessFiles.add(normalizePath(file));
    environment.textureUrl = assetPrefix + encodeURIComponent(file); delete environment.textureFile;
  } else if (environment.textureUrl) throw new Error('捕获环境仍含外部纹理URL，不能证明捕获文件等价。');
  const transport = { version: 2, input: { ...captured, meshes: meshMetadata, environment }, geometry };
  const input = validateLightingBakeInput(transport);
  // 解码与校验只使用正式实现，保留所有数值、稳定key、worldMatrix、UV/颜色/切线。
  assert.deepEqual(input.settings, captured.settings, '正式校验不能改变已捕获的计算参数。');
  assert.deepEqual(input.meshes.map(mesh => ({ key: mesh.key, entityId: mesh.entityId, nodeKey: mesh.nodeKey, worldMatrix: mesh.worldMatrix })),
    captured.meshes.map(mesh => ({ key: mesh.key, entityId: mesh.entityId, nodeKey: mesh.nodeKey, worldMatrix: mesh.worldMatrix })), '网格身份和世界矩阵必须保持原值。');
  const scene = serializer.deserializeScene(sourceBytes.toString('utf8'));
  const proposedScene = structuredClone(scene);
  proposedScene.sceneSettings.lighting.bake = structuredClone(captured.settings);
  const originalScene = serializer.deserializeScene(originalSourceBytes.toString('utf8'));
  const originalProposedScene = structuredClone(originalScene);
  originalProposedScene.sceneSettings.lighting.bake = structuredClone(captured.settings);
  const originalSceneSignature = serializer.getSceneLightingBakeSignature(originalProposedScene);
  const originalCompiledSignature = compiledContract.getSceneLightingBakeSignature(originalProposedScene);
  const sourceSignature = serializer.getSceneLightingBakeSignature(scene);
  const sceneSignature = serializer.getSceneLightingBakeSignature(proposedScene);
  const compiledSignature = compiledContract.getSceneLightingBakeSignature(proposedScene);
  const inputHashesBefore = await Promise.all([...inputFiles].sort().map(hashFile));
  const report = { version: 1, status: [sceneSignature, compiledSignature, originalSceneSignature, originalCompiledSignature].every(signature => signature === input.signature) ? 'CHECKED' : 'BLOCKED',
    capturedTaskDirectory: capturedRoot, sourceScenePath: source, sourceSceneSha256Before: sha256(sourceBytes),
    originalSourceScenePath: originalSource, originalSourceSceneSha256Before: sha256(originalSourceBytes), originalSceneSignature, originalCompiledSignature,
    sourceSignature, inputSignature: input.signature, sceneSignature, compiledSignature, geometrySignature: input.geometrySignature,
    expectedStaticMeshCount: input.meshes.length, expectedReceiverCount: input.meshes.filter(mesh => mesh.receiver !== false).length,
    expectedTriangleCount: input.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0), sceneEntityCount: scene.entityIds.length,
    capturedSettings: structuredClone(input.settings), capturedTextureCount: textureFiles.size, inputHashesBefore,
    compiledModuleHashes: await Promise.all(['ipc/lightingBakeValidation.js', 'ipc/lightingBakeService.js', 'shared/sceneLightingBakeContract.js', 'shared/sceneLightingBakeBinary.js', 'lighting-bake/cycles_bake.py'].map(file => hashFile(path.join(compiledRoot, file)))) };
  if (report.status === 'BLOCKED') { const error = new Error('捕获输入与正式反序列化场景签名不等，禁止启动引擎或重签旧结果。'); error.report = report; throw error; }
  return { input, geometry, proposedScene, serializer, report, accessFiles, inputFiles: [...inputFiles], compiledRoot };
}

async function inspectUnchanged(loaded) {
  const inputHashesAfter = await Promise.all(loaded.inputFiles.sort().map(hashFile));
  assert.deepEqual(inputHashesAfter, loaded.report.inputHashesBefore, '原始捕获输入或来源场景已变化。');
  return { inputHashesAfter, sourceSceneSha256After: (await hashFile(loaded.report.sourceScenePath)).sha256,
    originalSourceSceneSha256After: (await hashFile(loaded.report.originalSourceScenePath)).sha256 };
}
async function hashOutputFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('新证据工程出现链接，拒绝生成完整性结论。');
      if (entry.isDirectory()) await walk(file); else if (entry.isFile() && entry.name !== 'replay-report.json') files.push(file);
    }
  }
  await walk(root); return Promise.all(files.sort().map(hashFile));
}

/** 从已捕获完整几何启动正式后台服务；新结果只写新工程，不改变旧输入及原项目。 */
export async function runLightingFactoryBakeReplay(options) {
  const loaded = await loadLightingFactoryBakeReplay(options);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evidenceRoot = path.resolve(options.workspace ?? workspaceDefault, 'output/lighting-optimization');
  const projectRoot = path.resolve(options.projectRoot ?? path.join(evidenceRoot, 'factory-replay-' + stamp));
  if (path.dirname(projectRoot) !== evidenceRoot || !path.basename(projectRoot).startsWith('factory-replay-')) throw new Error('新工程必须是 output/lighting-optimization 下的 factory-replay-* 直接子目录。');
  // 必须是全新目录，避免把正式资产写进已有工程或覆盖其它验收结果。
  await fs.mkdir(path.dirname(projectRoot), { recursive: true });
  await fs.mkdir(projectRoot, { recursive: false });
  const reportPath = path.join(projectRoot, 'replay-report.json');
  const report = { ...loaded.report, status: 'RUNNING', startedAt: new Date().toISOString(), projectRoot, progress: [] };
  try {
    const service = await import(pathToFileURL(path.join(loaded.compiledRoot, 'ipc/lightingBakeService.js')).href);
    const historyApi = await import(pathToFileURL(path.join(loaded.compiledRoot, 'ipc/lightingBakeTaskHistory.js')).href);
    const previousEnginePath = process.env.BABYLON_BLENDER_PATH;
    let engine;
    try { if (options.enginePath) process.env.BABYLON_BLENDER_PATH = path.resolve(options.enginePath);
      engine = await service.findLightingBakeEngine(options.userDataDirectory ?? path.join(options.workspace ?? workspaceDefault, 'output/lighting-optimization/engine-config'));
    } finally { if (previousEnginePath === undefined) delete process.env.BABYLON_BLENDER_PATH; else process.env.BABYLON_BLENDER_PATH = previousEnginePath; }
    if (!engine.available || !engine.path) throw new Error(engine.message ?? '没有可用的正式烘焙引擎。');
    const jobId = 'factory_replay_' + randomUUID();
    const input = { ...loaded.input, jobId };
    report.jobId = jobId; report.engine = engine;
    const decodeAssetUrl = url => { if (typeof url !== 'string' || !url.startsWith(assetPrefix)) throw new Error('重放仅允许授权本地资产URL。'); return decodeURIComponent(url.slice(assetPrefix.length)); };
    const snapshot = await service.runLightingBakeJob({ input, binaryGeometry: loaded.geometry, projectRoot,
      enginePath: engine.path, engineVersion: engine.version, signal: options.signal ?? new AbortController().signal,
      isProjectCurrent: () => true, decodeAssetUrl, encodeAssetUrl: file => assetPrefix + encodeURIComponent(file),
      isAuthorizedAssetFile: file => loaded.accessFiles.has(normalizePath(file)),
      authorizeAssetFile: file => { const relative = path.relative(projectRoot, file); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('新资产越过证据工程。'); loaded.accessFiles.add(normalizePath(file)); },
      onProgress: event => { report.progress.push({ ...event, at: new Date().toISOString() }); options.onProgress?.(event); },
    });
    assert.equal(snapshot.signature, loaded.input.signature, '正式结果签名必须等于捕获输入，禁止洗签。');
    assert.equal(snapshot.geometrySignature, loaded.input.geometrySignature, '正式结果几何签名必须保持原捕获值。');
    Object.assign(report, await inspectUnchanged(loaded));
    const bakedScene = { ...loaded.proposedScene, sceneSettings: { ...loaded.proposedScene.sceneSettings,
      lighting: { ...loaded.proposedScene.sceneSettings.lighting, result: snapshot } } };
    assert.deepEqual(bakedScene.entities, loaded.proposedScene.entities, '不能删除静态源或替换业务模型。');
    const content = loaded.serializer.serializeScene(bakedScene);
    assert.equal(loaded.serializer.getSceneLightingBakeSignature(loaded.serializer.deserializeScene(content)), loaded.input.signature, '保存往返必须保持原输入签名。');
    const scenesRoot = path.join(projectRoot, 'Scenes'); await fs.mkdir(scenesRoot);
    const bakedScenePath = path.join(scenesRoot, 'factory-baked.scene.json'); await fs.writeFile(bakedScenePath, content, { flag: 'wx' });
    Object.assign(report, { status: 'PASS', completedAt: new Date().toISOString(), bakedScenePath, snapshot,
      taskHistory: await historyApi.getLightingBakeTaskHistory(projectRoot), outputHashes: await hashOutputFiles(projectRoot),
      ...await inspectUnchanged(loaded) });
  } catch (error) {
    Object.assign(report, { status: 'FAIL', completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    try { Object.assign(report, await inspectUnchanged(loaded)); } catch (integrityError) { report.integrityError = integrityError.message; }
    try { const api = await import(pathToFileURL(path.join(loaded.compiledRoot, 'ipc/lightingBakeTaskHistory.js')).href); report.taskHistory = await api.getLightingBakeTaskHistory(projectRoot); } catch (historyError) { report.historyError = historyError.message; }
    throw Object.assign(error, { report, reportPath });
  } finally { await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' }); }
  return { report, reportPath };
}

function cliOptions(argv) {
  const positions = [], options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--check-only') options.checkOnly = true;
    else if (['--project-root', '--compiled-root', '--engine', '--user-data', '--original-source-scene'].includes(argument)) {
      const value = argv[++index]; if (!value) throw new Error('缺少参数：' + argument);
      options[{ '--project-root': 'projectRoot', '--compiled-root': 'compiledRoot', '--engine': 'enginePath', '--user-data': 'userDataDirectory', '--original-source-scene': 'originalSourceScenePath' }[argument]] = value;
    } else if (argument.startsWith('--')) throw new Error('未知参数：' + argument); else positions.push(argument);
  }
  if (positions.length !== 2) throw new Error('用法：node tests/helpers/lightingFactoryBakeReplay.mjs <task-dir> <source-scene> [--check-only] [--original-source-scene <original-scene>] [--engine <blender>] [--project-root <new-root>]');
  return { ...options, taskDirectory: positions[0], sourceScenePath: positions[1] };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    const options = cliOptions(process.argv.slice(2));
    if (options.checkOnly) {
      const loaded = await loadLightingFactoryBakeReplay(options), integrity = await inspectUnchanged(loaded);
      const { inputHashesBefore, compiledModuleHashes, ...summary } = loaded.report;
      console.log(JSON.stringify({ ...summary, ...integrity, inputHashesAfter: undefined, inputHashCount: inputHashesBefore.length, compiledModuleHashes }, null, 2));
    } else {
      const result = await runLightingFactoryBakeReplay({ ...options, onProgress: event => console.log('[factory-replay]', event.phase, Math.round(event.progress * 100) + '%', event.message) });
      console.log(JSON.stringify({ status: result.report.status, reportPath: result.reportPath, bakedScenePath: result.report.bakedScenePath,
        meshCount: result.report.expectedStaticMeshCount, triangleCount: result.report.expectedTriangleCount,
        sourceBefore: result.report.sourceSceneSha256Before, sourceAfter: result.report.sourceSceneSha256After,
        originalSourceBefore: result.report.originalSourceSceneSha256Before, originalSourceAfter: result.report.originalSourceSceneSha256After }, null, 2));
    }
  } catch (error) {
    const report = error.report ? { ...error.report, inputHashesBefore: undefined, inputHashesAfter: undefined, progress: undefined } : undefined;
    console.error(JSON.stringify({ status: 'FAIL', error: error.message, reportPath: error.reportPath, report }, null, 2)); process.exitCode = 1;
  }
}
