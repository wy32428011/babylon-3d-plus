import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConveyorArrowModules } from '../helpers/conveyorSurfaceArrowModules.mjs';

const [systems, telemetry, sessions, configs, motions] = await loadConveyorArrowModules([
  'src/runtime/babylon/telemetry/RgvMotionArrowSystem.ts', 'src/runtime/mqtt/deviceTelemetry.ts',
  'src/runtime/rgvMotionArrowSession.ts', 'src/editor/model/rgvMotionArrows.ts',
  'src/runtime/babylon/telemetry/rgvMotionState.ts',
]);
const session = sessions.rgvMotionArrowSession, store = telemetry.deviceTelemetryStore;
function fixture(t) {
  session.clear(); store.clear(); const calls = new Map();
  const renderer = {
    update(id, model, config, channel, direction, delta, visible) { calls.set(JSON.stringify([id, channel]), { direction, visible }); return null; },
    retain(keys) { for (const key of calls.keys()) if (!keys.has(key)) calls.delete(key); },
    clear() { calls.clear(); }, dispose() { calls.clear(); },
  };
  const system = new systems.RgvMotionArrowSystem(renderer);
  const model = (assetCode, sourceId = 'default') => ({ assetCode, assetHandle: {}, rgvTelemetry: {}, stackerTelemetryReady: true, root: { isDisposed: () => false },
    telemetryBinding: { enabled: true, sourceId, deviceType: 'rgv', staleAfterMs: 2000,
      rgvMotionArrows: { ...configs.createDefaultRgvMotionArrowsConfig(), enabled: true } } });
  const entry = (id, model) => ({ entityId: id, model, deviceType: 'rgv', visible: true });
  const push = (assetCode, sourceId = 'default', faulted = false) => store.upsert({ sourceId, assetCode, deviceType: 'rgv', topic: '', payloadDeviceCode: assetCode,
    sourceTimestamp: null, sequence: null, receivedAt: 10000, fields: { movement_x: 2, front_movement_z: 2 }, faulted,
    currentLocationKey: null, targetLocationKey: null, hasTargetLocation: false, message: '' });
  const publish = (model, movement = { travel: .2, front: .1, back: -.1 }, frame = 5) => motions.publishRgvMotionFrame(model, frame, .1, movement);
  const call = (id, channel) => calls.get(JSON.stringify([id, channel]));
  t.after(() => { system.dispose(); session.clear(); store.clear(); });
  return { system, model, entry, push, publish, call, calls };
}

test('三路使用同帧驱动结果而非MQTT编码；同资产跨数据源隔离', t => {
  const h = fixture(t), a = h.model('001'), b = h.model('001', 'other');
  h.push('001'); h.push('001', 'other'); h.publish(a); h.publish(b, { travel: -.1, front: 0, back: 0 });
  h.system.tick([h.entry('a', a), h.entry('b', b)], true, .1, 5, 11000);
  assert.deepEqual(h.call('a', 'travel'), { direction: 1, visible: true });
  assert.deepEqual(h.call('a', 'front'), { direction: 1, visible: true });
  assert.deepEqual(h.call('a', 'back'), { direction: -1, visible: true });
  assert.equal(h.call('b', 'travel').direction, -1);
});

test('旧帧、故障、过期、禁用绑定立即隐藏；正常停止保留淡出入口', t => {
  const h = fixture(t), a = h.model('001'), entries = [h.entry('a', a)]; h.push('001'); h.publish(a);
  h.system.tick(entries, true, .1, 6, 11000); assert.equal(h.call('a', 'travel').visible, false);
  h.system.tick(entries, true, .1, 5, 13000); assert.equal(h.call('a', 'travel').visible, false); assert.match(session.getDiagnostic('a', 'travel'), /过期/);
  h.push('001', 'default', true); h.system.tick(entries, true, .1, 5, 11000); assert.equal(h.call('a', 'front').visible, false);
  h.push('001'); h.publish(a, { travel: 0, front: 0, back: 0 }); h.system.tick(entries, true, .1, 5, 11000);
  assert.deepEqual(h.call('a', 'travel'), { direction: 0, visible: true });
  a.telemetryBinding.enabled = false; h.system.tick(entries, true, .1, 5, 11000); assert.equal(h.call('a', 'travel').visible, false);
});

test('未启用箭头的RGV仍参与设备绑定冲突；旧场景不分配资源', t => {
  const h = fixture(t), a = h.model('001'), b = h.model('001'); delete b.telemetryBinding.rgvMotionArrows;
  h.push('001'); h.publish(a); h.system.tick([h.entry('a', a), h.entry('b', b)], true, .1, 5, 11000);
  assert.equal(h.call('a', 'front').visible, false); assert.match(session.getDiagnostic('a', 'front'), /冲突/);
  assert.equal(h.call('b', 'travel'), undefined);
});

test('三路编辑预览独立；隐藏、关闭、未就绪和删除均清理', t => {
  const h = fixture(t), a = h.model('001'), entry = h.entry('a', a);
  session.setPreview('a', 'front', -1); session.setPreview('a', 'back', 1);
  h.system.tick([entry], false, .1, 5, 11000);
  assert.deepEqual(h.call('a', 'front'), { direction: -1, visible: true });
  assert.equal(h.call('a', 'back').direction, 1); assert.equal(h.call('a', 'travel').visible, false);
  entry.visible = false; h.system.tick([entry], false, .1, 5, 11000); assert.equal(h.call('a', 'front').visible, false);
  a.telemetryBinding.rgvMotionArrows.channels.front.enabled = false;
  h.system.tick([entry], false, .1, 5, 11000); assert.equal(h.call('a', 'front'), undefined);
  a.stackerTelemetryReady = false; h.system.tick([entry], false, .1, 5, 11000); assert.equal(h.calls.size, 0);
  h.system.tick([], false, .1, 5, 11000); assert.equal(session.getDiagnostic('a', 'back'), '');
});

test('解析为其它设备类型时不执行RGV箭头，即使残留显式配置', t => {
  const h = fixture(t), a = h.model('001'), entry = { ...h.entry('a', a), deviceType: 'shuttle' };
  session.setPreview('a', 'travel', 1); h.system.tick([entry], false, .1, 5, 11000);
  assert.equal(h.calls.size, 0);
});
