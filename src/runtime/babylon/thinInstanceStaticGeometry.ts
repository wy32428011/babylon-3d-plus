import { Constants } from '@babylonjs/core/Engines/constants.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';

import type { Material } from '@babylonjs/core';
import { ENTITY_ARRAY_MATRIX_DETERMINANT_EPSILON, STATIC_MERGE_MAX_VERTICES, STATIC_MERGE_MAX_INDICES, STATIC_MERGE_VERTEX_KINDS, type EntityArrayMatrixCandidate } from './thinInstanceBatchTypes';
import { getSourceMatrixCount, isFiniteMatrix } from './thinInstanceMatrixBuilder';


/**
 * 将脚本生成的同 Geometry 静态叶 Mesh 聚合为一个矩阵源。
 * 与直接合并顶点不同，这会保留每个叶 Mesh 的完整相对矩阵，使货架梁柱、滚筒等重复部件可逐实例视锥裁剪。
 */
export function groupRepeatedStaticGeometryCandidates(
  candidates: readonly EntityArrayMatrixCandidate[],
): EntityArrayMatrixCandidate[] {
  const grouped = new Map<string, EntityArrayMatrixCandidate[]>();
  const output: EntityArrayMatrixCandidate[] = [];
  const materialSignatureCache = new Map<Material, string | null>();

  for (const candidate of candidates) {
    const staticKey = createStaticMergeKey(candidate, materialSignatureCache);
    const geometryId = candidate.batchSource.geometry?.uniqueId;
    if (!staticKey || geometryId === undefined) {
      output.push(candidate);
      continue;
    }
    const key = `${geometryId}|${staticKey}`;
    const group = grouped.get(key) ?? [];
    group.push(candidate);
    grouped.set(key, group);
  }

  for (const group of grouped.values()) {
    if (group.length < 2) {
      output.push(...group);
      continue;
    }
    const representative = group.reduce((best, candidate) => (
      candidate.meshIndex < best.meshIndex ? candidate : best
    ));
    output.push({
      ...representative,
      meshIndex: Math.min(...group.map((candidate) => candidate.meshIndex)),
      sourceMeshes: group.flatMap((candidate) => candidate.sourceMeshes),
    });
  }

  return output.sort((left, right) => left.meshIndex - right.meshIndex);
}

/**
 * 把同材质静态叶 Mesh 合并为源根局部 Geometry。
 * 透明、骨骼、Morph、动态顶点动画、复杂 SubMesh 和已有内部 thinInstance 保持原批次路径。
 */
export function mergeStaticCandidatesByMaterial(
  candidates: readonly EntityArrayMatrixCandidate[],
  sourceRootWorldMatrix: Matrix,
): EntityArrayMatrixCandidate[] {
  if (!isFiniteMatrix(sourceRootWorldMatrix)) return [...candidates];
  const rootDeterminant = sourceRootWorldMatrix.determinant();
  if (!Number.isFinite(rootDeterminant) || Math.abs(rootDeterminant) <= ENTITY_ARRAY_MATRIX_DETERMINANT_EPSILON) {
    return [...candidates];
  }

  const inverseSourceRoot = sourceRootWorldMatrix.clone();
  inverseSourceRoot.invert();
  const grouped = new Map<string, EntityArrayMatrixCandidate[]>();
  const output: EntityArrayMatrixCandidate[] = [];
  const materialSignatureCache = new Map<Material, string | null>();

  for (const candidate of candidates) {
    if (!isTriangleListMergeCandidate(candidate)) {
      output.push(candidate);
      continue;
    }
    const key = createStaticMergeKey(candidate, materialSignatureCache);
    if (!key) {
      output.push(candidate);
      continue;
    }
    const group = grouped.get(key) ?? [];
    group.push(candidate);
    grouped.set(key, group);
  }

  for (const group of grouped.values()) {
    let chunk: EntityArrayMatrixCandidate[] = [];
    let chunkVertices = 0;
    let chunkIndices = 0;
    const flush = (): void => {
      if (chunk.length < 2) {
        output.push(...chunk);
      } else {
        const merged = createMergedStaticCandidate(chunk, sourceRootWorldMatrix, inverseSourceRoot);
        if (merged) output.push(merged);
        else output.push(...chunk);
      }
      chunk = [];
      chunkVertices = 0;
      chunkIndices = 0;
    };

    for (const candidate of group) {
      const vertexCount = candidate.batchSource.getTotalVertices();
      const indexCount = candidate.batchSource.getTotalIndices();
      if (vertexCount > STATIC_MERGE_MAX_VERTICES || indexCount > STATIC_MERGE_MAX_INDICES) {
        flush();
        output.push(candidate);
        continue;
      }
      if (
        chunk.length > 0
        && (
          chunkVertices + vertexCount > STATIC_MERGE_MAX_VERTICES
          || chunkIndices + indexCount > STATIC_MERGE_MAX_INDICES
        )
      ) {
        flush();
      }
      chunk.push(candidate);
      chunkVertices += vertexCount;
      chunkIndices += indexCount;
    }
    flush();
  }

  return output.sort((left, right) => left.meshIndex - right.meshIndex);
}

