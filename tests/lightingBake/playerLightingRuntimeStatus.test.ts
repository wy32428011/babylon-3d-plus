import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePlayerLightingRuntimeStatus, updatePlayerRuntimeMessage } from '../../src/player/playerLightingRuntimeStatus.ts';

test('加载期的历史GI失败不成为持续运行提示，普通提示仍保留', () => {
  const failure = '混合光照：模型几何或实际姿态与烘焙资源不一致，请重新烘焙。';
  assert.equal(updatePlayerRuntimeMessage(null, failure), null);
  assert.equal(updatePlayerRuntimeMessage('普通运行提示', failure), '普通运行提示');
  assert.equal(updatePlayerRuntimeMessage('普通运行提示', '混合光照已恢复实时基线：静态对象已变化。'), '普通运行提示');
  assert.equal(updatePlayerRuntimeMessage('旧提示', '新的普通运行提示'), '新的普通运行提示');
});

test('只有真实首帧就绪后显示当前GI错误，恢复后移除错误且不伪造成功', () => {
  const failure = '模型几何或实际姿态与烘焙资源不一致，请重新烘焙。';
  assert.equal(resolvePlayerLightingRuntimeStatus(false, failure), null);
  assert.equal(resolvePlayerLightingRuntimeStatus(true, failure), `混合光照：${failure}`);
  assert.equal(resolvePlayerLightingRuntimeStatus(true, null), null);
});

test('当前有效静态失配始终显示，不能被历史日志或其他运行提示替换', () => {
  const failure = '静态对象「立柱」的姿态、显隐、几何或材质发生变化，请重新烘焙。';
  const normalMessage = updatePlayerRuntimeMessage(null, 'MQTT 状态更新');
  assert.equal(resolvePlayerLightingRuntimeStatus(true, failure), `混合光照：${failure}`);
  assert.equal(normalMessage, 'MQTT 状态更新');
  assert.equal(resolvePlayerLightingRuntimeStatus(true, null), null);
  assert.equal(normalMessage, 'MQTT 状态更新');
});
