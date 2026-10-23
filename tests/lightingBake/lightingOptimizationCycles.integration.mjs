import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLightingBakeEngine, inspectLightingBakeRequest, runLightingBakeJob } from '../../dist-electron/ipc/lightingBakeService.js';
import { validateLightingBakeInput } from '../../dist-electron/ipc/lightingBakeValidation.js';
import { getLightingBakeTaskHistory, readLightingBakeTaskLog } from '../../dist-electron/ipc/lightingBakeTaskHistory.js';
import { encodeLightingBakeTransport, decodeLightingBakeTransport } from '../../dist-electron/shared/sceneLightingBakeBinary.js';
import { planLightingProbeVolumes } from '../../dist-electron/shared/sceneLightingProbeVolumes.js';
import { validateLightingGeometry, validateLightingProbes, validateLightingPng } from '../../dist-electron/shared/sceneLightingBakeArtifacts.js';

// 本脚本只在显式运行时启动真实 Blender；由根任务统一调度，避免与性能采样并发。
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputBase = path.join(repository, 'output', 'lighting-optimization');
await fs.mkdir(outputBase, { recursive: true });
const evidenceDirectory = await fs.mkdtemp(path.join(outputBase, 'cycles-' + Date.now() + '-'));
const projectRoot = path.join(evidenceDirectory, 'project');
await fs.mkdir(projectRoot);
const reportFile = path.join(evidenceDirectory, 'report.json');
const report = { success: false, startedAt: new Date().toISOString(), evidenceDirectory, projectRoot,
  checks: [], cases: [], engine: null, limits: ['真实小场景验收不代表完整工厂 GI、FPS 或 GPU 加速收益。'] };
const geometryFields = ['positions', 'normals', 'indices', 'uvs', 'uvs2', 'colors', 'tangents'];
const fieldWidths = { positions: 3, normals: 3, uvs: 2, uvs2: 2, colors: 4, tangents: 4 };
const material = { baseColor: [0.8, 0.8, 0.8], alpha: 1, alphaMode: 'opaque', metallic: 0,
  roughness: 0.8, emissive: [0, 0, 0], doubleSided: true };
const uv = [0, 0, 1, 0, 1, 1, 0, 1];
const uv2 = [0.1, 0.2, 0.8, 0.2, 0.8, 0.9, 0.1, 0.9];
const colors = [1, 1, 1, 1, 0.3, 0.8, 1, 1, 0.5, 0.6, 0.9, 1, 0.2, 0.7, 0.6, 1];
const tangents = [1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1];
function makeInput(name, device, volumes) {
  return { version: 1, jobId: 'optimization-' + name, signature: 'optimization-' + name + '-v1', sceneName: '增强验收 · ' + name,
    settings: { enabled: true, quality: 'preview', atlasSize: 256, texelsPerMeter: 8, probeSpacing: volumes ? 1 : 2,
      maxTextureMiB: 16, cacheStaticShadows: true, dynamicShadows: true, device,
      ...(volumes ? { probeVolumes: volumes } : {}) },
    meshes: [
      { key: 'floor', entityId: 'floor', nodeKey: 'floor', name: '接收地面', receiver: true,
        positions: [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
        indices: [0, 2, 1, 0, 3, 2], uvs: [...uv], uvs2: [...uv2], colors: [...colors], tangents: [...tangents],
        worldMatrix: [4,0,0,0, 0,1,0,0, 0,0,4,0, 0,0,0,1], material: { ...material } },
      { key: 'wall', entityId: 'wall', nodeKey: 'wall', name: '保留遮挡与反弹墙', receiver: false,
        positions: [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, -0.5, -0.5, 1, -0.5], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2, 0, 2, 3], uvs: [...uv], uvs2: [...uv2], colors: [...colors], tangents: [...tangents],
        worldMatrix: [4,0,0,0, 0,2,0,0, 0,0,4,0, 0,0,0,1], material: { ...material, baseColor: [0.9, 0.15, 0.1] } },
    ],
    lights: [{ kind: 'directional', position: [0, 4, 0], direction: [-0.4, -1, -0.2], color: [1, 1, 1], intensity: 1 }],
    environment: { color: [0.3, 0.4, 0.5], intensity: 1 },
  };
}
const volumes = [
  { id: 'occupied', name: '设备活动区', enabled: true, min: [-1, 0.25, -1], max: [1, 1.75, 1] },
  { id: 'duplicate', name: '重叠区域去重', enabled: true, min: [-1, 0.25, -1], max: [1, 1.75, 1] },
  { id: 'disabled', name: '禁用区域不生成探针', enabled: false, min: [-100, -100, -100], max: [100, 100, 100] },
];
const authorized = new Set();
const access = { isAuthorizedAssetFile: file => authorized.has(file),
  encodeAssetUrl: file => 'editor-asset://local/' + encodeURIComponent(file),
  decodeAssetUrl: url => decodeURIComponent(new URL(url).pathname.slice(1)),
  authorizeAssetFile: file => authorized.add(file) };