/** 跨 Geometry 顶点烘焙只接受三角形列表；无索引 drawArrays 也必须按完整三角形覆盖。 */
export function isTriangleListMergeCandidate(candidate: EntityArrayMatrixCandidate): boolean {
  const { sourceMesh, batchSource } = candidate;
  const totalIndices = batchSource.getTotalIndices();
  const totalVertices = batchSource.getTotalVertices();
  const fillMode = batchSource.overrideRenderingFillMode
    ?? sourceMesh.material?.fillMode
    ?? Constants.MATERIAL_TriangleFillMode;
  if (fillMode !== Constants.MATERIAL_TriangleFillMode) return false;
  if (totalIndices > 0) {
    return totalIndices % 3 === 0
      && batchSource.subMeshes.every((subMesh) => subMesh.indexCount % 3 === 0);
  }
  return totalVertices > 0
    && totalVertices % 3 === 0
    && batchSource.subMeshes.every((subMesh) => subMesh.verticesCount % 3 === 0);
}

/** 返回只有视觉状态完全兼容时才相同的静态合并键。 */
export function createStaticMergeKey(
  candidate: EntityArrayMatrixCandidate,
  materialSignatureCache: Map<Material, string | null>,
): string | null {
  const { sourceMesh, batchSource } = candidate;
  if (candidate.sourceMeshes.length !== 1 || getSourceMatrixCount(sourceMesh) !== 1) return null;
  if (batchSource.getClassName() !== 'Mesh' || batchSource.subMeshes.length !== 1) return null;
  if (!batchSource.geometry) return null;
  const totalVertices = batchSource.getTotalVertices();
  const totalIndices = batchSource.getTotalIndices();
  const subMesh = batchSource.subMeshes[0];
  if (
    subMesh.verticesStart !== 0
    || subMesh.verticesCount !== totalVertices
    || (totalIndices > 0 && (subMesh.indexStart !== 0 || subMesh.indexCount !== totalIndices))
  ) {
    return null;
  }
  if (totalIndices <= 0 && totalVertices % 3 !== 0) return null;
  const vertexKinds = batchSource.getVerticesDataKinds().slice().sort();
  if (vertexKinds.some((kind) => !STATIC_MERGE_VERTEX_KINDS.has(kind))) return null;
  if (sourceMesh.skeleton || sourceMesh.morphTargetManager || sourceMesh.bakedVertexAnimationManager) return null;
  if (sourceMesh.billboardMode !== 0 || sourceMesh.infiniteDistance) return null;

  const material = sourceMesh.material;
  try {
    if (material?.needAlphaBlendingForMesh(sourceMesh)) return null;
  } catch {
    return null;
  }
  const materialSignature = material
    ? getMaterialAppearanceSignature(material, materialSignatureCache)
    : 'none';
  if (!materialSignature) return null;

  return [
    materialSignature,
    candidate.layerMask ?? sourceMesh.layerMask,
    sourceMesh.renderingGroupId,
    sourceMesh.alphaIndex,
    sourceMesh.visibility,
    sourceMesh.isVisible ? 1 : 0,
    sourceMesh.isEnabled(false) ? 1 : 0,
    sourceMesh.receiveShadows ? 1 : 0,
    sourceMesh.hasVertexAlpha ? 1 : 0,
    sourceMesh.useVertexColors ? 1 : 0,
    sourceMesh.applyFog ? 1 : 0,
    batchSource.sideOrientation,
    batchSource.overrideRenderingFillMode ?? -1,
    material?.sideOrientation ?? -1,
    batchSource.getTotalIndices() > 0 ? 'indexed' : 'unindexed',
    vertexKinds.join(','),
  ].join('|');
}

