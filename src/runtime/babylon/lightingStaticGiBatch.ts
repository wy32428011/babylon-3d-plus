import { Material } from '@babylonjs/core/Materials/material.js';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { LightingBakeGeometry } from '../../../electron/shared/sceneLightingBakeContract.ts';
import type { BakedLightingBinding } from './BakedLightingMaterialPlugin.ts';
import type { LightingRuntimeSource } from './lightingClassificationRuntime.ts';
import { FORMAL_BATCH_MIN_PARTITION_SPAN_METERS, STATIC_MERGE_MAX_INDICES, STATIC_MERGE_MAX_VERTICES } from './thinInstanceBatchTypes.ts';

export type LightingStaticGiSurface = {
  key: string;
  source: LightingRuntimeSource;
  geometry: LightingBakeGeometry;
  material: Material | null;
  materialParent: Material | null;
  primitive: number;
  materialIndex: number;
  binding: BakedLightingBinding;
  layerMask: number;
};
export type LightingStaticGiBatch = {
  surfaces: LightingStaticGiSurface[];
  geometry: LightingBakeGeometry;
  signature: string | null;
};
export type LightingStaticGiBatchWatch = { surface: LightingStaticGiSurface; signature: string };

type Attribute = 'positions' | 'normals' | 'uvs' | 'uvs2' | 'colors' | 'tangents' | 'bakeUvs';
const attributes: readonly Attribute[] = ['positions', 'normals', 'uvs', 'uvs2', 'colors', 'tangents', 'bakeUvs'];
const supportedPlugins = ['detailMap', 'clearCoat', 'anisotropy', 'brdf', 'sheen', 'subSurface', 'iridescence', 'diffuseRoughness'] as const;
const cellSize = FORMAL_BATCH_MIN_PARTITION_SPAN_METERS;

function supportedMaterial(material: Material | null, mesh: Mesh): boolean {
  if (!material || (Object.getPrototypeOf(material) !== PBRMaterial.prototype
    && Object.getPrototypeOf(material) !== StandardMaterial.prototype)) return false;
  if (material.customShaderNameResolve || material.shadowDepthWrapper || material.onBindObservable.hasObservers()
    || (material.animations?.length ?? 0) > 0 || material.stencil.enabled || material.fillMode !== Material.TriangleFillMode
    || material.needAlphaBlendingForMesh(mesh) || material.needAlphaTestingForMesh(mesh)) return false;
  // 仅承认当前材质实际持有的原生配置插件；不按插件名称猜测自定义 shader 是否逐对象取值。
  const native = material as unknown as Record<string, unknown>;
  const plugins = material.pluginManager?._plugins ?? [];
  return plugins.every(plugin => supportedPlugins.some(field => native[field] === plugin));
}

/** 相同签名只允许同变换、同光照语义的不可交互环境表面共享一次绘制。 */
export function lightingStaticGiBatchSignature(surface: LightingStaticGiSurface): string | null {
  const { source, material, geometry, binding, layerMask } = surface;
  const mesh = source.mesh;
  if (source.entry.entityId !== '$environment' || source.entry.mobility !== 'static' || !source.entry.bakeIndirect
    || source.instance || !(mesh instanceof Mesh) || Object.getPrototypeOf(mesh) !== Mesh.prototype
    || mesh.metadata?.editorEnvironmentMesh !== true || mesh.isPickable || mesh.isDisposed()
    || !mesh.isVisible || !mesh.isEnabled() || mesh.visibility !== 1 || mesh.hasVertexAlpha
    || mesh.skeleton || mesh.morphTargetManager || mesh.bakedVertexAnimationManager || mesh.hasThinInstances
    || mesh.billboardMode !== 0 || mesh.infiniteDistance || mesh.renderOutline || mesh.renderOverlay
    || mesh.onBeforeRenderObservable.hasObservers() || mesh.onBeforeBindObservable.hasObservers()
    || mesh.onAfterRenderObservable.hasObservers() || mesh.onBeforeDrawObservable.hasObservers()
    || mesh.onBetweenPassObservable.hasObservers() || !supportedMaterial(material, mesh)) return null;
  if (mesh.material !== surface.materialParent || (mesh.subMeshes[surface.primitive]?.materialIndex ?? 0) !== surface.materialIndex
    || (surface.materialParent instanceof MultiMaterial ? surface.materialParent.subMaterials[surface.materialIndex] : surface.materialParent) !== material) return null;
  const scene = mesh.getScene();
  if (scene.customRenderTargets.length || geometry.positions.length / 3 > STATIC_MERGE_MAX_VERTICES
    || geometry.indices.length > STATIC_MERGE_MAX_INDICES) return null;
  const world = source.getWorldMatrix();
  if (!world || !Array.from(world.m).every(Number.isFinite)) return null;
  const lightPolicies = scene.lights.map(light => [light.uniqueId,
    light.includedOnlyMeshes.length === 0 || light.includedOnlyMeshes.includes(mesh), light.excludedMeshes.includes(mesh),
    light.includeOnlyWithLayerMask === 0 || (light.includeOnlyWithLayerMask & layerMask) !== 0,
    (light.excludeWithLayerMask & layerMask) !== 0]);
  return JSON.stringify([material!.uniqueId, binding.texture?.uniqueId, binding.rgbmRange, binding.encoding, binding.mipLevelCount,
    layerMask, source.entry.castShadows, source.entry.receiveShadows, mesh.renderingGroupId, mesh.alphaIndex,
    mesh.useVertexColors, mesh.applyFog, mesh.overrideMaterialSideOrientation, mesh.overrideRenderingFillMode,
    Array.from(world.m), attributes.map(attribute => geometry[attribute] !== undefined), lightPolicies]);
}

