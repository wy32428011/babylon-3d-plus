import type { AbstractMesh, Geometry, Material, Matrix, Mesh, SubMesh } from '@babylonjs/core';

type Scalar = number | boolean | null | undefined;

// Array.join 将 null/undefined 都写成空字段，NaN 和 -0 也须保留旧签名的比较语义。
const sameScalar = (left: Scalar, right: Scalar): boolean => left === right
  || (left == null && right == null) || (typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right));

/** 矩阵快照保留 JS number 精度，兼容 Babylon 的 64 位矩阵配置。 */
export class HybridShadowMatrixSnapshot {
  private readonly values = new Float64Array(16);
  private matrix: Matrix | null = null;
  private updateFlag = -1;

  update(matrix: Matrix | null | undefined): boolean {
    if (!matrix) {
      const changed = this.matrix !== null;
      this.matrix = null;
      return changed;
    }
    const values = matrix.asArray(), previous = this.values;
    // updateFlag 不变时展开常见稳定路径；仍逐项核对，以兼容直接修改 matrix.m 的调用者。
    const stable = this.matrix === matrix && this.updateFlag === matrix.updateFlag;
    let changed = this.matrix === null;
    if (!changed && stable) {
      changed = !(sameScalar(values[0], previous[0]) && sameScalar(values[1], previous[1])
        && sameScalar(values[2], previous[2]) && sameScalar(values[3], previous[3])
        && sameScalar(values[4], previous[4]) && sameScalar(values[5], previous[5])
        && sameScalar(values[6], previous[6]) && sameScalar(values[7], previous[7])
        && sameScalar(values[8], previous[8]) && sameScalar(values[9], previous[9])
        && sameScalar(values[10], previous[10]) && sameScalar(values[11], previous[11])
        && sameScalar(values[12], previous[12]) && sameScalar(values[13], previous[13])
        && sameScalar(values[14], previous[14]) && sameScalar(values[15], previous[15]));
    } else if (!changed) {
      for (let index = 0; index < 16; index++) if (!sameScalar(values[index], previous[index])) { changed = true; break; }
    }
    if (changed) for (let index = 0; index < 16; index++) previous[index] = values[index];
    this.matrix = matrix;
    this.updateFlag = matrix.updateFlag;
    return changed;
  }
}

class SubMeshSnapshot {
  private valid = false;
  private materialIndex = 0;
  private verticesStart = 0;
  private verticesCount = 0;
  private indexStart = 0;
  private indexCount = 0;
  private materialId?: number;
  private alpha?: number;
  private backFaceCulling?: boolean;
  private cullBackFaces?: boolean;
  private transparencyMode?: number | null;
  private fillMode?: number;
  private sideOrientation?: number | null;
  private alphaTest = false;
  private alphaBlend = false;
  private alphaCutOff?: number;
  private textureId?: number;
  private textureReady?: boolean;
  private coordinatesIndex?: number;
  private dynamicFrame = 0;
  private readonly textureMatrix = new HybridShadowMatrixSnapshot();

  update(subMesh: SubMesh, frame: number): boolean {
    const material = subMesh.getMaterial(), renderingMesh = subMesh.getMesh();
    const alphaTest = material?.needAlphaTestingForMesh(renderingMesh) ?? false;
    const alphaBlend = material?.needAlphaBlendingForMesh(renderingMesh) ?? false;
    const texture = alphaTest || alphaBlend ? material?.getAlphaTestTexture() : null;
    const alphaCutOff = (material as Material & { alphaCutOff?: number } | null)?.alphaCutOff;
    const textureReady = texture?.isReady();
    const matrixChanged = this.textureMatrix.update(texture?.getTextureMatrix());
    const dynamicFrame = texture?.getClassName() === 'DynamicTexture' ? frame : 0;
    const changed = !this.valid || this.materialIndex !== subMesh.materialIndex || this.verticesStart !== subMesh.verticesStart
      || this.verticesCount !== subMesh.verticesCount || this.indexStart !== subMesh.indexStart || this.indexCount !== subMesh.indexCount
      || this.materialId !== material?.uniqueId || !sameScalar(this.alpha, material?.alpha)
      || this.backFaceCulling !== material?.backFaceCulling || this.cullBackFaces !== material?.cullBackFaces
      || !sameScalar(this.transparencyMode, material?.transparencyMode) || !sameScalar(this.fillMode, material?.fillMode)
      || !sameScalar(this.sideOrientation, material?.sideOrientation) || this.alphaTest !== alphaTest || this.alphaBlend !== alphaBlend
      || !sameScalar(this.alphaCutOff, alphaCutOff) || this.textureId !== texture?.uniqueId || this.textureReady !== textureReady
      || !sameScalar(this.coordinatesIndex, texture?.coordinatesIndex) || this.dynamicFrame !== dynamicFrame || matrixChanged;
    if (changed) {
      this.valid = true;
      this.materialIndex = subMesh.materialIndex; this.verticesStart = subMesh.verticesStart; this.verticesCount = subMesh.verticesCount;
      this.indexStart = subMesh.indexStart; this.indexCount = subMesh.indexCount;
      this.materialId = material?.uniqueId; this.alpha = material?.alpha; this.backFaceCulling = material?.backFaceCulling;
      this.cullBackFaces = material?.cullBackFaces; this.transparencyMode = material?.transparencyMode;
      this.fillMode = material?.fillMode; this.sideOrientation = material?.sideOrientation;
      this.alphaTest = alphaTest; this.alphaBlend = alphaBlend; this.alphaCutOff = alphaCutOff;
      this.textureId = texture?.uniqueId; this.textureReady = textureReady; this.coordinatesIndex = texture?.coordinatesIndex;
      this.dynamicFrame = dynamicFrame;
    }
    return changed;
  }
}

