import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './deploymentExportFileSystem.js' && context.parentURL?.endsWith('/deploymentPrecompiledScripts.ts')) {
    return nextResolve(new URL('./deploymentExportFileSystem.ts', context.parentURL).href, context);
  }
  return nextResolve(specifier, context);
} });
const [{ writePrecompiledDeploymentScripts }, { copyDeploymentFiles }] = await Promise.all([
  import('../../electron/ipc/deploymentPrecompiledScripts.ts'),
  import('../../electron/ipc/deploymentExportFileSystem.ts'),
]);
hooks.deregister();
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const signal = () => new AbortController().signal;

async function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployment-compiled-script-'));
  t.after(async () => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('deployment-compiled-script-')) throw new Error('测试临时目录范围无效');
    await fs.rm(root, { recursive: true, force: true });
  });
  const sourcePath = path.join(root, 'source', 'model.model.ts');
  const stagingRoot = path.join(root, 'staging');
  const bytes = Buffer.from('\ufeffexport const label: string = "原始源码";\n', 'utf8');
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, bytes);
  const stat = await fs.stat(sourcePath);
  const source = { sourcePath, relativePath: 'model.model.ts', size: bytes.length, mtimeMs: stat.mtimeMs,
    destinationRelativePath: 'project/assets/pump/model.model.ts', kind: 'script' as const, logicalUrl: 'model-assets/pump/model.model.ts' };
  const script = { sourcePath, sourceFileSha256: sha256(bytes), destinationRelativePath: `${source.destinationRelativePath}.compiled.json`,
    logicalUrl: `${source.logicalUrl}.compiled.json`, content: JSON.stringify({ version: 1, code: 'export const label = "派生产物";' }) + '\n' };
  const copiedAssets = await copyDeploymentFiles([source], stagingRoot, 1, signal(), () => {});
  return { root, sourcePath, stagingRoot, bytes, source, script, copiedAssets };
}

test('sidecar 绑定包含 BOM 的真实源码字节，并返回最终 UTF-8 大小、哈希与资源地址', async t => {
  const f = await fixture(t);
  assert.notEqual(sha256(f.bytes), sha256(f.bytes.toString('utf8').replace(/^\ufeff/, '')));
  const [result] = await writePrecompiledDeploymentScripts(f.stagingRoot, [f.script], f.copiedAssets, signal());
  const written = await fs.readFile(path.join(f.stagingRoot, f.script.destinationRelativePath));
  assert.equal(written.toString('utf8'), f.script.content);
  assert.equal(result.size, written.byteLength);
  assert.equal(result.sha256, sha256(written));
  assert.equal(result.logicalUrl, f.script.logicalUrl);
  assert.equal(result.destinationRelativePath, f.script.destinationRelativePath);
  assert.equal(result.kind, 'script');
  assert.deepEqual(await fs.readFile(path.join(f.stagingRoot, f.source.destinationRelativePath)), f.bytes);
  assert.deepEqual(await fs.readFile(f.sourcePath), f.bytes);
});

test('预编译后源码发生变化或没有复制源码时拒绝写入', async t => {
  const f = await fixture(t);
  await assert.rejects(writePrecompiledDeploymentScripts(f.stagingRoot, [{ ...f.script, sourceFileSha256: sha256('changed') }], f.copiedAssets, signal()), /SHA-256/);
  await assert.rejects(writePrecompiledDeploymentScripts(f.stagingRoot, [f.script], [], signal()), /未列入已复制资源/);
  await assert.rejects(fs.stat(path.join(f.stagingRoot, f.script.destinationRelativePath)), { code: 'ENOENT' });
});

