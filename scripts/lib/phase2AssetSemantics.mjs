import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;
const COMPONENT_BYTES = new Map([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]]);
const VECTOR_COMPONENTS = new Map([['SCALAR', 1], ['VEC2', 2], ['VEC3', 3], ['VEC4', 4]]);
const MATRIX_DIMENSIONS = new Map([['MAT2', 2], ['MAT3', 3], ['MAT4', 4]]);
const KNOWN_EXTENSIONS = new Set(['KHR_lights_punctual', 'KHR_materials_unlit', 'KHR_materials_pbrSpecularGlossiness',
  'KHR_materials_clearcoat', 'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_sheen',
  'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_iridescence',
  'KHR_materials_anisotropy', 'KHR_materials_dispersion', 'KHR_texture_transform', 'KHR_texture_basisu',
  'EXT_texture_webp', 'EXT_texture_avif', 'EXT_mesh_gpu_instancing']);
const MAX_ACCESSOR_BYTES = 128 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const align4 = size => Math.ceil(size / 4) * 4;
const integer = (value, name) => { assert.ok(Number.isSafeInteger(value) && value >= 0, `${name} 必须为非负安全整数。`); return value; };

/** 只解析完整单文件 GLB；未知块不能在重写时静默丢失。 */
export function readModelGlb(input) {
  const bytes = Buffer.from(input);
  assert.ok(bytes.length >= 20 && bytes.readUInt32LE(0) === 0x46546c67, '输入不是完整 GLB。');
  assert.equal(bytes.readUInt32LE(4), 2, '只支持 GLB 2。');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB 声明长度与实际字节不符。');
  const chunks = [];
  for (let offset = 12; offset < bytes.length;) {
    assert.ok(offset + 8 <= bytes.length, 'GLB 块头截断。');
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    assert.equal(length % 4, 0, 'GLB 块必须四字节对齐。');
    assert.ok(offset + 8 + length <= bytes.length, 'GLB 块越界。');
    chunks.push({ type, bytes: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 8 + length;
  }
  assert.ok(chunks.length >= 1 && chunks.length <= 2 && chunks[0].type === JSON_CHUNK
    && (chunks.length === 1 || chunks[1].type === BIN_CHUNK), '存在未知/重复 GLB 块，拒绝丢失数据。');
  const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(chunks[0].bytes));
  assert.equal(json.asset?.version, '2.0', '只支持 glTF 2.0。');
  const binary = chunks[1]?.bytes ?? Buffer.alloc(0);
  assert.ok((json.buffers?.length ?? 0) <= 1, '严格无损模式只支持一个内嵌 buffer。');
  if (json.buffers?.length) {
    assert.ok(!Object.hasOwn(json.buffers[0], 'uri'), '严格无损模式不读取外部或 data URI buffer。');
    const length = integer(json.buffers[0].byteLength, 'buffer.byteLength');
    assert.ok(length <= binary.length && binary.length - length <= 3, 'BIN 与 buffer 长度不符。');
  } else assert.equal(binary.length, 0, 'BIN 缺少对应 buffer 定义。');
  return { json, binary };
}

function stringifyModelJson(value) {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), '模型 JSON 数值必须有限。');
    return Object.is(value, -0) ? '-0' : JSON.stringify(value);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stringifyModelJson).join(',') + ']';
  assert.ok(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), '模型 JSON 必须为普通数据。');
  return '{' + Object.entries(value).map(([key, item]) => JSON.stringify(key) + ':' + stringifyModelJson(item)).join(',') + '}';
}

export function encodeModelGlb(json, binary) {
  // JSON.stringify 会把可观察的 -0 变为 +0；元数据也必须保持其原数值语义。
  const source = Buffer.from(stringifyModelJson(json)), jsonLength = align4(source.length), binaryLength = align4(binary.length);
  const bytes = Buffer.alloc(20 + jsonLength + (binaryLength ? 8 + binaryLength : 0));
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonLength, 12); bytes.writeUInt32LE(JSON_CHUNK, 16);
  bytes.fill(0x20, 20, 20 + jsonLength); source.copy(bytes, 20);
  if (binaryLength) {
    bytes.writeUInt32LE(binaryLength, 20 + jsonLength); bytes.writeUInt32LE(BIN_CHUNK, 24 + jsonLength);
    Buffer.from(binary).copy(bytes, 28 + jsonLength);
  }
  return bytes;
}

