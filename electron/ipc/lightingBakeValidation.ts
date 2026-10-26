import path from 'node:path';
import { normalizeLightingLightmapEncoding, normalizeLightingLightmapMipLevels } from '../shared/sceneLightingTextureCodec.ts';
import { normalizeLightingProbeVolumes } from '../shared/sceneLightingProbeVolumes.ts';
import { decodeLightingBakeTransport } from '../shared/sceneLightingBakeBinary.ts';
import type { LightingBakeInput, LightingBakeMeshInput } from '../shared/sceneLightingBakeContract.js';

type ObjectValue = Record<string, unknown>;
function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式不正确。`);
  return value as ObjectValue;
}
function finite(value: unknown, label: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label}必须是范围内的有限数值。`);
  return value;
}
function numbers(value: unknown, label: string, size?: number): ArrayLike<number> {
  // 二进制传输在 main 侧零拷贝为 TypedArray 视图；旧 JSON 路径仍是 number[]，两者都走同一逐项校验。
  if (!(Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView)))) throw new Error(`${label}长度不正确。`);
  const values = value as ArrayLike<number>;
  if (size !== undefined && values.length !== size) throw new Error(`${label}长度不正确。`);
  for (let index = 0; index < values.length; index++) finite(values[index], label);
  return values;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw new Error(`${label}格式不正确。`);
  return value;
}
function assetUrl(value: unknown): void {
  if (typeof value !== 'string' || (!value.startsWith('editor-asset://local/') && !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))) throw new Error('烘焙纹理必须来自已授权的本机资产或导出的 PNG。');
}

