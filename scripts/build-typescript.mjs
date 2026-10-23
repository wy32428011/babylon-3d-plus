import path from 'node:path';
import { existsSync, statSync, mkdirSync, readdirSync, copyFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiler = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
const diagnosticHost = { getCanonicalFileName: file => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' };

/** 拒绝源码目录中的同名编译产物，防止 Vite/Node 优先加载过期 JavaScript。 */
export function findSourceJavaScriptArtifacts(root = workspaceRoot) {
  const sourceRoot = path.join(root, 'src');
  if (!existsSync(sourceRoot)) return [];
  const artifacts = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const base = file.slice(0, -3);
        if (['.ts', '.tsx'].some(extension => existsSync(base + extension) && statSync(base + extension).isFile())) {
          artifacts.push(path.relative(root, file).replaceAll('\\', '/'));
        }
      }
    }
  };
  visit(sourceRoot);
  return artifacts.sort();
}

/** 按实际编译配置列举全部产物，避免增量缓存掩盖单个 IPC 或声明文件缺失。 */
function expectedElectronOutputs(root) {
  const configFile = path.join(root, 'tsconfig.node.json');
  const loaded = ts.readConfigFile(configFile, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.formatDiagnostics([loaded.error], diagnosticHost));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, undefined, configFile);
  if (parsed.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, diagnosticHost));
  return [...new Set(parsed.fileNames.flatMap(file => ts.getOutputFileNames(parsed, file, !ts.sys.useCaseSensitiveFileNames)))];
}

/** 只检查真实运行时导入；文档示例字符串和模板文本不能触发强制构建。 */
function invalidElectronImports(outputs) {
  return outputs.flatMap(file => {
    if (!/\.[cm]?js$/i.test(file) || !existsSync(file) || !statSync(file).isFile()) return [];
    return ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles.flatMap(({ fileName }) => {
      if (!/^\.\.?\//.test(fileName) || !/\.(?:ts|tsx|mts|cts)(?:[?#]|$)/i.test(fileName)) return [];
      const target = path.resolve(path.dirname(file), fileName.split(/[?#]/, 1)[0]);
      return existsSync(target) && statSync(target).isFile() ? [] : [{ file, reference: fileName, target }];
    });
  });
}

/** 输出齐全且引用可交付时沿用增量；损坏产物最多触发一次强制重建，之后仍损坏则明确失败。 */
export function runTypeScript({ root = workspaceRoot, mode = 'root', stdio = 'inherit' } = {}) {
  if (!['root', 'electron'].includes(mode)) throw new Error(`未知编译模式: ${mode}`);
  const artifacts = findSourceJavaScriptArtifacts(root);
  if (artifacts.length) throw new Error('[typescript] 源码目录存在同名 TypeScript 衍生 JavaScript，请核对后移除：\n'
    + artifacts.map(file => `  ${file}`).join('\n'));
  const outputs = expectedElectronOutputs(root);
  const missing = outputs.filter(file => !existsSync(file) || !statSync(file).isFile());
  const invalidImports = invalidElectronImports(outputs);
  let forced = missing.length > 0 || invalidImports.length > 0;
  const compile = force => {
    const args = ['-b', mode === 'electron' ? 'tsconfig.node.json' : 'tsconfig.json', ...(force ? ['--force'] : [])];
    const result = spawnSync(process.execPath, [compiler, ...args], { cwd: root, stdio, encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
  };
  if (stdio === 'inherit' && missing.length) console.log(`[typescript] 缺少 ${missing.length}/${outputs.length} 个 Electron 产物，本次强制重建。`);
  if (stdio === 'inherit' && invalidImports.length) console.log(`[typescript] ${invalidImports.length} 处 Electron 导入仍指向未交付的 TypeScript 文件，本次强制重建。`);
  let result = compile(forced);
  let unresolvedImports = result.status === 0 ? invalidElectronImports(outputs) : [];
  // 新输入也可能生成不受扩展名重写覆盖的 require；只允许补救一次，不掩盖持续坏引用。
  if (unresolvedImports.length && !forced) {
    forced = true;
    if (stdio === 'inherit') console.log('[typescript] 增量产物仍有未交付的 TypeScript 导入，本次强制重建。');
    const previous = result;
    result = compile(true);
    if (stdio === 'pipe') {
      result.stdout = (previous.stdout ?? '') + (result.stdout ?? '');
      result.stderr = (previous.stderr ?? '') + (result.stderr ?? '');
    }
    unresolvedImports = result.status === 0 ? invalidElectronImports(outputs) : [];
  }
  let status = result.status ?? 1;
  if (unresolvedImports.length) {
    status = 1;
    const diagnostic = '[typescript] 强制重建后 Electron 产物仍引用未交付的 TypeScript 文件：\n'
      + unresolvedImports.map(item => `  ${item.file} -> ${item.reference}`).join('\n') + '\n';
    if (stdio === 'inherit') console.error(diagnostic.trimEnd());
    else if (stdio === 'pipe') result.stderr = (result.stderr ?? '') + diagnostic;
  }
  // Blender 外部进程不能读取 asar；随 Electron 构建复制受控脚本，运行时再展开到任务目录。
  if (status === 0) {
    const source = path.join(root, 'electron', 'lighting-bake');
    if (existsSync(source)) {
      const output = path.join(root, 'dist-electron', 'lighting-bake');
      mkdirSync(output, { recursive: true });
      for (const name of readdirSync(source)) if (name.endsWith('.py')) copyFileSync(path.join(source, name), path.join(output, name));
    }
  }
  return { status, signal: result.signal, forced, missing, expectedOutputs: outputs.length,
    ...(unresolvedImports.length ? { unresolvedImports } : {}),
    ...(stdio === 'pipe' ? { stdout: result.stdout, stderr: result.stderr } : {}) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--electron')) throw new Error('未知参数；用法: node scripts/build-typescript.mjs [--electron]');
    process.exitCode = runTypeScript({ mode: args[0] ? 'electron' : 'root' }).status;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
