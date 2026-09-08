import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine, Scene, TransformNode } from '@babylonjs/core';
import { SpecializedTelemetryRuntime } from '../../src/runtime/babylon/telemetry/specialized/SpecializedTelemetryRuntime';
import { createConveyorTelemetryState } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import { deviceTelemetryStore, type DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { telemetryRuntimeDiagnosticsStore, TelemetryRuntimeDiagnosticsStore, type TelemetryRuntimeDiagnosticInput } from '../../src/runtime/mqtt/telemetryRuntimeDiagnostics';
import { createDefaultTelemetryBinding } from '../../src/editor/model/telemetryBinding';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';
import type { SpecializedTelemetryHost } from '../../src/runtime/babylon/telemetry/specialized/types';

function snapshot(fields: Record<string, unknown> = { movement_x: 0 }, receivedAt = Date.now()): DeviceTelemetrySnapshot {
  return { sourceId: 'default', topic: 'test/conveyor/001', deviceType: 'conveyor', assetCode: '001',
    receivedAt, fields, faulted: false, message: '', payloadDeviceCode: null, sourceTimestamp: null,
    sequence: null, currentLocationKey: null, targetLocationKey: null, hasTargetLocation: false };
}

function harness() {
  deviceTelemetryStore.clear();
  telemetryRuntimeDiagnosticsStore.clear();
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const makeModel = (name: string) => ({
    root: new TransformNode(name, scene), contentRoot: new TransformNode(`${name}_content`, scene),
    assetCode: '001', assetHandle: {}, stackerTelemetryReady: true, conveyorCapable: true,
    stackerCapable: false, rgvCapable: false, externalScriptRuntime: null,
    telemetryBinding: createDefaultTelemetryBinding('conveyor'), conveyorTelemetry: createConveyorTelemetryState(),
  } as unknown as ModelRuntimeEntry);
  const model = makeModel('one');
  const entries = [{ entityId: 'one', model }];
  let injections = 0;
  const host = {
    collectModels: () => entries,
    pushLog: () => {},
    updateExternalScriptContext: () => { injections++; return false; },
  } as unknown as SpecializedTelemetryHost;
  const runtime = new SpecializedTelemetryRuntime(scene, host);
  // 只替换运动回调来记录调度，帧分组、快照解析、断流、脚本注入和诊断均执行真实代码。
  const calls: { id: string; delta: number; fields: Record<string, unknown> }[] = [];
  const drivers = (runtime as unknown as { drivers: { deviceType: string; apply: (model: ModelRuntimeEntry, data: DeviceTelemetrySnapshot, delta: number) => void }[] }).drivers;
  drivers.find((driver) => driver.deviceType === 'conveyor')!.apply = (target, data, delta) => {
    calls.push({ id: target.root.name, delta, fields: { ...data.fields } });
  };
  return { model, entries, makeModel, runtime, calls, injections: () => injections,
    frame: (delta = 1 / 60) => { runtime.clearInactiveDiagnostics(); runtime.applyFrame(delta); },
    dispose: () => { runtime.dispose(); scene.dispose(); engine.dispose(); deviceTelemetryStore.clear(); telemetryRuntimeDiagnosticsStore.clear(); } };
}

test('连续帧复用绑定、上下文和诊断，同时每帧保留相同 delta 的驱动调用', () => {
  const h = harness();
  try {
    deviceTelemetryStore.upsert(snapshot());
    h.frame();
    const metadata = h.model.root.metadata.telemetryRuntime;
    const before = h.runtime.getPerformanceMetrics();
    for (let frame = 0; frame < 120; frame++) h.frame();
    assert.equal(h.calls.length, 121);
    assert.ok(h.calls.every((call) => call.delta === 1 / 60));
    assert.equal(h.injections(), 1);
    assert.equal(h.model.root.metadata.telemetryRuntime, metadata);
    const after = h.runtime.getPerformanceMetrics();
    assert.equal(after.candidateRebuilds, before.candidateRebuilds);
    assert.equal(after.contextSignatureBuilds, before.contextSignatureBuilds);
    assert.equal(after.diagnosticWrites, before.diagnosticWrites);
  } finally { h.dispose(); }
});

test('同值心跳刷新在线时间，断流与自驱继续遵守原规则', () => {
  const h = harness();
  try {
    const old = Date.now() - 10_000;
    h.model.telemetryBinding!.staleAfterMs = 1000;
    deviceTelemetryStore.upsert(snapshot({ movement_x: 0 }, old));
    h.frame();
    assert.equal(h.calls.length, 0);
    assert.equal(telemetryRuntimeDiagnosticsStore.getSnapshot('one')!.stale, true);
    h.model.conveyorTelemetry.selfDriveDirection = 1;
    h.frame();
    assert.equal(h.calls.length, 1);
    const receivedAt = Date.now();
    deviceTelemetryStore.upsert(snapshot({ movement_x: 0 }, receivedAt));
    h.frame();
    assert.equal(h.calls.length, 2);
    assert.equal(telemetryRuntimeDiagnosticsStore.getSnapshot('one')!.lastReceivedAt, receivedAt);
    assert.equal(telemetryRuntimeDiagnosticsStore.getSnapshot('one')!.stale, false);
  } finally { h.dispose(); }
});

test('模型增删、原位修改绑定、异步 ready 和同 ID 换模型均及时更新', () => {
  const h = harness();
  try {
    deviceTelemetryStore.upsert(snapshot());
    h.frame();
    const second = h.makeModel('two');
    h.entries.push({ entityId: 'two', model: second });
    h.frame();
    assert.equal(h.calls.length, 1, '冲突立即停止两个模型');
    second.telemetryBinding!.sourceId = 'another';
    h.frame();
    assert.equal(h.calls.length, 2, '修改绑定立即解除冲突');
    h.model.stackerTelemetryReady = false;
    h.frame();
    assert.equal(h.calls.length, 2);
    h.model.stackerTelemetryReady = true;
    h.entries.pop();
    h.frame();
    assert.equal(h.calls.length, 3);
    const replacement = h.makeModel('replacement');
    h.entries[0] = { entityId: 'one', model: replacement };
    const before = h.injections();
    h.frame();
    assert.equal(h.calls.at(-1)!.id, 'replacement');
    assert.equal(h.injections(), before + 1, '新模型必须获得上下文');
    h.entries.length = 0;
    h.frame();
    assert.equal(h.calls.length, 4);
  } finally { h.dispose(); }
});

test('字段原位变化、嵌套值变化和脚本替换不会被缓存吞掉', () => {
  const h = harness();
  try {
    const data = snapshot({ movement_x: 0, detail: { value: 1 } });
    deviceTelemetryStore.upsert(data);
    h.frame();
    (data.fields.detail as { value: number }).value = 2;
    h.frame();
    assert.equal(h.injections(), 2);
    data.fields.movement_x = 1;
    h.frame();
    assert.equal(h.injections(), 3);
    h.model.externalScriptRuntime = { getDataDrivenConfigs: () => [] } as never;
    h.frame();
    assert.equal(h.injections(), 4);
    h.runtime.clearReportedState();
    h.frame();
    assert.equal(h.injections(), 5);
  } finally { h.dispose(); }
});

test('临时禁用或未就绪后恢复同一模型，不额外调用脚本 onUpdate', () => {
  const h = harness();
  try {
    deviceTelemetryStore.upsert(snapshot());
    h.frame();
    h.model.telemetryBinding!.enabled = false;
    h.frame();
    h.model.telemetryBinding!.enabled = true;
    h.frame();
    h.model.stackerTelemetryReady = false;
    h.frame();
    h.model.stackerTelemetryReady = true;
    h.frame();
    assert.equal(h.injections(), 1);
    assert.equal(h.calls.length, 3);
  } finally { h.dispose(); }
});

test('诊断同步订阅者在帧前清理中禁用设备，当帧立即停止驱动', () => {
  const h = harness();
  let unsubscribe = () => {};
  try {
    deviceTelemetryStore.upsert(snapshot());
    h.frame();
    const disabled = h.makeModel('disabled');
    disabled.telemetryBinding!.enabled = false;
    h.entries.push({ entityId: 'disabled', model: disabled });
    telemetryRuntimeDiagnosticsStore.upsert('disabled', diagnostic());
    unsubscribe = telemetryRuntimeDiagnosticsStore.subscribe(() => {
      if (!telemetryRuntimeDiagnosticsStore.getSnapshot('disabled')) h.model.telemetryBinding!.enabled = false;
    });
    h.frame();
    assert.equal(h.calls.length, 1);
  } finally { unsubscribe(); h.dispose(); }
});

test('每帧新心跳的诊断只比较一次，并在通知订阅者前同步节点状态', () => {
  const h = harness();
  const stringify = JSON.stringify;
  let diagnosticSerializations = 0;
  let notifications = 0;
  const unsubscribe = telemetryRuntimeDiagnosticsStore.subscribe(() => {
    const current = telemetryRuntimeDiagnosticsStore.getSnapshot('one');
    if (!current) return;
    assert.equal(h.model.root.metadata.telemetryRuntime.lastReceivedAt, current.lastReceivedAt);
    notifications++;
  });
  try {
    const data = snapshot();
    deviceTelemetryStore.upsert(data);
    h.frame();
    JSON.stringify = ((value: unknown, ...args: unknown[]) => {
      if (value && typeof value === 'object' && 'nodeTargets' in value) diagnosticSerializations++;
      return (stringify as (...args: unknown[]) => string)(value, ...args);
    }) as typeof JSON.stringify;
    for (let frame = 0; frame < 120; frame++) { data.receivedAt++; h.frame(); }
    assert.equal(diagnosticSerializations, 240, '不能重复执行 current/input 两次诊断比较');
    assert.equal(notifications, 121);
    assert.equal(h.calls.length, 121);
    assert.equal(h.injections(), 1);
  } finally { JSON.stringify = stringify; unsubscribe(); h.dispose(); }
});

test('前一驱动组同步修改后续组数据源，后续设备当帧采用新快照', () => {
  const h = harness();
  try {
    const stacker = h.makeModel('stacker');
    stacker.stackerCapable = true;
    stacker.conveyorCapable = false;
    stacker.telemetryBinding = createDefaultTelemetryBinding('stacker');
    h.entries.push({ entityId: 'stacker', model: stacker });
    deviceTelemetryStore.upsert({ ...snapshot(), deviceType: 'stacker' });
    deviceTelemetryStore.upsert(snapshot({ movement_x: 1 }));
    deviceTelemetryStore.upsert({ ...snapshot({ movement_x: 2 }), sourceId: 'new-source' });
    const drivers = (h.runtime as unknown as { drivers: { deviceType: string; apply: () => void }[] }).drivers;
    drivers.find((driver) => driver.deviceType === 'stacker')!.apply = () => {
      h.model.telemetryBinding!.sourceId = 'new-source';
    };
    h.frame();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].fields.movement_x, 2);
  } finally { h.dispose(); }
});

