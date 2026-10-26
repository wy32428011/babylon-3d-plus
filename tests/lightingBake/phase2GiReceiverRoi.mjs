import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareBusinessGiSubset } from './phase2GiBusinessSubset.mjs';

export const ROI_LIMITS = Object.freeze({ maxTriangles: 1000000, maxProbes: 1024, maxInputGeometryBytes: 512 * 1024 ** 2,
  maxDerivedNumericBytes: 1024 ** 3, maxTextureMiB: 256, maxCyclesPeakRssBytes: 4 * 1024 ** 3,
  maxObservedRendererHeapBytes: 2 * 1024 ** 3, maxWorkingDiskBytes: 2 * 1024 ** 3, bakeTimeoutMs: 600000,
  maxReceiverTriangles: 100000, minReceiverTriangles: 20000, minSourceReceiverNodes: 20 });
export const roiSha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const inside = (root, file) => { const relative = path.relative(path.resolve(root), path.resolve(file)); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };
async function json(file, expected) {
  const stat = await fs.lstat(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 ** 2, 'ROI只读JSON证据超过4MiB或不是普通文件');
  const bytes = await fs.readFile(file); assert.ok(bytes.length <= 4 * 1024 ** 2, 'ROI只读JSON证据超过4MiB');
  if (expected) assert.equal(roiSha(bytes), expected, '已冻结证据SHA变化：' + file);
  return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), bytes, sha256: roiSha(bytes) };
}

/** 只读旧任务metadata，绝不读取geometry BIN或把旧捕获当新捕获。 */
export async function readReceiverRoiPlan(planFile) {
  const frozen = await json(planFile), plan = frozen.value;
  assert.equal(plan.version, 1); assert.equal(plan.status, 'PROPOSED_NOT_RENDERED_NOT_BAKED_RESOURCE_IDENTITY_UNBOUND');
  assert.equal(plan.unchangedFullInputDeclaration.meshCount, 798); assert.equal(plan.unchangedFullInputDeclaration.triangleCount, 866611);
  assert.equal(plan.receiverCandidate.sourceNodeCount, 33); assert.equal(plan.receiverCandidate.triangleCount, 24498);
  assert.equal(plan.nonreceiverInputDeclaration.sourceNodeCount, 765); assert.equal(plan.nonreceiverInputDeclaration.triangleCount, 842113);
  for (const [key, value] of Object.entries(ROI_LIMITS)) assert.equal(plan.preregisteredBudget[key], value, '不能扩大/改写冻结budget：' + key);
  assert.deepEqual(plan.pilot, { device: 'cpu', quality: 'preview', atlasSize: 1024, texelsPerMeter: 4, probeSpacing: 16, maxTextureMiB: 256 }, '不自动降质或改probe范围');
  const input = await json(plan.sourceEvidence.inputMetadata, plan.sourceEvidence.inputMetadataSha256);
  const approved = await json(plan.sourceEvidence.originalApprovedPlan, plan.sourceEvidence.originalApprovedPlanSha256);
  const evidenceRoot = path.dirname(plan.sourceEvidence.originalApprovedPlan);
  const uv = await json(path.join(evidenceRoot, 'nonreceiver-uv-real-1', 'report.json'));
  const comparison = await json(path.join(evidenceRoot, 'nonreceiver-uv-real-1', 'comparison-details.json'));
  const admission = await json(path.join(evidenceRoot, 'nonreceiver-uv-real-1', 'environment-roi-static-admission.json'));
  assert.equal(uv.value.status, 'PASS'); assert.equal(uv.value.cases.length, 9); assert.equal(uv.value.frozenSourcesUnchanged, true);
  assert.equal(comparison.value.status, 'PASS_ALL_SAVED_COMPONENT_COMPARISONS');
  for (const phase of Object.values(comparison.value.sums)) for (const row of Object.values(phase)) assert.equal(row.different, 0);
  assert.equal(admission.value.inputMetadataSha256, input.sha256); assert.equal(admission.value.binaryGeometryRead, false);
  assert.equal(admission.value.selectedReceiverNodeCount, 33); assert.equal(admission.value.nonreceiverNodeCount, 765);
  assert.equal(input.value.meshes.length, 798);
  const inventory = input.value.meshes.map(mesh => {
    assert.equal(mesh.entityId, '$environment'); assert.ok(typeof mesh.nodeKey === 'string' && mesh.nodeKey);
    assert.ok(Array.isArray(mesh.worldMatrix) && mesh.worldMatrix.length === 16 && mesh.worldMatrix.every(Number.isFinite), '冻结metadata必须有真实worldMatrix');
    return { key: mesh.key, nodeKey: mesh.nodeKey, worldMatrix: mesh.worldMatrix };
  });
  assert.equal(new Set(inventory.map(row => row.nodeKey)).size, 798);
  const selected = plan.receiverCandidate.selectedNodes.map(node => node.nodeKey);
  assert.equal(new Set(selected).size, 33); assert.ok(selected.every(key => inventory.some(row => row.nodeKey === key)));
  assert.equal(plan.receiverCandidate.selectedNodes.reduce((sum, node) => sum + node.triangles, 0), 24498);
  return { plan, planFile: path.resolve(planFile), planSha256: frozen.sha256, planBytes: frozen.bytes,
    inventory, approved: approved.value, approvedSha256: approved.sha256,
    evidenceSha256: { input: input.sha256, approved: approved.sha256, uv: uv.sha256, comparison: comparison.sha256, admission: admission.sha256 },
    uvEvidence: { status: 'NINE_MICRO_CASES_PASS_NOT_ACTUAL_ROI_PREDICATE', cases: 9, productAdoption: 'NOT_ASSERTED',
      staticFieldCompatibleNonreceivers: admission.value.staticFieldCompatibleCount,
      finiteUvValuesUnverified: admission.value.withRequiredUvFiniteValuesUnverified, actualPredicateSkipCount: null },
    actual: { runtimeIdentity: null, predicateSkipCount: null, receiverTriangles: null, probeCount: null, uvArea: null, atlasPages: null } };
}

