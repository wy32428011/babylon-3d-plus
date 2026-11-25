import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';

import { createModelEntity } from '../../src/editor/model/SceneDocument';
import {
  isSpecializedTelemetryDeviceType,
  normalizeModelDataDrivenConfig,
  normalizeTelemetryBindingComponent,
  resolveModelTelemetryDataDrivenConfig,
} from '../../src/editor/model/telemetryBinding';
import {
  createDeviceTelemetrySnapshot,
  deviceTelemetryStore,
  parseDeviceTelemetryMessage,
  type DeviceTelemetrySnapshot,
} from '../../src/runtime/mqtt/deviceTelemetry';
import { RobotTelemetryDriver, readRobotArmAngles } from '../../src/runtime/babylon/telemetry/specialized/robotDriver';
import { RobotJointDebugSystem, ROBOT_JOINT_DEBUG_HOLD_SECONDS, ROBOT_JOINT_DEBUG_SEGMENT_SECONDS, ROBOT_JOINT_DEBUG_ZERO_SECONDS } from '../../src/runtime/babylon/telemetry/specialized/robotJointDebugSystem';
import { robotJointDebugSession } from '../../src/runtime/robotJointDebugSession';
import { isRobotRuntimeModel } from '../../src/runtime/babylon/telemetry/specialized/specializedModelAssets';
import { SpecializedTelemetryRuntime } from '../../src/runtime/babylon/telemetry/specialized/SpecializedTelemetryRuntime';
import type { SpecializedTelemetryHost } from '../../src/runtime/babylon/telemetry/specialized/types';
import type { ModelRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';

const LEFT_NODES = [
  'zuoshouyuandian01',
  'zuoshouyuandian02',
  'zuoshouyuandian03',
  'zuoshouyuandian04',
  'zuoshouyuandian05',
  'zuoshouyuandian06',
  'zuoshouyuandian07',
];
const RIGHT_NODES = [
  'youshouyuandian01',
  'youshouyuandian02',
  'youshouyuandian03',
  'youshouyuandian04',
  'youshouyuandian05',
  'youshouyuandian06',
  'youshouyuandian07',
];
const AXIS_NAMES = ['z', 'x', 'z', 'x', 'z', 'x', 'z'];
const AXES = [new Vector3(0, 0, 1), new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Vector3(1, 0, 0), new Vector3(0, 0, 1)];
const RIGHT_SAMPLE = [-1.25, -0.62, -0.14, -0.48, -0.16, -0.12, -0.1];

function createRobotEntity() {
  return createModelEntity(
    '机器人整合.glb',
    'editor-asset://local/机器人整合.glb',
    '具身机器人',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      device: { devType: 'robot', defaultAssetCode: 'SIM_WP3_01' },
      motion: {
        angleUnit: 'rad',
        arms: {
          L: { field: 'armJointL', nodes: LEFT_NODES, axes: AXIS_NAMES, signs: [1, 1, 1, 1, 1, 1, 1] },
          R: { field: 'armJointR', nodes: RIGHT_NODES, axes: AXIS_NAMES, signs: [1, 1, 1, 1, 1, 1, 1] },
        },
      },
      fixedNodes: ['shenti'],
    },
    undefined,
    undefined,
    undefined,
    'robot',
  );
}

function createRobotModel(scene: Scene) {
  const root = new TransformNode('robot-root', scene);
  const contentRoot = new TransformNode('robot-content', scene);
  contentRoot.parent = root;
  const joints = new Map<string, TransformNode>();
  for (const names of [LEFT_NODES, RIGHT_NODES]) {
    let parent = contentRoot;
    names.forEach((name, index) => {
      const node = new TransformNode(name, scene);
      node.parent = parent;
      node.rotationQuaternion = Quaternion.RotationAxis(new Vector3(0, 1, 0), index * 0.03);
      joints.set(name, node);
      parent = node;
    });
  }
  const finger = new TransformNode('zuoshouyuandian08', scene);
  finger.parent = joints.get(RIGHT_NODES[6])!;
  finger.rotationQuaternion = Quaternion.RotationAxis(new Vector3(1, 0, 0), 0.2);
  const entity = createRobotEntity();
  const model = {
    root,
    contentRoot,
    assetCode: 'SIM_WP3_01',
    assetHandle: {},
    stackerTelemetryReady: true,
    entitySnapshot: entity,
    telemetryBinding: entity.components.telemetryBinding,
    externalScriptRuntime: null,
  } as unknown as ModelRuntimeEntry;
  return { entity, model, joints, finger };
}

