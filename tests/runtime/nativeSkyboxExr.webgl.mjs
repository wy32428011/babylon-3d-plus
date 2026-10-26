/* global window */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { startSkyboxViteServer } from '../helpers/skyboxViteServer.mjs';

const fixtures = process.env.SKYBOX_EXR_FIXTURES;
if (!fixtures) throw new Error('先用 Blender 执行 tests/fixtures/nativeSkyboxExr.py，并通过 SKYBOX_EXR_FIXTURES 指定产物目录。');
const root = path.resolve(fixtures), relative = path.relative(process.cwd(), root);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '夹具必须位于当前项目内');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const server = process.env.SKYBOX_TEST_URL ? null : await startSkyboxViteServer();
const origin = process.env.SKYBOX_TEST_URL ?? server.origin;
let browser;
const requests = [], remote = [], errors = [], failed = [], results = [];
try {
  browser = await chromium.launch({ executablePath: process.env.SKYBOX_TEST_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  await page.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && !url.startsWith(origin + '/')) { remote.push(url); return route.abort(); }
    return route.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) failed.push(response.url()); });
  await page.goto(`${origin}/tests/fixtures/nativeSkybox.harness.html`);
  await page.waitForFunction(() => window.__skyboxModulesReady);
  for (const resource of manifest.resources) {
    const result = await page.evaluate(async ({ sourceUrl, resource }) => {
      const stages = [];
      const ticket = { token: 'exr-verification', sourceUrl, sourceSha256: resource.sha256, sourceRevision: resource.sha256,
        faceSize: 256, recipeKey: window.__skyboxContract.SKYBOX_ENVIRONMENT_RECIPE, environment: null };
      const bytes = await window.__skyboxModules.compileSkyboxEnvironment(ticket, 'exr', new AbortController().signal, stage => stages.push(stage));
      return { codec: resource.codec, byteLength: bytes.length, stages, structure: window.__skyboxContract.inspectSkyboxEnvironmentBytes(bytes, 256) };
    }, { sourceUrl: `${origin}/${relative.split(path.sep).map(encodeURIComponent).join('/')}/${resource.file}`, resource });
    assert.equal(result.structure.imageCount, 54);
    assert.ok(result.stages.includes('prefilter') && result.stages.includes('validate'));
    results.push(result);
    console.log('PASS EXR', resource.codec, result.byteLength);
  }
  const cancellation = await page.evaluate(async ({ sourceUrl, resource }) => {
    const { prepareSkyboxEnvironment } = await import('/src/editor/assets/skyboxPreparationService.ts');
    const source = { sourceUrl, sourcePath: 'fixture.exr', format: 'exr', assetRevision: resource.sha256, resolution: 256 };
    const ticket = { token: 'cancel-at-commit', sourceUrl, sourceSha256: resource.sha256, sourceRevision: resource.sha256,
      faceSize: 256, recipeKey: window.__skyboxContract.SKYBOX_ENVIRONMENT_RECIPE, environment: null };
    let canceled = [], commits = 0;
    const controller = new AbortController();
    window.editorApi = { prepareSkyboxEnvironment: async () => ticket,
      cancelSkyboxEnvironment: async token => { canceled.push(token); },
      commitSkyboxEnvironment: async () => { commits++; throw new Error('取消后不能提交'); } };
    let name = '';
    try { await prepareSkyboxEnvironment(source, controller.signal, stage => { if (stage === 'commit') controller.abort(); }); }
    catch (error) { name = error.name; }
    await new Promise(resolve => setTimeout(resolve, 25));
    const before = { name, commits, canceled: [...canceled] };
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    canceled = [];
    window.editorApi.commitSkyboxEnvironment = async () => { enter(); await gate; return null; };
    const second = new AbortController();
    const pending = prepareSkyboxEnvironment(source, second.signal).catch(error => error.name);
    await entered;
    second.abort();
    const afterName = await pending;
    await new Promise(resolve => setTimeout(resolve, 25));
    const during = { name: afterName, canceled: [...canceled] };
    release();
    return { before, during };
  }, { sourceUrl: `${origin}/${relative.split(path.sep).map(encodeURIComponent).join('/')}/${manifest.resources[0].file}`, resource: manifest.resources[0] });
  assert.deepEqual(cancellation.before, { name: 'AbortError', commits: 0, canceled: ['cancel-at-commit'] });
  assert.deepEqual(cancellation.during, { name: 'AbortError', canceled: ['cancel-at-commit'] });
  assert.deepEqual(remote, []); assert.deepEqual(errors, []); assert.deepEqual(failed, []);
  for (const resource of manifest.resources) assert.ok(requests.some(url => url.includes(resource.file)
    && new URL(url).searchParams.get('assetRevision') === resource.sha256), '原图读取URL必须以实际SHA隔离HTTP缓存');
  await writeFile(path.join(root, 'webgl-result.json'), JSON.stringify({ results, cancellation, remote, errors, failed, cycles: manifest.cycles }, null, 2));
  console.log('PASS OFFLINE_EXR_AND_COMMIT_CANCELLATION');
} finally { await browser?.close(); await server?.close(); }