/** 仅新文档更改pilot与receiver规则；未绑定身份时不写任何虚构nodeRule，始终禁bake。 */
export function makeUnboundReceiverRoiDocument(document, bundle) {
  assert.equal(document.scene.sceneSettings.lighting.version, 2);
  assert.ok(Object.values(document.scene.entities).every(entity => !entity.components?.modelAsset && !entity.components?.modelGenerator && !entity.components?.deviceSpawner),
    '必须先走环境only准备，不能重新分类未知模型脚本/生成器');
  assert.ok(document.scene.sceneSettings.environment?.activeVariantUrl);
  assert.ok(!(document.scene.sceneSettings.lighting.bake.probeVolumes ?? []).some(volume => volume.enabled), '不通过新probe volume缩小原全环境探针域');
  const next = structuredClone(document), lighting = next.scene.sceneSettings.lighting;
  lighting.result = null;
  const { device: _device, ...pilot } = bundle.plan.pilot;
  lighting.bake = { ...lighting.bake, ...pilot, enabled: false };
  return next;
}

function rowFacts(row) {
  assert.equal(row.entityId, '$environment'); assert.ok(typeof row.nodeKey === 'string' && row.nodeKey);
  const context = row.policyContext;
  const resourceIdentity = context?.resourceIdentity ?? row.resourceIdentity;
  const nodeKey = context?.partKey ?? row.partKey ?? row.nodeKey;
  assert.ok(typeof resourceIdentity === 'string' && resourceIdentity.trim() === resourceIdentity && resourceIdentity.length > 0, '必须由实际runtime提供resourceIdentity');
  if (context?.resourceIdentity && row.resourceIdentity) assert.equal(context.resourceIdentity, row.resourceIdentity);
  assert.equal(row.mobility, 'static'); assert.equal(row.automaticMobility ?? context?.automatic?.mobility, 'static');
  assert.equal(row.motionRole ?? context?.motionRole, 'fixed'); assert.notEqual(row.parentDynamic, true);
  assert.equal(row.deviceType ?? context?.deviceType, 'environment');
  assert.equal(typeof row.castShadows, 'boolean'); assert.equal(typeof row.receiveShadows, 'boolean');
  assert.equal(typeof row.bakeIndirect, 'boolean');
  assert.ok(!row.unmatchedOverride && !(row.policyMismatches?.length) && !(row.policyConflicts?.length), '资源规则有失配/冲突，不自动抹除');
  return { key: row.key, nodeKey, runtimeNodeKey: row.nodeKey, resourceIdentity,
    mobility: row.mobility, castShadows: row.castShadows, receiveShadows: row.receiveShadows, bakeIndirect: row.bakeIndirect,
    sourceUrl: context?.modelAsset?.sourceUrl };
}