/** 只接受已明确理解的标准依赖；未知 extras 可能含自定义地址，不能推断其纯净性。 */
export function validateModelLosslessPolicy(json) {
  const keys = (object, allowed, location) => {
    if (!object) return;
    for (const key of Object.keys(object)) assert.ok(allowed.includes(key), `${location}.${key} 为未知属性，保留原资产。`);
  };
  keys(json, ['asset', 'scene', 'scenes', 'nodes', 'meshes', 'skins', 'animations', 'cameras', 'materials', 'samplers',
    'textures', 'images', 'accessors', 'bufferViews', 'buffers', 'extensionsUsed', 'extensionsRequired', 'extensions', 'extras'], 'glTF');
  keys(json.asset, ['copyright', 'generator', 'version', 'minVersion', 'extensions', 'extras'], 'asset');
  const tables = {
    scenes: ['nodes', 'name'], nodes: ['camera', 'children', 'skin', 'matrix', 'mesh', 'rotation', 'scale', 'translation', 'weights', 'name'],
    meshes: ['primitives', 'weights', 'name'], skins: ['inverseBindMatrices', 'skeleton', 'joints', 'name'],
    animations: ['channels', 'samplers', 'name'], cameras: ['orthographic', 'perspective', 'type', 'name'],
    materials: ['pbrMetallicRoughness', 'normalTexture', 'occlusionTexture', 'emissiveTexture', 'emissiveFactor', 'alphaMode', 'alphaCutoff', 'doubleSided', 'name'],
    samplers: ['magFilter', 'minFilter', 'wrapS', 'wrapT', 'name'], textures: ['sampler', 'source', 'name'],
    images: ['bufferView', 'mimeType', 'uri', 'name'], accessors: ['bufferView', 'byteOffset', 'componentType', 'normalized', 'count', 'type', 'max', 'min', 'sparse', 'name'],
    bufferViews: ['buffer', 'byteOffset', 'byteLength', 'byteStride', 'target', 'name'], buffers: ['uri', 'byteLength', 'name'],
  };
  for (const [table, allowed] of Object.entries(tables)) for (const [index, value] of (json[table] ?? []).entries()) {
    keys(value, [...allowed, 'extensions', 'extras'], `${table}[${index}]`);
  }
  for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
    keys(primitive, ['attributes', 'indices', 'material', 'mode', 'targets', 'extensions', 'extras'], 'primitive');
  }
  for (const animation of json.animations ?? []) {
    for (const sampler of animation.samplers ?? []) keys(sampler, ['input', 'output', 'interpolation', 'extensions', 'extras'], 'animation.sampler');
    for (const channel of animation.channels ?? []) {
      keys(channel, ['sampler', 'target', 'extensions', 'extras'], 'animation.channel');
      keys(channel.target, ['node', 'path', 'extensions', 'extras'], 'animation.target');
    }
  }
  for (const accessor of json.accessors ?? []) if (accessor.sparse) {
    keys(accessor.sparse, ['count', 'indices', 'values', 'extensions', 'extras'], 'accessor.sparse');
    keys(accessor.sparse.indices, ['bufferView', 'byteOffset', 'componentType', 'extensions', 'extras'], 'sparse.indices');
    keys(accessor.sparse.values, ['bufferView', 'byteOffset', 'extensions', 'extras'], 'sparse.values');
  }
  for (const camera of json.cameras ?? []) {
    keys(camera.perspective, ['aspectRatio', 'yfov', 'zfar', 'znear', 'extensions', 'extras'], 'camera.perspective');
    keys(camera.orthographic, ['xmag', 'ymag', 'zfar', 'znear', 'extensions', 'extras'], 'camera.orthographic');
  }
  for (const material of json.materials ?? []) {
    keys(material.pbrMetallicRoughness, ['baseColorFactor', 'baseColorTexture', 'metallicFactor', 'roughnessFactor', 'metallicRoughnessTexture', 'extensions', 'extras'], 'pbrMetallicRoughness');
    const textures = [material.normalTexture, material.occlusionTexture, material.emissiveTexture,
      material.pbrMetallicRoughness?.baseColorTexture, material.pbrMetallicRoughness?.metallicRoughnessTexture];
    for (const texture of textures) keys(texture, ['index', 'texCoord', 'scale', 'strength', 'extensions', 'extras'], 'textureInfo');
  }
  const visit = (value, location, inExtension = false) => {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value)) {
      if (Object.hasOwn(value, 'uri')) throw new Error(`${location}.uri 依赖不在内嵌 bufferView 内，保留原资产。`);
      if (value.extras != null && (typeof value.extras !== 'object' || Object.keys(value.extras).length)) {
        throw new Error(`${location}.extras 的自定义索引/地址语义未知，保留原资产。`);
      }
      for (const name of Object.keys(value.extensions ?? {})) {
        assert.ok(KNOWN_EXTENSIONS.has(name), `扩展 ${name} 的二进制依赖未证明安全，保留原资产。`);
      }
      if (inExtension) for (const key of ['buffer', 'bufferView', 'byteOffset', 'byteLength']) {
        assert.ok(!Object.hasOwn(value, key), `${location}.${key} 是未经支持的扩展二进制地址，保留原资产。`);
      }
    }
    for (const [name, child] of Object.entries(value)) visit(child, `${location}.${name}`, inExtension || name === 'extensions');
  };
  for (const name of [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]) {
    assert.ok(KNOWN_EXTENSIONS.has(name), `扩展 ${name} 缺少严格无损支持，保留原资产。`);
  }
  visit(json, 'glTF');
}

