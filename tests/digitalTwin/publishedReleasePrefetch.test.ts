import assert from 'node:assert/strict';
import test from 'node:test';
import { prefetchPublishedReleaseFiles } from '../../src/player/publishedReleasePrefetch.ts';

test('完整预缓存受控并发并按字节计进度，失败文件保留为部分完成', async () => {
  let running = 0; let peak = 0;
  const progress: number[] = [];
  const files = Array.from({ length: 8 }, (_, id) => ({ id, size: id + 1 }));
  const result = await prefetchPublishedReleaseFiles(files, async file => {
    running++; peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 2));
    running--;
    if (file.id === 4) throw new Error('storage failure');
    return file.id !== 2;
  }, new AbortController().signal, state => progress.push(state.completedBytes));
  assert.ok(peak <= 2);
  assert.equal(result.completedFiles, 6);
  assert.equal(result.completedBytes, 28);
  assert.equal(result.phase, 'partial');
  assert.equal(progress.at(-1), 28);
});

test('取消后不再取新文件，只有全部成功才报告ready', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(prefetchPublishedReleaseFiles([{ size: 1 }, { size: 2 }, { size: 3 }], async () => {
    calls++; controller.abort(); return true;
  }, controller.signal), { name: 'AbortError' });
  assert.ok(calls <= 2);
  assert.equal((await prefetchPublishedReleaseFiles([{ size: 1 }], async () => true, new AbortController().signal)).phase, 'ready');
});