/** 证据对象必须来自已有Editor只读入口；文件声明本身不替代后续fresh Editor/Capture验证。 */
export function verifyReceiverRoiRuntime(bundle, document, observation, expected) {
  assert.equal(observation.kind, 'ACTUAL_EDITOR_RUNTIME_CLASSIFICATION');
  assert.ok(typeof observation.captureId === 'string' && observation.captureId && Number.isSafeInteger(observation.editorPid) && observation.editorPid > 0);
  assert.ok(Number.isFinite(Date.parse(observation.capturedAt)));
  assert.equal(path.resolve(observation.scenePath), path.resolve(expected.scenePath));
  assert.equal(observation.sceneSha256, expected.sceneSha256);
  assert.equal(observation.environmentSha256, bundle.approved.environmentSha256);
  assert.equal(observation.runtimeError, null);
  assert.equal(observation.statistics.sceneId, document.scene.id); assert.equal(observation.statistics.phase, 'ready');
  assert.equal(observation.statistics.modelTriangleCount, 0);
  assert.equal(observation.statistics.environmentTriangleCount, 866611);
  assert.ok(Array.isArray(observation.classification));
  const rows = observation.classification.map(rowFacts);
  assert.equal(rows.length, 798); assert.equal(new Set(rows.map(row => row.key)).size, 798);
  assert.equal(new Set(rows.map(row => row.nodeKey)).size, 798);
  assert.deepEqual(rows.map(row => row.nodeKey).sort(), bundle.inventory.map(row => row.nodeKey).sort(), '实际完整节点目录不能减小/按name近似');
  assert.equal(new Set(rows.map(row => row.resourceIdentity)).size, 1);
  const sourceUrl = document.scene.sceneSettings.environment.activeVariantUrl;
  assert.ok(rows.every(row => row.sourceUrl === sourceUrl), 'runtime必须实际加载此owned环境URL');
  const selected = new Set(bundle.plan.receiverCandidate.selectedNodes.map(node => node.nodeKey));
  return { resourceIdentity: rows[0].resourceIdentity, rows, selected: rows.filter(row => selected.has(row.nodeKey)),
    captureId: observation.captureId, editorPid: observation.editorPid, capturedAt: observation.capturedAt };
}

/** 绑定后的副本仍禁bake；先重开并验证真实分类，再由既有受预算流程显式启用。 */
export function bindReceiverRoiDocument(document, bundle, observation, expected) {
  assert.equal(document.scene.sceneSettings.lighting.bake.enabled, false, 'unbound文档必须禁bake');
  const binding = verifyReceiverRoiRuntime(bundle, document, observation, expected);
  assert.equal(binding.selected.length, 33);
  const next = structuredClone(document), lighting = next.scene.sceneSettings.lighting;
  const policy = lighting.policy ?? { version: 1, defaults: {}, rules: [] };
  const id = 'phase2-environment-roi-' + bundle.planSha256.slice(0, 12);
  assert.ok(!policy.rules.some(rule => rule.id === id), '拒绝覆盖/重复应用已冻结ROI规则');
  const rule = { id, name: '仓储台架ROI · 保留完整环境遮挡反弹', enabled: true,
    target: { kind: 'type', deviceType: 'environment' }, values: { bakeIndirect: false },
    nodeRules: binding.selected.map((row, index) => ({ id: id + '-node-' + index, enabled: true,
      target: { kind: 'node', nodeKey: row.nodeKey, resourceIdentity: row.resourceIdentity }, values: { bakeIndirect: true } })) };
  lighting.policy = { ...policy, rules: [...policy.rules, rule] }; lighting.result = null; lighting.bake.enabled = false;
  return { document: next, binding: { ...binding, ruleId: id, observationSha256: roiSha(encode(observation)),
    planSha256: bundle.planSha256, status: 'BOUND_POLICY_NOT_CAPTURED_NOT_BAKED', bakeAllowed: false,
    actualPredicateSkipCount: null, actualReceiverTriangles: null, actualProbeCount: null } };
}

export function verifyAppliedReceiverRoi(bundle, document, observation, expected, binding) {
  assert.equal(binding.planSha256, bundle.planSha256);
  const fresh = verifyReceiverRoiRuntime(bundle, document, observation, expected);
  assert.equal(fresh.resourceIdentity, binding.resourceIdentity); assert.notEqual(fresh.captureId, binding.captureId, '应用后必须重新读取实际runtime，不复用旧观察');
  const selected = new Set(binding.selected.map(row => row.nodeKey)), before = new Map(binding.rows.map(row => [row.nodeKey, row]));
  for (const row of fresh.rows) {
    const previous = before.get(row.nodeKey); assert.ok(previous);
    assert.equal(row.castShadows, previous.castShadows); assert.equal(row.receiveShadows, previous.receiveShadows);
    assert.equal(row.mobility, previous.mobility); assert.equal(row.bakeIndirect, selected.has(row.nodeKey));
  }
  assert.equal(fresh.rows.filter(row => row.bakeIndirect).length, 33);
  return { status: 'ACTUAL_POLICY_BOUND_REQUIRES_FRESH_CAPTURE_AND_BUDGETS', bakeAllowed: false,
    classificationNodes: 798, environmentStatisticsTriangles: 866611, policyReceiverNodes: 33,
    actualInputMeshes: null, actualInputTriangles: null, actualReceiverNodes: null,
    actualReceiverTriangles: null, projectedReceiverTriangles: 24498, actualProbeCount: null, actualPredicateSkipCount: null };
}

