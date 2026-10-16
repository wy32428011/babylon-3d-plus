import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiler = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
const diagnosticHost = { getCanonicalFileName: file => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' };

/** 按实际编译配置列举全部产物，避免增量缓存掩盖单个 IPC 或声明文件缺失。 */
function expectedElectronOutputs(root) {
  const configFile = path.join(root, 'tsconfig.node.json');
  const loaded = ts.readConfigFile(configFile, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.formatDiagnostics([loaded.error], diagnosticHost));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, undefined, configFile);
  if (parsed.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, diagnosticHost));
  return [...new Set(parsed.fileNames.flatMap(file => ts.getOutputFileNames(parsed, file, !ts.sys.useCaseSensitiveFileNames)))];
}

/** 输出齐全时沿用增量构建；任一产物缺失时由本次单次构建完整重建。 */
export function runTypeScript({ root = workspaceRoot, mode = 'root', stdio = 'inherit' } = {}) {
  if (!['root', 'electron'].includes(mode)) throw new Error(`未知编译模式: ${mode}`);
  const outputs = expectedElectronOutputs(root);
  const missing = outputs.filter(file => !existsSync(file) || !statSync(file).isFile());
  const forced = missing.length > 0;
  const args = ['-b', mode === 'electron' ? 'tsconfig.node.json' : 'tsconfig.json', ...(forced ? ['--force'] : [])];
  if (stdio === 'inherit' && forced) console.log(`[typescript] 缺少 ${missing.length}/${outputs.length} 个 Electron 产物，本次强制重建。`);
  const result = spawnSync(process.execPath, [compiler, ...args], { cwd: root, stdio, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, signal: result.signal, forced, missing, expectedOutputs: outputs.length,
    ...(stdio === 'pipe' ? { stdout: result.stdout, stderr: result.stderr } : {}) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--electron')) throw new Error('未知参数；用法: node scripts/build-typescript.mjs [--electron]');
    process.exitCode = runTypeScript({ mode: args[0] ? 'electron' : 'root' }).status;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
