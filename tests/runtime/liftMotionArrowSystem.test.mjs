import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConveyorArrowModules } from '../helpers/conveyorSurfaceArrowModules.mjs';

const [systems, telemetry, sessions, configs, motions] = await loadConveyorArrowModules([
  'src/runtime/babylon/telemetry/LiftMotionArrowSystem.ts', 'src/runtime/mqtt/deviceTelemetry.ts',
  'src/runtime/liftMotionArrowSession.ts', 'src/editor/model/liftMotionArrows.ts',
  'src/runtime/babylon/telemetry/liftMotionState.ts',
]);
const session = sessions.liftMotionArrowSession, store = telemetry.deviceTelemetryStore;

function fixture(t) {
  session.clear(); store.clear(); const calls = new Map();
  const renderer = {
    update(id, model, config, channel, direction, delta, visible, axis) { calls.set(JSON.stringify([id, channel]), { direction, visible, axis }); return null; },
    retain(keys) { for (const key of calls.keys()) if (!keys.has(key)) calls.delete(key); },
    clear() { calls.clear(); }, dispose() { calls.clear(); },
  };
  const system = new systems.LiftMotionArrowSystem(renderer);
  const model = (assetCode, deviceType = 'lift', sourceId = 'default') => ({ assetCode, assetHandle: {},
    liftTelemetry: {}, hcliftTelemetry: {}, stackerTelemetryReady: true, root: { isDisposed: () => false },
    telemetryBinding: { enabled: true, sourceId, deviceType, staleAfterMs: 2000,
      liftMotionArrows: { ...configs.createDefaultLiftMotionArrowsConfig(), enabled: true } } });
  const entry = (id, model) => ({ entityId: id, model, deviceType: model.telemetryBinding.deviceType, visible: true });
  const push = (assetCode, deviceType = 'lift', sourceId = 'default', faulted = false, fields = {}) => store.upsert({ sourceId, assetCode, deviceType, topic: '', payloadDeviceCode: assetCode,
    sourceTimestamp: null, sequence: null, receivedAt: 10000, fields: { lift_current_level: 2, task_target_level: 3, ...fields }, faulted,
    currentLocationKey: null, targetLocationKey: null, hasTargetLocation: false, message: '' });
  const publish = (model, movement = { lift: .2, front: .1, back: -.1, axis: { x: 0, y: 0, z: -1 } }, frame = 5) => motions.publishLiftMotionFrame(model, frame, .1, movement);
  const call = (id, channel) => calls.get(JSON.stringify([id, channel]));
  t.after(() => { system.dispose(); session.clear(); store.clear(); });
  return { system, model, entry, push, publish, call, calls };
}

test('提升机三路方向使用真实同帧位移及世界交接轴，跨数据源隔离', t => {
  const h = fixture(t), a = h.model('001'), b = h.model('001', 'lift', 'other');
  h.push('001'); h.push('001', 'lift', 'other'); h.publish(a); h.publish(b, { lift: -.1, front: 0, back: 0 });
  h.system.tick([h.entry('a', a), h.entry('b', b)], true, .1, 5, 11000);
  assert.equal(h.call('a', 'lift').direction, 1);
  assert.deepEqual(h.call('a', 'front'), { direction: 1, visible: true, axis: { x: 0, y: 0, z: -1 } });
  assert.equal(h.call('a', 'back').direction, -1); assert.equal(h.call('b', 'lift').direction, -1);
});

test('换层提升机只消费升降通道，不能启用台面输送模拟箭头', t => {
  const h = fixture(t), a = h.model('001', 'hclift'); h.push('001', 'hclift'); h.publish(a);
  h.system.tick([h.entry('a', a)], true, .1, 5, 11000);
  assert.equal(h.call('a', 'lift').visible, true); assert.equal(h.call('a', 'front'), undefined); assert.equal(h.call('a', 'back'), undefined);
  assert.match(session.getDiagnostic('a', 'front'), /仅支持升降/);
  session.setPreview('a', 'front', 1); h.system.tick([h.entry('a', a)], false, .1, 5, 11000);
  assert.equal(h.call('a', 'front'), undefined);
});

