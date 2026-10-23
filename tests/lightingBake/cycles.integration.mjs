import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { findLightingBakeEngine, runLightingBakeJob, runLightingBakeProcess } from '../../dist-electron/ipc/lightingBakeService.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'babylon-cycles-integration-'));
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const material = { baseColor: [0.8, 0.8, 0.8], alpha: 1, metallic: 0, roughness: 0.8, emissive: [0, 0, 0], doubleSided: true };
const input = { version: 1, jobId: 'real-cycles', signature: 'integration-v1', sceneName: '真实 Cycles 集成场景',
  settings: { enabled: true, quality: 'preview', atlasSize: 256, texelsPerMeter: 8, probeSpacing: 4, maxTextureMiB: 16, cacheStaticShadows: true, dynamicShadows: true },
  meshes: [
    { key: 'floor', entityId: 'floor', nodeKey: 'floor', name: '地面', positions: [-2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
      indices: [0, 2, 1, 0, 3, 2], uvs: [0, 0, 1, 0, 1, 1, 0, 1], colors: [1, 1, 1, 1, 0.3, 0.8, 1, 1, 1, 1, 1, 1, 0.3, 0.8, 1, 1], worldMatrix: identity, material },
    { key: 'wall', entityId: 'wall', nodeKey: 'wall', name: '红色墙面', positions: [-2, 0, -2, 2, 0, -2, 2, 2, -2, -2, 2, -2], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2, 0, 2, 3], uvs: [0, 0, 1, 0, 1, 1, 0, 1], worldMatrix: identity, material: { ...material, baseColor: [0.9, 0.1, 0.1] } },
  ],
  lights: [{ kind: 'directional', position: [0, 4, 0], direction: [-0.4, -1, -0.2], color: [1, 1, 1], intensity: 1 }],
  environment: { color: [0.3, 0.4, 0.5], intensity: 1 },
};
const engine = await findLightingBakeEngine(root);
assert.equal(engine.available, true, engine.message);
// 先检查实际交付的 Python，复现发布链路的共线面/细面失败后才运行耗时烘焙。
const uvDirectory = path.join(root, 'publish-uv');
const uvArguments = ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
  '--python', path.resolve('tests/lightingBake/cycles_degenerate_uv_checks.py'), '--', '--output', uvDirectory,
  '--bake-script', path.resolve('dist-electron/lighting-bake/cycles_bake.py')];
