import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertModelSemanticsUnchanged, encodeModelGlb, readModelGlb, validateModelLosslessPolicy } from './phase2AssetSemantics.mjs';

export const MESHOPT_EXTENSION = 'EXT_meshopt_compression';
const MAX_DECODED_BYTES = 512 * 1024 ** 2;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const align4 = value => Math.ceil(value / 4) * 4;
const integer = (value, name, positive = false) => {
  assert.ok(Number.isSafeInteger(value) && value >= (positive ? 1 : 0), name + ' 必须为安全整数。');
  return value;
};
const onlyKeys = (value, allowed, name) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), name + ' 必须为对象。');
  for (const key of Object.keys(value)) assert.ok(allowed.includes(key), name + ' 含未知字段 ' + key);
};

/** 独立解析压缩容器；不使用编码器生成的映射、期望哈希或解码结果。 */
function readCompressedGlb(input) {
  const bytes = Buffer.from(input);
  assert.ok(bytes.length >= 28 && bytes.readUInt32LE(0) === 0x46546c67, '压缩输入不是完整 GLB。');
  assert.equal(bytes.readUInt32LE(4), 2); assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a); assert.equal(jsonLength % 4, 0);
  const binHeader = 20 + jsonLength;
  assert.ok(binHeader + 8 <= bytes.length, '压缩 GLB 缺少 BIN。');
  assert.equal(bytes.readUInt32LE(binHeader + 4), 0x004e4942);
  const binLength = bytes.readUInt32LE(binHeader);
  assert.equal(binLength % 4, 0); assert.equal(binHeader + 8 + binLength, bytes.length);
  const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, binHeader)));
  assert.equal(json.asset?.version, '2.0'); assert.equal(json.buffers?.length, 2, '只接受一个物理 BIN 与一个无 URI fallback buffer。');
  assert.ok(!Object.hasOwn(json.buffers[0], 'uri'));
  const actualLength = integer(json.buffers[0].byteLength, 'BIN buffer.byteLength');
  assert.ok(actualLength <= binLength && binLength - actualLength <= 3);
  onlyKeys(json.buffers[1], ['byteLength', 'extensions'], 'fallback buffer');
  onlyKeys(json.buffers[1].extensions, [MESHOPT_EXTENSION], 'fallback extensions');
  assert.deepEqual(json.buffers[1].extensions[MESHOPT_EXTENSION], { fallback: true });
  const fallbackLength = integer(json.buffers[1].byteLength, 'fallback.byteLength', true);
  assert.ok(fallbackLength <= MAX_DECODED_BYTES, 'fallback 解码范围超过512MiB保守预算。');
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    assert.ok(Array.isArray(json[key]) && json[key].filter(name => name === MESHOPT_EXTENSION).length === 1,
      '压缩候选必须明确 required EXT_meshopt_compression，不能依赖不存在的 raw fallback。');
  }
  return { json, binary: bytes.subarray(binHeader + 8, binHeader + 8 + actualLength), fallbackLength };
}

