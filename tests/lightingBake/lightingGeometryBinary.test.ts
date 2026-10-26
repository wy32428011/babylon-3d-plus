import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeLightingGeometryBinary, decodeLightingGeometryResource } from '../../electron/shared/sceneLightingBakeGeometryBinary.ts';
import { validateSceneLightingBakeSnapshot } from '../../electron/shared/sceneLightingBakeData.ts';
import { binaryFixture, geometryFixture, type MutableBinaryHeader } from './lightingGeometryBinaryFixture.ts';

test('LE binary-v1保留通道/索引/负零，aligned输入直接视图，非对齐输入显式一次复制', () => {
  const bytes = binaryFixture({ ...geometryFixture, uvs2: [...geometryFixture.uvs], colors: Array(12).fill(.5), tangents: Array(12).fill(1) });
  const decoded = decodeLightingGeometryBinary(bytes);
  assert.equal(decoded.storage, 'view'); assert.equal(decoded.geometry.version, 2);
  assert.ok(decoded.geometry.positions instanceof Float32Array); assert.ok(decoded.geometry.indices instanceof Uint32Array);
  assert.equal(decoded.geometry.positions.buffer, bytes.buffer); assert.equal(Object.is(decoded.geometry.positions[0], -0), true);
  assert.deepEqual(Array.from(decoded.geometry.indices), [0, 1, 2]); assert.equal(decoded.geometry.tangents?.length, 12);
  const backing = new Uint8Array(bytes.length + 3); backing.set(bytes, 1);
  const copied = decodeLightingGeometryBinary(backing.subarray(1, 1 + bytes.length));
  assert.equal(copied.storage, 'aligned-copy'); assert.notEqual(copied.geometry.positions.buffer, backing.buffer);
  assert.ok(Object.is(copied.geometry.positions[0], -0));
  const nodeBacking = Buffer.alloc(bytes.length + 3, 0xaa); nodeBacking.set(bytes, 1);
  const nodeCopied = decodeLightingGeometryBinary(nodeBacking.subarray(1, 1 + bytes.length));
  assert.equal(nodeCopied.storage, 'aligned-copy'); assert.notEqual(nodeCopied.geometry.positions.buffer, nodeBacking.buffer);
  assert.equal(nodeCopied.geometry.positions.buffer.byteLength, bytes.byteLength);
  assert.ok(Object.is(nodeCopied.geometry.positions[0], -0));
  assert.equal(nodeBacking[0], 0xaa); assert.equal(nodeBacking[bytes.length + 1], 0xaa);
});

test('旧v1/v2 JSON、省略或显式json均兼容，未知encoding/格式不静默猜测', () => {
  for (const version of [1, 2]) for (const encoding of [undefined, 'json'] as const) {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...geometryFixture, version }));
    const actual = decodeLightingGeometryResource(bytes, encoding);
    assert.ok(Array.isArray(actual.positions)); assert.equal(actual.version, version);
  }
  assert.throws(() => decodeLightingGeometryResource(binaryFixture(), 'json'));
  assert.throws(() => decodeLightingGeometryResource(new TextEncoder().encode(JSON.stringify(geometryFixture)), 'binary-v1'));
  assert.throws(() => decodeLightingGeometryResource(binaryFixture(), 'future' as never));
});

test('不可信二进制头/数据：schema、数量/偏移、对齐/重叠/越界、finite/index/UV/尾字节均拒绝', () => {
  for (const mutate of [
    (h: MutableBinaryHeader) => { h.version = 2; }, (h: MutableBinaryHeader) => { h.geometryVersion = 1; },
    (h: MutableBinaryHeader) => { h.extra = true; }, (h: MutableBinaryHeader) => { delete h.attributes.normals; },
    (h: MutableBinaryHeader) => { h.attributes.extra = h.attributes.positions; },
    (h: MutableBinaryHeader) => { h.vertexCount = Number.MAX_SAFE_INTEGER; },
    (h: MutableBinaryHeader) => { h.attributes.positions.type = 'float64'; },
    (h: MutableBinaryHeader) => { h.attributes.positions.components = 2; },
    (h: MutableBinaryHeader) => { h.attributes.positions.count = 8; },
    (h: MutableBinaryHeader) => { h.attributes.positions.byteOffset += 1; },
    (h: MutableBinaryHeader) => { h.attributes.normals.byteOffset = h.attributes.positions.byteOffset; },
    (h: MutableBinaryHeader) => { h.attributes.positions.byteOffset = Number.MAX_SAFE_INTEGER; },
    (h: MutableBinaryHeader) => { h.attributes.positions.byteOffset = -4; },
    (h: MutableBinaryHeader) => { h.attributes.positions.count = 0x40000000; },
    (h: MutableBinaryHeader) => { h.attributes.positions.extra = true; },
  ]) assert.throws(() => decodeLightingGeometryBinary(binaryFixture(geometryFixture, mutate)));
  const valid = binaryFixture();
  const header = JSON.parse(new TextDecoder().decode(valid.subarray(12, 12 + new DataView(valid.buffer).getUint32(8, true))));
  for (const [field, value] of [['positions', NaN], ['normals', Infinity], ['indices', 3], ['bakeUvs', 2]] as const) {
    const bad = valid.slice(), view = new DataView(bad.buffer);
    if (field === 'indices') view.setUint32(header.attributes[field].byteOffset, value, true);
    else view.setFloat32(header.attributes[field].byteOffset, value, true);
    assert.throws(() => decodeLightingGeometryBinary(bad));
  }
  const badMagic = valid.slice(); badMagic[0] ^= 1; assert.throws(() => decodeLightingGeometryBinary(badMagic));
  const badUtf8 = valid.slice(); badUtf8[12] = 0xff; assert.throws(() => decodeLightingGeometryBinary(badUtf8));
  const hugeHeader = valid.slice(); new DataView(hugeHeader.buffer).setUint32(8, 65537, true); assert.throws(() => decodeLightingGeometryBinary(hugeHeader));
  assert.throws(() => decodeLightingGeometryBinary(valid.subarray(0, valid.length - 1)));
  const tail = new Uint8Array(valid.length + 4); tail.set(valid); assert.throws(() => decodeLightingGeometryBinary(tail));
});

test('快照仅geometry接受已知encoding；旧省略不补，非法值不会被normalizer剥除后当成功', () => {
  const snapshot = { version: 1, signature: 'fixture', createdAt: '2026-10-24', engineVersion: 'fixture', assets: [
    { id: 'g', kind: 'geometry', url: 'g.bin', byteLength: 12, geometryVersion: 2, encoding: 'binary-v1' },
    { id: 'l', kind: 'lightmap', url: 'l.png', byteLength: 33 }, { id: 'p', kind: 'probes', url: 'p.json', byteLength: 1 }],
    surfaces: [{ key: 'a', entityId: 'a', nodeKey: 'r', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
    statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 0 } };
  assert.equal(validateSceneLightingBakeSnapshot(snapshot)?.assets[0].encoding, 'binary-v1');
  const old = structuredClone(snapshot); delete (old.assets[0] as Record<string, unknown>).encoding;
  assert.equal(Object.hasOwn(validateSceneLightingBakeSnapshot(old)!.assets[0], 'encoding'), false);
  for (const [index, encoding] of [[0, 'future'], [1, 'binary-v1'], [2, 'json']] as const) {
    const bad = structuredClone(snapshot); (bad.assets[index] as Record<string, unknown>).encoding = encoding;
    assert.equal(validateSceneLightingBakeSnapshot(bad), null);
  }
});
