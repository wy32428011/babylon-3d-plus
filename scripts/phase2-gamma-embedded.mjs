import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { decodeGammaGiPng } from '../tests/helpers/phase2GammaGiAcceptance.mjs';
import { createLightingBakeTask, cleanupLightingBakeTasks } from '../electron/ipc/lightingBakeTaskHistory.ts';

const { values } = parseArgs({ options: { output: { type: 'string' }, engine: { type: 'string' }, source: { type: 'string' } } });
assert.ok(values.output && values.engine && path.isAbsolute(values.engine), '必须提供--output全新目录与--engine实际Blender绝对路径。');
const base = path.resolve(values.output), engine = values.engine;
const relative = path.relative(path.resolve('output'), base);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '微回归仅写仓库output内全新专属目录。');
await fs.lstat(base).then(() => { throw new Error('拒绝覆盖既有微回归证据。'); }, error => { if (error.code !== 'ENOENT') throw error; });
const source = path.resolve(values.source ?? 'electron/lighting-bake/cycles_bake.py');
const started = Date.now();
const result = spawnSync(engine, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python',
  path.resolve('tests/lightingBake/phase2_gamma_embedded_checks.py'), '--', '--source', source, '--output', base], {
  encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
});
await fs.mkdir(base, { recursive: true });
await fs.writeFile(path.join(base, 'blender.stdout.log'), result.stdout ?? ''); await fs.writeFile(path.join(base, 'blender.stderr.log'), result.stderr ?? '');
const report = { pass: false, engine, elapsedMs: Date.now() - started, exitCode: result.status, processError: result.error?.message };
try {
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  report.blender = JSON.parse(await fs.readFile(path.join(base, 'blender-report.json'), 'utf8')); assert.equal(report.blender.pass, true);
  report.png = [];
  const expected = report.blender.cases.find(row => row.name === 'success');
  for (const [name, field] of [['gamma', 'expectedGammaBottomFirstBytes'], ['linear', 'expectedLinearBottomFirstBytes']]) {
    const bytes = await fs.readFile(path.join(base, 'success', name + '.png')), image = decodeGammaGiPng(bytes);
    assert.deepEqual([image.width, image.height], [2, 2]);
    const bottomFirst = Buffer.concat([image.rgba.subarray(8), image.rgba.subarray(0, 8)]);
    assert.deepEqual([...bottomFirst], expected[field]);
    report.png.push({ name, width: 2, height: 2, sha256: createHash('sha256').update(bytes).digest('hex'), rgbaBottomFirst: [...bottomFirst] });
  }
  const project = path.join(base, 'ownership-check'); await fs.mkdir(project);
  const task = await createLightingBakeTask(project, { jobId: 'unknown-directory', sceneName: 'embedded guard', signature: 'embedded-signature' }, '5.2.2', { signature: 'embedded-signature', issues: [] });
  await fs.mkdir(path.join(task.directory, '__pycache__'));
  await assert.rejects(task.finish('completed', 'unknown dir must fail'), /非普通文件/);
  await task.update({ status: 'error', phase: 'error' });
  await assert.rejects(cleanupLightingBakeTasks(project, [task.record.taskId]), /非普通文件/);
  report.unknownDirectoryStillRejected = true;
  report.pass = true;
} finally {
  await fs.writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ pass: report.pass, output: base, blenderElapsedMs: report.elapsedMs }));
}
