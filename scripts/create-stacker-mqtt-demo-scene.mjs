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

/** 创建 4x4 单位矩阵，用于读取 glTF 节点层级包围盒。 */
function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** 乘法合成 glTF 节点矩阵。 */
function multiplyMatrix(left, right) {
  const result = new Array(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      for (let index = 0; index < 4; index += 1) {
        result[row * 4 + column] += left[row * 4 + index] * right[index * 4 + column];
      }
    }
  }
  return result;
}

/** 使用矩阵变换 accessor 包围盒角点。 */
function transformPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    x * matrix[0] + y * matrix[4] + z * matrix[8] + matrix[12],
    x * matrix[1] + y * matrix[5] + z * matrix[9] + matrix[13],
    x * matrix[2] + y * matrix[6] + z * matrix[10] + matrix[14],
  ];
}

/** 从 glTF 节点 TRS 或 matrix 生成矩阵。 */
function matrixFromNode(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16 && node.matrix.every((value) => typeof value === 'number')) {
    return node.matrix;
  }

  const translation = Array.isArray(node.translation) && node.translation.length === 3 ? node.translation : [0, 0, 0];
  const scale = Array.isArray(node.scale) && node.scale.length === 3 ? node.scale : [1, 1, 1];
  const rotation = Array.isArray(node.rotation) && node.rotation.length === 4 ? node.rotation : [0, 0, 0, 1];
  const [x, y, z, w] = rotation;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  return [
    (1 - (yy + zz)) * scale[0], (xy + wz) * scale[0], (xz - wy) * scale[0], 0,
    (xy - wz) * scale[1], (1 - (xx + zz)) * scale[1], (yz + wx) * scale[1], 0,
    (xz + wy) * scale[2], (yz - wx) * scale[2], (1 - (xx + yy)) * scale[2], 0,
    translation[0], translation[1], translation[2], 1,
  ];
}

/** 扩展模型包围盒。 */
function expandBounds(bounds, point) {
  for (let index = 0; index < 3; index += 1) {
    bounds.min[index] = Math.min(bounds.min[index], point[index]);
    bounds.max[index] = Math.max(bounds.max[index], point[index]);
    bounds.size[index] = bounds.max[index] - bounds.min[index];
  }
}

/** 从 GLB 文件读取 JSON chunk，供单位推断使用。 */
function readGlbJson(modelFilePath) {
  if (path.extname(modelFilePath).toLowerCase() !== '.glb') return null;

  const buffer = readFileSync(modelFilePath);
  if (buffer.toString('utf-8', 0, 4) !== 'glTF') return null;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    offset += 8;

    if (chunkType === 0x4e4f534a) {
      const parsed = JSON.parse(buffer.toString('utf-8', offset, offset + chunkLength));
      return isPlainObject(parsed) ? parsed : null;
    }

    offset += chunkLength;
  }

  return null;
}

/** 安全读取 glTF 数组成员。 */
function getArrayItem(collection, index) {
  if (!Array.isArray(collection) || typeof index !== 'number') return null;
  const item = collection[index];
  return isPlainObject(item) ? item : null;
}

/** 收集一个 mesh 的 POSITION accessor 包围盒。 */
function collectMeshBounds(gltf, meshIndex, worldMatrix, bounds) {
  const mesh = getArrayItem(gltf.meshes, meshIndex);
  if (!mesh || !Array.isArray(mesh.primitives)) return;

  for (const primitive of mesh.primitives) {
    if (!isPlainObject(primitive) || !isPlainObject(primitive.attributes)) continue;

    const accessor = getArrayItem(gltf.accessors, primitive.attributes.POSITION);
    if (!accessor || !Array.isArray(accessor.min) || !Array.isArray(accessor.max)) continue;
    if (accessor.min.length !== 3 || accessor.max.length !== 3) continue;
    if (!accessor.min.every((value) => typeof value === 'number') || !accessor.max.every((value) => typeof value === 'number')) continue;

    for (const x of [accessor.min[0], accessor.max[0]]) {
      for (const y of [accessor.min[1], accessor.max[1]]) {
        for (const z of [accessor.min[2], accessor.max[2]]) {
          expandBounds(bounds, transformPoint(worldMatrix, [x, y, z]));
        }
      }
    }
  }
}

/** 递归读取 glTF 节点树包围盒。 */
function traverseNodeBounds(gltf, nodeIndex, parentMatrix, bounds) {
  const node = getArrayItem(gltf.nodes, nodeIndex);
  if (!node) return;

  const worldMatrix = multiplyMatrix(parentMatrix, matrixFromNode(node));
  collectMeshBounds(gltf, node.mesh, worldMatrix, bounds);

  if (!Array.isArray(node.children)) return;
  for (const childNodeIndex of node.children) {
    traverseNodeBounds(gltf, childNodeIndex, worldMatrix, bounds);
  }
}

