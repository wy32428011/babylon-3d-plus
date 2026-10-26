import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { SkyboxDerivedAssetStore } from '../../electron/ipc/skyboxDerivedAssetStore.ts';
import { skyboxEnvironmentFixture, skyboxHdrFixture } from '../helpers/skyboxEnvironmentFixture.mjs';

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skybox-derived-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.hdr'), raw = skyboxHdrFixture();
  await writeFile(sourcePath, raw);
  const authorized = new Set([sourcePath]); let current = true;
  const encodeUrl = (file: string) => `editor-asset://local/${encodeURIComponent(file)}`;
  const openStore = (cacheBudgetBytes?: number) => new SkyboxDerivedAssetStore({ rootDirectory: root, cacheRoot: path.join(root, '.babylon-editor', 'skybox-derived'),
    isAuthorizedFile: file => authorized.has(file), encodeUrl, decodeUrl: url => decodeURIComponent(new URL(url).pathname.slice(1)),
    authorizeFile: file => { authorized.add(file); }, isCurrent: () => current, cacheBudgetBytes });
  const store = openStore();
  const source = { sourcePath, sourceUrl: encodeUrl(sourcePath), format: 'hdr' as const,
    assetRevision: createHash('sha256').update(raw).digest('hex'), resolution: 256 as const };
  return { root, store, openStore, source, raw, authorized, switchProject: () => { current = false; } };
}

test('源文件保持不变，ENV 原子提交后按源内容与配方复用', async t => {
  const f = await fixture(t), bytes = skyboxEnvironmentFixture();
  const ticket = await f.store.prepare(f.source, 7);
  assert.ok(ticket.token); assert.equal(ticket.environment, null);
  const env = await f.store.commit(ticket.token, 7, bytes);
  assert.equal(env.sourceSha256, f.source.assetRevision);
  assert.equal(env.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.notEqual(env.sha256, env.sourceSha256);
  assert.deepEqual(await readFile(f.source.sourcePath), f.raw);
  assert.deepEqual(await readFile(env.sourcePath!), bytes);
  assert.equal(f.authorized.has(env.sourcePath!), true);
  const cached = await f.store.prepare(f.source, 7);
  assert.equal(cached.token, null); assert.equal(cached.environment?.sha256, env.sha256);
});

test('窗口身份、取消和项目代次阻止迟到提交', async t => {
  const f = await fixture(t), bytes = skyboxEnvironmentFixture();
  const a = await f.store.prepare(f.source, 1);
  await assert.rejects(f.store.commit(a.token!, 2, bytes), /不属于/);
  assert.equal(f.store.cancel(a.token!, 2), false);
  assert.equal(f.store.cancel(a.token!, 1), true);
  await assert.rejects(f.store.commit(a.token!, 1, bytes), /失效/);
  const b = await f.store.prepare(f.source, 1);
  f.switchProject();
  await assert.rejects(f.store.commit(b.token!, 1, bytes), /切换/);
});

test('源 SHA 不匹配、转换期间源变化和畸形 ENV 明确失败', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.prepare({ ...f.source, assetRevision: 'b'.repeat(64) }, 1), /修订/);
  const ticket = await f.store.prepare(f.source, 1);
  await assert.rejects(f.store.commit(ticket.token!, 1, new Uint8Array(16)), /文件头/);
  await writeFile(f.source.sourcePath, skyboxHdrFixture(180));
  await assert.rejects(f.store.commit(ticket.token!, 1, skyboxEnvironmentFixture()), /修订|变化/);
});

test('损坏派生文件重新准备，不删除或改写源资产', async t => {
  const f = await fixture(t);
  const ticket = await f.store.prepare(f.source, 1);
  const env = await f.store.commit(ticket.token!, 1, skyboxEnvironmentFixture());
  await writeFile(env.sourcePath!, 'corrupted');
  const retry = await f.store.prepare(f.source, 1);
  assert.ok(retry.token); assert.equal(retry.environment, null);
  const repaired = await f.store.commit(retry.token!, 1, skyboxEnvironmentFixture());
  assert.deepEqual(await readFile(repaired.sourcePath!), skyboxEnvironmentFixture());
  assert.deepEqual(await readFile(f.source.sourcePath), f.raw);
});

