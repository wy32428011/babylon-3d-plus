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
const vertexFields = fields.filter(field => field !== 'indices') as Array<Exclude<Field, 'indices'>>;

/** TypedArray 整段拷贝到目标视图；number[] 保留逐元素校验写入，兼容旧 JSON 输入。 */
function writeBinaryValues(buffer: ArrayBuffer, type: LightingBakeBinaryAttribute['type'], values: ArrayLike<number>, byteOffset: number): void {
  const count = values.length;
  if (type === 'uint32') {
    const target = new Uint32Array(buffer, byteOffset, count);
    if (values instanceof Uint32Array || values instanceof Uint16Array || values instanceof Uint8Array) { target.set(values); return; }
    if (values instanceof Int32Array || values instanceof Int16Array || values instanceof Int8Array) {
      if (!values.every(value => value >= 0)) throw new Error('烘焙二进制几何含无效数字或索引。');
      target.set(values); return;
    }
    for (let index = 0; index < count; index++) {
      const value = values[index];
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('烘焙二进制几何含无效数字或索引。');
      target[index] = value;
    }
    return;
  }
  const target = new Float64Array(buffer, byteOffset, count);
  if (values instanceof Float64Array || values instanceof Float32Array) {
    if (!values.every(value => Number.isFinite(value))) throw new Error('烘焙二进制几何含无效数字或索引。');
    target.set(values); return;
  }
  if (ArrayBuffer.isView(values) && !(values instanceof DataView)) { target.set(values as ArrayLike<number>); return; }
  for (let index = 0; index < count; index++) {
    const value = values[index];
    if (!Number.isFinite(value)) throw new Error('烘焙二进制几何含无效数字或索引。');
    target[index] = value;
  }
}

/** 数值保持 Float64 精度，索引保持 Uint32；不把大型数字数组写进 JSON。
 * 同一源网格派生的 primitive 共享顶点属性引用：全部记录指向同一个 ArrayBuffer，
 * 顶点数据只编码一次，结构化克隆按引用去重，文件落地时也只写一份。 */
export function encodeLightingBakeTransport(input: LightingBakeInput, options: { deduplicateTextureUrls?: boolean } = {}): LightingBakeBinaryInput {
  const geometry: LightingBakeBinaryMesh[] = [];
  const groupsByPositions = new Map<ArrayLike<number>, LightingBakeMeshInput[][]>();
  for (const mesh of input.meshes) {
    const candidates = groupsByPositions.get(mesh.positions) ?? [];
    const group = candidates.find(candidate => vertexFields.every(field => candidate[0][field] === mesh[field]));
    if (group) group.push(mesh); else candidates.push([mesh]);
    groupsByPositions.set(mesh.positions, candidates);
  }
  const meshes: Array<Omit<LightingBakeMeshInput, Field>> = [];
  for (const groups of groupsByPositions.values()) for (const group of groups) {
    // 顶点属性按引用去重后先写入共享区，每条记录再追加自己的 indices。
    const sharedOffsets = new Map<ArrayLike<number>, LightingBakeBinaryAttribute>();
    let size = 8;
    const layout = (values: ArrayLike<number>, field: Field): LightingBakeBinaryAttribute => {
      const width = field === 'indices' ? 4 : 8;
      size = Math.ceil(size / width) * width;
      const attribute = { byteOffset: size, length: values.length, type: (field === 'indices' ? 'uint32' : 'float64') as LightingBakeBinaryAttribute['type'] };
      size += values.length * width;
      return attribute;
    };
    for (const mesh of group) for (const field of vertexFields) {
      const values = mesh[field];
      if (values !== undefined && !sharedOffsets.has(values)) sharedOffsets.set(values, layout(values, field));
    }
    const recordAttributes = group.map(mesh => {
      const attributes: LightingBakeBinaryMesh['attributes'] = {};
      for (const field of vertexFields) if (mesh[field] !== undefined) attributes[field] = sharedOffsets.get(mesh[field]!);
      if (mesh.indices !== undefined) attributes.indices = layout(mesh.indices, 'indices');
      return attributes;
    });
    const bytes = new ArrayBuffer(size); new Uint8Array(bytes).set(magic);
    for (const [values, attribute] of sharedOffsets) {
      writeBinaryValues(bytes, attribute.type, values, attribute.byteOffset);
    }
    group.forEach((mesh, index) => {
      const attribute = recordAttributes[index].indices;
      if (attribute) writeBinaryValues(bytes, attribute.type, mesh.indices, attribute.byteOffset);
      geometry.push({ key: mesh.key, bytes, attributes: recordAttributes[index] });
      const metadata = { ...mesh } as Omit<LightingBakeMeshInput, Field>;
      for (const field of fields) delete (metadata as Partial<LightingBakeMeshInput>)[field];
      meshes.push(metadata);
    });
  }
  // 磁盘准备也复用此encoder，只有renderer显式请求IPC优化；默认旧输出保持原样。
  const metadata = { ...input, meshes };
  return { version: 2, ...(options.deduplicateTextureUrls ? deduplicateTextureUrls(metadata) : { input: metadata }), geometry };
}
export function decodeLightingBakeTransport(value: unknown, _options: { views?: boolean } = {}): LightingBakeInput {
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
    const mesh = { ...metadata } as LightingBakeMeshInput, ranges: Array<[number,number]> = [];
    for (const field of fields) {
      const attribute = geometry.attributes[field];
      if (!attribute) continue;
      const width = field === 'indices' ? 4 : 8;
      const end = attribute.byteOffset + attribute.length * width;
      if (attribute.type !== (field === 'indices' ? 'uint32' : 'float64') || !Number.isSafeInteger(attribute.byteOffset) || attribute.byteOffset < 8 || attribute.byteOffset % width || !Number.isSafeInteger(attribute.length) || attribute.length < 0
        || end > geometry.bytes.byteLength || ranges.some(([start, stop]) => attribute.byteOffset < stop && end > start && (start !== attribute.byteOffset || stop !== end))) throw new Error('烘焙二进制属性偏移或长度无效。');
      ranges.push([attribute.byteOffset, end]);
      // 主进程只在已校验的边界上建零拷贝视图；大场景不再物化为 number[]。
      mesh[field] = field === 'indices'
        ? new Uint32Array(geometry.bytes, attribute.byteOffset, attribute.length)
        : new Float64Array(geometry.bytes, attribute.byteOffset, attribute.length);
    }
    return mesh;
  });
  return { ...input, meshes };
}
