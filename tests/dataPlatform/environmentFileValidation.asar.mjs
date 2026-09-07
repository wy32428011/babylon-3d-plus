import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPackage } = require('@electron/asar');
const electronPath = require('electron');
const root = await mkdtemp(path.join(os.tmpdir(), 'environment-asar-'));
const appRoot = path.join(root, 'app');
try {
  await mkdir(appRoot);
  await cp(path.resolve('dist-electron'), path.join(appRoot, 'dist-electron'), { recursive: true });
  await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'environment-asar-validation', version: '1.0.0', type: 'module', main: 'main.cjs' }));
  await writeFile(path.join(appRoot, 'main.cjs'), `
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', process.env.ENVIRONMENT_ASAR_USER_DATA);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let validation;
  try {
    validation = await import('./dist-electron/ipc/environmentFileValidation.js');
    const result = await validation.validateEnvironmentFile(process.env.ENVIRONMENT_ASAR_GLB);
    await validation.disposeEnvironmentFileValidation();
    fs.writeFileSync(process.env.ENVIRONMENT_ASAR_RESULT, JSON.stringify({ ok: true, result, appPath: app.getAppPath(), versions: process.versions }));
    app.exit(0);
  } catch (error) {
    if (validation) await validation.disposeEnvironmentFileValidation();
    fs.writeFileSync(process.env.ENVIRONMENT_ASAR_RESULT, JSON.stringify({ ok: false, error: error.stack || String(error), appPath: app.getAppPath(), versions: process.versions }));
    app.exit(1);
  }
});
`);
  const glbPath = path.join(root, 'model.glb');
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }], meshes: [{ primitives: [{}] }] }));
  const jsonSize = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(32 + jsonSize);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonSize, 12); bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(0x20, 20, 20 + jsonSize); json.copy(bytes, 20);
  bytes.writeUInt32LE(4, 20 + jsonSize); bytes.writeUInt32LE(0x004e4942, 24 + jsonSize);
  await writeFile(glbPath, bytes);
  const archive = path.join(root, 'app.asar');
  await createPackage(appRoot, archive);
  const resultPath = path.join(root, 'result.json');
  const env = { ...process.env, ENVIRONMENT_ASAR_USER_DATA: path.join(root, 'user-data'), ENVIRONMENT_ASAR_GLB: glbPath, ENVIRONMENT_ASAR_RESULT: resultPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [archive, '--no-sandbox'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), 30_000);
  let exitCode;
  try { exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); } finally { clearTimeout(timeout); }
  let result;
  try { result = JSON.parse(await readFile(resultPath, 'utf8')); } catch { throw new Error(`Electron did not produce a result: exit=${exitCode}\n${output}`); }
  console.log(JSON.stringify({ ...result, exitCode, output }, null, 2));
  assert.equal(result.ok, true, result.error);
  assert.equal(exitCode, 0);
  assert.ok(result.appPath.endsWith('app.asar'));
  assert.equal(result.result.fileSizeBytes, bytes.length);
} finally {
  await rm(root, { recursive: true, force: true });
}
