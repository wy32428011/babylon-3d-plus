import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STACKER_MODEL_DIR = 'F:\\3d-models\\models\\Stacker';
const STACKER_MODEL_DIR = path.resolve(process.env.STACKER_MODEL_DIR || DEFAULT_STACKER_MODEL_DIR);
const STACKER_MODEL_FILE_PATH = path.join(STACKER_MODEL_DIR, 'Stacker.glb');
const STACKER_META_FILE_PATH = path.join(STACKER_MODEL_DIR, 'meta.json');
const STACKER_SCRIPT_FILE_PATH = path.join(STACKER_MODEL_DIR, 'stacker.model.ts');
const SCENE_FILE_PATH = path.join(WORKSPACE_ROOT, 'examples', 'scenes', 'stacker-mqtt-demo.scene.json');
const MQTT_TOPIC = 'dt/factory/logistics/stacker/+/twindatadriven/joint';
const MQTT_ADDRESS = 'ws://127.0.0.1:8083/mqtt';
const STACKER_ASSET_CODE = 'DDJ2';
const STACKER_SIMULATOR_INTERVAL_MS = 500;
const DEFAULT_MODEL_LENGTH_UNIT_INFO = { lengthUnit: 'meter', unitScaleToMeters: 1 };

/** 将本地文件路径转换为编辑器授权资产 URL。 */
function toEditorAssetUrl(filePath) {
  return `editor-asset://local/${encodeURIComponent(filePath)}`;
}

/** 创建编辑器场景使用的 Vector3 字面量。 */
function vector3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

/** 创建标准 Transform 组件，避免示例实体字段缺失。 */
function transform(position, rotation = vector3(), scale = vector3(1, 1, 1)) {
  return { position, rotation, scale };
}

/** 判断值是否为普通 JSON 对象，避免读取 meta/glTF 时误用数组或 null。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** 读取真实 Stacker 模型包元数据，保证 demo 使用 models 目录中的模型资产。 */
function readStackerMetadata() {
  assertStackerModelPackage();

  try {
    return JSON.parse(readFileSync(STACKER_META_FILE_PATH, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`读取 Stacker meta.json 失败：${message}`);
  }
}

/** 校验真实模型包必需文件，缺失时给出可执行的修复提示。 */
function assertStackerModelPackage() {
  const missingFiles = [
    STACKER_MODEL_FILE_PATH,
    STACKER_META_FILE_PATH,
    STACKER_SCRIPT_FILE_PATH,
  ].filter((filePath) => !existsSync(filePath));

  if (missingFiles.length === 0) return;

  throw new Error(
    [
      `未找到完整的 Stacker 模型包：${STACKER_MODEL_DIR}`,
      `缺失文件：${missingFiles.join(', ')}`,
      '可设置环境变量 STACKER_MODEL_DIR 指向包含 Stacker.glb、meta.json、stacker.model.ts 的模型包目录。',
    ].join('\n'),
  );
}

/** 创建外置脚本资产引用，运行时会通过 editor-asset 协议读取同包 TypeScript 脚本。 */
function createStackerScriptAssets() {
  return [
    {
      path: STACKER_SCRIPT_FILE_PATH,
      sourceUrl: toEditorAssetUrl(STACKER_SCRIPT_FILE_PATH),
      name: path.basename(STACKER_SCRIPT_FILE_PATH),
    },
  ];
}

/** 只保留 meta.json 中可被场景序列化器接受的数组元数据。 */
function readJsonArrayMetadata(metadata, key) {
  return Array.isArray(metadata?.[key]) ? JSON.parse(JSON.stringify(metadata[key])) : undefined;
}

/** 读取模型参数 schema，缺失时由编辑器按普通导入模型处理。 */
function readModelParameterConfig(metadata) {
  const config = metadata?.modelParameters;
  if (!config || typeof config !== 'object') return undefined;
  if (config.schema !== 'babylon-editor.model-parameters' || config.version !== 1) return undefined;
  if (!Array.isArray(config.parameters) || !Array.isArray(config.bindings)) return undefined;
  return JSON.parse(JSON.stringify(config));
}

/** 读取显式模型长度单位；缺失或空值按米，显式非法值直接拒绝。 */
function readLengthUnitInfo(metadata) {
  const lengthUnit = metadata?.lengthUnit;
  if (lengthUnit === undefined) return DEFAULT_MODEL_LENGTH_UNIT_INFO;
  if (typeof lengthUnit !== 'string') throw new Error(`Stacker 模型单位不受支持：${String(lengthUnit)}`);

  const normalizedUnit = lengthUnit.trim().toLowerCase();
  if (!normalizedUnit) return DEFAULT_MODEL_LENGTH_UNIT_INFO;
  if (normalizedUnit === 'meter' || normalizedUnit === 'm') return DEFAULT_MODEL_LENGTH_UNIT_INFO;
  if (normalizedUnit === 'millimeter' || normalizedUnit === 'mm') return { lengthUnit: 'millimeter', unitScaleToMeters: 0.001 };
  if (normalizedUnit === 'centimeter' || normalizedUnit === 'cm') return { lengthUnit: 'centimeter', unitScaleToMeters: 0.01 };
  throw new Error(`Stacker 模型单位不受支持：${lengthUnit}`);
}

/** 创建一个虚拟定位线框实体，用于 to_x/to_y/to_z 查找目标位。 */
function createLocatorEntity(id, name, assetId, position, size = { length: 1.1, width: 1.1, height: 1.1 }) {
  return {
    id,
    name,
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: transform(position),
      locator: {
        assetId,
        length: size.length,
        width: size.width,
        height: size.height,
      },
    },
  };
}