/** IPC 是信任边界：只接收有限几何与固定材质字段，任何不支持的输入在启动引擎前失败。 */
export function validateLightingBakeInput(value: unknown): LightingBakeInput {
  if (value && typeof value === 'object' && 'version' in value && value.version === 2) return validateLightingBakeInput(decodeLightingBakeTransport(value));
  const input = object(value, '烘焙请求');
  if (input.version !== 1) throw new Error('不支持的烘焙请求版本。');
  if (typeof input.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.jobId)) throw new Error('烘焙任务标识格式不正确。');
  if (input.captureMetrics !== undefined) {
    const metrics = object(input.captureMetrics, '视口准备计量');
    if (metrics.durationMs !== null) finite(metrics.durationMs, '视口准备耗时', 0);
    if (metrics.rendererHeapMaxObservedBytes !== null) finite(metrics.rendererHeapMaxObservedBytes, '视口堆观察值', 0);
    if (!['performance.memory.usedJSHeapSize','unavailable'].includes(metrics.rendererHeapBasis as string)) throw new Error('视口准备计量口径无效。');
  }
  text(input.signature, '场景签名'); text(input.sceneName, '场景名称');
  const settings = object(input.settings, '烘焙设置');
  normalizeLightingLightmapEncoding(settings.lightmapEncoding);
  normalizeLightingLightmapMipLevels(settings.lightmapMipLevels);
  const probeVolumes = normalizeLightingProbeVolumes(settings.probeVolumes);
  if (settings.device !== undefined && !['cpu','auto','gpu'].includes(settings.device as string)) throw new Error('烘焙设备选择无效。');
  finite(settings.atlasSize, '图集大小', 64, 8192);
  if (!Number.isInteger(settings.atlasSize) || ((settings.atlasSize as number) & ((settings.atlasSize as number) - 1)) !== 0) throw new Error('图集大小必须是 2 的幂。');
  if (!['preview', 'standard', 'high'].includes(settings.quality as string)) throw new Error('烘焙质量设置不正确。');
  finite(settings.texelsPerMeter, '贴图密度', 0.1, 4096);
  finite(settings.probeSpacing, '探针间距', 0.1, 10000);
  finite(settings.maxTextureMiB, '纹理预算', 1, 4096);
  if (!Array.isArray(input.meshes) || !input.meshes.length) throw new Error('没有可烘焙的静态表面。');
  const keys = new Set<string>();
  for (const entry of input.meshes) {
    const mesh = object(entry, '几何'); const key = text(mesh.key, '几何标识');
    if (keys.has(key)) throw new Error('烘焙几何标识重复。'); keys.add(key);
    text(mesh.entityId, '实体标识'); text(mesh.nodeKey, '节点标识'); text(mesh.name, '几何名称');
    const positions = numbers(mesh.positions, '顶点'), normals = numbers(mesh.normals, '法线');
    if (!positions.length || positions.length % 3 || normals.length !== positions.length) throw new Error('几何顶点或法线长度不正确。');
    const indices = numbers(mesh.indices, '索引');
    let indicesValid = indices.length > 0 && indices.length % 3 === 0;
    if (indicesValid) for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      if (!Number.isInteger(index) || index < 0 || index >= positions.length / 3) { indicesValid = false; break; }
    }
    if (!indicesValid) throw new Error('几何索引越界或不是三角面。');
    numbers(mesh.worldMatrix, '世界矩阵', 16);
    if (mesh.uvs !== undefined) numbers(mesh.uvs, 'UV', positions.length / 3 * 2);
    if (mesh.uvs2 !== undefined) numbers(mesh.uvs2, 'UV2', positions.length / 3 * 2);
    if (mesh.colors !== undefined) numbers(mesh.colors, '顶点颜色', positions.length / 3 * 4);
    if (mesh.tangents !== undefined) numbers(mesh.tangents, '顶点切线', positions.length / 3 * 4);
    const material = object(mesh.material, '材质');
    numbers(material.baseColor, '基础色', 3); numbers(material.emissive, '自发光', 3);
    finite(material.alpha, '透明度', 0, 1); finite(material.metallic, '金属度', 0, 1); finite(material.roughness, '粗糙度', 0, 1);
    if (material.alphaMode !== undefined && !['opaque', 'mask', 'blend', 'mask-blend'].includes(material.alphaMode as string)) {
      throw new Error('材质透明模式不正确。');
    }
    for (const flag of ['useTextureAlpha', 'useVertexAlpha']) {
      if (material[flag] !== undefined && typeof material[flag] !== 'boolean') throw new Error(`材质 ${flag} 必须是布尔值。`);
    }
    if (material.alphaMode === undefined
      && ['useTextureAlpha', 'useVertexAlpha', 'meshVisibility'].some(field => material[field] !== undefined)) {
      throw new Error('材质声明独立透明因子时必须明确 alphaMode。');
    }
    if (material.meshVisibility !== undefined) finite(material.meshVisibility, '网格独立透明度', 0, 1);
    if (material.alphaCutoff !== undefined) {
      finite(material.alphaCutoff, '透明裁切值', 0, 1);
      if (material.alphaMode !== 'mask' && material.alphaMode !== 'mask-blend') throw new Error('只有 mask 材质可以设置透明裁切值。');
    }
    if (material.alphaMode === 'opaque' && (material.useTextureAlpha || material.useVertexAlpha)) throw new Error('不透明材质不能同时启用纹理或顶点透明度。');
    if (material.useVertexAlpha && !mesh.colors) throw new Error('材质启用顶点透明度，但没有顶点颜色数据。');
    if (material.useTextureAlpha && !object(material.textures ?? {}, '纹理').baseColor) throw new Error('材质启用纹理透明度，但没有基础色贴图。');
    if (typeof material.doubleSided !== 'boolean') throw new Error('双面材质设置格式不正确。');
    if (material.textures) for (const [kind, entry] of Object.entries(object(material.textures, '纹理'))) {
      if (!['baseColor', 'normal', 'metallicRoughness', 'emissive', 'occlusion'].includes(kind)) throw new Error(`不支持的烘焙纹理通道：${kind}`);
      const texture = object(entry, '纹理'); assetUrl(texture.url);
      if (texture.colorSpace !== undefined && texture.colorSpace !== 'srgb' && texture.colorSpace !== 'linear') throw new Error('纹理颜色空间必须是 srgb 或 linear。');
      const channel = finite(texture.coordinatesIndex ?? 0, '纹理坐标集', 0, 1);
      if (!Number.isInteger(channel) || !(channel === 0 ? mesh.uvs : mesh.uvs2)) throw new Error('材质需要的 UV 坐标集缺失。');
      for (const field of ['uScale', 'vScale', 'uOffset', 'vOffset', 'wAng', 'level', 'uRotationCenter', 'vRotationCenter']) if (texture[field] !== undefined) finite(texture[field], `纹理 ${field}`);
      if (texture.uvTransform !== undefined) numbers(texture.uvTransform, '纹理变换矩阵', 6);
      for (const field of ['wrapU', 'wrapV']) if (texture[field] !== undefined && ![0, 1, 2].includes(texture[field] as number)) throw new Error('不支持的纹理寻址方式。');
      if ((texture.wrapU ?? 1) !== (texture.wrapV ?? 1)) throw new Error('Cycles 暂不支持 U/V 不同的纹理寻址方式，请统一后再烘焙。');
    }
  }
  if (!input.meshes.some(mesh => object(mesh, '几何').receiver !== false)) throw new Error('没有接收光照烘焙的静态表面。');
  if (!Array.isArray(input.lights)) throw new Error('灯光列表格式不正确。');
  for (const value of input.lights) {
    const light = object(value, '灯光');
    if (!['directional', 'point', 'spot', 'area'].includes(light.kind as string)) throw new Error('不支持的烘焙灯光类型。');
    numbers(light.position, '灯光位置', 3); numbers(light.direction, '灯光方向', 3); numbers(light.color, '灯光颜色', 3);
    finite(light.intensity, '灯光强度', 0, 1e12);
    if (light.falloff !== undefined && !['standard', 'physical', 'gltf'].includes(light.falloff as string)) throw new Error('不支持的灯光衰减方式。');
    for (const field of ['range', 'angle', 'innerAngle', 'exponent', 'width', 'height']) if (light[field] !== undefined) finite(light[field], `灯光 ${field}`, 0, 1e12);
  }
  const environment = object(input.environment, '环境光');
  numbers(environment.color, '环境颜色', 3); finite(environment.intensity, '环境强度', 0, 1e12);
  if (environment.textureUrl !== undefined) assetUrl(environment.textureUrl);
  if (environment.rotation !== undefined) finite(environment.rotation, '环境旋转');
  // 旧 v1 请求沿用原对象；只有显式区域需要建立不可变归一化副本。
  if (probeVolumes === undefined) return input as unknown as LightingBakeInput;
  return { ...input, settings: { ...settings, probeVolumes } } as unknown as LightingBakeInput;
}