test('源文件未授权和派生根目录越界不产生写入', async t => {
  const f = await fixture(t);
  const unknown = path.join(f.root, 'unknown.hdr'); await writeFile(unknown, f.raw);
  await assert.rejects(f.store.prepare({ ...f.source, sourcePath: unknown }, 1), /未经过/);
  const parent = await mkdtemp(path.join(os.tmpdir(), 'skybox-derived-boundary-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'root'); await mkdir(root);
  const outside = new SkyboxDerivedAssetStore({ rootDirectory: root, cacheRoot: path.join(parent, 'escape'),
    isAuthorizedFile: () => true, encodeUrl: file => `editor-asset://local/${encodeURIComponent(file)}`, decodeUrl: () => unknown, authorizeFile() {} });
  await assert.rejects(outside.prepare(f.source, 1), /超出/);
});

test('旧受控URL源路径可生成ENV；运行包仅允许验证本地授权的ENV', async t => {
  const f = await fixture(t), bytes = skyboxEnvironmentFixture();
  const ticket = await f.store.prepare({ ...f.source, sourcePath: f.source.sourceUrl }, 1);
  const env = await f.store.commit(ticket.token!, 1, bytes);
  const verified = await f.store.prepare({ ...f.source, sourceAvailable: false, sourcePath: '', sourceUrl: '', environment: env }, 1);
  assert.equal(verified.environment?.sha256, env.sha256);
  await assert.rejects(f.store.prepare({ ...f.source, sourceAvailable: false, sourcePath: '', sourceUrl: '',
    environment: { ...env, sourcePath: undefined, sourceUrl: 'https://external.invalid/sky.env' } }, 1), /授权/);
});

test('prepare后将派生目录改成指向同工程模型包的Junction，commit拒绝且不覆盖manifest', async t => {
  const f = await fixture(t), bytes = skyboxEnvironmentFixture();
  const ticket = await f.store.prepare(f.source, 1);
  const recipe = createHash('sha256').update(`${ticket.recipeKey}:256`).digest('hex').slice(0, 24);
  const folder = path.join(f.root, '.babylon-editor', 'skybox-derived', ticket.sourceSha256, recipe);
  const model = path.join(f.root, 'Assets', 'Models', 'protected');
  await mkdir(model, { recursive: true });
  await writeFile(path.join(model, 'manifest.json'), 'original-model-manifest');
  await mkdir(path.dirname(folder), { recursive: true });
  await symlink(model, folder, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(f.store.commit(ticket.token!, 1, bytes), /Junction|junction|链接/);
    assert.equal(await readFile(path.join(model, 'manifest.json'), 'utf8'), 'original-model-manifest');
  } finally { await unlink(folder); }
});

test('超预算时保留本会话租约，重开后仅回收历史派生文件，原图不变', async t => {
  const f = await fixture(t), bytes = skyboxEnvironmentFixture();
  f.store.dispose();
  const store = f.openStore(bytes.length);
  const first = await store.prepare(f.source, 1), env = await store.commit(first.token!, 1, bytes);
  const otherPath = path.join(f.root, 'second.hdr'), otherBytes = skyboxHdrFixture(180);
  await writeFile(otherPath, otherBytes); f.authorized.add(otherPath);
  const secondSource = { ...f.source, sourcePath: otherPath, sourceUrl: `editor-asset://local/${encodeURIComponent(otherPath)}`,
    assetRevision: createHash('sha256').update(otherBytes).digest('hex') };
  const second = await store.prepare(secondSource, 1);
  await assert.rejects(store.commit(second.token!, 1, bytes), /租约/);
  assert.deepEqual(await readFile(env.sourcePath!), bytes);
  store.dispose();
  const reopened = f.openStore(bytes.length);
  const next = await reopened.prepare(secondSource, 1);
  await reopened.commit(next.token!, 1, bytes);
  await assert.rejects(readFile(env.sourcePath!), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.source.sourcePath), f.raw);
  assert.deepEqual(await readFile(otherPath), otherBytes);
});