function viewBytes(document, index) {
  integer(index, 'bufferView 索引');
  const view = document.json.bufferViews?.[index];
  assert.ok(view, `缺少 bufferView ${index}。`);
  assert.equal(view.buffer, 0, 'bufferView 只能引用内嵌 buffer 0。');
  const start = integer(view.byteOffset ?? 0, 'bufferView.byteOffset'), length = integer(view.byteLength, 'bufferView.byteLength');
  assert.ok(start + length <= (document.json.buffers?.[0]?.byteLength ?? 0), 'bufferView 数据越界。');
  return document.binary.subarray(start, start + length);
}

function elementLayout(accessor) {
  const bytes = COMPONENT_BYTES.get(accessor.componentType);
  assert.ok(bytes, `不支持 accessor componentType ${accessor.componentType}。`);
  const dimension = MATRIX_DIMENSIONS.get(accessor.type), components = VECTOR_COMPONENTS.get(accessor.type);
  assert.ok(dimension || components, `不支持 accessor type ${accessor.type}。`);
  if (!dimension) return { bytes, offsets: Array.from({ length: components }, (_, index) => index * bytes), span: components * bytes };
  // 小整数 MAT2/MAT3 的每列按四字节对齐；哈希只比较逻辑分量，另以 view SHA 保护 padding。
  const columnStride = align4(dimension * bytes);
  return { bytes, offsets: Array.from({ length: dimension * dimension }, (_, index) => Math.floor(index / dimension) * columnStride + index % dimension * bytes), span: dimension * columnStride };
}

/** 独立按 glTF accessor/stride/矩阵填充/sparse 规则解包；不使用优化器的去重映射或摘要。 */
function accessorSignature(document, accessor) {
  const { bytes, offsets, span } = elementLayout(accessor), count = integer(accessor.count, 'accessor.count');
  const logicalStride = offsets.length * bytes, extent = offsets.at(-1) + bytes, size = count * logicalStride;
  assert.ok(Number.isSafeInteger(size) && size <= MAX_ACCESSOR_BYTES, 'accessor 解包超过128MiB保守预算，保留原资产。');
  let base = null;
  if (accessor.bufferView !== undefined) {
    const source = viewBytes(document, accessor.bufferView), view = document.json.bufferViews[accessor.bufferView];
    const stride = integer(view.byteStride ?? span, 'bufferView.byteStride'), offset = integer(accessor.byteOffset ?? 0, 'accessor.byteOffset');
    assert.ok(stride >= span && (!count || offset + (count - 1) * stride + extent <= source.length), 'accessor 数据越界或 stride 无效。');
    if (!accessor.sparse && stride === logicalStride && span === logicalStride) {
      return { count, components: offsets.length, componentType: accessor.componentType, sha256: sha(source.subarray(offset, offset + size)) };
    }
    base = { source, stride, offset };
  } else assert.equal(accessor.byteOffset ?? 0, 0, '无 bufferView 的 accessor 不能含 byteOffset。');
  const decoded = Buffer.alloc(size);
  const copy = (source, sourceOffset, destinationIndex) => {
    if (span === logicalStride) source.copy(decoded, destinationIndex * logicalStride, sourceOffset, sourceOffset + logicalStride);
    else offsets.forEach((offset, component) => {
      source.copy(decoded, destinationIndex * logicalStride + component * bytes, sourceOffset + offset, sourceOffset + offset + bytes);
    });
  };
  if (base) for (let index = 0; index < count; index++) copy(base.source, base.offset + index * base.stride, index);
  if (accessor.sparse) {
    const sparse = accessor.sparse, sparseCount = integer(sparse.count, 'sparse.count');
    assert.ok(sparseCount <= count, 'sparse.count 越界。');
    const indexSize = COMPONENT_BYTES.get(sparse.indices.componentType);
    assert.ok([5121, 5123, 5125].includes(sparse.indices.componentType), 'sparse 索引类型无效。');
    const indices = viewBytes(document, sparse.indices.bufferView), values = viewBytes(document, sparse.values.bufferView);
    const indexOffset = integer(sparse.indices.byteOffset ?? 0, 'sparse.indices.byteOffset');
    const valueOffset = integer(sparse.values.byteOffset ?? 0, 'sparse.values.byteOffset');
    assert.ok(indexOffset + sparseCount * indexSize <= indices.length
      && (!sparseCount || valueOffset + (sparseCount - 1) * span + extent <= values.length), 'sparse 数据越界。');
    let previous = -1;
    for (let index = 0; index < sparseCount; index++) {
      const target = indices.readUIntLE(indexOffset + index * indexSize, indexSize);
      assert.ok(target > previous && target < count, 'sparse 索引必须严格递增且位于 accessor 内。');
      copy(values, valueOffset + index * span, target); previous = target;
    }
  }
  return { count, components: offsets.length, componentType: accessor.componentType, sha256: sha(decoded) };
}

