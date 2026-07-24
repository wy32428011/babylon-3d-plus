import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PACKAGE_DIR = path.join(WORKSPACE_ROOT, 'examples', 'model-packages', 'ParameterChainDemo');
const SOURCE_GLTF_PATH = path.join(SOURCE_PACKAGE_DIR, 'ParameterChainDemo.gltf');
const TARGET_PACKAGE_DIR = path.join(WORKSPACE_ROOT, 'examples', 'model-packages', 'GenericMqttMotionDemo');
const TARGET_TEXTURES_DIR = path.join(TARGET_PACKAGE_DIR, 'textures');
const TARGET_GLTF_PATH = path.join(TARGET_PACKAGE_DIR, 'GenericMqttMotionDemo.gltf');
const TARGET_META_PATH = path.join(TARGET_PACKAGE_DIR, 'meta.json');
const SCENE_FILE_PATH = path.join(WORKSPACE_ROOT, 'examples', 'scenes', 'generic-mqtt-motion-demo.scene.json');
const MQTT_ADDRESS = 'ws://127.0.0.1:8083/mqtt';
const MQTT_TOPIC = 'dt/factory/logistics/generic-machine/+/twindatadriven/joint';
const DEVICE_TYPE = 'generic-machine';
const ASSET_CODES = ['GEN-A', 'GEN-B'];
const SIMULATOR_INTERVAL_MS = 250;
const STALE_AFTER_MS = 2000;
const DEFAULT_MODEL_LENGTH_UNIT_INFO = { lengthUnit: 'meter', unitScaleToMeters: 1 };

/** 将本机绝对路径转换为编辑器授权资产 URL。 */
function toEditorAssetUrl(filePath) {
  return `editor-asset://local/${encodeURIComponent(filePath)}`;
}

/** 创建编辑器场景使用的 Vector3 字面量。 */
function vector3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

/** 创建标准 Transform 组件，保证实体结构与编辑器序列化一致。 */
function transform(position, rotation = vector3(), scale = vector3(1, 1, 1)) {
  return { position, rotation, scale };
}

/** 写入 JSON 文件并保留稳定缩进，方便重复运行后 diff 可读。 */
function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 断言基础 ParameterChainDemo 包存在，避免误生成空资产。 */
function assertSourcePackage() {
  if (!existsSync(SOURCE_GLTF_PATH)) {
    throw new Error(`缺少基础 glTF：${SOURCE_GLTF_PATH}`);
  }
}

/** 读取并解析基础 glTF JSON，所有修改只写入复制后的目标 glTF。 */
function readSourceGltf() {
  assertSourcePackage();
  return JSON.parse(readFileSync(SOURCE_GLTF_PATH, 'utf8'));
}

/** 把 Float32 数组编码为 glTF data URI，避免依赖额外 .bin 文件。 */
function createFloatBufferDataUri(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return `data:application/octet-stream;base64,${buffer.toString('base64')}`;
}

/** 生成绕 Z 轴旋转的 glTF 四元数关键帧，用于 DoorPulse 动画。 */
function createZRotationQuaternions(degrees) {
  return degrees.flatMap((degree) => {
    const radians = degree * Math.PI / 180;
    return [0, 0, Math.sin(radians / 2), Math.cos(radians / 2)];
  });
}

/** 查找 ScreenSurface 节点索引，确保状态动画与 AccentPanel 关节通道互不争用。 */
function findDoorPulseTargetNodeIndex(gltf) {
  const index = gltf.nodes?.findIndex((node) => node?.name === 'ScreenSurface') ?? -1;
  if (index < 0) throw new Error('基础 glTF 中找不到 ScreenSurface 节点，无法生成 DoorPulse 动画。');
  return index;
}

/** 给复制后的 glTF 增加真实 DoorPulse animation，供 Babylon AssetContainer.animationGroups 读取。 */
function addDoorPulseAnimation(gltf) {
  const animationTargetNodeIndex = findDoorPulseTargetNodeIndex(gltf);
  const timeValues = [0, 0.5, 1];
  const rotationValues = createZRotationQuaternions([0, 18, 0]);
  const animationDataUri = createFloatBufferDataUri([...timeValues, ...rotationValues]);
  const bufferIndex = gltf.buffers.length;
  const inputBufferViewIndex = gltf.bufferViews.length;
  const outputBufferViewIndex = gltf.bufferViews.length + 1;
  const inputAccessorIndex = gltf.accessors.length;
  const outputAccessorIndex = gltf.accessors.length + 1;

  gltf.buffers.push({ byteLength: 60, uri: animationDataUri });
  gltf.bufferViews.push({ buffer: bufferIndex, byteOffset: 0, byteLength: 12 });
  gltf.bufferViews.push({ buffer: bufferIndex, byteOffset: 12, byteLength: 48 });
  gltf.accessors.push({ bufferView: inputBufferViewIndex, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [1] });
  gltf.accessors.push({ bufferView: outputBufferViewIndex, componentType: 5126, count: 3, type: 'VEC4' });
  gltf.animations = [
    ...(gltf.animations ?? []),
    {
      name: 'DoorPulse',
      samplers: [{ input: inputAccessorIndex, output: outputAccessorIndex, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: animationTargetNodeIndex, path: 'rotation' } }],
    },
  ];

  return gltf;
}