/** 创建库位演示场景，包含真实 Stacker、库位参数和外部 MQTT 配置。 */
function createSceneDocument() {
  const metadata = readStackerMetadata();
  const unitInfo = readLengthUnitInfo(metadata);
  const entityIds = [
    'entity_stacker_ddj2',
    'entity_locator_1_1_1',
    'entity_locator_1_2_1',
    'entity_locator_2_1_1',
    'entity_locator_2_2_1',
    'entity_floor_reference',
    'entity_demo_light',
  ];
  const parameterConfig = readModelParameterConfig(metadata);
  const parameterScriptMetadata = readJsonArrayMetadata(metadata, 'parameterScripts');
  const animationScriptMetadata = readJsonArrayMetadata(metadata, 'animationScripts');

  return {
    version: 1,
    units: { length: 'meter' },
    scene: {
      id: 'scene_stacker_mqtt_demo',
      name: 'Stacker MQTT Demo',
      entityIds,
      entities: {
        entity_stacker_ddj2: {
          id: 'entity_stacker_ddj2',
          name: 'Stacker DDJ2',
          visible: true,
          locked: false,
          parentId: null,
          childrenIds: [],
          components: {
            transform: transform(vector3(0, 0, 0)),
            modelAsset: {
              assetCode: STACKER_ASSET_CODE,
              sourcePath: STACKER_MODEL_FILE_PATH,
              sourceUrl: toEditorAssetUrl(STACKER_MODEL_FILE_PATH),
              lengthUnit: unitInfo.lengthUnit,
              unitScaleToMeters: unitInfo.unitScaleToMeters,
              scriptAssets: createStackerScriptAssets(),
              ...(parameterScriptMetadata ? { parameterScriptMetadata } : {}),
              ...(animationScriptMetadata ? { animationScriptMetadata } : {}),
              ...(parameterConfig ? { parameterConfig } : {}),
            },
          },
        },
        entity_locator_1_1_1: createLocatorEntity('entity_locator_1_1_1', '库位 1-1-1', '1-1-1', vector3(0.9, 1.2, 4)),
        entity_locator_1_2_1: createLocatorEntity('entity_locator_1_2_1', '库位 1-2-1', '1-2-1', vector3(1.9, 1.2, 4)),
        entity_locator_2_1_1: createLocatorEntity('entity_locator_2_1_1', '库位 2-1-1', '2-1-1', vector3(0.9, 2.2, 8)),
        entity_locator_2_2_1: createLocatorEntity('entity_locator_2_2_1', '库位 2-2-1', '2-2-1', vector3(1.9, 2.2, 8)),
        entity_floor_reference: {
          id: 'entity_floor_reference',
          name: '运动参考地面',
          visible: true,
          locked: true,
          parentId: null,
          childrenIds: [],
          components: {
            transform: transform(vector3(0, -0.01, 5), vector3(), vector3(1, 1, 1)),
            meshRenderer: {
              meshKind: 'plane',
              materialColor: '#2a3844',
            },
          },
        },
        entity_demo_light: {
          id: 'entity_demo_light',
          name: 'Stacker 演示光源',
          visible: true,
          locked: false,
          parentId: null,
          childrenIds: [],
          components: {
            transform: transform(vector3(2, 5, -3)),
            light: {
              lightKind: 'point',
              intensity: 1.3,
            },
          },
        },
      },
      selectedEntityId: 'entity_stacker_ddj2',
      mqttConfig: {
        enabled: true,
        ip: '127.0.0.1',
        address: MQTT_ADDRESS,
        topic: MQTT_TOPIC,
        simulatorEnabled: false,
        simulatorAssetCode: STACKER_ASSET_CODE,
        simulatorScenario: 'cycle',
        simulatorIntervalMs: STACKER_SIMULATOR_INTERVAL_MS,
      },
    },
  };
}

/** 写入 JSON 文件，并保持缩进便于代码审阅。 */
function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 生成演示场景，模型固定引用 models 目录中的真实 Stacker 包。 */
function main() {
  mkdirSync(path.dirname(SCENE_FILE_PATH), { recursive: true });
  const sceneFile = createSceneDocument();
  const modelAsset = sceneFile.scene.entities.entity_stacker_ddj2.components.modelAsset;
  writeJson(SCENE_FILE_PATH, sceneFile);

  console.log(`已生成 Stacker MQTT 演示场景：${SCENE_FILE_PATH}`);
  console.log(`模型来源：${STACKER_MODEL_FILE_PATH}`);
  console.log(`模型脚本：${STACKER_SCRIPT_FILE_PATH}`);
  console.log(`模型单位：${modelAsset.lengthUnit} / ${modelAsset.unitScaleToMeters}`);
  console.log('场景默认关闭本地模拟，请运行 MQTT 库位任务脚本驱动近排/远排动作。');
}

main();