test('sidecar 地址必须逐字绑定复制源码路径和 logicalUrl，不接受改名或目录逃逸', async t => {
  const f = await fixture(t);
  for (const patch of [
    { destinationRelativePath: 'project/assets/another.compiled.json' },
    { destinationRelativePath: '../outside.compiled.json' },
    { destinationRelativePath: `${f.source.destinationRelativePath}.COMPILED.JSON` },
    { logicalUrl: 'model-assets/another.compiled.json' },
  ]) {
    await assert.rejects(writePrecompiledDeploymentScripts(f.stagingRoot, [{ ...f.script, ...patch }], f.copiedAssets, signal()), /路径或 logicalUrl/);
  }
  const escaping = { ...f.copiedAssets[0], destinationRelativePath: '../outside.ts' };
  await assert.rejects(writePrecompiledDeploymentScripts(f.stagingRoot,
    [{ ...f.script, destinationRelativePath: '../outside.ts.compiled.json' }], [escaping], signal()), /逃逸/);
  await assert.rejects(fs.stat(path.join(f.stagingRoot, f.script.destinationRelativePath)), { code: 'ENOENT' });
});

test('重复一致只写一次，重复内容冲突在写入前拒绝', async t => {
  const f = await fixture(t);
  await assert.rejects(writePrecompiledDeploymentScripts(f.stagingRoot,
    [f.script, { ...f.script, content: '{"different":true}' }], f.copiedAssets, signal()), /重复.*冲突/);
  await assert.rejects(fs.stat(path.join(f.stagingRoot, f.script.destinationRelativePath)), { code: 'ENOENT' });
  const written = await writePrecompiledDeploymentScripts(f.stagingRoot, [f.script, { ...f.script }], f.copiedAssets, signal());
  assert.equal(written.length, 1);
  assert.equal((await fs.readdir(path.dirname(written[0].sourcePath))).length, 2);
});

test('不覆盖已有文件，并拒绝资产清单路径或 logicalUrl 冲突', async t => {
  const f = await fixture(t);
  const target = path.join(f.stagingRoot, f.script.destinationRelativePath);
  await fs.writeFile(target, 'keep');
  await assert.rejects(writePrecompiledDeploymentScripts(f.stagingRoot, [f.script], f.copiedAssets, signal()), { code: 'EEXIST' });
  assert.equal(await fs.readFile(target, 'utf8'), 'keep');
  for (const patch of [{ destinationRelativePath: f.script.destinationRelativePath }, { logicalUrl: f.script.logicalUrl }]) {
    const occupied = { ...f.copiedAssets[0], sourcePath: path.join(f.root, 'other'), destinationRelativePath: 'project/assets/other.json',
      logicalUrl: 'model-assets/other.json', ...patch };
    await assert.rejects(writePrecompiledDeploymentScripts(f.stagingRoot, [f.script], [...f.copiedAssets, occupied], signal()), /现有部署资源冲突/);
  }
});

test('原 TS 的 SOURCE/DIST 大小和 SHA-256 绑定仍由真实资源复制路径严格执行', async t => {
  const f = await fixture(t);
  const changed = Buffer.from(f.bytes);
  changed[changed.length - 2] ^= 1;
  await fs.writeFile(f.sourcePath, changed);
  const stat = await fs.stat(f.sourcePath);
  const plan = { ...f.source, mtimeMs: stat.mtimeMs, expectedSize: f.bytes.length, expectedSha256: sha256(f.bytes) };
  await assert.rejects(copyDeploymentFiles([plan], path.join(f.root, 'changed-copy'), 1, signal(), () => {}), /SHA-256/);
  await assert.rejects(copyDeploymentFiles([{ ...plan, expectedSize: f.bytes.length + 1, expectedSha256: undefined }],
    path.join(f.root, 'wrong-size-copy'), 1, signal(), () => {}), /复制大小与预期不一致/);
});

test('已取消的导出不写 sidecar', async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(writePrecompiledDeploymentScripts(f.stagingRoot, [f.script], f.copiedAssets, controller.signal), { name: 'AbortError' });
  await assert.rejects(fs.stat(path.join(f.stagingRoot, f.script.destinationRelativePath)), { code: 'ENOENT' });
});
