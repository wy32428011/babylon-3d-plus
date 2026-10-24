import * as decoder from '@babylonjs/ktx2decoder';
import { DefaultKTX2DecoderOptions, KhronosTextureContainer2 } from '@babylonjs/core/Misc/khronosTextureContainer2.js';
import type { Engine } from '@babylonjs/core/Engines/engine.js';
import type { IKTX2DecoderOptions, ICompressedFormatCapabilities } from '@babylonjs/core/Materials/Textures/ktx2decoderTypes.js';
import type { LocalKtx2DecoderUrls } from './ktx2DecoderConfiguration';
import { Ktx2DecodeWorkerPool, Ktx2WorkerInfrastructureError } from './ktx2DecodeWorkerPool';

const engineCapabilities = new WeakSet<object>();
const optionFacts = new WeakSet<object>();
const nativeInstances = new WeakMap<object, { manager: object }>();
const nativeClasses = [decoder.LiteTranscoder_UASTC_ASTC, decoder.LiteTranscoder_UASTC_BC7,
  decoder.LiteTranscoder_UASTC_RGBA_UNORM, decoder.LiteTranscoder_UASTC_RGBA_SRGB,
  decoder.LiteTranscoder_UASTC_R8_UNORM, decoder.LiteTranscoder_UASTC_RG8_UNORM, decoder.MSCTranscoder];
const nativeRegistry = decoder.TranscoderManager._Transcoders;
const initialOptions = decoder.KTX2Decoder.DefaultDecoderOptions;
const canonicalGetOptions = DefaultKTX2DecoderOptions.prototype._getKTX2DecoderOptions;
const canonicalInitialize = Object.getOwnPropertyDescriptor(KhronosTextureContainer2, '_Initialize')?.value;
const canonicalDecodeData = Object.getOwnPropertyDescriptor(decoder.KTX2Decoder.prototype, '_decodeDataAsync')?.value;
const canonicalDecode = decoder.KTX2Decoder.prototype.decode;
optionFacts.add(initialOptions);
let installed = false;
const metrics = { workers: 0, submitted: 0, completed: 0, mainThread: 0, infrastructureFallbacks: 0, lastFallback: null as string | null };

/** 只登记应用刚创建的实际Engine caps，不对外部decoder调用的未知capability对象做额外读取。 */
export function registerKtx2WorkerEngine(engine: Engine): void { engineCapabilities.add(engine.getCaps()); }
export function getLocalKtx2DecodeDiagnostics() { return { ...metrics, installed }; }

// 这些对象由引擎原函数的新literal产生；只登记其内建decision tree，不认证调用方的bypass数组。
function registerOptions(options: IKTX2DecoderOptions): void {
  optionFacts.add(options);
  const tree = Object.getOwnPropertyDescriptor(options, 'transcodeFormatDecisionTree')?.value;
  if (tree) {
    optionFacts.add(tree);
    const branch = Object.getOwnPropertyDescriptor(tree, 'UASTC')?.value;
    if (branch) {
      optionFacts.add(branch);
      const formats = Object.getOwnPropertyDescriptor(branch, 'transcodeFormat')?.value;
      const yes = Object.getOwnPropertyDescriptor(branch, 'yes')?.value;
      if (Array.isArray(formats)) optionFacts.add(formats);
      if (yes) optionFacts.add(yes);
    }
  }
}

type Shape = { object: object; prototype: object | null; entries: Map<PropertyKey, PropertyDescriptor> };
function captureShape(object: object): Shape {
  return { object, prototype: Object.getPrototypeOf(object), entries: new Map(Reflect.ownKeys(object).map(key => [key, Object.getOwnPropertyDescriptor(object, key)!])) };
}
function sameShape(shape: Shape): boolean {
  if (Object.getPrototypeOf(shape.object) !== shape.prototype || Reflect.ownKeys(shape.object).length !== shape.entries.size) return false;
  for (const [key, expected] of shape.entries) {
    const actual = Object.getOwnPropertyDescriptor(shape.object, key);
    if (!actual || actual.value !== expected.value || actual.get !== expected.get || actual.set !== expected.set
      || actual.enumerable !== expected.enumerable || actual.writable !== expected.writable || actual.configurable !== expected.configurable) return false;
  }
  return true;
}
const typedArrayShape = captureShape(Object.getPrototypeOf(Uint8Array.prototype));
const byteArrayShape = captureShape(Uint8Array.prototype);

