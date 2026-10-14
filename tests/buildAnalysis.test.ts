import assert from 'node:assert/strict';
import test from 'node:test';
import { initialChunkNames, buildAnalysisPlugins } from '../scripts/build-analysis-plugin.ts';
import { captureBuildInputs } from '../scripts/lib/build-provenance.mjs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { build } from 'vite';

test('initial chunks follow static cycles and exclude dynamic-only roots and assets', () => {
  const initial = initialChunkNames([
    { type: 'chunk', fileName: 'entry.js', isEntry: true, imports: ['shared.js', 'external'], dynamicImports: ['lazy.js'] },
    { type: 'chunk', fileName: 'shared.js', imports: ['entry.js'] },
    { type: 'chunk', fileName: 'lazy.js', imports: ['shared.js'] },
    { type: 'asset', fileName: 'entry.css' },
  ]);
  assert.deepEqual([...initial].sort(), ['entry.js', 'shared.js']);
});

test('source identity includes non-ignored untracked build inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'babylon-build-identity-'));
  try {
    execFileSync('git', ['init', '--quiet', root]);
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/new.ts'), 'export const value = 1;');
    const first = captureBuildInputs(root);
    assert.deepEqual(first.files.map(file => file.path), ['src/new.ts']);
    await writeFile(path.join(root, 'src/new.ts'), 'export const value = 2;');
    assert.notEqual(captureBuildInputs(root).sha256, first.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact summary includes files from delayed capability write hooks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'babylon-build-summary-'));
  const previous = { ANALYZE: process.env.ANALYZE, ANALYZE_DIR: process.env.ANALYZE_DIR };
  try {
    process.env.ANALYZE = '1'; process.env.ANALYZE_DIR = path.join(root, 'reports');
    await writeFile(path.join(root, 'index.html'), '<script type="module">console.log("fixture")</script>');
    const output = path.join(root, 'dist');
    await build({ configFile: false, root, publicDir: false, logLevel: 'silent',
      plugins: [...buildAnalysisPlugins('viewer'), { name: 'delayed-capability-fixture', async writeBundle() {
        await new Promise(resolve => setTimeout(resolve, 80));
        await writeFile(path.join(output, 'capabilities.json'), '{"ready":true}');
      } }], build: { outDir: output, minify: false } });
    const summary = JSON.parse(await readFile(path.join(root, 'reports/viewer/summary.json'), 'utf8'));
    const files = (await readdir(output, { recursive: true, withFileTypes: true })).filter(file => file.isFile());
    assert.ok(files.some(file => file.name === 'capabilities.json'));
    assert.equal(summary.artifact.files, files.length);
    assert.equal(summary.artifact.bytes, (await Promise.all(files.map(async file =>
      (await readFile(path.join(file.parentPath, file.name))).length))).reduce((a, b) => a + b, 0));
    assert.ok(!files.some(file => /summary|modules\.html/.test(file.name)));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('normal builds have no analysis hooks and enabled reports stay outside bundle assets', () => {
  const previous = process.env.ANALYZE;
  try {
    delete process.env.ANALYZE;
    assert.deepEqual(buildAnalysisPlugins('viewer'), []);
    process.env.ANALYZE = '1';
    const plugins = buildAnalysisPlugins('viewer') as { name: string; emitFile?: unknown }[];
    assert.equal(plugins.length, 3);
    assert.equal(plugins.at(-1)?.name, 'build-analysis-final-files');
  } finally {
    if (previous === undefined) delete process.env.ANALYZE;
    else process.env.ANALYZE = previous;
  }
});
