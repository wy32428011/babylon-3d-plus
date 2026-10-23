/* global window */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const engineDialog = page => page.getByRole('dialog', { name: '本机烘焙引擎', exact: true });
export const engineConfiguration = page => page.evaluate(() => window.editorApi.getLightingBakeEngineConfiguration());

async function waitForCandidate(page, expected) {
  await page.waitForFunction(value => {
    const input = window.document.querySelector('.lighting-engine-dialog input');
    return input && !input.disabled && input.value === value;
  }, expected, { timeout: 90_000 });
}

/** 仅点击正式 UI；候选检测与最终配置另从正式 IPC 和磁盘独立交叉核对。 */
export async function fillAndSaveEngine({ page, blenderPath, capture, name, browse = false }) {
  const dialog = engineDialog(page);
  await dialog.waitFor({ state: 'visible' });
  const input = dialog.getByRole('textbox', { name: 'Blender 可执行文件', exact: true });
  if (browse) await dialog.getByRole('button', { name: '浏览…', exact: true }).click();
  else await input.fill(blenderPath);
  await waitForCandidate(page, blenderPath);
  assert.equal(await input.inputValue(), blenderPath);
  await dialog.getByRole('button', { name: '检测', exact: true }).click();
  await dialog.getByRole('button', { name: '检测', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const current = [...window.document.querySelectorAll('[role="dialog"],dialog')]
      .find(node => node.textContent?.includes('Blender 可执行文件'));
    const button = current && [...current.querySelectorAll('button')].find(node => node.textContent === '检测');
    return button && !button.disabled && /Blender\s+[4-9]\d*\./.test(current.textContent ?? '');
  }, null, { timeout: 90_000 });
  const geometry = await dialog.evaluate(element => ({
    dialogHeight: element.getBoundingClientRect().height,
    formHeight: element.querySelector('form').getBoundingClientRect().height,
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
  }));
  assert.ok(Math.abs(geometry.dialogHeight - geometry.formHeight - 2) <= 2, `配置窗口应紧贴表单内容：${JSON.stringify(geometry)}`);
  if (geometry.viewportWidth >= 1000) assert.ok(geometry.dialogHeight < geometry.viewportHeight - 100, '桌面配置窗口不能因原生上下定位而撑满视口');
  await capture(name + '-detected');
  await dialog.getByRole('button', { name: '保存并关闭', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 90_000 });
  const saved = await engineConfiguration(page);
  assert.equal(saved.configuredPath, blenderPath, JSON.stringify(saved));
  assert.equal(saved.source, 'configuration', '无环境变量时应实际使用已保存的本机路径');
  assert.equal(saved.engine.available, true, JSON.stringify(saved));
  assert.equal(saved.engine.path, blenderPath, JSON.stringify(saved));
  assert.ok(Number(saved.engine.version?.split('.')[0]) >= 4, JSON.stringify(saved));
  assert.ok(saved.engine.devices?.length > 0, '正式引擎检测必须返回设备清单');
  const content = await readFile(saved.configPath, 'utf8');
  assert.equal(JSON.parse(content).blenderPath, blenderPath, '实际用户配置文件应保存正式选择的路径');
  return { configuration: saved, content };
}

