import { hashSha256 } from './sha256.ts';

/** Node 预转译与旧包 renderer 兜底必须共用同一预处理，保持装饰器、导出类与注入语义。 */
export const MODEL_SCRIPT_COMPILATION_FORMAT = 'babylon-model-script-v1';
/** 生成与读取统一按整个 JSON 的 UTF-8 字节数计量，避免中文或转义使自产缓存被拒绝。 */
export const MODEL_SCRIPT_CACHE_MAX_BYTES = 16 * 1024 * 1024;

export type PrecompiledModelScript = {
  format: typeof MODEL_SCRIPT_COMPILATION_FORMAT;
  sourceSha256: string;
  codeSha256: string;
  compilerVersion: string;
  code: string;
  initializationError?: string;
};

/** 缓存仅是可丢弃的派生数据；旧场景或损坏缓存继续走源码兼容路径。 */
export function normalizePrecompiledModelScript(value: unknown): PrecompiledModelScript | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (data.format !== MODEL_SCRIPT_COMPILATION_FORMAT
    || typeof data.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sourceSha256)
    || typeof data.codeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.codeSha256)
    || typeof data.compilerVersion !== 'string' || data.compilerVersion.length > 64
    || typeof data.code !== 'string' || data.code.length > MODEL_SCRIPT_CACHE_MAX_BYTES
    || (data.initializationError !== undefined && (typeof data.initializationError !== 'string' || data.initializationError.length > 4096))) return undefined;
  return { format: MODEL_SCRIPT_COMPILATION_FORMAT, sourceSha256: data.sourceSha256,
    codeSha256: data.codeSha256, compilerVersion: data.compilerVersion, code: data.code,
    ...(typeof data.initializationError === 'string' ? { initializationError: data.initializationError } : {}) };
}

/** 预转译产物不能静默超出 Viewer 的读取契约；导入/导出阶段给出明确诊断。 */
export function serializePrecompiledModelScript(value: PrecompiledModelScript): string {
  const content = JSON.stringify(value) + '\n';
  if (!normalizePrecompiledModelScript(value) || new TextEncoder().encode(content).byteLength > MODEL_SCRIPT_CACHE_MAX_BYTES) {
    throw new Error(`模型脚本预转译缓存超过 ${MODEL_SCRIPT_CACHE_MAX_BYTES / 1024 / 1024} MiB 上限。`);
  }
  return content;
}

/** 以严格解码后的同一 UTF-8 文本计算摘要，BOM 不参与缓存身份。 */
export async function digestModelScriptText(source: string): Promise<string> {
  return hashSha256(new TextEncoder().encode(source));
}

export function prepareModelScriptCompilation(source: string): { sourceText: string; returnStatement: string } {
  const { sourceWithoutImports, importPrelude } = createImportPrelude(source);
  const exportTransform = removeTypeScriptExports(stripVisibleDecorators(sourceWithoutImports));
  const sourceText = importPrelude + '\n' + exportTransform.sourceText;
  return { sourceText, returnStatement: createReturnStatement(collectClassNames(sourceText), exportTransform.defaultClassName) };
}

type ImportBinding = {
  localName: string;
  importedName: string;
  source: 'babylon' | 'babylonNamespace' | 'decorator';
};

const SCRIPT_IMPORT_PATTERN = /^\s*import\s+(type\s+)?(.+?)\s+from\s+["']([^"']+)["'];?\s*$/gm;
const VISIBLE_DECORATOR_PATTERN = /^\s*@visibleAs[A-Za-z]+\([^)]*\)\s*$/;

