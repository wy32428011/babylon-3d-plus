import assert from 'node:assert/strict';
import test from 'node:test';

import { AnimationGroup, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import type { ModelAssetComponent } from '../../src/editor/model/components';
import type { TelemetryBindingComponent, TelemetryMotionChannel } from '../../src/editor/model/telemetryBinding';
import { GenericTelemetryMotionRuntime } from '../../src/runtime/babylon/telemetry/GenericTelemetryMotionRuntime';
import { compileTelemetryMotionBinding } from '../../src/runtime/babylon/telemetry/motionBindingCompiler';
import { mapTelemetryMotionValue } from '../../src/runtime/babylon/telemetry/motionValue';
import { DeviceTelemetryStore, type DeviceTelemetrySnapshot } from '../../src/runtime/mqtt/deviceTelemetry';
import { TelemetryRuntimeDiagnosticsStore } from '../../src/runtime/mqtt/telemetryRuntimeDiagnostics';

test('TelemetryRuntimeDiagnosticsStore 内容不变时不重复通知', () => {
  const diagnosticsStore = new TelemetryRuntimeDiagnosticsStore();
  let notifyCount = 0;
  diagnosticsStore.subscribe(() => { notifyCount += 1; });

  const diagnostic = {
    online: true,
    stale: false,
    faulted: false,
    conflict: false,
    lastReceivedAt: 1000,
    errors: [],
    sourceId: 'default',
    deviceType: 'generic-device',
    assetCode: 'GEN-01',
    topic: 'test/topic',
    sequence: 1,
    sourceTimestamp: 900,
    fields: { x: 1 },
    message: '',
    nodeTargets: ['Arm'],
    boneTargets: [],
    animationTargets: ['Run'],
  };

  assert.equal(diagnosticsStore.upsert('entity', diagnostic), true);
  assert.equal(diagnosticsStore.upsert('entity', diagnostic), false);
  assert.equal(notifyCount, 1);
  assert.equal(diagnosticsStore.getSnapshot('entity')?.fields.x, 1);

  assert.equal(diagnosticsStore.upsert('entity', { ...diagnostic, fields: { x: 2 } }), true);
  assert.equal(notifyCount, 2);
  assert.equal(diagnosticsStore.delete('entity'), true);
  assert.equal(diagnosticsStore.getSnapshot('entity'), null);
});

test('字段回退、数值 actionMap 和映射 clamp 可独立计算', () => {
  assert.equal(mapTelemetryMotionValue({ fields: { backup: 2 }, channel: channel({ fields: ['missing', 'backup'], scale: 3, offset: 1, min: 0, max: 5 }) }), 5);
  assert.equal(mapTelemetryMotionValue({ fields: { state: 'run' }, channel: channel({ fields: ['state'], actionMap: { stop: 0, run: 2 }, speed: 4 }) }), 2);
  assert.equal(mapTelemetryMotionValue({ fields: { v: 3 }, channel: channel({ fields: ['v'], invert: true, offset: 1 }) }), -4);
});

test('合并模型 dataDriven、脚本 fallback 与实例 channelOverrides，并补齐默认绑定和 assetCode', () => {
  const modelAsset = createModelAsset({
    assetCode: 'GEN-01',
    dataDrivenConfig: {
      device: { devType: 'generic-crane', defaultAssetCode: 'MODEL-DEFAULT', interpolationMs: 80 },
      motion: { x: channel({ fields: ['x'], target: { kind: 'root' }, property: 'position', axis: 'x' }) },
      fixedNodes: [],
    },
  });
  const binding: TelemetryBindingComponent = {
    enabled: true,
    sourceId: 'line-a',
    deviceType: 'generic-crane',
    expectedIntervalMs: 100,
    staleAfterMs: 500,
    channelOverrides: { x: channel({ fields: ['overrideX'], target: { kind: 'root' }, property: 'position', axis: 'x', scale: 2 }) },
  };
  const compiled = compileTelemetryMotionBinding({
    entityId: 'entity-a',
    modelAsset,
    binding,
    externalDataDrivenConfigs: [{ device: { devType: 'generic-crane', interpolationMs: 200 }, motion: { y: channel({ fields: ['y'], property: 'position', axis: 'y' }) } }],
  });

  assert.ok(compiled);
  assert.equal(compiled.key, 'line-a\u0000generic-crane\u0000GEN-01');
  assert.equal(compiled.binding.assetCode, 'GEN-01');
  assert.equal(compiled.channels.x.fields[0], 'overrideX');
  assert.equal(compiled.channels.x.scale, 2);
  assert.equal(compiled.channels.y.fields[0], 'y');

  const defaultCompiled = compileTelemetryMotionBinding({ entityId: 'entity-b', modelAsset, binding: null, externalDataDrivenConfigs: [] });
  assert.ok(defaultCompiled);
  assert.equal(defaultCompiled.binding.deviceType, 'generic-crane');
  assert.equal(defaultCompiled.binding.assetCode, 'GEN-01');
});

test('absolute 使用基线，EMA/linear 平滑，rotation 使用 quaternion 且角度输入按度转换', () => {
  const fixture = createRuntimeFixture();
  const root = new TransformNode('Root', fixture.scene);
  root.position.x = 10;
  const modelAsset = createModelAsset({
    dataDrivenConfig: {
      device: { devType: 'generic-device', interpolationMs: 100 },
      motion: {
        x: channel({ fields: ['x'], target: { kind: 'root' }, property: 'position', axis: 'x', smoothing: { kind: 'ema', alpha: 0.5 } }),
        y: channel({ fields: ['y'], target: { kind: 'root' }, property: 'position', axis: 'y', smoothing: { kind: 'linear', durationMs: 100 } }),
        r: channel({ fields: ['r'], target: { kind: 'root' }, property: 'rotation', axis: 'z' }),
      },
      fixedNodes: [],
    },
  });
  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [] });
  fixture.store.upsert(snapshot({ fields: { x: 4, y: 8, r: 90 }, receivedAt: 1000 }));

  fixture.runtime.applyFrame(0.05, 1000);
  assert.equal(root.position.x, 12);
  assert.equal(root.position.y, 4);
  assert.ok(root.rotationQuaternion);
  assert.ok(Math.abs(root.rotationQuaternion.toEulerAngles().z - Math.PI / 2) < 0.0001);

  fixture.runtime.applyFrame(0.05, 1050);
  assert.equal(root.position.y, 8);
  fixture.dispose();
});

