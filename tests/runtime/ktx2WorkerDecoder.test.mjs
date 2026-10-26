import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as decoder from '@babylonjs/ktx2decoder';
import { KTX2FileReader } from '@babylonjs/ktx2decoder/ktx2FileReader.js';
import { DataReader } from '@babylonjs/ktx2decoder/Misc/dataReader.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { DefaultKTX2DecoderOptions, KhronosTextureContainer2 } from '@babylonjs/core/Misc/khronosTextureContainer2.js';
import { createP4SsrTestModules } from '../helpers/p4SsrTestModules.mjs';

const originalDecode = decoder.KTX2Decoder.prototype.decode;
const capNames = ['astc', 'bptc', 's3tc', 'pvrtc', 'etc2', 'etc1'];
// 仅红见证选择输出目录中的冻结副本；正常命令始终加载真实产品入口，不增加产品测试接口。
const entry = process.env.KTX2_WORKER_DECODER_TEST_ENTRY ?? '/src/runtime/babylon/ktx2WorkerDecoder.ts';
const malformed = () => new Uint8Array(12);

// 自有4x4 UASTC KTX2头、DFD和一层16字节payload，实际9.12 parser读取；本测试不执行GPU或WASM转码。
function parseableKtx2(supercompression = 0) {
  const data = new Uint8Array(164), view = new DataView(data.buffer);
  data.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fields = [0, 1, 4, 4, 0, 0, 1, 1, supercompression, 104, 44, 0, 0];
  fields.forEach((value, index) => view.setUint32(12 + index * 4, value, true));
  view.setBigUint64(80, 148n, true); view.setBigUint64(88, 16n, true); view.setBigUint64(96, 16n, true);
  view.setUint32(104, 44, true); view.setUint16(112, 2, true); view.setUint16(114, 40, true);
  data.set([166, 1, 1, 0, 3, 3, 0, 0, 16], 116); data[134] = 127; data[135] = 3;
  view.setUint32(144, 0xffffffff, true);
  return data;
}
function saveProperty(object, name) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  return () => { if (descriptor) Object.defineProperty(object, name, descriptor); else delete object[name]; };
}
const outcome = promise => Promise.resolve(promise).then(value => ({ value }), error => ({ error }));
const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

