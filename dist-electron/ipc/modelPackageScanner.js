import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, normalizeModelLengthUnit } from '../modelUnits.js';
import { encodeAssetUrl } from './assetRegistry.js';
const MODEL_EXTENSIONS = new Set(['.glb', '.gltf']);
const MODEL_THUMBNAIL_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
async function readGlbJson(modelFilePath) {
    if (path.extname(modelFilePath).toLowerCase() !== '.glb')
        return null;
    const buffer = await fs.readFile(modelFilePath);
    if (buffer.length < 20 || buffer.toString('utf-8', 0, 4) !== 'glTF')
        return null;
    const version = buffer.readUInt32LE(4);
    const declaredLength = buffer.readUInt32LE(8);
    if (version !== 2 || declaredLength !== buffer.length)
        return null;
    let offset = 12;
    let isFirstChunk = true;
    let gltf = null;
    while (offset + 8 <= buffer.length) {
        const chunkLength = buffer.readUInt32LE(offset);
        const chunkType = buffer.readUInt32LE(offset + 4);
        const chunkDataOffset = offset + 8;
        const chunkEnd = chunkDataOffset + chunkLength;
        if (chunkLength === 0 || chunkLength % 4 !== 0 || chunkEnd > buffer.length)
            return null;
        if (isFirstChunk && chunkType !== 0x4e4f534a)
            return null;
        if (chunkType === 0x4e4f534a) {
            if (gltf)
                return null;
            const jsonText = buffer
                .toString('utf-8', chunkDataOffset, chunkEnd)
                .replace(/\u0000+$/g, '')
                .trimEnd();
            const parsed = JSON.parse(jsonText);
            gltf = isPlainObject(parsed) ? parsed : null;
            if (!gltf)
                return null;
        }
        isFirstChunk = false;
        offset = chunkEnd;
    }
    return offset === buffer.length ? gltf : null;
}
/** 校验 GLB 头、版本、声明长度、JSON 首块和分块边界，拒绝仅伪装扩展名的损坏文件。 */
export async function validateGlbModelFile(modelFilePath) {
    try {
        return (await readGlbJson(modelFilePath)) !== null;
    }
    catch {
        return false;
    }
}
function isModelFile(fileName) {
    return MODEL_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}
