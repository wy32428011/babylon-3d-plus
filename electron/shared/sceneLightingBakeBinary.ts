import type { LightingBakeInput, LightingBakeMeshInput } from './sceneLightingBakeContract.ts';
const fields = ['positions','normals','indices','uvs','uvs2','colors','tangents'] as const;
type Field = typeof fields[number];
export type LightingBakeBinaryAttribute = { byteOffset: number; length: number; type: 'float64' | 'uint32' };
export type LightingBakeBinaryMesh = { key: string; bytes: ArrayBuffer; attributes: Partial<Record<Field, LightingBakeBinaryAttribute>> };
export type LightingBakeBinaryInput = { version: 2; input: Omit<LightingBakeInput, 'meshes'> & { meshes: Omit<LightingBakeMeshInput, Field>[] }; geometry: LightingBakeBinaryMesh[] };
const magic = [66,76,71,69,79,48,48,49];
/** 数值保持 Float64 精度，索引保持 Uint32；不把大型数字数组写进 JSON。 */
export function encodeLightingBakeTransport(input: LightingBakeInput): LightingBakeBinaryInput {
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
  return { version: 2, input: { ...input, meshes }, geometry };
}
export function decodeLightingBakeTransport(value: unknown): LightingBakeInput {
  const data = value as LightingBakeBinaryInput;
  if (!data || data.version !== 2 || !data.input || !Array.isArray(data.input.meshes) || !Array.isArray(data.geometry) || data.geometry.length !== data.input.meshes.length) throw new Error('烘焙二进制请求版本或映射无效。');
  const byKey = new Map<string, LightingBakeBinaryMesh>();
  for (const geometry of data.geometry) {
    if (!geometry || typeof geometry.key !== 'string' || byKey.has(geometry.key) || !(geometry.bytes instanceof ArrayBuffer) || geometry.bytes.byteLength < 8 || !geometry.attributes
      || magic.some((byte,index) => new Uint8Array(geometry.bytes)[index] !== byte)) throw new Error('烘焙二进制几何头或映射无效。');
    byKey.set(geometry.key, geometry);
  }
  const meshes = data.input.meshes.map(metadata => {
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
  return { ...data.input, meshes };
}
