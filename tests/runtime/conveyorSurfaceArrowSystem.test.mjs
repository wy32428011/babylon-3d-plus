import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConveyorArrowModules } from '../helpers/conveyorSurfaceArrowModules.mjs';

const [systemModule, telemetry, sessionModule, configModule] = await loadConveyorArrowModules([
  'src/runtime/babylon/telemetry/ConveyorSurfaceArrowSystem.ts',
  'src/runtime/mqtt/deviceTelemetry.ts',
  'src/runtime/conveyorSurfaceArrowSession.ts',
  'src/editor/model/conveyorSurfaceArrows.ts',
]);
const { conveyorSurfaceArrowSession: session } = sessionModule;
const { deviceTelemetryStore: store } = telemetry;

function harness(t) {
  store.clear(); session.clear();
  const calls = new Map();
  const renderer = {
    update: (id, model, config, direction, delta, visible) => { calls.set(id, { direction, visible }); return null; },
    retain: ids => { for (const id of calls.keys()) if (!ids.has(id)) calls.delete(id); },
    clear: () => calls.clear(), dispose: () => calls.clear(),
  };
  const system = new systemModule.ConveyorSurfaceArrowSystem(renderer);
  const model = (code, sourceId = 'default') => ({
    assetCode: code, assetHandle: {}, stackerTelemetryReady: true,
    root: { isDisposed: () => false }, contentRoot: { getChildMeshes: () => [] },
    externalScriptRuntime: null, entitySnapshot: null,
    telemetryBinding: { enabled: true, sourceId, deviceType: 'conveyor', staleAfterMs: 2000,
      surfaceArrows: { ...configModule.createDefaultConveyorSurfaceArrowsConfig(), enabled: true } },
  });
  const entry = (id, model) => ({ entityId: id, model, deviceType: 'conveyor', visible: true });
  const push = (code, movement, sourceId = 'default', receivedAt = 10000, fields = {}) => {
    store.upsert({ sourceId, assetCode: code, deviceType: 'conveyor', topic: '', payloadDeviceCode: code,
      sourceTimestamp: null, sequence: null, receivedAt, fields: { movement_x: movement, ...fields },
      faulted: false, currentLocationKey: null, targetLocationKey: null, hasTargetLocation: false, message: '' });
  };
  t.after(() => { system.dispose(); store.clear(); session.clear(); });
  return { system, calls, model, entry, push };
}

test('各实例完整设备身份隔离，阵列代理也独立更新方向', t => {
  const h = harness(t), a = h.model('001'), b = h.model('001', 'other');
  b.telemetryProxySource = a;
  h.push('001', 1); h.push('001', 2, 'other');
  h.system.tick([h.entry('a', a), h.entry('b', b)], true, .1, 11000);
  assert.deepEqual(h.calls.get('a'), { direction: 1, visible: true });
  assert.deepEqual(h.calls.get('b'), { direction: -1, visible: true });
});

test('关闭箭头的另一设备仍参与冲突判定，解绑/过期主动隐藏', t => {
  const h = harness(t), a = h.model('001'), b = h.model('001');
  b.telemetryBinding.surfaceArrows.enabled = false;
  h.push('001', 1);
  h.system.tick([h.entry('a', a), h.entry('b', b)], true, .1, 11000);
  assert.equal(h.calls.get('a').visible, false);
  assert.match(session.getDiagnostic('a'), /冲突/);
  h.system.tick([h.entry('a', a)], true, .1, 13001);
  assert.equal(h.calls.get('a').visible, false);
  assert.match(session.getDiagnostic('a'), /过期/);
  a.telemetryBinding.enabled = false;
  h.system.tick([h.entry('a', a)], true, .1, 11000);
  assert.equal(h.calls.get('a').visible, false);
});

test('编辑预览不依赖 MQTT，进入运行忽略模拟状态，退出与删除清理', t => {
  const h = harness(t), a = h.model('001'), entries = [h.entry('a', a)];
  session.setPreview('a', -1);
  h.system.tick(entries, false, .1, 11000);
  assert.deepEqual(h.calls.get('a'), { direction: -1, visible: true });
  h.system.tick(entries, true, .1, 11000);
  assert.equal(h.calls.get('a').visible, false);
  h.system.tick([], true, .1, 11000);
  assert.equal(h.calls.size, 0);
  assert.equal(session.getDiagnostic('a'), '');
});

test('自带箭头保留优先权，显式关闭原参数后可使用通用箭头', t => {
  const h = harness(t), a = h.model('001');
  a.contentRoot.getChildMeshes = () => [{ metadata: { directionArrowVisual: true } }];
  a.entitySnapshot = { components: { modelAsset: { parameterValues: { showDirectionArrow: true } } } };
  h.push('001', 1);
  h.system.tick([h.entry('a', a)], true, .1, 11000);
  assert.equal(h.calls.get('a').visible, false);
  assert.match(session.getDiagnostic('a'), /自带箭头/);
  a.entitySnapshot.components.modelAsset.parameterValues = { showDirectionArrow: false };
  a.parameterSignature = 'changed';
  h.system.tick([h.entry('a', a)], true, .1, 11000);
  assert.equal(h.calls.get('a').visible, true);
});