/** 缺测保持unknown；此报告不是发起bake或正式验收授权。 */
export function receiverRoiBudgetEvidence(bundle, observed = {}) {
  const errors = [], unknown = [];
  for (const [field, limit] of [['rendererHeapMaxObservedBytes', ROI_LIMITS.maxObservedRendererHeapBytes], ['cyclesPeakRssBytes', ROI_LIMITS.maxCyclesPeakRssBytes],
    ['workingDiskMaxObservedBytes', ROI_LIMITS.maxWorkingDiskBytes], ['inputGeometryBytes', ROI_LIMITS.maxInputGeometryBytes],
    ['derivedNumericBytes', ROI_LIMITS.maxDerivedNumericBytes], ['atlasBytes', ROI_LIMITS.maxTextureMiB * 1024 ** 2], ['durationMs', ROI_LIMITS.bakeTimeoutMs], ['actualProbeCount', ROI_LIMITS.maxProbes]]) {
    const value = observed[field];
    if (!Number.isFinite(value) || value <= 0) unknown.push(field);
    else if (value > limit) errors.push(field + ' exceeds frozen limit');
  }
  for (const [field, expected] of [['inputMeshCount', 798], ['inputTriangleCount', 866611], ['receiverNodeCount', 33], ['receiverTriangleCount', 24498]]) {
    if (!Number.isSafeInteger(observed[field]) || observed[field] <= 0) unknown.push(field);
    else if (observed[field] !== expected) errors.push(field + ' differs from frozen ROI/full input');
  }
  if (Number.isFinite(observed.actualProbeCount) && observed.actualProbeCount !== bundle.plan.unchangedFullInputDeclaration.projectedProbeCountAtUnchangedSpacing16) errors.push('actualProbeCount differs from unchanged full-bounds spacing16 declaration');
  assert.equal(bundle.plan.preregisteredBudget.maxInputGeometryBytes, ROI_LIMITS.maxInputGeometryBytes);
  return { status: errors.length ? 'BUDGET_VIOLATION' : unknown.length ? 'UNKNOWN_NOT_ADMITTED' : 'MEASURED_BUDGETS_WITHIN_LIMITS_NOT_VIEWER_ACCEPTANCE',
    bakeAllowed: false, errors, unknown, actualPredicateSkipCount: observed.actualPredicateSkipCount ?? null,
    actualPredicateFallbackCount: observed.actualPredicateFallbackCount ?? null };
}

export async function prepareReceiverRoiProject({ sourceScene, planFile, output }) {
  const bundle = await readReceiverRoiPlan(planFile);
  assert.equal(path.resolve(sourceScene), path.resolve(bundle.approved.sourceScene));
  const original = await fs.readFile(sourceScene); assert.equal(roiSha(original), bundle.approved.sourceSceneSha256);
  output = path.resolve(output); assert.ok(inside(path.resolve('output'), output));
  await fs.mkdir(output, { recursive: false });
  const project = path.join(output, 'project'), intermediate = path.join(project, 'Scenes', 'phase2-business-gi.scene.json');
  try {
    const base = await prepareBusinessGiSubset({ sourceScene, output: project, entityIds: [], environment: 'keep', environmentOnly: true, previewBudget: false });
    assert.equal(base.sourceSceneSha256, bundle.approved.sourceSceneSha256);
    const relativeEnvironment = path.relative(path.dirname(path.dirname(sourceScene)), bundle.approved.environmentFile).replaceAll('\\', '/');
    assert.equal(base.copiedAssets.find(file => file.path === relativeEnvironment)?.sha256, bundle.approved.environmentSha256, '只能复制原始GLB，不能换E4候选或改材质');
    const baseDocument = (await json(base.scenePath)).value;
    const document = makeUnboundReceiverRoiDocument(baseDocument, bundle), scenePath = path.join(project, 'Scenes', 'receiver-roi-unbound.scene.json');
    const bytes = encode(document); await fs.writeFile(scenePath, bytes, { flag: 'wx' });
    // 中间环境only文档默认启用bake；删除本调用刚创建的中间项，最终只保留禁bake的ROI文档。
    assert.ok(inside(project, intermediate)); await fs.rm(intermediate);
    await fs.writeFile(path.join(output, 'roi-plan-frozen.json'), bundle.planBytes, { flag: 'wx' });
    const receipt = { status: 'PREPARED_RESOURCE_IDENTITY_UNBOUND_BAKE_DISABLED', project, scenePath, sceneSha256: roiSha(bytes),
      sourceSceneSha256: bundle.approved.sourceSceneSha256, environmentSha256: bundle.approved.environmentSha256,
      planSha256: bundle.planSha256, evidenceSha256: bundle.evidenceSha256, uvEvidence: bundle.uvEvidence,
      basePreparation: base, intermediateSceneRemoved: true, bakeAllowed: false, actual: bundle.actual };
    await fs.writeFile(path.join(output, 'roi-preparation.json'), encode(receipt), { flag: 'wx' });
    assert.equal(roiSha(await fs.readFile(sourceScene)), bundle.approved.sourceSceneSha256);
    assert.equal(roiSha(await fs.readFile(planFile)), bundle.planSha256, '原ROI计划不得被覆盖'); return receipt;
  } catch (error) {
    assert.ok(inside(project, intermediate)); await fs.rm(intermediate, { force: true });
    await fs.writeFile(path.join(output, 'roi-preparation-failure.json'), encode({ status: 'FAILED_NOT_ADMITTED', error: String(error), bakeAllowed: false }), { flag: 'wx' });
    throw error;
  }
}

