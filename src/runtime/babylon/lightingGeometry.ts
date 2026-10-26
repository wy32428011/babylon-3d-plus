import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { resolveLightingMaterialOverride, getLightingMaterialSourceOwner } from './lightingMaterialOverrides.ts';
import { Material } from '@babylonjs/core/Materials/material.js';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Matrix } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { Node } from '@babylonjs/core/node.js';
import { assertLightingRendererHeadroom, assertLightingWorkingBytes } from '../../../electron/shared/sceneLightingBakeResources.ts';
import type {
  LightingBakeMaterialInput, LightingBakeMeshInput, LightingBakeTextureInput,
} from '../../../electron/shared/sceneLightingBakeContract.ts';

const nativeNodeKeyEncoder = encodeURIComponent, NativeNodeKeyMap = Map;
const readNodeKeyEncoding: (map: Map<string, string>, key: string) => string | undefined = Function.prototype.call.bind(Map.prototype.get);
const writeNodeKeyEncoding: (map: Map<string, string>, key: string, value: string) => Map<string, string> = Function.prototype.call.bind(Map.prototype.set);
type LightingNodeKeyReader = (node: Node, root: Node) => string;
type LightingNodeNameEncoder = (encoder: typeof encodeURIComponent, name: string) => string;

/** 一轮分类只复用原生URI编码的纯字符串结果；不缓存节点路径、属性读取或兄弟序号。 */
export function createLightingNodeKeyPass(): LightingNodeKeyReader {
  const values = new NativeNodeKeyMap<string, string>();
  const encodeName: LightingNodeNameEncoder = (encoder, name) => {
    if (encoder !== nativeNodeKeyEncoder || typeof name !== 'string') return encoder(name);
    const previous = readNodeKeyEncoding(values, name);
    if (previous !== undefined) return previous;
    const encoded = encoder(name);
    writeNodeKeyEncoding(values, name, encoded);
    return encoded;
  };
  return (node, root) => readLightingNodeKey(node, root, encodeName);
}

/** 节点路径只由资源内层级和同名兄弟序号构成，不依赖本次运行的 Babylon uniqueId。 */
export function createLightingNodeKey(node: Node, root: Node): string {
  return readLightingNodeKey(node, root);
}

function readLightingNodeKey(node: Node, root: Node, encodeName?: LightingNodeNameEncoder): string {
  const parts: string[] = [];
  for (let current: Node | null = node; current && current !== root; current = current.parent) {
    const peers = current.parent?.getChildren(undefined, true).filter(item => item.name === current!.name) ?? [current];
    // 保留push/callee/label/indexOf的求值顺序；getter在本层更换encoder只影响下一层。
    parts.push(`${encodeName ? encodeName(encodeURIComponent, current.name || current.getClassName())
      : encodeURIComponent(current.name || current.getClassName())}[${Math.max(0, peers.indexOf(current))}]`);
  }
  return parts.reverse().join('/') || '$root';
}

export type LightingTextureCapture = (texture: BaseTexture) => Promise<string>;
type LightingMaterialExportBaseline = { alpha: number; transparencyMode: number | null };
const physicalMaterialBaselines = new WeakMap<Material, LightingMaterialExportBaseline>();

/** 环境显示模式只改变工作材质；烘焙始终读取导入时的物理 alpha，而不烘入编辑器半透明显示。 */
export function registerLightingMaterialExportBaseline(material: Material, baseline: LightingMaterialExportBaseline): void {
  physicalMaterialBaselines.set(material, { alpha: baseline.alpha, transparencyMode: baseline.transparencyMode });
}

/** 工作材质克隆保留同一物理基线，不把克隆时已经应用的 ghost opacity 当作原始材质。 */
export function copyLightingMaterialExportBaseline(source: Material, target: Material): void {
  const baseline = physicalMaterialBaselines.get(source);
  if (baseline) registerLightingMaterialExportBaseline(target, baseline);
}

const pngCrcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function pngChunk(type: string, bytes: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(bytes.length + 12), view = new DataView(chunk.buffer);
  view.setUint32(0, bytes.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(bytes, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < bytes.length + 8; i++) crc = pngCrcTable[(crc ^ chunk[i]) & 255] ^ (crc >>> 8);
  view.setUint32(bytes.length + 8, (crc ^ 0xffffffff) >>> 0);
  return chunk;
}

/** Canvas 会预乘透明像素并丢失其 RGB；直接编码 RGBA，保留 opaque 忽略 alpha 时仍需使用的原色。 */
async function encodeLightingRgbaPng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number,
  signal?: AbortSignal, writePng?: (bytes: Uint8Array) => Promise<string>): Promise<string> {
  const stride = width * 4, scanlines = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) scanlines.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  if (typeof CompressionStream === 'undefined') throw new Error('当前运行环境不支持保留透明像素原色的 PNG 编码。');
  const compressed = new Uint8Array(await new Response(
    new Blob([scanlines]).stream().pipeThrough(new CompressionStream('deflate')),
  ).arrayBuffer());
  signal?.throwIfAborted();
  const header = new Uint8Array(13), headerView = new DataView(header.buffer);
  headerView.setUint32(0, width); headerView.setUint32(4, height); header[8] = 8; header[9] = 6;
  const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array())];
  const png = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { png.set(chunk, offset); offset += chunk.length; }
  if (writePng) return writePng(png);
  const binary: string[] = [];
  for (let start = 0; start < png.length; start += 0x8000) {
    binary.push(String.fromCharCode(...png.subarray(start, start + 0x8000)));
  }
  return 'data:image/png;base64,' + btoa(binary.join(''));
}

/** 捕获 GPU 中实际使用的像素，兼容 GLB 内嵌纹理及压缩纹理，不把 blob URL 交给后台进程。 */
export function createLightingTextureCapture(signal?: AbortSignal, options?: { workingBytes: number; writePng: (bytes: Uint8Array) => Promise<string> }): LightingTextureCapture {
  const cache = new Map<BaseTexture, Promise<string>>();
  return texture => {
    let pending = cache.get(texture);
    if (!pending) {
      pending = (async () => {
        signal?.throwIfAborted();
        const { width, height } = texture.getSize();
        if (!width || !height || texture.isCube) throw new Error(`纹理「${texture.name}」不是可捕获的二维材质贴图。`);
        if (options) {
          assertLightingWorkingBytes(width * height * 4 * 12, options.workingBytes, `纹理「${texture.name}」`);
          assertLightingRendererHeadroom(width * height * 4 * 12);
        }
        const pixels = await texture.readPixels();
        signal?.throwIfAborted();
        if (!pixels || pixels.byteLength === 0) throw new Error(`无法读取材质纹理「${texture.name}」。`);
        const rgba = new Uint8ClampedArray(width * height * 4);
        if (pixels instanceof Float32Array || pixels instanceof Float64Array) {
          if (pixels.length !== rgba.length) throw new Error(`纹理「${texture.name}」像素通道长度不正确。`);
          for (let i = 0; i < rgba.length; i++) {
            const value = pixels[i];
            if (!Number.isFinite(value)) throw new Error(`纹理「${texture.name}」包含非有限像素，无法烘焙。`);
            if (value < 0 || value > 1) {
              throw new Error(`纹理「${texture.name}」包含超出 [0,1] 范围的 HDR 材质像素，当前 PNG 捕获不支持保真导出；请改用 LDR 贴图配合材质强度，或取消该表面烘焙。`);
            }
            rgba[i] = Math.round(value * 255);
          }
        } else {
          const source = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
          if (source.length !== rgba.length) throw new Error(`纹理「${texture.name}」像素格式不支持无损导出。`);
          rgba.set(source);
        }
        return encodeLightingRgbaPng(rgba, width, height, signal, options?.writePng);
      })();
      cache.set(texture, pending);
    }
    return pending;
  };
}

function color(color: Color3): [number, number, number] { return [color.r, color.g, color.b]; }

async function textureInput(texture: BaseTexture, capture: LightingTextureCapture): Promise<LightingBakeTextureInput> {
  if (texture.coordinatesIndex !== 0 && texture.coordinatesIndex !== 1) {
    throw new Error(`材质纹理「${texture.name}」使用 UV${texture.coordinatesIndex + 1}，当前烘焙仅支持原材质 UV1/UV2。`);
  }
  const uv = texture as Texture;
  const matrix = uv.getTextureMatrix().m;
  return {
    url: await capture(texture), colorSpace: texture.gammaSpace ? 'srgb' : 'linear',
    coordinatesIndex: texture.coordinatesIndex, uScale: uv.uScale ?? 1, vScale: uv.vScale ?? 1,
    uOffset: uv.uOffset ?? 0, vOffset: uv.vOffset ?? 0, wAng: uv.wAng ?? 0, level: texture.level,
    // 捕获的是 GPU v=0 开始的行，PNG 却把首行当顶部；源 invertY 已在上传时生效。
    invertY: true, wrapU: texture.wrapU, wrapV: texture.wrapV,
    uvTransform: [matrix[0], matrix[4], matrix[8], matrix[1], matrix[5], matrix[9]],
  };
}