/** 所有引擎产物使用简单文件名，禁止绝对路径、ADS、设备名及子目录逃逸。 */
export function safeLightingBakeChildPath(root: string, name: string): string {
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(name) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) throw new Error('烘焙产物路径不合法。');
  const destination = path.resolve(root, name);
  if (path.dirname(destination) !== path.resolve(root)) throw new Error('烘焙产物超出任务目录。');
  return destination;
}

type SurfaceMapping = { key: string; entityId: string; nodeKey: string };
type SurfacePartition = { leaf: boolean; zero?: SurfacePartition; one?: SurfacePartition };
/** 分片键描述完整二叉空间切分树；资源提交前拒绝缺片、重叠和错误的原表面关联。 */
export function matchLightingBakeSurfaceSources(inputs: readonly LightingBakeMeshInput[], outputs: readonly SurfaceMapping[]): LightingBakeMeshInput[] {
  const receivers = new Map(inputs.filter(mesh => mesh.receiver !== false).map(mesh => [mesh.key, mesh]));
  const partitions = new Map<string, SurfacePartition>(), seen = new Set<string>();
  const fail = (): never => { throw new Error('烘焙表面分片覆盖不完整、重复或源映射不正确。'); };
  const sources = outputs.map(output => {
    if (!output || typeof output.key !== 'string' || seen.has(output.key)) return fail();
    seen.add(output.key);
    const tile = receivers.has(output.key) ? null : /^(.*)\/tile:([01]+)$/.exec(output.key);
    const key = tile ? tile[1] : output.key, source = receivers.get(key);
    if (!source || source.entityId !== output.entityId || source.nodeKey !== output.nodeKey) return fail();
    const root = partitions.get(key) ?? { leaf: false }; partitions.set(key, root);
    let node = root;
    const route = tile?.[2] ?? '';
    if (route.length > 128) return fail();
    for (const bit of route) {
      if (node.leaf) return fail();
      const branch = bit === '0' ? 'zero' : 'one';
      node = node[branch] ??= { leaf: false };
    }
    if (node.leaf || node.zero || node.one) return fail();
    node.leaf = true;
    return source;
  });
  const complete = (node: SurfacePartition): boolean => node.leaf || Boolean(node.zero && node.one && complete(node.zero) && complete(node.one));
  if (partitions.size !== receivers.size || [...partitions.values()].some(node => !complete(node))) fail();
  return sources;
}

