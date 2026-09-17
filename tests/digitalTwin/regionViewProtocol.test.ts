import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDigitalTwinRegionViewMessage } from '../../src/player/digitalTwinRegionViewProtocol.ts';

const base = { channel: 'zending.digital-twin.bridge', version: 1, sessionId: 'session', requestId: 'request' };
test('区域视角扩展查询和响应精确校验 ID 与有界列表', () => {
  const list = { ...base, type: 'viewer.regionViews', payload: { views: [{ id: 'view-1', name: '入库区' }] } };
  assert.deepEqual(parseDigitalTwinRegionViewMessage(list), list);
  assert.ok(parseDigitalTwinRegionViewMessage({ ...base, type: 'host.regionViews' }));
  assert.equal(parseDigitalTwinRegionViewMessage({ ...list, payload: { views: [{ id: 123, name: '坏项' }] } }), null);
  assert.equal(parseDigitalTwinRegionViewMessage({ ...list, payload: { views: [list.payload.views[0], list.payload.views[0]] } }), null);
  assert.equal(parseDigitalTwinRegionViewMessage({ ...list, extra: true }), null);
  assert.equal(parseDigitalTwinRegionViewMessage({ ...list, sessionId: '' }), null);
});
test('命令拒绝空 ID、错误动画类型；兼容扩展不修改基础握手', () => {
  const command = { ...base, type: 'command.regionView', payload: { viewId: 'view-1', animate: true } };
  assert.deepEqual(parseDigitalTwinRegionViewMessage(command), command);
  assert.equal(parseDigitalTwinRegionViewMessage({ ...command, payload: { viewId: '', animate: true } }), null);
  assert.equal(parseDigitalTwinRegionViewMessage({ ...command, payload: { viewId: 'view-1', animate: 'yes' } }), null);
  assert.equal(parseDigitalTwinRegionViewMessage({ ...base, type: 'host.hello' }), null);
});

test('完成、失败、取消和手动离开视角事件均为严格可选扩展', () => {
  const valid = [
    { ...base, type: 'command.cancelRegionView' },
    { ...base, type: 'viewer.regionViewCleared' },
    { ...base, type: 'viewer.regionViewResult', ok: true, payload: { viewId: 'v' } },
    { ...base, type: 'viewer.regionViewResult', ok: false, error: { code: 'REGION_VIEW_NOT_FOUND', message: '未找到' } },
  ];
  for (const message of valid) assert.deepEqual(parseDigitalTwinRegionViewMessage(message), message);
  for (const message of [null, {}, { ...base, type: 'unknown' }, { ...valid[0], version: 2 },
    { ...valid[2], payload: { viewId: 'v', url: 'https://untrusted.test' } },
    { ...valid[3], error: { code: 'UNKNOWN', message: 'bad' } },
    { ...base, type: 'viewer.regionViews', payload: { views: Array.from({ length: 257 }, (_, i) => ({ id: String(i), name: '区域' })) } },
  ]) assert.equal(parseDigitalTwinRegionViewMessage(message), null);
});