/** 复制 ParameterChainDemo 贴图，使新模型包完全独立且不改原包。 */
function copyPackageTextures() {
  mkdirSync(TARGET_TEXTURES_DIR, { recursive: true });
  for (const textureName of ['screen-grid.png', 'screen-stripes.png']) {
    copyFileSync(path.join(SOURCE_PACKAGE_DIR, 'textures', textureName), path.join(TARGET_TEXTURES_DIR, textureName));
  }
}

/** 创建通用 MQTT 运动模型包元数据，包含 dataDriven 通道约定。 */
function createModelMetadata() {
  const sourceMetadata = JSON.parse(readFileSync(path.join(SOURCE_PACKAGE_DIR, 'meta.json'), 'utf8'));
  return {
    ...sourceMetadata,
    displayName: 'Generic MQTT Motion Demo',
    lengthUnit: DEFAULT_MODEL_LENGTH_UNIT_INFO.lengthUnit,
    dataDriven: createDataDrivenConfig(),
  };
}

/** 创建模型包级 dataDriven 配置，覆盖 root、AccentPanel 和 DoorPulse 三类目标。 */
function createDataDrivenConfig() {
  return {
    device: {
      device: 'Generic MQTT Motion Demo',
      devType: DEVICE_TYPE,
      defaultAssetCode: 'GEN',
      interpolationMs: SIMULATOR_INTERVAL_MS,
    },
    motion: {
      position_x: {
        channel: 'position_x',
        fields: ['position_x'],
        mode: 'absolute',
        target: { kind: 'root' },
        property: 'position',
        axis: 'x',
        space: 'local',
        scale: 1,
        offset: 0,
        invert: false,
        min: -3,
        max: 3,
        smoothing: { kind: 'linear', durationMs: SIMULATOR_INTERVAL_MS },
      },
      joint_angle_deg: {
        channel: 'joint_angle_deg',
        fields: ['joint_angle_deg'],
        mode: 'absolute',
        target: { kind: 'node', selector: 'AccentPanel' },
        property: 'rotation',
        axis: 'z',
        space: 'local',
        scale: 1,
        offset: 0,
        invert: false,
        min: -60,
        max: 60,
        smoothing: { kind: 'linear', durationMs: SIMULATOR_INTERVAL_MS },
      },
      operation_state: {
        channel: 'operation_state',
        fields: ['operation_state'],
        mode: 'state',
        target: { kind: 'animation', selector: 'DoorPulse' },
        scale: 1,
        offset: 0,
        invert: false,
        actionMap: {
          forward: 'play',
          reverse: 'reverse',
          fault: 'play',
          recovery: 'play',
        },
        animation: { loop: false, speed: 1 },
      },
    },
    fixedNodes: [],
  };
}

/** 创建实体级 telemetryBinding，使两台模型各自绑定 GEN-A 与 GEN-B。 */
function createTelemetryBinding(assetCode) {
  return {
    enabled: true,
    sourceId: 'default',
    deviceType: DEVICE_TYPE,
    assetCode,
    expectedIntervalMs: SIMULATOR_INTERVAL_MS,
    staleAfterMs: STALE_AFTER_MS,
    channelOverrides: {},
  };
}

/** 创建模型资产组件，复用同一模型包但使用不同资产编号。 */
function createModelAsset(assetCode, parameterValues) {
  const metadata = createModelMetadata();
  return {
    assetCode,
    sourcePath: TARGET_GLTF_PATH,
    sourceUrl: toEditorAssetUrl(TARGET_GLTF_PATH),
    lengthUnit: DEFAULT_MODEL_LENGTH_UNIT_INFO.lengthUnit,
    unitScaleToMeters: DEFAULT_MODEL_LENGTH_UNIT_INFO.unitScaleToMeters,
    parameterConfig: metadata.modelParameters,
    parameterValues,
    dataDrivenConfig: createDataDrivenConfig(),
  };
}

