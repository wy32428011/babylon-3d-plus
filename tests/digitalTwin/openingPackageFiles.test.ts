import assert from 'node:assert/strict';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { ZipArchive } from 'archiver';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (existsSync(fileURLToPath(url))) return next(url.href, context);
  }
  return next(specifier, context);
} });
const { extractOpeningPackageArchive, inspectOpeningPackageFiles } = await import('../../electron/ipc/openingPackageFiles.ts');

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'opening-package-files-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function zip(root: string, entries: Array<[string, string | Buffer]>) {
  const file = path.join(root, 'test.zip'), archive = new ZipArchive({ zlib: { level: 1 } });
  const completed = pipeline(archive, createWriteStream(file));
  for (const [name, value] of entries) archive.append(value, { name });
  await Promise.all([archive.finalize(), completed]);
  return file;
}

test('开场 ZIP 保留纯数据与包内素材，并为每个真实文件计算稳定 SHA-256', async () => fixture(async root => {
  const target = path.join(root, 'unpacked');
  const archive = await zip(root, [['manifest.json', '{}'], ['assets/map.webp', Buffer.from([1, 2, 3])]]);
  await extractOpeningPackageArchive(archive, target);
  const files = await inspectOpeningPackageFiles(target);
  assert.deepEqual(files.map(file => file.relativePath), ['assets/map.webp', 'manifest.json']);
  assert.ok(files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.deepEqual(await readFile(path.join(target, 'assets/map.webp')), Buffer.from([1, 2, 3]));
  assert.deepEqual((await inspectOpeningPackageFiles(target)).map(file => file.sha256), files.map(file => file.sha256));
}));

test('禁止开场包脚本、HTML、大小写冲突和 Windows 设备文件名，失败不留下文件', async () => {
  for (const entries of [
    [['assets/renderer.js', 'alert(1)']], [['assets/index.html', '<script/>']],
    [['manifest.json', '{}'], ['MANIFEST.json', '{}']], [['assets/con.png', 'bad']],
    [['assets/map.webp.', 'bad']], [['assets/a:b.png', 'bad']],
  ] as Array<Array<[string, string]>>) await fixture(async root => {
    const target = path.join(root, 'unpacked');
    await assert.rejects(extractOpeningPackageArchive(await zip(root, entries), target), /开场包/);
    await assert.rejects(readFile(path.join(target, entries[0][0])));
  });
});

test('包目录中添加脚本或符号链接后再次发布校验失败', async () => fixture(async root => {
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'assets/runtime.js'), 'export default 1');
  await assert.rejects(inspectOpeningPackageFiles(root), /开场包/);
}));

test('取消导入与 JSON 文件大小限制在读取前生效', async () => fixture(async root => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractOpeningPackageArchive(path.join(root, 'absent.zip'), path.join(root, 'out'), controller.signal));
  await writeFile(path.join(root, 'manifest.json'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(inspectOpeningPackageFiles(root), /开场包.*JSON/);
}));

test('SVG 只允许静态绘图及本文件片段引用，主动内容与编码绕过均拒绝', async () => {
  const safe = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><text x="1" y="2">中文 &amp; text</text></svg>';
  await fixture(async root => { await mkdir(path.join(root, 'assets')); await writeFile(path.join(root, 'assets/map.svg'), safe); assert.equal((await inspectOpeningPackageFiles(root)).length, 1); });
  for (const unsafe of [
    '<svg><script>alert(1)</script></svg>', '<svg><foreignObject/></svg>', '<svg onload="alert(1)"/>',
    '<svg><use href="https://remote.test/a.svg"/></svg>', '<svg><rect fill="url(https://remote.test/a.svg)"/></svg>',
    '<svg><rect style="fill:red"/></svg>', '<!DOCTYPE svg><svg/>', '<svg xmlns:x="http://evil.test"/>',
    '<svg><use href="&#35;id"/></svg>', '<svg><animate attributeName="href"/></svg>',
  ]) await fixture(async root => { await mkdir(path.join(root, 'assets')); await writeFile(path.join(root, 'assets/map.svg'), unsafe); await assert.rejects(inspectOpeningPackageFiles(root), /开场包.*SVG/); });
});

test('原始 ZIP 目录项中的父路径和符号链接在落盘前拒绝', async () => {
  for (const mode of ['traversal', 'symlink']) await fixture(async root => {
    const file = await zip(root, [['assets/a.png', 'image']]);
    const bytes = await readFile(file);
    if (mode === 'traversal') {
      const from = Buffer.from('assets/a.png'), to = Buffer.from('../hackx.png'); assert.equal(from.length, to.length);
      let offset = bytes.indexOf(from);
      while (offset >= 0) { to.copy(bytes, offset); offset = bytes.indexOf(from, offset + from.length); }
    } else {
      const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); assert.ok(central >= 0);
      bytes.writeUInt32LE((0xa1ff * 0x10000) >>> 0, central + 38);
    }
    await writeFile(file, bytes);
    await assert.rejects(extractOpeningPackageArchive(file, path.join(root, 'out')), /开场包/);
    await assert.rejects(readFile(path.join(root, 'hackx.png')));
  });
});
