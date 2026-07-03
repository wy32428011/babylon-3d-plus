import { readFileSync } from "node:fs";

const filePath = "F:/3d-models/models/YZJ/YZJ.glb";
const bytes = readFileSync(filePath);

function readUint32(offset) {
  return bytes.readUInt32LE(offset);
}

function readJsonChunk() {
  if (readUint32(0) !== 0x46546c67) {
    throw new Error("不是有效的 GLB 文件");
  }
  let offset = 12;
  while (offset < bytes.length) {
    const chunkLength = readUint32(offset);
    const chunkType = readUint32(offset + 4);
    const chunkStart = offset + 8;
    if (chunkType === 0x4e4f534a) {
      return JSON.parse(bytes.subarray(chunkStart, chunkStart + chunkLength).toString("utf8"));
    }
    offset = chunkStart + chunkLength;
  }
  throw new Error("GLB 缺少 JSON chunk");
}

function fmt(value) {
  return Number.isFinite(value) ? Number(value).toFixed(4) : "n/a";
}

function vec(value, fallback) {
  const v = Array.isArray(value) ? value : fallback;
  return `(${fmt(v[0])},${fmt(v[1])},${fmt(v[2])})`;
}

function meshBounds(mesh) {
  const ranges = [];
  for (const primitive of mesh?.primitives ?? []) {
    const accessorIndex = primitive?.attributes?.POSITION;
    const accessor = Number.isInteger(accessorIndex) ? gltf.accessors?.[accessorIndex] : null;
    if (accessor?.min && accessor?.max) {
      ranges.push(`min=${vec(accessor.min, [0, 0, 0])} max=${vec(accessor.max, [0, 0, 0])}`);
    }
  }
  return ranges.join(" | ");
}

const gltf = readJsonChunk();
const parents = new Map();
(gltf.nodes ?? []).forEach((node, index) => {
  for (const child of node.children ?? []) {
    parents.set(child, index);
  }
});

console.log(`nodes=${gltf.nodes?.length ?? 0} meshes=${gltf.meshes?.length ?? 0}`);
console.log("=== nodes ===");
(gltf.nodes ?? []).forEach((node, index) => {
  const parentIndex = parents.get(index);
  const parentName = parentIndex === undefined ? "<root>" : (gltf.nodes[parentIndex]?.name ?? `node_${parentIndex}`);
  const mesh = Number.isInteger(node.mesh) ? gltf.meshes[node.mesh] : null;
  const bounds = mesh ? ` bounds=${meshBounds(mesh)}` : "";
  console.log(`${index}: ${node.name ?? "<unnamed>"} parent=${parentName} mesh=${mesh?.name ?? node.mesh ?? "-"} t=${vec(node.translation, [0, 0, 0])} s=${vec(node.scale, [1, 1, 1])}${bounds}`);
});