async function fixture(context, { autoInit = true, customDecode } = {}) {
  const restorers = [], workers = [], pagehide = [], network = [];
  for (const [object, names] of [
    [decoder.KTX2Decoder, ['DefaultDecoderOptions']], [decoder.KTX2Decoder.prototype, ['decode', '_decodeDataAsync']],
    [decoder.TranscoderManager, ['_Transcoders', '_TranscoderInstances']],
    [decoder.MSCTranscoder, ['UseFromWorkerThread']], [decoder.WASMMemoryManager, ['LoadBinariesFromCurrentThread']],
    [decoder.ZSTDDecoder.prototype, ['init']],
    [KTX2FileReader.prototype, ['isValid']], [DataReader.prototype, ['readUint32']],
    [KhronosTextureContainer2, ['_Initialize', '_DecoderModulePromise', '_WorkerPoolPromise', '_KTX2DecoderModule', 'DefaultDecoderOptions', 'DefaultNumWorkers']],
    [globalThis, ['Worker', 'navigator', 'KTX2DECODER', 'addEventListener', 'fetch']],
  ]) for (const name of names) restorers.push(saveProperty(object, name));
  let modules = null, engine = null, caps = null, capsDescriptors = null, capsPrototype = null;
  context.after(async () => {
    pagehide.forEach(close => close());
    if (caps) { for (const key of Reflect.ownKeys(caps)) if (!Object.hasOwn(capsDescriptors, key)) delete caps[key]; Object.defineProperties(caps, capsDescriptors); Object.setPrototypeOf(caps, capsPrototype); }
    engine?.dispose();
    restorers.reverse().forEach(restore => restore());
    await modules?.close();
  });
  class FakeWorker extends EventTarget {
    requests = []; terminated = false; readySent = false; lastError = null;
    constructor(url) { super(); this.url = String(url); workers.push(this); }
    postMessage(message, transfer = []) {
      // 使用真实structuredClone/transfer验证buffer所有权；转码末端以parser结果替代，并明确不证明GPU。
      const copy = structuredClone(message, { transfer }); this.requests.push(copy);
      if (copy.action === 'init' && autoInit) queueMicrotask(() => this.ready());
      if (copy.action === 'decode') queueMicrotask(() => {
        if (this.terminated) return;
        try {
          const reader = new KTX2FileReader(copy.data);
          if (!reader.isValid()) throw new Error('Invalid KT2 file: wrong signature');
          reader.parse();
          this.message({ action: 'decoded', success: true, decodedData: { width: reader.header.pixelWidth, height: reader.header.pixelHeight,
            transcodedFormat: 32856, isInGammaSpace: reader.isInGammaSpace, hasAlpha: reader.hasAlpha, transcoderName: 'FakeWorker-native-parser',
            caps: copy.caps, mipmaps: [{ width: reader.header.pixelWidth, height: reader.header.pixelHeight, data: new Uint8Array(64).fill(7) }] } });
        } catch (error) { this.lastError = error; this.message({ action: 'decoded', success: false, msg: error }); }
      });
    }
    terminate() { this.terminated = true; }
    message(data) { if (!this.terminated) this.dispatchEvent(new MessageEvent('message', { data })); }
    ready() { if (!this.readySent) { this.readySent = true; this.message({ action: 'init' }); } }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hardwareConcurrency: 2 } });
  Object.defineProperty(globalThis, 'KTX2DECODER', { configurable: true, writable: true, value: decoder });
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: (type, callback) => { if (type === 'pagehide') pagehide.push(callback); } });
  decoder.KTX2Decoder.DefaultDecoderOptions = {};
  decoder.TranscoderManager._TranscoderInstances = {};
  KhronosTextureContainer2._DecoderModulePromise = undefined; KhronosTextureContainer2._WorkerPoolPromise = undefined;
  KhronosTextureContainer2._KTX2DecoderModule = undefined; KhronosTextureContainer2.DefaultNumWorkers = 0;
  KhronosTextureContainer2.DefaultDecoderOptions = new DefaultKTX2DecoderOptions();
  if (customDecode) decoder.KTX2Decoder.prototype.decode = customDecode;
  modules = await createP4SsrTestModules([entry]);
  const bridge = await modules.ssrLoadModule(entry);
  engine = new NullEngine(); caps = engine.getCaps(); capsDescriptors = Object.getOwnPropertyDescriptors(caps); capsPrototype = Object.getPrototypeOf(caps);
  for (const name of capNames) Object.defineProperty(caps, name, { configurable: true, enumerable: true, writable: true, value: false });
  bridge.registerKtx2WorkerEngine(engine); bridge.installLocalKtx2WorkerDecoder({});
  // 实际Khronos constructor/_Initialize创建canonical decoder，不能手工写Promise冒充已认证实例。
  new KhronosTextureContainer2(engine, 0);
  const instance = await KhronosTextureContainer2._DecoderModulePromise;
  await tick();
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: (...args) => { network.push(args); throw new Error('Unexpected network in LD1 bridge unit'); } });
  return { bridge, workers, instance, caps, network, defaults: KhronosTextureContainer2.DefaultDecoderOptions };
}

async function compareWrongSignature(instance, caps, trace, options) {
  trace.length = 0;
  await assert.rejects(originalDecode.call(instance, malformed(), caps, options), /Invalid KT2 file/);
  const expected = [...trace]; trace.length = 0;
  await assert.rejects(instance.decode(malformed(), caps, options), /Invalid KT2 file/);
  assert.deepEqual(trace, expected, 'wrapper额外观察了原执行器以外的getter或Proxy trap');
  return expected;
}

test('自有KTX2 fixture由实际9.12 parser读取header/DFD/level', () => {
  const reader = new KTX2FileReader(parseableKtx2()); assert.equal(reader.isValid(), true); reader.parse();
  assert.equal(reader.header.pixelWidth, 4); assert.equal(reader.header.pixelHeight, 4); assert.equal(reader.header.levelCount, 1);
  assert.equal(reader.dfdBlock.colorModel, 166); assert.equal(reader.hasAlpha, true); assert.equal(reader.needZSTDDecoder, false);
});

