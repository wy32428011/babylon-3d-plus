import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { createSceneLightingPolicyResolver } from '../../electron/shared/sceneLightingPolicy.ts';
import { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';
import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';
import { bindReceiverRoiDocument, encodeReceiverRoiJson, makeUnboundReceiverRoiDocument, readReceiverRoiPlan,
  receiverRoiBudgetEvidence, ROI_LIMITS, roiSha, verifyAppliedReceiverRoi, verifyReceiverRoiRuntime,
  assertReceiverRoiCapture, assertReceiverRoiVersionLock, relocateReceiverRoiDocument, readReceiverRoiReceipt,
  copyReceiverRoiRun, readReceiverRoiVersionLock } from './phase2GiReceiverRoi.mjs';

// default package test不能依赖本机output/原工厂。798行仅是小metadata，不含原scene/GLB或数值几何。
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-roi-contract-'));
after(async () => { assert.equal(path.dirname(fixtureRoot), path.resolve(os.tmpdir())); assert.ok(path.basename(fixtureRoot).startsWith('phase2-roi-contract-'));
  await fs.rm(fixtureRoot, { recursive: true, force: true }); });
const writeJson = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); const bytes = encodeReceiverRoiJson(value); await fs.writeFile(file, bytes); return roiSha(bytes); };
const originalLighting = { version: 2, policy: { version: 1, defaults: {}, rules: [] }, result: null,
  bake: { enabled: true, quality: 'production', atlasSize: 2048, texelsPerMeter: 8, probeSpacing: 16, maxTextureMiB: 256, probeVolumes: [] } };
const environmentSettings = { visible: true, packagePath: 'fixture-environment', activeVariantUrl: 'fixture-original.glb' };
const inventory = Array.from({ length: 798 }, (_, index) => ({ key: '$environment/node:' + index, nodeKey: 'node:' + index, entityId: '$environment',
  worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index, 0, 0, 1] }));
const selectedNodes = inventory.slice(0, 33).map((row, index) => ({ nodeKey: row.nodeKey, triangles: index < 21 ? 938 : 400 }));
const sourceEvidenceRoot = path.join(fixtureRoot, 'evidence'), inputMetadata = path.join(sourceEvidenceRoot, 'input.json');
const inputMetadataSha256 = await writeJson(inputMetadata, { meshes: inventory });
const sourceScene = path.join(fixtureRoot, 'source', 'Scenes', 'original.scene.json'), environmentFile = path.join(fixtureRoot, 'source', 'Assets', 'model.glb');
await fs.mkdir(path.dirname(environmentFile), { recursive: true }); await fs.writeFile(environmentFile, Buffer.from('synthetic-byte-fixture-not-a-rendered-GLB'));
const sourceSceneSha256 = await writeJson(sourceScene, { fixtureOnly: true });
const approvedFile = path.join(sourceEvidenceRoot, 'approved.json');
const approvedSha = await writeJson(approvedFile, { sourceScene, sourceSceneSha256, environmentFile,
  environmentSha256: roiSha(await fs.readFile(environmentFile)), originalLighting, environmentSettings });
await writeJson(path.join(sourceEvidenceRoot, 'nonreceiver-uv-real-1', 'report.json'), { status: 'PASS', cases: Array.from({ length: 9 }, () => ({ synthetic: true })), frozenSourcesUnchanged: true });
await writeJson(path.join(sourceEvidenceRoot, 'nonreceiver-uv-real-1', 'comparison-details.json'), { status: 'PASS_ALL_SAVED_COMPONENT_COMPARISONS', sums: { synthetic: { all: { different: 0 } } } });
await writeJson(path.join(sourceEvidenceRoot, 'nonreceiver-uv-real-1', 'environment-roi-static-admission.json'), { inputMetadataSha256, binaryGeometryRead: false,
  selectedReceiverNodeCount: 33, nonreceiverNodeCount: 765, staticFieldCompatibleCount: 765, withRequiredUvFiniteValuesUnverified: 552 });
