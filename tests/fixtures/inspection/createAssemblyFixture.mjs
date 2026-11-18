import { writeFile } from 'node:fs/promises';

// 自包含的测试夹具，不代表真实设备、高精度模型或工程资源。
const positions = [
  -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
  -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
];
const indices = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
  1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
];
const times = [0, 1];
const translations = [0, 0, 0, 0.4, 0, 0];

function floats(values) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes;
}

function unsignedShorts(values) {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
  return bytes;
}

const chunks = [floats(positions), unsignedShorts(indices), floats(times), floats(translations)];
const offsets = [];
let offset = 0;
for (const chunk of chunks) {
  offsets.push(offset);
  offset += chunk.length;
}
const binary = Buffer.concat(chunks);
const document = {
  asset: { version: '2.0', generator: 'inspection-test-fixture' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    { name: 'AssemblyRoot', children: [1, 2, 4], rotation: [0, 0.38268343, 0, 0.92387953], scale: [1.5, 2, 0.75] },
    { name: 'Base', mesh: 0, scale: [1, 0.25, 0.8], extras: { partKey: 'assembly.base' } },
    { name: 'DriveAssembly', translation: [0, 0.8, 0], children: [3], extras: { partKey: 'drive' } },
    { name: 'Motor', mesh: 0, scale: [0.5, 0.5, 0.5], extras: { partKey: 'drive.motor' } },
    { name: 'Guard', mesh: 0, translation: [0, 1.4, 0], scale: [0.9, 0.12, 0.9], extras: { partKey: 'drive.guard' } },
  ],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
  materials: [{ name: 'Fixture material', pbrMetallicRoughness: { baseColorFactor: [0.35, 0.52, 0.7, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
  animations: [{
    name: 'MotorTranslation',
    samplers: [{ input: 2, output: 3, interpolation: 'LINEAR' }],
    channels: [{ sampler: 0, target: { node: 3, path: 'translation' } }],
  }],
  buffers: [{ byteLength: binary.length }],
  bufferViews: chunks.map((chunk, index) => ({ buffer: 0, byteOffset: offsets[index], byteLength: chunk.length })),
  accessors: [
    { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' },
    { bufferView: 2, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
    { bufferView: 3, componentType: 5126, count: 2, type: 'VEC3' },
  ],
};
const json = Buffer.from(JSON.stringify(document), 'utf8');
const jsonPadding = (4 - (json.length % 4)) % 4;
const binPadding = (4 - (binary.length % 4)) % 4;
const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
const binChunk = Buffer.concat([binary, Buffer.alloc(binPadding)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonChunk.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binChunk.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);

await writeFile(new URL('./assembly-animation.glb', import.meta.url), Buffer.concat([
  header, jsonHeader, jsonChunk, binHeader, binChunk,
]));
