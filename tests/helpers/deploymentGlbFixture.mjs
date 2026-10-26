/** 有效 GLB 2：三个已知顶点及重复三角面，用于验证无损运输和实际 loader，不代表业务压缩率。 */
export function deploymentGlbFixture(revision = 'fixture') {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const triangleCount = 2048;
  const binary = Buffer.alloc(positions.length * 4 + triangleCount * 3 * 2);
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  for (let i = 0; i < triangleCount * 3; i++) binary.writeUInt16LE(i % 3, positions.length * 4 + i * 2);
  const document = {
    asset: { version: '2.0', generator: 'deployment-transport-fixture' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: revision, mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length * 4, target: 34962 },
      { buffer: 0, byteOffset: positions.length * 4, byteLength: triangleCount * 3 * 2, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: triangleCount * 3, type: 'SCALAR' }],
  };
  const json = Buffer.from(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonLength + binary.length, 0x20);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonLength, 12); bytes.write('JSON', 16); json.copy(bytes, 20);
  bytes.writeUInt32LE(binary.length, 20 + jsonLength); bytes.writeUInt32LE(0x004e4942, 24 + jsonLength);
  binary.copy(bytes, 28 + jsonLength);
  return bytes;
}