const planFile = path.join(fixtureRoot, 'plan.json');
await writeJson(planFile, { version: 1, status: 'PROPOSED_NOT_RENDERED_NOT_BAKED_RESOURCE_IDENTITY_UNBOUND',
  sourceEvidence: { inputMetadata, inputMetadataSha256, originalApprovedPlan: approvedFile, originalApprovedPlanSha256: approvedSha },
  unchangedFullInputDeclaration: { meshCount: 798, triangleCount: 866611, projectedProbeCountAtUnchangedSpacing16: 585 },
  receiverCandidate: { sourceNodeCount: 33, triangleCount: 24498, selectedNodes }, nonreceiverInputDeclaration: { sourceNodeCount: 765, triangleCount: 842113 },
  pilot: { device: 'cpu', quality: 'preview', atlasSize: 1024, texelsPerMeter: 4, probeSpacing: 16, maxTextureMiB: 256 },
  preregisteredBudget: ROI_LIMITS, previousFailuresPreserved: ['original 600000ms UV timeout remains failed'] });
const bundle = await readReceiverRoiPlan(planFile);
const scenePath = path.resolve('output/roi-unit-not-created/project/Scenes/unbound.scene.json');
const identity = 'a1'.repeat(8); // 单元模拟实际API返回值，不是原资源身份，不写入任何真实场景。
function baseDocument() {
  const lighting = structuredClone(bundle.approved.originalLighting);
  lighting.policy = { version: 1, defaults: { castShadows: false, receiveShadows: true },
    rules: [{ id: 'retained-other-type', enabled: true, target: { kind: 'type', deviceType: 'forklift' }, values: { mobility: 'dynamic' } }] };
  return { version: 6, scene: { id: 'pure-roi-test', name: 'pure fixture', entityIds: ['light-on', 'light-off'],
    entities: { 'light-on': { id: 'light-on', enabled: true, components: { light: { enabled: true, intensity: 3 } } },
      'light-off': { id: 'light-off', enabled: false, components: { light: { enabled: false, intensity: 7 } } } },
    sceneSettings: { environment: { ...structuredClone(bundle.approved.environmentSettings), activeVariantUrl: 'editor-asset://local/' + encodeURIComponent('F:/owned/roi/model.glb') }, lighting } } };
}
function observed(document, captureId = 'pure-before', currentPath = scenePath) {
  const resolve = createSceneLightingPolicyResolver(document.scene.sceneSettings.lighting.policy);
  const directory = bundle.inventory.map(row => row.nodeKey);
  const classification = directory.map(nodeKey => {
    const context = { entityId: '$environment', nodeKey, partKey: nodeKey, resourceIdentity: identity, deviceType: 'environment',
      motionRole: 'fixed', automatic: { mobility: 'static', reason: 'environment' }, modelAsset: { sourceUrl: document.scene.sceneSettings.environment.activeVariantUrl } };
    const effective = resolve({ ...context, availableNodeKeys: directory });
    return { key: '$environment/' + nodeKey, entityId: '$environment', nodeKey, resourceIdentity: identity,
      ...effective.settings, automaticMobility: 'static', motionRole: 'fixed', deviceType: 'environment', policyContext: context,
      policyMismatches: effective.mismatches, policyConflicts: effective.conflicts };
  });
  return { kind: 'ACTUAL_EDITOR_RUNTIME_CLASSIFICATION', captureId, editorPid: 12345, capturedAt: '2026-10-25T00:00:00Z',
    scenePath: currentPath, sceneSha256: roiSha(encodeReceiverRoiJson(document)), environmentSha256: bundle.approved.environmentSha256,
    runtimeError: null, statistics: { sceneId: document.scene.id, phase: 'ready', modelTriangleCount: 0, environmentTriangleCount: 866611 }, classification };
}
function fixture() {
  const base = baseDocument(), document = makeUnboundReceiverRoiDocument(base, bundle), snapshot = observed(document);
  const expected = { scenePath, sceneSha256: snapshot.sceneSha256 };
  return { base, document, snapshot, expected };
}

test('独立合成小计划完整校验SHA/9例证据结构，798/866611全输入与33/24498 ROI分别保留', async () => {
  const before = roiSha(await fs.readFile(planFile));
  const again = await readReceiverRoiPlan(planFile);
  assert.equal(again.planSha256, before); assert.equal(roiSha(await fs.readFile(planFile)), before);
  assert.equal(again.inventory.length, 798); assert.equal(again.plan.receiverCandidate.selectedNodes.length, 33);
  assert.equal(again.plan.receiverCandidate.triangleCount, 24498);
  assert.equal(again.uvEvidence.cases, 9); assert.equal(again.uvEvidence.actualPredicateSkipCount, null);
  assert.deepEqual(again.actual, { runtimeIdentity: null, predicateSkipCount: null, receiverTriangles: null, probeCount: null, uvArea: null, atlasPages: null });
  assert.ok(again.plan.previousFailuresPreserved.some(value => value.includes('600000ms UV timeout')));
});

