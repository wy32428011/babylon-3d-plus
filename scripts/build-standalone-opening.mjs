import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import ts from 'typescript';
import { ZipArchive } from 'archiver';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = '1.0.0';
const output = path.join(root, 'output/standalone-opening');
await mkdir(output, { recursive: true });
const delivery = await mkdtemp(path.join(output, 'delivery-'));
const name = `zending-opening-web-${version}`;
const folder = path.join(delivery, name);
await mkdir(folder, { recursive: true });

const libraryOptions = {
  configFile: false, base: './', publicDir: false, logLevel: 'warn',
  build: {
    target: 'es2022', minify: false, reportCompressedSize: false,
    lib: { name: 'ZendingOpening', formats: ['es', 'iife'],
      fileName: format => format === 'es' ? 'zending-opening.mjs' : 'zending-opening.js',
      cssFileName: 'zending-opening' },
    rolldownOptions: { output: { codeSplitting: false } },
  },
};
const result = await build({ ...libraryOptions, root,
  cacheDir: path.join(delivery, 'vite-cache'),
  build: { ...libraryOptions.build, outDir: path.join(folder, 'dist'),
    lib: { ...libraryOptions.build.lib, entry: path.join(root, 'src/standalone-opening/index.ts') } },
});
const chunks = (Array.isArray(result) ? result : [result]).flatMap(output => output.output).filter(file => file.type === 'chunk');
for (const chunk of chunks) {
  if (chunk.imports.length || chunk.dynamicImports.length) throw new Error('独立插件仍包含外部运行模块依赖');
  if (Object.keys(chunk.modules).some(file => /node_modules[\\/](?:react|react-dom|electron|@babylonjs)[\\/]/.test(file))) {
    throw new Error('独立插件不应依赖 React、Electron 或 Babylon');
  }
}

