import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture.js';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { SceneDocument } from '../../editor/model/SceneDocument';
import type { LightingRuntimeSource } from './lightingClassificationRuntime.ts';
import { lightingSourceVisible, sourceGeometryMesh } from './lightingRuntimeCapture.ts';
import { exportLightingMaterial } from './lightingGeometry.ts';
import { getSceneLightingConfig } from '../../../electron/shared/sceneLightingConfig.ts';
import { getSceneLightingBakeSignature } from '../../../electron/shared/sceneLightingBakeContract.ts';
import { planLightingProbeVolumes } from '../../../electron/shared/sceneLightingProbeVolumes.ts';
import { LIGHTING_BAKE_PROBE_LIMIT, type LightingBakePreflight } from '../../../electron/shared/sceneLightingBakePreflight.ts';
import { assertLightingWorkingBytes, type LightingBakeResourceBudget } from '../../../electron/shared/sceneLightingBakeResources.ts';

/** 只读已有计数/包围盒和材质元数据；禁止像素读回、顶点导出、PNG与IPC全量捕获。 */
export async function inspectLightingCaptureAdmission(scene: Scene, document: SceneDocument, sources: readonly LightingRuntimeSource[],
  budget: LightingBakeResourceBudget, signal?: AbortSignal): Promise<LightingBakePreflight> {
  const settings = getSceneLightingConfig(document).bake, signature = getSceneLightingBakeSignature(document);
  const textures = new Set<BaseTexture>(), geometries = new Set<unknown>();
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let meshCount = 0, receiverCount = 0, triangleCount = 0, vertexCount = 0, bytes = 0, largest = 0, decoded = 0;
  const textureMetadata = async (texture: BaseTexture) => {
    if (!textures.has(texture)) {
      const size = texture.getSize(), rgbaBytes = size.width * size.height * 4;
      if (!Number.isSafeInteger(rgbaBytes) || rgbaBytes <= 0 || texture.isCube) throw new Error(`纹理「${texture.name}」尺寸或类型不能烘焙。`);
      textures.add(texture); decoded += rgbaBytes;
      // float读回、RGBA、扫描行、压缩和PNG暂存留余量，不当作RSS精确预测。
      largest = Math.max(largest, rgbaBytes * 12);
    }
    return `metadata-texture-${texture.uniqueId}`;
  };
  let index = 0;
  for (const source of sources) {
    signal?.throwIfAborted();
    if (source.entry.mobility !== 'static' || !lightingSourceVisible(source)) continue;
    const mesh = sourceGeometryMesh(source.mesh), matrix = source.getWorldMatrix();
    if (!matrix) throw new Error(`对象「${source.entry.name}」的矩阵已失效。`);
    if (mesh.skeleton || mesh.morphTargetManager?.numTargets) throw new Error(`对象「${mesh.name}」包含骨骼或形变，应设置为动态。`);
    const bounds = mesh.rawBoundingInfo?.boundingBox ?? mesh.getBoundingInfo().boundingBox;
    for (const corner of bounds.vectors) {
      const point = Vector3.TransformCoordinates(corner, matrix);
      for (let axis = 0; axis < 3; axis++) { const value = [point.x, point.y, point.z][axis]; min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value); }
    }
    const vertices = mesh.getTotalVertices();
    const channels = 6 + (mesh.isVerticesDataPresent(VertexBuffer.UVKind) ? 2 : 0) + (mesh.isVerticesDataPresent(VertexBuffer.UV2Kind) ? 2 : 0)
      + (mesh.useVertexColors && mesh.isVerticesDataPresent(VertexBuffer.ColorKind) ? 4 : 0) + (mesh.isVerticesDataPresent(VertexBuffer.TangentKind) ? 4 : 0);
    const groups = mesh.subMeshes?.length ? mesh.subMeshes : [{ materialIndex: 0, indexCount: mesh.getTotalIndices(), verticesCount: vertices }];
    for (const group of groups) {
      const count = mesh.isUnIndexed ? group.verticesCount : group.indexCount;
      if (!count) continue;
      if (!vertices || count % 3) throw new Error(`对象「${mesh.name}」缺少完整三角面。`);
      const compactVertices = Math.min(vertices, count);
      const size = compactVertices * channels * 8 + count * 4 + 64;
      if (!Number.isSafeInteger(size)) throw new Error('几何大小超出有效范围。');
      meshCount++; receiverCount += source.entry.bakeIndirect ? 1 : 0; triangleCount += count / 3; vertexCount += vertices; bytes += size;
      largest = Math.max(largest, compactVertices * (channels * 8 * 3 + 64) + count * 16 + 64,
        mesh.getTotalIndices() * 8 + (mesh.isVerticesDataPresent(VertexBuffer.NormalKind) ? 0 : vertices * 3 * 8));
      const material = mesh.material instanceof MultiMaterial ? mesh.material.subMaterials[group.materialIndex] : source.mesh.material;
      await exportLightingMaterial(material, textureMetadata, source.mesh);
    }
    geometries.add(mesh.geometry ?? mesh);
    if (++index % 16 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  if (!receiverCount) throw new Error('没有参与间接光烘焙的静态表面，请先检查对象分类。');
  if (getSceneLightingBakeSignature(document) !== signature) throw new Error('预检期间场景已变化，请重新检查。');
  const plan = planLightingProbeVolumes(settings.probeVolumes, settings.probeSpacing, { min, max });
  const issues: LightingBakePreflight['issues'] = [{ code: 'metadata-preflight', severity: 'warning', message: '轻量检查未读取纹理像素或展开几何；接收面积、精确输入字节与UV排版将在有界捕获后复验。' }];
  try { assertLightingWorkingBytes(largest, budget.workingBytes, '最大单项捕获'); }
  catch (error) { issues.push({ code: 'capture-memory', severity: 'error', message: String((error as Error).message) }); }
  const backendEstimateBytes = bytes * 4 + decoded * 2 + settings.atlasSize ** 2 * 64;
  if (backendEstimateBytes > budget.backendBytes) issues.push({ code: 'backend-memory', severity: 'error', message: `后端工作集保守估计 ${(backendEstimateBytes / 1048576).toFixed(0)} MiB 超过可用预算；请减少工程规模或释放系统内存后重试，未降低画质。` });
  if (plan.count > LIGHTING_BAKE_PROBE_LIMIT) issues.push({ code: 'probe-limit', severity: 'error', message: '探针数量超过4096，请调整探针覆盖区域或间距。' });
  if (scene.getEngine().isDisposed) throw new Error('场景引擎已关闭。');
  return { signature, metadataOnly: true, meshCount, receiverCount, triangleCount, vertexCount, receiverArea: 0,
    geometryBytes: bytes, binaryGeometryBytes: bytes, estimatedInputBytes: bytes, inputEstimate: true,
    sourceTextureCount: textures.size, sourceTextureDecodedBytes: decoded, minAtlasCount: 0, minTextureBytes: 0, atlasEstimate: true,
    probeCount: plan.count, probeCountExact: plan.countExact, probeLimit: LIGHTING_BAKE_PROBE_LIMIT, bounds: plan.bounds, issues,
    largestCaptureBytes: largest, uniqueGeometryCount: geometries.size, backendEstimateBytes, resourceBudget: budget };
}
