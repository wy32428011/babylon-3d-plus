import type * as KTX2DecoderModule from '@babylonjs/ktx2decoder';

/** 主线程与本地 worker 必须使用同一套显式地址，不能依赖引擎初始化分支补写。 */
export type LocalKtx2DecoderUrls = {
  wasmUASTCToASTC: string;
  wasmUASTCToBC7: string;
  wasmUASTCToRGBA_UNORM: string;
  wasmUASTCToRGBA_SRGB: string;
  wasmUASTCToR8_UNORM: string;
  wasmUASTCToRG8_UNORM: string;
  jsMSCTranscoder: string;
  wasmMSCTranscoder: string;
  wasmZSTDDecoder: string;
};

/** 预置全局模块时 Babylon 9.12 不调用 applyConfig；这里直接设置实际执行器。 */
export function configureKtx2DecoderModule(module: typeof KTX2DecoderModule, urls: LocalKtx2DecoderUrls): void {
  module.LiteTranscoder_UASTC_ASTC.WasmModuleURL = urls.wasmUASTCToASTC;
  module.LiteTranscoder_UASTC_BC7.WasmModuleURL = urls.wasmUASTCToBC7;
  module.LiteTranscoder_UASTC_RGBA_UNORM.WasmModuleURL = urls.wasmUASTCToRGBA_UNORM;
  module.LiteTranscoder_UASTC_RGBA_SRGB.WasmModuleURL = urls.wasmUASTCToRGBA_SRGB;
  module.LiteTranscoder_UASTC_R8_UNORM.WasmModuleURL = urls.wasmUASTCToR8_UNORM;
  module.LiteTranscoder_UASTC_RG8_UNORM.WasmModuleURL = urls.wasmUASTCToRG8_UNORM;
  module.MSCTranscoder.JSModuleURL = urls.jsMSCTranscoder;
  module.MSCTranscoder.WasmModuleURL = urls.wasmMSCTranscoder;
  module.ZSTDDecoder.WasmModuleURL = urls.wasmZSTDDecoder;
}