export const encodeReceiverRoiJson = encode;

const ROI_PREPARED = 'PREPARED_RESOURCE_IDENTITY_UNBOUND_BAKE_DISABLED';
const ROI_BOUND = 'BOUND_POLICY_NOT_CAPTURED_NOT_BAKED';
const ROI_CHECKED = 'ACTUAL_POLICY_BOUND_REQUIRES_FRESH_CAPTURE_AND_BUDGETS';
const SOURCE_FILES = ['package.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts',
  'scripts/phase2-gi-business.mjs', 'scripts/phase2-gi-receiver-roi.mjs',
  'tests/lightingBake/phase2GiReceiverRoi.mjs', 'tests/lightingBake/phase2GiReceiverRoi.test.mjs',
  'tests/lightingBake/phase2GiBusinessSubset.mjs', 'tests/helpers/phase2GiArtifacts.mjs',
  'tests/helpers/phase2GiViewer.mjs', 'tests/helpers/phase2GiBudget.mjs', 'tests/helpers/phase2GiArchiveReader.mjs'];

async function fileSha(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** 检查整条owned路径；realpath本身不能证明中间目录没有链接。 */
async function ownedFile(root, file) {
  root = path.resolve(root); file = path.resolve(file); assert.ok(inside(root, file), '文件必须位于专属根内');
  const rootStat = await fs.lstat(root); assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part); const stat = await fs.lstat(current);
    assert.equal(stat.isSymbolicLink(), false, 'ROI路径不接受中间链接');
    assert.ok(current === file ? stat.isFile() : stat.isDirectory());
  }
  assert.ok(inside(await fs.realpath(root), await fs.realpath(file))); return file;
}

function assertVersionLock(lock) {
  assert.equal(lock?.kind, 'ROI_SOURCE_AND_BUILD_TREE_SHA256_V1');
  for (const section of ['sources', 'builds']) {
    assert.ok(lock[section] && Object.keys(lock[section]).length > 0, '源码/build锁不得为空');
    for (const [name, value] of Object.entries(lock[section])) assert.ok(name && /^[a-f0-9]{64}$/.test(value));
  }
}

/** 按树冻结真实使用的源与构建；流式读文件，不加载GLB/几何数组。 */
export async function readReceiverRoiVersionLock(repository = process.cwd()) {
  const sources = {}, builds = {};
  const walk = async (relative, target) => {
    const directory = path.join(repository, relative), stat = await fs.lstat(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
      assert.equal(entry.isSymbolicLink(), false, '版本树不接受链接');
      if (entry.isDirectory()) await walk(child, target);
      else { assert.ok(entry.isFile()); target[child] = await fileSha(path.join(repository, child)); }
      assert.ok(Object.keys(target).length <= 20000, '版本树异常膨胀');
    }
  };
  await walk('src', sources); await walk('electron', sources);
  for (const name of SOURCE_FILES) { await ownedFile(repository, path.join(repository, name)); sources[name] = await fileSha(path.join(repository, name)); }
  for (const entry of await fs.readdir(repository, { withFileTypes: true })) if (entry.isFile()
    && /^(?:vite.*\.config\.[cm]?[jt]s|tsconfig.*\.json|package(?:-lock)?\.json|electron-builder.*\.(?:ya?ml|json))$/.test(entry.name)) {
    sources[entry.name] = await fileSha(path.join(repository, entry.name));
  }
  await walk('dist-electron', builds); await walk('dist-viewer-template', builds);
  assert.ok(builds['dist-electron/main.js'] && builds['dist-electron/lighting-bake/cycles_bake.py'] && builds['dist-viewer-template/index.html']);
  const lock = { kind: 'ROI_SOURCE_AND_BUILD_TREE_SHA256_V1', sources, builds }; assertVersionLock(lock); return lock;
}

