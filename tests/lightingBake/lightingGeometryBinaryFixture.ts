/** 按公开容器合同独立构造夹具；不调用产品编码器。 */
export const geometryFixture = { version: 2 as const, key: 'a/root', positions: [-0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 0, 1], bakeUvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };
export type MutableBinaryHeader = { version: number; geometryVersion: unknown; key: unknown; vertexCount: number; indexCount: number;
  attributes: Record<string, { type: string; components: number; count: number; byteOffset: number; [key: string]: unknown }>; [key: string]: unknown };
export function binaryFixture(geometry: Record<string, unknown> = geometryFixture, mutate?: (header: MutableBinaryHeader) => void): Uint8Array {
  const attributes: MutableBinaryHeader['attributes'] = {};
  const widths: Record<string, number> = { positions: 3, normals: 3, uvs: 2, uvs2: 2, colors: 4, tangents: 4, bakeUvs: 2, indices: 1 };
  const fields = Object.keys(widths).filter(field => geometry[field] !== undefined);
  const header = { version: 1, geometryVersion: geometry.version, key: geometry.key ?? 'a/root', vertexCount: (geometry.positions as number[]).length / 3,
    indexCount: (geometry.indices as number[]).length, attributes };
  let start = 12, text = new Uint8Array();
  for (let attempt = 0; attempt < 20; attempt++) {
    let offset = start;
    for (const field of fields) {
      const values = geometry[field] as number[];
      attributes[field] = { type: field === 'indices' ? 'uint32' : 'float32', components: widths[field], count: values.length, byteOffset: offset };
      offset += values.length * 4;
    }
    text = new TextEncoder().encode(JSON.stringify(header));
    const next = Math.ceil((12 + text.length) / 4) * 4;
    if (next === start) break;
    start = next;
  }
  // mutation仅用于构造坏头，不重新修正描述符，避免负例被fixture自动修好。
  if (mutate) { mutate(header); text = new TextEncoder().encode(JSON.stringify(header)); }
  const data = new Uint8Array(Math.max(start + fields.reduce((count, field) => count + (geometry[field] as number[]).length * 4, 0), 12 + text.length));
  data.set(new TextEncoder().encode('BLGOUT01')); new DataView(data.buffer).setUint32(8, text.length, true); data.set(text, 12);
  if (!mutate) {
    const view = new DataView(data.buffer);
    for (const field of fields) (geometry[field] as number[]).forEach((value, index) => {
      if (field === 'indices') view.setUint32(attributes[field].byteOffset + index * 4, value, true);
      else view.setFloat32(attributes[field].byteOffset + index * 4, value, true);
    });
  }
  return data;
}