function selectPrimaryModelFile(packagePath, fileNames) {
    const modelFileNames = fileNames.filter(isModelFile);
    if (modelFileNames.length === 0)
        return null;
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
function extractThumbnailReferenceFromMetadata(metadata) {
    if (!isPlainObject(metadata))
        return undefined;
    for (const key of ['thumbnail', 'cover']) {
        const value = metadata[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return undefined;
}
/** 只接受模型包内部相对图片路径作为卡片封面，避免元数据越权引用外部文件。 */
async function resolveModelThumbnail(packagePath, metadata) {
    const reference = extractThumbnailReferenceFromMetadata(metadata);
    if (!reference)
        return undefined;
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
        if (!stat.isFile())
            return undefined;
    }
    catch {
        return undefined;
    }
    return {
        thumbnailPath,
        thumbnailUrl: encodeAssetUrl(thumbnailPath),
    };
}
function extractDisplayNameFromMetadata(metadata) {
    if (!isPlainObject(metadata) || !Array.isArray(metadata.parameterScripts))
        return undefined;
    for (const script of metadata.parameterScripts) {
        if (!isPlainObject(script))
            continue;
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
            if (isPlainObject(deviceNameField) &&
                typeof deviceNameField.defaultValue === 'string' &&
                deviceNameField.defaultValue.trim()) {
                return deviceNameField.defaultValue.trim();
            }
        }
    }
    return undefined;
}
function extractModelParameterConfigFromMetadata(metadata) {
    if (!isPlainObject(metadata) || !isPlainObject(metadata.modelParameters))
        return undefined;
    const config = metadata.modelParameters;
    if (config.schema !== 'babylon-editor.model-parameters' || config.version !== 1)
        return undefined;
    if (!Array.isArray(config.parameters) || !Array.isArray(config.bindings))
        return undefined;
    if (config.parameters.length > 64 || config.bindings.length > 256)
        return undefined;
    if (Array.isArray(config.rules) && config.rules.length > 128)
        return undefined;
    return config;
}
function extractJsonArrayMetadata(metadata, key) {
    if (!isPlainObject(metadata) || !Array.isArray(metadata[key]))
        return undefined;
    return metadata[key].map((item) => JSON.parse(JSON.stringify(item)));
}
/** 从 meta.json 读取 dataDriven 并深拷贝为纯 JSON，运行时脚本 fallback 不在主进程执行。 */
function extractDataDrivenConfigFromMetadata(metadata) {
    if (!isPlainObject(metadata) || !('dataDriven' in metadata))
        return undefined;
    try {
        return JSON.parse(JSON.stringify(metadata.dataDriven));
    }
    catch {
        return undefined;
    }
}
function readFieldConfiguration(field) {
    return isPlainObject(field.configuration) ? field.configuration : {};
}
function readFieldNumber(field, configuration, key) {
    const directValue = field[key];
    const configuredValue = configuration[key];
    if (typeof directValue === 'number' && Number.isFinite(directValue))
        return directValue;
    return typeof configuredValue === 'number' && Number.isFinite(configuredValue) ? configuredValue : undefined;
}
function normalizeStringOptions(value, defaultValue) {
    if (!Array.isArray(value) || value.length === 0)
        return null;
    const options = value.map((item) => {
        if (typeof item === 'string' && item.trim())
            return { value: item.trim(), label: item.trim() };
        if (!isPlainObject(item))
            return null;
        const optionValue = typeof item.value === 'string' && item.value.trim() ? item.value.trim() : null;
        const optionLabel = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : optionValue;
        return optionValue && optionLabel ? { value: optionValue, label: optionLabel } : null;
    });
    if (!options.every(Boolean))
        return null;
    const normalizedOptions = options;
    if (!normalizedOptions.some((option) => option.value === defaultValue)) {
        normalizedOptions.unshift({ value: defaultValue, label: defaultValue });
    }
    return normalizedOptions;
}
function isHexColor(value) {
    return /^#[0-9a-fA-F]{6}$/.test(value);
}
function isParameterInfoField(key) {
    return ['modelKey', 'deviceType', 'deviceName', 'description'].includes(key);
}
function createParameterDefinitionFromScriptField(field) {
    if (!isPlainObject(field))
        return null;
    const key = typeof field.key === 'string' && field.key.trim() ? field.key.trim() : null;
    const label = typeof field.label === 'string' && field.label.trim() ? field.label.trim() : key;
    if (!key || !label)
        return null;
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
        if (options)
            return { ...base, type: 'enum', defaultValue, options };
        if (isHexColor(defaultValue))
            return { ...base, type: 'color', defaultValue };
        if (type === 'texture' && /\.(png|jpe?g|webp)$/i.test(defaultValue)) {
            return { ...base, type: 'texture', defaultValue, allowedExtensions: ['.png', '.jpg', '.jpeg', '.webp'] };
        }
        if (isParameterInfoField(key))
            return null;
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
function extractModelParameterConfigFromParameterScripts(metadata) {
    if (!isPlainObject(metadata) || !Array.isArray(metadata.parameterScripts))
        return undefined;
    const parameters = [];
    const seenKeys = new Set();
    for (const script of metadata.parameterScripts) {
        if (!isPlainObject(script) || !Array.isArray(script.fields))
            continue;
        for (const field of script.fields) {
            const definition = createParameterDefinitionFromScriptField(field);
            if (!isPlainObject(definition) || typeof definition.key !== 'string' || seenKeys.has(definition.key))
                continue;
            seenKeys.add(definition.key);
            parameters.push(definition);
        }
    }
    return parameters.length > 0
        ? { schema: 'babylon-editor.model-parameters', version: 1, parameters, bindings: [] }
        : undefined;
}
async function readModelPackageMetadata(packagePath) {
    const metadataPath = path.join(packagePath, 'meta.json');
    try {
        const content = await fs.readFile(metadataPath, 'utf-8');
        const parsed = JSON.parse(content);
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
            ...unitInfo,
        };
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('模型单位不受支持：')) {
            throw error;
        }
        return { ...DEFAULT_MODEL_LENGTH_UNIT_INFO };
    }
}
function findModelScripts(packagePath, fileNames) {
    return fileNames
        .filter((fileName) => fileName.toLowerCase().endsWith('.model.ts'))
        .map((fileName) => path.join(packagePath, fileName));
}
/** 从模型包脚本 dataDriven.device.defaultAssetCode 中只读提取导入实例编号前缀。 */
async function readDefaultAssetCodeFromScripts(scriptPaths) {
    for (const scriptPath of scriptPaths) {
        try {
            const sourceText = await fs.readFile(scriptPath, 'utf-8');
            const match = sourceText.match(/\bdefaultAssetCode\s*:\s*["'`]([^"'`]{1,128})["'`]/);
            const defaultAssetCode = match?.[1]?.trim();
            if (defaultAssetCode)
                return defaultAssetCode;
        }
        catch {
            // 单个脚本读取失败不影响模型包导入，默认编号会退回通用前缀。
        }
    }
    return undefined;
}
function createModelScriptAssets(scriptPaths) {
    return scriptPaths.map((scriptPath) => ({
        path: scriptPath,
        sourceUrl: encodeAssetUrl(scriptPath),
        name: path.basename(scriptPath),
    }));
}
export async function scanModelPackage(packagePath) {
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
    const metadata = await readModelPackageMetadata(packagePath);
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
            dataDrivenConfig: metadata.dataDrivenConfig,
        },
    };
}
/** 列出模型包内所有可作为环境效果切换的 glTF/GLB 变体，并把主模型排在首位。 */
export async function listModelPackageVariants(packagePath) {
    const entries = await fs.readdir(packagePath, { withFileTypes: true });
    const fileNames = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter(isModelFile)
        .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
    const primaryModelPath = selectPrimaryModelFile(packagePath, fileNames);
    const primaryFileName = primaryModelPath ? path.basename(primaryModelPath) : fileNames[0] ?? null;
    if (!primaryFileName)
        return [];
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
export async function scanModelFolder(rootPath) {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    const assets = [];
    const skipped = [];
    const hasRootModelFile = entries.some((entry) => entry.isFile() && isModelFile(entry.name));
    if (hasRootModelFile) {
        try {
            const rootPackageResult = await scanModelPackage(rootPath);
            if (rootPackageResult.asset) {
                return { assets: [rootPackageResult.asset], skipped };
            }
            if (rootPackageResult.skipped)
                skipped.push(rootPackageResult.skipped);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            skipped.push({ packagePath: rootPath, reason: `扫描失败：${message}` });
        }
    }
    const packageDirectories = entries.filter((entry) => entry.isDirectory());
    for (const entry of packageDirectories) {
        const packagePath = path.join(rootPath, entry.name);
        try {
            const result = await scanModelPackage(packagePath);
            if (result.asset)
                assets.push(result.asset);
            if (result.skipped)
                skipped.push(result.skipped);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            skipped.push({ packagePath, reason: `扫描失败：${message}` });
        }
    }
    return { assets, skipped };
}
