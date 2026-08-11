import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const STATIC_ASSET_PATTERN = /\.(png|jpe?g|webp|gif|svg|glb|gltf)$/i;
const MODULE_SPECIFIER_PATTERN = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"]+)\2/g;

/**
 * 把指定源码模块编译到一次性目录后导入，既支持 extensionless 源码引用，
 * 也不会向测试进程注册永久 loader；静态模块图加载完成后立即清理临时产物。
 */
export async function importIsolatedTypeScriptModules<TModules extends readonly unknown[]>(
  projectRelativeEntries: readonly string[],
): Promise<TModules> {
  const projectRoot = resolve(process.cwd());
  const entryPaths = projectRelativeEntries.map((entry) => resolve(projectRoot, entry));
  if (entryPaths.some((entry) => {
    const relativeEntry = relative(projectRoot, entry);
    return relativeEntry.startsWith('..') || isAbsolute(relativeEntry);
  })) {
    throw new Error('测试源码入口必须位于项目目录内。');
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'babylon-ts-test-'));
  const outDir = join(tempRoot, 'out');
  const tsconfigPath = join(tempRoot, 'tsconfig.json');
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
        files: [join(projectRoot, 'src/vite-env.d.ts'), ...entryPaths],
      },
      null,
      2,
    ),
  );

  try {
    compileTypeScriptProject(projectRoot, tsconfigPath);
    rewriteCompiledModuleSpecifiers(outDir);
    const modules = await Promise.all(entryPaths.map((entryPath) => {
      const outputPath = join(outDir, relative(projectRoot, entryPath)).replace(/\.ts$/i, '.js');
      return import(pathToFileURL(outputPath).href);
    }));
    return modules as unknown as TModules;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function compileTypeScriptProject(projectRoot: string, tsconfigPath: string): void {
  const result = spawnSync(
    process.execPath,
    [join(projectRoot, 'node_modules/typescript/bin/tsc'), '-p', tsconfigPath],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  if (result.status === 0) return;

  const output = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  throw new Error(`测试源码临时编译失败。${output ? `\n${output}` : ''}`);
}

function rewriteCompiledModuleSpecifiers(directory: string): void {
  for (const entry of readdirSync(directory)) {
    const entryPath = join(directory, entry);
    if (statSync(entryPath).isDirectory()) {
      rewriteCompiledModuleSpecifiers(entryPath);
      continue;
    }
    if (!entryPath.endsWith('.js')) continue;

    const source = readFileSync(entryPath, 'utf8');
    const rewritten = source.replace(
      MODULE_SPECIFIER_PATTERN,
      (match, prefix: string, quote: string, specifier: string) => {
        if (!specifier.startsWith('.')) return match;
        if (STATIC_ASSET_PATTERN.test(specifier)) {
          return `${prefix}"data:text/javascript,export default %22%22"`;
        }
        if (/\.[^/]+$/.test(specifier)) return match;
        return `${prefix}${quote}${specifier}.js${quote}`;
      },
    );
    if (rewritten !== source) writeFileSync(entryPath, rewritten);
  }
}
