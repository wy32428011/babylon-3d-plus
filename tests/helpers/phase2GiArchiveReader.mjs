import assert from 'node:assert/strict';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import unzipper from 'unzipper';

function key(value) {
  const name = value.replaceAll('\\', '/').replace(/^\.\//, '');
  assert.ok(!name.includes('\0') && !name.startsWith('/') && !/^[a-z]:/i.test(name) && !name.split('/').includes('..'), '资源路径越界');
  return name;
}
const missing = name => Object.assign(new Error('GI归档缺少资源：' + name), { code: 'ENOENT' });

/** 本地验收从原ZIP流式服务原字节，避免大型GI为SOURCE/DIST各留一份无必要解压副本。 */
export async function openGiArtifactReader(root) {
  const info = await fs.stat(root);
  if (info.isDirectory()) {
    const realRoot = await fs.realpath(root), inside = file => { const relative = path.relative(realRoot, file); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); };
    const resolve = async name => { const file = await fs.realpath(path.resolve(realRoot, key(name))); assert.ok(inside(file)); return file; };
    return { kind: 'directory',
      read: async name => fs.readFile(await resolve(name)),
      list: async directory => fs.readdir(await resolve(directory)),
      describe: async name => { const file = await resolve(name), stat = await fs.stat(file); assert.ok(stat.isFile()); return { size: stat.size, stream: () => createReadStream(file) }; } };
  }
  assert.ok(info.isFile() && /\.zip$/i.test(root));
  const archive = await unzipper.Open.file(root), files = new Map(), names = new Set(); let unpackedBytes = 0;
  assert.ok(archive.files.length <= 100000);
  for (const entry of archive.files) {
    const name = key(entry.path), folded = name.replace(/\/$/, '').toLowerCase();
    assert.ok(!names.has(folded), '归档重复或大小写歧义路径'); names.add(folded);
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
    assert.ok(mode === 0 || mode === 0x8000 || mode === 0x4000, '归档不能包含链接或设备');
    assert.ok(['File', 'Directory'].includes(entry.type));
    if (entry.type === 'File') {
      assert.ok(Number.isSafeInteger(entry.uncompressedSize) && entry.uncompressedSize >= 0);
      unpackedBytes += entry.uncompressedSize; assert.ok(unpackedBytes <= 2 * 1024 ** 3);
      files.set(name, entry);
    }
  }
  const entry = name => { const result = files.get(key(name)); if (!result) throw missing(name); return result; };
  return { kind: 'zip', archiveEntries: archive.files.length, unpackedBytes,
    read: async name => { const value = entry(name), bytes = await value.buffer(); assert.equal(bytes.length, value.uncompressedSize); return bytes; },
    list: async directory => { const prefix = key(directory).replace(/\/$/, '') + '/'; return [...files.keys()].filter(name => name.startsWith(prefix) && !name.slice(prefix.length).includes('/')).map(name => name.slice(prefix.length)); },
    describe: async name => { const value = entry(name); return { size: value.uncompressedSize, stream: () => value.stream() }; } };
}