/** 读取模型原始坐标包围盒，用于判断 GLB 源单位。 */
function readModelBounds(modelFilePath) {
  const gltf = readGlbJson(modelFilePath);
  if (!gltf) return null;

  const bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    size: [0, 0, 0],
  };
  const sceneIndex = typeof gltf.scene === 'number' ? gltf.scene : 0;
  const scene = getArrayItem(gltf.scenes, sceneIndex);
  if (!scene || !Array.isArray(scene.nodes)) return null;

  for (const nodeIndex of scene.nodes) {
    traverseNodeBounds(gltf, nodeIndex, identityMatrix(), bounds);
  }

  return bounds.min.every(Number.isFinite) && bounds.max.every(Number.isFinite) ? bounds : null;
}

/** 只采集模型参数中的尺寸类默认值，和项目导入器保持一致的单位判断依据。 */
function collectNumericMetadataValues(metadata) {
  if (!isPlainObject(metadata) || !Array.isArray(metadata.parameterScripts)) return [];

  const values = [];
  for (const script of metadata.parameterScripts) {
    if (!isPlainObject(script)) continue;

    if (Array.isArray(script.fields)) {
      for (const field of script.fields) {
        if (!isPlainObject(field)) continue;
        const key = typeof field.key === 'string' ? field.key.toLowerCase() : '';
        if (
          ['length', 'width', 'height', 'depth', 'gap'].some((word) => key.includes(word)) &&
          typeof field.defaultValue === 'number' &&
          field.defaultValue > 0
        ) {
          values.push(field.defaultValue);
        }
      }
    }

    if (isPlainObject(script.values)) {
      for (const [key, value] of Object.entries(script.values)) {
        if (
          ['length', 'width', 'height', 'depth', 'gap'].some((word) => key.toLowerCase().includes(word)) &&
          isPlainObject(value) &&
          typeof value.value === 'number' &&
          value.value > 0
        ) {
          values.push(value.value);
        }
      }
    }
  }

  return values;
}

/** 按 meta 尺寸默认值和 GLB 原始包围盒推断模型源单位。 */
function inferUnitFromBounds(metadata) {
  const bounds = readModelBounds(STACKER_MODEL_FILE_PATH);
  if (!bounds) return DEFAULT_MODEL_LENGTH_UNIT_INFO;

  const metadataValues = collectNumericMetadataValues(metadata);
  const metadataMax = metadataValues.length > 0 ? Math.max(...metadataValues) : NaN;
  const boundsMax = Math.max(...bounds.size);
  if (!Number.isFinite(metadataMax) || !Number.isFinite(boundsMax) || metadataMax <= 0 || boundsMax <= 0) {
    return DEFAULT_MODEL_LENGTH_UNIT_INFO;
  }

  const ratio = boundsMax / metadataMax;
  if (ratio > 800 && ratio < 1200) return { lengthUnit: 'millimeter', unitScaleToMeters: 0.001 };
  if (ratio > 80 && ratio < 120) return { lengthUnit: 'centimeter', unitScaleToMeters: 0.01 };
  return DEFAULT_MODEL_LENGTH_UNIT_INFO;
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

/** 读取模型长度单位，缺省时按项目导入器的包围盒规则推断。 */
function readLengthUnitInfo(metadata) {
  const lengthUnit = metadata?.lengthUnit;
  if (lengthUnit === 'meter' || lengthUnit === 'm') return { lengthUnit: 'meter', unitScaleToMeters: 1 };
  if (lengthUnit === 'millimeter' || lengthUnit === 'mm') return { lengthUnit: 'millimeter', unitScaleToMeters: 0.001 };
  if (lengthUnit === 'centimeter' || lengthUnit === 'cm') return { lengthUnit: 'centimeter', unitScaleToMeters: 0.01 };
  return inferUnitFromBounds(metadata);
}

/** 创建一个虚拟定位线框实体，用于 to_x/to_y/to_z 查找目标位。 */
function createLocatorEntity(id, name, assetId, storageDepth, position, size = { length: 1.1, width: 1.1, height: 1.1 }) {
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
        storageDepth,
        length: size.length,
        width: size.width,
        height: size.height,
      },
    },
  };
}

/** 创建近排/远排库位演示场景，包含真实 Stacker、库位参数和外部 MQTT 配置。 */
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
        entity_locator_1_1_1: createLocatorEntity('entity_locator_1_1_1', '近排库位 1-1-1', '1-1-1', 'near', vector3(0.9, 1.2, 4)),
        entity_locator_1_2_1: createLocatorEntity('entity_locator_1_2_1', '远排库位 1-2-1', '1-2-1', 'far', vector3(1.9, 1.2, 4)),
        entity_locator_2_1_1: createLocatorEntity('entity_locator_2_1_1', '近排库位 2-1-1', '2-1-1', 'near', vector3(0.9, 2.2, 8)),
        entity_locator_2_2_1: createLocatorEntity('entity_locator_2_2_1', '远排库位 2-2-1', '2-2-1', 'far', vector3(1.9, 2.2, 8)),
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
