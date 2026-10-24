import * as decoder from '@babylonjs/ktx2decoder';
import { workerFunction } from '@babylonjs/core/Misc/khronosTextureContainer2Worker.js';

// Vite 生成同源经典 worker；MSC 的 importScripts 继续读取随应用交付的本地脚本。
(globalThis as typeof globalThis & { KTX2DECODER: typeof decoder }).KTX2DECODER = decoder;
workerFunction(decoder);
