import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: { scene: { type: 'string' }, candidate: { type: 'string' }, output: { type: 'string' } } });
assert.ok(values.scene && values.candidate && values.output, '--scene 为独立完整环境副本，--candidate 为无损候选，--output 必须全新。');
const sourceScene = path.resolve(values.scene), candidate = path.resolve(values.candidate), output = path.resolve(values.output);
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
assert.ok(output !== path.resolve('output') && inside(path.resolve('output'), output));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const originalScene = await fs.readFile(sourceScene), document = JSON.parse(originalScene.toString('utf8'));
assert.equal(path.basename(path.dirname(sourceScene)).toLowerCase(), 'scenes');
assert.equal(Object.values(document.scene.entities).some(entity => entity.components?.modelAsset), false, '像素对照只允许无外置模型脚本的独立完整环境副本。');
assert.equal(document.scene.mqttConfig.enabled, false);
const originalProject = path.dirname(path.dirname(sourceScene)), environment = document.scene.sceneSettings.environment;
assert.equal(environment.variants.length, 1, '此验收固定原环境唯一GLB变体，不能猜活动变体。');
const originalModel = environment.variants[0].sourcePath;
assert.ok(inside(path.join(originalProject, 'Assets'), originalModel));
const originalModelSha = sha(await fs.readFile(originalModel)), candidateSha = sha(await fs.readFile(candidate));
assert.notEqual(originalModelSha, candidateSha);
await fs.mkdir(output, { recursive: false });
const report = { status: 'RUNNING', scope: 'same-hardware full-buffer actual Editor comparison of original GLB and storage-only candidate; no FPS claim',
  sourceScene, sourceSceneSha256: sha(originalScene), originalModelSha256: originalModelSha, candidateSha256: candidateSha, cases: [] };
try {
  for (const name of ['original', 'candidate']) {
    const project = path.join(output, name, 'project');
    await fs.mkdir(project, { recursive: true });
    // 仅复制任务副本；不跟随链接，也不覆盖既有目录或原资产。
    await fs.cp(path.join(originalProject, 'Assets'), path.join(project, 'Assets'), { recursive: true, force: false, errorOnExist: true,
      filter: async file => { const stat = await fs.lstat(file); assert.equal(stat.isSymbolicLink(), false); return true; } });
    const rewrite = value => {
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
      if (typeof value !== 'string') return value;
      let physical = value, kind = 'path';
      if (value.startsWith('editor-asset://local/')) { physical = decodeURIComponent(new URL(value).pathname.slice(1)); kind = 'editor'; }
      else if (value.startsWith('file:')) { physical = fileURLToPath(value); kind = 'file'; }
      if (!path.isAbsolute(physical) || !inside(originalProject, physical)) return value;
      const mapped = path.join(project, path.relative(originalProject, physical));
      return kind === 'editor' ? 'editor-asset://local/' + encodeURIComponent(mapped) : kind === 'file' ? pathToFileURL(mapped).href : mapped;
    };
    const prepared = rewrite(document);
    prepared.scene.sceneSettings.lighting.result = null;
    prepared.scene.sceneSettings.lighting.bake.enabled = false;
    const model = path.join(project, path.relative(originalProject, originalModel));
    if (name === 'candidate') {
      await fs.copyFile(candidate, model);
      const settings = prepared.scene.sceneSettings.environment;
      settings.fileSizeBytes = (await fs.stat(model)).size;
      // 候选是独立本地修订，不能继续冒用中台原文件的大小/版本声明。
      for (const key of ['source', 'resourceType', 'dataPlatformResourceId', 'dataPlatformSourceKey', 'dataPlatformRevision', 'displayNameSnapshot']) delete settings[key];
      report.candidateRegistration = { source: 'local-copy', byteLength: settings.fileSizeBytes, sha256: candidateSha,
        originalRemoteBindingPreservedInOriginalProject: true };
    }
    await fs.mkdir(path.join(project, 'Scenes'));
    const scene = path.join(project, 'Scenes', 'storage-pixels.scene.json');
    await fs.writeFile(scene, JSON.stringify(prepared, null, 2) + '\n');
    const capture = path.join(output, name, 'capture');
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/phase2-runtime-audit.mjs', '--scene', scene, '--output', capture,
        '--width', '1920', '--height', '1080', '--pixels', '--scene-in-place'], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const parts = [];
      child.stdout.on('data', part => parts.push(part)); child.stderr.on('data', part => parts.push(part));
      child.once('error', reject); child.once('exit', code => resolve({ code, log: Buffer.concat(parts).toString('utf8') }));
    });
    await fs.writeFile(path.join(output, name, 'capture.log'), result.log);
    assert.equal(result.code, 0, result.log.slice(-3000));
    const actual = JSON.parse(await fs.readFile(path.join(capture, 'report.json'), 'utf8'));
    report.cases.push({ name, modelSha256: sha(await fs.readFile(model)), report: actual, capture });
    assert.equal(actual.status, 'PASS_STATIC_PIXELS'); assert.equal(actual.functionalPass, true);
  }
  const [baseline, changed] = report.cases;
  assert.deepEqual(changed.report.before.renderer, baseline.report.before.renderer, '不能跨显卡比较像素。');
  assert.deepEqual(changed.report.pixels.camera, baseline.report.pixels.camera);
  assert.deepEqual([changed.report.pixels.width, changed.report.pixels.height], [1920, 1080]);
  const left = await fs.readFile(path.join(baseline.capture, 'frame.rgba')), right = await fs.readFile(path.join(changed.capture, 'frame.rgba'));
  assert.equal(left.length, 1920 * 1080 * 4); assert.equal(right.length, left.length);
  let changedPixels = 0, maxDifference = 0;
  const colors = new Set();
  for (let index = 0; index < left.length; index += 4) {
    colors.add(left.readUInt32LE(index)); let different = false;
    for (let channel = 0; channel < 4; channel++) { const delta = Math.abs(left[index + channel] - right[index + channel]); different ||= delta !== 0; maxDifference = Math.max(maxDifference, delta); }
    if (different) changedPixels++;
  }
  report.comparison = { changedPixels, maxDifference, uniqueBaselineColors: colors.size, rgbaBytes: left.length };
  assert.ok(colors.size > 32, '不能拿空白画布证明无损。');
  assert.equal(changedPixels, 0, '存储无损候选必须完整RGBA逐字节相同。');
  report.status = 'PASS_FULL_BUFFER_STORAGE_EQUIVALENCE';
} catch (error) { report.status = 'FAIL'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  report.originalSceneUnchanged = sha(await fs.readFile(sourceScene)) === report.sourceSceneSha256;
  report.originalModelUnchanged = sha(await fs.readFile(originalModel)) === originalModelSha;
  report.candidateUnchanged = sha(await fs.readFile(candidate)) === candidateSha;
  assert.ok(report.originalSceneUnchanged && report.originalModelUnchanged && report.candidateUnchanged);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, output, comparison: report.comparison, error: report.error }));
}
