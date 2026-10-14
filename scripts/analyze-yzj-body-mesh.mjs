import { readFileSync } from "node:fs";

const filePath = "F:/3d-models/models/YZJ/YZJ.glb";
const bytes = readFileSync(filePath);

function readUint32(offset) {
  return bytes.readUInt32LE(offset);
}

function readChunks() {
  let json = null;
  let bin = null;
  let offset = 12;
  while (offset < bytes.length) {
    const chunkLength = readUint32(offset);
    const chunkType = readUint32(offset + 4);
    const chunkStart = offset + 8;
    const chunk = bytes.subarray(chunkStart, chunkStart + chunkLength);
    if (chunkType === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8"));
    if (chunkType === 0x004e4942) bin = chunk;
    offset = chunkStart + chunkLength;
  }
  return { json, bin };
}

function readAccessor(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex];
  const view = gltf.bufferViews[accessor.bufferView];
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? 12;
  const result = [];
  for (let i = 0; i < accessor.count; i += 1) {
    const start = offset + i * stride;
    result.push({
      x: bin.readFloatLE(start),
      y: bin.readFloatLE(start + 4),
      z: bin.readFloatLE(start + 8),
    });
  }
  return result;
}

function histogram(points, key, bins = 24) {
  const values = points.map((point) => point[key]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = (max - min) / bins;
  return Array.from({ length: bins }, (_, index) => {
    const from = min + index * width;
    const to = index === bins - 1 ? max : from + width;
    const count = values.filter((value) => value >= from && value <= to).length;
    return { from: Number(from.toFixed(4)), to: Number(to.toFixed(4)), count };
  });
}

function range(points, key) {
  const values = points.map((point) => point[key]);
  return [Math.min(...values), Math.max(...values)].map((value) => Number(value.toFixed(4)));
}

const { json: gltf, bin } = readChunks();
const bodyNode = gltf.nodes.find((node) => node.name === "ZT.2");
const bodyMesh = gltf.meshes[bodyNode.children.map((index) => gltf.nodes[index]).find((node) => Number.isInteger(node.mesh)).mesh];
const positionAccessor = bodyMesh.primitives[0].attributes.POSITION;
const points = readAccessor(gltf, bin, positionAccessor);
const low = points.filter((point) => point.y < 0.18);
const high = points.filter((point) => point.y > 0.62);
const nearSides = points.filter((point) => Math.abs(point.z) > 0.46);

console.log(JSON.stringify({
  total: points.length,
  all: { x: range(points, "x"), y: range(points, "y"), z: range(points, "z") },
  low: { count: low.length, x: range(low, "x"), z: range(low, "z") },
  high: { count: high.length, x: range(high, "x"), z: range(high, "z") },
  sideRails: { count: nearSides.length, x: range(nearSides, "x"), y: range(nearSides, "y") },
  xHistogram: histogram(points, "x", 28),
  lowXHistogram: histogram(low, "x", 28),
}, null, 2));