test('unbound文档禁bake，不写null身份nodeRule；原灯光/禁用状态/环境/原policy不变', () => {
  const f = fixture(), before = structuredClone(f.base);
  assert.equal(f.document.scene.sceneSettings.lighting.bake.enabled, false);
  assert.equal(f.document.scene.sceneSettings.lighting.result, null);
  assert.deepEqual(f.document.scene.entities, before.scene.entities);
  assert.deepEqual(f.document.scene.sceneSettings.environment, before.scene.sceneSettings.environment);
  assert.deepEqual(f.document.scene.sceneSettings.lighting.policy, before.scene.sceneSettings.lighting.policy);
  assert.deepEqual(f.base, before);
  assert.equal(f.document.scene.sceneSettings.lighting.bake.probeSpacing, 16);
  const unknown = structuredClone(f.base); unknown.scene.entities['light-on'].components.modelGenerator = {};
  assert.throws(() => makeUnboundReceiverRoiDocument(unknown, bundle), /未知模型脚本/);
});

test('纯模拟runtime校验精确identity/key后才生成33 nodeRule，shared真实resolver验证765非receiver且旗标不变', () => {
  const f = fixture(), before = structuredClone(f.document);
  const bound = bindReceiverRoiDocument(f.document, bundle, f.snapshot, f.expected);
  assert.deepEqual(f.document, before);
  assert.equal(bound.document.scene.sceneSettings.lighting.bake.enabled, false);
  const rule = bound.document.scene.sceneSettings.lighting.policy.rules.at(-1);
  assert.deepEqual(rule.values, { bakeIndirect: false }); assert.equal(rule.nodeRules.length, 33);
  assert.ok(rule.nodeRules.every(node => node.target.resourceIdentity === identity && node.target.kind === 'node'));
  assert.deepEqual(rule.nodeRules.map(node => node.target.nodeKey).sort(), bundle.plan.receiverCandidate.selectedNodes.map(node => node.nodeKey).sort());
  const boundPath = path.resolve('output/roi-unit-not-created/project/Scenes/bound.scene.json');
  const fresh = observed(bound.document, 'pure-after', boundPath);
  const result = verifyAppliedReceiverRoi(bundle, bound.document, fresh, { scenePath: boundPath, sceneSha256: fresh.sceneSha256 }, bound.binding);
  assert.equal(result.policyReceiverNodes, 33); assert.equal(fresh.classification.filter(row => !row.bakeIndirect).length, 765);
  assert.equal(result.actualReceiverTriangles, null); assert.equal(result.actualProbeCount, null); assert.equal(result.bakeAllowed, false);
  assert.ok(fresh.classification.every(row => row.castShadows === false && row.receiveShadows === true && row.mobility === 'static'));
});

test('缺身份/目录漂移/只按name/非原GLB/错scene/unknown role等不产生可bake绑定', () => {
  const f = fixture();
  for (const mutate of [
    value => { value.classification[0].resourceIdentity = ''; value.classification[0].policyContext.resourceIdentity = ''; },
    value => { value.classification[0].resourceIdentity = 'different'; },
    value => { value.classification.pop(); },
    value => { value.classification[0].nodeKey = 'name-only'; value.classification[0].policyContext.partKey = 'name-only'; },
    value => { value.environmentSha256 = '0'.repeat(64); }, value => { value.sceneSha256 = '0'.repeat(64); },
    value => { value.classification[0].motionRole = 'unknown'; }, value => { value.statistics.environmentTriangleCount--; },
    value => { value.runtimeError = 'not ready'; }, value => { value.classification[0].policyMismatches = [{}]; },
  ]) {
    const bad = structuredClone(f.snapshot); mutate(bad);
    assert.throws(() => bindReceiverRoiDocument(f.document, bundle, bad, f.expected));
    assert.equal(f.document.scene.sceneSettings.lighting.bake.enabled, false);
  }
  const renamed = structuredClone(f.snapshot); renamed.classification.forEach(row => { row.name = '同一显示名不能作为绑定'; });
  assert.equal(verifyReceiverRoiRuntime(bundle, f.document, renamed, f.expected).selected.length, 33);
});

