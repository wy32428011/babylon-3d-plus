/* global window, requestAnimationFrame */
import assert from 'node:assert/strict';
import { runLightingOptimizationDiagnosticsSmoke } from './lightingOptimizationDiagnosticsSmoke.mjs';

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const waitLighting = async page => { await page.evaluate(() => window.lightingSmoke.runtime.waitForLightingReady()); await settle(page); };
async function openDetails(manager, prefix) {
  const summary = manager.locator('summary').filter({ hasText: new RegExp('^' + prefix) }).first();
  if (!await summary.evaluate(node => node.parentElement.open)) await summary.click();
  return summary;
}
async function discard(ui) {
  await ui.manager.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click();
  await ui.manager.getByRole('button', { name: '放弃更改并关闭', exact: true }).click();
  await ui.manager.waitFor({ state: 'hidden' });
}
async function snapshot(page) {
  return page.evaluate(() => {
    const state = window.lightingSmoke.store.getState(), scene = window.lightingSmoke.runtime.scene, gl = scene.getEngine()._gl;
    const visibleMeshes = new Set(scene.getActiveMeshes().data.slice(0, scene.getActiveMeshes().length));
    const active = scene.meshes.filter(mesh => visibleMeshes.has(mesh) && mesh.isEnabled() && mesh.isVisible && mesh.metadata?.lightingDerived && mesh.isVerticesDataPresent('lightingBakeUV'))
      .filter(mesh => mesh.subMeshes?.some(sub => {
        const effect = sub.effect, location = effect?.getUniform('lightingBakeActive'), program = effect?.getPipelineContext()?.program;
        return effect?.defines.includes('#define BAKED_INDIRECT_MAP') && location && program && gl.getUniform(program, location) === 1;
      })).length;
    return { document: JSON.stringify(state.scene), undoCount: state.history.undoStack.length, active,
      exposure: scene.imageProcessingConfiguration.exposure, mainIntensity: scene.getLightByName('__SceneLightingMain')?.intensity,
      result: JSON.stringify(state.scene.sceneSettings.lighting.result), error: window.lightingSmoke.runtime.getLightingBakeRuntimeError() };
  });
}