test('velocity 按 dt 积分并 clamp，stale 冻结后恢复继续平滑接入', () => {
  const fixture = createRuntimeFixture();
  const root = new TransformNode('Root', fixture.scene);
  const modelAsset = createModelAsset({
    dataDrivenConfig: {
      device: { devType: 'generic-device', interpolationMs: 200 },
      motion: { move: channel({ fields: ['speed'], mode: 'velocity', target: { kind: 'root' }, property: 'position', axis: 'x', speed: 2, min: 0, max: 3 }) },
      fixedNodes: [],
    },
  });
  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: { ...defaultBinding(), staleAfterMs: 100 }, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [] });
  fixture.store.upsert(snapshot({ fields: { speed: 1 }, receivedAt: 1000 }));

  fixture.runtime.applyFrame(1, 1000);
  assert.equal(root.position.x, 2);
  fixture.runtime.applyFrame(1, 1201);
  assert.equal(root.position.x, 2);
  assert.equal(root.metadata.telemetryRuntime.stale, true);

  fixture.store.upsert(snapshot({ fields: { speed: 1.5 }, sequence: 2, receivedAt: 1300 }));
  fixture.runtime.applyFrame(1, 1300);
  assert.equal(root.position.x, 3);
  assert.equal(root.metadata.telemetryRuntime.online, true);
  assert.equal(root.metadata.telemetryRuntime.stale, false);
  fixture.dispose();
});

test('节点精确选择过滤父子重复目标，fallbackPattern 仅显式配置时使用', () => {
  const fixture = createRuntimeFixture();
  const root = new TransformNode('Root', fixture.scene);
  const parent = new TransformNode('Arm', fixture.scene);
  const child = new TransformNode('ArmTip', fixture.scene);
  const fallback = new TransformNode('FallbackWheel', fixture.scene);
  parent.parent = root;
  child.parent = parent;
  fallback.parent = root;
  const modelAsset = createModelAsset({
    dataDrivenConfig: {
      device: { devType: 'generic-device', interpolationMs: 200 },
      motion: {
        exact: channel({ fields: ['x'], target: { kind: 'node', selectors: ['Arm', 'ArmTip'] }, property: 'position', axis: 'x' }),
        fallback: channel({ fields: ['z'], target: { kind: 'node', fallbackPattern: 'Wheel$' }, property: 'position', axis: 'z' }),
      },
      fixedNodes: [],
    },
  });
  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [] });
  fixture.store.upsert(snapshot({ fields: { x: 5, z: 7 }, receivedAt: 1000 }));

  fixture.runtime.applyFrame(0.016, 1000);
  assert.equal(parent.position.x, 5);
  assert.equal(child.position.x, 0);
  assert.equal(fallback.position.z, 7);
  fixture.dispose();
});