function diagnostic(): TelemetryRuntimeDiagnosticInput {
  return { online: true, stale: false, faulted: false, conflict: false, lastReceivedAt: 123,
    errors: [], sourceId: 'default', deviceType: 'conveyor', assetCode: '001', topic: 'test',
    sequence: null, sourceTimestamp: null, fields: { value: 1 }, message: '',
    nodeTargets: [], boneTargets: [], animationTargets: [] };
}

test('相同诊断不创建字段副本、不重复 JSON 序列化，变化仍同步通知', () => {
  const store = new TelemetryRuntimeDiagnosticsStore();
  const input = diagnostic();
  let notifications = 0;
  store.subscribe(() => notifications++);
  store.upsert('one', input);
  const stringify = JSON.stringify;
  let serializations = 0;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { serializations++; return stringify(...args); }) as typeof JSON.stringify;
  try {
    for (let index = 0; index < 120; index++) assert.equal(store.upsert('one', input), false);
    assert.equal(serializations, 0);
  } finally { JSON.stringify = stringify; }
  input.fields.value = 2;
  assert.equal(store.getSnapshot('one')!.fields.value, 1, '对外快照继续与输入字段隔离');
  assert.equal(store.upsert('one', input), true);
  assert.equal(notifications, 2);
  input.lastReceivedAt = input.lastReceivedAt! + 1;
  assert.equal(store.upsert('one', input), true);
});
