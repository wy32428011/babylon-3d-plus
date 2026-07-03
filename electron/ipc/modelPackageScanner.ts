import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, normalizeModelLengthUnit, type ModelLengthUnitInfo } from '../modelUnits.js';
import type { AssetEntry, ImportModelFolderSkippedEntry } from '../types.js';
import { encodeAssetUrl } from './assetRegistry.js';

const MODEL_EXTENSIONS = new Set(['.glb', '.gltf']);
const MODEL_THUMBNAIL_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

type ModelPackageMetadata = ModelLengthUnitInfo & {
  displayName?: string;
  thumbnailPath?: string;
  thumbnailUrl?: string;
  parameterConfig?: unknown;
  parameterScriptMetadata?: unknown[];
  animationScriptMetadata?: unknown[];
  defaultAssetCode?: string;
};

type ModelPackageScanResult = {
  asset?: AssetEntry;
  skipped?: ImportModelFolderSkippedEntry;
};

type Vector3Tuple = [number, number, number];

type ModelBounds = {
  min: Vector3Tuple;
  max: Vector3Tuple;
  size: Vector3Tuple;
};

type Matrix4Tuple = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function identityMatrix(): Matrix4Tuple {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrix(left: Matrix4Tuple, right: Matrix4Tuple): Matrix4Tuple {
  const result = new Array(16).fill(0) as Matrix4Tuple;

  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      for (let index = 0; index < 4; index += 1) {
        result[row * 4 + column] += left[row * 4 + index] * right[index * 4 + column];
      }
    }
  }

  return result;
}

function transformPoint(matrix: Matrix4Tuple, point: Vector3Tuple): Vector3Tuple {
  const [x, y, z] = point;

  return [
    x * matrix[0] + y * matrix[4] + z * matrix[8] + matrix[12],
    x * matrix[1] + y * matrix[5] + z * matrix[9] + matrix[13],
    x * matrix[2] + y * matrix[6] + z * matrix[10] + matrix[14],
  ];
}

function matrixFromNode(node: Record<string, unknown>): Matrix4Tuple {
  if (Array.isArray(node.matrix) && node.matrix.length === 16 && node.matrix.every((value) => typeof value === 'number')) {
    return node.matrix as Matrix4Tuple;
  }

  const translation = Array.isArray(node.translation) && node.translation.length === 3 ? node.translation as Vector3Tuple : [0, 0, 0];
  const scale = Array.isArray(node.scale) && node.scale.length === 3 ? node.scale as Vector3Tuple : [1, 1, 1];
  const rotation = Array.isArray(node.rotation) && node.rotation.length === 4 ? node.rotation as [number, number, number, number] : [0, 0, 0, 1];
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

function expandBounds(bounds: ModelBounds, point: Vector3Tuple): void {
  for (let index = 0; index < 3; index += 1) {
    bounds.min[index] = Math.min(bounds.min[index], point[index]);
    bounds.max[index] = Math.max(bounds.max[index], point[index]);
    bounds.size[index] = bounds.max[index] - bounds.min[index];
  }
}

async function readGlbJson(modelFilePath: string): Promise<Record<string, unknown> | null> {
  if (path.extname(modelFilePath).toLowerCase() !== '.glb') return null;

  const buffer = await fs.readFile(modelFilePath);
  if (buffer.toString('utf-8', 0, 4) !== 'glTF') return null;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    offset += 8;

    if (chunkType === 0x4e4f534a) {
      const parsed = JSON.parse(buffer.toString('utf-8', offset, offset + chunkLength)) as unknown;
      return isPlainObject(parsed) ? parsed : null;
    }

    offset += chunkLength;
  }

  return null;
}

function getArrayItem(collection: unknown, index: unknown): Record<string, unknown> | null {
  if (!Array.isArray(collection) || typeof index !== 'number') return null;
  const item = collection[index];
  return isPlainObject(item) ? item : null;
}

