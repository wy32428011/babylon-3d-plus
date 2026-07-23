import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'babylon-model-asset-relink-test-'));
const outDir = join(tempRoot, 'out');
const tsconfigPath = join(tempRoot, 'tsconfig.model-asset-relink.json');
const assetTypesPath = join(tempRoot, 'assets.d.ts');
const normalizedProjectRoot = projectRoot.replaceAll(String.fromCharCode(92), '/');
symlinkSync(join(projectRoot, 'node_modules'), join(tempRoot, 'node_modules'), 'junction');
writeFileSync(assetTypesPath, "declare module '*.png' { const source: string; export default source; }\n");

writeFileSync(
  tsconfigPath,
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['DOM', 'DOM.Iterable', 'ES2022'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: false,
        outDir,
        rootDir: projectRoot,
        types: ['node'],
        typeRoots: [join(projectRoot, 'node_modules/@types')],
      },
      include: [
        assetTypesPath.replaceAll(String.fromCharCode(92), '/'),
        normalizedProjectRoot + '/src/editor/assets/modelAssetRelink.ts',
        normalizedProjectRoot + '/tests/editor/modelAssetRelink.test.ts',
      ],
    },
    null,
    2,
  ),
);

try {
  run('node', ['node_modules/typescript/bin/tsc', '-p', tsconfigPath], projectRoot);
  rewriteRelativeImports(outDir);
  run('node', ['--test', join(outDir, 'tests/editor/modelAssetRelink.test.js')], projectRoot);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function rewriteRelativeImports(directory) {
  for (const entry of readdirSync(directory)) {
    const entryPath = join(directory, entry);
    if (statSync(entryPath).isDirectory()) {
      rewriteRelativeImports(entryPath);
      continue;
    }
    if (!entryPath.endsWith('.js')) continue;
    const source = readFileSync(entryPath, 'utf8');
    const rewritten = source.replace(/from '([^']+)'/g, (match, specifier) => {
      if (!specifier.startsWith('.') || specifier.endsWith('.js')) return match;
      return "from '" + specifier + ".js'";
    });
    if (rewritten !== source) writeFileSync(entryPath, rewritten);
  }
}