function exactArrayBuffer(bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function writeJson(file, value) { await fs.writeFile(file, JSON.stringify(value, null, 2)); }
async function hashFormalAssets() {
  const root = path.join(projectRoot, 'Assets', 'LightingBakes'), files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), '测试工程不应产生符号链接');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push({ file: path.relative(root, file).replaceAll('\\', '/'), sha256: hash(await fs.readFile(file)) });
    }
  }
  await visit(root); return files.sort((a, b) => a.file.localeCompare(b.file));
}
async function verifyDiskInput(staging, input) {
  const text = await fs.readFile(path.join(staging, 'input.json'), 'utf8'), prepared = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) < 64 * 1024, '小场景 input.json 应只包含小型元数据');
  assert.equal(prepared.meshes.length, 2); assert.equal(prepared.meshes[0].receiver, true); assert.equal(prepared.meshes[1].receiver, false);
  const geometry = [], metadata = [];
  for (const mesh of prepared.meshes) {
    for (const field of geometryFields) assert.equal(Object.hasOwn(mesh, field), false, 'input.json 不应内嵌 ' + field);
    const { geometryBinary, ...remaining } = mesh;
    assert.equal(geometryBinary.version, 1); assert.match(geometryBinary.file, /^geometry-input-\d+\.bin$/);
    const bytes = await fs.readFile(path.join(staging, geometryBinary.file));
    assert.equal(bytes.toString('ascii', 0, 8), 'BLGEO001'); assert.equal(bytes.length, geometryBinary.byteLength);
    for (const field of geometryFields) assert.ok(geometryBinary.attributes[field], '二进制附件应包含 ' + field);
    geometry.push({ key: mesh.key, bytes: exactArrayBuffer(bytes), attributes: geometryBinary.attributes }); metadata.push(remaining);
  }
  const recovered = decodeLightingBakeTransport({ version: 2, input: { ...prepared, meshes: metadata }, geometry });
  assert.deepEqual(recovered.meshes, input.meshes, '接收面和仅遮挡面全部输入属性必须精确保留');
  return { inputJsonBytes: Buffer.byteLength(text), geometryBinaryBytes: geometry.reduce((sum, item) => sum + item.bytes.byteLength, 0) };
}
async function runCase(name, input, engine) {
  const directory = path.join(evidenceDirectory, name); await fs.mkdir(directory);
  const original = structuredClone(input), transport = encodeLightingBakeTransport(input), validated = validateLightingBakeInput(transport);
  const preflight = await inspectLightingBakeRequest(validated, access);
  assert.equal(preflight.issues.some(issue => issue.severity === 'error'), false, JSON.stringify(preflight.issues));
  const expectedProbes = planLightingProbeVolumes(validated.settings.probeVolumes, validated.settings.probeSpacing, preflight.bounds);
  assert.equal(expectedProbes.countExact, true); assert.ok(expectedProbes.count > 0 && expectedProbes.count <= 4096);
  const progress = [], devices = [], enginePids = [];
  const snapshot = await runLightingBakeJob({ input: validated, binaryGeometry: transport.geometry, projectRoot,
    enginePath: engine.path, engineVersion: engine.version, signal: new AbortController().signal,
    isProjectCurrent: () => true, ...access, timeoutMs: 300000,
    onEngineSpawn: pid => enginePids.push(pid), onDevice: selection => devices.push(selection),
    onProgress: event => { progress.push(event); process.stdout.write(JSON.stringify({ case: name, ...event }) + '\n'); } });
  assert.deepEqual(input, original, '实际执行不能修改调用方输入');
  assert.equal(snapshot.signature, input.signature); assert.equal(snapshot.statistics.meshCount, 2);
  assert.equal(snapshot.statistics.triangleCount, 4, '区域设置不能裁掉墙面的遮挡与反弹三角面');
  assert.deepEqual(snapshot.surfaces.map(surface => surface.key), ['floor'], '仅遮挡墙面保留贡献但不生成接收贴图');
  const assetFiles = new Map();
  for (const asset of snapshot.assets) {
    const file = access.decodeAssetUrl(asset.url), bytes = await fs.readFile(file);
    assert.ok(authorized.has(file)); assert.equal(bytes.byteLength, asset.byteLength); assert.equal(hash(bytes), asset.sha256);
    if (asset.kind === 'lightmap') validateLightingPng(bytes, input.settings.atlasSize ** 2, { width: input.settings.atlasSize, height: input.settings.atlasSize });
    assetFiles.set(asset.id, { asset, file, bytes });
  }
  const receiver = input.meshes[0], geometry = validateLightingGeometry(JSON.parse(assetFiles.get(snapshot.surfaces[0].geometryAssetId).bytes.toString('utf8')));
  assert.deepEqual(geometry.indices, receiver.indices.map((_, index) => index));
  for (const [field, width] of Object.entries(fieldWidths)) {
    const expected = receiver.indices.flatMap(index => receiver[field].slice(index * width, index * width + width));
    assert.deepEqual(geometry[field], expected, '接收面展开后仍须保留 ' + field + ' 的数值和角点次序');
  }
  const probeData = validateLightingProbes(JSON.parse(assetFiles.get(snapshot.probeAssetId).bytes.toString('utf8')));
  assert.equal(probeData.probes.length, expectedProbes.count); assert.equal(snapshot.statistics.probeCount, expectedProbes.count);
  probeData.probes.forEach((probe, index) => probe.position.forEach((value, axis) => {
    assert.ok(Math.abs(value - expectedProbes.positions[index][axis]) <= 1e-6, '实际探针位置应与共享区域/全场 planner 一致');
  }));
  assert.ok(probeData.probes.some(probe => probe.irradiance.some(value => value > 0.01)), '真实环境照明应产生非零探针');
  const history = await getLightingBakeTaskHistory(projectRoot), task = history.tasks.find(task => task.jobId === input.jobId);
  assert.ok(task); assert.equal(task.status, 'completed'); assert.equal(task.progress, 1); assert.equal(task.device.requested, input.settings.device);
  assert.ok(['CPU', 'GPU'].includes(task.device.actual));
  if (input.settings.device === 'cpu') assert.equal(task.device.actual, 'CPU');
  if (input.settings.device === 'gpu' && !engine.devices?.some(device => device.type === 'GPU')) {
    assert.equal(task.device.actual, 'CPU'); assert.ok(task.device.fallbackReason, '没有兼容 GPU 时必须明确记录 CPU 回退原因');
  }
  if (input.settings.device === 'gpu' && task.device.actual === 'CPU') assert.ok(task.device.fallbackReason);
  for (const phase of ['preparing', 'baking', 'applying']) assert.ok(task.phaseMetrics.some(metric => metric.phase === phase), '任务应记录阶段 ' + phase);
  assert.ok(task.phaseMetrics.every(metric => metric.durationMs >= 0 && (metric.mainRssBytes === null || metric.mainRssBytes > 0) && (metric.mainHeapUsedBytes === null || metric.mainHeapUsedBytes > 0)
    && (metric.cyclesPeakRssBytes === null || metric.cyclesPeakRssBytes > 0)));
  assert.ok(task.inputBytes > 0); assert.ok(task.expandedGeometryBytes > 0); assert.ok(task.logAvailable); assert.ok(task.engineVersion);
  assert.equal(task.outputBytes, snapshot.assets.reduce((sum, asset) => sum + asset.byteLength, 0));
  const staging = path.join(projectRoot, '.babylon-editor', 'lighting-bake-jobs', task.taskId), disk = await verifyDiskInput(staging, input);
  assert.ok(task.inputBytes >= disk.inputJsonBytes + disk.geometryBinaryBytes);
  const exact = JSON.parse(await fs.readFile(path.join(staging, 'preflight.json'), 'utf8'));
  assert.deepEqual(exact.sourceBounds, { min: [-2,0,-2], max: [2,2,2] }, "提前规划应以真实物理输入范围为准，不能重复应用 UV 临时尺度");
  assert.equal(exact.probeCount, expectedProbes.count); assert.equal(exact.atlasCount, snapshot.statistics.atlasCount);
  const log = await readLightingBakeTaskLog(projectRoot, task.taskId); assert.match(log, /LIGHTING_BAKE_DEVICE/);
  await Promise.all([writeJson(path.join(directory, 'snapshot.json'), snapshot), writeJson(path.join(directory, 'preflight.json'), preflight),
    writeJson(path.join(directory, 'task.json'), task), writeJson(path.join(directory, 'events.json'), { progress, devices, enginePids }),
    writeJson(path.join(directory, 'probes.json'), probeData), fs.writeFile(path.join(directory, 'cycles.log'), log)]);
  report.checks.push(name + ': binary input, full caster/receiver geometry, probes, hashes, device and task cost records');
  report.cases.push({ name, directory, staging, statistics: snapshot.statistics, device: task.device, disk, phaseMetrics: task.phaseMetrics,
    cyclesMemoryMeasured: task.phaseMetrics.some(metric => metric.cyclesPeakRssBytes !== null), enginePids });
  await writeJson(reportFile, report); return snapshot;
}
try {
  await writeJson(reportFile, report);
  const engine = await findLightingBakeEngine(evidenceDirectory); report.engine = engine;
  assert.equal(engine.available, true, engine.message); assert.ok(engine.path);
  await runCase('cpu', makeInput('cpu', 'cpu'), engine);
  await runCase('gpu-region', makeInput('gpu-region', 'gpu', volumes), engine);
  const uvDirectory = path.join(evidenceDirectory, 'uv-robustness'); await fs.mkdir(uvDirectory);
  let uvOutput;
  try {
    uvOutput = await promisify(execFile)(engine.path, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
      '--python', path.join(repository, 'tests', 'lightingBake', 'cycles_degenerate_uv_checks.py'), '--', '--output', uvDirectory],
    { windowsHide: true, timeout: 180000, maxBuffer: 4 * 1048576, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
  } catch (error) {
    await fs.writeFile(path.join(uvDirectory, 'blender.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
    throw error;
  }
  await fs.writeFile(path.join(uvDirectory, 'blender.log'), uvOutput.stdout + uvOutput.stderr);
  assert.match(uvOutput.stdout, /CYCLES_DEGENERATE_UV_CHECKS_PASS/);
  report.uvRobustness = JSON.parse(await fs.readFile(path.join(uvDirectory, 'report.json'), 'utf8'));
  assert.equal(report.uvRobustness.success, true);
  assert.equal(report.uvRobustness.originalTriangleCount, report.uvRobustness.exportedTriangleCount);
  assert.equal(report.uvRobustness.positiveSliver.sourceTriangles, report.uvRobustness.positiveSliver.outputTriangles);
  report.checks.push('real SmartProject collinear/sliver regressions preserve all faces, source attributes and minimum density');
  const before = await hashFormalAssets(), jobsDirectory = path.join(projectRoot, '.babylon-editor', 'lighting-bake-jobs');
  const jobsBefore = (await fs.readdir(jobsDirectory)).sort(), excessive = makeInput('probe-rejected', 'cpu');
  excessive.settings.probeSpacing = 0.1;
  const transport = encodeLightingBakeTransport(excessive), input = validateLightingBakeInput(transport); let spawned = 0;
  await assert.rejects(runLightingBakeJob({ input, binaryGeometry: transport.geometry, projectRoot, enginePath: engine.path,
    engineVersion: engine.version, signal: new AbortController().signal, isProjectCurrent: () => true, ...access,
    onEngineSpawn: () => { spawned++; }, onProgress: () => {} }), /探针/);
  assert.equal(spawned, 0, '探针超限应在首个实际引擎进程和第一次 bake 之前拒绝');
  assert.deepEqual((await fs.readdir(jobsDirectory)).sort(), jobsBefore, '硬预算失败不应创建任务暂存目录');
  assert.deepEqual(await hashFormalAssets(), before, '失败不能改变已有正式结果或任何旧资产内容');
  report.checks.push('probe limit rejected before spawn; both completed snapshots and formal asset hashes unchanged');
  await writeJson(path.join(evidenceDirectory, 'final-history.json'), await getLightingBakeTaskHistory(projectRoot));
  report.success = true;
} catch (error) {
  report.error = { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
  throw error;
} finally {
  report.completedAt = new Date().toISOString(); await writeJson(reportFile, report);
  process.stdout.write(JSON.stringify({ success: report.success, evidenceDirectory, reportFile, checks: report.checks }) + '\n');
}