test('DefaultDecoderOptions静态accessor只读原执行器原有一次，不提前调用', async context => {
  const f = await fixture(context), trace = [], unknown = {};
  Object.defineProperty(decoder.KTX2Decoder, 'DefaultDecoderOptions', { configurable: true, get() { trace.push('default:get'); return unknown; } });
  assert.deepEqual(await compareWrongSignature(f.instance, f.caps, trace), ['default:get']); assert.equal(f.workers.length, 0);
});

test('未知静态registry getter在原解析尚未使用时不新增读取', async context => {
  const f = await fixture(context), trace = [], registry = decoder.TranscoderManager._Transcoders;
  Object.defineProperty(decoder.TranscoderManager, '_Transcoders', { configurable: true, get() { trace.push('registry:get'); return registry; } });
  assert.deepEqual(await compareWrongSignature(f.instance, f.caps, trace), []); assert.equal(f.workers.length, 0);
});

test('unknown default Proxy及其own getter仅保留原spread trap顺序', async context => {
  const f = await fixture(context), trace = [], target = {};
  Object.defineProperty(target, 'forceRGBA', { enumerable: true, get() { trace.push('own:get'); return true; } });
  decoder.KTX2Decoder.DefaultDecoderOptions = new Proxy(target, {
    ownKeys(value) { trace.push('ownKeys'); return Reflect.ownKeys(value); },
    getOwnPropertyDescriptor(value, key) { trace.push('descriptor:' + String(key)); return Reflect.getOwnPropertyDescriptor(value, key); },
    get(value, key, receiver) { trace.push('get:' + String(key)); return Reflect.get(value, key, receiver); },
    getPrototypeOf(value) { trace.push('getPrototypeOf'); return Reflect.getPrototypeOf(value); },
  });
  const expected = await compareWrongSignature(f.instance, f.caps, trace);
  assert.deepEqual(expected, ['ownKeys', 'descriptor:forceRGBA', 'get:forceRGBA', 'own:get']); assert.equal(f.workers.length, 0);
});

test('已登记默认对象后来增加own getter仍原路且只调用一次', async context => {
  const f = await fixture(context), trace = [];
  Object.defineProperty(decoder.KTX2Decoder.DefaultDecoderOptions, 'forceRGBA', { enumerable: true, get() { trace.push('own:get'); return false; } });
  assert.deepEqual(await compareWrongSignature(f.instance, f.caps, trace), ['own:get']); assert.equal(f.workers.length, 0);
});

test('Object.prototype继承tree getter不被自产options登记触发', async context => {
  const f = await fixture(context), restore = saveProperty(Object.prototype, 'transcodeFormatDecisionTree'); let calls = 0;
  f.defaults.useRGBAIfOnlyBC1BC3AvailableWhenUASTC = false;
  Object.defineProperty(Object.prototype, 'transcodeFormatDecisionTree', { configurable: true, get() { calls++; return {}; } });
  try {
    const options = f.defaults._getKTX2DecoderOptions();
    assert.deepEqual(Reflect.ownKeys(options), []); assert.equal(calls, 0);
  } finally { restore(); }
});

test('canonical实例自身_decodeDataAsync原样调用一次并返回sentinel', async context => {
  const f = await fixture(context), sentinel = { customized: true }; let calls = 0;
  f.instance._decodeDataAsync = function(reader, caps) { calls++; assert.equal(reader.header.pixelWidth, 4); assert.equal(caps, f.caps); return sentinel; };
  assert.equal(await f.instance.decode(parseableKtx2(), f.caps), sentinel); assert.equal(calls, 1); assert.equal(f.workers.length, 0);
});