function spatialCell(surface: LightingStaticGiSurface): string | null {
  const world = surface.source.getWorldMatrix();
  if (!world) return null;
  const minimum = new Vector3(Infinity, Infinity, Infinity), maximum = new Vector3(-Infinity, -Infinity, -Infinity);
  const { positions } = surface.geometry;
  const point = new Vector3(), transformed = new Vector3();
  for (let index = 0; index < positions.length; index += 3) {
    point.set(positions[index], positions[index + 1], positions[index + 2]);
    Vector3.TransformCoordinatesToRef(point, world, transformed);
    minimum.minimizeInPlace(transformed); maximum.maximizeInPlace(transformed);
  }
  if (![...minimum.asArray(), ...maximum.asArray()].every(Number.isFinite)) return null;
  if (maximum.x - minimum.x > cellSize || maximum.y - minimum.y > cellSize || maximum.z - minimum.z > cellSize) return null;
  // 以整个表面的实际范围划分，不用常为同一原点的环境节点平移代替几何位置。
  const low = minimum.asArray().map(value => Math.floor(value / cellSize));
  const high = maximum.asArray().map(value => Math.floor(value / cellSize));
  return low.every((value, index) => value === high[index]) ? low.join(',') : null;
}

function mergeGeometry(surfaces: readonly LightingStaticGiSurface[]): LightingBakeGeometry {
  const count = surfaces.reduce((total, surface) => total + surface.geometry.positions.length / 3, 0);
  const geometry = { version: 2 } as LightingBakeGeometry;
  for (const attribute of attributes) {
    if (surfaces[0].geometry[attribute] === undefined) continue;
    const length = surfaces.reduce((total, surface) => total + surface.geometry[attribute]!.length, 0);
    const values = new Float32Array(length);
    let offset = 0;
    for (const surface of surfaces) {
      values.set(surface.geometry[attribute]!, offset);
      offset += surface.geometry[attribute]!.length;
    }
    geometry[attribute] = values;
  }
  const indices = new Uint32Array(surfaces.reduce((total, surface) => total + surface.geometry.indices.length, 0));
  let vertexOffset = 0, indexOffset = 0;
  for (const surface of surfaces) {
    for (const index of surface.geometry.indices) indices[indexOffset++] = index + vertexOffset;
    vertexOffset += surface.geometry.positions.length / 3;
  }
  if (vertexOffset !== count) throw new Error('环境 GI 合批顶点布局不一致。');
  geometry.indices = indices;
  return geometry;
}

/** 只合并相邻兼容表面，保留原 primitive 顺序和不同材质间的深度相等绘制顺序。 */
export function planLightingStaticGiBatches(surfaces: readonly LightingStaticGiSurface[], enabled: boolean): LightingStaticGiBatch[] {
  const batches: LightingStaticGiBatch[] = [];
  let members: LightingStaticGiSurface[] = [], signature: string | null = null, cell: string | null = null;
  let vertices = 0, indices = 0;
  const flush = () => {
    if (members.length) batches.push({ surfaces: members, geometry: members.length > 1 ? mergeGeometry(members) : members[0].geometry,
      signature: members.length > 1 ? signature : null });
    members = []; vertices = 0; indices = 0;
  };
  for (const surface of surfaces) {
    const nextSignature = enabled ? lightingStaticGiBatchSignature(surface) : null;
    const nextCell = nextSignature ? spatialCell(surface) : null;
    const vertexCount = surface.geometry.positions.length / 3, indexCount = surface.geometry.indices.length;
    if (!nextSignature || !nextCell) {
      flush(); batches.push({ surfaces: [surface], geometry: surface.geometry, signature: null });
      signature = null; cell = null; continue;
    }
    if (nextSignature !== signature || nextCell !== cell || vertices + vertexCount > STATIC_MERGE_MAX_VERTICES
      || indices + indexCount > STATIC_MERGE_MAX_INDICES) flush();
    signature = nextSignature; cell = nextCell;
    members.push(surface); vertices += vertexCount; indices += indexCount;
  }
  flush();
  return batches;
}
