import type { LightingBakeInput } from './sceneLightingBakeContract.ts';
import { planLightingProbeVolumes } from './sceneLightingProbeVolumes.ts';
import { getRequestedLightingLightmapMipLevels, getLightingLightmapTextureBytes, LIGHTING_LIGHTMAP_MIP_WORKING_BYTES_LIMIT } from './sceneLightingTextureCodec.ts';
export const LIGHTING_BAKE_PROBE_LIMIT = 4096;
export type LightingBakePreflightIssue = { code: string; severity: 'error' | 'warning'; message: string };
export type LightingBakePreflight = {
  /** 元数据准入不读回GPU、不遍历全部顶点；未知面积不得显示为零。 */
  metadataOnly?: boolean; sourceTextureDecodedBytes?: number; largestCaptureBytes?: number;
  uniqueGeometryCount?: number; backendEstimateBytes?: number;
  resourceBudget?: import('./sceneLightingBakeResources.ts').LightingBakeResourceBudget;
  signature: string; meshCount: number; receiverCount: number; triangleCount: number; vertexCount: number;
  receiverArea: number; geometryBytes: number; binaryGeometryBytes: number; estimatedInputBytes: number; inputEstimate: true; sourceTextureCount: number;
  /** 裁切前接收面展开后的 number 数字量估算（每数值8字节）；不含JSON字符、引擎及额外分片，也不是预算上界。 */
  estimatedDerivedNumericBytes?: number;
  sourceTextureBytes?: number; minAtlasCount: number; minTextureBytes: number; atlasEstimate: true;
  probeCount: number; probeCountExact: boolean; probeLimit: number; suggestedProbeSpacing?: number;
  bounds: { min: [number, number, number]; max: [number, number, number] }; issues: LightingBakePreflightIssue[];
  /** 新mip估计只含接收面；实际按最终每atlas三角形重验，不是Blender/OS RSS保证。 */
  mipWorkingEstimateBytes?: number; mipWorkingLimitBytes?: number;
};
/** 只读物理输入估算；图集数是面积下界，最终以 Cycles 的真实 UV 排版为准。 */
export function inspectLightingBakeInput(input: LightingBakeInput): LightingBakePreflight {
  const low: [number, number, number] = [Infinity, Infinity, Infinity], high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let triangleCount = 0, vertexCount = 0, receiverCount = 0, receiverArea = 0, numericCount = 0, binaryGeometryBytes = 0, estimatedDerivedNumericBytes = 0;
  const textures = new Set<string>();
  const mipLevels = getRequestedLightingLightmapMipLevels(input.settings.lightmapMipLevels); let mipReceiverTriangles = 0;
  for (const mesh of input.meshes) {
    const matrix = mesh.worldMatrix, positions = mesh.positions;
    const point = (index: number): number[] => [0, 1, 2].map(row => matrix[row] * positions[index * 3] + matrix[4 + row] * positions[index * 3 + 1] + matrix[8 + row] * positions[index * 3 + 2] + matrix[12 + row]);
    // 与 Blender 对变换后局部包围盒的处理一致，包含只遮挡、不接收的静态物体。
    const localLow = [Infinity, Infinity, Infinity], localHigh = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < positions.length; index++) { const axis = index % 3; localLow[axis] = Math.min(localLow[axis], positions[index]); localHigh[axis] = Math.max(localHigh[axis], positions[index]); }
    for (let corner = 0; corner < 8; corner++) for (let row = 0; row < 3; row++) {
      const value = matrix[row] * ((corner & 1) ? localHigh[0] : localLow[0]) + matrix[4 + row] * ((corner & 2) ? localHigh[1] : localLow[1]) + matrix[8 + row] * ((corner & 4) ? localHigh[2] : localLow[2]) + matrix[12 + row];
      low[row] = Math.min(low[row], value); high[row] = Math.max(high[row], value);
    }
    triangleCount += mesh.indices.length / 3; vertexCount += positions.length / 3;
    // 与BLGEO001附件的8字节头、属性对齐和数值宽度一致，无需构造另一份二进制副本。
    let binaryMeshBytes = 8;
    for (const field of ['positions', 'normals', 'indices', 'uvs', 'uvs2', 'colors', 'tangents'] as const) if (mesh[field] !== undefined) {
      binaryMeshBytes = Math.ceil(binaryMeshBytes / 8) * 8 + mesh[field]!.length * (field === 'indices' ? 4 : 8);
    }
    binaryGeometryBytes += binaryMeshBytes;
    for (const values of [positions, mesh.normals, mesh.indices, mesh.uvs, mesh.uvs2, mesh.colors, mesh.tangents, matrix]) numericCount += values?.length ?? 0;
    if (mesh.receiver !== false) {
      receiverCount++;
      if (mipLevels) mipReceiverTriangles += mesh.indices.length / 3;
      // 输出按三角角点展开；原UV缺省时仍补零，bakeUvs独立输出，索引也按运行时number估算。
      const derivedValuesPerCorner = 11 + (mesh.uvs2 !== undefined ? 2 : 0) + (mesh.colors !== undefined ? 4 : 0) + (mesh.tangents !== undefined ? 4 : 0);
      estimatedDerivedNumericBytes += mesh.indices.length * derivedValuesPerCorner * 8;
      for (let index = 0; index < mesh.indices.length; index += 3) {
        const a = point(mesh.indices[index]), b = point(mesh.indices[index + 1]), c = point(mesh.indices[index + 2]);
        const u = b.map((value, axis) => value - a[axis]), v = c.map((value, axis) => value - a[axis]);
        receiverArea += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
      }
    }
    for (const texture of Object.values(mesh.material.textures ?? {})) if (texture) textures.add(texture.url);
  }
  if (input.environment.textureUrl) textures.add(input.environment.textureUrl);
  const probePlan = planLightingProbeVolumes(input.settings.probeVolumes, input.settings.probeSpacing, { min: low, max: high });
  const extents = probePlan.bounds.max.map((value, axis) => Math.max(0, value - probePlan.bounds.min[axis]));
  const countAt = (spacing: number) => planLightingProbeVolumes(input.settings.probeVolumes, spacing, { min: low, max: high }).count;
  const probeCount = probePlan.count, issues: LightingBakePreflightIssue[] = [];
  let suggestedProbeSpacing: number | undefined;
  if (probeCount > LIGHTING_BAKE_PROBE_LIMIT) {
    let lower = input.settings.probeSpacing, upper = Math.max(...extents, lower);
    if (countAt(upper) <= LIGHTING_BAKE_PROBE_LIMIT) {
      for (let step = 0; step < 60; step++) { const middle = (lower + upper) / 2; if (countAt(middle) > LIGHTING_BAKE_PROBE_LIMIT) lower = middle; else upper = middle; }
      suggestedProbeSpacing = Math.ceil(upper * 1000) / 1000;
    }
    issues.push({ code: 'probe-limit', severity: 'error', message: '预计' + (probePlan.countExact ? ' ' : '至少 ') + probeCount
      + ' 个探针，超过 4096 上限；' + (suggestedProbeSpacing === undefined ? '请减少覆盖区域或调整区域范围后重新检查。'
        : '请将探针间距增大到至少 ' + suggestedProbeSpacing + ' m 后重新检查。') });
  }
  const minimumPixels = receiverArea * input.settings.texelsPerMeter ** 2;
  const minAtlasCount = Math.max(1, Math.ceil(minimumPixels / input.settings.atlasSize ** 2));
  const minTextureBytes = mipLevels ? minAtlasCount * getLightingLightmapTextureBytes(input.settings.atlasSize, input.settings.atlasSize, mipLevels) : minAtlasCount * input.settings.atlasSize ** 2 * 4;
  const mipWorkingEstimateBytes = mipLevels ? input.settings.atlasSize ** 2 * 160 + mipReceiverTriangles * 4096 : undefined;
  if (mipLevels && input.settings.atlasSize ** 2 * 160 > LIGHTING_LIGHTMAP_MIP_WORKING_BYTES_LIMIT) issues.push({ code: 'mip-working-budget', severity: 'error', message: '有限Mip临时工作数组的像素下界已超过2GiB预算；请显式调整图集尺寸，未自动改变LOD或几何。' });
  else if (mipWorkingEstimateBytes && mipWorkingEstimateBytes > LIGHTING_LIGHTMAP_MIP_WORKING_BYTES_LIMIT) issues.push({ code: 'mip-working-estimate', severity: 'warning', message: '接收三角形集中到单张图集的临时工作估计超过2GiB；真实UV排版后逐图集严格复验，不能以此估计代表RSS。' });
  if (minTextureBytes > input.settings.maxTextureMiB * 1048576) issues.push({ code: 'texture-budget', severity: 'error', message: '图集面积下界已超过纹理预算，请调整贴图密度、图集尺寸或预算后重新检查。' });
  const geometryBytes = numericCount * 8;
  if (geometryBytes > 256 * 1048576) issues.push({ code: 'geometry-size', severity: 'warning', message: '输入几何数字数据超过 256 MiB；JSON、IPC、展开几何和 Cycles 另有内存开销，贴图预算不能代表总内存。' });
  return { signature: input.signature, meshCount: input.meshes.length, receiverCount, triangleCount, vertexCount,
    receiverArea, geometryBytes, binaryGeometryBytes, estimatedDerivedNumericBytes, inputEstimate: true, estimatedInputBytes: binaryGeometryBytes + [...textures].reduce((sum, url) => sum + url.length, 0) + input.meshes.length * 2048 + input.lights.length * 1024,
    sourceTextureCount: textures.size, minAtlasCount, minTextureBytes, atlasEstimate: true, probeCount, probeCountExact: probePlan.countExact, probeLimit: LIGHTING_BAKE_PROBE_LIMIT,
    ...(suggestedProbeSpacing === undefined ? {} : { suggestedProbeSpacing }), bounds: probePlan.bounds, issues,
    ...(mipWorkingEstimateBytes === undefined ? {} : { mipWorkingEstimateBytes, mipWorkingLimitBytes: LIGHTING_LIGHTMAP_MIP_WORKING_BYTES_LIMIT }) };
}
export function assertLightingBakePreflight(report: LightingBakePreflight): void {
  const errors = report.issues.filter(issue => issue.severity === 'error');
  if (errors.length) throw new Error(errors.map(issue => issue.message).join('\n'));
}