test('应用后必须fresh同身份且严格receiver/旗标，无fresh/漂移不被旧观察遮蔽', () => {
  const f = fixture(), bound = bindReceiverRoiDocument(f.document, bundle, f.snapshot, f.expected);
  const fresh = observed(bound.document, 'new-capture');
  const expected = { scenePath, sceneSha256: fresh.sceneSha256 };
  for (const change of [value => { value.captureId = f.snapshot.captureId; }, value => { value.classification[0].bakeIndirect = !value.classification[0].bakeIndirect; },
    value => { value.classification[0].castShadows = true; }, value => { value.classification.forEach(row => { row.resourceIdentity = 'b2'.repeat(8); row.policyContext.resourceIdentity = row.resourceIdentity; }); }]) {
    const bad = structuredClone(fresh); change(bad);
    assert.throws(() => verifyAppliedReceiverRoi(bundle, bound.document, bad, expected, bound.binding));
  }
});

test('固定预算缺测unknown不可填0，越2GiB/4GiB/512MiB/10min或缩源receiver均拒绝', () => {
  const unknown = receiverRoiBudgetEvidence(bundle);
  assert.equal(unknown.status, 'UNKNOWN_NOT_ADMITTED'); assert.equal(unknown.bakeAllowed, false);
  assert.equal(unknown.actualPredicateSkipCount, null); assert.ok(unknown.unknown.includes('actualProbeCount'));
  const measured = { rendererHeapMaxObservedBytes: 1024 ** 3, cyclesPeakRssBytes: 3 * 1024 ** 3, workingDiskMaxObservedBytes: 1024 ** 3,
    inputGeometryBytes: 269747432, derivedNumericBytes: 400000000, atlasBytes: 16777216, durationMs: 120000,
    actualProbeCount: 585, inputMeshCount: 798, inputTriangleCount: 866611, receiverNodeCount: 33, receiverTriangleCount: 24498 };
  assert.equal(receiverRoiBudgetEvidence(bundle, measured).status, 'MEASURED_BUDGETS_WITHIN_LIMITS_NOT_VIEWER_ACCEPTANCE');
  for (const [field, value] of [['rendererHeapMaxObservedBytes', ROI_LIMITS.maxObservedRendererHeapBytes + 1], ['cyclesPeakRssBytes', ROI_LIMITS.maxCyclesPeakRssBytes + 1],
    ['inputGeometryBytes', ROI_LIMITS.maxInputGeometryBytes + 1], ['durationMs', 600001], ['inputMeshCount', 797], ['receiverTriangleCount', 1000], ['actualProbeCount', 1]]) {
    assert.equal(receiverRoiBudgetEvidence(bundle, { ...measured, [field]: value }).status, 'BUDGET_VIOLATION');
  }
  assert.equal(receiverRoiBudgetEvidence(bundle, { ...measured, actualProbeCount: 0 }).status, 'BUDGET_VIOLATION');
});

test('薄CLI help仅声明prepare/bind/validate，没有启动/发布/bake入口', () => {
  const result = spawnSync(process.execPath, ['scripts/phase2-gi-receiver-roi.mjs', '--help'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /No command launches Editor/); assert.match(result.stdout, /bake.enabled=false/);
});

const versionLock = () => ({ kind: 'ROI_SOURCE_AND_BUILD_TREE_SHA256_V1', sources: { 'src/sentinel.ts': '1'.repeat(64) }, builds: { 'dist-electron/main.js': '2'.repeat(64) } });

test('源码/build完整锁拒绝空值、内容变化、新增或删除，目录读取只读小合成树', async () => {
  const root = path.join(fixtureRoot, 'versions');
  const helperText = await fs.readFile(new URL('./phase2GiReceiverRoi.mjs', import.meta.url), 'utf8');
  const sourceFiles = [...helperText.match(/const SOURCE_FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  for (const name of [...sourceFiles, 'src/sentinel.ts', 'electron/shared/sentinel.ts', 'dist-electron/main.js',
    'dist-electron/lighting-bake/cycles_bake.py', 'dist-viewer-template/index.html']) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), 'fixture:' + name);
  }
  const initial = await readReceiverRoiVersionLock(root); assertReceiverRoiVersionLock(initial, await readReceiverRoiVersionLock(root));
  assert.throws(() => assertReceiverRoiVersionLock({}, initial));
  for (const mutate of [value => { value.sources['src/sentinel.ts'] = '0'.repeat(64); }, value => { delete value.builds['dist-electron/main.js']; },
    value => { value.sources['src/new.ts'] = '0'.repeat(64); }]) {
    const changed = structuredClone(initial); mutate(changed); assert.throws(() => assertReceiverRoiVersionLock(initial, changed));
  }
  await fs.writeFile(path.join(root, 'dist-viewer-template', 'added.js'), 'new build chunk');
  assert.throws(() => assertReceiverRoiVersionLock(initial, { ...initial, builds: { ...initial.builds, 'dist-viewer-template/added.js': roiSha('new build chunk') } }));
});

