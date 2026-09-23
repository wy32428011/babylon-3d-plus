import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublishedReleaseStorageIdentity, assessPublishedReleaseCapacity, isPublishedReleaseCleanupCandidate, isPublishedReleaseComplete } from '../../src/player/publishedReleaseStorage.ts';

test('存储身份由地址与发布版本 SHA-256 确定，同项目不同 release 可归组且不会跨项目', async () => {
  const first = await createPublishedReleaseStorageIdentity('https://example.test/digital-twin/releases/42/7/', 'a');
  assert.match(first.databaseName, /^zending-published-release-v1-[a-f0-9]{64}$/);
  assert.deepEqual(await createPublishedReleaseStorageIdentity(first.baseUrl, 'a'), first);
  const next = await createPublishedReleaseStorageIdentity('https://example.test/digital-twin/releases/42/8/', 'b');
  const other = await createPublishedReleaseStorageIdentity('https://example.test/digital-twin/releases/43/7/', 'a');
  assert.equal(next.projectKey, first.projectKey);
  assert.notEqual(next.databaseName, first.databaseName);
  assert.notEqual(other.projectKey, first.projectKey);
  assert.equal(first.responseCacheName, `zending-published-response:v1:${encodeURIComponent(first.baseUrl)}:a`);
});

test('存储根地址拒绝查询参数、凭据与非目录，不为模糊地址合并项目', async () => {
  for (const base of ['https://u:p@example.test/viewer/', 'https://example.test/viewer/?v=1', 'https://example.test/viewer']) {
    await assert.rejects(createPublishedReleaseStorageIdentity(base, 'a'), /地址/);
  }
  const first = await createPublishedReleaseStorageIdentity('https://example.test/a/', 'one');
  const second = await createPublishedReleaseStorageIdentity('https://example.test/b/', 'two');
  assert.notEqual(first.projectKey, second.projectKey);
});

test('配额按尚缺内容加元信息余量准入，已缓存部分与完整版本不重复要求一整包空间', () => {
  assert.equal(assessPublishedReleaseCapacity(1000, 0, { quota: 2000, usage: 1500 }).admitted, false);
  assert.equal(assessPublishedReleaseCapacity(1000, 600, { quota: 2000, usage: 1500 }).admitted, true);
  assert.equal(assessPublishedReleaseCapacity(1000, 1000, { quota: 2000, usage: 2000 }).admitted, true);
  assert.equal(assessPublishedReleaseCapacity(1000, 1000, undefined).admitted, true);
  assert.equal(assessPublishedReleaseCapacity(1000, 999, undefined).admitted, false);
  assert.equal(assessPublishedReleaseCapacity(1000, 999, { quota: NaN, usage: 0 }).admitted, false);
});

test('清理策略仅允许同项目超过七天的其他版本，时钟回拨与无 Locks 都保留', async () => {
  const now = 1_000_000_000;
  const current = await createPublishedReleaseStorageIdentity('https://example.test/digital-twin/releases/42/8/', 'b');
  const old = await createPublishedReleaseStorageIdentity('https://example.test/digital-twin/releases/42/7/', 'a');
  const other = await createPublishedReleaseStorageIdentity('https://example.test/digital-twin/releases/43/7/', 'a');
  const record = { ...old, cacheRevision: 'a', totalBytes: 100, lastUsed: now - 8 * 86400_000, complete: true };
  assert.equal(isPublishedReleaseCleanupCandidate(record, current, now, true), true);
  assert.equal(isPublishedReleaseCleanupCandidate(record, current, now, false), false);
  assert.equal(isPublishedReleaseCleanupCandidate({ ...record, ...other }, current, now, true), false);
  assert.equal(isPublishedReleaseCleanupCandidate({ ...record, ...current }, current, now, true), false);
  assert.equal(isPublishedReleaseCleanupCandidate({ ...record, lastUsed: now - 86400_000 }, current, now, true), false);
  assert.equal(isPublishedReleaseCleanupCandidate({ ...record, lastUsed: now + 86400_000 }, current, now, true), false);
});

test('只有 ready 且全部文件完成才记录整版本完成，部分或错误状态不能误标', () => {
  assert.equal(isPublishedReleaseComplete({ phase: 'ready', completedFiles: 3, totalFiles: 3 }), true);
  for (const state of [undefined, { phase: 'partial', completedFiles: 3, totalFiles: 3 }, { phase: 'ready', completedFiles: 2, totalFiles: 3 }, { phase: 'ready', completedFiles: 0, totalFiles: 0 }]) {
    assert.equal(isPublishedReleaseComplete(state), false);
  }
});
