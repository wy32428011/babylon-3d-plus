// 生成虚拟输送线内置模型包 GLB：1×0.05×1 m 扁平长方体，单 mesh 命名 VCConveyorBelt。
// 运行：node scripts/generate-virtual-conveyor-glb.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'public', 'builtin-model-packages', 'virtual-conveyor');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'virtual-conveyor.glb');

const HALF_X = 0.5;
const HALF_Z = 0.5;
const HEIGHT = 0.05;

// 每个面 4 个顶点（从外侧看 CCW），法线统一朝外；几何原点在底面中心。
const FACES = [
  { normal: [0, 1, 0], corners: [[-HALF_X, HEIGHT, -HALF_Z], [HALF_X, HEIGHT, -HALF_Z], [HALF_X, HEIGHT, HALF_Z], [-HALF_X, HEIGHT, HALF_Z]] },
  { normal: [0, -1, 0], corners: [[-HALF_X, 0, HALF_Z], [HALF_X, 0, HALF_Z], [HALF_X, 0, -HALF_Z], [-HALF_X, 0, -HALF_Z]] },
  { normal: [1, 0, 0], corners: [[HALF_X, 0, -HALF_Z], [HALF_X, 0, HALF_Z], [HALF_X, HEIGHT, HALF_Z], [HALF_X, HEIGHT, -HALF_Z]] },
  { normal: [-1, 0, 0], corners: [[-HALF_X, 0, HALF_Z], [-HALF_X, 0, -HALF_Z], [-HALF_X, HEIGHT, -HALF_Z], [-HALF_X, HEIGHT, HALF_Z]] },
  { normal: [0, 0, 1], corners: [[HALF_X, 0, HALF_Z], [-HALF_X, 0, HALF_Z], [-HALF_X, HEIGHT, HALF_Z], [HALF_X, HEIGHT, HALF_Z]] },
  { normal: [0, 0, -1], corners: [[-HALF_X, 0, -HALF_Z], [HALF_X, 0, -HALF_Z], [HALF_X, HEIGHT, -HALF_Z], [-HALF_X, HEIGHT, -HALF_Z]] },
];

const positions = [];
const normals = [];
const indices = [];

FACES.forEach((face, faceIndex) => {
  const base = faceIndex * 4;
  face.corners.forEach((corner) => {
    positions.push(corner[0], corner[1], corner[2]);
    normals.push(face.normal[0], face.normal[1], face.normal[2]);
  });
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
});

function toFloat32Buffer(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

function toUint16Buffer(values) {
  return Buffer.from(new Uint16Array(values).buffer);
}

const positionBuffer = toFloat32Buffer(positions);
const normalBuffer = toFloat32Buffer(normals);
const indexBuffer = toUint16Buffer(indices);

const positionOffset = 0;
const normalOffset = positionBuffer.length;
const indexOffset = normalOffset + normalBuffer.length;
const binLength = indexOffset + indexBuffer.length;

const json = {
  asset: { version: '2.0', generator: 'zending-3d-editor virtual-conveyor generator' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'VCConveyorBelt' }],
  meshes: [{
    name: 'VCConveyorBelt',
    primitives: [{
      attributes: { POSITION: 0, NORMAL: 1 },
      indices: 2,
      material: 0,
    }],
  }],
  materials: [{
    name: 'VCBeltMaterial',
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0.05,
      roughnessFactor: 0.85,
    },
  }],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: positions.length / 3,
      type: 'VEC3',
      min: [-HALF_X, 0, -HALF_Z],
      max: [HALF_X, HEIGHT, HALF_Z],
    },
    {
      bufferView: 1,
      componentType: 5126,
      count: normals.length / 3,
      type: 'VEC3',
    },
    {
      bufferView: 2,
      componentType: 5123,
      count: indices.length,
      type: 'SCALAR',
    },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: positionOffset, byteLength: positionBuffer.length },
    { buffer: 0, byteOffset: normalOffset, byteLength: normalBuffer.length },
    { buffer: 0, byteOffset: indexOffset, byteLength: indexBuffer.length },
  ],
  buffers: [{ byteLength: binLength }],
};

let jsonChunk = Buffer.from(JSON.stringify(json), 'utf-8');
const jsonPadding = (4 - (jsonChunk.length % 4)) % 4;
if (jsonPadding > 0) {
  jsonChunk = Buffer.concat([jsonChunk, Buffer.from(' '.repeat(jsonPadding))]);
}

const binChunk = Buffer.concat([positionBuffer, normalBuffer, indexBuffer]);
const binPadding = (4 - (binChunk.length % 4)) % 4;
const paddedBin = binPadding > 0 ? Buffer.concat([binChunk, Buffer.alloc(binPadding)]) : binChunk;

const totalLength = 12 + 8 + jsonChunk.length + 8 + paddedBin.length;
const glb = Buffer.alloc(totalLength);
let offset = 0;

glb.writeUInt32LE(0x46546c67, offset); offset += 4; // "glTF"
glb.writeUInt32LE(2, offset); offset += 4;
glb.writeUInt32LE(totalLength, offset); offset += 4;

glb.writeUInt32LE(jsonChunk.length, offset); offset += 4;
glb.writeUInt32LE(0x4e4f534a, offset); offset += 4; // "JSON"
jsonChunk.copy(glb, offset); offset += jsonChunk.length;

glb.writeUInt32LE(paddedBin.length, offset); offset += 4;
glb.writeUInt32LE(0x004e4942, offset); offset += 4; // "BIN\0"
paddedBin.copy(glb, offset);

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(OUTPUT_FILE, glb);
console.log(`已生成 ${OUTPUT_FILE}（${glb.length} 字节）`);
