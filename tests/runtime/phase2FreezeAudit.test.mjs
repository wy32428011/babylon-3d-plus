import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectPhase2FreezeAudit } from '../../scripts/lib/phase2FreezeAudit.mjs';

function node(name, parent = null) {
  return { name, parent, position: { x: 0, y: 0, z: 0 }, scaling: { x: 1, y: 1, z: 1 },
    animations: [], billboardMode: 0, geometry: { _totalVertices: 24 }, isWorldMatrixFrozen: false, _nodeDataStorage: { _isDisposed: false },
    computeWorldMatrix() { throw new Error('审计不能计算矩阵'); }, getWorldMatrix() { throw new Error('审计不能读取或触发惰性矩阵'); },
    freezeWorldMatrix() { throw new Error('审计不能freeze'); }, unfreezeWorldMatrix() { throw new Error('审计不能unfreeze'); },
    markAsDirty() { throw new Error('审计不能标脏'); }, getChildren() { throw new Error('审计不能调用未知遍历方法'); } };
}
function fixture(count = 2) {
  const root = node('environment-root'), meshes = Array.from({ length: count }, (_, index) => node('leaf-' + index, root));
  const scene = { meshes, transformNodes: [root], lights: [], cameras: [], animationGroups: [], _activeAnimatables: [] };
  const environmentRuntime = { current: { root, container: { meshes }, controlledTransforms: {}, disposed: false }, pending: null, adjustmentActive: false };
  return { root, meshes, scene, environmentRuntime, runtime: { environment: { environmentRuntime }, assets: { models: new Map() } } };
}

test('只读统计受控环境叶网格，不调用任何矩阵/冻结/collector或更改输入', () => {
  const f = fixture(); f.meshes[0].isWorldMatrixFrozen = true;
  f.runtime.environment.lightingRuntime = { getClassification() { throw new Error('禁止lighting全量收集'); } };
  const before = JSON.stringify({ scene: f.scene, root: f.root });
  const report = collectPhase2FreezeAudit(f);
  assert.equal(report.summary.total, 2); assert.equal(report.summary.frozen, 1); assert.equal(report.summary.unfrozen, 1);
  assert.equal(report.summary.eligible, 2); assert.equal(report.summary.eligibleAlreadyFrozen, 1); assert.equal(report.summary.eligibleUnfrozen, 1);
  assert.deepEqual(report.byOwner, { environment: 2 }); assert.deepEqual(report.rejectionReasons, {});
  assert.equal(JSON.stringify({ scene: f.scene, root: f.root }), before);
});

test('无明确所有权时不把名字/当前无动画当成安全静态证明', () => {
  const f = fixture(); f.meshes[0].name = 'static-environment-freeze-safe';
  f.meshes[0].metadata = { editorStaticWorldMatrix: true };
  const report = collectPhase2FreezeAudit({ scene: f.scene });
  assert.equal(report.summary.eligible, 0); assert.equal(report.byOwner.unknown, 2);
  assert.equal(report.rejectionReasons.unknownOwnership, 2);
});

test('动画/蒙皮/Morph/action及动态元数据在任何祖先上都会拒绝', () => {
  for (const [property, value, reason] of [
    ['skeleton', {}, 'mutableAncestry'], ['morphTargetManager', {}, 'mutableAncestry'],
    ['actionManager', {}, 'mutableAncestry'], ['bakedVertexAnimationManager', {}, 'mutableAncestry'],
    ['animations', [{}], 'animatedAncestry'], ['billboardMode', 7, 'dynamicPresentation'],
    ['infiniteDistance', true, 'dynamicPresentation'], ['metadata', { runtimeDynamic: true }, 'dynamicMetadata'],
    ['metadata', { scripts: [{}] }, 'externalScript'], ['metadata', { editorStaticWorldMatrix: false }, 'explicitDynamic'],
  ]) {
    const f = fixture(1); f.root[property] = value;
    const report = collectPhase2FreezeAudit(f);
    assert.equal(report.summary.eligible, 0, property); assert.equal(report.rejectionReasons[reason], 1, property);
  }
  for (const kind of ['animationGroups', '_activeAnimatables']) {
    const f = fixture(1);
    f.scene[kind] = kind === 'animationGroups' ? [{ targetedAnimations: [{ target: f.root }] }] : [{ target: f.root }];
    assert.equal(collectPhase2FreezeAudit(f).rejectionReasons.animatedAncestry, 1);
  }
});