/** 仅对无动态绑定的标准/PBR 材质生成有界视觉签名，避免序列化 GLB 内嵌纹理拖慢场景加载。 */
export function getMaterialAppearanceSignature(
  material: Material,
  cache: Map<Material, string | null>,
): string | null {
  if (cache.has(material)) return cache.get(material) ?? null;
  // SelectionOutline/DepthRenderer 会在首次渲染后给标准材质追加 onBind observer；
  // observer 数量不是视觉属性，若据此拒绝合并，同一场景重导入后会从百级批次退化回数千批次。
  if ((material.animations?.length ?? 0) > 0 || material.stencil.enabled) {
    cache.set(material, null);
    return null;
  }
  const textures = material.getActiveTextures();
  if (textures.some((texture) => (
    texture.isRenderTarget
    || (texture.animations?.length ?? 0) > 0
    || !['Texture', 'CubeTexture'].includes(texture.getClassName())
  ))) {
    cache.set(material, null);
    return null;
  }

  const materialBase = material as Material & {
    textureRepetitionMode?: number;
    textureRepetitionHexTilingParams?: unknown;
  };
  const base = [
    normalizeMaterialAppearanceName(material.name),
    material.alpha,
    material.backFaceCulling,
    material.cullBackFaces,
    material.sideOrientation,
    material.alphaMode,
    material.needDepthPrePass,
    material.disableDepthWrite,
    material.disableColorWrite,
    material.forceDepthWrite,
    material.depthFunction,
    material.separateCullingPass,
    material.fogEnabled,
    material.pointSize,
    material.zOffset,
    material.zOffsetUnits,
    material.pointsCloud,
    material.fillMode,
    materialBase.textureRepetitionMode ?? null,
    materialBase.textureRepetitionHexTilingParams ?? null,
    ...textures.map(createTextureAppearanceSignature),
  ];
  let signature: string | null = null;

  if (material instanceof PBRMaterial) {
    if (
      material.clearCoat.isEnabled
      || material.anisotropy.isEnabled
      || material.sheen.isEnabled
      || material.iridescence.isEnabled
      || material.detailMap.isEnabled
      || material.subSurface.isRefractionEnabled
      || material.subSurface.isTranslucencyEnabled
      || material.subSurface.isScatteringEnabled
    ) {
      cache.set(material, null);
      return null;
    }
    signature = JSON.stringify([
      'PBRMaterial',
      ...base,
      material.albedoColor.asArray(),
      material.ambientColor.asArray(),
      material.reflectivityColor.asArray(),
      material.reflectionColor.asArray(),
      material.emissiveColor.asArray(),
      material.metallicReflectanceColor.asArray(),
      material.metallic,
      material.roughness,
      material.microSurface,
      material.indexOfRefraction,
      material.directIntensity,
      material.emissiveIntensity,
      material.environmentIntensity,
      material.specularIntensity,
      material.metallicF0Factor,
      material.baseWeight,
      material.ambientTextureStrength,
      material.ambientTextureImpactOnAnalyticalLights,
      material.transparencyMode,
      material.disableBumpMap,
      material.disableLighting,
      material.maxSimultaneousLights,
      material.twoSidedLighting,
      material.invertNormalMapX,
      material.invertNormalMapY,
      material.forceNormalForward,
      material.unlit,
      material.useAlphaFromAlbedoTexture,
      material.forceAlphaTest,
      material.alphaCutOff,
      material.useSpecularOverAlpha,
      material.useRoughnessFromMetallicTextureAlpha,
      material.useRoughnessFromMetallicTextureGreen,
      material.useMetallnessFromMetallicTextureBlue,
      material.useAmbientOcclusionFromMetallicTextureRed,
      material.useOnlyMetallicFromMetallicReflectanceTexture,
      material.useLightmapAsShadowmap,
      material.useMicroSurfaceFromReflectivityMapAlpha,
      material.useAmbientInGrayScale,
      material.useAutoMicroSurfaceFromReflectivityMap,
      material.usePhysicalLightFalloff,
      material.useGLTFLightFalloff,
      material.useRadianceOverAlpha,
      material.useObjectSpaceNormalMap,
      material.useParallax,
      material.useParallaxOcclusion,
      material.parallaxScaleBias,
      material.forceIrradianceInFragment,
      material.useAlphaFresnel,
      material.useLinearAlphaFresnel,
      material.enableSpecularAntiAliasing,
      material.useHorizonOcclusion,
      material.useRadianceOcclusion,
      material.applyDecalMapAfterDetailMap,
    ]);
  } else if (material instanceof StandardMaterial) {
    if (
      material.detailMap.isEnabled
      || material.diffuseFresnelParameters
      || material.opacityFresnelParameters
      || material.reflectionFresnelParameters
      || material.refractionFresnelParameters
      || material.emissiveFresnelParameters
    ) {
      cache.set(material, null);
      return null;
    }
    signature = JSON.stringify([
      'StandardMaterial',
      ...base,
      material.diffuseColor.asArray(),
      material.ambientColor.asArray(),
      material.specularColor.asArray(),
      material.emissiveColor.asArray(),
      material.specularPower,
      material.roughness,
      material.indexOfRefraction,
      material.invertRefractionY,
      material.disableLighting,
      material.maxSimultaneousLights,
      material.twoSidedLighting,
      material.invertNormalMapX,
      material.invertNormalMapY,
      material.useAlphaFromDiffuseTexture,
      material.alphaCutOff,
      material.useEmissiveAsIllumination,
      material.linkEmissiveWithDiffuse,
      material.useSpecularOverAlpha,
      material.useReflectionOverAlpha,
      material.useObjectSpaceNormalMap,
      material.useParallax,
      material.useParallaxOcclusion,
      material.parallaxScaleBias,
      material.useLightmapAsShadowmap,
      material.useReflectionFresnelFromSpecular,
      material.useGlossinessFromSpecularMapAlpha,
      material.applyDecalMapAfterDetailMap,
    ]);
  }

  cache.set(material, signature);
  return signature;
}

