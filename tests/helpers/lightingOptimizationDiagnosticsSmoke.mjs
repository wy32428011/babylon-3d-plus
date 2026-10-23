/* global window, requestAnimationFrame */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(value).digest('hex');
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function snapshot(page, moving) {
  return page.evaluate(async selection => {
    const smoke = window.lightingSmoke, state = smoke.store.getState(), scene = smoke.runtime.scene;
    const { getSceneLightingBakeSignature } = await import('/electron/shared/sceneLightingBakeContract.ts');
    const activeMeshes = new Set(scene.getActiveMeshes().data.slice(0, scene.getActiveMeshes().length)), gl = scene.getEngine()._gl;
    const active = scene.meshes.filter(mesh => activeMeshes.has(mesh) && mesh.isEnabled() && mesh.isVisible && mesh.metadata?.lightingDerived)
      .filter(mesh => mesh.subMeshes?.some(sub => {
        const effect = sub.effect, location = effect?.getUniform('lightingBakeActive'), program = effect?.getPipelineContext()?.program;
        return effect?.defines.includes('#define BAKED_INDIRECT_MAP') && location && program && gl.getUniform(program, location) === 1;
      })).length;
    smoke.runtime.getLightingClassification();
    const source = selection ? smoke.runtime.environment.lightingRuntime.sources.find(item => item.entry.entityId === selection.entityId && item.entry.nodeKey === selection.nodeKey) : null;
    const sourceMatrix = source?.getWorldMatrix();
    const camera = scene.activeCamera;
    return { document: JSON.stringify(state.scene), result: JSON.stringify(state.scene.sceneSettings.lighting.result),
      signature: getSceneLightingBakeSignature(state.scene), undoCount: state.history.undoStack.length, active,
      error: smoke.runtime.getLightingBakeRuntimeError(), progressCount: smoke.progress.length,
      movingWorldMatrix: sourceMatrix ? Array.from(sourceMatrix.asArray()) : null,
      camera: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.asArray() } };
  }, moving ?? null);
}
async function issueFor(manager, text, entityName, nodeKey) {
  const candidates = manager.locator('.lighting-manager-diagnostics > li').filter({ hasText: text });
  await candidates.first().waitFor({ state: 'visible' });
  const index = await candidates.evaluateAll((nodes, criteria) => nodes.findIndex(node => {
    const identity = node.querySelector('.lighting-manager-diagnostic-identity')?.textContent ?? '';
    return identity.split(' · ')[0].trim() === criteria.entityName && (!criteria.nodeKey || identity.includes(criteria.nodeKey));
  }), { entityName, nodeKey });
  assert.ok(index >= 0, '应出现真实对象诊断：' + JSON.stringify({ text, entityName, nodeKey }));
  return candidates.nth(index);
}
async function selectedRule(page, manager, name) {
  const input = manager.getByRole('textbox', { name: '规则名称', exact: true });
  await input.waitFor({ state: 'visible' });
  await page.waitForFunction(expected => window.document.querySelector('#lighting-page-rules input[aria-label="规则名称"]')?.value === expected, name);
  assert.equal(await input.inputValue(), name, '诊断应打开产生问题的真实规则');
  return await input.inputValue();
}
async function focusExpectation(page, selection) {
  return page.evaluate(async target => {
    const { sourceGeometryMesh } = await import('/src/runtime/babylon/lightingRuntimeCapture.ts');
    const smoke = window.lightingSmoke; smoke.runtime.getLightingClassification();
    const sources = smoke.runtime.environment.lightingRuntime.sources.filter(source => source.entry.entityId === target.entityId && source.entry.nodeKey === target.nodeKey);
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (const source of sources) {
      const matrix = source.getWorldMatrix(); if (!matrix) continue;
      const bounds = sourceGeometryMesh(source.mesh).rawBoundingInfo?.boundingBox ?? source.mesh.getBoundingInfo().boundingBox;
      for (const point of bounds.vectors) for (let axis = 0; axis < 3; axis++) {
        const value = matrix.m[axis] * point.x + matrix.m[axis + 4] * point.y + matrix.m[axis + 8] * point.z + matrix.m[axis + 12];
        low[axis] = Math.min(low[axis], value); high[axis] = Math.max(high[axis], value);
      }
    }
    if (![...low, ...high].every(Number.isFinite)) throw new Error('目标节点缺少实际可定位的世界几何');
    return { sourceCount: sources.length, target: low.map((value, axis) => (value + high[axis]) / 2) };
  }, selection);
}