test('同一绑定键匹配多个通用模型时全部停止并标记 conflict', () => {
  const fixture = createRuntimeFixture();
  const first = new TransformNode('First', fixture.scene);
  const second = new TransformNode('Second', fixture.scene);
  const modelAsset = createModelAsset({ dataDrivenConfig: { device: { devType: 'generic-device', interpolationMs: 200 }, motion: { x: channel({ fields: ['x'], property: 'position', axis: 'x' }) }, fixedNodes: [] } });
  fixture.runtime.syncModel({ entityId: 'a', root: first, contentRoot: first, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [] });
  fixture.runtime.syncModel({ entityId: 'b', root: second, contentRoot: second, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [] });
  fixture.store.upsert(snapshot({ fields: { x: 9 }, receivedAt: 1000 }));

  fixture.runtime.applyFrame(0.016, 1000);
  assert.equal(first.position.x, 0);
  assert.equal(second.position.x, 0);
  assert.equal(first.metadata.telemetryRuntime.conflict, true);
  assert.equal(second.metadata.telemetryRuntime.conflict, true);
  fixture.dispose();
});

test('动画通道只在状态边沿执行，找不到组会禁用该通道并记录错误', () => {
  const fixture = createRuntimeFixture();
  const root = new TransformNode('Root', fixture.scene);
  const group = new AnimationGroup('Run', fixture.scene);
  let playCount = 0;
  let pauseCount = 0;
  group.play = ((loop?: boolean) => { playCount += loop ? 1 : 1; return group; }) as AnimationGroup['play'];
  group.pause = (() => { pauseCount += 1; return group; }) as AnimationGroup['pause'];
  const modelAsset = createModelAsset({
    dataDrivenConfig: {
      device: { devType: 'generic-device', interpolationMs: 200 },
      motion: {
        anim: channel({ fields: ['state'], mode: 'state', target: { kind: 'animation', selector: 'Run' }, actionMap: { run: 'play', idle: 'pause' }, animation: { loop: true, speed: 1.5, blend: 0.3 } }),
        missing: channel({ fields: ['missing'], mode: 'state', target: { kind: 'animation', selector: 'Missing' }, actionMap: { run: 'play' } }),
      },
      fixedNodes: [],
    },
  });
  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [group] });
  fixture.store.upsert(snapshot({ fields: { state: 'run', missing: 'run' }, receivedAt: 1000 }));

  fixture.runtime.applyFrame(0.016, 1000);
  fixture.runtime.applyFrame(0.016, 1016);
  assert.equal(playCount, 1);
  assert.equal(group.speedRatio, 1.5);
  assert.match(root.metadata.telemetryRuntime.errors.join('\n'), /Missing/);

  fixture.store.upsert(snapshot({ fields: { state: 'idle' }, sequence: 2, receivedAt: 1100 }));
  fixture.runtime.applyFrame(0.016, 1100);
  assert.equal(pauseCount, 1);
  fixture.dispose();
});

