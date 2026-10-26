import assert from 'node:assert/strict';
import { serialize } from 'node:v8';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { encodeLightingBakeTransport, decodeLightingBakeTransport } from '../../electron/shared/sceneLightingBakeBinary.ts';
import { validateLightingBakeInput } from '../../electron/ipc/lightingBakeValidation.ts';
import { DEFAULT_LIGHTING_BAKE_SETTINGS } from '../../electron/shared/sceneLightingBakeData.ts';

const url = 'data:image/png;base64,' + 'A'.repeat(8192);
function fixture(amount = 16) {
  return { version: 1, jobId: 'memory-small-proof', signature: 'signature', sceneName: 'small-node-only',
    meshes: Array.from({ length: amount }, (_, index) => ({ key: 'mesh-' + index, entityId: 'entity', nodeKey: 'node', name: 'mesh',
      positions: [0, -0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2], uvs: [0, 0, 1, 0, 0, 1],
      worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      material: { baseColor: [1, 1, 1], alpha: 1, metallic: 0, roughness: 1, emissive: [0, 0, 0], doubleSided: false,
        textures: { baseColor: { url } } }, receiver: true })), lights: [], environment: { color: [0, 0, 0], intensity: 1 } };
}

test('实际v2 codec保留原数组，同时新建binary；无transfer的structuredClone与decode再建立独立数据', () => {
  const input = fixture(2), encoded = encodeLightingBakeTransport(input), cloned = structuredClone(encoded), decoded = decodeLightingBakeTransport(cloned);
  assert.equal(encoded.geometry[0].bytes.byteLength, 216);
  assert.equal(encoded.input.meshes[0].positions, undefined);
  assert.equal(encoded.input.meshes[0].material, input.meshes[0].material, 'metadata是浅副本，不能误说成此处已深拷贝几何');
  assert.notEqual(cloned.geometry[0].bytes, encoded.geometry[0].bytes);
  assert.equal(encoded.geometry[0].bytes.byteLength, 216, '没有transfer，所以发送侧buffer不脱离');
  assert.notEqual(decoded.meshes[0].positions, input.meshes[0].positions);
  assert.ok(Array.isArray(decoded.meshes[0].positions)); assert.deepEqual(decoded, input);
  assert.equal(Object.is(decoded.meshes[0].positions[1], -0), true);
});

test('仅作设计证明的URL字典减少Node V8序列化体积，恢复后仍由原decoder逐值读回', () => {
  const input = fixture(), original = encodeLightingBakeTransport(input);
  const candidate = { ...original, textureUrls: [url], input: { ...original.input,
    meshes: original.input.meshes.map(mesh => ({ ...mesh, material: { ...mesh.material,
      textures: { baseColor: { ...mesh.material.textures.baseColor, url: 'texture-table:0' } } } })) } };
  const restored = { ...candidate, input: { ...candidate.input, meshes: candidate.input.meshes.map(mesh => ({ ...mesh,
    material: { ...mesh.material, textures: { baseColor: { ...mesh.material.textures.baseColor, url: candidate.textureUrls[0] } } } })) } };
  assert.deepEqual(decodeLightingBakeTransport(restored), decodeLightingBakeTransport(original));
  const before = serialize(original).byteLength, after = serialize(candidate).byteLength;
  assert.ok(after < before / 2, '仅说明本Node小对象的序列化差异，不冒充Electron wire字节或真实heap');
  console.log(JSON.stringify({ proof: 'small-node-v8-not-electron-ipc', originalSerializedBytes: before, dictionarySerializedBytes: after,
    originalJsonChars: JSON.stringify(original.input).length, dictionaryJsonChars: JSON.stringify(candidate.input).length + url.length }));
});

test('产品IPC字典只去重重复大URL，几何逐位/材质参数/原输入与完整校验保持', () => {
  const input = { ...fixture(), settings: { ...DEFAULT_LIGHTING_BAKE_SETTINGS } }, before = structuredClone(input);
  const legacy = encodeLightingBakeTransport(input), transport = encodeLightingBakeTransport(input, { deduplicateTextureUrls: true });
  assert.equal(legacy.textureTable, undefined); assert.equal(transport.textureTable.version, 1);
  assert.deepEqual(transport.textureTable.urls, [url]);
  assert.equal(transport.input.meshes[0].material.textures.baseColor.url, 'lighting-texture-ref://v1/0');
  assert.deepEqual(decodeLightingBakeTransport(structuredClone(transport)), input);
  assert.deepEqual(validateLightingBakeInput(transport), validateLightingBakeInput(legacy));
  assert.deepEqual(input, before);
  for (let index = 0; index < legacy.geometry.length; index++) assert.deepEqual(transport.geometry[index], legacy.geometry[index]);
  assert.ok(serialize(transport).byteLength < serialize(legacy).byteLength / 2);
  console.log(JSON.stringify({ proof: 'product-codec-small-node-v8-not-electron-wire',
    legacySerializedBytes: serialize(legacy).byteLength, tableSerializedBytes: serialize(transport).byteLength }));
});

