import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ appType: 'custom', configFile: false,
  server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true } });
after(() => server.close());
const { copyManualRoamAvatarWithAdaptation } = await server.ssrLoadModule('/electron/ipc/manualRoamAvatarAdaptation.ts');

type GlbDocument = Record<string, unknown> & { nodes: Array<Record<string, unknown> & { extras?: Record<string, unknown> }> };
function parseGlb(bytes: Buffer): { json: GlbDocument; tail: Buffer } {
  const length = bytes.readUInt32LE(12);
  return { json: JSON.parse(bytes.subarray(20, 20 + length).toString().trimEnd()), tail: bytes.subarray(20 + length) };
}
function createGlb(json: unknown, tail = Buffer.alloc(0)): Buffer {
  const content = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([content, Buffer.alloc((4 - content.length % 4) % 4, 32)]);
  const header = Buffer.alloc(20);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + padded.length + tail.length, 8);
  header.writeUInt32LE(padded.length, 12); header.write('JSON', 16);
  return Buffer.concat([header, padded, tail]);
}
async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'roam-avatar-import-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('普通 Mixamo GLB 自动嵌入可保存适配数据，并完整保留外观、蒙皮、动画及未知 chunk', async () => {
  await withDirectory(async directory => {
    const original = await readFile(new URL('../../scripts/manual-roam-assets/sources/Xbot.glb', import.meta.url));
    const { json, tail } = parseGlb(original);
    json.extras = { author: '保留未知元数据' };
    json.nodes.forEach(node => { node.extras = { ...(node.extras ?? {}), sourceTag: '保留各节点元数据' }; });
    const unknownChunk = Buffer.alloc(12);
    unknownChunk.writeUInt32LE(4, 0); unknownChunk.write('TEST', 4); unknownChunk.writeUInt32LE(0x76543210, 8);
    const source = createGlb(json, Buffer.concat([tail, unknownChunk]));
    const sourcePath = path.join(directory, 'source.glb');
    const targetPath = path.join(directory, 'adapted.glb');
    await writeFile(sourcePath, source);
    await copyManualRoamAvatarWithAdaptation(sourcePath, targetPath);

    const adapted = await readFile(targetPath);
    const { json: result, tail: adaptedTail } = parseGlb(adapted);
    assert.equal(adapted.readUInt32LE(8), adapted.length);
    const marked = result.nodes.filter(node => node.extras?.manualRoamHumanoid);
    assert.equal(marked.length, 1, '只在一个骨架根节点保存适配声明');
    const metadata = marked[0].extras!.manualRoamHumanoid as Record<string, unknown>;
    assert.equal(metadata.version, 1);
    assert.equal(metadata.motionProfile, 'mixamo-humanoid-v2');
    assert.equal(Object.keys(metadata.joints as object).length, 22);
    assert.equal(metadata.sourceHash, createHash('sha256').update(source).digest('hex'));
    assert.deepEqual(adaptedTail, Buffer.concat([tail, unknownChunk]), 'BIN 中的顶点、权重、inverse bind 和未知 chunk 必须原字节保留');
    const originalRoot = json.nodes[result.nodes.indexOf(marked[0])];
    if (originalRoot.extras) marked[0].extras = originalRoot.extras; else delete marked[0].extras;
    assert.deepEqual(result, json, '除适配元数据外不改节点、材质、动画或蒙皮定义');
    assert.deepEqual(await readFile(sourcePath), source, '用户源文件不应被修改');
    const reimportedPath = path.join(directory, 'reimported.glb');
    await copyManualRoamAvatarWithAdaptation(targetPath, reimportedPath);
    assert.deepEqual(await readFile(reimportedPath), adapted, '已适配人物重复导入保持指纹和内容稳定');
  });
});

test('复制期间源文件变化会明确失败并清理未完成的派生人物', async t => {
  await withDirectory(async directory => {
    const source = path.join(directory, 'source.glb');
    const target = path.join(directory, 'partial.glb');
    await writeFile(source, await readFile(new URL('../../scripts/manual-roam-assets/sources/Xbot.glb', import.meta.url)));
    const originalOpen = fs.open.bind(fs);
    let changed = false;
    t.mock.method(fs, 'open', async (filePath: string, flags: string) => {
      const handle = await originalOpen(filePath, flags);
      if (filePath === source) {
        const originalRead = handle.read.bind(handle);
        t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await originalRead(buffer, offset, length, position);
          if (position > 20 && !changed) {
            changed = true;
            await fs.utimes(source, new Date(), new Date(Date.now() + 60_000));
          }
          return result;
        });
      }
      return handle;
    });
    await assert.rejects(copyManualRoamAvatarWithAdaptation(source, target), /复制期间已发生变化/);
    assert.deepEqual(await readdir(directory), ['source.glb']);
  });
});

test('已有 v2 人物、静态人物以及不支持的骨架继续保留原始导入行为', async () => {
  await withDirectory(async directory => {
    const existing = await readFile(new URL('../../public/manual-roam/EQ_People_rigged_v2.glb', import.meta.url));
    const original = parseGlb(await readFile(new URL('../../scripts/manual-roam-assets/sources/Xbot.glb', import.meta.url)));
    original.json.nodes.forEach((node, index) => { node.name = `unknown_joint_${index}`; });
    const unsupported = createGlb(original.json, original.tail);
    const staticModel = createGlb({ asset: { version: '2.0' }, meshes: [{ primitives: [{}] }], nodes: [{ mesh: 0 }] });
    for (const [index, source] of [existing, unsupported, staticModel].entries()) {
      const sourcePath = path.join(directory, `${index}.glb`);
      const targetPath = path.join(directory, `${index}-copy.glb`);
      await writeFile(sourcePath, source);
      await copyManualRoamAvatarWithAdaptation(sourcePath, targetPath);
      assert.deepEqual(await readFile(targetPath), source);
    }
  });
});

test('目标已存在时不覆盖，且损坏输入不会留下半份人物资源', async () => {
  await withDirectory(async directory => {
    const source = path.resolve('scripts/manual-roam-assets/sources/Xbot.glb');
    const target = path.join(directory, 'existing.glb');
    const existing = Buffer.from('已有资源必须保留');
    await writeFile(target, existing);
    await assert.rejects(copyManualRoamAvatarWithAdaptation(source, target), /EEXIST/);
    assert.deepEqual(await readFile(target), existing);
    const broken = path.join(directory, 'broken.glb');
    await writeFile(broken, 'invalid');
    await assert.rejects(copyManualRoamAvatarWithAdaptation(broken, path.join(directory, 'partial.glb')), /GLB/);
    assert.deepEqual((await readdir(directory)).sort(), ['broken.glb', 'existing.glb']);
  });
});
