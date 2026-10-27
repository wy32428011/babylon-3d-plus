import { encodeLightingPixels, LightingPixelDataError } from './lightingPngEncode.ts';

type Request = { bytes: ArrayBuffer; kind: 'float32' | 'float64' | 'bytes'; width: number; height: number; name: string };

self.onmessage = async (event: MessageEvent<Request>) => {
  try {
    const { bytes, kind, width, height, name } = event.data;
    const pixels = kind === 'float32' ? new Float32Array(bytes) : kind === 'float64' ? new Float64Array(bytes) : new Uint8Array(bytes);
    const png = await encodeLightingPixels(pixels, width, height, name);
    self.postMessage({ png }, { transfer: [png.buffer as ArrayBuffer] });
  } catch (error) {
    self.postMessage({ kind: error instanceof LightingPixelDataError ? 'data-error' : 'infrastructure-error',
      error: error instanceof Error ? error.message : String(error) });
  }
};