test('运行地址搬迁仅本owned根且逐值可逆，不改policy/灯光/质量或外部普通文本', () => {
  const f = fixture(), from = path.resolve('output/pure-prepared/project'), to = path.resolve('output/pure-run/project');
  f.document.scene.sceneSettings.environment.activeVariantUrl = 'editor-asset://local/' + encodeURIComponent(path.join(from, 'Assets', 'model.glb'));
  f.document.scene.sceneSettings.environment.packagePath = path.join(from, 'Assets', 'environment');
  f.document.scene.sceneSettings.environment.extraFileUrl = pathToFileURL(path.join(from, 'Assets', 'meta.json')).href;
  const before = structuredClone(f.document), moved = relocateReceiverRoiDocument(f.document, from, to);
  assert.equal(moved.references.length, 3); assert.deepEqual(relocateReceiverRoiDocument(moved.document, to, from).document, before);
  assert.deepEqual(f.document, before); assert.deepEqual(moved.document.scene.entities, f.document.scene.entities);
  const bad = structuredClone(f.document); bad.scene.sceneSettings.environment.activeVariantUrl = 'editor-asset://local/' + encodeURIComponent(path.resolve('outside.glb'));
  assert.throws(() => relocateReceiverRoiDocument(bad, from, to), /冻结工程/);
});

function freshCapture() {
  const settings = { ...makeUnboundReceiverRoiDocument(baseDocument(), bundle).scene.sceneSettings.lighting.bake, enabled: true };
  const selected = new Map(selectedNodes.map(row => [row.nodeKey, row.triangles]));
  const keys = inventory.map((row, index) => ({ ...row, positions: 9, receiver: selected.has(row.nodeKey),
    indices: 3 * (selected.get(row.nodeKey) ?? (index - 33 < 613 ? 1101 : 1100)) }));
  const proof = { proofKind: 'metadata-of-actual-capture-not-full-numeric-copy', signature: 'fresh-signature', settings,
    meshCount: 798, triangleCount: 866611, receiverCount: 33, receiverTriangleCount: 24498, geometryBytes: 269747432, rendererHeapMaxObservedBytes: 1024 ** 3, keys,
    preflight: { signature: 'fresh-signature', meshCount: 798, receiverCount: 33, triangleCount: 866611, probeCount: 585, probeCountExact: true,
      geometryBytes: 269747432, estimatedDerivedNumericBytes: 24498 * 3 * 11 * 8, minTextureBytes: 4 * 1024 ** 2, issues: [] } };
  return { proof, settings };
}

test('同一fresh输入仅798/866611遮挡与33/24498receiver、585精确probe可过，旧全receiver/缺测/超限拒绝', () => {
  const { proof, settings } = freshCapture(), accepted = assertReceiverRoiCapture(bundle, proof, settings);
  assert.equal(accepted.receiverTriangleCount, 24498); assert.equal(accepted.actualProbeCount, 585); assert.equal(accepted.actualPredicateSkipCount, null);
  for (const change of [value => { value.receiverCount = 798; value.receiverTriangleCount = 866611; }, value => { delete value.preflight; },
    value => { delete value.geometryBytes; },
    value => { value.preflight.probeCount = null; }, value => { value.preflight.probeCountExact = false; },
    value => { value.preflight.geometryBytes = ROI_LIMITS.maxInputGeometryBytes + 1; }, value => { value.rendererHeapMaxObservedBytes = 0; },
    value => { value.keys[0].nodeKey = value.keys[1].nodeKey; }, value => { value.keys[40].receiver = true; },
    value => { value.keys[40].indices += 3; }, value => { value.keys[40].worldMatrix[12]++; }, value => { value.preflight.issues.push({ severity: 'error', code: 'fixture-error' }); }]) {
    const changed = structuredClone(proof); change(changed); assert.throws(() => assertReceiverRoiCapture(bundle, changed, settings));
  }
});

