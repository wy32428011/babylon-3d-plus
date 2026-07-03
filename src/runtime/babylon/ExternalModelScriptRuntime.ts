import * as BabylonCore from '@babylonjs/core';
import type { TransformNode } from '@babylonjs/core';
import type * as TypeScriptModule from 'typescript';
import type { ModelAssetComponent, ModelScriptAsset } from '../../editor/model/components';
import type { ModelParameterValues } from '../../editor/model/modelParameters';
import { resolveRuntimeAssetUrl } from '../assets/editorAssetUrl';

type ExternalModelScriptInstance = {
  onStart?: () => void;
  onUpdate?: () => void;
  onStop?: () => void;
  [key: string]: unknown;
};

type ExternalModelScriptClass = new (node: TransformNode) => ExternalModelScriptInstance;

type CompiledExternalModelScript = {
  classes: Record<string, ExternalModelScriptClass | undefined>;
  dataDriven?: unknown;
};

type ImportBinding = {
  localName: string;
  importedName: string;
  source: 'babylon' | 'babylonNamespace' | 'decorator';
};

const DEFAULT_RUNTIME_CLASS_NAMES = [
  'default',
  'ParametricModelRuntimeComponent',
  'ModelRuntimeComponent',
  'RuntimeComponent',
];
const SCRIPT_IMPORT_PATTERN = /^\s*import\s+(type\s+)?(.+?)\s+from\s+["']([^"']+)["'];?\s*$/gm;
const VISIBLE_DECORATOR_PATTERN = /^\s*@visibleAs[A-Za-z]+\([^)]*\)\s*$/;
const compiledScriptCache = new Map<string, CompiledExternalModelScript>();
let typescriptModulePromise: Promise<typeof TypeScriptModule> | null = null;

/** 管理单个导入模型上的外置参数化脚本生命周期。 */
export class ExternalModelScriptRuntime {
  private readonly instances: ExternalModelScriptInstance[] = [];
  private readonly dataDrivenConfigs: unknown[] = [];
  private parameterValues: ModelParameterValues = {};
  private assetCode: string;
  private disposed = false;
  private started = false;

  /** 创建本地可信模型脚本运行器。 */
  constructor(
    private readonly node: TransformNode,
    private readonly modelAsset: ModelAssetComponent,
  ) {
    this.assetCode = modelAsset.assetCode;
  }

  /** 加载、转译并启动模型包内的运行脚本。 */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;

    for (const scriptAsset of this.modelAsset.scriptAssets ?? []) {
      await this.startScriptAsset(scriptAsset);
    }
  }

  /** 读取模型脚本导出的 dataDriven 配置，供遥测运行时按模型包声明查找运动节点。 */
  getDataDrivenConfigs(): readonly unknown[] {
    return this.dataDrivenConfigs;
  }

  /** 将 Inspector 参数实时注入所有已启动脚本实例。 */
  updateParameterValues(values: ModelParameterValues | undefined): void {
    this.parameterValues = values ? { ...values } : {};
    for (const instance of this.instances) {
      this.assignParameterValues(instance);
    }
  }

  /** 将当前导入模型实例资产编号注入脚本实例，供动画数据按实例识别。 */
  updateAssetCode(assetCode: string): void {
    this.assetCode = assetCode;
    for (const instance of this.instances) {
      this.assignParameterValues(instance);
    }
  }

  /** 触发脚本的增量刷新入口。 */
  update(): void {
    if (this.disposed) return;

    for (const instance of this.instances) {
      this.callLifecycle(instance, 'onUpdate');
    }
  }

  /** 停止脚本并恢复脚本自己维护的运行态资源。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const instance of [...this.instances].reverse()) {
      this.callLifecycle(instance, 'onStop');
    }
    this.instances.length = 0;
  }

  /** 启动单个 .model.ts 文件中声明的运行组件。 */
  private async startScriptAsset(scriptAsset: ModelScriptAsset): Promise<void> {
    try {
      const compiledScript = await loadCompiledExternalModelScript(scriptAsset);
      if (this.disposed) return;
      if (compiledScript.dataDriven !== undefined) {
        this.dataDrivenConfigs.push(compiledScript.dataDriven);
      }

      for (const className of this.getRuntimeClassNamesForAsset(scriptAsset)) {
        const ScriptClass = compiledScript.classes[className];
        if (!ScriptClass) continue;

        const instance = new ScriptClass(this.node);
        this.assignParameterValues(instance);
        this.instances.push(instance);
        this.callLifecycle(instance, 'onStart');
      }
    } catch (error) {
      console.warn(`模型脚本加载失败：${scriptAsset.name}`, error);
    }
  }

  /** 根据 meta.json 的 animationScripts 选择真正需要实例化的运行类。 */
  private getRuntimeClassNamesForAsset(scriptAsset: ModelScriptAsset): string[] {
    const names = new Set<string>();
    const metadata = Array.isArray(this.modelAsset.animationScriptMetadata)
      ? this.modelAsset.animationScriptMetadata
      : [];

    for (const item of metadata) {
      if (!isPlainObject(item) || typeof item.className !== 'string') continue;
      const scriptFilename = typeof item.scriptFilename === 'string' ? item.scriptFilename : '';
      if (!scriptFilename || scriptFilename.toLowerCase() === scriptAsset.name.toLowerCase()) {
        names.add(item.className);
      }
    }

    for (const fallbackName of DEFAULT_RUNTIME_CLASS_NAMES) {
      names.add(fallbackName);
    }

    return [...names];
  }

  /** 把当前参数值写到脚本实例属性上，兼容现有模型脚本的读取方式。 */
  private assignParameterValues(instance: ExternalModelScriptInstance): void {
    instance.assetCode = this.assetCode;
    for (const [key, value] of Object.entries(this.parameterValues)) {
      instance[key] = value;
    }
  }

  /** 调用脚本生命周期，避免单个脚本异常中断编辑器运行时。 */
  private callLifecycle(instance: ExternalModelScriptInstance, methodName: 'onStart' | 'onUpdate' | 'onStop'): void {
    try {
      instance[methodName]?.();
    } catch (error) {
      console.warn(`模型脚本生命周期执行失败：${methodName}`, error);
    }
  }
}

