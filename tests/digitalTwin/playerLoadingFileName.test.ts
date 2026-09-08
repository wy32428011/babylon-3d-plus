import assert from 'node:assert/strict';
import test from 'node:test';
import { computePlayerLoadingProgress } from '../../src/player/playerLoadingProgress.ts';

function computeLoadingDetail(fileName: string): string | null {
  return computePlayerLoadingProgress({
    phase: 'loading',
    startupPercent: 50,
    modelLoadProgress: {
      loading: true,
      percent: 0,
      completedCount: 0,
      totalCount: 1,
      currentFile: fileName,
    },
    initialLoadCompleted: false,
    message: '场景加载中...',
  }).detail;
}

test('发布加载详情将中文 URL 文件名还原并移除资源修订参数', () => {
  const fileName = '%E9%93%BE%E6%9D%A1%E6%9C%BA%E6%96%B0.glb?assetRevision=63#mesh';
  assert.equal(computeLoadingDetail(fileName), '模型 0/1 · 链条机新.glb');
});

test('普通中文、英文文件名和空文件名保持原有显示', () => {
  assert.equal(computeLoadingDetail('厂区环境.glb'), '模型 0/1 · 厂区环境.glb');
  assert.equal(computeLoadingDetail('box.glb'), '模型 0/1 · box.glb');
  assert.equal(computeLoadingDetail(''), '模型 0/1');
});

test('先移除 URL 参数再解码，保留文件名本身的特殊字符且只解码一次', () => {
  const name = '环境 #1? A+B 100% %E9.glb';
  assert.equal(computeLoadingDetail(`${encodeURIComponent(name)}?assetRevision=63`), `模型 0/1 · ${name}`);
  assert.equal(computeLoadingDetail('box.glb#mesh'), '模型 0/1 · box.glb');
});

test('不合法的转义和 UTF-8 字节不阻断加载进度且仍移除 URL 参数', () => {
  for (const name of ['100%.glb', 'model%ZZ.glb', 'model%E9%93.glb']) {
    assert.equal(computeLoadingDetail(`${name}?assetRevision=63`), `模型 0/1 · ${name}`);
  }
});
