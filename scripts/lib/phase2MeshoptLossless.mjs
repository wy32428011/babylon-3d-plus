import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeModelGlb, modelLosslessSnapshot, readModelGlb, validateModelLosslessPolicy } from './phase2AssetSemantics.mjs';
import { assertPhase2MeshoptLossless, MESHOPT_EXTENSION } from './phase2MeshoptOracle.mjs';

const align4 = value => Math.ceil(value / 4) * 4;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const COMPONENT_SIZE = new Map([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]]);
const COMPONENTS = new Map([['SCALAR', 1], ['VEC2', 2], ['VEC3', 3], ['VEC4', 4], ['MAT2', 4], ['MAT3', 9], ['MAT4', 16]]);

/** 仅选择合法整 view 字节布局；无合法stride的视图保持raw，绝不补改原有效字节。 */
function attributeStride(json, index, length) {
  const declared = json.bufferViews[index].byteStride;
  if (declared !== undefined) return Number.isInteger(declared) && declared > 0 && declared <= 256 && declared % 4 === 0 && length % declared === 0 ? declared : null;
  const layouts = (json.accessors ?? []).filter(accessor => accessor.bufferView === index)
    .map(accessor => COMPONENT_SIZE.get(accessor.componentType) * COMPONENTS.get(accessor.type));
  const natural = layouts[0];
  if (layouts.length && layouts.every(value => value === natural) && natural > 0 && natural <= 256 && natural % 4 === 0 && length % natural === 0) return natural;
  return length % 4 === 0 ? 4 : null;
}

function exactIndexStride(json, index, length) {
  const view = json.bufferViews[index];
  if (view.byteStride !== undefined) return null;
  const users = (json.accessors ?? []).map((value, accessor) => ({ ...value, accessor })).filter(value => value.bufferView === index);
  if (!users.length || users.some(value => value.type !== 'SCALAR' || ![5123, 5125].includes(value.componentType) || value.sparse
    || (value.byteOffset ?? 0) !== 0 || value.count * COMPONENT_SIZE.get(value.componentType) !== length)) return null;
  const indices = new Set((json.meshes ?? []).flatMap(mesh => mesh.primitives ?? []).map(primitive => primitive.indices));
  if (users.some(value => !indices.has(value.accessor) || value.componentType !== users[0].componentType)) return null;
  return COMPONENT_SIZE.get(users[0].componentType);
}

/** 独立可选存储候选：不量化/重排/去重逻辑索引，不接入现有生产优化器。 */
export function optimizePhase2MeshoptLossless(input, { encoder, decoders }) {
  const before = Buffer.from(input), document = readModelGlb(before);
  validateModelLosslessPolicy(document.json); modelLosslessSnapshot(before);
  assert.ok(encoder?.supported && typeof encoder.encodeGltfBuffer === 'function', '缺少固定0.23实际encoder。');
  const json = structuredClone(document.json), segments = [], rows = [];
  let actualBytes = 0, fallbackBytes = 0, compressedViews = 0;
  for (const [index, view] of (json.bufferViews ?? []).entries()) {
    assert.equal(view.buffer, 0);
    const original = document.binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    let encoded = null, layout = null;
    // 图片由自身PNG/JPEG/KTX等格式压缩，保留其原view字节；不把它误当索引或顶点。
    const image = (json.images ?? []).some(value => value.bufferView === index);
    if (original.length && !image) {
      const candidates = [], indexStride = exactIndexStride(json, index, original.length), stride = attributeStride(json, index, original.length);
      if (indexStride) candidates.push({ mode: 'INDICES', stride: indexStride });
      if (stride) candidates.push({ mode: 'ATTRIBUTES', stride });
      for (const candidate of candidates) {
        // 独立复制输入，避免任何第三方实现意外改写原GLB；不转换成浮点数。
        const bytes = encoder.encodeGltfBuffer(new Uint8Array(original), original.length / candidate.stride, candidate.stride, candidate.mode);
        assert.ok(bytes instanceof Uint8Array && bytes.length > 0, 'encoder未返回实际压缩字节。');
        if (!encoded || bytes.length < encoded.length) { encoded = Buffer.from(bytes); layout = candidate; }
      }
    }
    // 包含新增JSON开销的整体收益最后判断；单view膨胀先保持raw。
    if (encoded && encoded.length < original.length) {
      view.buffer = 1; view.byteOffset = fallbackBytes; fallbackBytes = align4(fallbackBytes + original.length);
      view.extensions = { ...view.extensions, [MESHOPT_EXTENSION]: { buffer: 0, byteOffset: actualBytes,
        byteLength: encoded.length, byteStride: layout.stride, count: original.length / layout.stride, mode: layout.mode, filter: 'NONE' } };
      compressedViews++;
    } else {
      encoded = original; layout = null; view.byteOffset = actualBytes;
    }
    segments.push({ offset: actualBytes, bytes: encoded }); actualBytes = align4(actualBytes + encoded.length);
    rows.push({ index, originalBytes: original.length, storedBytes: encoded.length, mode: layout?.mode ?? 'RAW',
      stride: layout?.stride ?? null, originalSha256: sha(original), filter: 'NONE' });
  }
  if (!compressedViews) return { bytes: before, improved: false, reason: 'no-eligible-smaller-view', rows, compressedViews: 0, proofs: [] };
  json.buffers[0].byteLength = actualBytes;
  json.buffers.push({ byteLength: fallbackBytes, extensions: { [MESHOPT_EXTENSION]: { fallback: true } } });
  for (const key of ['extensionsUsed', 'extensionsRequired']) json[key] = [...(json[key] ?? []), MESHOPT_EXTENSION];
  const binary = Buffer.alloc(actualBytes); for (const entry of segments) entry.bytes.copy(binary, entry.offset);
  const candidate = encodeModelGlb(json, binary);
  const proofs = assertPhase2MeshoptLossless(before, candidate, decoders);
  const improved = candidate.length < before.length;
  return { bytes: improved ? candidate : before, improved, reason: improved ? 'byte-exact-dual-decoder' : 'whole-glb-not-smaller',
    candidateBytes: candidate.length, originalBytes: before.length, compressedViews, rows, proofs,
    preservedLogicalOrder: true, quantization: false, filters: false, triangleCodec: false };
}