/** 静态投射物每帧只读标量和矩阵；稳定帧不再拼接或分配签名数组/字符串。 */
export class HybridShadowNumericSignature {
  private valid = false;
  private disposed = false;
  private enabled = false;
  private visible = false;
  private visibility = 0;
  private renderingGroupId = 0;
  private geometryId?: number;
  private geometryVersion = 0;
  private vertices?: number;
  private indices?: number;
  private materialId?: number;
  private readonly world = new HybridShadowMatrixSnapshot();
  private readonly subMeshes: SubMeshSnapshot[] = [];

  update(mesh: AbstractMesh, source: Mesh | null, geometry: Geometry | null | undefined, version: number, world: Matrix): boolean {
    const disposed = mesh.isDisposed(), enabled = mesh.isEnabled();
    const vertices = source?.getTotalVertices(), indices = source?.getTotalIndices(), materialId = mesh.material?.uniqueId;
    let changed = !this.valid || this.disposed !== disposed || this.enabled !== enabled || this.visible !== mesh.isVisible
      || !sameScalar(this.visibility, mesh.visibility) || this.renderingGroupId !== mesh.renderingGroupId
      || this.geometryId !== geometry?.uniqueId || this.geometryVersion !== version
      || this.vertices !== vertices || this.indices !== indices || this.materialId !== materialId;
    if (changed) {
      this.valid = true; this.disposed = disposed; this.enabled = enabled; this.visible = mesh.isVisible;
      this.visibility = mesh.visibility; this.renderingGroupId = mesh.renderingGroupId;
      this.geometryId = geometry?.uniqueId; this.geometryVersion = version; this.vertices = vertices; this.indices = indices; this.materialId = materialId;
    }
    // 已判定失效时仍同步快照，避免下一稳定帧再次失效。
    if (this.world.update(world)) changed = true;
    const subMeshes = mesh.subMeshes, count = subMeshes?.length ?? 0, frame = mesh.getScene().getFrameId();
    if (this.subMeshes.length !== count) { this.subMeshes.length = count; changed = true; }
    for (let index = 0; index < count; index++) {
      const snapshot = this.subMeshes[index] ??= new SubMeshSnapshot();
      if (snapshot.update(subMeshes![index], frame)) changed = true;
    }
    return changed;
  }
}

/** @internal 旧实现用于逐帧等价性核对与性能 A/B；保持原字段和 join 顺序。 */
export function legacyHybridShadowSignature(mesh: AbstractMesh, source: Mesh | null,
  geometry: Geometry | null | undefined, version: number, world: Matrix): string {
  const materialSignatures = (mesh.subMeshes ?? []).map(subMesh => {
    const material = subMesh.getMaterial(), renderingMesh = subMesh.getMesh();
    const alphaTest = material?.needAlphaTestingForMesh(renderingMesh) ?? false;
    const alphaBlend = material?.needAlphaBlendingForMesh(renderingMesh) ?? false;
    const texture = alphaTest || alphaBlend ? material?.getAlphaTestTexture() : null;
    return [subMesh.materialIndex, subMesh.verticesStart, subMesh.verticesCount, subMesh.indexStart, subMesh.indexCount,
      material?.uniqueId, material?.alpha, material?.backFaceCulling, material?.cullBackFaces,
      material?.transparencyMode, material?.fillMode, material?.sideOrientation,
      alphaTest, alphaBlend, (material as Material & { alphaCutOff?: number } | null)?.alphaCutOff,
      texture?.uniqueId, texture?.isReady(), texture?.coordinatesIndex, ...(texture?.getTextureMatrix().asArray() ?? []),
      texture?.getClassName() === 'DynamicTexture' ? mesh.getScene().getFrameId() : 0].join(',');
  });
  return [mesh.isDisposed(), mesh.isEnabled(), mesh.isVisible, mesh.visibility, mesh.renderingGroupId, ...world.asArray(),
    geometry?.uniqueId, version, source?.getTotalVertices(), source?.getTotalIndices(), mesh.material?.uniqueId, ...materialSignatures].join(',');
}
