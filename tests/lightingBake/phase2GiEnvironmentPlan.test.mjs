import assert from 'node:assert/strict';
import test from 'node:test';
import { approveOriginalEnvironmentInputBudget, estimateEnvironmentGiPlan } from './phase2GiEnvironmentPlan.mjs';

function fixture() {
  return { scene: 0, scenes: [{ nodes: [0] }], nodes: [{ translation: [10, 0, 0], children: [1] }, { mesh: 0, scale: [2, 1, 1] }],
    accessors: [{ count: 30000, componentType: 5126, min: [0, 0, 0], max: [80, 8, 20] }, { count: 60000 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }] };
}
const environment = { unitScaleToMeters: 1, transform: { position: { x: 4, y: 2, z: -10 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 } };

test('环境only预算沿真实glTF层级/实例累计全部几何，先冻结独立1M/1024预算不启动渲染', () => {
  const json = fixture();
  json.nodes[0].children.push(2); json.nodes.push({ mesh: 0, translation: [200, 0, 0] });
  const plan = estimateEnvironmentGiPlan(json, environment);
  assert.equal(plan.metadataEstimate.triangleCount, 40000); assert.equal(plan.metadataEstimate.primitiveCount, 2);
  assert.deepEqual(plan.metadataEstimate.extentsMeters, [280, 8, 20]);
  assert.ok(plan.metadataEstimate.probeCountUpperEstimate <= 768);
  assert.equal(plan.preregisteredBudget.maxTriangles, 1000000); assert.equal(plan.preregisteredBudget.maxProbes, 1024);
  assert.equal(plan.pilot.atlasSize, 1024); assert.equal(plan.pilot.quality, 'preview');
  assert.equal(plan.status, 'PROPOSED_NOT_RENDERED_NOT_BAKED'); assert.equal(plan.requiresRootApprovalBeforeActualBake, true);
});

test('环境only规划保留未知/不支持/超预算，不能偷偷省略节点或增大旧门槛', () => {
  const missing = fixture(); missing.nodes[1].mesh = 999;
  assert.throws(() => estimateEnvironmentGiPlan(missing, environment), /网格缺失/);
  const cycle = fixture(); cycle.nodes[1].children = [0];
  assert.throws(() => estimateEnvironmentGiPlan(cycle, environment), /层级/);
  const large = fixture(); large.accessors[1].count = 3000003;
  assert.throws(() => estimateEnvironmentGiPlan(large, environment), /1M三角预算/);
  const animated = fixture(); animated.animations = [{}];
  assert.throws(() => estimateEnvironmentGiPlan(animated, environment), /动画环境/);
  assert.throws(() => estimateEnvironmentGiPlan(fixture(), { ...environment, unitScaleToMeters: undefined }), /单位未知/);
  assert.throws(() => estimateEnvironmentGiPlan(fixture(), { ...environment, transform: { ...environment.transform, rotation: { x: 0, y: 1, z: 0 } } }), /零旋转/);
});

test('执行前获批512MiB调整只适用冻结原环境，不改变其它预算或追认已执行案例', () => {
  const first = { ...estimateEnvironmentGiPlan(fixture(), environment), sourceSceneSha256: '0e5379583e46511b8c780d9fd3e0225a294a219a0ce3d5f249d0061c5af75015',
    environmentSha256: '819d2d007b0b8cae4799d525affe96a3d45d2a40895d0e32dfdaf547e0fccb7e' };
  const second = approveOriginalEnvironmentInputBudget(first);
  assert.equal(first.preregisteredBudget.maxInputGeometryBytes, 256 * 1024 ** 2);
  assert.equal(second.planRevision, 2); assert.equal(second.preregisteredBudget.maxInputGeometryBytes, 512 * 1024 ** 2);
  for (const [field, value] of Object.entries(first.preregisteredBudget)) if (field !== 'maxInputGeometryBytes') assert.equal(second.preregisteredBudget[field], value);
  assert.throws(() => approveOriginalEnvironmentInputBudget({ ...first, environmentSha256: 'different' }));
  assert.throws(() => approveOriginalEnvironmentInputBudget({ ...first, status: 'ALREADY_BAKED' }));
});
