import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const workspace = process.cwd();
const root = await mkdtemp(path.join(tmpdir(), 'zending-session-smoke-'));
const userData = path.join(root, 'user-data');
const projectWorkspace = path.join(root, 'workspace');
await mkdir(userData);
const projects = ['1', '2'].map((id) => ({
  id, projectName: `会话隔离项目 ${id === '1' ? 'A' : 'B'}`,
  latestEditorProjectId: null, latestEditorProjectVersionId: null,
  latestEditorProjectVersionNumber: null, latestEditorProjectPackageUrl: null, currentResourceRevision: '0',
}));
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  let data = { records: [], total: 0 };
  if (request.url === '/api/v1/projects/query') data = { records: projects, total: 2 };
  if (request.url === '/api/v1/projects/detail') data = projects.find((project) => project.id === body.id);
  if (request.url === '/api/v1/digital-twin/projects/status') data = {
    projectId: body.projectId, status: 'UNBOUND', editorProjectId: null,
    latestVersionId: null, latestVersionNumber: null, resourceRevision: '0',
    runtimeConfig: { projectId: body.projectId, runtimeEnabled: true },
  };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ success: true, data }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
try {
  const env = { ...process.env, OPEN_DEVTOOLS: 'false',
    VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL ?? '',
    ZENDING_EDITOR_STORAGE_ROOT: projectWorkspace, ZENDING_ALLOW_STORAGE_ROOT_OVERRIDE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [workspace, `--user-data-dir=${userData}`], cwd: workspace, env, timeout: 60_000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => void dialog.accept());
  await page.waitForFunction(() => Boolean(window.editorApi?.closeDataPlatformProject));
  await page.getByRole('button', { name: '进入空白编辑器', exact: true }).waitFor({ state: 'visible', timeout: 120_000 });
  await page.evaluate((baseUrl) => window.editorApi.saveDataPlatformConfig({ baseUrl }), `http://127.0.0.1:${server.address().port}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  for (const project of projects) {
    const card = page.locator('.home-recent-card').filter({ hasText: project.projectName });
    await card.getByRole('button', { name: '打开', exact: true }).click();
    const back = page.getByRole('button', { name: '返回首页', exact: true });
    await back.waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.scene-preparation-overlay'));
    const context = await page.evaluate(() => window.editorApi.getDigitalTwinPublishContext());
    assert.equal(context.projectId, project.id);
    assert.equal(path.resolve(context.projectRoot), path.join(projectWorkspace, 'Projects', project.id));
    await back.click();
    await page.getByRole('button', { name: '进入空白编辑器', exact: true }).waitFor({ state: 'visible' });
    const cleared = await page.evaluate(async () => ({
      context: await window.editorApi.getDigitalTwinPublishContext(), assets: await window.editorApi.listProjectAssets(),
    }));
    assert.equal(cleared.context.projectId, null);
    assert.equal(cleared.context.projectRoot, null);
    assert.equal(cleared.assets.projectRoot, null);
    assert.equal(cleared.assets.assets.length, 0);
  }
  await page.getByRole('button', { name: '进入空白编辑器', exact: true }).click();
  await page.getByRole('button', { name: '返回首页', exact: true }).waitFor({ state: 'visible' });
  assert.equal((await page.evaluate(() => window.editorApi.getDigitalTwinPublishContext())).projectId, null);
  assert.deepEqual(errors, []);
  console.log('PASS: rendered Electron A -> home -> B -> home -> blank; publish project/root and assets isolated; no page errors');
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