export function assertReceiverRoiVersionLock(expected, actual) {
  assertVersionLock(expected); assertVersionLock(actual);
  assert.deepEqual(actual, expected, 'ROI observation之后的源码/build漂移，必须重新观察绑定');
}

/** 单独的classification文件不能绕过失败/未清理的driver；必须读回最终只读运行收据。 */
export async function readReceiverRoiObservation(file, expectedSha) {
  await ownedFile(path.resolve('output'), file); const observation = await json(file, expectedSha);
  await ownedFile(path.resolve('output'), observation.value.driverReport); const driver = (await json(observation.value.driverReport)).value;
  assert.equal(driver.status, 'ROI_ACTUAL_CLASSIFICATION_ONLY_NOT_CAPTURED_NOT_BAKED');
  assert.equal(driver.sourceVersionsStable, true); assert.equal(driver.roiVersionsStable, true);
  assert.equal(driver.originalSceneUnchanged, true); assert.equal(driver.originalAssetHashesStillMatch, true);
  assert.deepEqual(driver.pageErrors, []); assert.deepEqual(driver.consoleErrors, []); assert.deepEqual(driver.cleanupErrors ?? [], []);
  assert.deepEqual(driver.roiObservation, observation.value);
  for (const name of ['close-owned-editor', 'close-owned-vite', 'remove-owned-bootstrap']) {
    assert.ok(driver.cleanupActions?.some(action => action.name === name && action.status === 'PASS'), '真实观察owned资源尚未确认关闭：' + name);
  }
  return observation;
}

/** 只重写同一owned工程根的地址；正反转换逐值相等才允许运行副本。 */
export function relocateReceiverRoiDocument(document, from, to) {
  from = path.resolve(from); to = path.resolve(to); assert.notEqual(from, to);
  const references = [];
  const rewrite = value => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    if (typeof value !== 'string') return value;
    let file = value, kind = 'path';
    if (value.startsWith('editor-asset://local/')) { file = decodeURIComponent(new URL(value).pathname.slice(1)); kind = 'editor'; }
    else if (value.startsWith('file:')) { file = fileURLToPath(value); kind = 'file'; }
    if (!path.isAbsolute(file)) { assert.equal(kind, 'path', 'asset URL必须是本机绝对路径'); return value; }
    if (!inside(from, file)) { assert.equal(kind, 'path', '外部asset URL不在冻结工程内'); return value; }
    const mapped = path.join(to, path.relative(from, file)); references.push({ original: file, mapped });
    return kind === 'editor' ? 'editor-asset://local/' + encodeURIComponent(mapped) : kind === 'file' ? pathToFileURL(mapped).href : mapped;
  };
  return { document: rewrite(document), references };
}