/** 创建单台通用 MQTT 模型实体。 */
function createMachineEntity(id, name, assetCode, position, parameterValues) {
  return {
    id,
    name,
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: transform(position),
      modelAsset: createModelAsset(assetCode, parameterValues),
      telemetryBinding: createTelemetryBinding(assetCode),
    },
  };
}

/** 创建地面实体，给演示场景提供空间参照。 */
function createGroundEntity() {
  return {
    id: 'entity_generic_mqtt_ground',
    name: '通用 MQTT 演示地面',
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: transform(vector3(0, -0.02, 0), vector3(), vector3(5, 1, 3)),
      meshRenderer: { meshKind: 'plane', materialColor: '#2b3344' },
    },
  };
}

/** 创建场景灯光实体，保证自动加载后模型可见。 */
function createLightEntity() {
  return {
    id: 'entity_generic_mqtt_light',
    name: '通用 MQTT 演示灯光',
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: transform(vector3(0, 3.2, -2.4), vector3(0.6, 0, 0)),
      light: { lightKind: 'point', intensity: 1.2 },
    },
  };
}

/** 创建完整场景文档，包含两台通用模型、地面、灯光和 MQTT 配置。 */
function createSceneDocument() {
  const entities = {
    entity_generic_mqtt_gen_a: createMachineEntity(
      'entity_generic_mqtt_gen_a',
      'Generic MQTT Motion Demo - GEN-A',
      ASSET_CODES[0],
      vector3(-3, 0, 0),
      { bodyColor: '#2f86ff', cabinetHeight: 1.2, showAccentPanel: true, screenTexture: 'textures/screen-grid.png' },
    ),
    entity_generic_mqtt_gen_b: createMachineEntity(
      'entity_generic_mqtt_gen_b',
      'Generic MQTT Motion Demo - GEN-B',
      ASSET_CODES[1],
      vector3(3, 0, 0),
      { bodyColor: '#ef476f', cabinetHeight: 1.55, showAccentPanel: true, screenTexture: 'textures/screen-stripes.png' },
    ),
    entity_generic_mqtt_ground: createGroundEntity(),
    entity_generic_mqtt_light: createLightEntity(),
  };

  return {
    version: 2,
    units: { length: 'meter' },
    scene: {
      id: 'scene_generic_mqtt_motion_demo',
      name: 'Generic MQTT Motion Demo',
      entityIds: Object.keys(entities),
      entities,
      selectedEntityId: 'entity_generic_mqtt_gen_a',
      mqttConfig: {
        enabled: true,
        ip: '127.0.0.1',
        address: MQTT_ADDRESS,
        topic: MQTT_TOPIC,
        subscriptions: [{ topic: MQTT_TOPIC, qos: 0, adapter: { kind: 'epv', sourceId: 'default', deviceType: DEVICE_TYPE } }],
        simulatorEnabled: true,
        simulatorAssetCode: ASSET_CODES.join(','),
        simulatorScenario: 'generic',
        simulatorIntervalMs: SIMULATOR_INTERVAL_MS,
      },
    },
  };
}

/** 生成独立模型包，重复运行会覆盖 glTF、meta 和贴图。 */
function generateModelPackage() {
  mkdirSync(TARGET_PACKAGE_DIR, { recursive: true });
  copyPackageTextures();
  writeJson(TARGET_GLTF_PATH, addDoorPulseAnimation(readSourceGltf()));
  writeJson(TARGET_META_PATH, createModelMetadata());
}

/** 生成通用 MQTT 无 Broker 演示资产和场景，并输出全部生成路径。 */
function main() {
  generateModelPackage();
  mkdirSync(path.dirname(SCENE_FILE_PATH), { recursive: true });
  writeJson(SCENE_FILE_PATH, createSceneDocument());

  console.log(`已生成通用 MQTT 模型包：${TARGET_PACKAGE_DIR}`);
  console.log(`已生成 glTF：${TARGET_GLTF_PATH}`);
  console.log(`已生成 meta：${TARGET_META_PATH}`);
  console.log(`已生成场景：${SCENE_FILE_PATH}`);
  console.log(`演示约定：${DEVICE_TYPE} / ${ASSET_CODES.join(',')} / ${SIMULATOR_INTERVAL_MS}ms / stale ${STALE_AFTER_MS}ms`);
}

main();