test('canonical实例更换prototype后的继承_decodeDataAsync仍原路调用一次', async context => {
  const f = await fixture(context), sentinel = { inheritedOverride: true }; let calls = 0;
  const prototype = Object.create(decoder.KTX2Decoder.prototype);
  Object.defineProperty(prototype, '_decodeDataAsync', { configurable: true, value(reader, caps) {
    calls++; assert.equal(reader.header.pixelWidth, 4); assert.equal(caps, f.caps); return sentinel;
  } });
  Object.setPrototypeOf(f.instance, prototype);
  assert.equal(await f.instance.decode(parseableKtx2(), f.caps), sentinel);
  assert.equal(calls, 1); assert.equal(f.workers.length, 0);
});

test('canonical实例私有manager被替换时保留实际主线程自定义转码器', async context => {
  const f = await fixture(context); let calls = 0;
  f.instance._transcoderMgr = { findTranscoder() { calls++; return { getName: () => 'custom-private-manager', transcode: async () => new Uint8Array(64).fill(23) }; } };
  const result = await f.instance.decode(parseableKtx2(), f.caps);
  assert.equal(result.transcoderName, 'custom-private-manager'); assert.equal(result.mipmaps[0].data[0], 23); assert.equal(calls, 1); assert.equal(f.workers.length, 0);
});

test('canonical manager自有_wasmMemoryManager getter仍由原转码查找读取一次', async context => {
  const f = await fixture(context), error = new Error('own wasm memory manager sentinel'); let calls = 0;
  decoder.KTX2Decoder.DefaultDecoderOptions.forceRGBA = true;
  Object.defineProperty(f.instance._transcoderMgr, '_wasmMemoryManager', { configurable: true, get() { calls++; throw error; } });
  await assert.rejects(f.instance.decode(parseableKtx2(), f.caps), reason => reason === error);
  assert.equal(calls, 1); assert.equal(f.workers.length, 0); assert.equal(f.network.length, 0);
});

test('KTX2Decoder prototype父链新增_zstdDecoder getter保持原读取一次', async context => {
  const f = await fixture(context), error = new Error('ancestor zstd getter sentinel'); let calls = 0;
  const prototype = decoder.KTX2Decoder.prototype, previous = Object.getPrototypeOf(prototype);
  Object.setPrototypeOf(prototype, Object.create(previous, { _zstdDecoder: { configurable: true, get() { calls++; throw error; } } }));
  try {
    await assert.rejects(f.instance.decode(parseableKtx2(2), f.caps), reason => reason === error);
    assert.equal(calls, 1); assert.equal(f.workers.length, 0); assert.equal(f.network.length, 0);
  } finally { Object.setPrototypeOf(prototype, previous); }
});

test('KTX2Decoder prototype自有_zstdDecoder getter保持原继承读取一次', async context => {
  const f = await fixture(context), error = new Error('prototype zstd getter sentinel'); let calls = 0;
  const prototype = decoder.KTX2Decoder.prototype, restore = saveProperty(prototype, '_zstdDecoder');
  Object.defineProperty(prototype, '_zstdDecoder', { configurable: true, get() { calls++; throw error; } });
  try {
    await assert.rejects(f.instance.decode(parseableKtx2(2), f.caps), reason => reason === error);
    assert.equal(calls, 1); assert.equal(f.workers.length, 0); assert.equal(f.network.length, 0);
  } finally { restore(); }
});

test('ZSTDDecoder prototype init自定义hook在WASM之前原样抛异常', async context => {
  const f = await fixture(context), error = new Error('zstd init hook sentinel'); let calls = 0;
  decoder.ZSTDDecoder.prototype.init = function() { calls++; throw error; };
  await assert.rejects(f.instance.decode(parseableKtx2(2), f.caps), reason => reason === error);
  assert.equal(calls, 1); assert.equal(f.workers.length, 0); assert.equal(f.network.length, 0);
});

test('公开KTX2FileReader isValid hook原路一次且不能被worker同realm假身份掩盖', async context => {
  const f = await fixture(context), error = new Error('public parser hook sentinel'); let calls = 0;
  KTX2FileReader.prototype.isValid = function() { calls++; throw error; };
  await assert.rejects(f.instance.decode(parseableKtx2(), f.caps), reason => reason === error);
  assert.equal(calls, 1); assert.equal(f.workers.length, 0, '公开parser hook不应进入worker'); assert.equal(f.network.length, 0);
});