/** 核验准备/绑定/复开证据链；未校验身份的receipt只能观察，不能烘焙。 */
export async function readReceiverRoiReceipt(receiptFile, currentVersions, trail = new Set()) {
  receiptFile = path.resolve(receiptFile); assert.ok(inside(path.resolve('output'), receiptFile));
  assert.ok(!trail.has(receiptFile) && trail.size < 3, 'ROI receipt链循环/层级不合法'); trail.add(receiptFile);
  await ownedFile(path.resolve('output'), receiptFile);
  const current = await json(receiptFile), receipt = current.value;
  assert.ok([ROI_PREPARED, ROI_BOUND, ROI_CHECKED].includes(receipt.status), '未知ROI receipt状态');
  const parentFile = receipt.status === ROI_BOUND ? receipt.preparationFile : receipt.status === ROI_CHECKED ? receipt.bindingFile : null;
  let parent;
  if (parentFile) {
    parent = await readReceiverRoiReceipt(parentFile, currentVersions, trail);
    assert.equal(parent.receiptSha256, receipt.status === ROI_BOUND ? receipt.preparationSha256 : receipt.bindingSha256, '父receipt SHA变化');
    assert.equal(parent.receipt.status, receipt.status === ROI_BOUND ? ROI_PREPARED : ROI_BOUND);
  }
  const planFile = receipt.planFile ?? path.join(path.dirname(receiptFile), 'roi-plan-frozen.json');
  const bundle = parent?.bundle ?? await readReceiverRoiPlan(planFile);
  assert.equal(receipt.planSha256, bundle.planSha256); assert.deepEqual(receipt.evidenceSha256, bundle.evidenceSha256);
  assert.equal(roiSha(await fs.readFile(planFile)), bundle.planSha256);
  assert.equal(await fileSha(bundle.approved.sourceScene), bundle.approved.sourceSceneSha256, '原场景SHA改变');
  assert.equal(await fileSha(bundle.approved.environmentFile), bundle.approved.environmentSha256, '原GLB SHA改变');
  assert.equal(receipt.sourceSceneSha256, bundle.approved.sourceSceneSha256); assert.equal(receipt.environmentSha256, bundle.approved.environmentSha256);
  assert.equal(receipt.bakeAllowed, false);
  assert.equal(path.resolve(receipt.basePreparation.sourceScene), path.resolve(bundle.approved.sourceScene));
  assert.equal(receipt.basePreparation.sourceSceneSha256, bundle.approved.sourceSceneSha256);
  assert.equal(path.resolve(receipt.basePreparation.sourceProject), path.dirname(path.dirname(path.resolve(bundle.approved.sourceScene))));
  assert.ok(inside(path.resolve('output'), receipt.project)); await ownedFile(receipt.project, receipt.scenePath);
  const saved = await json(receipt.scenePath, receipt.sceneSha256), document = saved.value;
  assert.equal(document.scene.sceneSettings.lighting.bake.enabled, false); assert.equal(document.scene.sceneSettings.lighting.result, null);
  const environment = new URL(document.scene.sceneSettings.environment.activeVariantUrl);
  assert.equal(environment.protocol, 'editor-asset:'); assert.equal(environment.hostname, 'local'); assert.equal(environment.search + environment.hash, '');
  const environmentFile = path.join(receipt.project, path.relative(receipt.basePreparation.sourceProject, bundle.approved.environmentFile));
  assert.equal(path.resolve(decodeURIComponent(environment.pathname.slice(1))), path.resolve(environmentFile));
  await ownedFile(receipt.project, environmentFile); assert.equal(await fileSha(environmentFile), bundle.approved.environmentSha256, '准备环境GLB SHA改变');
  if (parent) {
    assert.equal(path.resolve(receipt.project), path.resolve(parent.receipt.project));
    assert.deepEqual(receipt.basePreparation, parent.receipt.basePreparation);
  }
  const copied = receipt.basePreparation?.copiedAssets;
  assert.ok(Array.isArray(copied) && copied.length > 0);
  assert.equal(new Set(copied.map(asset => asset.path.toLowerCase())).size, copied.length, '资产目录重复/大小写歧义');
  for (const asset of copied) {
    assert.ok(asset.path.startsWith('Assets/') && !asset.path.split(/[\\/]/).includes('..'));
    const file = path.join(receipt.project, asset.path); await ownedFile(receipt.project, file);
    assert.equal(await fileSha(file), asset.sha256, '准备副本资产SHA改变');
    const original = path.join(receipt.basePreparation.sourceProject, asset.path); await ownedFile(receipt.basePreparation.sourceProject, original);
    assert.equal(await fileSha(original), asset.sha256, '原资产SHA改变');
  }
  if (parent) {
    await ownedFile(path.resolve('output'), receipt.observationFile);
    const observation = await readReceiverRoiObservation(receipt.observationFile, receipt.observationSha256);
    assertVersionLock(observation.value.versionLock); assertReceiverRoiVersionLock(receipt.versionLock, observation.value.versionLock);
    if (currentVersions) assertReceiverRoiVersionLock(receipt.versionLock, currentVersions);
    assert.equal(receipt.policySha256, roiSha(encode(document.scene.sceneSettings.lighting.policy)));
    if (receipt.status === ROI_BOUND) {
      const bound = bindReceiverRoiDocument(parent.document, bundle, observation.value, parent.receipt);
      assert.deepEqual(document, bound.document); assert.deepEqual(receipt.binding, bound.binding);
    } else {
      assert.deepEqual(document, parent.document); assert.deepEqual(receipt.binding, parent.receipt.binding);
      assert.deepEqual(receipt.runtime, verifyAppliedReceiverRoi(bundle, document, observation.value, receipt, receipt.binding));
      assert.equal(receipt.runtime.policyReceiverNodes, 33);
    }
  }
  return { receipt, receiptFile, receiptSha256: current.sha256, bundle, document,
    mode: receipt.status === ROI_PREPARED ? 'observe-unbound' : receipt.status === ROI_BOUND ? 'observe-bound' : 'checked-run' };
}

