/** @typedef {{count?: number, min?: number[], max?: number[], componentType?: number, normalized?: boolean}} Accessor */
/** @typedef {{indices?: number, attributes?: Record<string, number>, mode?: number, targets?: unknown[], extensions?: Record<string, unknown>}} Primitive */
/** @typedef {{name?: string, primitives?: Primitive[]}} SourceMesh */
/** @typedef {{mesh?: number, children?: number[], matrix?: number[], translation?: number[], rotation?: number[], scale?: number[], skin?: number, extensions?: Record<string, unknown>}} SourceNode */
/** @typedef {{asset?: {version?: string}, meshes?: SourceMesh[], nodes?: SourceNode[], accessors?: Accessor[], scenes?: {nodes?: number[]}[], scene?: number, animations?: {channels?: {target?: {node?: number}}[]}[], materials?: unknown[], images?: unknown[], extensionsUsed?: string[]}} SourceGltf */
/** @typedef {{smallObjectMaxSizeMeters: number, smallObjectTriangleLimit: number, trianglesPerSquareMeterLimit: number}} DensityThresholds */
/** @typedef {'small-high-poly'|'dense'} DensityReason */
/** @typedef {{meshIndex: number, mesh: string, triangles: number, vertices: number|null, sizeMeters: number[], trianglesPerSquareMeter: number|null, reasons: DensityReason[]}} DensityFinding */
/** @typedef {{index: number, name: string, triangles: number, trianglesKnown: boolean, vertices: number, verticesKnown: boolean, min: number[], max: number[], boundsKnown: boolean, morphing: boolean, instances: (number[]|null)[], instanceCounts: (number|null)[]}} MeshMetric */

export const DEFAULT_THRESHOLDS = Object.freeze({
  smallObjectMaxSizeMeters: 0.5,
  smallObjectTriangleLimit: 20_000,
  trianglesPerSquareMeterLimit: 200_000,
});
const KNOWN_DENSITY_EXTENSIONS = new Set(['KHR_lights_punctual', 'KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'EXT_mesh_gpu_instancing',
  'KHR_texture_basisu', 'KHR_texture_transform', 'EXT_texture_webp', 'EXT_texture_avif', 'KHR_mesh_quantization',
  'KHR_materials_anisotropy', 'KHR_materials_clearcoat', 'KHR_materials_diffuse_transmission', 'KHR_materials_dispersion',
  'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_iridescence', 'KHR_materials_pbrSpecularGlossiness',
  'KHR_materials_sheen', 'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_unlit', 'KHR_materials_variants', 'KHR_materials_volume']);
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** @param {unknown} value @param {number} length @returns {number[]|null} */
function vector(value, length) {
  return Array.isArray(value) && value.length === length && value.every(item => typeof item === 'number' && Number.isFinite(item)) ? value : null;
}
/** @param {unknown} value @returns {value is number} */
function count(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
/** 列主序矩阵，与 glTF 的节点 TRS 约定一致。 @param {number[]} a @param {number[]} b */
function multiply(a, b) {
  /** @type {number[]} */
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  }
  return out;
}
/** @param {SourceNode} node @returns {number[]|null} */
function localMatrix(node) {
  if (node.matrix !== undefined) return vector(node.matrix, 16);
  const translation = vector(node.translation ?? [0, 0, 0], 3), rotation = vector(node.rotation ?? [0, 0, 0, 1], 4), scale = vector(node.scale ?? [1, 1, 1], 3);
  if (!translation || !rotation || !scale) return null;
  const [tx, ty, tz] = translation, [qx, qy, qz, qw] = rotation, [sx, sy, sz] = scale;
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [(1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0, tx, ty, tz, 1];
}
/** @param {number[]} min @param {number[]} max @param {number[]} matrix @param {number} unitScale */
function worldSize(min, max, matrix, unitScale) {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const point = [corner & 1 ? max[0] : min[0], corner & 2 ? max[1] : min[1], corner & 4 ? max[2] : min[2]];
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * point[0] + matrix[4 + axis] * point[1] + matrix[8 + axis] * point[2] + matrix[12 + axis];
      low[axis] = Math.min(low[axis], value); high[axis] = Math.max(high[axis], value);
    }
  }
  return high.map((value, axis) => (value - low[axis]) * unitScale);
}
/** 只读源 JSON 估计；未知计数/尺寸保持 null，不解码 BIN 或运行模型脚本。
 * @param {unknown} value @param {DensityThresholds} [thresholds] @param {{unitScaleToMeters?: number}} [options]
 */
