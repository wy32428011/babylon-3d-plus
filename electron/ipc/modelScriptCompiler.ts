import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type * as TypeScriptModule from 'typescript';
import { promises as fs, readFileSync } from 'node:fs';
import { decodeUtf8Text } from '../shared/strictUtf8.js';
import { MODEL_SCRIPT_COMPILATION_FORMAT, prepareModelScriptCompilation, serializePrecompiledModelScript, type PrecompiledModelScript } from '../shared/modelScriptCompilation.ts';
import { openModelScriptPersistentCache, type ModelScriptCacheKeyProtection, type ModelScriptPersistentCache } from './modelScriptPersistentCache.ts';

/** 预处理规则或编译选项改变时必须更新；与 TypeScript 实际安装版本共同隔离产物。 */
export const MODEL_SCRIPT_COMPILATION_CACHE_VERSION = 'preprocess-v1-es2020-none-decorators-definefalse';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const compilerVersion = (JSON.parse(readFileSync(createRequire(import.meta.url).resolve('typescript/package.json'), 'utf8')) as { version: string }).version;

/** 源码授权由文件调用方维持；编译器只处理已读取文本，不执行模型脚本。 */
export class ModelScriptCompiler {
  private readonly compiled = new Map<string, { artifact: PrecompiledModelScript; bytes: number }>();
  private readonly inFlight = new Map<string, Promise<PrecompiledModelScript>>();
  private compilerRequest: Promise<typeof TypeScriptModule> | null = null;
  private memoryBytes = 0;
  private readonly metrics = { memoryHits: 0, persistentHits: 0, compilations: 0, compilerLoads: 0 };

  constructor(private readonly options: {
    cache?: () => Promise<ModelScriptPersistentCache | null>;
    loadCompiler?: () => Promise<typeof TypeScriptModule>;
    compilerVersion?: string;
    compilationVersion?: string;
  } = {}) {}

  getMetrics() { return { ...this.metrics, memoryEntries: this.compiled.size, memoryBytes: this.memoryBytes, inFlight: this.inFlight.size }; }

  /** 单个等待者取消不会破坏同内容的其它导入；已开始的同步 transpile 不可抢占。 */
  precompile(sourceText: string, signal?: AbortSignal): Promise<PrecompiledModelScript> {
    if (signal?.aborted) return Promise.reject(new DOMException('模型脚本转译已取消。', 'AbortError'));
    const sourceSha256 = sha256(sourceText);
    const existing = this.compiled.get(sourceSha256);
    if (existing) {
      this.metrics.memoryHits++;
      this.compiled.delete(sourceSha256); this.compiled.set(sourceSha256, existing);
      return this.wait(Promise.resolve(existing.artifact), signal);
    }
    let request = this.inFlight.get(sourceSha256);
    if (!request) {
      request = this.compile(sourceText, sourceSha256).then(artifact => {
        const bytes = Buffer.byteLength(serializePrecompiledModelScript(artifact));
        this.compiled.set(sourceSha256, { artifact, bytes }); this.memoryBytes += bytes;
        while (this.compiled.size > 128 || this.memoryBytes > 64 * 1024 * 1024) {
          const key = this.compiled.keys().next().value!;
          this.memoryBytes -= this.compiled.get(key)!.bytes; this.compiled.delete(key);
        }
        return artifact;
      }).finally(() => { this.inFlight.delete(sourceSha256); });
      this.inFlight.set(sourceSha256, request);
    }
    return this.wait(request, signal);
  }

  private async compile(sourceText: string, sourceSha256: string): Promise<PrecompiledModelScript> {
    const identity = { sourceSha256, compilerVersion: this.options.compilerVersion ?? compilerVersion,
      compilationVersion: this.options.compilationVersion ?? MODEL_SCRIPT_COMPILATION_CACHE_VERSION };
    const cache = await this.options.cache?.().catch(() => null);
    const cached = await cache?.read(identity).catch(() => undefined);
    if (cached) { this.metrics.persistentHits++; return cached; }
    if (!this.compilerRequest) {
      this.metrics.compilerLoads++;
      this.compilerRequest = (this.options.loadCompiler?.() ?? import('typescript')).catch(error => { this.compilerRequest = null; throw error; });
    }
    const ts = await this.compilerRequest;
    const prepared = prepareModelScriptCompilation(sourceText);
    const result = ts.transpileModule(prepared.sourceText, {
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None,
        experimentalDecorators: true, useDefineForClassFields: false },
    });
    this.metrics.compilations++;
    const diagnostic = result.diagnostics?.find(item => item.file && item.category === ts.DiagnosticCategory.Error);
    const code = result.outputText + '\n' + prepared.returnStatement;
    const artifact: PrecompiledModelScript = { format: MODEL_SCRIPT_COMPILATION_FORMAT, sourceSha256,
      codeSha256: sha256(code), compilerVersion: ts.version, code,
      ...(diagnostic ? { initializationError: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') } : {}) };
    serializePrecompiledModelScript(artifact);
    await cache?.write(identity, artifact).catch(() => undefined);
    return Object.freeze(artifact);
  }

  private wait(request: Promise<PrecompiledModelScript>, signal?: AbortSignal): Promise<PrecompiledModelScript> {
    if (!signal) return request;
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(new DOMException('模型脚本转译已取消。', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      request.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
      if (signal.aborted) abort();
    });
  }
}

let persistentCache: Promise<ModelScriptPersistentCache | null> = Promise.resolve(null);
let persistentCacheState: 'disabled-unavailable' | 'opening' | 'ready' | 'disabled-failed' = 'disabled-unavailable';
const compiler = new ModelScriptCompiler({ cache: () => persistentCache });

/** 仅主进程传入自身 userData 根与 safeStorage；不可用时保留内存转译与原 TS 路径。 */
export function configureModelScriptPersistentCache(root: string, protection?: ModelScriptCacheKeyProtection): void {
  persistentCacheState = protection ? 'opening' : 'disabled-unavailable';
  persistentCache = protection ? openModelScriptPersistentCache(root, protection).then(cache => {
    persistentCacheState = 'ready'; return cache;
  }).catch(() => {
    persistentCacheState = 'disabled-failed';
    console.warn('[Model script cache] 本机持久缓存不可用，继续使用源码与内存转译。');
    return null;
  }) : Promise.resolve(null);
  if (!protection) console.warn('[Model script cache] 系统安全存储不可用，继续使用源码与内存转译。');
}

export function getModelScriptCompilerMetrics() { return { ...compiler.getMetrics(), persistentCacheState }; }

/** 只读取受调用方授权的脚本文件；每次重读原字节，不以路径或缓存自报摘要替代授权。 */
export async function precompileModelScriptFile(filePath: string, signal?: AbortSignal): Promise<PrecompiledModelScript & { sourceFileSha256: string }> {
  const bytes = await fs.readFile(filePath, { signal });
  const artifact = await precompileModelScript(decodeUtf8Text(bytes, '模型脚本'), signal);
  const fileArtifact = { ...artifact, sourceFileSha256: createHash('sha256').update(bytes).digest('hex') };
  serializePrecompiledModelScript(fileArtifact);
  return fileArtifact;
}

export function precompileModelScript(sourceText: string, signal?: AbortSignal): Promise<PrecompiledModelScript> {
  return compiler.precompile(sourceText, signal);
}
