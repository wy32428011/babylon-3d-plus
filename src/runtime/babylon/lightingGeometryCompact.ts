import type { LightingBakeMeshInput } from '../../../electron/shared/sceneLightingBakeContract.ts';

export type LightingGeometryChannels = Pick<LightingBakeMeshInput, 'indices' | 'positions' | 'normals' | 'uvs' | 'uvs2' | 'colors' | 'tangents'>;
export type CompactLightingGeometry = {
  indices: Uint32Array; positions: Float64Array; normals: Float64Array;
  uvs?: Float64Array; uvs2?: Float64Array; colors?: Float64Array; tangents?: Float64Array;
};

/** Worker 和回退共用首见顺序的重映射，保留所有角点与 Float64 属性值。 */
export function compactLightingGeometry(input: LightingGeometryChannels): CompactLightingGeometry {
  const remap = new Map<number, number>(), used: number[] = [];
  const indices = new Uint32Array(input.indices.length);
  for (let index = 0; index < input.indices.length; index++) {
    const sourceIndex = input.indices[index]; let target = remap.get(sourceIndex);
    if (target === undefined) { target = used.length; remap.set(sourceIndex, target); used.push(sourceIndex); }
    indices[index] = target;
  }
  const output = { indices } as CompactLightingGeometry;
  for (const [field, width] of [['positions', 3], ['normals', 3], ['uvs', 2], ['uvs2', 2], ['colors', 4], ['tangents', 4]] as const) {
    const original = input[field]; if (!original) continue;
    const compact = new Float64Array(used.length * width);
    for (let index = 0; index < used.length; index++) for (let channel = 0; channel < width; channel++) compact[index * width + channel] = original[used[index] * width + channel];
    output[field] = compact;
  }
  return output;
}