test('未知动画动作只记录错误且不阻断其他通道', () => {
  const fixture = createRuntimeFixture();
  const root = new TransformNode('Root', fixture.scene);
  const group = new AnimationGroup('Run', fixture.scene);
  let playCount = 0;
  let pauseCount = 0;
  let stopCount = 0;
  let startCount = 0;
  group.play = (() => { playCount += 1; return group; }) as AnimationGroup['play'];
  group.pause = (() => { pauseCount += 1; return group; }) as AnimationGroup['pause'];
  group.stop = (() => { stopCount += 1; return group; }) as AnimationGroup['stop'];
  group.start = (() => { startCount += 1; return group; }) as AnimationGroup['start'];
  const modelAsset = createModelAsset({
    dataDrivenConfig: {
      device: { devType: 'generic-device', interpolationMs: 200 },
      motion: {
        anim: channel({ fields: ['state'], mode: 'state', target: { kind: 'animation', selector: 'Run' }, actionMap: { bad: 'jump' } }),
        x: channel({ fields: ['x'], target: { kind: 'root' }, property: 'position', axis: 'x' }),
      },
      fixedNodes: [],
    },
  });
  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [group] });
  fixture.store.upsert(snapshot({ fields: { state: 'bad', x: 4 }, receivedAt: 1000 }));

  fixture.runtime.applyFrame(0.016, 1000);
  assert.equal(playCount + pauseCount + stopCount + startCount, 0);
  assert.equal(root.position.x, 4);
  assert.match(root.metadata.telemetryRuntime.errors.join('\n'), /未知动画动作 jump/);

  fixture.store.upsert(snapshot({ fields: { state: 'bad', x: 6 }, sequence: 2, receivedAt: 1100 }));
  fixture.runtime.applyFrame(0.016, 1100);
  assert.equal(playCount + pauseCount + stopCount + startCount, 0);
  assert.equal(root.position.x, 6);
  assert.match(root.metadata.telemetryRuntime.errors.join('\n'), /通道 anim/);
  fixture.dispose();
});

test('stale 暂停持续动画且恢复后相同动作只续播一次', () => {
  const fixture = createRuntimeFixture();
  const root = new TransformNode('Root', fixture.scene);
  const group = new AnimationGroup('Run', fixture.scene);
  let playCount = 0;
  let pauseCount = 0;
  group.play = (() => { playCount += 1; return group; }) as AnimationGroup['play'];
  group.pause = (() => { pauseCount += 1; return group; }) as AnimationGroup['pause'];
  const modelAsset = createModelAsset({
    dataDrivenConfig: {
      device: { devType: 'generic-device', interpolationMs: 200 },
      motion: {
        anim: channel({ fields: ['state'], mode: 'state', target: { kind: 'animation', selector: 'Run' }, actionMap: { run: 'play' }, animation: { loop: true } }),
      },
      fixedNodes: [],
    },
  });
  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: { ...defaultBinding(), staleAfterMs: 100 }, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [group] });
  fixture.store.upsert(snapshot({ fields: { state: 'run' }, receivedAt: 1000 }));

  fixture.runtime.applyFrame(0.016, 1000);
  assert.equal(playCount, 1);
  fixture.runtime.applyFrame(0.016, 1101);
  fixture.runtime.applyFrame(0.016, 1120);
  assert.equal(pauseCount, 1);
  assert.equal(root.metadata.telemetryRuntime.stale, true);

  fixture.store.upsert(snapshot({ fields: { state: 'run', heartbeat: 2 }, sequence: 2, receivedAt: 1200 }));
  fixture.runtime.applyFrame(0.016, 1200);
  fixture.runtime.applyFrame(0.016, 1216);
  assert.equal(playCount, 2);
  assert.equal(root.metadata.telemetryRuntime.stale, false);
  fixture.dispose();
});

test('faulted 时停止 transform 通道但允许故障动画边沿执行', () => {
  const fixture = createRuntimeFixture();
  const root = new TransformNode('Root', fixture.scene);
  const group = new AnimationGroup('Fault', fixture.scene);
  let playCount = 0;
  group.play = (() => { playCount += 1; return group; }) as AnimationGroup['play'];
  const modelAsset = createModelAsset({
    dataDrivenConfig: {
      device: { devType: 'generic-device', interpolationMs: 200 },
      motion: {
        x: channel({ fields: ['x'], target: { kind: 'root' }, property: 'position', axis: 'x' }),
        fault: channel({ fields: ['faultState'], mode: 'state', target: { kind: 'animation', selector: 'Fault' }, actionMap: { fault: 'play' } }),
      },
      fixedNodes: [],
    },
  });
  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [group] });
  fixture.store.upsert(snapshot({ fields: { x: 9, faultState: 'fault' }, faulted: true, receivedAt: 1000 }));

  fixture.runtime.applyFrame(0.016, 1000);
  assert.equal(root.position.x, 0);
  assert.equal(playCount, 1);
  assert.equal(root.metadata.telemetryRuntime.faulted, true);
  fixture.dispose();
});