test('旧帧、故障、过期、失效绑定和缺少真实交接轴立即隐藏，正常停止保留淡出入口', t => {
  const h = fixture(t), a = h.model('001'), entries = [h.entry('a', a)]; h.push('001'); h.publish(a);
  h.system.tick(entries, true, .1, 6, 11000); assert.equal(h.call('a', 'lift').visible, false);
  h.system.tick(entries, true, .1, 5, 13000); assert.equal(h.call('a', 'lift').visible, false); assert.match(session.getDiagnostic('a', 'lift'), /过期/);
  h.push('001', 'lift', 'default', true); h.system.tick(entries, true, .1, 5, 11000); assert.equal(h.call('a', 'front').visible, false);
  h.push('001', 'lift', 'default', false, { work_state: 10 }); h.system.tick(entries, true, .1, 5, 11000);
  assert.equal(h.call('a', 'lift').visible, false); assert.match(session.getDiagnostic('a', 'lift'), /故障/);
  h.push('001'); h.publish(a, { lift: .1, front: .1, back: -.1 }); h.system.tick(entries, true, .1, 5, 11000);
  assert.equal(h.call('a', 'front').visible, false); assert.match(session.getDiagnostic('a', 'front'), /运动轴/);
  assert.equal(h.call('a', 'lift').visible, true);
  h.publish(a, { lift: 0, front: 0, back: 0 }); h.system.tick(entries, true, .1, 5, 11000);
  assert.equal(h.call('a', 'lift').direction, 0); assert.equal(h.call('a', 'lift').visible, true);
  a.telemetryBinding.enabled = false; h.system.tick(entries, true, .1, 5, 11000); assert.equal(h.call('a', 'lift').visible, false);
});

test('未启用箭头的同类设备仍参与绑定冲突，两类设备身份相互隔离', t => {
  const h = fixture(t), a = h.model('001'), b = h.model('001'), c = h.model('001', 'hclift');
  delete b.telemetryBinding.liftMotionArrows; h.push('001'); h.push('001', 'hclift'); h.publish(a); h.publish(c);
  h.system.tick([h.entry('a', a), h.entry('b', b), h.entry('c', c)], true, .1, 5, 11000);
  assert.equal(h.call('a', 'front').visible, false); assert.match(session.getDiagnostic('a', 'front'), /冲突/);
  assert.equal(h.call('b', 'lift'), undefined); assert.equal(h.call('c', 'lift').visible, true);
});

test('编辑预览三路独立；模型隐藏、禁用通道、未就绪和删除均清理', t => {
  const h = fixture(t), a = h.model('001'), entry = h.entry('a', a);
  session.setPreview('a', 'lift', -1); session.setPreview('a', 'back', 1);
  h.system.tick([entry], false, .1, 5, 11000);
  assert.equal(h.call('a', 'lift').direction, -1); assert.equal(h.call('a', 'back').direction, 1); assert.equal(h.call('a', 'front').visible, false);
  entry.visible = false; h.system.tick([entry], false, .1, 5, 11000); assert.equal(h.call('a', 'lift').visible, false);
  a.telemetryBinding.liftMotionArrows.channels.lift.enabled = false;
  h.system.tick([entry], false, .1, 5, 11000); assert.equal(h.call('a', 'lift'), undefined);
  a.stackerTelemetryReady = false; h.system.tick([entry], false, .1, 5, 11000); assert.equal(h.calls.size, 0);
  h.system.tick([], false, .1, 5, 11000); assert.equal(session.getDiagnostic('a', 'back'), '');
});

test('切换为其他设备类型时忽略残留配置，切换为换层设备时回收前后路资源', t => {
  const h = fixture(t), a = h.model('001'), entry = h.entry('a', a); session.setPreview('a', 'front', 1);
  h.system.tick([entry], false, .1, 5, 11000); assert.ok(h.call('a', 'front'));
  entry.deviceType = 'hclift'; h.system.tick([entry], false, .1, 5, 11000); assert.equal(h.call('a', 'front'), undefined);
  entry.deviceType = 'shuttle'; h.system.tick([entry], false, .1, 5, 11000); assert.equal(h.calls.size, 0);
});