function createSnapshot(
  fields: Record<string, unknown>,
  receivedAt = Date.now(),
  sourceTimestamp: number | null = null,
): DeviceTelemetrySnapshot {
  return createDeviceTelemetrySnapshot({
    sourceId: 'default',
    topic: 'dt/factory/logistics/robot/SIM_WP3_01/twindatadriven/joint',
    deviceType: 'robot',
    assetCode: 'SIM_WP3_01',
    payloadDeviceCode: 'SIM_WP3_01',
    sourceTimestamp,
    sequence: null,
    fields,
  }, receivedAt);
}

function flattenAngles(fields: Record<string, unknown>, side: 'L' | 'R', values: number[]): void {
  values.forEach((value, index) => { fields[`armJoint${side}.${index}`] = value; });
}

function assertJointAngle(node: TransformNode, baseline: Quaternion, axis: Vector3, angle: number): void {
  const expected = baseline.multiply(Quaternion.RotationAxis(axis, angle));
  assert.ok(node.rotationQuaternion?.equalsWithEpsilon(expected, 1e-10),
    `关节 ${node.name} 实际 ${node.rotationQuaternion?.toString()}，期望 ${expected.toString()}`);
}

test('robot 模型包声明生成默认 MQTT 绑定并保留关节配置', () => {
  const entity = createRobotEntity();
  assert.equal(isSpecializedTelemetryDeviceType('robot'), true);
  assert.match(entity.components.modelAsset?.assetCode ?? '', /^SIM_WP3_01-/);
  assert.equal(entity.components.telemetryBinding?.deviceType, 'robot');
  assert.equal(entity.components.telemetryBinding?.assetCode, undefined);
  assert.equal(resolveModelTelemetryDataDrivenConfig({ deviceType: 'robot' })?.device.devType, 'robot');
  const normalized = normalizeModelDataDrivenConfig({
    device: { devType: 'robot' },
    motion: { angleUnit: 'deg', arms: { L: { nodes: LEFT_NODES, axes: ['z', 'x', 'z', 'x', 'z', 'x', 'z'] } } },
    fixedNodes: [],
  });
  assert.equal(normalized?.specializedMotion?.angleUnit, 'deg');
  assert.deepEqual(normalized?.specializedMotion?.arms, {
    L: { nodes: LEFT_NODES, axes: ['z', 'x', 'z', 'x', 'z', 'x', 'z'] },
  });
  const binding = normalizeTelemetryBindingComponent({
    ...entity.components.telemetryBinding,
    robotJointCalibration: {
      L: { offsetsDeg: [30, 'invalid'], axes: ['-y', 'x'] },
      R: { offsetsDeg: [0, 0, 0, 0, 0, 0, 0], signs: [1, 1, 1, 1, 1, 1, -1] },
    },
  });
  assert.deepEqual(binding?.robotJointCalibration, {
    L: { offsetsDeg: [30, 0, 0, 0, 0, 0, 0], axes: ['-y', 'x', 'z', 'z', 'z', 'z', 'z'] },
    R: { offsetsDeg: [0, 0, 0, 0, 0, 0, 0], signs: [1, 1, 1, 1, 1, 1, -1] },
  });
});