/** 根据原生材质的有效 alpha 路径导出，不改变实际工作材质或它的冻结状态。 */
function materialAlphaInput(material: PBRMaterial | StandardMaterial, mesh?: AbstractMesh): Pick<
  LightingBakeMaterialInput, 'alpha' | 'alphaMode' | 'useTextureAlpha' | 'useVertexAlpha' | 'meshVisibility' | 'alphaCutoff'
> {
  const baseline = physicalMaterialBaselines.get(material);
  const alpha = baseline?.alpha ?? material.alpha;
  const mode = baseline ? baseline.transparencyMode : material.transparencyMode;
  // 有登记基线的环境网格，其显示透明度来自编辑状态，不是物理材质透射。
  const meshVisibility = baseline ? 1 : mesh?.visibility ?? 1;
  const pbr = material instanceof PBRMaterial;
  const baseTexture = pbr ? material.albedoTexture : material.diffuseTexture;
  const alphaFromTexture = pbr ? material.useAlphaFromAlbedoTexture : material.useAlphaFromDiffuseTexture;
  const vertexAlpha = Boolean(mesh?.useVertexColors && mesh.hasVertexAlpha && mesh.isVerticesDataPresent(VertexBuffer.ColorKind));
  let blend = mode === Material.MATERIAL_ALPHABLEND || mode === Material.MATERIAL_ALPHATESTANDBLEND;
  let mask = mode === Material.MATERIAL_ALPHATEST || mode === Material.MATERIAL_ALPHATESTANDBLEND;
  if (mode == null) {
    const disabled = pbr && material.subSurface.disableAlphaBlending;
    const opacityFresnel = !pbr && material.opacityFresnelParameters?.isEnabled;
    blend = meshVisibility < 1 || (!disabled && (vertexAlpha || alpha < 1 || Boolean(material.opacityTexture)
      || Boolean(opacityFresnel) || Boolean(baseTexture?.hasAlpha && alphaFromTexture)));
    mask = !blend && !disabled && Boolean(baseTexture?.hasAlpha);
  }
  const alphaMode = mask ? blend ? 'mask-blend' : 'mask' : blend ? 'blend' : 'opaque';
  // Standard 的旧 auto mask 直接测试 diffuse alpha；显式模式只测试已启用的 alpha 因子。
  // PBR 的 ALPHATEST 明确读取 albedo alpha，即使 hasAlpha 提示标记为 false。
  const useTextureAlpha = alphaMode !== 'opaque' && Boolean(baseTexture
    && ((pbr && mask) || (baseTexture.hasAlpha && (alphaFromTexture || (mask && mode == null)))));
  return {
    alpha, alphaMode, useTextureAlpha, useVertexAlpha: alphaMode !== 'opaque' && vertexAlpha, meshVisibility,
    ...(mask ? { alphaCutoff: material.alphaCutOff } : {}),
  };
}