test('同名通道合并优先级为模型覆盖脚本且实例覆盖最优先', () => {
  const modelAsset = createModelAsset({
    dataDrivenConfig: {
      device: { devType: 'generic-device', interpolationMs: 200 },
      motion: { x: channel({ fields: ['modelX'], scale: 2 }) },
      fixedNodes: [],
    },
  });
  const scriptConfig = { device: { devType: 'generic-device', interpolationMs: 200 }, motion: { x: channel({ fields: ['scriptX'], scale: 9 }), y: channel({ fields: ['scriptY'], axis: 'y' }) } };

  const modelWins = compileTelemetryMotionBinding({ entityId: 'entity', modelAsset, binding: null, externalDataDrivenConfigs: [scriptConfig] });
  assert.ok(modelWins);
  assert.equal(modelWins.channels.x.fields[0], 'modelX');
  assert.equal(modelWins.channels.x.scale, 2);
  assert.equal(modelWins.channels.y.fields[0], 'scriptY');

  const overrideWins = compileTelemetryMotionBinding({
    entityId: 'entity',
    modelAsset,
    binding: { ...defaultBinding(), channelOverrides: { x: channel({ fields: ['overrideX'], scale: 4 }) } },
    externalDataDrivenConfigs: [scriptConfig],
  });
  assert.ok(overrideWins);
  assert.equal(overrideWins.channels.x.fields[0], 'overrideX');
  assert.equal(overrideWins.channels.x.scale, 4);
});

test('baselineRevision 变化后重建状态并按新基线计算 absolute', () => {
  const fixture = createRuntimeFixture();
  const root = new TransformNode('Root', fixture.scene);
  root.position.x = 10;
  const modelAsset = createModelAsset({ dataDrivenConfig: { device: { devType: 'generic-device', interpolationMs: 200 }, motion: { x: channel({ fields: ['x'], property: 'position', axis: 'x' }) }, fixedNodes: [] } });
  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [] });
  fixture.store.upsert(snapshot({ fields: { x: 5 }, receivedAt: 1000 }));
  fixture.runtime.applyFrame(0.016, 1000);
  assert.equal(root.position.x, 15);

  root.position.x = 20;
  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r2', animationGroups: [] });
  fixture.store.upsert(snapshot({ fields: { x: 5 }, sequence: 2, receivedAt: 1100 }));
  fixture.runtime.applyFrame(0.016, 1100);
  assert.equal(root.position.x, 25);
  fixture.dispose();
});

test('动画组限定在当前模型容器快照内，同名组不会跨模型串用', () => {
  const fixture = createRuntimeFixture();
  const firstRoot = new TransformNode('FirstRoot', fixture.scene);
  const secondRoot = new TransformNode('SecondRoot', fixture.scene);
  const firstGroup = new AnimationGroup('Run', fixture.scene);
  const secondGroup = new AnimationGroup('Run', fixture.scene);
  let firstPlayCount = 0;
  let secondPlayCount = 0;
  firstGroup.play = (() => { firstPlayCount += 1; return firstGroup; }) as AnimationGroup['play'];
  secondGroup.play = (() => { secondPlayCount += 1; return secondGroup; }) as AnimationGroup['play'];
  const firstAsset = createModelAsset({ assetCode: 'GEN-01', dataDrivenConfig: { device: { devType: 'generic-device', interpolationMs: 200 }, motion: { anim: channel({ fields: ['state'], mode: 'state', target: { kind: 'animation', selector: 'Run' }, actionMap: { run: 'play' } }) }, fixedNodes: [] } });
  const secondAsset = createModelAsset({ assetCode: 'GEN-02', dataDrivenConfig: firstAsset.dataDrivenConfig });
  fixture.runtime.syncModel({ entityId: 'first', root: firstRoot, contentRoot: firstRoot, modelAsset: firstAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [firstGroup] });
  fixture.runtime.syncModel({ entityId: 'second', root: secondRoot, contentRoot: secondRoot, modelAsset: secondAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [secondGroup] });
  fixture.store.upsert(snapshot({ assetCode: 'GEN-02', fields: { state: 'run' }, receivedAt: 1000 }));

  fixture.runtime.applyFrame(0.016, 1000);
  assert.equal(firstPlayCount, 0);
  assert.equal(secondPlayCount, 1);
  fixture.dispose();
});