function cancelledLightingBake(): Error {
  const error = new Error('光照烘焙已取消。'); error.name = 'AbortError'; return error;
}
/** 取消权限绑定到发起窗口；全局串行避免多个 Cycles 进程争抢显存。 */
export class LightingBakeJobs {
  private readonly jobs = new Map<string, AbortController>();
  private readonly releaseListeners = new Set<() => void>();
  create(owner: number, id: string): AbortController {
    if (this.jobs.size) throw new Error('已有光照烘焙正在运行，请等待完成或取消。');
    const controller = new AbortController(); this.jobs.set(`${owner}:${id}`, controller); return controller;
  }
  /** 已取消的进程仍占用引擎；重试先预约，清理结束才启动，预约本身也受窗口取消约束。 */
  async acquire(owner: number, id: string, lifetime?: AbortSignal): Promise<AbortController> {
    if (lifetime?.aborted) throw cancelledLightingBake();
    if (!this.jobs.size) return this.create(owner, id);
    const key = `${owner}:${id}`;
    if (this.jobs.has(key) || [...this.jobs.values()].some(job => !job.signal.aborted)) {
      throw new Error('已有光照烘焙正在运行，请等待完成或取消。');
    }
    const controller = new AbortController(); this.jobs.set(key, controller);
    const cancel = () => controller.abort();
    lifetime?.addEventListener('abort', cancel, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); this.releaseListeners.delete(check); controller.signal.removeEventListener('abort', check); };
        const check = () => {
          if (controller.signal.aborted) { cleanup(); reject(cancelledLightingBake()); }
          else if (this.jobs.size === 1 && this.jobs.get(key) === controller) { cleanup(); resolve(); }
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error('上次烘焙的进程仍在清理，请稍后重试。')); }, 10_000);
        this.releaseListeners.add(check); controller.signal.addEventListener('abort', check, { once: true }); check();
      });
      return controller;
    } catch (error) {
      this.release(owner, id, controller); throw error;
    } finally {
      lifetime?.removeEventListener('abort', cancel);
    }
  }
  cancel(owner: number, id: string): boolean { const job = this.jobs.get(`${owner}:${id}`); job?.abort(); return !!job; }
  release(owner: number, id: string, controller: AbortController): void {
    const key = `${owner}:${id}`;
    if (this.jobs.get(key) === controller) { this.jobs.delete(key); for (const listener of [...this.releaseListeners]) listener(); }
  }
  cancelAll(): void { for (const job of this.jobs.values()) job.abort(); }
}