export async function exportLightingMaterial(rawMaterial: Material | null, capture?: LightingTextureCapture,
  mesh?: AbstractMesh): Promise<LightingBakeMaterialInput> {
  const physical = resolveLightingMaterialOverride(rawMaterial, mesh ? getLightingMaterialSourceOwner(mesh) : undefined);
  if (!physical.stable) throw new Error('显示材质存在真实业务修改，不能将临时入口材质当作有效烘焙输入。');
  const material = physical.material;
  if (!material) return { baseColor: [0.8, 0.8, 0.8], alpha: 1, alphaMode: 'opaque', useTextureAlpha: false,
    useVertexAlpha: false, meshVisibility: 1, metallic: 0, roughness: 0.8, emissive: [0, 0, 0], doubleSided: false };
  if (!(material instanceof PBRMaterial) && !(material instanceof StandardMaterial)) {
    throw new Error(`材质「${material.name}」不支持光照烘焙，请保留实时处理或换用 PBR/Standard 材质。`);
  }
  const pbr = material instanceof PBRMaterial;
  const alphaInput = materialAlphaInput(material, mesh);
  if (alphaInput.alphaMode !== 'opaque'
    && (pbr ? material.useAlphaFresnel || material.useLinearAlphaFresnel : material.opacityFresnelParameters?.isEnabled)) {
    throw new Error(`材质「${material.name}」使用视角相关的透明度 Fresnel，当前无法保真转译静态遮挡，请取消该表面烘焙。`);
  }
  // 只拒绝实际参与透明度的独立贴图；opaque 模式下这些 alpha 通道本来就不影响遮挡。
  if (alphaInput.alphaMode !== 'opaque' && material.opacityTexture) throw new Error(`材质「${material.name}」使用独立透明度贴图，请先将透明度合入基础色 alpha 或取消该表面烘焙。`);
  if (pbr && material.metallicTexture && (!material.useRoughnessFromMetallicTextureGreen || !material.useMetallnessFromMetallicTextureBlue)) {
    throw new Error(`材质「${material.name}」的金属/粗糙度通道不是 glTF G/B 布局。`);
  }
  const result: LightingBakeMaterialInput = {
    baseColor: color(pbr ? material.albedoColor : material.diffuseColor),
    ...alphaInput, metallic: pbr ? material.metallic ?? 0 : 0,
    roughness: pbr ? material.roughness ?? 0.8 : Math.sqrt(2 / (material.specularPower + 2)),
    emissive: color(material.emissiveColor), doubleSided: !material.backFaceCulling,
    invertNormalMapX: material.invertNormalMapX, invertNormalMapY: material.invertNormalMapY,
  };
  const textures: Array<[keyof NonNullable<LightingBakeMaterialInput['textures']>, BaseTexture | null]> = [
    ['baseColor', pbr ? material.albedoTexture : material.diffuseTexture], ['normal', material.bumpTexture],
    ['metallicRoughness', pbr ? material.metallicTexture : null], ['emissive', material.emissiveTexture],
    ['occlusion', material.ambientTexture],
  ];
  for (const [kind, texture] of textures) {
    if (!texture) continue;
    if (!capture) throw new Error(`材质「${material.name}」需要实际纹理捕获器。`);
    (result.textures ??= {})[kind] = await textureInput(texture, capture);
  }
  return result;
}

