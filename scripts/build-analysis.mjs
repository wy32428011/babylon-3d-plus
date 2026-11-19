import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { captureBuildInputs } from './lib/build-provenance.mjs';
import { checkInitialJsBudget } from './lib/build-size-budget.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = process.argv.slice(2);
const checkBudget = options.includes('--check-budget');
const [selected, ...extra] = options.filter((option) => option !== '--check-budget');
if (extra.length || (selected && !['editor', 'viewer'].includes(selected))) {
  throw new Error('用法：node scripts/build-analysis.mjs [editor|viewer] [--check-budget]');
}
const baseline = checkBudget
  ? JSON.parse(await fs.readFile(path.join(workspace, 'scripts/build-size-baseline.json'), 'utf8'))
  : null;
const runRoot = path.resolve(workspace, 'output/bundle-analysis', new Date().toISOString().replaceAll(/[:.]/g, '-'));
await fs.mkdir(runRoot, { recursive: true });
const results = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const provenance = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
  diffSha256: hash(execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: workspace, maxBuffer: 64 * 1024 * 1024 })),
  lockSha256: hash(await fs.readFile(path.join(workspace, 'package-lock.json'))),
  inputs: captureBuildInputs(workspace),
  node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model,
  mode: 'production', reportVersion: 1,
};
for (const target of selected ? [selected] : ['editor', 'viewer']) {
  const started = performance.now();
  const args = ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(runRoot, target, 'dist'), '--emptyOutDir'];
  if (target === 'viewer') args.push('--config', 'vite.viewer.config.ts');
  const log = [];
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: workspace, env: {
      ...process.env, ANALYZE: '1', ANALYZE_DIR: runRoot,
      VITE_CACHE_DIR: path.join(runRoot, target, 'cache'),
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log.push(data); process.stdout.write(data); });
    child.on('error', reject);
    child.on('close', resolve);
  });
  await fs.writeFile(path.join(runRoot, target + '.log'), Buffer.concat(log));
  const result = {
    target,
    exitCode: code,
    wallMs: performance.now() - started,
    cache: 'unique empty cache directory; OS filesystem cache not cleared',
  };
  if (checkBudget && code === 0) {
    const summary = JSON.parse(await fs.readFile(path.join(runRoot, target, 'summary.json'), 'utf8'));
    const budget = checkInitialJsBudget(target, summary, baseline);
    result.initialJsBudget = budget;
    const message = `${target} 首屏 JS ${budget.actualBytes} 字节，基线 ${budget.baselineBytes} 字节，+5% 上限 ${budget.limitBytes} 字节`;
    if (budget.withinBudget) {
      console.log(message);
    } else {
      console.error(`${message}，超出体积门禁。`);
      process.exitCode = 1;
    }
  }
  results.push(result);
  await fs.writeFile(path.join(runRoot, 'run.json'), JSON.stringify({ runRoot, provenance, results }, null, 2) + '\n');
  if (code !== 0) { process.exitCode = 1; break; }
}
console.log('构建分析报告:', runRoot);