export function modelLosslessSnapshot(input) {
  const document = readModelGlb(input), structure = structuredClone(document.json);
  for (const buffer of structure.buffers ?? []) buffer.byteLength = 0;
  for (const view of structure.bufferViews ?? []) view.byteOffset = 0;
  return { structure,
    bufferViews: (document.json.bufferViews ?? []).map((_, index) => sha(viewBytes(document, index))),
    accessors: (document.json.accessors ?? []).map(accessor => accessorSignature(document, accessor)),
    images: (document.json.images ?? []).map(image => {
      assert.ok(image.bufferView !== undefined && image.uri === undefined, '图片必须通过 bufferView 内嵌。');
      return sha(viewBytes(document, image.bufferView));
    }),
  };
}

export function assertModelSemanticsUnchanged(before, after) {
  assert.deepEqual(modelLosslessSnapshot(after), modelLosslessSnapshot(before),
    '严格模型转换改变了逻辑索引/结构/材质/动画/skin/扩展/元数据或解码字节，保留原资产。');
}

/** 保留逻辑 accessor/image/bufferView 索引；只共享相同存储并清除所有 view 以外的 BIN 字节。 */
export function optimizeModelBufferViews(input) {
  const before = Buffer.from(input), document = readModelGlb(before);
  validateModelLosslessPolicy(document.json);
  // 先完整验证支持域与解包预算；不能生成候选后才发现输入存在不能解释的引用。
  const beforeSnapshot = modelLosslessSnapshot(before);
  const json = structuredClone(document.json), unique = new Map(), segments = [];
  let packedBytes = 0, sharedViews = 0;
  for (let index = 0; index < (json.bufferViews?.length ?? 0); index++) {
    const data = viewBytes(document, index), signature = `${data.length}:${sha(data)}`;
    let existing = unique.get(signature)?.find(entry => entry.data.equals(data));
    if (!existing) {
      existing = { offset: packedBytes, data }; segments.push(existing);
      unique.set(signature, [...(unique.get(signature) ?? []), existing]); packedBytes = align4(packedBytes + data.length);
    } else sharedViews += 1;
    json.bufferViews[index].byteOffset = existing.offset;
  }
  const binary = Buffer.alloc(packedBytes);
  for (const entry of segments) entry.data.copy(binary, entry.offset);
  if (json.buffers?.length) json.buffers[0].byteLength = binary.length;
  const candidate = encodeModelGlb(json, binary);
  assert.deepEqual(modelLosslessSnapshot(candidate), beforeSnapshot, '候选未通过独立模型语义验收，保留原资产。');
  const improved = candidate.length < before.length;
  return { bytes: improved ? candidate : before, improved, sharedViews,
    retainedLogicalIndices: true, beforeBinaryBytes: document.binary.length, candidateBinaryBytes: binary.length,
    unusedOrDuplicateBinaryBytes: document.binary.length - binary.length };
}