/** 本机配置不能修改场景、撤销历史或发布工程数据。 */
export async function runLightingEngineConfigurationUiSmoke({ page, blenderPath, invalidPath, capture, check }) {
  const initial = await engineConfiguration(page);
  assert.equal(initial.configuredPath, null);
  assert.equal(initial.engine.available, false, JSON.stringify(initial));
  const untouchedScene = await page.evaluate(() => JSON.stringify(window.lightingSmoke.store.getState().scene));
  const manager = page.getByRole('dialog', { name: '光照与烘焙管理器', exact: true });
  await page.getByRole('button', { name: '光照与烘焙管理器', exact: true }).click();
  await manager.getByRole('tab', { name: '总览与烘焙', exact: true }).click();
  await manager.getByRole('button', { name: '配置引擎…', exact: true }).click();
  const dialog = engineDialog(page);
  await dialog.waitFor({ state: 'visible' });
  assert.match(await dialog.innerText(), /所有工程|全部工程|工程共用/);
  await capture('engine-missing');
  check('隔离 userData 和自动发现目录，真实管理器显示缺少 Blender 并可打开配置');
  const saved = await fillAndSaveEngine({ page, blenderPath, capture, name: 'engine-selected', browse: true });
  check('真实文件选择、版本与设备检测、保存成功，磁盘 JSON 与正式 IPC 一致');
  await manager.getByRole('button', { name: '配置引擎…', exact: true }).click();
  const input = dialog.getByRole('textbox', { name: 'Blender 可执行文件', exact: true });
  await waitForCandidate(page, blenderPath);
  assert.equal(await input.inputValue(), blenderPath, '关闭重开应读回已生效路径');
  await input.fill(invalidPath);
  await dialog.getByRole('button', { name: '检测', exact: true }).click();
  await dialog.getByRole('alert').first().waitFor({ state: 'visible' });
  await capture('engine-invalid-path');
  const saveButton = dialog.getByRole('button', { name: '保存并关闭', exact: true });
  if (await saveButton.isEnabled()) {
    await saveButton.click();
    await dialog.getByRole('alert').first().waitFor({ state: 'visible' });
  }
  assert.equal(await dialog.isVisible(), true, '无效路径不得关闭并伪造保存成功');
  assert.equal(await readFile(saved.configuration.configPath, 'utf8'), saved.content, '无效路径不得覆盖原配置字节');
  assert.equal((await engineConfiguration(page)).configuredPath, blenderPath);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await manager.getByRole('button', { name: '配置引擎…', exact: true }).click();
  await waitForCandidate(page, blenderPath);
  assert.equal(await input.inputValue(), blenderPath);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await manager.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click();
  assert.equal(await page.evaluate(() => JSON.stringify(window.lightingSmoke.store.getState().scene)), untouchedScene);
  check('错误路径检测及保存被拒绝，旧文件保持不变；取消和重开不污染场景');
  return saved;
}

