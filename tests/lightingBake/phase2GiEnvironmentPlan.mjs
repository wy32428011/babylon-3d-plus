import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
// 与现有modelDensityAnalysis的glTF列主序TRS算法一致，只用于保守包围盒预算，不解码/修改顶点。
function multiply(a, b) { const out = Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return out; }
function localMatrix(node) {
  if (node.matrix !== undefined) { assert.ok(vector(node.matrix, 16) && [3, 7, 11].every(index => node.matrix[index] === 0) && node.matrix[15] === 1); return node.matrix; }
  const t = node.translation ?? [0, 0, 0], q = node.rotation ?? [0, 0, 0, 1], s = node.scale ?? [1, 1, 1];
  assert.ok(vector(t, 3) && vector(q, 4) && vector(s, 3));
  assert.ok(Math.abs(q.reduce((sum, value) => sum + value * value, 0) - 1) < 1e-5, '无效四元数不能用于预算');
  const [x, y, z, w] = q, [sx, sy, sz] = s;
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + w * z) * sx, 2 * (x * z - w * y) * sx, 0,
    2 * (x * y - w * z) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + w * x) * sy, 0,
    2 * (x * z + w * y) * sz, 2 * (y * z - w * x) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, ...t, 1];
}

export function estimateEnvironmentGiPlan(json, environment) {
  assert.equal((json.animations ?? []).length, 0, '含动画环境须先实际捕获，不能按静态JSON估计');
  assert.ok(Number.isFinite(environment.unitScaleToMeters) && environment.unitScaleToMeters > 0, '环境单位未知，不能估计物理探针预算');
  const scale = environment.unitScaleToMeters * (environment.transform?.scale ?? 1);
  assert.ok(Number.isFinite(scale) && scale > 0);
  const rotation = environment.transform?.rotation ?? { x: 0, y: 0, z: 0 };
  assert.ok([rotation.x, rotation.y, rotation.z].every(value => value === 0), '本案例预算只支持当前零旋转环境，不能猜测其它摆放');
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity], nodes = json.nodes ?? [], visited = new Set();
  let triangleCount = 0, primitiveCount = 0, vertexCount = 0, indexCount = 0, declaredInputNumericBytes = 0;
  const visit = (index, parent, chain) => {
    assert.ok(nodes[index] && !chain.has(index) && chain.size < 256 && !visited.has(index), '层级循环/重复节点不能推断完整几何');
    visited.add(index); const node = nodes[index]; assert.equal(node.skin, undefined);
    assert.equal(node.extensions?.EXT_mesh_gpu_instancing, undefined, 'GPU实例逐个矩阵需实际解码');
    const world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh]; assert.ok(mesh && Array.isArray(mesh.primitives), '源网格缺失，不能忽略');
      for (const primitive of mesh.primitives) {
      assert.equal(primitive.mode ?? 4, 4, '非三角面必须先核实际捕获，不可删掉');
      assert.equal(primitive.targets, undefined, '形变须实际捕获');
      const accessor = json.accessors?.[primitive.attributes?.POSITION];
      assert.ok(accessor && (accessor.componentType === undefined || accessor.componentType === 5126) && !accessor.normalized
        && vector(accessor.min, 3) && vector(accessor.max, 3) && accessor.min.every((value, axis) => value <= accessor.max[axis]), '位置界或单位未知');
      assert.ok(Number.isSafeInteger(accessor.count) && accessor.count > 0, '源顶点计数未知');
      const count = primitive.indices === undefined ? accessor.count : json.accessors?.[primitive.indices]?.count;
      assert.ok(Number.isSafeInteger(count) && count >= 0 && count % 3 === 0);
      triangleCount += count / 3; primitiveCount++; vertexCount += accessor.count; indexCount += count;
      const attributes = primitive.attributes;
      const components = 6 + (attributes.TEXCOORD_0 === undefined ? 0 : 2) + (attributes.TEXCOORD_1 === undefined ? 0 : 2)
        + (attributes.COLOR_0 === undefined ? 0 : 4) + (attributes.TANGENT === undefined ? 0 : 4);
      declaredInputNumericBytes += (accessor.count * components + count + 16) * 8;
      for (let corner = 0; corner < 8; corner++) {
        const point = [corner & 1 ? accessor.max[0] : accessor.min[0], corner & 2 ? accessor.max[1] : accessor.min[1], corner & 4 ? accessor.max[2] : accessor.min[2]];
        for (let axis = 0; axis < 3; axis++) {
          const value = (world[axis] * point[0] + world[4 + axis] * point[1] + world[8 + axis] * point[2] + world[12 + axis]) * scale;
          low[axis] = Math.min(low[axis], value); high[axis] = Math.max(high[axis], value);
        }
      }
      }
    }
    const next = new Set(chain); next.add(index); for (const child of node.children ?? []) visit(child, world, next);
  };
  const children = new Set(nodes.flatMap(node => node.children ?? []));
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, index) => index).filter(index => !children.has(index));
  for (const root of roots) visit(root, identity(), new Set());
  assert.ok(triangleCount > 0 && primitiveCount > 0 && low.every(Number.isFinite) && high.every(Number.isFinite));
  const extents = high.map((value, axis) => value - low[axis]);
  const counts = spacing => extents.reduce((total, extent) => total * Math.max(1, Math.ceil(extent / spacing)), 1);
  const spacing = [4, 6, 8, 10, 12, 16, 20, 24, 32, 48, 64, 100].find(value => counts(value) <= 768);
  assert.ok(spacing, '即使100m仍超预算，必须另行资源决策');
  assert.ok(triangleCount <= 1000000, '原环境超出新案例预注册1M三角预算，不删除几何追门槛');
  return { metadataEstimate: { triangleCount, primitiveCount, vertexCount, indexCount, extentsMeters: extents,
    inputNumericBytesAtMost18AttributesPerVertexEstimate: vertexCount * 18 * 8 + indexCount * 8,
    inputNumericBytesByDeclaredAttributesWithNormalsEstimate: declaredInputNumericBytes,
    expandedCorner20NumericComponentsEstimate: indexCount * 20 * 8,
    probeCountUpperEstimate: counts(spacing), note: 'accessor/node AABB estimate; final renderer bounds/count authoritative; translations/handedness can change origin, not current zero-rotation extents' },
    preregisteredBudget: { maxTriangles: 1000000, maxProbes: 1024, maxInputGeometryBytes: 256 * 1024 ** 2,
      maxDerivedNumericBytes: 1024 ** 3, maxTextureMiB: 256, maxCyclesPeakRssBytes: 4 * 1024 ** 3,
      maxObservedRendererHeapBytes: 2 * 1024 ** 3, maxWorkingDiskBytes: 2 * 1024 ** 3, bakeTimeoutMs: 600000 },
    pilot: { quality: 'preview', device: 'cpu', atlasSize: 1024, texelsPerMeter: 4, probeSpacing: spacing, maxTextureMiB: 256 },
    preserved: ['entire original environment GLB geometry/materials/hierarchy', 'original lighting main/fill/environment values', 'no extra model scripts'],
    unverifiedResourceCosts: ['actual receiver area/UV atlas count', 'actual captured geometry and derived buffers', 'Cycles OS peak RSS', 'renderer observed heap', 'own working disk during packaging'],
    status: 'PROPOSED_NOT_RENDERED_NOT_BAKED', requiresRootApprovalBeforeActualBake: true };
}