/** 使用 URL、采样、UV 和纹理视觉状态生成有界签名，不依赖运行时 texture uniqueId。 */
export function createTextureAppearanceSignature(
  texture: ReturnType<Material['getActiveTextures']>[number],
): string {
  const sampledTexture = texture as typeof texture & {
    url?: string | null;
    uOffset?: number;
    vOffset?: number;
    uScale?: number;
    vScale?: number;
    uAng?: number;
    vAng?: number;
    wAng?: number;
    uRotationCenter?: number;
    vRotationCenter?: number;
    wRotationCenter?: number;
    homogeneousRotationInUVTransform?: boolean;
    wrapR?: number;
    anisotropicFilteringLevel?: number;
    invertZ?: boolean;
    lodLevelInAlpha?: boolean;
    lodGenerationOffset?: number;
    lodGenerationScale?: number;
    linearSpecularLOD?: boolean;
    invertY?: boolean;
    samplingMode?: number;
    noMipmap?: boolean;
    optimizeUVAllocation?: boolean;
    isBlocking?: boolean;
    is3D?: boolean;
    is2DArray?: boolean;
    _useSRGBBuffer?: boolean;
  };
  return JSON.stringify([
    texture.getClassName(),
    texture.name,
    sampledTexture.url ?? null,
    texture.coordinatesIndex,
    texture.coordinatesMode,
    texture.level,
    sampledTexture.uOffset ?? 0,
    sampledTexture.vOffset ?? 0,
    sampledTexture.uScale ?? 1,
    sampledTexture.vScale ?? 1,
    sampledTexture.uAng ?? 0,
    sampledTexture.vAng ?? 0,
    sampledTexture.wAng ?? 0,
    sampledTexture.uRotationCenter ?? 0.5,
    sampledTexture.vRotationCenter ?? 0.5,
    sampledTexture.wRotationCenter ?? 0.5,
    sampledTexture.homogeneousRotationInUVTransform ?? false,
    texture.wrapU,
    texture.wrapV,
    sampledTexture.wrapR ?? 1,
    texture.hasAlpha,
    texture.getAlphaFromRGB,
    texture.gammaSpace,
    texture.isCube,
    sampledTexture.is3D ?? false,
    sampledTexture.is2DArray ?? false,
    sampledTexture.anisotropicFilteringLevel ?? 0,
    sampledTexture.invertZ ?? false,
    sampledTexture.lodLevelInAlpha ?? false,
    sampledTexture.lodGenerationOffset ?? 0,
    sampledTexture.lodGenerationScale ?? 0,
    sampledTexture.linearSpecularLOD ?? false,
    sampledTexture.invertY ?? false,
    sampledTexture.samplingMode ?? null,
    sampledTexture.noMipmap ?? false,
    sampledTexture.optimizeUVAllocation ?? true,
    sampledTexture.isBlocking ?? true,
    sampledTexture._useSRGBBuffer ?? false,
  ]);
}