test('EPV 平铺关节字段和直接数组都按 0 到 6 读取', () => {
  const data = [
    { e: 'SIM_WP3_01', p: 'deviceCode', v: 'SIM_WP3_01' },
    { e: 'SIM_WP3_01', p: 'normal', v: 1 },
  ];
  RIGHT_SAMPLE.forEach((value, index) => {
    data.push({ e: 'SIM_WP3_01', p: `armJointR.${index}`, v: value });
  });
  const snapshot = parseDeviceTelemetryMessage(
    'dt/factory/logistics/robot/SIM_WP3_01/twindatadriven/joint',
    JSON.stringify({ data, ts: '2026-11-18T15:43:39.183094421+08:00' }),
  );
  assert.ok(snapshot);
  assert.equal(snapshot.deviceType, 'robot');
  assert.deepEqual(readRobotArmAngles(snapshot.fields, 'armJointR'), RIGHT_SAMPLE);
  assert.deepEqual(readRobotArmAngles({ armJointL: [0, 1, 2, 3, 4, 5, 6] }, 'armJointL'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(readRobotArmAngles({ armJointL: [0, 1], 'armJointL.1': 9 }, 'armJointL'), [0, 9, null, null, null, null, null]);
});

test('缺少模型包节点声明时不使用编辑器硬编码回退', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const { entity, model, joints } = createRobotModel(scene);
  entity.components.modelAsset!.dataDrivenConfig = {
    device: { devType: 'robot' },
    motion: true,
    specializedMotion: { angleUnit: 'rad' },
    fixedNodes: [],
  };
  const node = joints.get(RIGHT_NODES[0])!;
  const baseline = node.rotationQuaternion!.clone();
  const driver = new RobotTelemetryDriver();

  driver.applyToModel(model, createSnapshot({ 'armJointR.0': 1 }, Date.now(), 1000), 0);
  assert.ok(node.rotationQuaternion!.equalsWithEpsilon(baseline));
  assert.equal(driver.getDebugJointOffset(model, 'R', 0), null);
});

test('双臂 7 轴保留导入基线并按局部 Z/X 交替轴叠加弧度', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const { model, joints, finger } = createRobotModel(scene);
  const driver = new RobotTelemetryDriver();
  const fields: Record<string, unknown> = { armJointL: [0, 0, 0, 0, 0, 0, 0] };
  flattenAngles(fields, 'R', RIGHT_SAMPLE);
  const fingerBaseline = finger.rotationQuaternion!.clone();
  const baselines = new Map([...joints].map(([name, node]) => [name, node.rotationQuaternion!.clone()]));

  driver.applyToModel(model, createSnapshot(fields, Date.now(), 1000), 0);
  RIGHT_NODES.forEach((name, index) => {
    assertJointAngle(joints.get(name)!, baselines.get(name)!, AXES[index], RIGHT_SAMPLE[index]);
  });
  LEFT_NODES.forEach(name => {
    assert.ok(joints.get(name)!.rotationQuaternion!.equalsWithEpsilon(baselines.get(name)!));
  });
  assert.ok(finger.rotationQuaternion!.equalsWithEpsilon(fingerBaseline), '第七轴只转手掌父节点，不改夹爪本地姿态');

  driver.applyToModel(model, createSnapshot({ 'armJointR.2': 0.5 }, Date.now(), 2000), 1);
  assertJointAngle(joints.get(RIGHT_NODES[0])!, baselines.get(RIGHT_NODES[0])!, AXES[0], RIGHT_SAMPLE[0]);
  assertJointAngle(joints.get(RIGHT_NODES[2])!, baselines.get(RIGHT_NODES[2])!, AXES[2], 0.5);
  const beforeFault = joints.get(RIGHT_NODES[2])!.rotationQuaternion!.clone();
  driver.applyToModel(model, { ...createSnapshot({ 'armJointR.2': 1 }, Date.now(), 3000), faulted: true }, 1);
  assert.ok(joints.get(RIGHT_NODES[2])!.rotationQuaternion!.equalsWithEpsilon(beforeFault));
});

test('实例级零位偏置和正负转向轴参与校准，旧方向配置保持兼容', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const { entity, model, joints } = createRobotModel(scene);
  entity.components.telemetryBinding!.robotJointCalibration = {
    L: {
      offsetsDeg: [45, 0, 0, 0, 0, 0, 0],
      signs: [-1, 1, 1, 1, 1, 1, 1],
    },
    R: {
      offsetsDeg: [30, 0, 0, 0, 0, 0, 0],
      axes: ['-y', 'x', 'z', 'x', 'z', 'x', 'z'],
    },
  };
  const driver = new RobotTelemetryDriver();
  const left = joints.get(LEFT_NODES[0])!;
  const right = joints.get(RIGHT_NODES[0])!;
  const leftBaseline = left.rotationQuaternion!.clone();
  const rightBaseline = right.rotationQuaternion!.clone();

  driver.applyToModel(model, createSnapshot({ armJointL: [0], armJointR: [0.5] }, Date.now(), 1000), 0);
  assertJointAngle(left, leftBaseline, AXES[0], -Math.PI / 4);
  assertJointAngle(right, rightBaseline, Vector3.Up(), -0.5 - Math.PI / 6);

  entity.components.telemetryBinding!.robotJointCalibration.R!.offsetsDeg[0] = 60;
  driver.applyToModel(model, createSnapshot({ armJointR: [0.5] }, Date.now(), 2000), 0);
  assertJointAngle(right, rightBaseline, Vector3.Up(), -0.5 - Math.PI / 3);

  entity.components.telemetryBinding!.robotJointCalibration.R!.axes![0] = 'y';
  driver.applyToModel(model, createSnapshot({ armJointR: [0.5] }, Date.now(), 3000), 0);
  assertJointAngle(right, rightBaseline, Vector3.Up(), 0.5 + Math.PI / 3);
});

