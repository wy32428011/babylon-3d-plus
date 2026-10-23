/* global window */
import assert from 'node:assert/strict';

export const lightingManagerSecondLiftId = 'lighting-manager-lift-two';

/** 正式集中管理入口的实际点击验证；只用 Store 安排夹具旧配置和复制后的空间位置。 */
export async function runLightingManagerUiSmoke({ page, liftId, capture, check }) {
  const manager = page.getByRole('dialog', { name: '光照与烘焙管理器', exact: true });
  const open = async tab => {
    if (!await manager.isVisible()) await page.getByRole('button', { name: '光照与烘焙管理器', exact: true }).click();
    await manager.waitFor({ state: 'visible' });
    await manager.getByRole('tab', { name: tab, exact: true }).click();
  };
  const close = async () => {
    await manager.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click();
    await manager.waitFor({ state: 'hidden' });
  };
  const legacy = await page.evaluate(id => {
    const state = window.lightingSmoke.store.getState();
    const column = state.lightingClassification.find(entry => entry.entityId === id && entry.name === 'LiftColumn');
    if (!column) throw new Error('真实升降机固定柱尚未加载');
    state.updateLightingNodeOverride(id, column.nodeKey, { receiveShadows: false });
    window.lightingSmoke.store.getState().selectEntity(id);
    return JSON.stringify(window.lightingSmoke.store.getState().scene.entities[id].components.lighting);
  }, liftId);
  await open('总览与烘焙');
  await page.waitForFunction(() => window.lightingSmoke.store.getState().lightingManagerPreview?.startsWith('data:image/'));
  const previewColors = await manager.getByRole('img', { name: '当前场景的真实视口快照', exact: true }).evaluate(image => {
    const canvas = window.document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data, colors = new Set();
    for (let i = 0; i < pixels.length; i += 64) colors.add(pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2]);
    return colors.size;
  });
  assert.ok(previewColors > 20, '真实视口预览不能是空白读回：' + previewColors);
  assert.ok(await page.locator('.lighting-manager-summary').count() > 0, '已选模型必须展示集中管理摘要');
  assert.equal(await page.locator('.lighting-manager-summary select').count(), 0, '摘要不能保留分散参数');
  await capture('manager-overview');
  const initialQuality = await manager.getByRole('combobox', { name: '烘焙质量', exact: true }).inputValue();
  const untouchedScene = await page.evaluate(() => JSON.stringify(window.lightingSmoke.store.getState().scene));
  await manager.getByRole('combobox', { name: '烘焙质量', exact: true }).selectOption(initialQuality === 'high' ? 'standard' : 'high');
  await manager.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click();
  await manager.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await manager.isVisible(), true);
  await page.keyboard.press('Escape');
  await manager.getByRole('button', { name: '放弃更改并关闭', exact: true }).click();
  await manager.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => JSON.stringify(window.lightingSmoke.store.getState().scene)), untouchedScene);
  await open('总览与烘焙');
  assert.equal(await manager.getByRole('combobox', { name: '烘焙质量', exact: true }).inputValue(), initialQuality);
  await manager.focus(); await page.keyboard.press('Delete');
  assert.equal(await page.evaluate(() => JSON.stringify(window.lightingSmoke.store.getState().scene)), untouchedScene, '管理器不能透传删除快捷键');
  check('未应用草稿可继续编辑或明确放弃，Escape/删除键不会误改后台场景');
  const beforeRule = await page.evaluate(() => JSON.stringify(window.lightingSmoke.store.getState().scene));
  await manager.getByRole('tab', { name: '分类规则', exact: true }).click();
  await manager.getByRole('button', { name: /新建规则/ }).click();
  const ruleName = '提升机集中策略';
  await manager.getByRole('textbox', { name: '规则名称', exact: true }).fill(ruleName);
  await manager.getByRole('combobox', { name: '规则作用范围', exact: true }).selectOption('resource');
  const resourcePicker = manager.getByRole('combobox', { name: '规则模型资源', exact: true });
  const options = await resourcePicker.locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, text: node.textContent })));
  const resource = options.find(option => /^arrow-lift(?:$|\s|[（(·])|arrow-lift\.glb|^提升机箭头验收/.test(option.text));
  assert.ok(resource, '集中规则必须列出当前真实模型资源：' + JSON.stringify(options));
  await resourcePicker.selectOption(resource.value);
  await manager.getByRole('combobox', { name: ruleName + ' 投射阴影', exact: true }).selectOption('false');
  await manager.getByRole('button', { name: /固定结构/ }).click();
  await manager.getByRole('combobox', { name: '部件策略 1 动静分类', exact: true }).selectOption('static');
  await manager.getByRole('button', { name: /运动部件/ }).click();
  await manager.getByRole('combobox', { name: '部件策略 2 动静分类', exact: true }).selectOption('dynamic');
  assert.equal(await page.evaluate(() => JSON.stringify(window.lightingSmoke.store.getState().scene)), beforeRule, '未应用规则不得提前改文档');
  await capture('manager-rules');
  await manager.getByRole('button', { name: '应用规则', exact: true }).click();
  await page.waitForFunction(({ liftId, secondId }) => {
    const state = window.lightingSmoke.store.getState();
    return state.scene.sceneSettings.lighting.policy?.rules.length === 1
      && state.lightingClassification.some(entry => entry.entityId === secondId && entry.castShadows === false)
      && state.lightingClassification.some(entry => entry.entityId === secondId && entry.name === 'LiftDeck' && entry.mobility === 'dynamic')
      && state.lightingClassification.some(entry => entry.entityId === liftId && entry.name === 'LiftColumn' && entry.receiveShadows === false);
  }, { liftId, secondId: lightingManagerSecondLiftId });
  assert.equal(await page.evaluate(id => JSON.stringify(window.lightingSmoke.store.getState().scene.entities[id].components.lighting), liftId), legacy);
  check('统一规则按真实模型资源作用，固定与运动部件分开，已有例外原样保留');
  await close();

  const beforeCopy = await page.evaluate(() => window.lightingSmoke.store.getState().scene.entityIds);
  await page.getByText('提升机集中实例02', { exact: true }).click();
  await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v');
  await page.waitForFunction(ids => window.lightingSmoke.store.getState().scene.entityIds.some(id => !ids.includes(id)), beforeCopy);
  const copied = await page.evaluate(ids => {
    const store = window.lightingSmoke.store, state = store.getState();
    const entity = state.scene.entityIds.map(id => state.scene.entities[id]).find(entity => !ids.includes(entity.id) && entity.components.modelAsset);
    if (!entity) throw new Error('真实复制操作未创建同资源实例');
    const position = entity.components.transform.position;
    store.setState({ scene: { ...state.scene, entities: { ...state.scene.entities, [entity.id]: { ...entity,
      components: { ...entity.components, transform: { ...entity.components.transform, position: { ...position, x: position.x + 4 } } } } } } });
    return { id: entity.id, name: entity.name, lighting: entity.components.lighting };
  }, beforeCopy);
  assert.equal(copied.lighting, undefined, '同资源继承不能展开为逐模型配置');
  await page.waitForFunction(id => window.lightingSmoke.store.getState().lightingClassification.some(entry => entry.entityId === id && entry.castShadows === false), copied.id);
  check('实际UI复制新增实例自动继承资源规则，没有写入模型例外');

  await open('对象与部件');
  const secondName = '提升机集中实例02';
  await manager.getByRole('checkbox', { name: '选择 ' + secondName + ' 对象', exact: true }).check();
  const cameraBefore = await page.evaluate(() => JSON.stringify(window.lightingSmoke.runtime.scene.activeCamera.target.asArray()));
  await manager.getByRole('button', { name: '在场景中定位', exact: true }).click();
  await page.waitForFunction(before => JSON.stringify(window.lightingSmoke.runtime.scene.activeCamera.target.asArray()) !== before, cameraBefore);
  await manager.getByRole('checkbox', { name: '选择 ' + copied.name + ' 对象', exact: true }).check();
  const beforeBulk = await page.evaluate(() => JSON.stringify(window.lightingSmoke.store.getState().scene));
  await manager.getByRole('combobox', { name: '批量接收阴影', exact: true }).selectOption('false');
  await manager.getByRole('button', { name: '暂存例外设置', exact: true }).click();
  assert.equal(await page.evaluate(() => JSON.stringify(window.lightingSmoke.store.getState().scene)), beforeBulk);
  await capture('manager-objects');
  await manager.getByRole('button', { name: '应用配置', exact: true }).click();
  await page.waitForFunction(ids => ids.every(id => {
    const rows = window.lightingSmoke.store.getState().lightingClassification.filter(entry => entry.entityId === id);
    return rows.length > 0 && rows.every(entry => entry.receiveShadows === false && entry.castShadows === false);
  }), [lightingManagerSecondLiftId, copied.id]);
  const bulk = await page.evaluate(ids => ids.map(id => window.lightingSmoke.store.getState().scene.entities[id].components.lighting), [lightingManagerSecondLiftId, copied.id]);
  assert.ok(bulk.every(settings => settings.receiveShadows === false && settings.inheritPolicy.includes('castShadows')));
  await close(); await page.keyboard.press('Control+z');
  await page.waitForFunction(ids => ids.every(id => !window.lightingSmoke.store.getState().scene.entities[id].components.lighting), [lightingManagerSecondLiftId, copied.id]);
  check('跨模型批量例外先暂存后统一应用，一次撤销恢复规则继承');

  await open('分类规则');
  await manager.locator('.lighting-manager-rule-select').filter({ hasText: ruleName }).click();
  await manager.getByRole('combobox', { name: ruleName + ' 投射阴影', exact: true }).selectOption('true');
  await manager.getByRole('combobox', { name: '部件策略 1 接收阴影', exact: true }).selectOption('false');
  await manager.getByRole('button', { name: '应用规则', exact: true }).click();
  await page.waitForFunction(ids => ids.every(id => {
    const rows = window.lightingSmoke.store.getState().lightingClassification.filter(entry => entry.entityId === id);
    return rows.some(entry => entry.name === 'LiftColumn' && entry.receiveShadows === false)
      && rows.some(entry => entry.name === 'LiftDeck' && entry.receiveShadows === true);
  }), [lightingManagerSecondLiftId, copied.id]);
  await manager.getByRole('tab', { name: '总览与烘焙', exact: true }).click();
  for (const viewport of [{ width: 1586, height: 992 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport);
    const bounds = await manager.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1
      && bounds.y + bounds.height <= viewport.height + 1, '管理器不得超出桌面视口：' + JSON.stringify({ viewport, bounds }));
    await capture('manager-overview-' + viewport.width);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await manager.getByRole('button', { name: '刷新场景预览', exact: true }).click();
  await page.waitForFunction(() => window.lightingSmoke.store.getState().lightingManagerPreview && !window.lightingSmoke.store.getState().lightingManagerPreviewError);
  check('参考与较窄桌面视口可操作，预览来自实际WebGL画面');
  const expectedPolicyBindings = [lightingManagerSecondLiftId, copied.id].map(entityId => ({ entityId, nodeName: 'LiftColumn', receiveShadows: false }));
  expectedPolicyBindings.push({ entityId: 'hclift-arrow-fixture', nodeName: 'HcColumn', receiveShadows: true });
  return { manager, open, close, copied, ruleName, expectedPolicyBindings };
}
