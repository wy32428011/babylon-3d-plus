import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { createServer as createViteServer } from 'vite';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(path.join(tmpdir(), 'zending-config-smoke-'));
const configPath = path.join(tempRoot, 'data-platform-config.json');
const pendingResponses = [];
const api = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url.startsWith('/slow')) {
    pendingResponses.push(response);
    return;
  }
  response.end(JSON.stringify(projectList('2', '新地址项目')));
});
let vite;
let app;

function projectList(id, projectName) {
  return { success: true, data: { records: [{ id, projectName }], total: 1 } };
}

async function waitForPendingRequests(count) {
  const deadline = Date.now() + 5000;
  while (pendingResponses.length < count && Date.now() < deadline) await delay(20);
  assert.equal(pendingResponses.length, count, '慢请求应已到达模拟服务');
}

async function finishPendingRequests(page, payload) {
  for (const response of pendingResponses.splice(0)) response.end(JSON.stringify(payload));
  await page.evaluate(() => window.configSmokePendingRequest);
  // 等待旧 IPC 响应触发的 React 更新完成，再检查是否污染当前界面。
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function observePendingRequest(page) {
  await page.evaluate(() => {
    window.configSmokePendingRequest = window.editorApi.listDataPlatformProjects({ projectName: '' })
      .catch((error) => ({ error: error.message }));
  });
  await waitForPendingRequests(2);
}

async function openConfig(page) {
  await page.getByRole('button', { name: '数据中台配置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '数据中台配置' });
  await dialog.waitFor();
  return dialog.getByRole('textbox');
}

async function typeAddress(input, value) {
  assert.equal(await input.isEnabled(), true, '服务地址输入框应允许修改');
  await input.click();
  await input.press('ControlOrMeta+A');
  await input.pressSequentially(value);
  assert.equal(await input.inputValue(), value, '实际键盘输入应保留完整服务地址');
}

async function saveConfig(page) {
  const dialog = page.getByRole('dialog', { name: '数据中台配置' });
  await dialog.getByRole('button', { name: '保存并刷新' }).click();
  await dialog.waitFor({ state: 'hidden' });
}

try {
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${api.address().port}`;
  await writeFile(configPath, JSON.stringify({
    version: 2,
    baseUrl,
    workspaceRoot: path.join(tempRoot, 'workspace'),
  }));
  vite = await createViteServer({
    root: workspaceRoot,
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  });
  await vite.listen();
  const env = { ...process.env, OPEN_DEVTOOLS: 'false', VITE_DEV_SERVER_URL: vite.resolvedUrls.local[0] };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ZENDING_ALLOW_STORAGE_ROOT_OVERRIDE;
  delete env.ZENDING_EDITOR_STORAGE_ROOT;
  app = await electron.launch({ args: [workspaceRoot, `--user-data-dir=${tempRoot}`], cwd: workspaceRoot, env });
  const page = await app.firstWindow({ timeout: 120000 });
  page.setDefaultTimeout(15000);
  await page.locator('.home-workspace-path').waitFor();
  await page.waitForFunction(() => !document.querySelector('.home-workspace-path')?.textContent.includes('正在读取'));

  const input = await openConfig(page);
  assert.equal(await input.inputValue(), baseUrl);
  await typeAddress(input, `${baseUrl}/slow`);
  await saveConfig(page);
  await waitForPendingRequests(1);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).baseUrl, `${baseUrl}/slow`);
  console.log('PASS: 实际键盘输入及 IPC 保存服务地址');
  await observePendingRequest(page);

  const reopenedInput = await openConfig(page);
  await typeAddress(reopenedInput, `${baseUrl}/updated`);
  await saveConfig(page);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).baseUrl, `${baseUrl}/updated`);
  await page.locator('.home-data-platform-card').filter({ hasText: '新地址项目' }).waitFor();
  console.log('PASS: 项目请求未完成时可重新修改并保存服务地址');

  await finishPendingRequests(page, projectList('1', '旧地址项目'));
  assert.equal(await page.locator('.home-data-platform-card').count(), 1);
  assert.match(await page.locator('.home-data-platform-card').innerText(), /新地址项目/);
  const staleProjectError = await page.evaluate(async () => {
    try {
      await window.editorApi.openDataPlatformProject({ projectId: '1' });
      return '';
    } catch (error) {
      return error.message;
    }
  });
  assert.match(staleProjectError, /最近一次数据中台列表/, '旧请求不能重新填充可打开项目的缓存');
  console.log('PASS: 旧地址的成功响应不会覆盖当前列表和主进程项目缓存');

  await typeAddress(await openConfig(page), 'ftp://invalid.example');
  await page.getByRole('button', { name: '保存并刷新' }).click();
  await page.locator('.home-config-dialog-error').waitFor();
  assert.equal(await page.getByRole('dialog').getByRole('textbox').isEnabled(), true);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).baseUrl, `${baseUrl}/updated`);
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  assert.equal(await (await openConfig(page)).inputValue(), `${baseUrl}/updated`);
  console.log('PASS: 非法地址保存失败后可继续编辑，取消后恢复已保存地址');

  await typeAddress(page.getByRole('dialog').getByRole('textbox'), `${baseUrl}/slow-error`);
  await saveConfig(page);
  await waitForPendingRequests(1);
  await observePendingRequest(page);
  await typeAddress(await openConfig(page), `${baseUrl}/updated`);
  await saveConfig(page);
  await page.locator('.home-data-platform-card').filter({ hasText: '新地址项目' }).waitFor();
  await finishPendingRequests(page, { success: false, message: '旧地址连接失败' });
  assert.equal(await page.getByText('旧地址连接失败', { exact: true }).count(), 0);
  assert.match(await page.locator('.home-data-platform-card').innerText(), /新地址项目/);
  console.log('PASS: 旧地址的失败响应不会清空新地址项目或显示过期错误');

  await page.evaluate((value) => window.editorApi.saveDataPlatformConfig({ baseUrl: value }), `${baseUrl}/slow-initial`);
  await page.reload();
  await waitForPendingRequests(1);
  await observePendingRequest(page);
  const clearingInput = await openConfig(page);
  await clearingInput.press('ControlOrMeta+A');
  await clearingInput.press('Backspace');
  await saveConfig(page);
  await finishPendingRequests(page, projectList('1', '旧地址项目'));
  const cleared = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(cleared.baseUrl, '');
  assert.equal(cleared.workspaceRoot, path.join(tempRoot, 'workspace'));
  assert.equal(await page.locator('.home-data-platform-card').count(), 0);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('.home-workspace-path')?.textContent.includes('正在读取'));
  assert.equal(await (await openConfig(page)).inputValue(), '');
  console.log('PASS: 初始列表加载期间可清空配置，重载后保持为空且保留工作区');
} finally {
  for (const response of pendingResponses) response.destroy();
  if (app) await app.close();
  if (vite) await vite.close();
  api.closeAllConnections();
  await new Promise((resolve) => api.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
}