/** 完整解码每个原逻辑 view，包括 stride padding；不以浮点近似或三角形等价替代字节。 */
export function decodePhase2MeshoptGlb(input, decoder, originalJson) {
  assert.ok(decoder?.supported && typeof decoder.decodeGltfBuffer === 'function', '缺少实际 meshopt decoder。');
  const document = readCompressedGlb(input), json = structuredClone(document.json), data = [];
  let packedBytes = 0, compressedViews = 0;
  assert.equal(json.bufferViews?.length, originalJson.bufferViews?.length, '逻辑 view 索引不可增删。');
  for (const [index, view] of (json.bufferViews ?? []).entries()) {
    const length = integer(view.byteLength, 'bufferView.byteLength');
    assert.ok(length <= MAX_DECODED_BYTES - packedBytes, '完整 view 解码超过512MiB保守预算。');
    let decoded;
    const extension = view.extensions?.[MESHOPT_EXTENSION];
    if (extension) {
      onlyKeys(extension, ['buffer', 'byteOffset', 'byteLength', 'byteStride', 'count', 'mode', 'filter'], 'meshopt view');
      assert.equal(view.buffer, 1); assert.equal(extension.buffer, 0);
      const viewOffset = integer(view.byteOffset ?? 0, 'fallback view.byteOffset');
      assert.ok(viewOffset + length <= document.fallbackLength, 'fallback view 越界。');
      const count = integer(extension.count, 'meshopt.count', true), stride = integer(extension.byteStride, 'meshopt.byteStride', true);
      assert.equal(length, count * stride); assert.ok(Number.isSafeInteger(count * stride));
      if (view.byteStride !== undefined) assert.equal(view.byteStride, stride, '原交错 stride 不可改变。');
      assert.equal(extension.filter ?? 'NONE', 'NONE', '严格无损不允许任何量化 filter。');
      assert.ok(['ATTRIBUTES', 'INDICES'].includes(extension.mode), '禁止会旋转三角索引的 TRIANGLES 或未知 mode。');
      if (extension.mode === 'ATTRIBUTES') assert.ok(stride % 4 === 0 && stride <= 256);
      else assert.ok(stride === 2 || stride === 4);
      const offset = integer(extension.byteOffset ?? 0, 'meshopt.byteOffset'), bytes = integer(extension.byteLength, 'meshopt.byteLength', true);
      assert.ok(offset + bytes <= document.binary.length, 'meshopt 数据越界。');
      decoded = Buffer.alloc(length);
      decoder.decodeGltfBuffer(decoded, count, stride, document.binary.subarray(offset, offset + bytes), extension.mode, 'NONE');
      delete view.extensions[MESHOPT_EXTENSION];
      // 只还原为新增扩展所需的空容器存在性，不复制来源的其它结构，避免掩盖候选错误。
      if (!Object.keys(view.extensions).length && !Object.hasOwn(originalJson.bufferViews[index], 'extensions')) delete view.extensions;
      compressedViews++;
    } else {
      assert.equal(view.buffer, 0, 'raw view 不可引用没有实体字节的 fallback。');
      const offset = integer(view.byteOffset ?? 0, 'raw view.byteOffset');
      assert.ok(offset + length <= document.binary.length, 'raw view 越界。');
      decoded = document.binary.subarray(offset, offset + length);
    }
    data.push({ offset: packedBytes, bytes: decoded });
    view.buffer = 0; view.byteOffset = packedBytes; packedBytes = align4(packedBytes + length);
  }
  assert.ok(compressedViews > 0, '候选没有实际压缩 view。');
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    json[key] = json[key].filter(name => name !== MESHOPT_EXTENSION);
    if (!json[key].length && !Object.hasOwn(originalJson, key)) delete json[key];
  }
  json.buffers.pop(); json.buffers[0].byteLength = packedBytes;
  const binary = Buffer.alloc(packedBytes); for (const item of data) item.bytes.copy(binary, item.offset);
  validateModelLosslessPolicy(json);
  return { bytes: encodeModelGlb(json, binary), compressedViews, viewSha256: data.map(item => sha(item.bytes)) };
}

/** 两套实际 decoder 各自还原后通过原独立逻辑/完整 view/image/accessor oracle。 */
export function assertPhase2MeshoptLossless(before, after, decoders) {
  const original = readModelGlb(before); validateModelLosslessPolicy(original.json);
  assert.ok(decoders.length >= 2, '至少需要工具链decoder与产品0.20 decoder两份独立验收。');
  const proofs = [];
  for (const { name, decoder } of decoders) {
    const decoded = decodePhase2MeshoptGlb(after, decoder, original.json);
    assertModelSemanticsUnchanged(before, decoded.bytes);
    if (proofs.length) assert.deepEqual(decoded.viewSha256, proofs[0].viewSha256, '两套decoder逐view完整字节必须一致。');
    proofs.push({ name, compressedViews: decoded.compressedViews, viewSha256: decoded.viewSha256 });
  }
  return proofs;
}
