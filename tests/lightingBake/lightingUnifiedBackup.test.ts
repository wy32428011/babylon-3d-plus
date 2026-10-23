import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { preserveLegacyLightingSceneBeforeWrite } from '../../electron/ipc/sceneLightingMigrationSave.ts';

const next = JSON.stringify({ version: 5, scene: { sceneSettings: { lighting: { version: 2 } } } });
async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-unified-backup-'));
  t.after(async () => {
    if (!path.basename(root).startsWith('lighting-unified-backup-') || path.dirname(root) !== os.tmpdir()) throw new Error('备份测试目录越界');
    await fs.rm(root, { recursive: true, force: true });
  });
  return path.join(root, 'legacy.scene.json');
}

test('首次覆盖旧场景前逐字节备份，备份本身不改原文件', async t => {
  const file = await fixture(t);
  const original = Buffer.from('\ufeff{\r\n  "version": 5, "scene": {"sceneSettings": {"shadows": {"mode": "baked"}}, "custom": false}\r\n}\r\n');
  await fs.writeFile(file, original);
  const backup = await preserveLegacyLightingSceneBeforeWrite(file, next);
  assert.ok(backup);
  assert.deepEqual(await fs.readFile(backup), original);
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal(await preserveLegacyLightingSceneBeforeWrite(file, next), backup);
  await fs.writeFile(file, next);
  assert.equal(await preserveLegacyLightingSceneBeforeWrite(file, next), null);
});

test('新文件和已有统一配置不创建迁移备份', async t => {
  const file = await fixture(t);
  assert.equal(await preserveLegacyLightingSceneBeforeWrite(file, next), null);
  await fs.writeFile(file, next);
  assert.equal(await preserveLegacyLightingSceneBeforeWrite(file, next), null);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['legacy.scene.json']);
});

test('备份目标被不同内容占用时拒绝覆盖，并保留旧文件', async t => {
  const file = await fixture(t), original = Buffer.from('{"version":5,"scene":{"sceneSettings":{"theme":null}}}');
  await fs.writeFile(file, original);
  const hash = createHash('sha256').update(original).digest('hex').slice(0, 12);
  const backup = file + '.before-lighting-v2.' + hash + '.bak';
  await fs.writeFile(backup, '占用备份');
  await assert.rejects(preserveLegacyLightingSceneBeforeWrite(file, next), /备份|内容|占用/);
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal(await fs.readFile(backup, 'utf8'), '占用备份');
});