/** 从本地发布入口完成缺失诊断、配置修复和原窗口重新检查，保持用户表单。 */
export async function runLightingEnginePublishCheckSmoke({ page, blenderPath, capture, check }) {
  await verifyDigitalTwinForm({ page, blenderPath, capture, save: false });
  await page.getByRole('button', { name: '导出离线部署包', exact: true }).click();
  const publish = page.getByRole('dialog', { name: '导出部署工程', exact: true });
  const section = publish.getByRole('region', { name: '发布检查', exact: true });
  await section.getByText('发布前需要生成或刷新光照，请先配置可用的 Blender 4+。', { exact: true }).waitFor();
  const projectName = publish.getByRole('textbox', { name: '工程名称', exact: true });
  await projectName.fill('engine-configuration-dist');
  const zip = publish.getByRole('radio', { name: /ZIP 压缩包/ });
  await zip.check();
  await section.getByRole('button', { name: '配置 Blender…', exact: true }).click();
  await engineDialog(page).waitFor({ state: 'visible' });
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await engineDialog(page).evaluate(dialog => {
    const bounds = dialog.getBoundingClientRect();
    const body = dialog.querySelector('.lighting-engine-body');
    const footer = dialog.querySelector('footer').getBoundingClientRect();
    return { x: bounds.x, right: bounds.right, y: bounds.y, bottom: bounds.bottom,
      width: bounds.width, scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth,
      bodyScrollWidth: body.scrollWidth, bodyClientWidth: body.clientWidth, footerBottom: footer.bottom,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  });
  assert.ok(narrow.x >= -1 && narrow.right <= narrow.viewportWidth + 1 && narrow.y >= -1
    && narrow.bottom <= narrow.viewportHeight + 1, JSON.stringify(narrow));
  assert.ok(narrow.scrollWidth <= narrow.clientWidth + 1 && narrow.bodyScrollWidth <= narrow.bodyClientWidth + 1,
    '390px 配置窗口及正文不能水平溢出：' + JSON.stringify(narrow));
  assert.ok(narrow.footerBottom <= narrow.viewportHeight + 1, '窄屏必须保留可操作的配置窗口底栏');
  await capture('publish-engine-narrow-390');
  await page.keyboard.press('Escape');
  await engineDialog(page).waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1440, height: 960 });
  assert.equal(await publish.isVisible(), true, 'Esc 关闭配置时必须保留外层发布表单');
  assert.equal(await projectName.inputValue(), 'engine-configuration-dist');
  assert.equal(await zip.isChecked(), true);
  await section.getByRole('button', { name: '配置 Blender…', exact: true }).click();
  await fillAndSaveEngine({ page, blenderPath, capture, name: 'publish-engine' });
  await publish.waitFor({ state: 'visible' });
  assert.equal(await projectName.inputValue(), 'engine-configuration-dist');
  assert.equal(await zip.isChecked(), true, '配置保存后必须保留用户选择的输出形式');
  await section.getByRole('button', { name: '重新检查引擎', exact: true }).click();
  await section.getByText('本机烘焙引擎已就绪，可继续发布。', { exact: true }).waitFor();
  await capture('publish-engine-ready');
  await publish.getByRole('button', { name: '关闭导出部署工程对话框', exact: true }).click();
  await verifyDigitalTwinForm({ page, blenderPath, capture, save: true });
  check('390px 配置窗口无水平溢出，Esc 只关闭配置且保留原发布表单与输出形式');
  check('正式本地发布检查通过配置入口修复，返回原表单并重新检查成功');
  check('真实中台发布窗取消与保存引擎配置后保留发布名称、备注和 Origin；未连接项目不能提交');
}

/** 隔离工程没有中台绑定；只打开、编辑和关闭表单，绝不点击远端发布。 */
async function verifyDigitalTwinForm({ page, blenderPath, capture, save }) {
  await page.getByRole('button', { name: '发布到数据中台', exact: true }).click();
  const publish = page.getByRole('dialog', { name: '发布到数据中台', exact: true });
  const name = publish.getByRole('textbox', { name: '发布名称', exact: true });
  const remark = publish.getByRole('textbox', { name: '备注', exact: true });
  await name.fill('本机引擎配置 UI 验收'); await remark.fill('仅测试本机配置，不向远端发布');
  const add = publish.getByRole('button', { name: '+ 添加父页面 Origin', exact: true });
  if (await publish.getByRole('textbox', { name: '父页面 Origin 1', exact: true }).count() === 0) await add.click();
  const origin = publish.getByRole('textbox', { name: '父页面 Origin 1', exact: true });
  await origin.fill('https://engine-smoke.example.com');
  const section = publish.getByRole('region', { name: '发布检查', exact: true });
  await section.getByRole('button', { name: '配置 Blender…', exact: true }).click();
  if (save) await fillAndSaveEngine({ page, blenderPath, capture, name: 'digital-twin-engine' });
  else {
    await engineDialog(page).waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await engineDialog(page).waitFor({ state: 'hidden' });
  }
  assert.equal(await publish.isVisible(), true);
  assert.equal(await name.inputValue(), '本机引擎配置 UI 验收');
  assert.equal(await remark.inputValue(), '仅测试本机配置，不向远端发布');
  assert.equal(await origin.inputValue(), 'https://engine-smoke.example.com');
  assert.equal(await publish.getByRole('button', { name: '确认发布', exact: true }).isDisabled(), true,
    '无中台项目绑定的隔离工程不得提交远端发布');
  await capture(save ? 'digital-twin-engine-saved' : 'digital-twin-engine-missing');
  await publish.getByRole('button', { name: '关闭发布到数据中台对话框', exact: true }).click();
}
