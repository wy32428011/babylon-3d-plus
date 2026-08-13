import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, normalizeModelLengthUnit, type ModelLengthUnitInfo } from '../modelUnits.js';
import type { AssetEntry, ImportModelFolderSkippedEntry, ModelPackageVariant } from '../types.js';
import { encodeAssetUrl } from './assetRegistry.js';

const MODEL_EXTENSIONS = new Set(['.glb', '.gltf']);
const MODEL_THUMBNAIL_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
export const MAX_GLB_MODEL_FILE_BYTES = 512 * 1024 * 1024;
const MAX_GLB_JSON_CHUNK_BYTES = 64 * 1024 * 1024;
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a;
const GLB_BINARY_CHUNK_TYPE = 0x004e4942;
const SUPPORTED_GLTF_REQUIRED_EXTENSIONS = new Set([
  'EXT_mesh_gpu_instancing',
  'EXT_meshopt_compression',
  'EXT_texture_avif',
  'EXT_texture_webp',
  'KHR_draco_mesh_compression',
  'KHR_lights_punctual',
  'KHR_materials_anisotropy',
  'KHR_materials_clearcoat',
  'KHR_materials_diffuse_transmission',
  'KHR_materials_dispersion',
  'KHR_materials_emissive_strength',
  'KHR_materials_ior',
  'KHR_materials_iridescence',
  'KHR_materials_pbrSpecularGlossiness',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_unlit',
  'KHR_materials_variants',
  'KHR_materials_volume',
  'KHR_mesh_quantization',
  'KHR_texture_basisu',
  'KHR_texture_transform',
  'KHR_xmp_json_ld',
  'MSFT_lod',
]);

type ModelPackageMetadata = ModelLengthUnitInfo & {
  displayName?: string;
  thumbnailPath?: string;
  thumbnailUrl?: string;
  parameterConfig?: unknown;
  parameterScriptMetadata?: unknown[];
  animationScriptMetadata?: unknown[];
  dataDrivenConfig?: unknown;
  builtInSlotBinding?: unknown;
  defaultAssetCode?: string;
  scriptFileNames?: string[];
};

type ModelPackageScanResult = {
  asset?: AssetEntry;
  skipped?: ImportModelFolderSkippedEntry;
};


function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

export type GlbModelInspection = {
  fileSizeBytes: number;
  extensionsUsed: string[];
  warnings: string[];
};

type ParsedGlbDocument = {
  fileSizeBytes: number;
  gltf: Record<string, unknown>;
  hasBinaryChunk: boolean;
};

async function readExactly(
  handle: Awaited<ReturnType<typeof fs.open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead <= 0) throw new Error('GLB 文件提前结束。');
    offset += result.bytesRead;
  }
  return buffer;
}

function normalizeGlbStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`${label} 必须是非空字符串数组。`);
  }
  return value.map((item) => item.trim());
}

