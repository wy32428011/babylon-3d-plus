import { resolveBabylonScriptRuntimeNamespace, type BabylonScriptRuntimeNamespace } from './babylonScriptRuntimeNamespace.js';
import { digestModelScriptText, normalizePrecompiledModelScript, prepareModelScriptCompilation, MODEL_SCRIPT_CACHE_MAX_BYTES } from '../../../electron/shared/modelScriptCompilation.js';
import { fetchRuntimeAsset } from '../assets/runtimeAssetFetch';
import type { TransformNode } from '@babylonjs/core';
import type * as TypeScriptModule from 'typescript';
import type { ModelAssetComponent, ModelScriptAsset } from '../../editor/model/components';
import type { ModelParameterDefinition, ModelParameterValue, ModelParameterValues } from '../../editor/model/modelParameters';
import { resolveModelTextureAssetUrl } from '../assets/modelTextureAssetUrl';
import { resolveRuntimeAssetUrl } from '../assets/editorAssetUrl';
import { readUtf8ResponseText } from '../../shared/text/strictUtf8';
import { modelInitializationScheduler } from './modelInitializationScheduler';

type ExternalModelScriptInstance = {
  onStart?: () => void;
  onUpdate?: () => void;
  onStop?: () => void;
  [key: string]: unknown;
};

/** 外置模型脚本运行模式，编辑态只响应参数，运行态可读取遥测快照。 */
export type ExternalModelScriptRuntimeMode = 'edit' | 'runtime';

/** 注入到外置模型脚本实例的只读遥测快照，避免脚本直接依赖 MQTT store。 */
export type ExternalModelScriptTelemetrySnapshot = {
  deviceType: string;
  assetCode: string;
  faulted: boolean;
  fields: Record<string, unknown>;
};

/** 外置模型脚本运行时上下文，SceneRuntime 负责按预览生命周期更新。 */
export type ExternalModelScriptRuntimeContext = {
  mode: ExternalModelScriptRuntimeMode;
  telemetry: ExternalModelScriptTelemetrySnapshot | null;
};

type ExternalModelScriptClass = new (node: TransformNode) => ExternalModelScriptInstance;

type CompiledExternalModelScript = {
  classes: Record<string, ExternalModelScriptClass | undefined>;
  dataDriven?: unknown;
  initializationError?: string;
};

const DEFAULT_RUNTIME_CLASS_NAMES = [
  'default',
  'ParametricModelRuntimeComponent',
  'ModelRuntimeComponent',
  'RuntimeComponent',
];
const sourceHashRequests = new Map<string, Promise<string>>();
const compiledScriptCache = new Map<string, CompiledExternalModelScript>();
const scriptTextRequests = new Map<string, Promise<string>>();
const compiledScriptRequests = new Map<string, Promise<CompiledExternalModelScript>>();
const scriptLoadDiagnostics = { readRequests: 0, sharedReads: 0, compileRequests: 0, sharedCompiles: 0,
  precompiledHits: 0, compilerFallbacks: 0, compiledCacheHits: 0, compileElapsedMs: 0, initializationCount: 0, initializationQueueMs: 0,
  initializationMs: 0, maxInitializationMs: 0, cancelledInitializations: 0 };
let typescriptModulePromise: Promise<typeof TypeScriptModule> | null = null;

/** 只读 renderer 会话计数；编译耗时包含首次等待 TypeScript 模块的时间。 */
export function getExternalModelScriptLoadDiagnostics() {
  return Object.freeze({ scope: 'renderer-session' as const, ...scriptLoadDiagnostics,
    pendingReads: scriptTextRequests.size, pendingCompiles: compiledScriptRequests.size,
    cachedCompiles: compiledScriptCache.size });
}