test('零位偏置为 0 时跳过预置和停留，直接开始往返动画', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const { entity, model } = createRobotModel(scene);
  const system = new RobotJointDebugSystem();
  t.after(() => {
    system.dispose();
    robotJointDebugSession.clear();
    scene.dispose();
    engine.dispose();
  });

  robotJointDebugSession.start(entity.id, 'R', 0);
  system.tick([{ entityId: entity.id, model }], false, 0);
  assert.equal(robotJointDebugSession.getSnapshot(entity.id).message, '正在调试');
  assert.equal(robotJointDebugSession.getSnapshot(entity.id).currentAngleDeg, 0);
  system.tick([{ entityId: entity.id, model }], false, 0.25);
  assert.ok(robotJointDebugSession.getSnapshot(entity.id).currentAngleDeg > 0);
});

test('单关节调试先到数据零位，再平滑往返并恢复模型原位', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const { entity, model, joints } = createRobotModel(scene);
  entity.components.telemetryBinding!.robotJointCalibration = {
    R: {
      offsetsDeg: [30, 0, 0, 0, 0, 0, 0],
      axes: ['-y', 'x', 'z', 'x', 'z', 'x', 'z'],
    },
  };
  const system = new RobotJointDebugSystem();
  const node = joints.get(RIGHT_NODES[0])!;
  const baseline = node.rotationQuaternion!.clone();
  const models = [{ entityId: entity.id, model }];
  t.after(() => {
    system.dispose();
    robotJointDebugSession.clear();
    scene.dispose();
    engine.dispose();
  });

  const advance = (seconds: number) => {
    const frameCount = Math.ceil(seconds / 0.25);
    for (let frame = 0; frame < frameCount; frame++) system.tick(models, false, seconds / frameCount);
  };

  robotJointDebugSession.start(entity.id, 'R', 0);
  advance(ROBOT_JOINT_DEBUG_ZERO_SECONDS / 2);
  assert.equal(robotJointDebugSession.getSnapshot(entity.id).currentAngleDeg, -15);
  assertJointAngle(node, baseline, Vector3.Up(), -Math.PI / 12);
  advance(ROBOT_JOINT_DEBUG_ZERO_SECONDS / 2);
  assert.equal(robotJointDebugSession.getSnapshot(entity.id).currentAngleDeg, 0);
  assertJointAngle(node, baseline, Vector3.Up(), -Math.PI / 6);
  advance(ROBOT_JOINT_DEBUG_HOLD_SECONDS / 2);
  assert.equal(robotJointDebugSession.getSnapshot(entity.id).message, '数据 0 位停留');
  assertJointAngle(node, baseline, Vector3.Up(), -Math.PI / 6);
  advance(ROBOT_JOINT_DEBUG_HOLD_SECONDS / 2);

  const expectedDegrees = [90, 180, 90, 0, -90, -180, -90, 0];
  for (const [index, degrees] of expectedDegrees.entries()) {
    advance(ROBOT_JOINT_DEBUG_SEGMENT_SECONDS / 2);
    assert.equal(robotJointDebugSession.getSnapshot(entity.id).currentAngleDeg, degrees);
    if (index < expectedDegrees.length - 1) {
      assertJointAngle(node, baseline, Vector3.Up(), (-30 - degrees) * Math.PI / 180);
      assert.equal(robotJointDebugSession.getSnapshot(entity.id).running, true);
    }
  }
  assert.equal(robotJointDebugSession.getSnapshot(entity.id).running, false);
  assert.ok(node.rotationQuaternion!.equalsWithEpsilon(baseline), '动画完成后恢复模型原位');

  robotJointDebugSession.start(entity.id, 'R', 0);
  system.tick(models, false, ROBOT_JOINT_DEBUG_SEGMENT_SECONDS / 2);
  assert.ok(!node.rotationQuaternion!.equalsWithEpsilon(baseline));
  robotJointDebugSession.stop(entity.id);
  system.tick(models, false, 0);
  assert.ok(node.rotationQuaternion!.equalsWithEpsilon(baseline), '中途停止也恢复模型原位');

  robotJointDebugSession.start(entity.id, 'R', 0);
  system.tick(models, false, ROBOT_JOINT_DEBUG_SEGMENT_SECONDS / 3);
  system.tick(models, true, 0);
  assert.ok(node.rotationQuaternion!.equalsWithEpsilon(baseline), '进入 MQTT 预览前恢复模型原位');
  assert.equal(robotJointDebugSession.getSnapshot(entity.id).request, null);
});

