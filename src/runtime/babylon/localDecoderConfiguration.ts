import { BasisToolsOptions } from '@babylonjs/core/Misc/basis.js';
import { DracoCompression } from '@babylonjs/core/Meshes/Compression/dracoCompression.js';
import { MeshoptCompression } from '@babylonjs/core/Meshes/Compression/meshoptCompression.js';
import { KhronosTextureContainer2 } from '@babylonjs/core/Misc/khronosTextureContainer2.js';
import * as KTX2DecoderModule from '@babylonjs/ktx2decoder';

let configured = false;

function resolveDecoderUrl(relativePath: string): string {
  const normalized = relativePath.replace(/^\/+/, '');
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    return new URL(`./babylon-decoders/${normalized}`, window.location.href).toString();
  }
  const baseUrl = import.meta.env.BASE_URL || '/';
  return new URL(`babylon-decoders/${normalized}`, new URL(baseUrl, window.location.href)).toString();
}

/** 把 Babylon 压缩资源解码器固定到随应用打包的本地文件，禁止运行时回退公共 CDN。 */
export function configureLocalBabylonDecoders(): void {
  if (configured || typeof window === 'undefined') return;
  configured = true;

  DracoCompression.Configuration = {
    decoder: {
      wasmUrl: resolveDecoderUrl('draco/draco_wasm_wrapper_gltf.js'),
      wasmBinaryUrl: resolveDecoderUrl('draco/draco_decoder_gltf.wasm'),
      fallbackUrl: resolveDecoderUrl('draco/draco_decoder_gltf.js'),
    },
  };
  MeshoptCompression.Configuration = {
    decoder: { url: resolveDecoderUrl('meshopt/meshopt_decoder.js') },
  };
  BasisToolsOptions.JSModuleURL = resolveDecoderUrl('basis/basis_transcoder.js');
  BasisToolsOptions.WasmModuleURL = resolveDecoderUrl('basis/basis_transcoder.wasm');
  KhronosTextureContainer2.DefaultNumWorkers = 0;
  KhronosTextureContainer2.URLConfig = {
    jsDecoderModule: '',
    wasmUASTCToASTC: resolveDecoderUrl('ktx2/uastc_astc.wasm'),
    wasmUASTCToBC7: resolveDecoderUrl('ktx2/uastc_bc7.wasm'),
    wasmUASTCToRGBA_UNORM: resolveDecoderUrl('ktx2/uastc_rgba8_unorm_v2.wasm'),
    wasmUASTCToRGBA_SRGB: resolveDecoderUrl('ktx2/uastc_rgba8_srgb_v2.wasm'),
    wasmUASTCToR8_UNORM: resolveDecoderUrl('ktx2/uastc_r8_unorm.wasm'),
    wasmUASTCToRG8_UNORM: resolveDecoderUrl('ktx2/uastc_rg8_unorm.wasm'),
    jsMSCTranscoder: resolveDecoderUrl('ktx2/msc_basis_transcoder.js'),
    wasmMSCTranscoder: resolveDecoderUrl('ktx2/msc_basis_transcoder.wasm'),
    wasmZSTDDecoder: resolveDecoderUrl('ktx2/zstddec.wasm'),
  };
  (globalThis as typeof globalThis & { KTX2DECODER?: typeof KTX2DecoderModule }).KTX2DECODER = KTX2DecoderModule;
}

let decoderWarmup: Promise<void> | null = null;

/**
 * 预编译 Draco WASM，避免打开带环境 GLB 的场景时才第一次拉起 worker。
 * 预热失败只记日志，后续加载仍会按需初始化解码器。
 */
export function warmupLocalBabylonDecoders(): Promise<void> {
  configureLocalBabylonDecoders();
  if (typeof window === 'undefined') return Promise.resolve();
  decoderWarmup ??= DracoCompression.Default.whenReadyAsync().catch((error) => {
    decoderWarmup = null;
    console.warn('[Babylon] Draco 解码器预热失败。', error);
  });
  return decoderWarmup;
}