test('reverse 动画边沿使用负 speedRatio 从 to 到 from 启动', () => {
  const fixture = createRuntimeFixture();
  const root = new TransformNode('Root', fixture.scene);
  const group = new AnimationGroup('Run', fixture.scene);
  let startArgs: unknown[] | null = null;
  group.start = ((...args: unknown[]) => { startArgs = args; return group; }) as AnimationGroup['start'];
  const modelAsset = createModelAsset({ dataDrivenConfig: { device: { devType: 'generic-device', interpolationMs: 200 }, motion: { anim: channel({ fields: ['state'], mode: 'state', target: { kind: 'animation', selector: 'Run' }, actionMap: { reverse: 'reverse' }, animation: { loop: false, speed: 2 } }) }, fixedNodes: [] } });
  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [group] });
  fixture.store.upsert(snapshot({ fields: { state: 'reverse' }, receivedAt: 1000 }));

  fixture.runtime.applyFrame(0.016, 1000);
  assert.ok(startArgs);
  assert.equal(startArgs[1], -2);
  assert.equal(startArgs[2], group.to);
  assert.equal(startArgs[3], group.from);
  fixture.dispose();
});

test('world position 使用绝对坐标基线，父节点位移下不产生错位', () => {
  const fixture = createRuntimeFixture();
  const parent = new TransformNode('Parent', fixture.scene);
  const root = new TransformNode('Root', fixture.scene);
  parent.position.x = 100;
  root.parent = parent;
  root.position.x = 10;
  const modelAsset = createModelAsset({ dataDrivenConfig: { device: { devType: 'generic-device', interpolationMs: 200 }, motion: { x: channel({ fields: ['x'], target: { kind: 'root' }, property: 'position', axis: 'x', space: 'world' }) }, fixedNodes: [] } });
  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [] });
  fixture.store.upsert(snapshot({ fields: { x: 5 }, receivedAt: 1000 }));

  fixture.runtime.applyFrame(0.016, 1000);
  assert.equal(root.getAbsolutePosition().x, 115);
  assert.equal(root.position.x, 15);
  fixture.dispose();
});

test('通用运行时同步诊断 store 并在无绑定、专用驱动和释放时清理', () => {
  const fixture = createRuntimeFixture();
  const root = new TransformNode('Root', fixture.scene);
  const child = new TransformNode('Arm', fixture.scene);
  child.parent = root;
  const animationGroup = new AnimationGroup('Run', fixture.scene);
  const modelAsset = createModelAsset({
    dataDrivenConfig: {
      device: { devType: 'generic-device', interpolationMs: 100 },
      motion: { x: channel({ fields: ['x'], target: { kind: 'root' }, property: 'position', axis: 'x' }) },
      fixedNodes: [],
    },
  });

  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [animationGroup] });
  fixture.store.upsert(snapshot({ fields: { x: 4 }, sourceTimestamp: 900, sequence: 7, receivedAt: 1000, message: 'ok' }));
  fixture.runtime.applyFrame(0.016, 1000);

  const diagnostic = fixture.diagnosticsStore.getSnapshot('entity');
  assert.ok(diagnostic);
  assert.equal(diagnostic.online, true);
  assert.equal(diagnostic.sourceId, 'default');
  assert.equal(diagnostic.deviceType, 'generic-device');
  assert.equal(diagnostic.assetCode, 'GEN-01');
  assert.equal(diagnostic.topic, 'test/topic');
  assert.equal(diagnostic.sequence, 7);
  assert.equal(diagnostic.sourceTimestamp, 900);
  assert.equal(diagnostic.fields.x, 4);
  assert.equal(diagnostic.message, 'ok');
  assert.equal(diagnostic.nodeTargets.includes('Arm'), true);
  assert.deepEqual(diagnostic.animationTargets, ['Run']);

  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: { ...defaultBinding(), enabled: false }, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 2, baselineRevision: 'r1', animationGroups: [] });
  assert.equal(fixture.diagnosticsStore.getSnapshot('entity'), null);

  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 3, baselineRevision: 'r1', animationGroups: [] });
  fixture.runtime.applyFrame(0.016, 1000);
  assert.ok(fixture.diagnosticsStore.getSnapshot('entity'));
  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: true, loadToken: 4, baselineRevision: 'r1', animationGroups: [] });
  assert.equal(fixture.diagnosticsStore.getSnapshot('entity'), null);

  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 5, baselineRevision: 'r1', animationGroups: [] });
  fixture.runtime.applyFrame(0.016, 1000);
  fixture.runtime.disposeModel('entity');
  assert.equal(fixture.diagnosticsStore.getSnapshot('entity'), null);
  fixture.dispose();
});