/** 加载并缓存已经转译好的外置脚本。 */
async function loadCompiledExternalModelScript(scriptAsset: ModelScriptAsset): Promise<CompiledExternalModelScript> {
  const sourceText = await fetchScriptText(scriptAsset);
  const cacheKey = `${scriptAsset.sourceUrl}:${hashText(sourceText)}`;
  const cachedScript = compiledScriptCache.get(cacheKey);
  if (cachedScript) return cachedScript;

  const compiledScript = await compileExternalModelScript(sourceText);
  compiledScriptCache.set(cacheKey, compiledScript);
  return compiledScript;
}

/** 从 editor-asset 协议读取模型包内的 TypeScript 源码。 */
async function fetchScriptText(scriptAsset: ModelScriptAsset): Promise<string> {
  const response = await fetch(resolveRuntimeAssetUrl(scriptAsset.sourceUrl));
  if (!response.ok) {
    throw new Error(`无法读取脚本：${response.status}`);
  }
  return response.text();
}

/** 将 .model.ts 转成可在 renderer 内执行的本地函数模块。 */
async function compileExternalModelScript(sourceText: string): Promise<CompiledExternalModelScript> {
  const ts = await loadTypeScriptCompiler();
  const { sourceWithoutImports, importPrelude } = createImportPrelude(sourceText);
  const sourceWithoutDecorators = stripVisibleDecorators(sourceWithoutImports);
  const exportTransform = removeTypeScriptExports(sourceWithoutDecorators);
  const preparedSource = `${importPrelude}\n${exportTransform.sourceText}`;
  const classNames = collectClassNames(preparedSource);
  const transpiled = ts.transpileModule(preparedSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      experimentalDecorators: true,
      useDefineForClassFields: false,
    },
  });

  const returnStatement = createReturnStatement(classNames, exportTransform.defaultClassName);
  const factory = new Function(
    '__babylon',
    '__decorator',
    `${transpiled.outputText}\n${returnStatement}`,
  ) as (babylon: typeof BabylonCore, decorator: () => PropertyDecorator) => CompiledExternalModelScript;

  return factory(BabylonCore, createNoopDecorator);
}

/** 延迟加载 TypeScript 编译器，避免 Electron 首屏启动时预构建整个 compiler 包。 */
function loadTypeScriptCompiler(): Promise<typeof TypeScriptModule> {
  typescriptModulePromise ??= import('typescript');
  return typescriptModulePromise;
}

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

/** 创建空装饰器函数，兼容 Babylon Editor 脚本的可见性装饰器。 */
function createNoopDecorator(): PropertyDecorator {
  return () => undefined;
}

/** 判断对象是否为普通 JSON 对象。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** 限制注入变量名为普通标识符，避免外置脚本 import 预处理注入代码。 */
function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(value);
}

/** 为脚本文本生成轻量缓存指纹。 */
function hashText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return `${value.length}:${hash}`;
}
