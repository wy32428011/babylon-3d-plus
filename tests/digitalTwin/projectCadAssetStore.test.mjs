import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importCadFileIntoProject } from '../../dist-electron/ipc/projectCadAssetStore.js';
import { isAuthorizedAssetFile } from '../../dist-electron/ipc/assetRegistry.js';

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-cad-import-'));
  const projectRoot = path.join(root, 'project');
  const sourceRoot = path.join(root, 'selected');
  await mkdir(projectRoot);
  await mkdir(sourceRoot);
  try {
    await run({ root, projectRoot, sourceRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('CAD 导入保存项目内原文件，删除原图纸后仍能读取完整副本', () => fixture(async ({ projectRoot, sourceRoot }) => {
  const sourcePath = path.join(sourceRoot, '中鼎五期_20260716.DXF');
  const content = Buffer.from('0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n');
  await writeFile(sourcePath, content);

  const imported = await importCadFileIntoProject(projectRoot, sourcePath);
  assert.equal(path.basename(imported.filePath), path.basename(sourcePath));
  assert.equal(path.dirname(path.dirname(imported.filePath)), path.join(projectRoot, 'Assets', 'Cad'));
  assert.equal(imported.fileSizeBytes, content.length);
  assert.equal(imported.sourceUrl, `editor-asset://local/${encodeURIComponent(imported.filePath)}`);
  assert.equal(isAuthorizedAssetFile(imported.filePath), true);
  await rm(sourcePath);
  assert.deepEqual(await readFile(imported.filePath), content);
}));

test('同时导入同名不同内容 CAD 不覆盖任何已有图纸', () => fixture(async ({ projectRoot, sourceRoot }) => {
  const alternateRoot = path.join(sourceRoot, 'another');
  await mkdir(alternateRoot);
  const sourcePaths = [path.join(sourceRoot, 'layout.dxf'), path.join(alternateRoot, 'layout.dxf')];
  await writeFile(sourcePaths[0], 'first drawing');
  await writeFile(sourcePaths[1], 'second drawing');
  const imports = await Promise.all(sourcePaths.map(sourcePath => importCadFileIntoProject(projectRoot, sourcePath)));
  assert.notEqual(imports[0].filePath, imports[1].filePath);
  assert.equal(await readFile(imports[0].filePath, 'utf8'), 'first drawing');
  assert.equal(await readFile(imports[1].filePath, 'utf8'), 'second drawing');
  assert.deepEqual(await Promise.all(sourcePaths.map(sourcePath => readFile(sourcePath, 'utf8'))), ['first drawing', 'second drawing']);
}));

test('错误扩展名、缺失文件和伪装成 DXF 的目录不会创建 CAD 副本', () => fixture(async ({ projectRoot, sourceRoot }) => {
  const wrongExtension = path.join(sourceRoot, 'drawing.txt');
  const directory = path.join(sourceRoot, 'folder.dxf');
  await writeFile(wrongExtension, 'text');
  await mkdir(directory);
  await assert.rejects(importCadFileIntoProject(projectRoot, wrongExtension), /\.dxf/);
  await assert.rejects(importCadFileIntoProject(projectRoot, path.join(sourceRoot, 'missing.dxf')), /ENOENT/);
  await assert.rejects(importCadFileIntoProject(projectRoot, directory), /普通文件/);
  assert.deepEqual(await readdir(projectRoot), []);
}));

test('未选择项目目录时拒绝隐式使用当前工作目录', () => fixture(async ({ sourceRoot }) => {
  const sourcePath = path.join(sourceRoot, 'drawing.dxf');
  await writeFile(sourcePath, 'drawing');
  await assert.rejects(importCadFileIntoProject('', sourcePath), /已选择的项目目录/);
  await assert.rejects(importCadFileIntoProject('relative-project', sourcePath), /已选择的项目目录/);
}));

test('复制失败清理本次部分副本，保留原图纸和已有项目资产', (context) => fixture(async ({ projectRoot, sourceRoot }) => {
  const cadRoot = path.join(projectRoot, 'Assets', 'Cad');
  await mkdir(cadRoot, { recursive: true });
  await writeFile(path.join(cadRoot, 'existing.dxf'), 'existing');
  const sourcePath = path.join(sourceRoot, 'drawing.dxf');
  await writeFile(sourcePath, 'complete drawing');
  context.mock.method(fs, 'copyFile', async (_source, target) => {
    await writeFile(target, 'partial');
    throw new Error('simulated copy failure');
  });
  await assert.rejects(importCadFileIntoProject(projectRoot, sourcePath), /simulated copy failure/);
  assert.deepEqual(await readdir(cadRoot), ['existing.dxf']);
  assert.equal(await readFile(path.join(cadRoot, 'existing.dxf'), 'utf8'), 'existing');
  assert.equal(await readFile(sourcePath, 'utf8'), 'complete drawing');
}));

test('拒绝通过源文件祖先 Junction 或符号链接导入 CAD', () => fixture(async ({ root, projectRoot, sourceRoot }) => {
  await writeFile(path.join(sourceRoot, 'drawing.dxf'), 'original drawing');
  const linkedRoot = path.join(root, 'linked-source');
  await symlink(sourceRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(importCadFileIntoProject(projectRoot, path.join(linkedRoot, 'drawing.dxf')), /符号链接|Junction/);
  assert.deepEqual(await readdir(projectRoot), []);
}));

for (const linkedDirectory of ['Assets', 'Cad']) {
  test(`拒绝项目 ${linkedDirectory} Junction 逃逸，保留外部文件`, () => fixture(async ({ root, projectRoot, sourceRoot }) => {
    const outsideRoot = path.join(root, 'outside');
    await mkdir(outsideRoot);
    await writeFile(path.join(outsideRoot, 'preserve.txt'), 'existing');
    if (linkedDirectory === 'Cad') await mkdir(path.join(projectRoot, 'Assets'));
    const target = linkedDirectory === 'Assets' ? path.join(projectRoot, 'Assets') : path.join(projectRoot, 'Assets', 'Cad');
    await symlink(outsideRoot, target, process.platform === 'win32' ? 'junction' : 'dir');
    const sourcePath = path.join(sourceRoot, 'drawing.dxf');
    await writeFile(sourcePath, 'drawing');
    await assert.rejects(importCadFileIntoProject(projectRoot, sourcePath), /符号链接|Junction/);
    assert.deepEqual(await readdir(outsideRoot), ['preserve.txt']);
    assert.equal(await readFile(path.join(outsideRoot, 'preserve.txt'), 'utf8'), 'existing');
  }));
}