/** 使用真实分类事实和正式草稿事务制造诊断；不写入issue数组，不启动烘焙；一次撤销恢复全部配置。 */
export async function runLightingOptimizationDiagnosticsSmoke({ page, ui, capture, check }) {
  await ui.open('总览与烘焙'); await page.evaluate(() => window.lightingSmoke.runtime.waitForLightingReady()); await settle(page);
  const manager = ui.manager;
  // 先对真实上下文做只读推演，找不到能产生实际冲突的节点时明确失败，不能造假诊断。
  const planned = await page.evaluate(async () => {
    const { createLightingManagerDraft, buildLightingManagerRows } = await import('/src/editor/panels/lightingBakeManagerModel.ts');
    const { createLightingModelReference, matchesLightingPolicyTarget, normalizeLightingPolicyNodeKey } = await import('/electron/shared/sceneLightingPolicy.ts');
    const smoke = window.lightingSmoke, state = smoke.store.getState();
    if (state.lightingBakeRequest || state.runtimeMode !== 'edit' || state.lightingDraftPreview) throw new Error('诊断验收需要无任务且没有临时预览的编辑状态。');
    const draft = createLightingManagerDraft(state.scene, state.sceneSessionId), entries = smoke.runtime.getLightingClassification();
    const rows = buildLightingManagerRows(state.scene, entries, draft);
    for (const moving of rows.filter(row => row.entry.parentDynamic && row.context?.modelAsset && state.scene.entities[row.entityId] && !row.entry.unmatchedOverride)) {
      const model = createLightingModelReference(moving.context.modelAsset);
      if (!model || !moving.context.resourceIdentity) continue;
      const fixed = rows.find(row => row.entityId === moving.entityId && !row.entry.parentDynamic && row.effective?.settings.mobility === 'static'
        && row.context?.resourceIdentity && matchesLightingPolicyTarget({ kind: 'resource', model }, row.context));
      if (!fixed) continue;
      const id = 'diagnostic-' + crypto.randomUUID(), tag = 'optimization-obsolete-' + id;
      const rule = { id, name: '真实诊断点击验收 ' + id, enabled: true, target: { kind: 'resource', model }, values: {}, nodeRules: [
        { id: id + '-identity', name: '旧资源身份诊断', enabled: true, target: { kind: 'node', nodeKey: normalizeLightingPolicyNodeKey(fixed.partKey), resourceIdentity: tag }, values: { receiveShadows: false } },
        { id: id + '-ancestor', name: '动态祖先约束诊断', enabled: true, target: { kind: 'node', nodeKey: normalizeLightingPolicyNodeKey(moving.partKey), resourceIdentity: moving.context.resourceIdentity }, values: { mobility: 'static' } },
      ] };
      const currentPolicy = draft.lighting.policy ?? { version: 1, defaults: {}, rules: [] };
      const next = { ...draft, lighting: { ...draft.lighting, policy: { ...currentPolicy, rules: [rule, ...currentPolicy.rules] } } };
      const preview = buildLightingManagerRows(state.scene, entries, next);
      if (!preview.some(row => row.entityId === fixed.entityId && row.effective?.mismatches.some(issue => issue.ruleId === id && issue.expectedResourceIdentity === tag))
        || !preview.some(row => row.entityId === moving.entityId && row.nodeKey === moving.nodeKey && row.effective?.conflicts.some(issue => issue.ruleId === id && issue.nodeRuleId === id + '-ancestor'))) continue;
      const select = row => ({ entityId: row.entityId, ownerEntityId: row.ownerEntityId, entityName: row.entityName, nodeKey: row.nodeKey, partKey: row.partKey, resourceIdentity: row.context.resourceIdentity });
      // 计划对象留在本次测试对象内，正式变更仍由唯一的公开Store事务提交。
      return { rule, tag, fixed: select(fixed), moving: select(moving) };
    }
    throw new Error('真实分类中未找到同资源固定部件及无例外遮挡的动态祖先节点，不能构造准确诊断验收。');
  });
  const baseline = await snapshot(page, planned.moving);
  assert.ok(baseline.active > 0 && baseline.movingWorldMatrix, '诊断验收必须从有效真实GI及实际运动节点开始');
  const proof = { ruleId: planned.rule.id, ruleName: planned.rule.name, resourceMismatchNodeRuleId: planned.rule.nodeRules[0].id,
    conflictNodeRuleId: planned.rule.nodeRules[1].id, staticNode: planned.fixed, dynamicNode: planned.moving,
    documentSha256Before: digest(baseline.document), resultSha256Before: digest(baseline.result), signatureBefore: baseline.signature,
    giActiveBefore: baseline.active, undoCountBefore: baseline.undoCount };
  let applied = false, restored = false;
  try {
    const committed = await page.evaluate(async rule => {
      const { createLightingManagerDraft } = await import('/src/editor/panels/lightingBakeManagerModel.ts');
      const state = window.lightingSmoke.store.getState(), draft = createLightingManagerDraft(state.scene, state.sceneSessionId);
      const policy = draft.lighting.policy ?? { version: 1, defaults: {}, rules: [] };
      draft.lighting.policy = { ...policy, rules: [rule, ...policy.rules] };
      return state.applyLightingManagementDraft(draft);
    }, planned.rule);
    assert.equal(committed.ok, true, committed.message); applied = true;
    await page.waitForFunction(ids => {
      const entries = window.lightingSmoke.store.getState().lightingClassification;
      return entries.some(entry => entry.entityId === ids.fixed && entry.policyMismatches?.some(issue => issue.ruleId === ids.rule))
        && entries.some(entry => entry.entityId === ids.moving && entry.nodeKey === ids.nodeKey && entry.policyConflicts?.some(issue => issue.ruleId === ids.rule));
    }, { fixed: planned.fixed.entityId, moving: planned.moving.entityId, nodeKey: planned.moving.nodeKey, rule: planned.rule.id });
    assert.equal((await snapshot(page, planned.moving)).undoCount, baseline.undoCount + 1);
    assert.equal((await snapshot(page, planned.moving)).result, baseline.result, '诊断配置不能替换或销毁旧结果');
    await ui.open('任务与资源');
    let mismatch = await issueFor(manager, planned.tag, planned.fixed.entityName);
    assert.equal(await mismatch.getByRole('button', { name: '定位部件', exact: true }).count(), 0, '资源身份失配不能把任意当前节点当作准确映射');
    await mismatch.getByRole('button', { name: '查看规则', exact: true }).click();
    proof.selectedRuleFromMismatch = await selectedRule(page, manager, planned.rule.name);
    await ui.open('任务与资源'); mismatch = await issueFor(manager, planned.tag, planned.fixed.entityName);
    await mismatch.getByRole('button', { name: '查看对象', exact: true }).click();
    proof.resourceObjectScope = await page.evaluate(() => window.lightingSmoke.store.getState().lightingManagerFocus);
    assert.deepEqual(proof.resourceObjectScope.entityIds, [planned.fixed.ownerEntityId]);
    assert.equal(Object.hasOwn(proof.resourceObjectScope, 'nodeKey'), false, '旧资源身份只能筛宿主对象');
    await manager.getByRole('tabpanel', { name: '对象与部件', exact: true }).waitFor({ state: 'visible' });
    await manager.getByRole('button', { name: /当前定位对象/ }).waitFor({ state: 'visible' });
    assert.equal(await manager.getByRole('button', { name: /当前定位对象/ }).count(), 1);
    await capture('optimization-diagnostic-resource-object');

    await ui.open('任务与资源');
    let conflict = await issueFor(manager, '动态祖先会改变当前部件的世界姿态', planned.moving.entityName, planned.moving.nodeKey);
    await conflict.getByRole('button', { name: '查看规则', exact: true }).click(); proof.selectedRuleFromConflict = await selectedRule(page, manager, planned.rule.name);
    await ui.open('任务与资源'); conflict = await issueFor(manager, '动态祖先会改变当前部件的世界姿态', planned.moving.entityName, planned.moving.nodeKey);
    await conflict.getByRole('button', { name: '查看对象', exact: true }).click();
    await page.waitForFunction(nodeKey => [...window.document.querySelectorAll('#lighting-page-objects tr.is-selected strong')].some(node => node.title === nodeKey), planned.moving.nodeKey);
    proof.conflictObjectScope = await page.evaluate(() => window.lightingSmoke.store.getState().lightingManagerFocus);
    assert.deepEqual(proof.conflictObjectScope.entityIds, [planned.moving.ownerEntityId]); assert.equal(proof.conflictObjectScope.nodeKey, planned.moving.nodeKey);
    await capture('optimization-diagnostic-dynamic-node');
    await ui.open('任务与资源'); conflict = await issueFor(manager, '动态祖先会改变当前部件的世界姿态', planned.moving.entityName, planned.moving.nodeKey);
    proof.cameraTargetBeforeFocus = await page.evaluate(() => window.lightingSmoke.runtime.scene.activeCamera.target.asArray());
    proof.expectedFocus = await focusExpectation(page, planned.moving);
    await conflict.getByRole('button', { name: '定位部件', exact: true }).click();
    await page.waitForFunction(expected => window.lightingSmoke.runtime.scene.activeCamera.target.asArray().every((value, axis) => Math.abs(value - expected[axis]) < 1e-5), proof.expectedFocus.target);
    proof.focusRequest = await page.evaluate(() => window.lightingSmoke.store.getState().lightingNodeFocusRequest);
    assert.equal(proof.focusRequest.entityId, planned.moving.entityId); assert.equal(proof.focusRequest.nodeKey, planned.moving.nodeKey);
    proof.cameraTargetAfterFocus = await page.evaluate(() => window.lightingSmoke.runtime.scene.activeCamera.target.asArray());
    await capture('optimization-diagnostic-actual-focus');
    await ui.close(); await page.keyboard.press('Control+z');
    await page.evaluate(camera => {
      const active = window.lightingSmoke.runtime.scene.activeCamera;
      active.setTarget(active.target.clone().copyFromFloats(...camera.target)); active.alpha = camera.alpha; active.beta = camera.beta; active.radius = camera.radius;
    }, baseline.camera);
    await page.waitForFunction(expected => JSON.stringify(window.lightingSmoke.store.getState().scene) === expected.document
      && window.lightingSmoke.store.getState().history.undoStack.length === expected.undoCount
      && window.lightingSmoke.runtime.getLightingBakeRuntimeError() === null, { document: baseline.document, undoCount: baseline.undoCount });
    await page.evaluate(() => window.lightingSmoke.runtime.waitForLightingReady()); await settle(page);
    const after = await snapshot(page, planned.moving);
    assert.equal(after.document, baseline.document, '一次撤销必须恢复完全相同文档');
    assert.equal(after.result, baseline.result); assert.equal(after.signature, baseline.signature);
    assert.equal(after.undoCount, baseline.undoCount); assert.equal(after.active, baseline.active); assert.equal(after.error, null);
    assert.equal(after.progressCount, baseline.progressCount, '诊断点击不能启动新的真实烘焙');
    assert.deepEqual(after.movingWorldMatrix, baseline.movingWorldMatrix, '规则诊断不能改变真实设备姿态');
    Object.assign(proof, { documentSha256After: digest(after.document), resultSha256After: digest(after.result), signatureAfter: after.signature,
      giActiveAfter: after.active, undoCountAfter: after.undoCount, restored: true });
    restored = true; await ui.open('总览与烘焙');
    check('真实资源身份失配与动态祖先冲突可查看规则/对象，确定节点实际定位；一次撤销恢复完整文档、GI与设备姿态');
    return proof;
  } finally {
    if (applied && !restored) await page.evaluate(({ id, count }) => {
      const state = window.lightingSmoke.store.getState();
      if (state.history.undoStack.length === count + 1 && state.scene.sceneSettings.lighting.policy?.rules.some(rule => rule.id === id)) state.undo();
    }, { id: planned.rule.id, count: baseline.undoCount }).catch(() => {});
  }
}