/** 在真实 Cycles 成功、GI shader 已绘制且运动预览停止后调用；只清理由本次 progress 记录证明归属的终态任务。 */
export async function runLightingOptimizationUiSmoke({ page, ui, capture, check }) {
  await ui.open('总览与烘焙');
  const manager = ui.manager;
  await waitLighting(page);
  const baseline = await snapshot(page);
  assert.ok(baseline.active > 0, '优化验收必须从实际有效 GI shader 开始');
  assert.equal(baseline.error, null);
  const persistedSettings = await page.evaluate(() => window.lightingSmoke.store.getState().scene.sceneSettings.lighting.bake);
  assert.equal(persistedSettings.device, 'gpu');
  assert.ok(persistedSettings.probeVolumes?.some(volume => volume.id === 'optimization-floor' && volume.enabled));
  const deviceSelect = manager.getByRole('combobox', { name: '烘焙计算设备', exact: true });
  assert.equal(await deviceSelect.inputValue(), 'gpu');
  await deviceSelect.selectOption('auto');
  assert.match(await manager.getByRole('region', { name: '待应用变更摘要', exact: true }).textContent(), /GI 输入保持不变/);
  const deviceDraft = await snapshot(page);
  assert.equal(deviceDraft.document, baseline.document); assert.equal(deviceDraft.undoCount, baseline.undoCount); assert.equal(deviceDraft.active, baseline.active);
  await deviceSelect.selectOption('gpu');
  const detectDevices = manager.getByRole('button', { name: '检测设备', exact: true });
  await detectDevices.click();
  await page.waitForFunction(() => { const button = [...window.document.querySelectorAll('button')].find(node => node.textContent === '检测设备'); return button && !button.disabled; });
  const detectedDeviceText = await manager.locator('.lighting-manager-device-status p').textContent();
  assert.match(detectedDeviceText, /CPU/);
  assert.equal((await snapshot(page)).document, baseline.document);
  await capture('optimization-device-detection');
  check('计算设备真实下拉选择仅暂存，GI继续可用；独立设备探测返回实际CPU且不改场景');

  await openDetails(manager, '显示效果');
  const exposure = manager.getByRole('spinbutton', { name: '曝光', exact: true });
  const temporaryExposure = baseline.exposure === 1.35 ? 1.15 : 1.35;
  await exposure.fill(String(temporaryExposure)); await exposure.press('Tab');
  const changes = manager.getByRole('region', { name: '待应用变更摘要', exact: true });
  assert.match(await changes.textContent(), /显示效果/);
  assert.doesNotMatch(await changes.textContent(), /影响 0 个对象/);
  assert.match(await changes.textContent(), /GI 输入保持不变/);
  await manager.getByRole('button', { name: '临时预览草稿', exact: true }).click();
  await page.waitForFunction(value => window.lightingSmoke.store.getState().lightingDraftPreview
    && window.lightingSmoke.runtime.scene.imageProcessingConfiguration.exposure === value, temporaryExposure);
  await waitLighting(page);
  const exposurePreview = await snapshot(page);
  assert.equal(exposurePreview.document, baseline.document); assert.equal(exposurePreview.undoCount, baseline.undoCount);
  assert.equal(exposurePreview.active, baseline.active, '曝光临时预览必须继续实际应用 GI');
  assert.equal(await page.evaluate(() => window.lightingSmoke.store.getState().lightingDraftPreview.suppressIndirect), false);
  await capture('optimization-exposure-draft-preview');
  await manager.getByRole('button', { name: '恢复已应用配置', exact: true }).click(); await waitLighting(page);
  assert.equal((await snapshot(page)).exposure, baseline.exposure);
  await discard(ui); await ui.open('总览与烘焙');
  check('显示更改摘要准确，临时曝光实际生效且文档、撤销栈、GI shader 均保持原值');

  await openDetails(manager, '场景照明');
  const mainIntensity = manager.getByRole('spinbutton', { name: '主光强度', exact: true });
  assert.equal(await mainIntensity.isEnabled(), true, '该受控验收夹具应使用启用的统一主光');
  const temporaryMain = Number(await mainIntensity.inputValue()) === 1.8 ? 1.55 : 1.8;
  await mainIntensity.fill(String(temporaryMain)); await mainIntensity.press('Tab');
  assert.match(await changes.textContent(), /物理照明/); assert.match(await changes.textContent(), /已有 GI 将过期/);
  await manager.getByRole('button', { name: '临时预览草稿', exact: true }).click();
  await page.waitForFunction(value => window.lightingSmoke.store.getState().lightingDraftPreview?.suppressIndirect
    && window.lightingSmoke.runtime.scene.getLightByName('__SceneLightingMain')?.intensity === value, temporaryMain);
  await waitLighting(page);
  const physicalPreview = await snapshot(page);
  assert.equal(physicalPreview.active, 0, '物理输入改变时临时画面不能继续混入旧 GI');
  assert.equal(physicalPreview.document, baseline.document); assert.equal(physicalPreview.undoCount, baseline.undoCount);
  assert.equal(physicalPreview.result, baseline.result, '临时预览不能销毁旧资产结果');
  assert.equal(await manager.getByRole('button', { name: '运动预览', exact: true }).isDisabled(), true);
  assert.equal(await manager.getByRole('button', { name: '重新烘焙', exact: true }).count(), 0, '有草稿时主动作保持应用并烘焙');
  assert.equal(await manager.getByRole('button', { name: '应用并烘焙', exact: true }).isDisabled(), true);
  await capture('optimization-physical-draft-preview');
  await manager.getByRole('button', { name: '恢复已应用配置', exact: true }).click(); await waitLighting(page);
  const restored = await snapshot(page);
  assert.equal(restored.active, baseline.active); assert.equal(restored.mainIntensity, baseline.mainIntensity);
  assert.equal(restored.error, null); assert.equal(restored.document, baseline.document);
  await discard(ui); await ui.open('总览与烘焙');
  check('物理照明临时预览停用旧 GI，恢复后真实 shader 和原资产可用，未改文档及撤销栈');

  await manager.getByRole('button', { name: '烘焙前检查', exact: true }).click();
  await page.waitForFunction(() => ['ready', 'blocked', 'error'].includes(window.lightingSmoke.store.getState().lightingBakePreflight.phase), null, { timeout: 180_000 });
  const checked = await page.evaluate(() => window.lightingSmoke.store.getState().lightingBakePreflight);
  assert.equal(checked.phase, 'ready', JSON.stringify(checked));
  assert.ok(checked.report.meshCount > 0 && checked.report.receiverCount > 0 && checked.report.triangleCount > 0);
  assert.ok(checked.report.geometryBytes > 0 && checked.report.estimatedInputBytes > 0);
  assert.ok(checked.report.estimatedDerivedNumericBytes > 0);
  assert.ok([...checked.report.bounds.min, ...checked.report.bounds.max].every(Number.isFinite));
  assert.equal(await page.evaluate(() => Boolean(window.lightingSmoke.store.getState().lightingBakeRequest)), false);
  assert.match(await manager.getByRole('tabpanel', { name: '任务与资源', exact: true }).textContent(), /图集面积下界|二进制输入估算/);
  assert.match(await manager.getByRole('tabpanel', { name: '任务与资源', exact: true }).textContent(), /派生数字数据估算/);
  assert.match(await manager.getByRole('tabpanel', { name: '任务与资源', exact: true }).textContent(), /探针覆盖范围（世界米）/);
  await page.waitForFunction(() => window.lightingSmoke.store.getState().lightingShadowCosts?.lights.length > 0);
  assert.match(await manager.locator('#lighting-cost-title').textContent(), /实时阴影成本/);
  await capture('optimization-preflight-and-costs');
  check('真实几何预检返回表面、三角形、输入内存和探针估算，实时阴影成本采用独立口径');

  await ui.open('对象与部件');
  const search = manager.getByRole('searchbox', { name: '搜索模型或部件', exact: true });
  await search.fill('提升机');
  await manager.getByRole('combobox', { name: '每页显示数量', exact: true }).selectOption('50');
  await ui.open('任务与资源'); await ui.open('对象与部件');
  assert.equal(await search.inputValue(), '提升机');
  assert.equal(await manager.getByRole('combobox', { name: '每页显示数量', exact: true }).inputValue(), '50');
  await search.fill('');
  check('隐藏页暂停后重新进入，搜索和分页设置仍保留');

  await ui.open('总览与烘焙');
  await openDetails(manager, '探针覆盖区域');
  const regionName = '优化验收专属区域';
  await manager.getByRole('button', { name: '添加覆盖区域', exact: true }).click();
  const regionOrdinal = await manager.locator('.lighting-manager-probe-volume').count();
  await manager.getByRole('textbox', { name: '探针区域 ' + regionOrdinal + ' 名称', exact: true }).fill(regionName);
  for (const axis of ['X', 'Y', 'Z']) {
    const coordinate = manager.getByRole('spinbutton', { name: '区域 ' + regionOrdinal + ' 最大 ' + axis, exact: true });
    await coordinate.fill('100'); await coordinate.press('Tab');
  }
  const spacing = manager.getByRole('spinbutton', { name: '探针间距', exact: true });
  await spacing.fill('0.5'); await spacing.press('Tab');
  assert.equal((await snapshot(page)).document, baseline.document, '区域编辑仅暂存');
  await manager.getByRole('button', { name: '应用配置', exact: true }).click();
  const regionDocument = await page.evaluate(name => {
    const state = window.lightingSmoke.store.getState(), volume = state.scene.sceneSettings.lighting.bake.probeVolumes.find(item => item.name === name);
    return { volume, undoCount: state.history.undoStack.length };
  }, regionName);
  assert.ok(regionDocument.volume?.enabled); assert.equal(regionDocument.undoCount, baseline.undoCount + 1);
  await ui.close();
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  await page.waitForFunction(name => window.lightingSmoke.store.getState().persistedSceneContent?.includes(name), regionName, { timeout: 60_000 });
  await ui.open('总览与烘焙');
  await manager.getByRole('button', { name: '烘焙前检查', exact: true }).click();
  await page.waitForFunction(() => ['blocked', 'error', 'ready'].includes(window.lightingSmoke.store.getState().lightingBakePreflight.phase), null, { timeout: 180_000 });
  const blocked = await page.evaluate(() => window.lightingSmoke.store.getState().lightingBakePreflight);
  assert.equal(blocked.phase, 'blocked', JSON.stringify(blocked));
  assert.ok(blocked.report.issues.some(issue => issue.code === 'probe-limit' && issue.severity === 'error'));
  assert.equal(await manager.getByRole('button', { name: '重新烘焙', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => Boolean(window.lightingSmoke.store.getState().lightingBakeRequest)), false);
  await capture('optimization-probe-limit-blocked');
  await ui.close(); await page.keyboard.press('Control+z'); await waitLighting(page);
  const undone = await snapshot(page);
  assert.equal(undone.document, baseline.document); assert.equal(undone.active, baseline.active); assert.equal(undone.error, null);
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  await page.waitForFunction(name => !window.lightingSmoke.store.getState().persistedSceneContent?.includes(name), regionName, { timeout: 60_000 });
  check('区域草稿经真实应用与保存，超限预检阻止启动，一次撤销恢复原范围和实际 GI');
  const diagnostics = await runLightingOptimizationDiagnosticsSmoke({ page, ui, capture, check });

  await ui.open('任务与资源');
  await manager.getByRole('button', { name: '刷新任务记录', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.lightingSmoke.store.getState().lightingBakeTaskHistory));
  const owned = await page.evaluate(() => {
    const history = window.lightingSmoke.store.getState().lightingBakeTaskHistory;
    const jobIds = new Set(window.lightingSmoke.progress.map(event => event.jobId));
    return { history, ownedTaskIds: history.tasks.filter(task => jobIds.has(task.jobId)).map(task => task.taskId) };
  });
  assert.ok(owned.ownedTaskIds.length > 0, '历史必须包含本次真实 Cycles 任务');
  const captureTask = owned.history.tasks.find(task => owned.ownedTaskIds.includes(task.taskId) && task.status === 'completed');
  assert.ok(captureTask?.captureMetrics, '真实完成任务应保留视口准备计量');
  assert.equal(captureTask.device?.requested, 'gpu');
  assert.ok(captureTask.device.actual === 'GPU' || (captureTask.device.actual === 'CPU' && captureTask.device.fallbackReason));
  assert.ok(Number.isFinite(captureTask.captureMetrics.durationMs) && captureTask.captureMetrics.durationMs >= 0, '本次Chromium时钟可用时应记录真实导出耗时');
  const observedHeap = captureTask.captureMetrics.rendererHeapMaxObservedBytes;
  assert.ok(observedHeap === null || (Number.isFinite(observedHeap) && observedHeap > 0));
  assert.equal(captureTask.captureMetrics.rendererHeapBasis, observedHeap === null ? 'unavailable' : 'performance.memory.usedJSHeapSize');
  check('真实任务历史保留Renderer准备耗时与JS堆观察，并与后台耗时分开显示');
  const readableIndex = owned.history.tasks.findIndex(task => owned.ownedTaskIds.includes(task.taskId) && task.logAvailable);
  assert.ok(readableIndex >= 0, '本次任务应具有可读取日志');
  await manager.locator('.lighting-manager-history-list article').nth(readableIndex).getByRole('button', { name: '查看日志', exact: true }).click();
  await manager.locator('.lighting-manager-task-log pre').waitFor({ state: 'visible' });
  assert.ok((await manager.locator('.lighting-manager-task-log pre').textContent()).length > 0);
  await capture('optimization-task-history-log');
  const cleanIndex = owned.history.tasks.findIndex(task => owned.ownedTaskIds.includes(task.taskId)
    && ['cancelled', 'error', 'interrupted'].includes(task.status) && task.stagingBytes > 0);
  if (cleanIndex >= 0) {
    const target = owned.history.tasks[cleanIndex];
    const beforeAssets = (await snapshot(page)).result;
    await manager.locator('.lighting-manager-history-list article').nth(cleanIndex).getByRole('button', { name: '清理临时文件', exact: true }).click();
    await page.waitForFunction(id => {
      const task = window.lightingSmoke.store.getState().lightingBakeTaskHistory?.tasks.find(item => item.taskId === id);
      return !task || task.stagingBytes === 0;
    }, target.taskId, { timeout: 60_000 });
    const afterHistory = await page.evaluate(() => window.lightingSmoke.store.getState().lightingBakeTaskHistory);
    for (const task of owned.history.tasks.filter(task => task.taskId !== target.taskId)) assert.ok(afterHistory.tasks.some(item => item.taskId === task.taskId), '不能删除其它任务记录：' + task.taskId);
    assert.equal((await snapshot(page)).result, beforeAssets); await waitLighting(page); assert.ok((await snapshot(page)).active > 0);
    check('本任务新终态临时文件可安全清理，其它任务记录、已保存光照资产和真实 GI 保持有效');
  } else check('本任务终态没有可清理临时残留；未触碰历史其它任务和已保存光照资产');

  for (const viewport of [{ width: 1440, height: 960 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport);
    for (const tab of ['总览与烘焙', '任务与资源']) {
      await ui.open(tab);
      const bounds = await manager.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1);
      const footer = await manager.locator('.lighting-manager-footer').boundingBox();
      assert.ok(footer && footer.y + footer.height <= viewport.height + 1, '页脚必须保持可操作');
      await capture('optimization-' + (tab === '总览与烘焙' ? 'overview-' : 'resources-') + viewport.width);
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 }); await ui.open('总览与烘焙');
  assert.equal((await snapshot(page)).document, baseline.document);
  check('1440 与 1024 桌面视口的预览、成本、任务和固定页脚可操作');
  return { preflight: checked.report, blocked: blocked.report, ownedTaskIds: owned.ownedTaskIds, captureMetrics: captureTask.captureMetrics, device: captureTask.device, persistedSettings, detectedDeviceText, diagnostics };
}