const unsupported = Symbol('unsupported');
/** 私有已认证对象允许反射；未知引用先返回，不能为了审计再执行脚本getter/Proxy。 */
function copyOptionFacts(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || ['undefined', 'boolean', 'number', 'string'].includes(typeof value)) return value;
  if (typeof value !== 'object' || !optionFacts.has(value) || ancestors.has(value)) return unsupported;
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype)) return unsupported;
  const result: unknown[] | Record<string, unknown> = array ? [] : {};
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable) continue;
    if (typeof key !== 'string' || !('value' in descriptor)) { ancestors.delete(value); return unsupported; }
    const copied = copyOptionFacts(descriptor.value, ancestors);
    if (copied === unsupported) { ancestors.delete(value); return unsupported; }
    Object.defineProperty(result, key, { value: copied, enumerable: true, configurable: true, writable: true });
  }
  ancestors.delete(value);
  return result;
}

/**
 * 把缓存未命中的标准执行器移到本地worker。发布缓存仍包裹同一个decode入口，
 * 原始缓存key、GPU能力/选项与热缓存行为保持；自定义选项/注册器回原执行器。
 */
export function installLocalKtx2WorkerDecoder(urls: LocalKtx2DecoderUrls): void {
  if (installed || typeof Worker !== 'function') return;
  installed = true;
  const hardware = typeof navigator === 'object' ? navigator.hardwareConcurrency : 2;
  metrics.workers = Math.min(4, Math.max(1, Math.floor((hardware || 2) / 2)));
  const pool = new Ktx2DecodeWorkerPool(urls, metrics.workers);
  const nativeDecode = decoder.KTX2Decoder.prototype.decode;
  // 原初始化器也会设置这两个主线程开关；提前固定后再记录私有库形状。
  decoder.MSCTranscoder.UseFromWorkerThread = false;
  decoder.WASMMemoryManager.LoadBinariesFromCurrentThread = true;
  const libraryShapes: Shape[] = [];
  const visited = new Set<object>();
  for (const type of [...nativeClasses, decoder.WASMMemoryManager, decoder.ZSTDDecoder, decoder.KTX2FileReader, decoder.DataReader]) {
    for (const start of [type, type.prototype]) for (let object: object | null = start; object && !visited.has(object); object = Object.getPrototypeOf(object)) {
      visited.add(object); libraryShapes.push(captureShape(object));
    }
  }
  libraryShapes.push(captureShape(decoder.TranscoderManager.prototype));
  const originalInstances = Object.getOwnPropertyDescriptor(decoder.TranscoderManager, '_TranscoderInstances')?.value;
  const initializer = Object.getOwnPropertyDescriptor(KhronosTextureContainer2, '_Initialize');
  if (initializer?.value === canonicalInitialize) Object.defineProperty(KhronosTextureContainer2, '_Initialize', { ...initializer,
    value: function(...args: unknown[]) {
      const before = Object.getOwnPropertyDescriptor(KhronosTextureContainer2, '_DecoderModulePromise')?.value;
      const result = Reflect.apply(canonicalInitialize, this, args);
      const module = Object.getOwnPropertyDescriptor(KhronosTextureContainer2, '_KTX2DecoderModule')?.value;
      const promise = Object.getOwnPropertyDescriptor(KhronosTextureContainer2, '_DecoderModulePromise')?.value;
      // 此Promise与实例都由原初始化器新建；登记continuation早于其后upload的await，不加热路径微任务。
      if (this === KhronosTextureContainer2 && before === undefined && module === decoder && promise instanceof Promise) {
        void promise.then(instance => {
          const manager = Object.getOwnPropertyDescriptor(instance, '_transcoderMgr')?.value;
          if (manager) nativeInstances.set(instance, { manager });
        }, () => {});
      }
      return result;
    } });
  const engineOptions = KhronosTextureContainer2.DefaultDecoderOptions;
  const nativeGetOptions = engineOptions._getKTX2DecoderOptions;
  if (nativeGetOptions === canonicalGetOptions) engineOptions._getKTX2DecoderOptions = function() {
    // 只有原对象的dirty=true分支会新建literal；其它接收者及缓存返回不增加认证。
    const createsFacts = this === engineOptions && Object.getOwnPropertyDescriptor(this, '_isDirty')?.value === true;
    const options = nativeGetOptions.call(this);
    if (createsFacts) registerOptions(options);
    return options;
  };
  decoder.KTX2Decoder.prototype.decode = function(data, capabilities, options) {
    const direct = () => { metrics.mainThread++; return nativeDecode.call(this, data, capabilities, options); };
    const instance = nativeInstances.get(this);
    if (nativeDecode !== canonicalDecode || options !== undefined || !instance || !engineCapabilities.has(capabilities) || !ArrayBuffer.isView(data)
      || Object.getPrototypeOf(this) !== decoder.KTX2Decoder.prototype
      || Object.getPrototypeOf(decoder.KTX2Decoder.prototype) !== Object.prototype
      || Object.hasOwn(decoder.KTX2Decoder.prototype, '_zstdDecoder')
      || Object.getPrototypeOf(data) !== Uint8Array.prototype
      || !sameShape(typedArrayShape) || !sameShape(byteArrayShape)
      || Object.hasOwn(this, '_decodeDataAsync') || Object.hasOwn(this, '_zstdDecoder')
      || Object.getOwnPropertyDescriptor(this, '_transcoderMgr')?.value !== instance.manager
      || Object.getPrototypeOf(instance.manager) !== decoder.TranscoderManager.prototype
      || Object.hasOwn(instance.manager, 'findTranscoder') || Object.hasOwn(instance.manager, '_getExistingTranscoder')
      || Object.hasOwn(instance.manager, '_wasmMemoryManager')
      || Object.getOwnPropertyDescriptor(decoder.KTX2Decoder.prototype, '_decodeDataAsync')?.value !== canonicalDecodeData
      || Object.getOwnPropertyDescriptor(decoder.TranscoderManager, '_Transcoders')?.value !== nativeRegistry
      || nativeRegistry.length !== nativeClasses.length
      || nativeClasses.some((type, index) => Object.getOwnPropertyDescriptor(nativeRegistry, String(index))?.value !== type)
      || !libraryShapes.every(sameShape)
      || Object.getOwnPropertyDescriptor(decoder.TranscoderManager, '_TranscoderInstances')?.value !== originalInstances
      || !originalInstances || Object.getPrototypeOf(originalInstances) !== Object.prototype || Reflect.ownKeys(originalInstances).length) return direct();
    const defaultOptions = Object.getOwnPropertyDescriptor(decoder.KTX2Decoder, 'DefaultDecoderOptions');
    if (!defaultOptions || !('value' in defaultOptions)) return direct();
    const facts = copyOptionFacts(defaultOptions.value);
    if (facts === unsupported) return direct();
    const caps: ICompressedFormatCapabilities = {};
    for (const name of ['astc', 'bptc', 's3tc', 'pvrtc', 'etc2', 'etc1'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(capabilities, name);
      if (!descriptor || !('value' in descriptor)) return direct();
      caps[name] = !!descriptor.value;
    }
    for (const name of ['buffer', 'byteOffset', 'byteLength'] as const) if (Object.hasOwn(data, name)) return direct();
    if (!(data.buffer instanceof ArrayBuffer)) return direct();
    metrics.submitted++;
    return pool.decode({ data, caps, options: facts as IKTX2DecoderOptions }).then(result => { metrics.completed++; return result; }, error => {
      if (!(error instanceof Ktx2WorkerInfrastructureError)) throw error;
      metrics.infrastructureFallbacks++; metrics.lastFallback = error.message;
      if (metrics.infrastructureFallbacks === 1) console.warn('[Babylon] 本地KTX2 worker初始化或传输失败，回到本地主线程执行器。', error);
      return direct();
    });
  };
  globalThis.addEventListener?.('pagehide', () => pool.dispose(), { once: true });
}