function collectMeshBounds(gltf: Record<string, unknown>, meshIndex: unknown, worldMatrix: Matrix4Tuple, bounds: ModelBounds): void {
  const mesh = getArrayItem(gltf.meshes, meshIndex);
  if (!mesh || !Array.isArray(mesh.primitives)) return;

  for (const primitive of mesh.primitives) {
    if (!isPlainObject(primitive) || !isPlainObject(primitive.attributes)) continue;

    const accessor = getArrayItem(gltf.accessors, primitive.attributes.POSITION);
    if (!accessor || !Array.isArray(accessor.min) || !Array.isArray(accessor.max)) continue;
    if (accessor.min.length !== 3 || accessor.max.length !== 3) continue;
    if (!accessor.min.every((value) => typeof value === 'number') || !accessor.max.every((value) => typeof value === 'number')) continue;

    const min = accessor.min as Vector3Tuple;
    const max = accessor.max as Vector3Tuple;
    for (const x of [min[0], max[0]]) {
      for (const y of [min[1], max[1]]) {
        for (const z of [min[2], max[2]]) {
          expandBounds(bounds, transformPoint(worldMatrix, [x, y, z]));
        }
      }
    }
  }
}

function traverseNodeBounds(gltf: Record<string, unknown>, nodeIndex: unknown, parentMatrix: Matrix4Tuple, bounds: ModelBounds): void {
  const node = getArrayItem(gltf.nodes, nodeIndex);
  if (!node) return;

  const worldMatrix = multiplyMatrix(parentMatrix, matrixFromNode(node));
  collectMeshBounds(gltf, node.mesh, worldMatrix, bounds);

  if (!Array.isArray(node.children)) return;
  for (const childNodeIndex of node.children) {
    traverseNodeBounds(gltf, childNodeIndex, worldMatrix, bounds);
  }
}