for (const file of ['index', 'types']) {
  const source = await readFile(path.join(root, `src/standalone-opening/${file}.ts`), 'utf8');
  const declaration = ts.transpileDeclaration(source, { fileName: `${file}.ts`,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  if (declaration.diagnostics?.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(declaration.diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  // 样式已经抽取为公开的 zending-opening.css，声明不应保留源码 CSS 的副作用导入。
  await writeFile(path.join(folder, `dist/${file}.d.ts`), declaration.outputText.replace(/^import ['"][^'"]+\.css['"];?\s*$/gm, ''));
}
const program = ts.createProgram([path.join(folder, 'dist/index.d.ts')], {
  noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [],
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
}));

const sdk = await import(pathToFileURL(path.join(folder, 'dist/zending-opening.mjs')).href);
if (sdk.VERSION !== version) throw new Error('插件与交付版本不一致');
await writeFile(path.join(folder, 'config.default.json'), JSON.stringify(sdk.defaultSettings(), null, 2) + '\n');
await writeFile(path.join(folder, 'package.json'), JSON.stringify({
  name: '@zending/opening-animation', version, private: true, type: 'module',
  description: '独立网页与大屏开场动画，原生 Canvas/WebGL，无框架运行依赖。',
  types: './dist/index.d.ts', module: './dist/zending-opening.mjs',
  exports: { '.': { types: './dist/index.d.ts', import: './dist/zending-opening.mjs', default: './dist/zending-opening.mjs' },
    './style.css': './dist/zending-opening.css', './browser': './dist/zending-opening.js' },
  files: ['dist', 'README.md', 'NOTICE.md', 'config.default.json'],
}, null, 2) + '\n');
for (const file of ['README.md', 'NOTICE.md', 'demo.html', 'iframe-demo.html']) {
  await copyFile(path.join(root, 'standalone-opening', file), path.join(folder, file));
}

// 保留运行实现和 type-only 相对依赖，使压缩包离开原仓库也能重新构建。
const copied = new Set();
async function resolveSource(importer, specifier) {
  const raw = path.resolve(path.dirname(importer), specifier.split('?')[0]);
  for (const candidate of [raw, ...['.ts', '.tsx', '.js', '.d.ts', '/index.ts'].map(extension => raw + extension)]) {
    try { if ((await stat(candidate)).isFile()) return candidate; } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  throw new Error(`未找到源码依赖：${path.relative(root, importer)} -> ${specifier}`);
}
async function copySource(file) {
  if (copied.has(file)) return;
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('源码依赖超出当前仓库');
  copied.add(file);
  const destination = path.join(folder, 'source', relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(file, destination);
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    const text = await readFile(file, 'utf8');
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      if (imported.fileName.startsWith('.')) await copySource(await resolveSource(file, imported.fileName));
      else throw new Error(`源码存在需要额外处理的外部依赖：${imported.fileName}`);
    }
    if (file.endsWith('.js')) {
      const declaration = file.slice(0, -3) + '.d.ts';
      try { await stat(declaration); await copySource(declaration); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
await copySource(path.join(root, 'src/standalone-opening/index.ts'));
await copyFile(path.join(root, 'src/runtime/opening/reference/SOURCE.md'), path.join(folder, 'source/ASSET-SOURCE.md'));
const viteVersion = JSON.parse(await readFile(path.join(root, 'node_modules/vite/package.json'), 'utf8')).version;
await writeFile(path.join(folder, 'source/package.json'), JSON.stringify({ name: 'zending-opening-source', version,
  private: true, type: 'module', engines: { node: '>=22.12.0' }, scripts: { build: 'node build.mjs', typecheck: 'tsc --noEmit' },
  devDependencies: { vite: viteVersion, typescript: ts.version } }, null, 2) + '\n');
await writeFile(path.join(folder, 'source/env.d.ts'), '/// <reference types="vite/client" />\n');
await writeFile(path.join(folder, 'source/tsconfig.json'), JSON.stringify({ compilerOptions: {
  target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM', 'DOM.Iterable'],
  strict: true, noEmit: true, allowJs: true, checkJs: false, allowImportingTsExtensions: true, skipLibCheck: true,
  types: ['vite/client'],
}, include: ['src/**/*', 'electron/shared/**/*', 'env.d.ts'] }, null, 2) + '\n');
await writeFile(path.join(folder, 'source/build.mjs'), `import { build } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
const root = path.dirname(fileURLToPath(import.meta.url));
await build({ configFile: false, root, base: './', publicDir: false, build: {
  target: 'es2022', minify: false, reportCompressedSize: false, outDir: path.join(root, '../dist'),
  lib: { entry: path.join(root, 'src/standalone-opening/index.ts'), name: 'ZendingOpening', formats: ['es', 'iife'],
    fileName: format => format === 'es' ? 'zending-opening.mjs' : 'zending-opening.js', cssFileName: 'zending-opening' },
  rolldownOptions: { output: { codeSplitting: false } },
}});
for (const name of ['index', 'types']) {
  const text = await readFile(path.join(root, 'src/standalone-opening/' + name + '.ts'), 'utf8');
  const result = ts.transpileDeclaration(text, { fileName: name + '.ts', compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  if (result.diagnostics?.length) throw new Error('公开类型生成失败');
  await writeFile(path.join(root, '../dist/' + name + '.d.ts'), result.outputText.replace(/^import ['"][^'"]+\\.css['"];?\\s*$/gm, ''));
}
`);

async function filesUnder(directory, prefix = '') {
  const files = [];
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + item.name;
    if (item.isDirectory()) files.push(...await filesUnder(path.join(directory, item.name), relative + '/'));
    else if (item.isFile()) files.push(relative);
    else throw new Error('交付包不能包含符号链接或特殊文件');
  }
  return files;
}
const files = await filesUnder(folder);
const entries = await Promise.all(files.map(async file => {
  const bytes = await readFile(path.join(folder, file));
  return { path: file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}));
await writeFile(path.join(folder, 'integrity.json'), JSON.stringify({ version, files: entries }, null, 2) + '\n');
const zip = path.join(delivery, `${name}.zip`);
const archive = new ZipArchive({ zlib: { level: 9 } });
const stream = createWriteStream(zip);
const done = new Promise((resolve, reject) => { stream.on('close', resolve); stream.on('error', reject); archive.on('error', reject); });
archive.pipe(stream);
archive.directory(folder, name);
await archive.finalize(); await done;
const bytes = await readFile(zip);
const report = { version, folder, zip, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  files: entries.length + 1, sourceFiles: copied.size, runtimeDependencies: [],
  formats: ['IIFE', 'ES Module'], defaultDurationSeconds: sdk.defaultSettings().reference.stageDurations.reduce((sum, value) => sum + value, 0) };
await writeFile(path.join(output, 'latest-build.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