test('公开DataReader readUint32 hook保留实际parse首读且不进入worker', async context => {
  const f = await fixture(context), error = new Error('public data reader hook sentinel'); let calls = 0;
  DataReader.prototype.readUint32 = function() { calls++; throw error; };
  await assert.rejects(f.instance.decode(parseableKtx2(), f.caps), reason => reason === error);
  assert.equal(calls, 1); assert.equal(f.workers.length, 0, '公开DataReader hook不应进入worker'); assert.equal(f.network.length, 0);
});

test('caps缺少own data时原路，继承getter仅在原决策树读取一次', async context => {
  const f = await fixture(context), error = new Error('inherited astc sentinel'); let calls = 0;
  delete f.caps.astc; Object.setPrototypeOf(f.caps, { get astc() { calls++; throw error; } });
  await assert.rejects(f.instance.decode(parseableKtx2(), f.caps), reason => reason === error);
  assert.equal(calls, 1); assert.equal(f.workers.length, 0); assert.equal(f.network.length, 0);
});

test('caps缺own字段不能默认为false后移入worker', async context => {
  const f = await fixture(context); delete f.caps.etc1;
  await assert.rejects(f.instance.decode(malformed(), f.caps), /Invalid KT2 file/); assert.equal(f.workers.length, 0);
});

test('caps own accessor走原路，原getter异常身份及次数保留', async context => {
  const f = await fixture(context), error = new Error('own astc sentinel'); let calls = 0;
  Object.defineProperty(f.caps, 'astc', { configurable: true, get() { calls++; throw error; } });
  await assert.rejects(f.instance.decode(parseableKtx2(), f.caps), reason => reason === error); assert.equal(calls, 1); assert.equal(f.workers.length, 0);
});

test('调用返回后同步改header/caps不改变队列提交快照且不转移调用方buffer', async context => {
  const f = await fixture(context, { autoInit: false }), data = parseableKtx2();
  const pending = outcome(f.instance.decode(data, f.caps));
  assert.equal(f.workers.length, 1, 'canonical热入口同步提交pool，不额外插入await微任务');
  new DataView(data.buffer).setUint32(20, 31, true); f.caps.astc = true;
  await tick(); assert.equal(f.workers.length, 1); f.workers[0].ready();
  const result = await pending; assert.equal(result.error, undefined, result.error?.stack);
  assert.equal(result.value.width, 4); assert.equal(result.value.caps.astc, false); assert.equal(data.byteLength, 164);
  assert.equal(new DataView(data.buffer).getUint32(20, true), 31); assert.equal(f.network.length, 0);
});

test('custom registry保留原findTranscoder及自定义输出，不移入另一个realm', async context => {
  const f = await fixture(context); let calls = 0;
  class CustomTranscoder {
    static Name = 'FixtureCustom'; static CanTranscode() { return true; }
    initialize() {} needMemoryManager() { return false; } getName() { return 'FixtureCustom'; }
    async transcode() { calls++; return new Uint8Array(64).fill(41); }
  }
  decoder.TranscoderManager._Transcoders = [CustomTranscoder];
  const result = await f.instance.decode(parseableKtx2(), f.caps);
  assert.equal(result.transcoderName, 'FixtureCustom'); assert.equal(result.mipmaps[0].data[0], 41); assert.equal(calls, 1); assert.equal(f.workers.length, 0);
});

test('私有空transcoder cache更换原型后的继承lookup只走原执行器一次', async context => {
  const f = await fixture(context), error = new Error('inherited transcoder cache sentinel'); let calls = 0;
  const cache = decoder.TranscoderManager._TranscoderInstances;
  Object.setPrototypeOf(cache, new Proxy({}, { get() { calls++; throw error; } }));
  assert.deepEqual(Reflect.ownKeys(cache), []);
  await assert.rejects(f.instance.decode(parseableKtx2(), f.caps), reason => reason === error);
  assert.equal(calls, 1); assert.equal(f.workers.length, 0); assert.equal(f.network.length, 0);
});

