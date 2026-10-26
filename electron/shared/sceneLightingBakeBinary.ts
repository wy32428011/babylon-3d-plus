import type { LightingBakeInput, LightingBakeMeshInput } from './sceneLightingBakeContract.ts';
const fields = ['positions','normals','indices','uvs','uvs2','colors','tangents'] as const;
type Field = typeof fields[number];
export type LightingBakeBinaryAttribute = { byteOffset: number; length: number; type: 'float64' | 'uint32' };
export type LightingBakeBinaryMesh = { key: string; bytes: ArrayBuffer; attributes: Partial<Record<Field, LightingBakeBinaryAttribute>> };
export type LightingBakeBinaryInput = { version: 2; input: Omit<LightingBakeInput, 'meshes'> & { meshes: Omit<LightingBakeMeshInput, Field>[] }; geometry: LightingBakeBinaryMesh[];
  /** 仅内部IPC去重；恢复原URL后仍走完整校验/授权/字节预算。旧请求不补此字段。 */
  textureTable?: { version: 1; urls: string[] } };
const magic = [66,76,71,69,79,48,48,49];
const textureReferencePrefix = 'lighting-texture-ref://v1/';
const maxTextureTableUrls = 16384, maxTextureTableCharacters = 512 * 1024 * 1024;
type MetadataInput = LightingBakeBinaryInput['input'];

/** 只改已知纹理URL槽；几何、材质参数和原对象均不变，不做全树克隆。 */
function mapTextureUrls(input: MetadataInput, map: (url: string) => string): MetadataInput {
  const meshes = input.meshes.map(mesh => {
    const textures = mesh.material?.textures;
    if (!textures) return mesh;
    let changed = false;
    const mapped = Object.fromEntries(Object.entries(textures).map(([kind, texture]) => {
      if (!texture || typeof texture.url !== 'string') return [kind, texture];
      const url = map(texture.url);
      if (url === texture.url) return [kind, texture];
      changed = true; return [kind, { ...texture, url }];
    }));
    return changed ? { ...mesh, material: { ...mesh.material, textures: mapped } } : mesh;
  });
  const url = input.environment?.textureUrl;
  const mappedUrl = typeof url === 'string' ? map(url) : url;
  return { ...input, meshes, ...(mappedUrl !== url ? { environment: { ...input.environment, textureUrl: mappedUrl } } : {}) };
}

function deduplicateTextureUrls(input: MetadataInput): { input: MetadataInput; textureTable?: LightingBakeBinaryInput['textureTable'] } {
  const counts = new Map<string, number>();
  mapTextureUrls(input, url => { counts.set(url, (counts.get(url) ?? 0) + 1); return url; });
  const urls = [...counts].filter(([url, count]) => count > 1 && url.length > 128).map(([url]) => url);
  if (!urls.length) return { input };
  const indices = new Map(urls.map((url, index) => [url, index]));
  const mapped = mapTextureUrls(input, url => indices.has(url) ? textureReferencePrefix + indices.get(url) : url);
  return { input: mapped, textureTable: { version: 1, urls } };
}