/** GLB 导入和参数脚本会给等价克隆追加运行时序号；只移除这些已知非视觉后缀。 */
export function normalizeMaterialAppearanceName(name: string): string {
  return name
    .replace(/_(?:chain|gd|hcts|wlts)_\d+$/i, '')
    .replace(/_parametric_\d+$/i, '');
}

/** 提取独立 VertexData，应用正确的世界到源根局部变换，再合并为单材质 Geometry。 */
export function createMergedStaticCandidate(
  candidates: readonly EntityArrayMatrixCandidate[],
  sourceRootWorldMatrix: Matrix,
  inverseSourceRoot: Matrix,
): EntityArrayMatrixCandidate | null {
  const vertexDatas: VertexData[] = [];
  try {
    for (const candidate of candidates) {
      const vertexData = VertexData.ExtractFromMesh(candidate.batchSource, true, true);
      if (!vertexData.positions || vertexData.positions.length === 0) return null;
      candidate.sourceMesh.computeWorldMatrix(true);
      const rootLocalMatrix = candidate.sourceMesh.getWorldMatrix().multiply(inverseSourceRoot);
      if (!transformVertexDataPreservingNormals(vertexData, rootLocalMatrix)) return null;
      vertexDatas.push(vertexData);
    }

    const merged = vertexDatas[0];
    if (!merged) return null;
    if (vertexDatas.length > 1) merged.merge(vertexDatas.slice(1), true, false, false, false);
    const representative = candidates[0];
    return {
      ...representative,
      meshIndex: Math.min(...candidates.map((candidate) => candidate.meshIndex)),
      // Geometry 已经烘焙为一个载体，但仍保留全部源 Mesh 作为覆盖诊断，避免合并后无法确认部件完整性。
      sourceMeshes: candidates.flatMap((candidate) => candidate.sourceMeshes),
      rootLocalVertexData: merged,
      rootLocalGeometryBaked: true,
      sourceRootWorldMatrix: sourceRootWorldMatrix.clone(),
    };
  } catch (error) {
    console.warn('合并模型阵列静态 Geometry 失败，已回退逐 Mesh 批次。', error);
    return null;
  }
}