test('显式options getter保留原spread读取一次，默认值优先语义不改', async context => {
  const f = await fixture(context), trace = [], options = {};
  Object.defineProperty(options, 'forceRGBA', { enumerable: true, get() { trace.push('explicit:get'); return true; } });
  assert.deepEqual(await compareWrongSignature(f.instance, f.caps, trace, options), ['explicit:get']); assert.equal(f.workers.length, 0);
  decoder.KTX2Decoder.DefaultDecoderOptions.forceRGBA = false;
  f.instance._decodeDataAsync = (_reader, _caps, finalOptions) => finalOptions.forceRGBA;
  trace.length = 0;
  assert.equal(await f.instance.decode(parseableKtx2(), f.caps, options), false, 'installed9.12默认值在显式options后展开并覆盖');
  assert.deepEqual(trace, ['explicit:get']); assert.equal(f.workers.length, 0);
});

test('外部替换私有Promise不能给未知decoder实例认证', async context => {
  const f = await fixture(context), unknown = new decoder.KTX2Decoder();
  KhronosTextureContainer2._DecoderModulePromise = Promise.resolve(unknown);
  KhronosTextureContainer2._Initialize(0);
  await tick();
  await assert.rejects(unknown.decode(malformed(), f.caps), /Invalid KT2 file/);
  assert.equal(f.workers.length, 0, '仅canonical初始化器创建时登记，不能在热调用信任外部Promise');
});

test('worker格式错误按原reject对象传播，不触发基础设施回退且健康槽可复用', async context => {
  const f = await fixture(context), before = f.bridge.getLocalKtx2DecodeDiagnostics();
  const invalid = await outcome(f.instance.decode(malformed(), f.caps));
  assert.match(invalid.error?.message, /Invalid KT2 file/); assert.equal(f.workers.length, 1); assert.equal(invalid.error, f.workers[0].lastError);
  const failed = f.bridge.getLocalKtx2DecodeDiagnostics();
  assert.equal(failed.mainThread, before.mainThread); assert.equal(failed.infrastructureFallbacks, before.infrastructureFallbacks); assert.equal(f.workers[0].terminated, false);
  const result = await f.instance.decode(parseableKtx2(), f.caps); assert.equal(result.width, 4); assert.equal(f.workers.length, 1);
});

test('未知实例不被异步包装，原函数同步sentinel与同步异常保持', async context => {
  const sentinel = { exactReturn: true }, error = new Error('custom sync error'); let shouldThrow = false, calls = 0;
  await fixture(context, { customDecode() { calls++; if (shouldThrow) throw error; return sentinel; } });
  const unknown = new decoder.KTX2Decoder();
  assert.equal(unknown.decode(malformed(), {}), sentinel); shouldThrow = true;
  assert.throws(() => unknown.decode(malformed(), {}), reason => reason === error); assert.equal(calls, 2);
});

test('未知this Proxy在原签名错误前不增加属性观察', async context => {
  const f = await fixture(context), trace = [], receiver = new Proxy({}, { get(target, key) { trace.push(String(key)); return Reflect.get(target, key); } });
  await assert.rejects(decoder.KTX2Decoder.prototype.decode.call(receiver, malformed(), f.caps), /Invalid KT2 file/);
  assert.deepEqual(trace, []); assert.equal(f.workers.length, 0);
});

test('Viewer先装cache再建Engine入口，configure在版本await与originalKtx捕获之前', async () => {
  const file = ts.createSourceFile('publishedBabylonCache.ts', await readFile('src/player/publishedBabylonCache.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'installPublishedViewerCache');
  assert.ok(declaration?.body);
  const first = declaration.body.statements[0];
  assert.ok(ts.isExpressionStatement(first) && ts.isCallExpression(first.expression) && first.expression.expression.getText(file) === 'configureLocalBabylonDecoders');
  const body = declaration.body.getText(file); assert.ok(body.indexOf('configureLocalBabylonDecoders()') < body.indexOf('await loadPublishedCacheVersion'));
  assert.ok(body.indexOf('configureLocalBabylonDecoders()') < body.indexOf('const originalKtx ='));
});