function assertSelfContainedGlbUris(value: unknown, location = 'glTF'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSelfContainedGlbUris(item, `${location}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (key === 'uri' && typeof child === 'string') {
      const uri = child.trim();
      if (!uri.toLowerCase().startsWith('data:')) {
        throw new Error(`${location}.uri 引用了外部资源，环境 GLB 必须是自包含单文件。`);
      }
    }
    assertSelfContainedGlbUris(child, `${location}.${key}`);
  }
}

function inspectEnvironmentGlbJson(
  gltf: Record<string, unknown>,
  hasBinaryChunk: boolean,
): Pick<GlbModelInspection, 'extensionsUsed' | 'warnings'> {
  if (!isPlainObject(gltf.asset) || gltf.asset.version !== '2.0') {
    throw new Error('环境模型必须是 glTF 2.0 Binary。');
  }
  if (!Array.isArray(gltf.meshes)) throw new Error('GLB 不包含可渲染 Mesh。');
  const hasRenderablePrimitive = gltf.meshes.some((mesh) => (
    isPlainObject(mesh) && Array.isArray(mesh.primitives) && mesh.primitives.some(isPlainObject)
  ));
  if (!hasRenderablePrimitive) throw new Error('GLB 不包含可渲染 Mesh primitive。');
  assertSelfContainedGlbUris(gltf);

  const extensionsUsed = normalizeGlbStringArray(gltf.extensionsUsed, 'extensionsUsed');
  const extensionsRequired = normalizeGlbStringArray(gltf.extensionsRequired, 'extensionsRequired');
  for (const extension of extensionsRequired) {
    if (!extensionsUsed.includes(extension)) {
      throw new Error(`必需扩展 ${extension} 未出现在 extensionsUsed 中。`);
    }
    if (!SUPPORTED_GLTF_REQUIRED_EXTENSIONS.has(extension)) {
      throw new Error(`不支持的 glTF 必需扩展：${extension}`);
    }
  }

  if (Array.isArray(gltf.buffers)) {
    const embeddedBuffers = gltf.buffers.filter((buffer) => isPlainObject(buffer) && buffer.uri === undefined);
    if (embeddedBuffers.length > 1) throw new Error('GLB 只能包含一个无 URI 的内嵌 Buffer。');
    if (embeddedBuffers.length === 1 && !hasBinaryChunk) {
      throw new Error('GLB 声明了内嵌 Buffer，但缺少 BIN chunk。');
    }
  }

  const warnings: string[] = [];
  if (Array.isArray(gltf.cameras) && gltf.cameras.length > 0) warnings.push('GLB 内相机将在环境运行时被忽略。');
  if (Array.isArray(gltf.animations) && gltf.animations.length > 0) warnings.push('GLB 内动画将在环境运行时被忽略。');
  if (extensionsUsed.includes('KHR_lights_punctual')) warnings.push('GLB 内灯光将在环境运行时被忽略。');
  const unknownOptional = extensionsUsed.filter((extension) => (
    !extensionsRequired.includes(extension) && !SUPPORTED_GLTF_REQUIRED_EXTENSIONS.has(extension)
  ));
  if (unknownOptional.length > 0) {
    warnings.push(`未知非必需扩展将按 Babylon.js 可用能力处理：${unknownOptional.join(', ')}`);
  }
  if (Object.hasOwn(gltf, 'extras')) warnings.push('GLB extras 仅作为静态数据保留，不会执行其中内容。');
  return { extensionsUsed, warnings };
}

/** 只校验普通 GLB 的容器结构，不施加环境模型的自包含、Mesh 或扩展白名单规则。 */
async function parseGlbContainer(modelFilePath: string): Promise<ParsedGlbDocument> {
  if (path.extname(modelFilePath).toLowerCase() !== '.glb') throw new Error('模型文件必须使用 .glb 扩展名。');
  const stat = await fs.lstat(modelFilePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('GLB 路径必须是普通文件。');
  if (stat.size < 20 || stat.size > MAX_GLB_MODEL_FILE_BYTES) {
    throw new Error('GLB 文件大小必须在 20 字节到 512 MiB 之间。');
  }

  const handle = await fs.open(modelFilePath, 'r');
  try {
    const header = await readExactly(handle, 12, 0);
    if (header.toString('ascii', 0, 4) !== 'glTF') throw new Error('GLB magic 无效。');
    if (header.readUInt32LE(4) !== 2) throw new Error('GLB 必须使用 version 2。');
    if (header.readUInt32LE(8) !== stat.size) throw new Error('GLB 声明长度与实际文件大小不一致。');

    let offset = 12;
    let gltf: Record<string, unknown> | null = null;
    let hasBinaryChunk = false;
    let chunkIndex = 0;
    while (offset < stat.size) {
      if (offset + 8 > stat.size) throw new Error('GLB chunk header 不完整。');
      const chunkHeader = await readExactly(handle, 8, offset);
      const chunkLength = chunkHeader.readUInt32LE(0);
      const chunkType = chunkHeader.readUInt32LE(4);
      const dataOffset = offset + 8;
      const chunkEnd = dataOffset + chunkLength;
      if (chunkLength === 0 || chunkLength % 4 !== 0 || chunkEnd > stat.size) {
        throw new Error('GLB chunk 边界无效。');
      }
      if (chunkIndex === 0 && chunkType !== GLB_JSON_CHUNK_TYPE) {
        throw new Error('GLB 首个 chunk 必须是 JSON。');
      }

      if (chunkType === GLB_JSON_CHUNK_TYPE) {
        if (gltf) throw new Error('GLB 只能包含一个 JSON chunk。');
        if (chunkLength > MAX_GLB_JSON_CHUNK_BYTES) throw new Error('GLB JSON chunk 超过 64 MiB 上限。');
        const jsonBuffer = await readExactly(handle, chunkLength, dataOffset);
        const jsonText = jsonBuffer.toString('utf8').replace(/[\u0000\u0020]+$/g, '');
        const parsed = JSON.parse(jsonText) as unknown;
        if (!isPlainObject(parsed)) throw new Error('GLB JSON 根节点必须是普通对象。');
        gltf = parsed;
      } else if (chunkType === GLB_BINARY_CHUNK_TYPE) {
        if (hasBinaryChunk) throw new Error('GLB 只能包含一个 BIN chunk。');
        hasBinaryChunk = true;
      }

      offset = chunkEnd;
      chunkIndex += 1;
    }
    if (offset !== stat.size || !gltf) throw new Error('GLB 分块未完整覆盖文件或缺少 JSON chunk。');
    return { fileSizeBytes: stat.size, gltf, hasBinaryChunk };
  } finally {
    await handle.close();
  }
}

/**
 * 以有界读取校验环境 GLB 的结构、自包含 URI、必需扩展和可渲染 Mesh。
 * 二进制主体不会整体载入内存，适用于 512 MiB 环境模型重复校验。
 */
export async function inspectGlbModelFile(modelFilePath: string): Promise<GlbModelInspection> {
  const parsed = await parseGlbContainer(modelFilePath);
  return {
    fileSizeBytes: parsed.fileSizeBytes,
    ...inspectEnvironmentGlbJson(parsed.gltf, parsed.hasBinaryChunk),
  };
}

/** 校验普通模型 GLB 的头、版本、声明长度、JSON 首块和分块边界。 */
export async function validateGlbModelFile(modelFilePath: string): Promise<boolean> {
  try {
    await parseGlbContainer(modelFilePath);
    return true;
  } catch {
    return false;
  }
}

/** 校验完整环境 GLB 契约，调用方只需要布尔结果时使用。 */
export async function validateEnvironmentGlbFile(modelFilePath: string): Promise<boolean> {
  try {
    await inspectGlbModelFile(modelFilePath);
    return true;
  } catch {
    return false;
  }
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

/** 判断文件名是否为可执行的 TypeScript 模型脚本，声明文件不会进入运行时。 */
function isRuntimeModelScriptFileName(fileName: string): boolean {
  const normalizedFileName = fileName.toLowerCase();
  return normalizedFileName.endsWith('.ts') && !normalizedFileName.endsWith('.d.ts');
}

/** 收集 meta.json 中参数/动画脚本显式引用的包内 TypeScript 文件名。 */
function extractScriptFileNamesFromMetadata(metadata: unknown): string[] | undefined {
  if (!isPlainObject(metadata)) return undefined;

  const scriptFileNames = new Set<string>();
  for (const key of ['parameterScripts', 'animationScripts'] as const) {
    const scripts = metadata[key];
    if (!Array.isArray(scripts)) continue;

    for (const script of scripts) {
      if (!isPlainObject(script) || typeof script.scriptFilename !== 'string') continue;
      const fileName = script.scriptFilename.trim().replace(/\\/g, '/');
      if (!fileName || path.posix.basename(fileName) !== fileName || !isRuntimeModelScriptFileName(fileName)) continue;
      scriptFileNames.add(fileName);
    }
  }

  return scriptFileNames.size > 0 ? [...scriptFileNames] : undefined;
}

/** 从 meta.json 读取 dataDriven 并深拷贝为纯 JSON，运行时脚本 fallback 不在主进程执行。 */
function extractDataDrivenConfigFromMetadata(metadata: unknown): unknown | undefined {
  if (!isPlainObject(metadata) || !('dataDriven' in metadata)) return undefined;
  try {
    return JSON.parse(JSON.stringify(metadata.dataDriven)) as unknown;
  } catch {
    return undefined;
  }
}

/** 从 meta.json 读取内置货格绑定声明并深拷贝为纯 JSON，结构校验在渲染进程 normalize 时完成。 */
function extractBuiltInSlotBindingFromMetadata(metadata: unknown): unknown | undefined {
  if (!isPlainObject(metadata) || !('builtInSlotBinding' in metadata)) return undefined;
  try {
    return JSON.parse(JSON.stringify(metadata.builtInSlotBinding)) as unknown;
  } catch {
    return undefined;
  }
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
    if (type === 'string') return { ...base, type: 'string', defaultValue };
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
): Promise<ModelPackageMetadata & { metadataPath?: string }> {
  const metadataPath = path.join(packagePath, 'meta.json');

  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    const lengthUnitValue = isPlainObject(parsed) ? parsed.lengthUnit : undefined;
    // 模型包单位只来自 meta.lengthUnit；缺失或空值按米兜底，避免参数脚本尺寸被误当作源模型单位。
    const unitInfo = normalizeModelLengthUnit(lengthUnitValue);

    if (!unitInfo) {
      throw new Error(`模型单位不受支持：${String(lengthUnitValue)}`);
    }

    const thumbnail = await resolveModelThumbnail(packagePath, parsed);

    return {
      metadataPath,
      ...(thumbnail ?? {}),
      displayName: extractDisplayNameFromMetadata(parsed),
      parameterConfig: extractModelParameterConfigFromMetadata(parsed) ?? extractModelParameterConfigFromParameterScripts(parsed),
      parameterScriptMetadata: extractJsonArrayMetadata(parsed, 'parameterScripts'),
      animationScriptMetadata: extractJsonArrayMetadata(parsed, 'animationScripts'),
      dataDrivenConfig: extractDataDrivenConfigFromMetadata(parsed),
      builtInSlotBinding: extractBuiltInSlotBindingFromMetadata(parsed),
      scriptFileNames: extractScriptFileNamesFromMetadata(parsed),
      ...unitInfo,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('模型单位不受支持：')) {
      throw error;
    }

    return { ...DEFAULT_MODEL_LENGTH_UNIT_INFO };
  }
}

function findModelScripts(
  packagePath: string,
  fileNames: string[],
  referencedScriptFileNames: string[] | undefined,
): string[] {
  const referencedFileNames = new Set(
    (referencedScriptFileNames ?? []).map((fileName) => fileName.toLowerCase()),
  );

  return fileNames
    .filter((fileName) => {
      const normalizedFileName = fileName.toLowerCase();
      return normalizedFileName.endsWith('.model.ts')
        || (referencedFileNames.has(normalizedFileName) && isRuntimeModelScriptFileName(normalizedFileName));
    })
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

  const metadata = await readModelPackageMetadata(packagePath);
  const scriptPaths = findModelScripts(packagePath, fileNames, metadata.scriptFileNames);
  const defaultAssetCode = await readDefaultAssetCodeFromScripts(scriptPaths);
  const scriptAssets = createModelScriptAssets(scriptPaths);
  const modelFileName = path.basename(modelFilePath);
  const packageName = path.basename(packagePath);
  const modelFileStat = await fs.stat(modelFilePath);

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
      fileSizeBytes: modelFileStat.size,
      parameterConfig: metadata.parameterConfig,
      dataDrivenConfig: metadata.dataDrivenConfig,
      builtInSlotBindingConfig: metadata.builtInSlotBinding,
    },
  };
}

/** 列出模型包内所有可作为环境效果切换的 glTF/GLB 变体，并把主模型排在首位。 */
export async function listModelPackageVariants(packagePath: string): Promise<ModelPackageVariant[]> {
  const entries = await fs.readdir(packagePath, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(isModelFile)
    .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));

  const primaryModelPath = selectPrimaryModelFile(packagePath, fileNames);
  const primaryFileName = primaryModelPath ? path.basename(primaryModelPath) : fileNames[0] ?? null;
  if (!primaryFileName) return [];

  const orderedFileNames = [
    primaryFileName,
    ...fileNames.filter((fileName) => fileName !== primaryFileName),
  ];

  return orderedFileNames.map((fileName) => {
    const modelPath = path.join(packagePath, fileName);

    return {
      name: path.parse(fileName).name,
      path: modelPath,
      sourceUrl: encodeAssetUrl(modelPath),
    };
  });
}

/**
 * 扫描用户选择的模型目录。
 * 所选目录根部存在模型文件时，优先把该目录视为完整模型包，避免 GLTF 的纹理等资源子目录被误判为独立模型包。
 */
export async function scanModelFolder(
  rootPath: string,
): Promise<{ assets: AssetEntry[]; skipped: ImportModelFolderSkippedEntry[] }> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const assets: AssetEntry[] = [];
  const skipped: ImportModelFolderSkippedEntry[] = [];
  const hasRootModelFile = entries.some((entry) => entry.isFile() && isModelFile(entry.name));

  if (hasRootModelFile) {
    try {
      const rootPackageResult = await scanModelPackage(rootPath);
      if (rootPackageResult.asset) {
        return { assets: [rootPackageResult.asset], skipped };
      }
      if (rootPackageResult.skipped) skipped.push(rootPackageResult.skipped);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skipped.push({ packagePath: rootPath, reason: `扫描失败：${message}` });
    }
  }

  const packageDirectories = entries.filter((entry) => entry.isDirectory());

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