async function receiptFixture(t) {
  await fs.mkdir(path.resolve('output'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('output', '.phase2-roi-receipt-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve('output')); assert.ok(path.basename(root).startsWith('.phase2-roi-receipt-')); await fs.rm(root, { recursive: true, force: true }); });
  const project = path.join(root, 'project'), scenePath = path.join(project, 'Scenes', 'unbound.scene.json');
  await fs.mkdir(path.join(project, 'Assets'), { recursive: true }); await fs.copyFile(environmentFile, path.join(project, 'Assets', 'model.glb'), constants.COPYFILE_EXCL);
  const document = makeUnboundReceiverRoiDocument(baseDocument(), bundle);
  document.scene.sceneSettings.environment.activeVariantUrl = 'editor-asset://local/' + encodeURIComponent(path.join(project, 'Assets', 'model.glb'));
  document.scene.sceneSettings.environment.packagePath = path.join(project, 'Assets');
  const sceneSha256 = await writeJson(scenePath, document);
  await fs.copyFile(planFile, path.join(root, 'roi-plan-frozen.json'), constants.COPYFILE_EXCL);
  const prepared = { status: 'PREPARED_RESOURCE_IDENTITY_UNBOUND_BAKE_DISABLED', project, scenePath, sceneSha256,
    sourceSceneSha256, environmentSha256: bundle.approved.environmentSha256, planSha256: bundle.planSha256, evidenceSha256: bundle.evidenceSha256,
    basePreparation: { sourceScene, sourceProject: path.dirname(path.dirname(sourceScene)), sourceSceneSha256,
      copiedAssets: [{ path: 'Assets/model.glb', sha256: bundle.approved.environmentSha256, bytes: (await fs.stat(environmentFile)).size }] }, bakeAllowed: false };
  const preparationFile = path.join(root, 'roi-preparation.json'), preparationSha256 = await writeJson(preparationFile, prepared);
  const closeActions = ['close-owned-editor', 'close-owned-vite', 'remove-owned-bootstrap'].map(name => ({ name, status: 'PASS' }));
  const writeDriver = observation => writeJson(observation.driverReport, { status: 'ROI_ACTUAL_CLASSIFICATION_ONLY_NOT_CAPTURED_NOT_BAKED',
    sourceVersionsStable: true, roiVersionsStable: true, originalSceneUnchanged: true, originalAssetHashesStillMatch: true,
    pageErrors: [], consoleErrors: [], cleanupActions: closeActions, roiObservation: observation });
  const lock = versionLock(), before = { ...observed(document, 'before-actual-fixture', scenePath), versionLock: lock, driverReport: path.join(root, 'before-driver.json') };
  const observationFile = path.join(root, 'before-observation.json'); await writeJson(observationFile, before);
  await writeDriver(before);
  const bound = bindReceiverRoiDocument(document, bundle, before, prepared), boundPath = path.join(project, 'Scenes', 'bound.scene.json');
  const boundSha = await writeJson(boundPath, bound.document), bindingFile = path.join(root, 'roi-binding.json');
  const binding = { ...prepared, status: bound.binding.status, scenePath: boundPath, sceneSha256: boundSha,
    planFile: path.join(root, 'roi-plan-frozen.json'), preparationFile, preparationSha256, binding: bound.binding,
    policySha256: roiSha(encodeReceiverRoiJson(bound.document.scene.sceneSettings.lighting.policy)), versionLock: lock,
    observationFile, observationSha256: roiSha(encodeReceiverRoiJson(before)) };
  const bindingSha256 = await writeJson(bindingFile, binding);
  const fresh = { ...observed(bound.document, 'after-actual-fixture', boundPath), versionLock: lock, driverReport: path.join(root, 'after-driver.json') };
  const afterFile = path.join(root, 'after-observation.json'), afterSha = await writeJson(afterFile, fresh);
  await writeDriver(fresh);
  const runtime = verifyAppliedReceiverRoi(bundle, bound.document, fresh, binding, bound.binding);
  const validation = { ...binding, status: runtime.status, bindingFile, bindingSha256, observationFile: afterFile, observationSha256: afterSha,
    runtime, budgets: receiverRoiBudgetEvidence(bundle), bakeAllowed: false };
  const validationFile = path.join(root, 'roi-validation.json'); await writeJson(validationFile, validation);
  return { root, project, document, prepared, preparationFile, binding, bindingFile, bound, validation, validationFile, lock };
}

test('真实文件receipt链/SHA/精确policy/复开身份核验，checked run只复制原资产且disabled地址可逆', async t => {
  const f = await receiptFixture(t);
  assert.equal((await readReceiverRoiReceipt(f.preparationFile)).mode, 'observe-unbound');
  assert.equal((await readReceiverRoiReceipt(f.bindingFile, f.lock)).mode, 'observe-bound');
  const checked = await readReceiverRoiReceipt(f.validationFile, f.lock); assert.equal(checked.mode, 'checked-run');
  const run = path.join(f.root, 'run'); await fs.mkdir(run);
  const preparation = await copyReceiverRoiRun(checked, run), copied = JSON.parse(await fs.readFile(preparation.scenePath, 'utf8'));
  assert.equal(copied.scene.sceneSettings.lighting.bake.enabled, false); assert.equal(preparation.roiRelocation.reversible, true);
  assert.equal(roiSha(await fs.readFile(path.join(preparation.projectRoot, 'Assets', 'model.glb'))), bundle.approved.environmentSha256);
  assert.deepEqual(relocateReceiverRoiDocument(copied, preparation.projectRoot, f.project).document, f.bound.document);
  assert.equal(roiSha(await fs.readFile(f.binding.scenePath)), f.binding.sceneSha256);
  await assert.rejects(copyReceiverRoiRun(checked, run), /EEXIST/);
  await fs.writeFile(path.join(f.project, 'Assets', 'model.glb'), 'changed bytes');
  await assert.rejects(readReceiverRoiReceipt(f.validationFile, f.lock), /SHA改变/);
});

test('receipt parent/observation/policy/版本漂移与循环链接均fail closed，不借旧全receiver准入', async t => {
  const f = await receiptFixture(t);
  const badVersions = versionLock(); badVersions.builds['dist-electron/main.js'] = '3'.repeat(64);
  await assert.rejects(readReceiverRoiReceipt(f.validationFile, badVersions), /漂移/);
  for (const change of [value => { value.bindingSha256 = '0'.repeat(64); }, value => { value.policySha256 = '0'.repeat(64); },
    value => { value.observationSha256 = '0'.repeat(64); }, value => { value.bindingFile = f.validationFile; }]) {
    const bad = structuredClone(f.validation); change(bad); await writeJson(f.validationFile, bad);
    await assert.rejects(readReceiverRoiReceipt(f.validationFile, f.lock));
  }
  await writeJson(f.validationFile, f.validation);
  const observation = JSON.parse(await fs.readFile(f.validation.observationFile, 'utf8'));
  const finished = JSON.parse(await fs.readFile(observation.driverReport, 'utf8'));
  for (const change of [value => { value.status = 'FAIL'; }, value => { value.roiVersionsStable = false; },
    value => { value.cleanupActions = []; }, value => { value.consoleErrors = ['actual error']; }]) {
    const bad = structuredClone(finished); change(bad); await writeJson(observation.driverReport, bad);
    await assert.rejects(readReceiverRoiReceipt(f.validationFile, f.lock));
  }
  await writeJson(observation.driverReport, finished);
  await writeJson(f.validationFile, { status: 'PREFLIGHT_ONLY_NOT_BAKED' });
  await assert.rejects(readReceiverRoiReceipt(f.validationFile, f.lock), /未知ROI/);
});

test('真实薄CLI bind→validate生成可消费receipt链，保持disabled且不启动Editor/Blender', async t => {
  const f = await receiptFixture(t), bindOutput = path.join(f.root, 'cli-bind');
  const run = args => {
    const child = spawnSync(process.execPath, ['scripts/phase2-gi-receiver-roi.mjs', ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
  };
  const bound = run(['bind', '--preparation', f.preparationFile, '--observation', f.binding.observationFile, '--output', bindOutput]);
  assert.equal(bound.bakeAllowed, false);
  const binding = (await readReceiverRoiReceipt(bound.receipt, f.lock)).receipt;
  const document = JSON.parse(await fs.readFile(binding.scenePath, 'utf8'));
  const observation = { ...observed(document, 'cli-reopen-fixture', binding.scenePath), versionLock: f.lock, driverReport: path.join(f.root, 'cli-driver.json') };
  const observationFile = path.join(f.root, 'cli-observation.json'); await writeJson(observationFile, observation);
  await writeJson(observation.driverReport, { status: 'ROI_ACTUAL_CLASSIFICATION_ONLY_NOT_CAPTURED_NOT_BAKED',
    sourceVersionsStable: true, roiVersionsStable: true, originalSceneUnchanged: true, originalAssetHashesStillMatch: true,
    pageErrors: [], consoleErrors: [], cleanupActions: ['close-owned-editor', 'close-owned-vite', 'remove-owned-bootstrap'].map(name => ({ name, status: 'PASS' })), roiObservation: observation });
  const validation = run(['validate', '--binding', bound.receipt, '--observation', observationFile, '--output', path.join(f.root, 'cli-validate')]);
  assert.equal(validation.bakeAllowed, false); assert.equal(validation.budgets.status, 'UNKNOWN_NOT_ADMITTED');
  const chain = await readReceiverRoiReceipt(validation.receipt, f.lock); assert.equal(chain.mode, 'checked-run');
  assert.equal(chain.document.scene.sceneSettings.lighting.bake.enabled, false);
});

test('receipt资产中间目录即使指向相同合法字节的junction/链接也拒绝', async t => {
  const f = await receiptFixture(t), original = path.join(f.project, 'Assets'), moved = path.join(f.project, 'Assets-retained');
  await fs.rename(original, moved); await fs.symlink(moved, original, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readReceiverRoiReceipt(f.validationFile, f.lock), /中间链接/);
});

test('SOURCE/DIST均独立解码产物geometry交叉receiver；默认旧路径不把全输入统计当proxy量', async () => {
  // 直接运行当前helper，只把编译模块定位到同一份TS源；fresh clone无需预先生成dist。
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier.includes('dist-electron/shared/') && specifier.endsWith('.js')) {
      const name = specifier.split('/').at(-1).slice(0, -3) + '.ts'; return nextResolve(new URL('../../electron/shared/' + name, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  } });
  let artifacts, viewer;
  try { [artifacts, viewer] = await Promise.all([import('../helpers/phase2GiArtifacts.mjs'), import('../helpers/phase2GiViewer.mjs')]); }
  finally { hooks.deregister(); }
  const root = path.join(fixtureRoot, 'artifacts'), geometry = { version: 2, key: 'receiver', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 0, 1], bakeUvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };
  const scene = { id: 'portable-fixture', entityIds: [], entities: {}, sceneSettings: { lighting: normalizeSceneLightingConfig({ version: 2, bake: { enabled: true } }) } };
  const data = [['g', 'geometry', encodeReceiverRoiJson(geometry)], ['l', 'lightmap', Buffer.from('fixture png bytes')], ['p', 'probes', Buffer.from('fixture probes')]];
  const assets = data.map(([id, kind, bytes]) => ({ id, kind, url: 'payload/' + id + '.bin', byteLength: bytes.length, sha256: roiSha(bytes), ...(kind === 'lightmap' ? { rgbmRange: 1 } : {}) }));
  const snapshot = { version: 1, signature: getSceneLightingBakeSignature(scene), geometrySignature: 'same-original-geometry', createdAt: '2026-10-25T00:00:00Z', engineVersion: 'synthetic',
    assets, surfaces: [{ key: '$environment/receiver', entityId: '$environment', nodeKey: 'receiver', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
    statistics: { meshCount: 2, triangleCount: 999, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 1 } };
  scene.sceneSettings.lighting.result = snapshot;
  await writeJson(path.join(root, 'scene.json'), { scene });
  await writeJson(path.join(root, 'project', 'scene.json'), { scene });
  await writeJson(path.join(root, 'project', 'asset-manifest.json'), { assets: assets.map(asset => ({ logicalUrl: asset.url, path: asset.id + '.bin' })) });
  for (const [id, , bytes] of data) {
    for (const directory of ['payload', 'project/assets']) { await fs.mkdir(path.join(root, directory), { recursive: true }); await fs.writeFile(path.join(root, directory, id + '.bin'), bytes); }
  }
  const parameters = { root, entryScenePath: 'scene.json', expectedSnapshot: snapshot, expectedScene: scene };
  assert.equal((await artifacts.verifyGiSourceReadback(parameters)).receiverTriangles, undefined, '旧无ROI参数不增加新合同');
  assert.equal((await artifacts.verifyGiSourceReadback({ ...parameters, expectedReceiverTriangles: 1 })).receiverTriangles, 1);
  await assert.rejects(artifacts.verifyGiSourceReadback({ ...parameters, expectedReceiverTriangles: 999 }), /SOURCE独立解码/);
  assert.equal((await viewer.inspectBusinessGiDist(root, snapshot, scene)).expectedTriangles, 1);
  await assert.rejects(viewer.verifyBusinessGiViewer({ root, snapshot, expectedScene: scene, expectedReceiverTriangles: 999 }), /DIST独立解码/);
});
