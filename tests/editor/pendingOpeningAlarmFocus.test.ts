import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingOpeningAlarmFocus } from '../../src/editor/opening/PendingOpeningAlarmFocus.ts';

const alarm = (targetId: string) => ({ managerId: 'manager', targetId });

test('开场准备及播放期间只保留最新告警，完成后仅聚焦仍然生效的告警', () => {
  const pending = new PendingOpeningAlarmFocus();
  pending.reset(true);
  assert.equal(pending.defer(alarm('first')), true);
  pending.begin();
  assert.equal(pending.defer(alarm('last')), true);
  assert.deepEqual(pending.finish('completed', event => event.targetId === 'last'), alarm('last'));
  assert.equal(pending.finish('completed', () => true), null);
  assert.equal(pending.defer(alarm('normal')), false);
});

test('用户取消和区域切换清理旧告警，迟到完成不得抢占相机', () => {
  const pending = new PendingOpeningAlarmFocus();
  pending.begin();
  pending.defer(alarm('old'));
  assert.equal(pending.finish('cancelled', () => true), null);
  assert.equal(pending.finish('completed', () => true), null);
});

test('跳过仅释放最新且仍生效的告警，已解除告警及切场景缓存丢弃', () => {
  const pending = new PendingOpeningAlarmFocus();
  pending.begin();
  pending.defer(alarm('cleared'));
  assert.equal(pending.finish('skipped', () => false), null);
  pending.begin();
  pending.defer(alarm('stale-scene'));
  pending.reset(true);
  assert.equal(pending.finish('completed', () => true), null);
  pending.reset(false);
  assert.equal(pending.defer(alarm('normal')), false);
});
