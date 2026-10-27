import type { LightingBakeInput, LightingBakeMeshInput, SceneLightingBakeSnapshot } from './sceneLightingBakeContract.ts';
import type { LightingBakeBinaryAttribute } from './sceneLightingBakeBinary.ts';
import type { LightingBakePreflight } from './sceneLightingBakePreflight.ts';
import type { LightingBakeResourceBudget } from './sceneLightingBakeResources.ts';

export type LightingBakeHeader = Omit<LightingBakeInput, 'meshes'>;
export type LightingBakeMeshMetadata = Omit<LightingBakeMeshInput, 'positions' | 'normals' | 'indices' | 'uvs' | 'uvs2' | 'colors' | 'tangents'>;
export type LightingBakePreparedInput = LightingBakeHeader & { meshes: LightingBakeMeshMetadata[] };
export type LightingBakeStreamCommand =
  | { kind: 'begin'; header: LightingBakeHeader; preflight: LightingBakePreflight }
  | { kind: 'asset'; jobId: string; assetKind: 'geometry' | 'texture'; byteLength: number; sha256: string }
  | { kind: 'chunk'; jobId: string; assetId: string; offset: number; bytes: Uint8Array }
  | { kind: 'seal'; jobId: string; assetId: string }
  | { kind: 'mesh'; jobId: string; mesh: LightingBakeMeshMetadata; assetId: string; attributes: Partial<Record<'positions' | 'normals' | 'indices' | 'uvs' | 'uvs2' | 'colors' | 'tangents', LightingBakeBinaryAttribute>> }
  | { kind: 'finish'; jobId: string; signature: string; geometrySignature: string; captureMetrics?: LightingBakeInput['captureMetrics'] }
  | { kind: 'abort'; jobId: string; error?: string };
export type LightingBakeStreamReply = { assetId?: string; sealed?: boolean; textureUrl?: string; budget?: LightingBakeResourceBudget; result?: SceneLightingBakeSnapshot };