/** 管理单个导入模型上的外置参数化脚本生命周期。 */
export class ExternalModelScriptRuntime {
  private readonly instances: ExternalModelScriptInstance[] = [];
  private readonly dataDrivenConfigs: unknown[] = [];
  private parameterValues: ModelParameterValues = {};
  private assetCode: string;
  private runtimeContext: ExternalModelScriptRuntimeContext = { mode: 'edit', telemetry: null };
  private disposed = false;
  private started = false;
  private initializationError: string | null = null;

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

  /** 严格场景同步读取已被本地容错捕获的错误；同一脚本运行代次保留首次失败。 */
  getInitializationError(): string | null {
    return this.initializationError;
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

  /** 更新脚本运行时上下文，固定注入 runtimeMode 与 runtimeTelemetry 给所有实例。 */
  updateRuntimeContext(context: ExternalModelScriptRuntimeContext): void {
    this.runtimeContext = {
      mode: context.mode,
      telemetry: context.telemetry
        ? {
            deviceType: context.telemetry.deviceType,
            assetCode: context.telemetry.assetCode,
            faulted: context.telemetry.faulted,
            fields: { ...context.telemetry.fields },
          }
        : null,
    };
    for (const instance of this.instances) {
      this.assignParameterValues(instance);
      this.callLifecycle(instance, 'onUpdate');
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

  /** 启动单个 TypeScript 模型脚本中声明的运行组件。 */
  private async startScriptAsset(scriptAsset: ModelScriptAsset): Promise<void> {
    try {
      const compiledScript = await loadCompiledExternalModelScript(scriptAsset, this.modelAsset.assetRevision);
      if (this.disposed) return;
      this.initializationError ??= compiledScript.initializationError ?? null;
      if (compiledScript.dataDriven !== undefined) {
        this.dataDrivenConfigs.push(compiledScript.dataDriven);
      }

      const queuedAt = performance.now();
      await modelInitializationScheduler.run(() => {
        if (this.disposed) { scriptLoadDiagnostics.cancelledInitializations += 1; return; }
        const startedAt = performance.now();
        scriptLoadDiagnostics.initializationQueueMs += startedAt - queuedAt;
        try {
          for (const className of this.getRuntimeClassNamesForAsset(scriptAsset)) {
            const ScriptClass = compiledScript.classes[className];
            if (!ScriptClass) continue;

            const instance = new ScriptClass(this.node);
            this.assignParameterValues(instance);
            this.instances.push(instance);
            this.callLifecycle(instance, 'onStart');
          }
        } finally {
          const elapsed = performance.now() - startedAt;
          scriptLoadDiagnostics.initializationCount += 1;
          scriptLoadDiagnostics.initializationMs += elapsed;
          scriptLoadDiagnostics.maxInitializationMs = Math.max(scriptLoadDiagnostics.maxInitializationMs, elapsed);
        }
      });
    } catch (error) {
      if (!this.disposed) {
        this.initializationError ??= `脚本 ${scriptAsset.name} 加载失败：${error instanceof Error ? error.message : String(error)}`;
      }
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

  /** 把当前参数值和运行上下文写到脚本实例属性上，兼容现有模型脚本的读取方式。 */
  private assignParameterValues(instance: ExternalModelScriptInstance): void {
    for (const [key, value] of Object.entries(this.parameterValues)) {
      instance[key] = this.resolveParameterInjectionValue(key, value);
    }
    instance.assetCode = this.assetCode;
    instance.runtimeMode = this.runtimeContext.mode;
    instance.runtimeTelemetry = this.runtimeContext.telemetry;
  }

  /** 解析单个参数的脚本注入值，贴图参数会转换为 Babylon 可直接读取的真实 URL。 */
  private resolveParameterInjectionValue(key: string, value: ModelParameterValue): ModelParameterValue {
    const definition = this.findParameterDefinition(key);
    if (definition?.type !== 'texture' || typeof value !== 'string') return value;

    return resolveModelTextureAssetUrl(value, {
      sourceUrl: this.modelAsset.sourceUrl,
      assetRevision: this.modelAsset.assetRevision,
    }) ?? value;
  }

  /** 按参数 key 查找模型包声明，用于区分普通字符串和贴图逻辑引用。 */
  private findParameterDefinition(key: string): ModelParameterDefinition | null {
    return this.modelAsset.parameterConfig?.parameters.find((definition) => definition.key === key) ?? null;
  }

  /** 调用脚本生命周期，避免单个脚本异常中断编辑器运行时。 */
  private callLifecycle(instance: ExternalModelScriptInstance, methodName: 'onStart' | 'onUpdate' | 'onStop'): void {
    try {
      instance[methodName]?.();
    } catch (error) {
      if (!this.disposed && methodName !== 'onStop') {
        this.initializationError ??= `脚本 ${methodName} 失败：${error instanceof Error ? error.message : String(error)}`;
      }
      console.warn(`模型脚本生命周期执行失败：${methodName}`, error);
    }
  }
}

/** 加载并缓存已经转译好的外置脚本。 */
async function loadCompiledExternalModelScript(
  scriptAsset: ModelScriptAsset,
  assetRevision: string | undefined,
): Promise<CompiledExternalModelScript> {
  const sourceText = await fetchScriptText(scriptAsset, assetRevision);
  let hashRequest = sourceHashRequests.get(sourceText);
  if (!hashRequest) {
    hashRequest = digestModelScriptText(sourceText);
    sourceHashRequests.set(sourceText, hashRequest);
    if (sourceHashRequests.size > 128) sourceHashRequests.delete(sourceHashRequests.keys().next().value!);
  }
  const sourceHash = await hashRequest;
  const cacheKey = `${scriptAsset.sourceUrl}:${sourceHash}`;
  const cachedScript = compiledScriptCache.get(cacheKey);
  if (cachedScript) {
    scriptLoadDiagnostics.compiledCacheHits += 1;
    return cachedScript;
  }
  const pending = compiledScriptRequests.get(cacheKey);
  if (pending) {
    scriptLoadDiagnostics.sharedCompiles += 1;
    return pending;
  }

  // 首次 compiler import 会让多个实例同时等待，在 await 前登记任务才可避免重复转译。
  scriptLoadDiagnostics.compileRequests += 1;
  const startedAt = performance.now();
  const request = compileExternalModelScript(sourceText, scriptAsset, assetRevision, sourceHash);
  compiledScriptRequests.set(cacheKey, request);
  try {
    const compiledScript = await request;
    compiledScriptCache.set(cacheKey, compiledScript);
    return compiledScript;
  } finally {
    if (compiledScriptRequests.get(cacheKey) === request) compiledScriptRequests.delete(cacheKey);
    scriptLoadDiagnostics.compileElapsedMs += Math.max(0, performance.now() - startedAt);
  }
}

/** 从 editor-asset 协议读取模型包内的 TypeScript 源码。 */
async function fetchScriptText(scriptAsset: ModelScriptAsset, assetRevision: string | undefined): Promise<string> {
  const url = createVersionedRuntimeAssetUrl(scriptAsset.sourceUrl, assetRevision);
  const pending = scriptTextRequests.get(url);
  if (pending) {
    scriptLoadDiagnostics.sharedReads += 1;
    return pending;
  }
  scriptLoadDiagnostics.readRequests += 1;
  const request = (async () => {
    const response = await fetchRuntimeAsset(url);
    if (!response.ok) throw new Error(`无法读取脚本：${response.status}`);
    return readUtf8ResponseText(response, `模型脚本 ${scriptAsset.name}`);
  })();
  scriptTextRequests.set(url, request);
  try {
    return await request;
  } finally {
    // 只合并进行中的读取；后续请求仍可发现未版本化脚本的修改，失败也可再次读取。
    if (scriptTextRequests.get(url) === request) scriptTextRequests.delete(url);
  }
}

/** 外置脚本跟随模型包导入版本追加查询参数，避免重新导入后仍读取旧脚本文本。 */
function createVersionedRuntimeAssetUrl(sourceUrl: string, assetRevision: string | undefined): string {
  const runtimeUrl = resolveRuntimeAssetUrl(sourceUrl);
  if (!assetRevision) return runtimeUrl;

  const separator = runtimeUrl.includes('?') ? '&' : '?';
  return `${runtimeUrl}${separator}assetRevision=${encodeURIComponent(assetRevision)}`;
}

/** 只从既有授权协议或 Viewer 资源读取派生产物，绝不执行 scene 内的 inline code。 */
async function fetchPrecompiledModelScript(scriptAsset: ModelScriptAsset, assetRevision: string | undefined): Promise<unknown> {
  const sourceUrl = createVersionedRuntimeAssetUrl(scriptAsset.sourceUrl, assetRevision);
  const local = sourceUrl.startsWith('editor-asset://local/') || sourceUrl.startsWith('/__editor_asset__/');
  const suffix = sourceUrl.search(/[?#]/);
  const url = local
    ? sourceUrl + (sourceUrl.includes('?') ? '&' : '?') + 'modelScriptCompiled=1'
    : (suffix < 0 ? sourceUrl + '.compiled.json' : sourceUrl.slice(0, suffix) + '.compiled.json' + sourceUrl.slice(suffix));
  try {
    const response = await fetchRuntimeAsset(url, undefined, undefined, MODEL_SCRIPT_CACHE_MAX_BYTES);
    if (!response.ok) return undefined;
    return JSON.parse(await readUtf8ResponseText(response, '模型脚本预转译缓存'));
  } catch {
    // 旧包、开发服务器或损坏派生缓存不阻断已经授权的原 TS 兼容读取。
    return undefined;
  }
}

/** 将 TypeScript 模型脚本转成可在 renderer 内执行的本地函数模块。 */
async function compileExternalModelScript(
  sourceText: string,
  scriptAsset: ModelScriptAsset,
  assetRevision: string | undefined,
  sourceHash: string,
): Promise<CompiledExternalModelScript> {
  const cached = normalizePrecompiledModelScript(await fetchPrecompiledModelScript(scriptAsset, assetRevision));
  let code: string;
  let initializationError: string | undefined;
  if (cached && cached.sourceSha256 === sourceHash && await digestModelScriptText(cached.code) === cached.codeSha256) {
    code = cached.code;
    initializationError = cached.initializationError;
    scriptLoadDiagnostics.precompiledHits += 1;
  } else {
    // 旧工程和开发期裸 TS 保持可用；新导入/导出脚本优先使用 Node 生成的缓存。
    scriptLoadDiagnostics.compilerFallbacks += 1;
    const ts = await loadTypeScriptCompiler();
    const prepared = prepareModelScriptCompilation(sourceText);
    const transpiled = ts.transpileModule(prepared.sourceText, {
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None,
        experimentalDecorators: true, useDefineForClassFields: false,
      },
    });
    code = transpiled.outputText + '\n' + prepared.returnStatement;
    const diagnostic = transpiled.diagnostics?.find(item => item.file && item.category === ts.DiagnosticCategory.Error);
    initializationError = diagnostic ? ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') : undefined;
  }
  const babylon = await resolveBabylonScriptRuntimeNamespace(sourceText);
  const factory = new Function('__babylon', '__decorator', code) as (
    babylon: BabylonScriptRuntimeNamespace, decorator: () => PropertyDecorator,
  ) => CompiledExternalModelScript;
  return { ...factory(babylon, createNoopDecorator), ...(initializationError ? { initializationError } : {}) };
}

/** 延迟加载 TypeScript 编译器，避免 Electron 首屏启动时预构建整个 compiler 包。 */
function loadTypeScriptCompiler(): Promise<typeof TypeScriptModule> {
  typescriptModulePromise ??= import('typescript');
  return typescriptModulePromise;
}

/** 创建空装饰器函数，兼容 Babylon Editor 脚本的可见性装饰器。 */
function createNoopDecorator(): PropertyDecorator {
  return () => undefined;
}

/** 判断对象是否为普通 JSON 对象。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
