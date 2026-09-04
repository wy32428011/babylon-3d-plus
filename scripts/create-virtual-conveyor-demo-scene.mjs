import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_PACKAGE_DIR = path.join(WORKSPACE_ROOT, 'public', 'builtin-model-packages', 'virtual-conveyor');
const PACKAGE_DIR = path.resolve(process.env.VIRTUAL_CONVEYOR_PACKAGE_DIR || DEFAULT_PACKAGE_DIR);
const GLB_FILE_PATH = path.join(PACKAGE_DIR, 'virtual-conveyor.glb');
const META_FILE_PATH = path.join(PACKAGE_DIR, 'meta.json');
const SCRIPT_FILE_PATH = path.join(PACKAGE_DIR, 'virtual-conveyor.model.ts');
const SCENE_FILE_PATH = path.join(WORKSPACE_ROOT, 'examples', 'scenes', 'virtual-conveyor-mqtt-demo.scene.json');
const MQTT_TOPIC = 'dt/factory/logistics/conveyor/+/twindatadriven/joint';
const MQTT_ADDRESS = 'ws://127.0.0.1:8083/mqtt';

/** 将本地文件路径转换为编辑器授权资产 URL。 */
function toEditorAssetUrl(filePath) {
  return `editor-asset://local/${encodeURIComponent(filePath)}`;
}

function vector3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

function transform(position, rotation = vector3(), scale = vector3(1, 1, 1)) {
  return { position, rotation, scale };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** 校验内置虚拟输送线模板包必需文件，缺失时给出可执行的修复提示。 */
function assertVirtualConveyorPackage() {
  const missingFiles = [GLB_FILE_PATH, META_FILE_PATH, SCRIPT_FILE_PATH].filter((filePath) => !existsSync(filePath));
  if (missingFiles.length === 0) return;

  throw new Error(
    [
      `未找到完整的虚拟输送线模型包：${PACKAGE_DIR}`,
      `缺失文件：${missingFiles.join(', ')}`,
      '可设置环境变量 VIRTUAL_CONVEYOR_PACKAGE_DIR 指向包含 virtual-conveyor.glb、meta.json、virtual-conveyor.model.ts 的模型包目录。',
    ].join('\n'),
  );
}

/** 读取模板包 meta.json，保证 demo 场景与内置包参数/dataDriven 一致。 */
function readPackageMetadata() {
  assertVirtualConveyorPackage();

  try {
    return JSON.parse(readFileSync(META_FILE_PATH, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`读取虚拟输送线 meta.json 失败：${message}`);
  }
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

/** 按参数 schema 生成默认参数值，与编辑器 createDefaultModelParameterValues 对齐。 */
function createDefaultParameterValues(config) {
  const values = {};
  for (const definition of config.parameters) {
    values[definition.key] = definition.defaultValue;
  }
  return values;
}

/** 创建外置脚本资产引用，运行时会通过 editor-asset 协议读取同包 TypeScript 脚本。 */
function createScriptAssets() {
  return [
    {
      path: SCRIPT_FILE_PATH,
      sourceUrl: toEditorAssetUrl(SCRIPT_FILE_PATH),
      name: path.basename(SCRIPT_FILE_PATH),
    },
  ];
}

/** 创建单台虚拟输送线实体；起点设备带 cargoOriginDevice，可自建仓箱。 */
function createVirtualConveyorEntity({ id, name, assetCode, positionX, metadata, parameterConfig, cargoOriginDevice }) {
  const scriptAssets = createScriptAssets();
  const parameterScriptMetadata = readJsonArrayMetadata(metadata, 'parameterScripts');
  const animationScriptMetadata = readJsonArrayMetadata(metadata, 'animationScripts');
  const dataDrivenConfig = isPlainObject(metadata.dataDriven) ? JSON.parse(JSON.stringify(metadata.dataDriven)) : undefined;

  return {
    id,
    name,
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: transform(vector3(positionX, 0, 0)),
      modelAsset: {
        assetCode,
        sourcePath: GLB_FILE_PATH,
        sourceUrl: toEditorAssetUrl(GLB_FILE_PATH),
        lengthUnit: 'meter',
        unitScaleToMeters: 1,
        ...(scriptAssets.length ? { scriptAssets } : {}),
        ...(parameterScriptMetadata?.length ? { parameterScriptMetadata } : {}),
        ...(animationScriptMetadata?.length ? { animationScriptMetadata } : {}),
        ...(parameterConfig
          ? {
              parameterConfig,
              parameterValues: createDefaultParameterValues(parameterConfig),
            }
          : {}),
        ...(dataDrivenConfig ? { dataDrivenConfig } : {}),
      },
      telemetryBinding: {
        enabled: true,
        sourceId: 'default',
        deviceType: 'conveyor',
        expectedIntervalMs: 500,
        staleAfterMs: 2000,
        trajectoryDirection: 'x',
        ...(cargoOriginDevice ? { cargoOriginDevice: true } : {}),
      },
    },
  };
}

/** 生成两台首尾相邻（A 出口即 B 入口）的虚拟输送线演示场景。 */
function createDemoScene() {
  const metadata = readPackageMetadata();
  const parameterConfig = readModelParameterConfig(metadata);

  const conveyorA = createVirtualConveyorEntity({
    id: 'entity_vc_demo_a',
    name: '虚拟输送线 A（起点）',
    assetCode: 'VirtualConveyor-A',
    positionX: 0,
    metadata,
    parameterConfig,
    cargoOriginDevice: true,
  });
  const conveyorB = createVirtualConveyorEntity({
    id: 'entity_vc_demo_b',
    name: '虚拟输送线 B（下游）',
    assetCode: 'VirtualConveyor-B',
    // A 长 2 m（x ∈ [-1,1]），B 紧邻其右侧（x ∈ [1,3]），出口探测点恰好触及。
    positionX: 2,
    metadata,
    parameterConfig,
    cargoOriginDevice: false,
  });

  const entities = {
    [conveyorA.id]: conveyorA,
    [conveyorB.id]: conveyorB,
  };

  return {
    version: 5,
    units: { length: 'meter' },
    scene: {
      id: 'scene_virtual_conveyor_demo',
      name: '虚拟输送线 MQTT 演示',
      entityIds: [conveyorA.id, conveyorB.id],
      entities,
      selectedEntityId: null,
      mqttConfig: {
        enabled: true,
        ip: '127.0.0.1',
        address: MQTT_ADDRESS,
        topic: MQTT_TOPIC,
        simulatorEnabled: false,
        simulatorAssetCode: 'VirtualConveyor-A',
        simulatorScenario: 'cycle',
        simulatorIntervalMs: 500,
      },
    },
  };
}

function main() {
  const scene = createDemoScene();
  mkdirSync(path.dirname(SCENE_FILE_PATH), { recursive: true });
  writeFileSync(SCENE_FILE_PATH, `${JSON.stringify(scene, null, 2)}\n`, 'utf8');
  console.log(`已生成虚拟输送线演示场景：${SCENE_FILE_PATH}`);
  console.log(`模型包来源：${PACKAGE_DIR}`);
  console.log(`A（起点，cargoOriginDevice）：VirtualConveyor-A @ x=0`);
  console.log(`B（下游订阅）：VirtualConveyor-B @ x=2`);
  console.log(`MQTT topic：${MQTT_TOPIC}`);
}

main();