export function analyzeGltfJson(value, thresholds = DEFAULT_THRESHOLDS, options = {}) {
  if (!value || typeof value !== 'object') throw new Error('源 glTF JSON 不是对象。');
  const json = /** @type {SourceGltf} */ (value), accessors = json.accessors ?? [];
  const unitScale = options.unitScaleToMeters ?? 1, unitKnown = Number.isFinite(unitScale) && unitScale > 0;
  /** @type {Set<string>} */
  const unknown = new Set();
  if (!unitKnown) unknown.add('源模型单位未知，尺寸与密度未计算。');
  const extensionNames = new Set(json.extensionsUsed ?? []);
  const owners = [json, ...(json.nodes ?? []), ...(json.meshes ?? []), ...(json.meshes ?? []).flatMap(mesh => mesh.primitives ?? []),
    ...(json.materials ?? []), ...(json.images ?? [])];
  for (const owner of owners) {
    const extensions = /** @type {{extensions?: Record<string, unknown>}|null} */ (owner)?.extensions;
    if (extensions && typeof extensions === 'object') for (const name of Object.keys(extensions)) extensionNames.add(name);
  }
  const extensions = [...extensionNames];
  const compression = { draco: extensions.includes('KHR_draco_mesh_compression'), meshopt: extensions.includes('EXT_meshopt_compression'), ktx2: extensions.includes('KHR_texture_basisu') };
  if (compression.draco || compression.meshopt) unknown.add('压缩几何仅按 JSON 元数据估计，未解码验证。');
  const opaque = extensions.some(name => !KNOWN_DENSITY_EXTENSIONS.has(name));
  if (opaque) unknown.add('存在未解释的扩展，尺寸密度未判定。');
  /** @type {MeshMetric[]} */
  const meshes = (json.meshes ?? []).map((mesh, index) => {
    const metric = { index, name: mesh.name ?? `mesh-${index}`, triangles: 0, trianglesKnown: true, vertices: 0,
      verticesKnown: true, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], boundsKnown: true,
      morphing: false, instances: /** @type {(number[]|null)[]} */ ([]), instanceCounts: /** @type {(number|null)[]} */ ([]) };
    for (const primitive of mesh.primitives ?? []) {
      const position = accessors[primitive.attributes?.POSITION ?? -1];
      const elements = primitive.indices !== undefined ? accessors[primitive.indices]?.count : position?.count;
      const mode = primitive.mode ?? 4;
      if (mode >= 0 && mode <= 3) { /* 点/线的三角面数确实为零。 */ }
      else if (!count(elements) || (mode === 4 && elements % 3 !== 0) || mode > 6 || mode < 0) metric.trianglesKnown = false;
      else metric.triangles += mode === 4 ? elements / 3 : Math.max(0, elements - 2);
      if (count(position?.count)) metric.vertices += position.count; else metric.verticesKnown = false;
      const low = vector(position?.min, 3), high = vector(position?.max, 3);
      if (!low || !high || low.some((entry, axis) => entry > high[axis]) || position?.normalized || (position?.componentType !== undefined && position.componentType !== 5126)) metric.boundsKnown = false;
      else for (let axis = 0; axis < 3; axis++) { metric.min[axis] = Math.min(metric.min[axis], low[axis]); metric.max[axis] = Math.max(metric.max[axis], high[axis]); }
      if (primitive.targets?.length) metric.morphing = true;
    }
    if (!metric.trianglesKnown) unknown.add('部分 primitive 缺少可靠的 accessor 计数，面数未知。');
    if (!metric.boundsKnown) unknown.add('部分 POSITION 缺少可用 min/max 或需解码坐标，尺寸未知。');
    return metric;
  });
  const nodes = json.nodes ?? [], animated = new Set((json.animations ?? []).flatMap(animation => (animation.channels ?? []).map(channel => channel.target?.node)));
  let graphKnown = true;
  /** @param {number} index @param {number[]|null} parent @param {Set<number>} path @param {boolean} inheritedDynamic @returns {void} */
  const visit = (index, parent, path, inheritedDynamic) => {
    const node = nodes[index];
    if (!node || path.has(index) || path.size > 256) { graphKnown = false; unknown.add('源节点层级缺失、循环或过深，实例统计不完整。'); return; }
    const local = localMatrix(node), world = local && parent ? multiply(parent, local) : null;
    const dynamic = inheritedDynamic || animated.has(index) || node.skin !== undefined;
    const mesh = node.mesh !== undefined ? meshes[node.mesh] : null;
    if (mesh) {
      const instancing = /** @type {{attributes?: Record<string, number>}|undefined} */ (node.extensions?.EXT_mesh_gpu_instancing);
      const amounts = instancing ? Object.values(instancing.attributes ?? {}).map(accessor => accessors[accessor]?.count) : [1];
      const amount = amounts.length && amounts.every(entry => count(entry) && entry === amounts[0]) ? amounts[0] ?? null : null;
      mesh.instanceCounts.push(amount);
      const size = world && unitKnown && mesh.boundsKnown && !dynamic && !mesh.morphing && !instancing && !opaque ? worldSize(mesh.min, mesh.max, world, unitScale) : null;
      mesh.instances.push(size?.every(Number.isFinite) ? size : null);
      if (!size) unknown.add(dynamic || mesh.morphing ? '动画/蒙皮/形变的实际尺寸未知。' : instancing ? 'GPU 实例的逐实例变换未解码，尺寸未知。' : '部分源网格尺寸未计算。');
    }
    const next = new Set(path); next.add(index);
    for (const child of node.children ?? []) visit(child, world, next, dynamic);
  };
  // 无默认场景时用一次子节点集合求根，避免大节点树退化为逐节点全树扫描。
  const childNodes = new Set(nodes.flatMap(node => node.children ?? []));
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, index) => index).filter(index => !childNodes.has(index));
  for (const root of roots) visit(root, identity(), new Set(), false);
  /** @type {DensityFinding[]} */
  const findings = [];
  for (const mesh of meshes) {
    if (!mesh.instances.length) unknown.add('部分 mesh 未找到源场景实例，尺寸未知。');
    if (!mesh.trianglesKnown) continue;
    for (const size of mesh.instances) {
      if (!size) continue;
      const area = 2 * (size[0] * size[1] + size[1] * size[2] + size[2] * size[0]);
      const density = area > 1e-9 ? mesh.triangles / area : null;
      /** @type {DensityReason[]} */
      const reasons = [];
      if (Math.max(...size) <= thresholds.smallObjectMaxSizeMeters && mesh.triangles > thresholds.smallObjectTriangleLimit) reasons.push('small-high-poly');
      if (density !== null && density > thresholds.trianglesPerSquareMeterLimit) reasons.push('dense');
      if (reasons.length) { findings.push({ meshIndex: mesh.index, mesh: mesh.name, triangles: mesh.triangles,
        vertices: mesh.verticesKnown ? mesh.vertices : null, sizeMeters: size.map(entry => Number(entry.toPrecision(8))),
        trianglesPerSquareMeter: density === null ? null : Math.round(density), reasons }); break; }
    }
  }
  const trianglesKnown = meshes.every(mesh => mesh.trianglesKnown), instancesKnown = graphKnown && meshes.every(mesh => mesh.instanceCounts.every(count));
  /** @param {MeshMetric} mesh */
  const instances = mesh => { let amount = 0; for (const entry of mesh.instanceCounts) amount += entry ?? 0; return mesh.instanceCounts.length ? amount : 1; };
  return { meshCount: meshes.length,
    instanceCount: instancesKnown ? meshes.reduce((sum, mesh) => sum + instances(mesh), 0) : null,
    triangles: trianglesKnown && instancesKnown ? meshes.reduce((sum, mesh) => sum + mesh.triangles * instances(mesh), 0) : null,
    uniqueTriangles: trianglesKnown ? meshes.reduce((sum, mesh) => sum + mesh.triangles, 0) : null,
    materials: json.materials?.length ?? 0, textures: json.images?.length ?? 0, compression,
    unknownReasons: [...unknown], findings: findings.sort((a, b) => b.triangles - a.triangles) };
}
