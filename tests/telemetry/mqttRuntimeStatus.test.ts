import assert from 'node:assert/strict';
import test from 'node:test';

import { mqttRuntimeStatusStore } from '../../src/runtime/mqtt/mqttRuntimeStatus';

test('mqttRuntimeStatusStore 内容不变时不重复通知且更新时间保持稳定', () => {
  mqttRuntimeStatusStore.update('disabled');
  let notifyCount = 0;
  const unsubscribe = mqttRuntimeStatusStore.subscribe(() => {
    notifyCount += 1;
  });

  try {
    mqttRuntimeStatusStore.update('connecting');
    const firstSnapshot = mqttRuntimeStatusStore.getSnapshot();
    mqttRuntimeStatusStore.update('connecting');
    const secondSnapshot = mqttRuntimeStatusStore.getSnapshot();

    assert.equal(notifyCount, 1);
    assert.equal(secondSnapshot, firstSnapshot);
    assert.equal(secondSnapshot.state, 'connecting');
    assert.equal(secondSnapshot.lastError, null);
  } finally {
    unsubscribe();
    mqttRuntimeStatusStore.update('disabled');
  }
});

test('mqttRuntimeStatusStore 记录错误并归一化空白错误', () => {
  mqttRuntimeStatusStore.update('error', ' broker failed ');
  assert.equal(mqttRuntimeStatusStore.getSnapshot().lastError, 'broker failed');

  mqttRuntimeStatusStore.update('connected', '   ');
  assert.equal(mqttRuntimeStatusStore.getSnapshot().state, 'connected');
  assert.equal(mqttRuntimeStatusStore.getSnapshot().lastError, null);

  mqttRuntimeStatusStore.update('disabled');
});