test('不重复URL/短URL不增加字段，字典同时覆盖环境与纹理但不误改任意字符串', () => {
  const one = fixture(1), encoded = encodeLightingBakeTransport(one, { deduplicateTextureUrls: true });
  assert.equal(encoded.textureTable, undefined); assert.deepEqual(encoded, encodeLightingBakeTransport(one));
  const input = fixture(1); input.environment.textureUrl = url; input.sceneName = url;
  const transport = encodeLightingBakeTransport(input, { deduplicateTextureUrls: true });
  assert.equal(transport.input.environment.textureUrl, 'lighting-texture-ref://v1/0'); assert.equal(transport.input.sceneName, url);
  assert.deepEqual(decodeLightingBakeTransport(transport), input);
  const short = fixture(2); for (const mesh of short.meshes) mesh.material.textures.baseColor.url = 'editor-asset://local/a.png';
  assert.equal(encodeLightingBakeTransport(short, { deduplicateTextureUrls: true }).textureTable, undefined);
});

test('字典坏版本/越界/缺项/重复/未使用/远端URL明确拒绝，仍保留原有限数值与材质校验', () => {
  const input = { ...fixture(2), settings: { ...DEFAULT_LIGHTING_BAKE_SETTINGS } };
  const valid = encodeLightingBakeTransport(input, { deduplicateTextureUrls: true });
  const mutate = callback => { const value = structuredClone(valid); callback(value); return value; };
  for (const raw of [
    mutate(value => { delete value.textureTable; }),
    mutate(value => { value.textureTable.version = 2; }),
    mutate(value => { value.textureTable.urls.push(url); }),
    mutate(value => { value.textureTable.urls.push('editor-asset://local/unused.png'); }),
    mutate(value => { value.textureTable.urls[0] = 'https://remote.invalid/image.png'; }),
    mutate(value => { value.textureTable.urls = []; }),
    mutate(value => { value.textureTable.extra = true; }),
    ...['-1', '01', '1', 'NaN', '9007199254740992'].map(index => mutate(value => { value.input.meshes[0].material.textures.baseColor.url = 'lighting-texture-ref://v1/' + index; })),
    mutate(value => { value.input.meshes[0].material.textures.baseColor.url = 'lighting-texture-ref://v2/0'; }),
  ]) assert.throws(() => decodeLightingBakeTransport(raw), /纹理字典/);
  assert.throws(() => validateLightingBakeInput(mutate(value => { value.input.meshes[0].material.roughness = NaN; })), /有限数值/);
  assert.throws(() => validateLightingBakeInput(mutate(value => { value.input.meshes[0].material.textures.baseColor.coordinatesIndex = 1; })), /UV/);
  assert.throws(() => validateLightingBakeInput(mutate(value => { new DataView(value.geometry[0].bytes).setFloat64(8, NaN, true); })), /有限数值/);
});

test('冻结旧decoder可读旧请求；新引用送入旧边界明确失败，不会作为有效PNG交给烘焙', async () => {
  const frozen = JSON.parse(await readFile(new URL('./fixtures/phase2BakeBinaryLegacy.json', import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(frozen.source).digest('hex'), frozen.sha256);
  const source = ts.transpileModule(frozen.source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const legacy = runInNewContext(source + '\nexports;', { exports: {}, ArrayBuffer, DataView, Uint8Array, Map, Number, Array, Error });
  const input = { ...fixture(2), settings: { ...DEFAULT_LIGHTING_BAKE_SETTINGS } };
  assert.deepEqual(validateLightingBakeInput(structuredClone(legacy.decodeLightingBakeTransport(encodeLightingBakeTransport(input)))), input);
  const decoded = legacy.decodeLightingBakeTransport(encodeLightingBakeTransport(input, { deduplicateTextureUrls: true }));
  assert.throws(() => validateLightingBakeInput(decoded), /资产或导出的 PNG/);
});