test('关节按相邻样本时间差线性平滑，新目标从当前角度承接', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const { model, joints } = createRobotModel(scene);
  const driver = new RobotTelemetryDriver();
  const node = joints.get(RIGHT_NODES[0])!;
  const baseline = node.rotationQuaternion!.clone();
  const receivedAt = Date.now();

  driver.applyToModel(model, createSnapshot({ 'armJointR.0': 0 }, receivedAt, 1000), 0);
  assertJointAngle(node, baseline, AXES[0], 0);
  const second = createSnapshot({ 'armJointR.0': 2 }, receivedAt + 1, 2000);
  driver.applyToModel(model, second, 0.25);
  assertJointAngle(node, baseline, AXES[0], 0.5);
  assert.equal(driver.hasPendingMotion(model), true);
  driver.applyToModel(model, second, 0.25);
  assertJointAngle(node, baseline, AXES[0], 1);

  const third = createSnapshot({ 'armJointR.0': -2 }, receivedAt + 2, 3000);
  driver.applyToModel(model, third, 0.5);
  assertJointAngle(node, baseline, AXES[0], -0.5);
  driver.applyToModel(model, third, 0.5);
  assertJointAngle(node, baseline, AXES[0], -2);
  assert.equal(driver.hasPendingMotion(model), false);
});

test('专用运行时按 robot 完整主键驱动，断流完成已开始的过渡后保持', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const { entity, model, joints } = createRobotModel(scene);
  const host = {
    collectModels: () => [{ entityId: entity.id, model }],
    pushLog: () => undefined,
    updateExternalScriptContext: () => false,
  } as unknown as SpecializedTelemetryHost;
  const runtime = new SpecializedTelemetryRuntime(scene, host);
  t.after(() => {
    runtime.dispose();
    deviceTelemetryStore.clear();
    scene.dispose();
    engine.dispose();
  });

  assert.equal(isRobotRuntimeModel(model), true);
  assert.equal(runtime.resolveDeviceType(model), 'robot');
  const receivedAt = Date.now();
  deviceTelemetryStore.upsert(createSnapshot({ 'armJointR.0': -1.25 }, receivedAt, 1000));
  runtime.applyFrame(1 / 60);
  const first = joints.get(RIGHT_NODES[0])!.rotationQuaternion!.clone();
  assert.ok(Math.abs(first.z) > 0.1);

  deviceTelemetryStore.upsert(createSnapshot({ 'armJointR.0': 0.8 }, receivedAt + 1, 2000));
  runtime.applyFrame(0);
  assert.ok(joints.get(RIGHT_NODES[0])!.rotationQuaternion!.equalsWithEpsilon(first));
  t.mock.method(Date, 'now', () => receivedAt + 10_000);
  runtime.applyFrame(0.5);
  assert.ok(!joints.get(RIGHT_NODES[0])!.rotationQuaternion!.equalsWithEpsilon(first), '断流应继续已经开始的过渡');
  runtime.applyFrame(0.5);
  const completed = joints.get(RIGHT_NODES[0])!.rotationQuaternion!.clone();
  runtime.applyFrame(1 / 60);
  assert.ok(joints.get(RIGHT_NODES[0])!.rotationQuaternion!.equalsWithEpsilon(completed), '到位后断流保持最后姿态');

  deviceTelemetryStore.upsert(createSnapshot({ 'armJointR.0': 0.8 }, receivedAt + 10_001, 3000));
  runtime.applyFrame(1 / 60);
  assert.ok(joints.get(RIGHT_NODES[0])!.rotationQuaternion!.equalsWithEpsilon(completed));
});
