import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import os from 'node:os';
import { listBuiltinSkyboxAssets, builtinSkyboxPackageForPath, validateBuiltinSkyboxPackage } from '../../electron/ipc/builtinSkyboxAssets.ts';

test('内置天空盒无需工程即可列出真实小文件，稳定身份与授权范围明确', async () => {
  const assets = await listBuiltinSkyboxAssets();
  assert.equal(assets.length, 1);
  const asset = assets[0];
  assert.equal(asset.id, 'builtin-skybox:partly-cloudy-light');
  assert.equal(asset.source, 'builtin');
  assert.equal(asset.fileSizeBytes, 1441554);
  assert.equal(asset.assetRevision, 'b35653ca75a00d75392649d29cd27001e5af79dcc6412aa557241bb3ecda1420');
  assert.equal(asset.fileSha256, undefined);
  assert.equal((await fs.stat(asset.path)).size, asset.fileSizeBytes);
  assert.equal(builtinSkyboxPackageForPath(asset.path), asset.packagePath);
  assert.equal(builtinSkyboxPackageForPath(asset.packagePath), asset.packagePath);
  assert.equal(builtinSkyboxPackageForPath(path.join(asset.packagePath, 'unregistered.hdr')), null);
  assert.equal(builtinSkyboxPackageForPath(path.join(asset.packagePath, '..', 'other')), null);
  await validateBuiltinSkyboxPackage(asset.packagePath);
});

test('任意外部目录不得作为内置资源目录授权', async () => {
  await assert.rejects(validateBuiltinSkyboxPackage(path.resolve('Assets/Skyboxes')), /内置天空盒/);
});

test('安装目录读取内置资源，并拒绝同大小损坏文件和符号链接', async () => {
  const [original] = await listBuiltinSkyboxAssets();
  const bytes = await fs.readFile(original.path);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'builtin-skybox-installed-'));
  const packagePath = path.join(temporaryRoot, 'builtin-skyboxes', 'partly-cloudy-light');
  const filePath = path.join(packagePath, original.name);
  const descriptors = ['resourcesPath', 'defaultApp'].map(key => [key, Object.getOwnPropertyDescriptor(process, key)] as const);
  try {
    await fs.mkdir(packagePath, { recursive: true });
    await fs.writeFile(filePath, bytes);
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: temporaryRoot });
    Object.defineProperty(process, 'defaultApp', { configurable: true, value: false });
    const [installed] = await listBuiltinSkyboxAssets();
    assert.equal(installed.path, filePath);
    assert.equal(installed.assetRevision, original.assetRevision);
    const corrupt = Buffer.from(bytes);
    corrupt[corrupt.length - 1] ^= 1;
    await fs.writeFile(filePath, corrupt);
    await assert.rejects(validateBuiltinSkyboxPackage(packagePath), /SHA-256/);
    await fs.unlink(filePath);
    await fs.symlink(original.path, filePath);
    await assert.rejects(validateBuiltinSkyboxPackage(packagePath), /符号链接|Junction/);
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(process, key, descriptor);
      else Reflect.deleteProperty(process, key);
    }
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