test('模型脚本/遥测/原生实例/薄实例与未认证静态模型保持拒绝', () => {
  const f = fixture(4);
  f.runtime.assets.models.set('a', { root: f.meshes[0], entitySnapshot: { components: { modelAsset: { scriptAssets: [{}] }, telemetryBinding: { enabled: true } } } });
  f.runtime.assets.models.set('b', { root: f.meshes[1], entitySnapshot: { components: { modelAsset: { scriptAssets: [] } } } });
  f.meshes[2].isAnInstance = true; f.meshes[3].thinInstanceCount = 17;
  const report = collectPhase2FreezeAudit(f);
  assert.equal(report.summary.eligible, 0); assert.equal(report.byOwner.model, 2);
  assert.equal(report.rejectionReasons.modelNotCertifiedStatic, 2);
  assert.equal(report.rejectionReasons.externalScript, 1); assert.equal(report.rejectionReasons.telemetry, 1);
  assert.equal(report.rejectionReasons.instanceOwnership, 2);
});

test('受控环境的中间节点不纳入叶候选；负/非均匀静态缩放仅报告不误称动态', () => {
  const f = fixture(2); f.meshes[1].parent = f.meshes[0];
  f.root.scaling = { x: -2, y: 1, z: 3 };
  const report = collectPhase2FreezeAudit(f);
  assert.equal(report.summary.eligible, 1); assert.equal(report.rejectionReasons.nonLeaf, 1);
  assert.equal(report.flags.negativeDeterminantScale, 2); assert.equal(report.flags.nonUniformScale, 2);
  f.environmentRuntime.adjustmentActive = true;
  assert.equal(collectPhase2FreezeAudit(f).summary.eligible, 0);
  f.environmentRuntime.adjustmentActive = false; f.environmentRuntime.pending = {};
  assert.equal(collectPhase2FreezeAudit(f).summary.eligible, 0);
});

test('未知访问器失败和父链循环显式拒绝，细节截断不影响总计', () => {
  const f = fixture(2), unknown = node('unknown');
  Object.defineProperty(unknown, 'parent', { get() { throw new Error('uninspectable'); } });
  f.scene.transformNodes.push(unknown);
  const report = collectPhase2FreezeAudit({ ...f, detailLimit: 1 });
  assert.equal(report.summary.eligible, 0); assert.equal(report.rejectionReasons.incompleteStructureInspection, 2);
  assert.equal(report.rows.length, 1); assert.equal(report.detailsTruncated, true); assert.equal(report.summary.total, 2);
  const cycle = fixture(1); cycle.meshes[0].parent = cycle.meshes[0];
  assert.equal(collectPhase2FreezeAudit(cycle).rejectionReasons.parentCycle, 1);
});

test('导出的函数无需模块闭包即可在page.evaluate环境独立执行', () => {
  const standalone = new Function('return (' + collectPhase2FreezeAudit.toString() + ');')();
  const f = fixture();
  assert.deepEqual(standalone(f), collectPhase2FreezeAudit(f));
  assert.throws(() => standalone({ scene: {} }), /scene.meshes/);
});

test('空几何、未知几何和受控根外未知祖先都不成为安全候选', () => {
  const f = fixture(3); f.meshes[0].geometry._totalVertices = 0; delete f.meshes[1].geometry;
  let report = collectPhase2FreezeAudit(f);
  assert.equal(report.summary.eligible, 1); assert.equal(report.rejectionReasons.emptyGeometry, 1);
  assert.equal(report.rejectionReasons.geometryNotInspectable, 1);
  f.root.parent = node('unowned-parent');
  report = collectPhase2FreezeAudit(f);
  assert.equal(report.summary.eligible, 0); assert.equal(report.rejectionReasons.unknownAncestorOwnership, 3);
});

test('其它模型的未约束脚本也阻止把环境推断为新增安全冻结候选', () => {
  const f = fixture(1), modelRoot = node('script-model');
  f.runtime.assets.models.set('script-model', { root: modelRoot, externalScriptRuntime: {} });
  const report = collectPhase2FreezeAudit(f);
  assert.equal(report.summary.eligible, 0);
  assert.equal(report.rejectionReasons.unboundedExternalScriptAccess, 1);
  assert.equal(report.unrestrictedScriptOwnerCount, 1);
});
