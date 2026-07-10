import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'babylon-telemetry-test-'));
const outDir = join(tempRoot, 'out');
const tsconfigPath = join(tempRoot, 'tsconfig.telemetry.json');
const normalizedProjectRoot = projectRoot.replaceAll(String.fromCharCode(92), '/');
symlinkSync(join(projectRoot, 'node_modules'), join(tempRoot, 'node_modules'), 'junction');

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
        normalizedProjectRoot + '/src/runtime/mqtt/deviceTelemetry.ts',
        normalizedProjectRoot + '/src/runtime/mqtt/MqttStackerTelemetryConfig.ts',
        normalizedProjectRoot + '/src/runtime/mqtt/GenericTelemetrySimulator.ts',
        normalizedProjectRoot + '/src/runtime/mqtt/StackerTelemetrySimulator.ts',
        normalizedProjectRoot + '/src/runtime/babylon/telemetry/**/*.ts',
        normalizedProjectRoot + '/src/editor/model/**/*.ts',
        normalizedProjectRoot + '/src/editor/project/SceneSerializer.ts',
        normalizedProjectRoot + '/tests/telemetry/**/*.ts',
      ],
    },
    null,
    2,
  ),
);

try {
  run('node', ['node_modules/typescript/bin/tsc', '-p', tsconfigPath], projectRoot);
  rewriteRelativeImports(outDir);
  run('node', ['--test', join(outDir, 'tests/telemetry/**/*.test.js')], projectRoot);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

/** 执行遥测自检子命令，并在失败时透传退出码。 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/** 修正临时编译产物中的相对 ESM 导入后缀，避免改动源码导入风格。 */
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
