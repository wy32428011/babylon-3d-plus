import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..');
const selectedTests = process.argv.slice(2);
for (const name of selectedTests) {
  if (!/^[A-Za-z0-9._-]+\.test\.ts$/.test(name) || !existsSync(join(projectRoot, 'tests/telemetry', name))) {
    throw new Error(`无效的遥测测试文件：${name}`);
  }
}
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
        allowImportingTsExtensions: true,
        rewriteRelativeImportExtensions: true,
        noEmit: false,
        outDir,
        rootDir: projectRoot,
        types: ['node'],
        typeRoots: [join(projectRoot, 'node_modules/@types')],
      },
      include: [
        normalizedProjectRoot + '/src/vite-env.d.ts',
        normalizedProjectRoot + '/src/runtime/mqtt/deviceTelemetry.ts',
        normalizedProjectRoot + '/src/runtime/mqtt/MqttStackerTelemetryConfig.ts',
        normalizedProjectRoot + '/src/runtime/mqtt/StackerTelemetrySimulator.ts',
        normalizedProjectRoot + '/src/runtime/babylon/telemetry/**/*.ts',
        normalizedProjectRoot + '/src/editor/model/**/*.ts',
        normalizedProjectRoot + '/src/editor/project/SceneSerializer.ts',
        normalizedProjectRoot + '/src/editor/deployment/deploymentExport.ts',
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
  const testFiles = selectedTests.length
    ? selectedTests.map(name => join(outDir, 'tests/telemetry', name.replace(/\.ts$/, '.js')))
    : [join(outDir, 'tests/telemetry/**/*.test.js')];
  run('node', ['--test', ...testFiles], projectRoot);
} catch (error) {
  process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  console.error('遥测回归执行失败：', error.message);
} finally {
  const target = relative(resolve(tmpdir()), resolve(tempRoot));
  if (!target.startsWith('babylon-telemetry-test-') || target.includes(sep)) throw new Error('测试清理目录超出临时工作区。');
  rmSync(tempRoot, { recursive: true, force: true });
}

/** 执行遥测自检子命令，并在失败时透传退出码。 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    throw Object.assign(new Error(`${command} 子命令退出码 ${result.status ?? 'unknown'}`), { exitCode: result.status ?? 1 });
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
    const rewritten = source.replace(/(from\s+|import\s+|import\(\s*)(['"])([^'"]+)\2/g, (match, prefix, quote, specifier) => {
      if (specifier.startsWith('@babylonjs/')) {
        // Babylon 的 bundler 风格深路径在纯 Node ESM 中必须指向真实 JS 文件。
        if (existsSync(join(projectRoot, 'node_modules', `${specifier}.js`))) return `${prefix}${quote}${specifier}.js${quote}`;
        if (existsSync(join(projectRoot, 'node_modules', specifier, 'index.js'))) return `${prefix}${quote}${specifier}/index.js${quote}`;
        return match;
      }
      if (!specifier.startsWith('.')) return match;
      // 编译产物在纯 Node 环境运行，图片/模型等二进制资产无法加载，替换为空默认导出桩
      if (/[.](png|jpe?g|webp|gif|svg|glb|gltf)$/.test(specifier)) return `${prefix}"data:text/javascript,export default %22%22"`;
      if (specifier.endsWith('.js')) return match;
      return `${prefix}${quote}${specifier}.js${quote}`;
    });
    if (rewritten !== source) writeFileSync(entryPath, rewritten);
  }
}
