import { validateLightingGeometry } from './sceneLightingBakeArtifacts.ts';
import type { LightingBakeGeometry } from './sceneLightingBakeContract.ts';
import type { LightingGeometryEncoding } from './sceneLightingBakeData.ts';

const MAGIC = 'BLGOUT01', HEADER_LIMIT = 65536;
const WIDTHS = { positions: 3, normals: 3, uvs: 2, uvs2: 2, colors: 4, tangents: 4, bakeUvs: 2, indices: 1 } as const;
type Field = keyof typeof WIDTHS;
const FIELDS = Object.keys(WIDTHS) as Field[];
const OPTIONAL = new Set<Field>(['uvs2', 'colors', 'tangents']);
type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: RecordValue, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function invalid(): never { throw new Error('光照二进制几何头、布局或数据无效。'); }
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** 输出容器与输入 Float64 附件相互独立；只在全部布局验证后暴露有界视图。 */
export function decodeLightingGeometryBinary(bytes: Uint8Array): { geometry: LightingBakeGeometry; storage: 'view' | 'aligned-copy' | 'endian-copy' } {
  if (bytes.byteLength < 12 || ![...MAGIC].every((value, index) => bytes[index] === value.charCodeAt(0))) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = view.getUint32(8, true);
  if (!length || length > HEADER_LIMIT || 12 + length > bytes.byteLength) invalid();
  const header: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(12, 12 + length)));
  if (!object(header) || !exactKeys(header, ['version', 'geometryVersion', 'key', 'vertexCount', 'indexCount', 'attributes'])
    || header.version !== 1 || header.geometryVersion !== 2 || typeof header.key !== 'string' || !header.key || header.key.length > 4096 || header.key.includes('\0')
    || !positiveInteger(header.vertexCount) || !positiveInteger(header.indexCount) || header.indexCount % 3 || !object(header.attributes)) invalid();
  const attributes = header.attributes as RecordValue;
  const fields = FIELDS.filter(field => Object.hasOwn(attributes, field));
  if (!exactKeys(attributes, fields) || FIELDS.some(field => !OPTIONAL.has(field) && !Object.hasOwn(attributes, field))) invalid();
  let end = Math.ceil((12 + length) / 4) * 4;
  if (end > bytes.byteLength || bytes.subarray(12 + length, end).some(value => value !== 0)) invalid();
  const layouts: Array<{ field: Field; count: number; offset: number }> = [];
  for (const field of fields) {
    const attribute = attributes[field];
    const expectedCount = field === 'indices' ? header.indexCount : header.vertexCount * WIDTHS[field];
    if (!Number.isSafeInteger(expectedCount) || !object(attribute) || !exactKeys(attribute, ['type', 'components', 'count', 'byteOffset'])
      || attribute.type !== (field === 'indices' ? 'uint32' : 'float32') || attribute.components !== WIDTHS[field]
      || !positiveInteger(attribute.count) || attribute.count !== expectedCount || !Number.isSafeInteger(attribute.byteOffset)
      || attribute.byteOffset !== end || end % 4 || !Number.isSafeInteger(attribute.count * 4 + end) || attribute.count * 4 > bytes.byteLength - end) invalid();
    layouts.push({ field, count: attribute.count as number, offset: end });
    end += (attribute.count as number) * 4;
  }
  if (end !== bytes.byteLength) invalid();
  // Node Buffer/子视图不一定四字节对齐；只复制当前文件范围，不暴露 backing 中其它文件。
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : new Uint8Array(bytes);
  const storage = !littleEndian ? 'endian-copy' : aligned === bytes ? 'view' : 'aligned-copy';
  const geometry = { version: 2 } as LightingBakeGeometry;
  for (const { field, count, offset } of layouts) {
    let data: Float32Array | Uint32Array;
    if (littleEndian) data = field === 'indices'
      ? new Uint32Array(aligned.buffer, aligned.byteOffset + offset, count)
      : new Float32Array(aligned.buffer, aligned.byteOffset + offset, count);
    else {
      data = field === 'indices' ? new Uint32Array(count) : new Float32Array(count);
      for (let index = 0; index < count; index++) data[index] = field === 'indices' ? view.getUint32(offset + index * 4, true) : view.getFloat32(offset + index * 4, true);
    }
    if (field === 'indices') geometry.indices = data as Uint32Array;
    else geometry[field] = data as Float32Array;
  }
  return { geometry: validateLightingGeometry(geometry), storage };
}

/** 清单显式选择格式，旧省略继续 JSON；不通过魔数猜测或容错降级。 */
export function decodeLightingGeometryResource(bytes: Uint8Array, encoding?: LightingGeometryEncoding): LightingBakeGeometry {
  if (encoding === 'binary-v1') return decodeLightingGeometryBinary(bytes).geometry;
  if (encoding !== undefined && encoding !== 'json') invalid();
  return validateLightingGeometry(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
