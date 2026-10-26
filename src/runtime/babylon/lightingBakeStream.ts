import { encodeLightingBakeTransport } from '../../../electron/shared/sceneLightingBakeBinary.ts';
import type { LightingBakeMeshInput } from '../../../electron/shared/sceneLightingBakeContract.ts';
import type { LightingBakeHeader, LightingBakeStreamCommand, LightingBakeStreamReply } from '../../../electron/shared/sceneLightingBakeStream.ts';
import type { LightingBakeResourceBudget } from '../../../electron/shared/sceneLightingBakeResources.ts';
import { assertLightingRendererHeadroom, assertLightingWorkingBytes, LIGHTING_BAKE_MAX_ASSET_BYTES } from '../../../electron/shared/sceneLightingBakeResources.ts';

export type LightingCaptureStream = { workingBytes: number; writePng: (bytes: Uint8Array) => Promise<string>; emit: (mesh: LightingBakeMeshInput) => Promise<void> };
/** 附件由主进程按SHA去重；renderer只保留单项数据和短资源引用。 */
export function createLightingCaptureStream(header: LightingBakeHeader, budget: LightingBakeResourceBudget,
  call: (command: LightingBakeStreamCommand) => Promise<LightingBakeStreamReply>, signal?: AbortSignal): LightingCaptureStream {
  const send = async (assetKind: 'geometry' | 'texture', bytes: Uint8Array) => {
    signal?.throwIfAborted(); assertLightingWorkingBytes(bytes.byteLength * 3, budget.workingBytes, '附件传输');
    assertLightingWorkingBytes(bytes.byteLength, LIGHTING_BAKE_MAX_ASSET_BYTES, '单个烘焙附件');
    assertLightingRendererHeadroom(bytes.byteLength * 2);
    const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    signal?.throwIfAborted();
    const sha256 = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
    const asset = await call({ kind: 'asset', jobId: header.jobId, assetKind, byteLength: bytes.byteLength, sha256 });
    if (!asset.assetId) throw new Error('烘焙附件没有返回受控身份。');
    if (!asset.sealed) for (let offset = 0; offset < bytes.length; offset += budget.chunkBytes) {
      signal?.throwIfAborted();
      await call({ kind: 'chunk', jobId: header.jobId, assetId: asset.assetId, offset, bytes: bytes.slice(offset, offset + budget.chunkBytes) });
    }
    signal?.throwIfAborted();
    return await call({ kind: 'seal', jobId: header.jobId, assetId: asset.assetId });
  };
  return { workingBytes: budget.workingBytes,
    async writePng(bytes) {
      const result = await send('texture', bytes);
      if (!result.textureUrl) throw new Error('烘焙纹理暂存未完成。');
      return result.textureUrl;
    },
    async emit(mesh) {
      signal?.throwIfAborted();
      const encoded = encodeLightingBakeTransport({ ...header, meshes: [mesh] });
      const geometry = encoded.geometry[0], asset = await send('geometry', new Uint8Array(geometry.bytes));
      if (!asset.assetId) throw new Error('几何暂存未完成。');
      await call({ kind: 'mesh', jobId: header.jobId, mesh: encoded.input.meshes[0], assetId: asset.assetId, attributes: geometry.attributes });
    } };
}