export function approveOriginalEnvironmentInputBudget(plan) {
  assert.equal(plan.sourceSceneSha256, '0e5379583e46511b8c780d9fd3e0225a294a219a0ce3d5f249d0061c5af75015');
  assert.equal(plan.environmentSha256, '819d2d007b0b8cae4799d525affe96a3d45d2a40895d0e32dfdaf547e0fccb7e');
  assert.equal(plan.status, 'PROPOSED_NOT_RENDERED_NOT_BAKED', '只能在新案例执行前调整已冻结输入的资源计划');
  assert.equal(plan.preregisteredBudget.maxInputGeometryBytes, 256 * 1024 ** 2);
  return { ...plan, planRevision: 2, preregisteredBudget: { ...plan.preregisteredBudget, maxInputGeometryBytes: 512 * 1024 ** 2 },
    budgetAdjustment: { field: 'maxInputGeometryBytes', previous: 256 * 1024 ** 2, approved: 512 * 1024 ** 2,
      basis: 'root approval before environment case execution; complete static declared input cost 269747432B and 18-component upper estimate 379370184B; physical RAM 127.69GiB',
      beforeRendererAndBake: true, basedOnLegacySmallOrPerformanceFailure: false, allOtherBudgetFieldsUnchanged: true } };
}

export async function createEnvironmentGiPlan(sourceScene, { approvedOriginalInput512MiB = false } = {}) {
  const original = await fs.readFile(sourceScene), document = JSON.parse(original.toString('utf8'));
  const environment = document.scene?.sceneSettings?.environment; assert.ok(environment?.activeVariantUrl && environment.visible !== false);
  assert.ok(!(document.scene.sceneSettings.lighting.bake.probeVolumes ?? []).some(volume => volume.enabled), '现有探针区域须先独立核预算');
  const reference = new URL(environment.activeVariantUrl); assert.equal(reference.protocol, 'editor-asset:');
  const file = decodeURIComponent(reference.pathname.slice(1)), handle = await fs.open(file, 'r');
  let json;
  try {
    const header = Buffer.alloc(20); await handle.read(header, 0, 20, 0); const stat = await handle.stat();
    assert.equal(header.readUInt32LE(0), 0x46546c67); assert.equal(header.readUInt32LE(4), 2); assert.equal(header.readUInt32LE(8), stat.size);
    const length = header.readUInt32LE(12); assert.equal(header.readUInt32LE(16), 0x4e4f534a); assert.ok(length <= 16 * 1024 ** 2 && 20 + length <= stat.size);
    const bytes = Buffer.alloc(length); await handle.read(bytes, 0, length, 20); json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await handle.close(); }
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
  const plan = { schemaVersion: 1, planRevision: 1, case: 'independent-original-environment-only', sourceScene: path.resolve(sourceScene), sourceSceneSha256: createHash('sha256').update(original).digest('hex'),
    environmentFile: file, environmentSha256: hash.digest('hex'), environmentSettings: environment,
    originalLighting: document.scene.sceneSettings.lighting, ...estimateEnvironmentGiPlan(json, environment) };
  return approvedOriginalInput512MiB ? approveOriginalEnvironmentInputBudget(plan) : plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv.length === 4 || process.argv.length === 5 && process.argv[4] === '--approved-original-input-512mib',
    '用法：node tests/lightingBake/phase2GiEnvironmentPlan.mjs <原scene.json> <新plan.json> [--approved-original-input-512mib]；只读元数据/哈希，不启动渲染或烘焙');
  const file = path.resolve(process.argv[3]), base = path.resolve('output'), relative = path.relative(base, file);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const plan = await createEnvironmentGiPlan(path.resolve(process.argv[2]), { approvedOriginalInput512MiB: process.argv.length === 5 });
  await fs.writeFile(file, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(plan, null, 2));
}
