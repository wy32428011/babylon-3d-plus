/* global window */
import { chromium } from 'playwright';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSkyboxViteServer } from '../tests/helpers/skyboxViteServer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const externalBase = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : process.env.SKYBOX_TEST_URL;
const ownServer = externalBase ? null : await startSkyboxViteServer();
const base = ownServer?.origin ?? externalBase;
const url = new URL(base);
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('内置资源生成只连接本机项目验证服务。');
const target = path.join(root, 'public', 'builtin-skybox-environments');
const expectedSource = 'b35653ca75a00d75392649d29cd27001e5af79dcc6412aa557241bb3ecda1420';
const original = await readFile(path.join(root, 'public/builtin-skyboxes/partly-cloudy-light/partly-cloudy-light.hdr'));
if (createHash('sha256').update(original).digest('hex') !== expectedSource) throw new Error('内置原图与登记 SHA 不一致。');
await mkdir(target, { recursive: true });
const allowed = new Set(['256.env', '512.env', '1024.env', 'manifest.json', 'LICENSE.md']);
if ((await readdir(target)).some(name => !allowed.has(name))) throw new Error('产物目录存在未知文件，拒绝覆盖。');
const browser = await chromium.launch({ executablePath: process.env.SKYBOX_TEST_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
page.on('console', message => { if (message.type() !== 'debug') console.log(message.text()); });
const watchdog = setTimeout(() => { console.error('内置 ENV 生成超时。'); void browser.close(); }, 600000);
try {
  await page.goto(`${url.origin}/tests/fixtures/nativeSkybox.harness.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__skyboxModulesReady === true);
  await page.waitForLoadState('networkidle');
  const resources = [];
  for (const size of [256, 512, 1024]) {
    const generated = await page.evaluate(async ({ base, size, expectedSource }) => {
      const { compileSkyboxEnvironment } = window.__skyboxModules, contract = window.__skyboxContract;
      const bytes = await compileSkyboxEnvironment({ token: 'builtin-generator', sourceUrl: `${base}/builtin-skyboxes/partly-cloudy-light/partly-cloudy-light.hdr`,
        sourceSha256: expectedSource, sourceRevision: expectedSource, faceSize: size, recipeKey: contract.SKYBOX_ENVIRONMENT_RECIPE, environment: null },
      'hdr', new AbortController().signal, stage => console.log(`${size}: ${stage}`));
      return { bytes: Array.from(bytes), recipeKey: contract.SKYBOX_ENVIRONMENT_RECIPE };
    }, { base: url.origin, size, expectedSource });
    const bytes = Buffer.from(generated.bytes), sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = `${size}.env`;
    // 先检查旧内容，生成工具只更新自己登记的产物；原 HDR 完全不写入。
    let existing = null;
    try { existing = await readFile(path.join(target, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!existing || !existing.equals(bytes)) await writeFile(path.join(target, file), bytes);
    resources.push({ version: 1, format: 'env', sourceSha256: expectedSource, sourceRevision: expectedSource,
      recipeKey: generated.recipeKey, sha256, byteLength: bytes.length, faceSize: size, file });
  }
  const manifest = { version: 1, sourceSha256: expectedSource, resources };
  await writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest, null, 2));
} finally { clearTimeout(watchdog); await browser.close(); await ownServer?.close(); }
