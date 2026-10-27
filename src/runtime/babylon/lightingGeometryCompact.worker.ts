import { compactLightingGeometry, type LightingGeometryChannels } from './lightingGeometryCompact.ts';

self.onmessage = (event: MessageEvent<LightingGeometryChannels>) => {
  try {
    const result = compactLightingGeometry(event.data);
    const transfer: ArrayBuffer[] = [];
    for (const value of Object.values(result)) {
      if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) transfer.push(value.buffer);
    }
    self.postMessage({ result }, { transfer });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