test('预览结束只停止遥测触发的动画并清理运行态诊断', () => {
  const fixture = createRuntimeFixture();
  const root = new TransformNode('Root', fixture.scene);
  const telemetryGroup = new AnimationGroup('TelemetryRun', fixture.scene);
  const manualGroup = new AnimationGroup('ManualRun', fixture.scene);
  let telemetryStopCount = 0;
  let manualStopCount = 0;
  telemetryGroup.play = (() => telemetryGroup) as AnimationGroup['play'];
  telemetryGroup.stop = (() => { telemetryStopCount += 1; return telemetryGroup; }) as AnimationGroup['stop'];
  manualGroup.stop = (() => { manualStopCount += 1; return manualGroup; }) as AnimationGroup['stop'];
  const modelAsset = createModelAsset({
    dataDrivenConfig: {
      device: { devType: 'generic-device', interpolationMs: 100 },
      motion: {
        anim: channel({ fields: ['state'], mode: 'state', target: { kind: 'animation', selector: 'TelemetryRun' }, actionMap: { run: 'play' } }),
        x: channel({ fields: ['x'], target: { kind: 'root' }, property: 'position', axis: 'x' }),
      },
      fixedNodes: [],
    },
  });

  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [telemetryGroup, manualGroup] });
  fixture.runtime.beginPreview();
  fixture.store.upsert(snapshot({ fields: { state: 'run', x: 4 }, receivedAt: 1000 }));
  fixture.runtime.applyFrame(0.016, 1000);
  assert.equal(root.position.x, 4);
  assert.ok(fixture.diagnosticsStore.getSnapshot('entity'));
  fixture.runtime.beginPreview();
  assert.equal(telemetryStopCount, 0);
  assert.equal(fixture.diagnosticsStore.getSnapshot('entity')?.online, true);

  fixture.runtime.endPreview();
  assert.equal(telemetryStopCount, 1);
  assert.equal(manualStopCount, 0);
  assert.equal(fixture.diagnosticsStore.getSnapshot('entity'), null);

  root.position.x = 0;
  fixture.runtime.beginPreview();
  fixture.store.upsert(snapshot({ fields: { state: 'run', x: 6 }, sequence: 2, receivedAt: 1100 }));
  fixture.runtime.applyFrame(0.016, 1100);
  assert.equal(root.position.x, 6);
  fixture.dispose();
});

test('同实体重同步新基线前停止旧遥测动画且不影响非遥测动画', () => {
  const fixture = createRuntimeFixture();
  const root = new TransformNode('Root', fixture.scene);
  const telemetryGroup = new AnimationGroup('TelemetryRun', fixture.scene);
  const manualGroup = new AnimationGroup('ManualRun', fixture.scene);
  let telemetryStopCount = 0;
  let manualStopCount = 0;
  telemetryGroup.play = (() => telemetryGroup) as AnimationGroup['play'];
  telemetryGroup.stop = (() => { telemetryStopCount += 1; return telemetryGroup; }) as AnimationGroup['stop'];
  manualGroup.stop = (() => { manualStopCount += 1; return manualGroup; }) as AnimationGroup['stop'];
  const modelAsset = createModelAsset({
    dataDrivenConfig: {
      device: { devType: 'generic-device', interpolationMs: 100 },
      motion: {
        anim: channel({ fields: ['state'], mode: 'state', target: { kind: 'animation', selector: 'TelemetryRun' }, actionMap: { run: 'play' } }),
      },
      fixedNodes: [],
    },
  });

  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [telemetryGroup, manualGroup] });
  fixture.runtime.beginPreview();
  fixture.store.upsert(snapshot({ fields: { state: 'run' }, receivedAt: 1000 }));
  fixture.runtime.applyFrame(0.016, 1000);

  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r2', animationGroups: [telemetryGroup, manualGroup] });

  assert.equal(telemetryStopCount, 1);
  assert.equal(manualStopCount, 0);
  assert.equal(fixture.diagnosticsStore.getSnapshot('entity'), null);
  fixture.dispose();
});