/** 最终运行用新副本；不重跑subset准备器、不复制旧job、不覆盖pilot或绑定文档。 */
export async function copyReceiverRoiRun(checked, output) {
  assert.equal(checked.mode, 'checked-run'); output = path.resolve(output);
  assert.ok(inside(path.resolve('output'), output)); const project = path.join(output, 'project');
  await fs.mkdir(project, { recursive: false });
  const source = checked.receipt, copiedAssets = [];
  for (const asset of source.basePreparation.copiedAssets) {
    const original = await ownedFile(source.project, path.join(source.project, asset.path)), destination = path.join(project, asset.path);
    assert.ok(inside(project, destination)); await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(original, destination, constants.COPYFILE_EXCL); assert.equal(await fileSha(destination), asset.sha256);
    copiedAssets.push(asset);
  }
  const relocated = relocateReceiverRoiDocument(checked.document, source.project, project);
  assert.deepEqual(relocateReceiverRoiDocument(relocated.document, project, source.project).document, checked.document, '地址搬迁必须完全可逆');
  const scenePath = path.join(project, 'Scenes', 'receiver-roi-checked-run.scene.json'); await fs.mkdir(path.dirname(scenePath), { recursive: true });
  const bytes = encode(relocated.document); await fs.writeFile(scenePath, bytes, { flag: 'wx' });
  return { ...source.basePreparation, projectRoot: project, scenePath, subsetSceneSha256: roiSha(bytes), copiedAssets,
    roiRelocation: { from: source.project, to: project, references: relocated.references, sourceSceneSha256: source.sceneSha256,
      runSceneSha256: roiSha(bytes), reversible: true } };
}

/** 同一个fresh capture的小元数据；未知不填0，完整遮挡输入与接收面分别核验。 */
export function assertReceiverRoiCapture(bundle, proof, settings) {
  assert.equal(proof.proofKind, 'metadata-of-actual-capture-not-full-numeric-copy');
  assert.equal(proof.meshCount, 798); assert.equal(proof.triangleCount, 866611);
  assert.equal(proof.receiverCount, 33); assert.equal(proof.receiverTriangleCount, 24498);
  assert.deepEqual(proof.settings, settings); assert.equal(settings.enabled, true);
  const rows = proof.keys; assert.equal(rows.length, 798); assert.equal(new Set(rows.map(row => row.nodeKey)).size, 798);
  assert.deepEqual(rows.map(row => row.nodeKey).sort(), bundle.inventory.map(row => row.nodeKey).sort());
  assert.deepEqual(rows.map(row => row.key).sort(), bundle.inventory.map(row => row.key).sort());
  const selected = bundle.plan.receiverCandidate.selectedNodes, wanted = new Map(selected.map(row => [row.nodeKey, row.triangles]));
  const original = new Map(bundle.inventory.map(row => [row.nodeKey, row]));
  for (const row of rows) {
    assert.equal(row.entityId, '$environment'); assert.equal(row.receiver, wanted.has(row.nodeKey));
    assert.ok(Number.isSafeInteger(row.indices) && row.indices > 0 && row.indices % 3 === 0);
    assert.deepEqual(row.worldMatrix, original.get(row.nodeKey).worldMatrix, '原环境每node实际worldMatrix不能改变');
    if (row.receiver) assert.equal(row.indices / 3, wanted.get(row.nodeKey));
  }
  assert.equal(rows.reduce((sum, row) => sum + row.indices / 3, 0), proof.triangleCount);
  assert.equal(rows.filter(row => row.receiver).reduce((sum, row) => sum + row.indices / 3, 0), proof.receiverTriangleCount);
  const budget = proof.preflight; assert.ok(budget); assert.equal(budget.signature, proof.signature);
  assert.equal(budget.geometryBytes, proof.geometryBytes);
  for (const field of ['meshCount', 'receiverCount', 'triangleCount']) assert.equal(budget[field], proof[field]);
  assert.equal(budget.probeCountExact, true); assert.equal(budget.probeCount, bundle.plan.unchangedFullInputDeclaration.projectedProbeCountAtUnchangedSpacing16);
  for (const [field, limit] of [['geometryBytes', ROI_LIMITS.maxInputGeometryBytes], ['estimatedDerivedNumericBytes', ROI_LIMITS.maxDerivedNumericBytes],
    ['minTextureBytes', ROI_LIMITS.maxTextureMiB * 1024 ** 2], ['probeCount', ROI_LIMITS.maxProbes]]) {
    assert.ok(Number.isFinite(budget[field]) && budget[field] > 0 && budget[field] <= limit, 'fresh实际预算未知/超限：' + field);
  }
  assert.deepEqual(budget.issues.filter(issue => issue.severity === 'error'), []);
  assert.ok(Number.isFinite(proof.rendererHeapMaxObservedBytes) && proof.rendererHeapMaxObservedBytes > 0
    && proof.rendererHeapMaxObservedBytes <= ROI_LIMITS.maxObservedRendererHeapBytes, 'fresh renderer heap未知或超过2GiB');
  return { inputMeshCount: 798, inputTriangleCount: 866611, receiverNodeCount: 33, receiverTriangleCount: 24498,
    actualProbeCount: budget.probeCount, actualPredicateSkipCount: null, actualPredicateFallbackCount: null };
}
