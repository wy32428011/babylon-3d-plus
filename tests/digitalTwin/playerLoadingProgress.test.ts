import assert from 'node:assert/strict';
import test from 'node:test';
import { computePlayerLoadingProgress } from '../../src/player/playerLoadingProgress.ts';

test('启动阶段尚无加载单元时按启动里程碑显示蒙版', () => {
  const progress = computePlayerLoadingProgress({
    phase: 'loading',
    startupPercent: 30,
    modelLoadProgress: null,
    initialLoadCompleted: false,
    message: '场景加载中...',
  });

  assert.equal(progress.visible, true);
  assert.equal(progress.percent, 30);
  assert.equal(progress.label, '场景加载中...');
  assert.equal(progress.detail, null);
});

test('模型加载进行中由实际单元接管剩余百分比并显示数量详情', () => {
  const progress = computePlayerLoadingProgress({
    phase: 'loading',
    startupPercent: 50,
    modelLoadProgress: {
      loading: true,
      percent: 0.6,
      completedCount: 3,
      totalCount: 5,
      currentFile: 'box.glb',
    },
    initialLoadCompleted: false,
    message: '场景加载中...',
  });

  assert.equal(progress.visible, true);
  assert.equal(progress.percent, 80);
  assert.equal(progress.label, '正在加载场景模型');
  assert.equal(progress.detail, '模型 3/5 · box.glb');
});

test('场景就绪但首次模型加载仍在进行时保持蒙版', () => {
  const progress = computePlayerLoadingProgress({
    phase: 'ready',
    startupPercent: 50,
    modelLoadProgress: {
      loading: true,
      percent: 0.4,
      completedCount: 2,
      totalCount: 5,
      currentFile: null,
    },
    initialLoadCompleted: false,
    message: '场景加载中...',
  });

  assert.equal(progress.visible, true);
  assert.equal(progress.label, '正在加载场景模型');
  assert.equal(progress.detail, '模型 2/5');
});

test('首次加载全部结算后蒙版消失', () => {
  const progress = computePlayerLoadingProgress({
    phase: 'ready',
    startupPercent: 50,
    modelLoadProgress: {
      loading: false,
      percent: 1,
      completedCount: 5,
      totalCount: 5,
      currentFile: null,
    },
    initialLoadCompleted: true,
    message: '场景加载中...',
  });

  assert.equal(progress.visible, false);
  assert.equal(progress.percent, 100);
});

test('首次加载完成后按需加载（如 MQTT 货物模板）不再重新弹出蒙版', () => {
  const progress = computePlayerLoadingProgress({
    phase: 'ready',
    startupPercent: 50,
    modelLoadProgress: {
      loading: true,
      percent: 0.2,
      completedCount: 6,
      totalCount: 7,
      currentFile: 'cargo.glb',
    },
    initialLoadCompleted: true,
    message: '场景加载中...',
  });

  assert.equal(progress.visible, false);
});

test('启动阻断后蒙版让位于错误提示', () => {
  const progress = computePlayerLoadingProgress({
    phase: 'blocked',
    startupPercent: 30,
    modelLoadProgress: null,
    initialLoadCompleted: false,
    message: '启动失败',
  });

  assert.equal(progress.visible, false);
});

test('天空盒失败时其他模型仍在加载，普通进度蒙版也不能遮挡错误', () => {
  const progress = computePlayerLoadingProgress({ phase: 'blocked', startupPercent: 50,
    initialLoadCompleted: false, message: '天空盒加载失败',
    modelLoadProgress: { loading: true, percent: .1, completedCount: 5, totalCount: 99, currentFile: 'device.glb' } });
  assert.equal(progress.visible, false);
});

test('模型进度越界时百分比裁剪到 0-100', () => {
  const progress = computePlayerLoadingProgress({
    phase: 'ready',
    startupPercent: 50,
    modelLoadProgress: {
      loading: false,
      percent: 1.8,
      completedCount: 5,
      totalCount: 5,
      currentFile: null,
    },
    initialLoadCompleted: true,
    message: '场景加载中...',
  });

  assert.equal(progress.percent, 100);
});

test('纯内置几何或空场景没有模型加载单元，仍等实际首帧确认后收起蒙版', () => {
  const progress = computePlayerLoadingProgress({
    phase: 'ready',
    startupPercent: 50,
    modelLoadProgress: null,
    initialLoadCompleted: false,
    message: '场景加载中...',
  });

  assert.equal(progress.visible, true);
  assert.equal(progress.percent, 99);
  assert.equal(progress.label, '正在验证场景首帧');
  for (const modelLoadProgress of [null, { loading: false, percent: 1, completedCount: 0, totalCount: 0, currentFile: null }]) {
    const verified = computePlayerLoadingProgress({ phase: 'ready', startupPercent: 50,
      modelLoadProgress, initialLoadCompleted: true, message: '场景加载中...' });
    assert.equal(verified.visible, false);
    assert.equal(verified.percent, 100);
  }
});


test('下载字节已到100%但资源或首帧未成功，显示最多99%', () => {
  const progress = computePlayerLoadingProgress({ phase: 'ready', startupPercent: 50, initialLoadCompleted: false, message: '加载中',
    modelLoadProgress: { loading: true, percent: 1, completedCount: 163, totalCount: 164, currentFile: 'skybox.exr' } });
  assert.equal(progress.percent, 99); assert.equal(progress.visible, true);
});
