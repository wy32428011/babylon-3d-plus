import assert from 'node:assert/strict';
import test from 'node:test';
import * as decoder from '@babylonjs/ktx2decoder';
import { KhronosTextureContainer2 } from '@babylonjs/core/Misc/khronosTextureContainer2.js';
import { DracoCompression } from '@babylonjs/core/Meshes/Compression/dracoCompression.js';
import { MeshoptCompression } from '@babylonjs/core/Meshes/Compression/meshoptCompression.js';
import { BasisToolsOptions } from '@babylonjs/core/Misc/basis.js';
import { createP4SsrTestModules } from '../helpers/p4SsrTestModules.mjs';

const localEntries = [
  ['LiteTranscoder_UASTC_ASTC', 'WasmModuleURL', 'uastc_astc.wasm'],
  ['LiteTranscoder_UASTC_BC7', 'WasmModuleURL', 'uastc_bc7.wasm'],
  ['LiteTranscoder_UASTC_RGBA_UNORM', 'WasmModuleURL', 'uastc_rgba8_unorm_v2.wasm'],
  ['LiteTranscoder_UASTC_RGBA_SRGB', 'WasmModuleURL', 'uastc_rgba8_srgb_v2.wasm'],
  ['LiteTranscoder_UASTC_R8_UNORM', 'WasmModuleURL', 'uastc_r8_unorm.wasm'],
  ['LiteTranscoder_UASTC_RG8_UNORM', 'WasmModuleURL', 'uastc_rg8_unorm.wasm'],
  ['MSCTranscoder', 'JSModuleURL', 'msc_basis_transcoder.js'],
  ['MSCTranscoder', 'WasmModuleURL', 'msc_basis_transcoder.wasm'],
  ['ZSTDDecoder', 'WasmModuleURL', 'zstddec.wasm'],
];

for (const href of ['https://viewer.example.test/sub/scene/index.html', 'file:///C:/offline/%E5%85%89%E7%85%A7%20%23%25/index.html']) {
  test(`预置全局KTX2模块时实际decoder静态URL全部本地：${new URL(href).protocol}`, async context => {
    const saved = localEntries.map(([name, key]) => [name, key, decoder[name][key]]);
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousModule = Object.getOwnPropertyDescriptor(globalThis, 'KTX2DECODER');
    const previousConfig = KhronosTextureContainer2.URLConfig, previousWorkers = KhronosTextureContainer2.DefaultNumWorkers;
    const previousDraco = DracoCompression.Configuration, previousMeshopt = MeshoptCompression.Configuration;
    const previousBasisJs = BasisToolsOptions.JSModuleURL, previousBasisWasm = BasisToolsOptions.WasmModuleURL;
    const modules = await createP4SsrTestModules(['/src/runtime/babylon/localDecoderConfiguration.ts']);
    context.after(async () => {
      for (const [name, key, value] of saved) decoder[name][key] = value;
      KhronosTextureContainer2.URLConfig = previousConfig; KhronosTextureContainer2.DefaultNumWorkers = previousWorkers;
      DracoCompression.Configuration = previousDraco; MeshoptCompression.Configuration = previousMeshopt;
      BasisToolsOptions.JSModuleURL = previousBasisJs; BasisToolsOptions.WasmModuleURL = previousBasisWasm;
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window;
      if (previousModule) Object.defineProperty(globalThis, 'KTX2DECODER', previousModule); else delete globalThis.KTX2DECODER;
      await modules.close();
    });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: new URL(href) } });
    // 恢复为远程默认值，确保不是前一用例留下的配置让测试偶然通过。
    for (const [name, key, file] of localEntries) decoder[name][key] = `https://cdn.invalid.test/${file}`;
    const { configureLocalBabylonDecoders } = await modules.ssrLoadModule('/src/runtime/babylon/localDecoderConfiguration.ts');
    configureLocalBabylonDecoders();
    assert.equal(globalThis.KTX2DECODER.KTX2Decoder, decoder.KTX2Decoder);
    const base = new URL(href).protocol === 'file:' ? new URL('./babylon-decoders/ktx2/', href) : new URL('/babylon-decoders/ktx2/', href);
    for (const [name, key, file] of localEntries) assert.equal(decoder[name][key], new URL(file, base).href, name + '.' + key);
    const actualUrls = localEntries.map(([name, key]) => decoder[name][key]);
    configureLocalBabylonDecoders();
    assert.deepEqual(localEntries.map(([name, key]) => decoder[name][key]), actualUrls, '重复配置保持同一套本地地址');
    assert.equal(KhronosTextureContainer2.DefaultNumWorkers, 0, '本用例不提前启用尚未完成缓存兼容的原生pool');
  });
}