test('direct dispose 停止遥测动画并清除模型 metadata 与诊断', () => {
  const fixture = createRuntimeFixture();
  const root = new TransformNode('Root', fixture.scene);
  const telemetryGroup = new AnimationGroup('TelemetryRun', fixture.scene);
  const manualGroup = new AnimationGroup('ManualRun', fixture.scene);
  let telemetryStopCount = 0;
  let manualStopCount = 0;
  telemetryGroup.play = (() => telemetryGroup) as AnimationGroup['play'];
  telemetryGroup.stop = (() => { telemetryStopCount += 1; return telemetryGroup; }) as AnimationGroup['stop'];
  manualGroup.stop = (() => { manualStopCount += 1; return manualGroup; }) as AnimationGroup['stop'];
  const modelAsset = createModelAsset({
    dataDrivenConfig: {
      device: { devType: 'generic-device', interpolationMs: 100 },
      motion: {
        anim: channel({ fields: ['state'], mode: 'state', target: { kind: 'animation', selector: 'TelemetryRun' }, actionMap: { run: 'play' } }),
      },
      fixedNodes: [],
    },
  });

  fixture.runtime.syncModel({ entityId: 'entity', root, contentRoot: root, modelAsset, binding: null, externalDataDrivenConfigs: [], specializedDriver: false, loadToken: 1, baselineRevision: 'r1', animationGroups: [telemetryGroup, manualGroup] });
  fixture.runtime.beginPreview();
  fixture.store.upsert(snapshot({ fields: { state: 'run' }, receivedAt: 1000 }));
  fixture.runtime.applyFrame(0.016, 1000);
  assert.ok(root.metadata.telemetryRuntime);

  fixture.runtime.dispose();

  assert.equal(telemetryStopCount, 1);
  assert.equal(manualStopCount, 0);
  assert.equal(root.metadata.telemetryRuntime, undefined);
  assert.equal(fixture.diagnosticsStore.getSnapshot('entity'), null);
  fixture.scene.dispose();
  fixture.engine.dispose();
});

function createRuntimeFixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const store = new DeviceTelemetryStore();
  const diagnosticsStore = new TelemetryRuntimeDiagnosticsStore();
  const runtime = new GenericTelemetryMotionRuntime(scene, { telemetryStore: store, diagnosticsStore, pushLog: () => undefined });
  return { engine, scene, store, diagnosticsStore, runtime, dispose: () => { runtime.dispose(); scene.dispose(); engine.dispose(); } };
}

function channel(overrides: Partial<TelemetryMotionChannel> = {}): TelemetryMotionChannel {
  return { ...createChannel(), ...overrides };
}

function createChannel(): TelemetryMotionChannel {
  return {
    channel: 'channel',
    fields: ['value'],
    mode: 'absolute' as const,
    target: { kind: 'root' as const },
    property: 'position' as const,
    axis: 'x' as const,
    scale: 1,
    offset: 0,
    invert: false,
  };
}

function createModelAsset(overrides: Partial<ModelAssetComponent> = {}): ModelAssetComponent {
  return {
    assetCode: 'GEN-01',
    sourcePath: 'generic.glb',
    sourceUrl: 'generic.glb',
    lengthUnit: 'meter',
    unitScaleToMeters: 1,
    ...overrides,
  };
}

function defaultBinding(): TelemetryBindingComponent {
  return {
    enabled: true,
    sourceId: 'default',
    deviceType: 'generic-device',
    assetCode: 'GEN-01',
    expectedIntervalMs: 100,
    staleAfterMs: 300,
    channelOverrides: {},
  };
}

function snapshot(overrides: Partial<DeviceTelemetrySnapshot> = {}): DeviceTelemetrySnapshot {
  return {
    sourceId: 'default',
    topic: 'test/topic',
    deviceType: 'generic-device',
    assetCode: 'GEN-01',
    payloadDeviceCode: null,
    sourceTimestamp: null,
    sequence: 1,
    receivedAt: 1000,
    fields: {},
    currentLocationKey: null,
    targetLocationKey: null,
    hasTargetLocation: false,
    faulted: false,
    message: '',
    ...overrides,
  };
}