function restoreTextureUrls(data: LightingBakeBinaryInput): MetadataInput {
  const table = data.textureTable, used = new Set<number>();
  if (table !== undefined) {
    if (!table || table.version !== 1 || Object.keys(table).some(key => key !== 'version' && key !== 'urls')
      || !Array.isArray(table.urls) || !table.urls.length || table.urls.length > maxTextureTableUrls) throw new Error('烘焙纹理字典版本或数量无效。');
    let characters = 0;
    const seen = new Set<string>();
    for (const url of table.urls) {
      if (typeof url !== 'string' || (!url.startsWith('editor-asset://local/') && !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(url))
        || seen.has(url)) throw new Error('烘焙纹理字典含无效或重复URL。');
      seen.add(url); characters += url.length;
      if (characters > maxTextureTableCharacters) throw new Error('烘焙纹理字典超过有界传输预算。');
    }
  }
  const input = mapTextureUrls(data.input, url => {
    if (!url.startsWith('lighting-texture-ref:')) return url;
    const match = /^lighting-texture-ref:\/\/v1\/(0|[1-9]\d*)$/.exec(url);
    const index = match ? Number(match[1]) : -1;
    if (!table || !Number.isSafeInteger(index) || index < 0 || index >= table.urls.length) throw new Error('烘焙纹理字典引用缺失、越界或版本无效。');
    used.add(index); return table.urls[index];
  });
  if (table && used.size !== table.urls.length) throw new Error('烘焙纹理字典含未使用的输入。');
  return input;
}
/** 数值保持 Float64 精度，索引保持 Uint32；不把大型数字数组写进 JSON。 */
export function encodeLightingBakeTransport(input: LightingBakeInput, options: { deduplicateTextureUrls?: boolean } = {}): LightingBakeBinaryInput {
  const geometry: LightingBakeBinaryMesh[] = [];
  const meshes = input.meshes.map(mesh => {
    let size = 8;
    const attributes: LightingBakeBinaryMesh['attributes'] = {};
    for (const field of fields) if (mesh[field] !== undefined) {
      size = Math.ceil(size / 8) * 8; attributes[field] = { byteOffset: size, length: mesh[field]!.length, type: field === 'indices' ? 'uint32' : 'float64' };
      size += mesh[field]!.length * (field === 'indices' ? 4 : 8);
    }
    const bytes = new ArrayBuffer(size), view = new DataView(bytes); new Uint8Array(bytes).set(magic);
    const metadata = { ...mesh };
    for (const field of fields) {
      const attribute = attributes[field], values = mesh[field];
      if (attribute && values) for (let index = 0; index < values.length; index++) {
        const value = values[index];
        if (!Number.isFinite(value) || field === 'indices' && (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) throw new Error('烘焙二进制几何含无效数字或索引。');
        if (field === 'indices') view.setUint32(attribute.byteOffset + index * 4, value, true);
        else view.setFloat64(attribute.byteOffset + index * 8, value, true);
      }
      delete metadata[field];
    }
    geometry.push({ key: mesh.key, bytes, attributes }); return metadata;
  });
  // 磁盘准备也复用此encoder，只有renderer显式请求IPC优化；默认旧输出保持原样。
  const metadata = { ...input, meshes };
  return { version: 2, ...(options.deduplicateTextureUrls ? deduplicateTextureUrls(metadata) : { input: metadata }), geometry };
}
export function decodeLightingBakeTransport(value: unknown): LightingBakeInput {
  const data = value as LightingBakeBinaryInput;
  if (!data || data.version !== 2 || !data.input || !Array.isArray(data.input.meshes) || !Array.isArray(data.geometry) || data.geometry.length !== data.input.meshes.length) throw new Error('烘焙二进制请求版本或映射无效。');
  const input = restoreTextureUrls(data);
  const byKey = new Map<string, LightingBakeBinaryMesh>();
  for (const geometry of data.geometry) {
    if (!geometry || typeof geometry.key !== 'string' || byKey.has(geometry.key) || !(geometry.bytes instanceof ArrayBuffer) || geometry.bytes.byteLength < 8 || !geometry.attributes
      || magic.some((byte,index) => new Uint8Array(geometry.bytes)[index] !== byte)) throw new Error('烘焙二进制几何头或映射无效。');
    byKey.set(geometry.key, geometry);
  }
  const meshes = input.meshes.map(metadata => {
    const geometry = byKey.get(metadata.key);
    if (!geometry) throw new Error('烘焙二进制网格映射缺失。');
    byKey.delete(metadata.key);
    const mesh = { ...metadata } as LightingBakeMeshInput, view = new DataView(geometry.bytes), ranges: Array<[number,number]> = [];
    for (const field of fields) {
      const attribute = geometry.attributes[field];
      if (!attribute) continue;
      const width = field === 'indices' ? 4 : 8;
      if (attribute.type !== (field === 'indices' ? 'uint32' : 'float64') || !Number.isSafeInteger(attribute.byteOffset) || attribute.byteOffset < 8 || attribute.byteOffset % width || !Number.isSafeInteger(attribute.length) || attribute.length < 0
        || attribute.byteOffset + attribute.length * width > geometry.bytes.byteLength || ranges.some(([start,end]) => attribute.byteOffset < end && attribute.byteOffset + attribute.length * width > start)) throw new Error('烘焙二进制属性偏移或长度无效。');
      ranges.push([attribute.byteOffset, attribute.byteOffset + attribute.length * width]);
      mesh[field] = Array.from({length:attribute.length}, (_,index) => field === 'indices' ? view.getUint32(attribute.byteOffset + index * width,true) : view.getFloat64(attribute.byteOffset + index * width,true));
    }
    return mesh;
  });
  return { ...input, meshes };
}