export type LightingMeshIdentity = {
  key: string; entityId: string; nodeKey: string; receiver: boolean; worldMatrix?: Matrix;
};
/** 保留每个 subMesh 的材质关系；UV 展开产生的新拓扑仅保存到派生几何中。 */
export async function exportLightingMesh(mesh: AbstractMesh, identity: LightingMeshIdentity,
  capture?: LightingTextureCapture, stream?: { workingBytes: number; emit: (input: LightingBakeMeshInput) => Promise<void> }): Promise<LightingBakeMeshInput[]> {
  const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
  if (!(source instanceof Mesh)) throw new Error(`对象「${mesh.name}」不是支持烘焙的三角网格。`);
  if (source.skeleton || source.morphTargetManager?.numTargets) throw new Error(`对象「${mesh.name}」包含骨骼或形变，应设置为动态。`);
  const positions = source.getVerticesData(VertexBuffer.PositionKind), indices = source.getIndices();
  const unindexed = source.isUnIndexed;
  if (!positions?.length || positions.length % 3 || (!unindexed && (!indices?.length || indices.length % 3))) {
    throw new Error(`对象「${mesh.name}」缺少有效三角网格。`);
  }
  const vertexCount = positions.length / 3;
  if (stream) {
    // 索引分组/缺省法线发生在每项编码之前，也必须先准入。
    const indexCount = unindexed ? vertexCount : indices!.length;
    assertLightingWorkingBytes(indexCount * 8 + (source.isVerticesDataPresent(VertexBuffer.NormalKind) ? 0 : vertexCount * 3 * 8), stream.workingBytes, `对象「${mesh.name}」分组`);
  }
  const groups = source.subMeshes?.length ? source.subMeshes : [{ materialIndex: 0, indexStart: 0,
    indexCount: indices?.length ?? 0, verticesStart: 0, verticesCount: vertexCount }];
  const primitives: Array<{ index: number; indices: Uint32Array; material: Material | null }> = [];
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index], start = unindexed ? group.verticesStart : group.indexStart;
    const count = unindexed ? group.verticesCount : group.indexCount;
    if (count === 0) continue;
    const material = source.material instanceof MultiMaterial ? source.material.subMaterials[group.materialIndex] : mesh.material;
    if (unindexed && (material?.fillMode ?? Material.TriangleFillMode) !== Material.TriangleFillMode) {
      throw new Error(`对象「${mesh.name}」的 primitive:${index} 不是无索引三角面拓扑，不能将线或点作为三角面烘焙。`);
    }
    const upperBound = unindexed ? vertexCount : indices!.length;
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 0 || count % 3 || start + count > upperBound) {
      throw new Error(`对象「${mesh.name}」的 primitive:${index} 缺少完整三角面或顶点范围越界。`);
    }
    // drawArrays 的实际绘制范围是 verticesStart/count；indexCount 可为零，不能据此静默丢失表面。
    // 索引用 Uint32Array：不再物化 number[]，与二进制传输目标类型一致，避免大场景堆放大。
    const primitiveIndices = new Uint32Array(count);
    if (unindexed) for (let offset = 0; offset < count; offset++) primitiveIndices[offset] = start + offset;
    else for (let offset = 0; offset < count; offset++) primitiveIndices[offset] = indices![start + offset];
    if (primitiveIndices.some(value => value >= vertexCount)) {
      throw new Error(`对象「${mesh.name}」的 primitive:${index} 三角面索引超出顶点范围。`);
    }
    primitives.push({ index, indices: primitiveIndices, material });
  }
  let normals = source.getVerticesData(VertexBuffer.NormalKind);
  if (!normals) {
    const calculated: number[] = [];
    if (unindexed) {
      const merged = new Uint32Array(primitives.reduce((total, part) => total + part.indices.length, 0));
      let offset = 0;
      for (const part of primitives) { merged.set(part.indices, offset); offset += part.indices.length; }
      VertexData.ComputeNormals(positions, merged, calculated);
    } else {
      VertexData.ComputeNormals(positions, indices!, calculated);
    }
    normals = Float32Array.from(calculated);
  }
  const uvs = source.getVerticesData(VertexBuffer.UVKind), uvs2 = source.getVerticesData(VertexBuffer.UV2Kind);
  const colors = source.useVertexColors ? source.getVerticesData(VertexBuffer.ColorKind) : null;
  const tangents = source.getVerticesData(VertexBuffer.TangentKind);
  const matrix = identity.worldMatrix ?? mesh.computeWorldMatrix(true);
  const result: LightingBakeMeshInput[] = [];
  // 同一源网格的 primitive 共享顶点属性引用；传输编码按引用去重，只编码并上送一份。
  for (const primitive of primitives) {
    const channels = 6 + (uvs ? 2 : 0) + (uvs2 ? 2 : 0) + (colors ? 4 : 0) + (tangents ? 4 : 0);
    const corners = Math.min(vertexCount, primitive.indices.length);
    const size = corners * (channels * 8 * 3 + 64) + primitive.indices.length * 16 + 64;
    if (stream) { assertLightingWorkingBytes(size, stream.workingBytes, `对象「${mesh.name}」`); assertLightingRendererHeadroom(size); }
    // 流式路径借用源属性到本次同步编码；每项写入完成即释放，捕获终点仍复核内容签名。
    const item: LightingBakeMeshInput = {
      key: `${identity.key}/primitive:${primitive.index}`, entityId: identity.entityId, nodeKey: identity.nodeKey,
      name: mesh.name, positions, normals, indices: primitive.indices,
      ...(uvs ? { uvs } : {}), ...(uvs2 ? { uvs2 } : {}),
      ...(colors ? { colors } : {}), worldMatrix: Array.from(matrix.asArray()),
      ...(tangents ? { tangents } : {}),
      material: await exportLightingMaterial(primitive.material, capture, mesh), receiver: identity.receiver,
    };
    if (stream) {
      // 只重映射本primitive真正引用的顶点；所有通道逐值复制，保持三角形顺序和Float64精度。
      const remap = new Map<number, number>(), used: number[] = [];
      const compactIndices = new Uint32Array(item.indices.length);
      for (let index = 0; index < item.indices.length; index++) {
        const sourceIndex = item.indices[index]; let target = remap.get(sourceIndex);
        if (target === undefined) { target = used.length; remap.set(sourceIndex, target); used.push(sourceIndex); }
        compactIndices[index] = target;
      }
      for (const [field, width] of [['positions', 3], ['normals', 3], ['uvs', 2], ['uvs2', 2], ['colors', 4], ['tangents', 4]] as const) {
        const original = item[field]; if (!original) continue;
        const compact = new Float64Array(used.length * width);
        for (let index = 0; index < used.length; index++) for (let channel = 0; channel < width; channel++) compact[index * width + channel] = original[used[index] * width + channel];
        item[field] = compact;
      }
      item.indices = compactIndices;
      await stream.emit(item); await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    else result.push(item);
  }
  return result;
}