/** 将 import 语句转换为受控注入变量，避免运行时动态解析第三方模块。 */
function createImportPrelude(sourceText: string): { sourceWithoutImports: string; importPrelude: string } {
  const bindings: ImportBinding[] = [];
  const sourceWithoutImports = sourceText.replace(SCRIPT_IMPORT_PATTERN, (statement, typeKeyword, importClause, moduleName) => {
    if (typeKeyword) return '';
    bindings.push(...parseImportBindings(importClause, moduleName));
    return '';
  });

  const uniqueBindings = new Map<string, ImportBinding>();
  for (const binding of bindings) {
    uniqueBindings.set(binding.localName, binding);
  }

  const importPrelude = [...uniqueBindings.values()].map((binding) => {
    if (binding.source === 'decorator') {
      return `const ${binding.localName} = __decorator;`;
    }
    if (binding.source === 'babylonNamespace') {
      return `const ${binding.localName} = __babylon;`;
    }
    return `const ${binding.localName} = __babylon[${JSON.stringify(binding.importedName)}];`;
  }).join('\n');

  return { sourceWithoutImports, importPrelude };
}

/** 解析外置脚本中常见的命名导入和命名空间导入。 */
function parseImportBindings(importClause: string, moduleName: string): ImportBinding[] {
  const source = moduleName.includes('babylonjs-editor-tools') ? 'decorator' : 'babylon';
  const trimmedClause = importClause.trim();

  if (trimmedClause.startsWith('* as ')) {
    const localName = trimmedClause.slice(5).trim();
    return isSafeIdentifier(localName) ? [{ localName, importedName: localName, source: 'babylonNamespace' }] : [];
  }

  const namedImportMatch = trimmedClause.match(/\{([\s\S]+)\}/);
  if (!namedImportMatch) return [];

  return namedImportMatch[1].split(',').flatMap((rawBinding) => {
    const bindingParts = rawBinding.trim().split(/\s+as\s+/i).map((part) => part.trim()).filter(Boolean);
    const importedName = bindingParts[0];
    const localName = bindingParts[1] ?? importedName;
    if (!isSafeIdentifier(importedName) || !isSafeIdentifier(localName)) return [];
    return [{ localName, importedName, source }];
  });
}

/** 移除 Inspector 装饰器行，运行时参数由当前编辑器显式注入。 */
function stripVisibleDecorators(sourceText: string): string {
  return sourceText
    .split(/\r?\n/)
    .filter((line) => !VISIBLE_DECORATOR_PATTERN.test(line.trim()))
    .join('\n');
}

/** 移除 ES module export 关键字，让脚本在受控函数作用域中执行。 */
function removeTypeScriptExports(sourceText: string): { sourceText: string; defaultClassName: string | null } {
  let defaultClassName: string | null = null;
  const normalizedSource = sourceText
    .replace(/\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/g, (_statement, className: string) => {
      defaultClassName = className;
      return `class ${className}`;
    })
    .replace(/\bexport\s+default\s+class\b/g, () => {
      defaultClassName = '__DefaultExternalModelScript';
      return 'class __DefaultExternalModelScript';
    })
    .replace(/\bexport\s+(?=(abstract\s+)?class|interface|type|enum|const|let|var|function)\b/g, '');

  return { sourceText: normalizedSource, defaultClassName };
}

/** 收集脚本中声明的类名，用于构造返回表。 */
function collectClassNames(sourceText: string): string[] {
  const classNames = new Set<string>();
  const classPattern = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  let match = classPattern.exec(sourceText);

  while (match) {
    classNames.add(match[1]);
    match = classPattern.exec(sourceText);
  }

  return [...classNames];
}

/** 生成安全的返回语句，导出脚本内声明的类。 */
function createReturnStatement(classNames: string[], defaultClassName: string | null): string {
  const entries = classNames.map((className) => {
    return `${JSON.stringify(className)}: typeof ${className} === "undefined" ? undefined : ${className}`;
  });
  if (defaultClassName) {
    entries.push(`default: typeof ${defaultClassName} === "undefined" ? undefined : ${defaultClassName}`);
  }
  return `return { classes: { ${entries.join(', ')} }, dataDriven: typeof dataDriven === "undefined" ? undefined : dataDriven };`;
}

/** 限制注入变量名为普通标识符，避免外置脚本 import 预处理注入代码。 */
function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(value);
}

