import assert from 'node:assert/strict';
import test from 'node:test';
import { PlayerInitialLoadMonitor } from '../../src/player/playerInitialLoadMonitor.ts';

const snapshot = (bytes = 0, stage = 'reading') => ({
  progress: { loading: true, percent: .9, completedCount: 163, totalCount: 164, currentFile: '天空盒纹理', filePercent: null },
  skybox: { stage, receivedBytes: bytes, totalBytes: 75_640_460 },
});

test('120秒仍下载时仅提示缓慢，140秒真实完成后允许进入首帧验证', () => {
  const monitor = new PlayerInitialLoadMonitor();
  assert.equal(monitor.sample(snapshot(), 0).kind, 'loading');
  assert.equal(monitor.sample(snapshot(60_000_000), 120_000).kind, 'slow');
  const ready = snapshot(75_640_460, '');
  ready.progress = { ...ready.progress, loading: false, completedCount: 164, percent: 1 };
  const result = monitor.sample(ready, 140_000);
  assert.equal(result.kind, 'slow');
  assert.match(result.detail, /首帧/);
});

test('持续下载超过五分钟不被总时长阻断；进度相同的重复通知不会掩盖停滞', () => {
  const monitor = new PlayerInitialLoadMonitor();
  for (let t = 0; t <= 600_000; t += 60_000) assert.notEqual(monitor.sample(snapshot(t), t).kind, 'stalled');
  assert.equal(monitor.sample(snapshot(600_000), 899_999).kind, 'slow');
  assert.equal(monitor.sample(snapshot(600_000), 900_000).kind, 'stalled');
});

test('下载转解码重置阶段停滞计时；未知大小也通过字节前进判断', () => {
  const monitor = new PlayerInitialLoadMonitor();
  const input = { ...snapshot(), skybox: { stage: 'reading', receivedBytes: 1, totalBytes: null } };
  monitor.sample(input, 0);
  input.skybox.receivedBytes = 2;
  assert.equal(monitor.sample(input, 299_000).kind, 'slow');
  input.skybox.stage = 'decoding';
  assert.notEqual(monitor.sample(input, 598_000).kind, 'stalled');
  assert.equal(monitor.sample(input, 898_000).kind, 'stalled');
});

test('取消旧会话后新监视器具有独立时间基线', () => {
  const old = new PlayerInitialLoadMonitor(); old.sample(snapshot(), 0);
  assert.equal(old.sample(snapshot(), 300_000).kind, 'stalled');
  assert.equal(new PlayerInitialLoadMonitor().sample(snapshot(), 300_000).kind, 'loading');
});


test('模型HTTP响应没有Content-Length时，真实下载字节也延续等待', () => {
  const monitor = new PlayerInitialLoadMonitor();
  for (let t = 0; t <= 900_000; t += 60_000) {
    const state = { ...snapshot(0, ''), resourceBytes: t };
    assert.notEqual(monitor.sample(state, t).kind, 'stalled');
  }
});

test('配置及场景文档阶段也有缓慢提示和独立停滞限制', () => {
  const monitor = new PlayerInitialLoadMonitor();
  const state = { ...snapshot(0, ''), startupStage: '读取发布配置' };
  monitor.sample(state, 0);
  assert.equal(monitor.sample(state, 120_000).kind, 'slow');
  state.startupStage = '读取资源清单';
  assert.equal(monitor.sample(state, 299_000).kind, 'slow');
  assert.equal(monitor.sample(state, 599_000).kind, 'stalled');
});
