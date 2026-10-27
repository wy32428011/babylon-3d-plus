import { createConnectedLimbMask, createProceduralStrideTargets } from './proceduralAvatarAnimation';
import type { ProceduralWorkerRequest, ProceduralWorkerResponse } from './proceduralAvatarStrideWorkerClient';

self.onmessage = (event: MessageEvent<ProceduralWorkerRequest>) => {
  try {
    const { positions, indices, normals, tangents, selection, options } = event.data;
    const result = createProceduralStrideTargets(positions, {
      ...options, normals, tangents, limbMask: createConnectedLimbMask(positions, indices, selection),
    });
    const transfers: Transferable[] = [];
    if (result) for (const value of Object.values(result)) {
      if (value instanceof Float32Array && value.buffer instanceof ArrayBuffer) transfers.push(value.buffer);
    }
    const scope = self as unknown as { postMessage: (message: ProceduralWorkerResponse, transfers: Transferable[]) => void };
    scope.postMessage({ result }, transfers);
  } catch (error) {
    const scope = self as unknown as { postMessage: (message: ProceduralWorkerResponse) => void };
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
