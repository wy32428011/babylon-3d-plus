import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after, before } from 'node:test';
import ts from 'typescript';

let fixtureRoot;
let readRegisteredSyncedImage;
let maxImageBytes;

before(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'synced-image-read-'));
  await fs.writeFile(path.join(fixtureRoot, 'package.json'), '{"type":"module"}');
  for (const name of ['editorAssetCacheHeaders', 'syncedImageRead']) {
    const source = await fs.readFile(new URL(`../../electron/ipc/${name}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    });
    await fs.writeFile(path.join(fixtureRoot, `${name}.js`), outputText);
  }
  const module = await import(pathToFileURL(path.join(fixtureRoot, 'syncedImageRead.js')).href);
  readRegisteredSyncedImage = module.readRegisteredSyncedImage;
  maxImageBytes = module.MAX_SYNCED_IMAGE_READ_BYTES;
});

after(async () => {
  if (fixtureRoot) {
    const target = path.resolve(fixtureRoot);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('synced-image-read-'));
    await fs.rm(target, { recursive: true, force: true });
  }
});

async function registerFile(iconKey, extension, content) {
  const filePath = path.join(fixtureRoot, `${iconKey}.${extension}`);
  await fs.writeFile(filePath, content);
  return {
    id: iconKey, iconKey, name: iconKey, updatedAt: '2026-09-03',
    fileName: path.basename(filePath), filePath,
    sourceUrl: 'https://unused.example/image.png', reference: `editor-image://platform/${iconKey}`,
  };
}

test('按当前登记引用读取真实图片文件，并返回全部图片库格式的 MIME 与字节', async () => {
  const fixtures = [
    ['PNG', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])],
    ['jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ['jpeg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ['webp', 'image/webp', Buffer.from('RIFF\0\0\0\0WEBP')],
    ['gif', 'image/gif', Buffer.from('GIF89a')],
    ['svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ];
  for (const [extension, contentType, expectedBytes] of fixtures) {
    const entry = await registerFile(`image_${extension.toLowerCase()}`, extension, expectedBytes);
    const actual = await readRegisteredSyncedImage(entry.reference, [entry]);
    assert.equal(actual.contentType, contentType);
    assert.ok(actual.bytes instanceof Uint8Array);
    assert.deepEqual(Buffer.from(actual.bytes), expectedBytes);
  }
});

test('未知引用和旧工作区引用拒绝读取，不回退到 sourceUrl', async () => {
  const first = await registerFile('workspace_first', 'png', Buffer.from('first'));
  const second = await registerFile('workspace_second', 'png', Buffer.from('second'));
  await assert.rejects(readRegisteredSyncedImage(first.reference, [second]), /未登记在当前图片库/);
  await assert.rejects(readRegisteredSyncedImage('editor-image://platform/missing', [first]), /未登记在当前图片库/);
});

test('路径、URL、编码穿越、空白和非字符串均不能冒充图片引用', async () => {
  const entry = await registerFile('valid_image', 'png', Buffer.from('valid'));
  for (const reference of [
    entry.filePath, entry.sourceUrl, 'editor-asset://local/encoded',
    'editor-image://platform/../valid_image', 'editor-image://platform/%2e%2e',
    `${entry.reference} `, '', null, { reference: entry.reference }, 7,
  ]) {
    await assert.rejects(readRegisteredSyncedImage(reference, [entry]), /引用格式不正确/);
  }
});

test('未知扩展名和相对登记路径被拒绝', async () => {
  const entry = await registerFile('invalid_type', 'txt', Buffer.from('private'));
  await assert.rejects(readRegisteredSyncedImage(entry.reference, [entry]), /格式或登记路径不受支持/);
  await assert.rejects(readRegisteredSyncedImage(entry.reference, [{ ...entry, filePath: './valid_image.png' }]), /格式或登记路径不受支持/);
});

test('空文件、目录和超出 20 MiB 的文件被拒绝，限制以内完整读取', async () => {
  const empty = await registerFile('empty_file', 'png', Buffer.alloc(0));
  await assert.rejects(readRegisteredSyncedImage(empty.reference, [empty]), /非空文件/);
  const directory = { ...empty, filePath: path.join(fixtureRoot, 'directory.png') };
  await fs.mkdir(directory.filePath);
  await assert.rejects(readRegisteredSyncedImage(directory.reference, [directory]));

  const large = await registerFile('large_file', 'png', Buffer.alloc(0));
  await fs.truncate(large.filePath, maxImageBytes + 1);
  await assert.rejects(readRegisteredSyncedImage(large.reference, [large]), /不能超过 20 MiB/);
  await fs.truncate(large.filePath, maxImageBytes);
  const accepted = await readRegisteredSyncedImage(large.reference, [large]);
  assert.equal(accepted.bytes.length, maxImageBytes);
});

test('登记文件已删除时返回读取错误，不能悄悄抓取远程地址', async () => {
  const entry = await registerFile('deleted_file', 'png', Buffer.from('temporary'));
  await fs.unlink(entry.filePath);
  await assert.rejects(readRegisteredSyncedImage(entry.reference, [entry]), { code: 'ENOENT' });
});

test('开发与打包 preload 同步暴露单一 reference API，IPC 限制主 frame 并读取当前登记表', async () => {
  for (const preload of ['preload.ts', 'preload.cts']) {
    const source = await fs.readFile(new URL(`../../electron/${preload}`, import.meta.url), 'utf8');
    assert.match(source, /readSyncedImage: \(reference: string\): Promise<SyncedImageReadResult> => ipcRenderer.invoke\('data-platform:readSyncedImage', reference\)/);
  }
  const ipc = await fs.readFile(new URL('../../electron/ipc/dataPlatformIpc.ts', import.meta.url), 'utf8');
  const handler = ipc.slice(ipc.indexOf("'data-platform:readSyncedImage'"), ipc.indexOf("ipcMain.handle('data-platform:syncCharts'"));
  assert.match(handler, /!event.senderFrame \|\| event.senderFrame !== event.sender.mainFrame/);
  assert.match(handler, /listSyncedImagesForWorkspace\(config.workspaceRoot\)/);
  assert.match(handler, /readRegisteredSyncedImage\(reference, images\)/);
});