let uvOutput;
try {
  uvOutput = await promisify(execFile)(engine.path, uvArguments, { windowsHide: true, timeout: 180000,
    maxBuffer: 4 * 1048576, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
} catch (error) {
  await fs.writeFile(path.join(root, 'publish-uv.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
  throw error;
}
await fs.writeFile(path.join(root, 'publish-uv.log'), uvOutput.stdout + uvOutput.stderr);
assert.match(uvOutput.stdout, /CYCLES_DEGENERATE_UV_CHECKS_PASS/);
const uvReport = JSON.parse(await fs.readFile(path.join(uvDirectory, 'report.json'), 'utf8'));
assert.equal(uvReport.success, true);
assert.equal(uvReport.originalTriangleCount, uvReport.exportedTriangleCount);
assert.equal(uvReport.positiveSliver.sourceTriangles, uvReport.positiveSliver.outputTriangles);
const authorized = new Set();
const options = { input, projectRoot: root, enginePath: engine.path, signal: new AbortController().signal,
  isProjectCurrent: () => true, isAuthorizedAssetFile: file => authorized.has(file),
  encodeAssetUrl: file => `editor-asset://local/${encodeURIComponent(file)}`,
  decodeAssetUrl: url => decodeURIComponent(new URL(url).pathname.slice(1)),
  authorizeAssetFile: file => authorized.add(file),
  onProgress: event => console.log(JSON.stringify(event)), timeoutMs: 180000 };
const result = await runLightingBakeJob(options);
assert.equal(result.signature, input.signature);
assert.equal(result.surfaces.length, 2);
assert.equal(result.statistics.triangleCount, 4);
assert.ok(result.statistics.probeCount > 0);
for (const asset of result.assets) {
  const file = options.decodeAssetUrl(asset.url);
  assert.ok(authorized.has(file));
  assert.equal((await fs.stat(file)).size, asset.byteLength);
  assert.match(asset.sha256, /^[0-9a-f]{64}$/);
}
const geometryAsset = result.assets.find(asset => asset.id === result.surfaces[0].geometryAssetId);
const geometry = JSON.parse(await fs.readFile(options.decodeAssetUrl(geometryAsset.url), 'utf8'));
assert.equal(geometry.bakeUvs.length, geometry.positions.length / 3 * 2);
assert.equal(geometry.colors.length, geometry.positions.length / 3 * 4);
assert.deepEqual(new Set(geometry.positions), new Set(input.meshes[0].positions));
const probeAsset = result.assets.find(asset => asset.id === result.probeAssetId);
const probes = JSON.parse(await fs.readFile(options.decodeAssetUrl(probeAsset.url), 'utf8'));
assert.ok(probes.probes.some(probe => probe.irradiance.some(value => value > 0.01)), '真实环境光应产生非零探针');
await fs.writeFile(path.join(root, 'verified-snapshot.json'), JSON.stringify(result, null, 2));

// 使用同一个受控脚本验证实际子进程取消和超时，不依赖模拟进程。
const jobFolders = await fs.readdir(path.join(root, '.babylon-editor', 'lighting-bake-jobs'));
const source = path.join(root, '.babylon-editor', 'lighting-bake-jobs', jobFolders[0]);
const cancellation = path.join(root, 'cancellation');
await fs.mkdir(cancellation);
await fs.copyFile(path.join(source, 'input.json'), path.join(cancellation, 'input.json'));
const controller = new AbortController();
const cancel = runLightingBakeProcess({ ...options, signal: controller.signal }, cancellation, path.join(source, 'cycles_bake.py'));
setTimeout(() => controller.abort(), 100);
await assert.rejects(cancel, /取消/);
const timeoutDirectory = path.join(root, 'timeout');
await fs.mkdir(timeoutDirectory);
await fs.copyFile(path.join(source, 'input.json'), path.join(timeoutDirectory, 'input.json'));
await assert.rejects(runLightingBakeProcess({ ...options, timeoutMs: 100 }, timeoutDirectory, path.join(source, 'cycles_bake.py')), /超时/);
const outputBefore = (await fs.readdir(path.join(root, 'Assets', 'LightingBakes'))).sort();
const cancelledCommit = new AbortController();
await assert.rejects(runLightingBakeJob({ ...options, input: { ...input, jobId: 'cancel-at-commit' },
  signal: cancelledCommit.signal, onProgress: event => { if (event.phase === 'applying') cancelledCommit.abort(); } }),
// 原生 fs.readFile 的 AbortSignal 会返回标准 AbortError；两种取消出口都须保留旧资源。
error => /取消/.test(error.message) || (error.name === 'AbortError' && error.code === 'ABORT_ERR'));
assert.deepEqual((await fs.readdir(path.join(root, 'Assets', 'LightingBakes'))).sort(), outputBefore, '取消不能提交新资源或覆盖旧资源');
await assert.rejects(runLightingBakeJob({ ...options, input: { ...input, jobId: 'budget-failure',
  settings: { ...input.settings, texelsPerMeter: 256, atlasSize: 64, maxTextureMiB: 1 } }, onProgress: () => {} }), /纹理预算/);
assert.deepEqual((await fs.readdir(path.join(root, 'Assets', 'LightingBakes'))).sort(), outputBefore, '引擎失败不能覆盖旧资源');
const linkedProject = path.join(root, 'linked-project'), outside = path.join(root, 'outside-assets');
await fs.mkdir(linkedProject); await fs.mkdir(outside);
await fs.symlink(outside, path.join(linkedProject, 'Assets'), process.platform === 'win32' ? 'junction' : 'dir');
await assert.rejects(runLightingBakeJob({ ...options, projectRoot: linkedProject, onProgress: () => {} }), /链接超出/);
assert.deepEqual(await fs.readdir(outside), [], '拒绝链接目录时不应先在外部创建产物目录');
// 逐三角面实证共享图集完整性、左右手绕序和单大网格多页覆盖，不以整张贴图非黑替代。
for (const script of ['cycles_atlas_integrity_checks.py', 'cycles_partition_checks.py']) {
  const directory = path.join(root, path.basename(script, '.py'));
  const log = path.join(root, `${script}.log`);
  let output;
  try {
    output = await promisify(execFile)(engine.path, ['--background', '--factory-startup', '--disable-autoexec',
      '--python-exit-code', '1', '--python', path.resolve('tests/lightingBake', script), '--', '--output', directory],
    { windowsHide: true, timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    await fs.writeFile(log, String(error.stdout ?? '') + String(error.stderr ?? ''));
    throw error;
  }
  await fs.writeFile(log, output.stdout + output.stderr);
  assert.match(output.stdout, /CYCLES_(ATLAS_INTEGRITY_PASSED|PARTITION_CHECKS_PASS)/, `${script} 必须完成全部断言`);
}
console.log(JSON.stringify({ success: true, engine, evidenceDirectory: root, uvReport, statistics: result.statistics }));