async function readModelBounds(modelFilePath: string): Promise<ModelBounds | null> {
  const gltf = await readGlbJson(modelFilePath);
  if (!gltf) return null;

  const bounds: ModelBounds = {
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

function isDimensionKey(key: string): boolean {
  const normalizedKey = key.toLowerCase();
  return (
    normalizedKey.includes('length') ||
    normalizedKey.includes('width') ||
    normalizedKey.includes('height') ||
    normalizedKey.includes('depth') ||
    normalizedKey.includes('gap') ||
    normalizedKey.includes('track') ||
    normalizedKey.includes('aisle') ||
    normalizedKey.includes('post') ||
    key.includes('长') ||
    key.includes('宽') ||
    key.includes('高') ||
    key.includes('深') ||
    key.includes('距')
  );
}

function collectNumericMetadataValues(metadata: unknown): number[] {
  if (!isPlainObject(metadata) || !Array.isArray(metadata.parameterScripts)) return [];

  const values: number[] = [];
  for (const script of metadata.parameterScripts) {
    if (!isPlainObject(script)) continue;

    if (Array.isArray(script.fields)) {
      for (const field of script.fields) {
        if (!isPlainObject(field)) continue;
        const key = typeof field.key === 'string' ? field.key : '';
        const label = typeof field.label === 'string' ? field.label : '';
        if ((isDimensionKey(key) || isDimensionKey(label)) && typeof field.defaultValue === 'number' && field.defaultValue > 0) {
          values.push(field.defaultValue);
        }
      }
    }

    if (isPlainObject(script.values)) {
      for (const [key, value] of Object.entries(script.values)) {
        if (!isDimensionKey(key) || !isPlainObject(value) || typeof value.value !== 'number' || value.value <= 0) continue;
        values.push(value.value);
      }
    }
  }

  return values;
}

function inferUnitFromBounds(metadata: unknown, bounds: ModelBounds | null): ModelLengthUnitInfo {
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

function isModelFile(fileName: string): boolean {
  return MODEL_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function selectPrimaryModelFile(packagePath: string, fileNames: string[]): string | null {
  const modelFileNames = fileNames.filter(isModelFile);

  if (modelFileNames.length === 0) return null;

  const packageName = path.basename(packagePath).toLowerCase();
  const sameNameModel = modelFileNames.find((fileName) => path.parse(fileName).name.toLowerCase() === packageName);

  if (sameNameModel) {
    return path.join(packagePath, sameNameModel);
  }

  if (modelFileNames.length === 1) {
    return path.join(packagePath, modelFileNames[0]);
  }

  return null;
}

function extractThumbnailReferenceFromMetadata(metadata: unknown): string | undefined {
  if (!isPlainObject(metadata)) return undefined;

  for (const key of ['thumbnail', 'cover']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  return undefined;
}

/** 只接受模型包内部相对图片路径作为卡片封面，避免元数据越权引用外部文件。 */
async function resolveModelThumbnail(packagePath: string, metadata: unknown): Promise<Pick<AssetEntry, 'thumbnailPath' | 'thumbnailUrl'> | undefined> {
  const reference = extractThumbnailReferenceFromMetadata(metadata);
  if (!reference) return undefined;

  const normalizedReference = reference.replace(/\\/g, '/');
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(normalizedReference) || path.isAbsolute(normalizedReference)) {
    return undefined;
  }

  const thumbnailPath = path.resolve(packagePath, normalizedReference);
  const relativePath = path.relative(packagePath, thumbnailPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }

  if (!MODEL_THUMBNAIL_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    return undefined;
  }

  try {
    const stat = await fs.stat(thumbnailPath);
    if (!stat.isFile()) return undefined;
  } catch {
    return undefined;
  }

  return {
    thumbnailPath,
    thumbnailUrl: encodeAssetUrl(thumbnailPath),
  };
}

function extractDisplayNameFromMetadata(metadata: unknown): string | undefined {
  if (!isPlainObject(metadata) || !Array.isArray(metadata.parameterScripts)) return undefined;

  for (const script of metadata.parameterScripts) {
    if (!isPlainObject(script)) continue;

    const values = script.values;
    if (isPlainObject(values)) {
      const deviceName = values.deviceName;
      if (isPlainObject(deviceName) && typeof deviceName.value === 'string' && deviceName.value.trim()) {
        return deviceName.value.trim();
      }
    }

    const fields = script.fields;
    if (Array.isArray(fields)) {
      const deviceNameField = fields.find((field) => isPlainObject(field) && field.key === 'deviceName');
      if (
        isPlainObject(deviceNameField) &&
        typeof deviceNameField.defaultValue === 'string' &&
        deviceNameField.defaultValue.trim()
      ) {
        return deviceNameField.defaultValue.trim();
      }
    }
  }

  return undefined;
}

function extractModelParameterConfigFromMetadata(metadata: unknown): unknown | undefined {
  if (!isPlainObject(metadata) || !isPlainObject(metadata.modelParameters)) return undefined;

  const config = metadata.modelParameters;
  if (config.schema !== 'babylon-editor.model-parameters' || config.version !== 1) return undefined;
  if (!Array.isArray(config.parameters) || !Array.isArray(config.bindings)) return undefined;
  if (config.parameters.length > 64 || config.bindings.length > 256) return undefined;
  if (Array.isArray(config.rules) && config.rules.length > 128) return undefined;

  return config;
}

function extractJsonArrayMetadata(metadata: unknown, key: 'parameterScripts' | 'animationScripts'): unknown[] | undefined {
  if (!isPlainObject(metadata) || !Array.isArray(metadata[key])) return undefined;

  return metadata[key].map((item) => JSON.parse(JSON.stringify(item)) as unknown);
}

function readFieldConfiguration(field: Record<string, unknown>): Record<string, unknown> {
  return isPlainObject(field.configuration) ? field.configuration : {};
}

function readFieldNumber(field: Record<string, unknown>, configuration: Record<string, unknown>, key: string): number | undefined {
  const directValue = field[key];
  const configuredValue = configuration[key];
  if (typeof directValue === 'number' && Number.isFinite(directValue)) return directValue;
  return typeof configuredValue === 'number' && Number.isFinite(configuredValue) ? configuredValue : undefined;
}

function normalizeStringOptions(value: unknown, defaultValue: string): { value: string; label: string }[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const options = value.map((item) => {
    if (typeof item === 'string' && item.trim()) return { value: item.trim(), label: item.trim() };
    if (!isPlainObject(item)) return null;
    const optionValue = typeof item.value === 'string' && item.value.trim() ? item.value.trim() : null;
    const optionLabel = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : optionValue;
    return optionValue && optionLabel ? { value: optionValue, label: optionLabel } : null;
  });

  if (!options.every(Boolean)) return null;
  const normalizedOptions = options as { value: string; label: string }[];
  if (!normalizedOptions.some((option) => option.value === defaultValue)) {
    normalizedOptions.unshift({ value: defaultValue, label: defaultValue });
  }
  return normalizedOptions;
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function isParameterInfoField(key: string): boolean {
  return ['modelKey', 'deviceType', 'deviceName', 'description'].includes(key);
}

function createParameterDefinitionFromScriptField(field: unknown): unknown | null {
  if (!isPlainObject(field)) return null;

  const key = typeof field.key === 'string' && field.key.trim() ? field.key.trim() : null;
  const label = typeof field.label === 'string' && field.label.trim() ? field.label.trim() : key;
  if (!key || !label) return null;

  const configuration = readFieldConfiguration(field);
  const type = typeof field.type === 'string' ? field.type : configuration.type;
  const defaultValue = field.defaultValue;
  const base = { key, label };

  if (type === 'number' && typeof defaultValue === 'number' && Number.isFinite(defaultValue)) {
    return {
      ...base,
      type: 'number',
      defaultValue,
      min: readFieldNumber(field, configuration, 'min'),
      max: readFieldNumber(field, configuration, 'max'),
      step: readFieldNumber(field, configuration, 'step'),
    };
  }

  if (type === 'boolean' && typeof defaultValue === 'boolean') {
    return { ...base, type: 'boolean', defaultValue };
  }

  if (typeof defaultValue === 'string') {
    const options = normalizeStringOptions(field.options ?? configuration.options, defaultValue);
    if (options) return { ...base, type: 'enum', defaultValue, options };
    if (isHexColor(defaultValue)) return { ...base, type: 'color', defaultValue };
    if (type === 'texture' && /\.(png|jpe?g|webp)$/i.test(defaultValue)) {
      return { ...base, type: 'texture', defaultValue, allowedExtensions: ['.png', '.jpg', '.jpeg', '.webp'] };
    }
    if (isParameterInfoField(key)) return null;
  }

  if (isPlainObject(defaultValue) &&
    typeof defaultValue.x === 'number' &&
    typeof defaultValue.y === 'number' &&
    typeof defaultValue.z === 'number') {
    return {
      ...base,
      type: 'vector3',
      defaultValue: { x: defaultValue.x, y: defaultValue.y, z: defaultValue.z },
      min: readFieldNumber(field, configuration, 'min'),
      max: readFieldNumber(field, configuration, 'max'),
      step: readFieldNumber(field, configuration, 'step'),
    };
  }

  return null;
}

function extractModelParameterConfigFromParameterScripts(metadata: unknown): unknown | undefined {
  if (!isPlainObject(metadata) || !Array.isArray(metadata.parameterScripts)) return undefined;

  const parameters: unknown[] = [];
  const seenKeys = new Set<string>();

  for (const script of metadata.parameterScripts) {
    if (!isPlainObject(script) || !Array.isArray(script.fields)) continue;

    for (const field of script.fields) {
      const definition = createParameterDefinitionFromScriptField(field);
      if (!isPlainObject(definition) || typeof definition.key !== 'string' || seenKeys.has(definition.key)) continue;
      seenKeys.add(definition.key);
      parameters.push(definition);
    }
  }

  return parameters.length > 0
    ? { schema: 'babylon-editor.model-parameters', version: 1, parameters, bindings: [] }
    : undefined;
}

async function readModelPackageMetadata(
  packagePath: string,
  modelFilePath: string,
): Promise<ModelPackageMetadata & { metadataPath?: string }> {
  const metadataPath = path.join(packagePath, 'meta.json');

  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    const hasExplicitLengthUnit = isPlainObject(parsed) && 'lengthUnit' in parsed;
    const unitInfo = hasExplicitLengthUnit
      ? normalizeModelLengthUnit(parsed.lengthUnit)
      : inferUnitFromBounds(parsed, await readModelBounds(modelFilePath));

    if (!unitInfo) {
      throw new Error(`模型单位不受支持：${isPlainObject(parsed) ? String(parsed.lengthUnit) : 'unknown'}`);
    }

    const thumbnail = await resolveModelThumbnail(packagePath, parsed);

    return {
      metadataPath,
      ...(thumbnail ?? {}),
      displayName: extractDisplayNameFromMetadata(parsed),
      parameterConfig: extractModelParameterConfigFromMetadata(parsed) ?? extractModelParameterConfigFromParameterScripts(parsed),
      parameterScriptMetadata: extractJsonArrayMetadata(parsed, 'parameterScripts'),
      animationScriptMetadata: extractJsonArrayMetadata(parsed, 'animationScripts'),
      ...unitInfo,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('模型单位不受支持：')) {
      throw error;
    }

    return { ...DEFAULT_MODEL_LENGTH_UNIT_INFO };
  }
}

function findModelScripts(packagePath: string, fileNames: string[]): string[] {
  return fileNames
    .filter((fileName) => fileName.toLowerCase().endsWith('.model.ts'))
    .map((fileName) => path.join(packagePath, fileName));
}

/** 从模型包脚本 dataDriven.device.defaultAssetCode 中只读提取导入实例编号前缀。 */
async function readDefaultAssetCodeFromScripts(scriptPaths: string[]): Promise<string | undefined> {
  for (const scriptPath of scriptPaths) {
    try {
      const sourceText = await fs.readFile(scriptPath, 'utf-8');
      const match = sourceText.match(/\bdefaultAssetCode\s*:\s*["'`]([^"'`]{1,128})["'`]/);
      const defaultAssetCode = match?.[1]?.trim();
      if (defaultAssetCode) return defaultAssetCode;
    } catch {
      // 单个脚本读取失败不影响模型包导入，默认编号会退回通用前缀。
    }
  }

  return undefined;
}

function createModelScriptAssets(scriptPaths: string[]): NonNullable<AssetEntry['scriptAssets']> {
  return scriptPaths.map((scriptPath) => ({
    path: scriptPath,
    sourceUrl: encodeAssetUrl(scriptPath),
    name: path.basename(scriptPath),
  }));
}

export async function scanModelPackage(packagePath: string): Promise<ModelPackageScanResult> {
  const entries = await fs.readdir(packagePath, { withFileTypes: true });
  const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const modelFilePath = selectPrimaryModelFile(packagePath, fileNames);

  if (!modelFilePath) {
    const modelCount = fileNames.filter(isModelFile).length;
    return {
      skipped: {
        packagePath,
        reason: modelCount > 1 ? '存在多个模型文件，无法判断主模型。' : '未发现 .glb/.gltf 模型文件。',
      },
    };
  }

  const scriptPaths = findModelScripts(packagePath, fileNames);
  const metadata = await readModelPackageMetadata(packagePath, modelFilePath);
  const defaultAssetCode = await readDefaultAssetCodeFromScripts(scriptPaths);
  const scriptAssets = createModelScriptAssets(scriptPaths);
  const modelFileName = path.basename(modelFilePath);
  const packageName = path.basename(packagePath);

  return {
    asset: {
      id: modelFilePath,
      name: modelFileName,
      path: modelFilePath,
      sourceUrl: encodeAssetUrl(modelFilePath),
      kind: 'model',
      packagePath,
      metadataPath: metadata.metadataPath,
      thumbnailPath: metadata.thumbnailPath,
      thumbnailUrl: metadata.thumbnailUrl,
      scriptPaths,
      scriptAssets,
      parameterScriptMetadata: metadata.parameterScriptMetadata,
      animationScriptMetadata: metadata.animationScriptMetadata,
      defaultAssetCode: defaultAssetCode ?? metadata.defaultAssetCode,
      displayName: metadata.displayName ?? packageName ?? path.parse(modelFileName).name,
      lengthUnit: metadata.lengthUnit,
      unitScaleToMeters: metadata.unitScaleToMeters,
      parameterConfig: metadata.parameterConfig,
    },
  };
}

export async function scanModelFolder(
  rootPath: string,
): Promise<{ assets: AssetEntry[]; skipped: ImportModelFolderSkippedEntry[] }> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const packageDirectories = entries.filter((entry) => entry.isDirectory());
  const assets: AssetEntry[] = [];
  const skipped: ImportModelFolderSkippedEntry[] = [];

  for (const entry of packageDirectories) {
    const packagePath = path.join(rootPath, entry.name);

    try {
      const result = await scanModelPackage(packagePath);
      if (result.asset) assets.push(result.asset);
      if (result.skipped) skipped.push(result.skipped);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skipped.push({ packagePath, reason: `扫描失败：${message}` });
    }
  }

  return { assets, skipped };
}