/** VertexData.transform 对非均匀缩放直接变换法线；这里用逆转置矩阵恢复正确光照。 */
export function transformVertexDataPreservingNormals(vertexData: VertexData, matrix: Matrix): boolean {
  const determinant = matrix.determinant();
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= ENTITY_ARRAY_MATRIX_DETERMINANT_EPSILON) return false;

  const sourceNormals = vertexData.normals ? Float32Array.from(vertexData.normals) : null;
  const sourceTangents = vertexData.tangents ? Float32Array.from(vertexData.tangents) : null;
  vertexData.transform(matrix);

  const normalMatrix = matrix.clone();
  normalMatrix.invert();
  const normalTransform = normalMatrix.transpose();
  const transformed = new Vector3();

  if (sourceNormals && vertexData.normals) {
    for (let offset = 0; offset < sourceNormals.length; offset += 3) {
      Vector3.TransformNormalFromFloatsToRef(
        sourceNormals[offset],
        sourceNormals[offset + 1],
        sourceNormals[offset + 2],
        normalTransform,
        transformed,
      );
      transformed.normalize();
      vertexData.normals[offset] = transformed.x;
      vertexData.normals[offset + 1] = transformed.y;
      vertexData.normals[offset + 2] = transformed.z;
    }
  }

  if (sourceTangents && vertexData.tangents) {
    const handedness = determinant < 0 ? -1 : 1;
    for (let offset = 0; offset < sourceTangents.length; offset += 4) {
      // 切线是表面方向，必须走线性模型矩阵；只有法线使用逆转置矩阵。
      Vector3.TransformNormalFromFloatsToRef(
        sourceTangents[offset],
        sourceTangents[offset + 1],
        sourceTangents[offset + 2],
        matrix,
        transformed,
      );
      transformed.normalize();
      vertexData.tangents[offset] = transformed.x;
      vertexData.tangents[offset + 1] = transformed.y;
      vertexData.tangents[offset + 2] = transformed.z;
      vertexData.tangents[offset + 3] = sourceTangents[offset + 3] * handedness;
    }
  }
  if (
    determinant < 0
    && (vertexData.indices?.length ?? 0) === 0
    && !flipUnindexedTriangleFaces(vertexData)
  ) return false;
  return true;
}

/** 反射变换下无索引三角形没有 index buffer 可翻面，必须交换每个三角形的后两个顶点。 */
export function flipUnindexedTriangleFaces(vertexData: VertexData): boolean {
  const vertexCount = (vertexData.positions?.length ?? 0) / 3;
  if (!Number.isInteger(vertexCount) || vertexCount % 3 !== 0) return false;
  for (let vertex = 0; vertex < vertexCount; vertex += 3) {
    swapVertexAttribute(vertexData.positions, 3, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.normals, 3, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.tangents, 4, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.colors, 4, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.uvs, 2, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.uvs2, 2, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.uvs3, 2, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.uvs4, 2, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.uvs5, 2, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.uvs6, 2, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.matricesIndices, 4, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.matricesWeights, 4, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.matricesIndicesExtra, 4, vertex + 1, vertex + 2);
    swapVertexAttribute(vertexData.matricesWeightsExtra, 4, vertex + 1, vertex + 2);
  }
  return true;
}

export function swapVertexAttribute(
  values: { length: number; [index: number]: number } | null | undefined,
  stride: number,
  leftVertex: number,
  rightVertex: number,
): void {
  if (!values) return;
  const leftOffset = leftVertex * stride;
  const rightOffset = rightVertex * stride;
  for (let component = 0; component < stride; component += 1) {
    const value = values[leftOffset + component];
    values[leftOffset + component] = values[rightOffset + component];
    values[rightOffset + component] = value;
  }
}