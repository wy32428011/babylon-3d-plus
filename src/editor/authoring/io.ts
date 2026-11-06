import { unzipSync, zipSync, strToU8 } from 'fflate';
import { fetchRuntimeAsset } from '../../runtime/assets/runtimeAssetFetch';
import { createEmptyProject, newId } from './types';
import type { ArchiveCandidate, AssetDescriptor, AuthoringParameter, AuthoringProject, AuthoringSession, BinaryAsset, CatalogModel, ImportedArchive, ParameterValue } from './types';
import { identifyTrustedTemplate, sha256, trustedTemplate } from './templates';

const MAX_FILE = 256 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_JSON = 8 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const PROJECT_ENTRY = 'authoring.json';
const MANIFEST_ENTRY = 'assets.json';

export function isSession(value: AuthoringSession | ImportedArchive): value is AuthoringSession {
  return 'project' in value && value.assets instanceof Map;
}

export function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 包路径只作逻辑键，不接受绝对路径、编码穿越、驱动器或 Windows 特殊文件名。 */
export function safeAssetPath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f\u007f:?#]/.test(value)) throw new Error('资产路径非法。');
  const path = value.replace(/\\/g, '/');
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { throw new Error(`资产路径编码无效：${value}`); }
  if (decoded.includes('\\') || /[\u0000-\u001f\u007f:?#]/.test(decoded)) throw new Error(`资产路径非法：${value}`);
  for (const candidate of [path, decoded]) {
    if (candidate.startsWith('/') || candidate.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error(`拒绝不安全的资产路径：${value}`);
    }
  }
  return path;
}

export function baseName(path: string): string { return path.replace(/\\/g, '/').split('/').pop() || 'asset'; }
function directory(path: string): string { const index = path.lastIndexOf('/'); return index < 0 ? '' : path.slice(0, index + 1); }

export function parseJson(bytes: Uint8Array, label: string): Record<string, unknown> {
  if (bytes.length > MAX_JSON) throw new Error(`${label} 超过 JSON 大小上限。`);
  const value: unknown = JSON.parse(decoder.decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象。`);
  return value as Record<string, unknown>;
}

export function mediaType(path: string): string {
  const ext = path.toLowerCase().split('.').pop();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', glb: 'model/gltf-binary', json: 'application/json', ts: 'text/plain' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
}

export async function makeAsset(path: string, bytes: Uint8Array, id = newId('asset')): Promise<BinaryAsset> {
  const normalized = safeAssetPath(path);
  if (bytes.length > MAX_FILE) throw new Error(`资产过大：${path}`);
  return { id, path: normalized, fileName: baseName(normalized), mediaType: mediaType(normalized), sha256: await sha256(bytes), bytes: new Uint8Array(bytes) };
}

/** 在解压每项之前校验声明尺寸，避免先分配 ZIP 炸弹再检查。 */
function readZip(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.length > MAX_FILE) throw new Error('压缩包超过 256 MiB 上限。');
  let count = 0, total = 0;
  const names = new Set<string>();
  const extracted = unzipSync(bytes, { filter(entry) {
    if (++count > MAX_ENTRIES) throw new Error('压缩包文件过多。');
    const isDirectory = /[/\\]$/.test(entry.name);
    const name = safeAssetPath(isDirectory ? entry.name.slice(0, -1) : entry.name);
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`压缩包存在重复路径：${name}`);
    names.add(key);
    total += entry.originalSize;
    if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || entry.originalSize > MAX_FILE || total > MAX_TOTAL) throw new Error('压缩包解压尺寸超过限制。');
    return !isDirectory;
  } });
  const entries: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  let actual = 0;
  for (const [path, data] of Object.entries(extracted)) {
    actual += data.length;
    if (data.length > MAX_FILE || actual > MAX_TOTAL) throw new Error('压缩包实际尺寸超过限制。');
    entries[safeAssetPath(path)] = data;
  }
  return entries;
}

/** 检查 GLB 头、完整 chunk 边界和外部依赖；不会修改原模型。 */
export function glbReferences(bytes: Uint8Array): string[] {
  if (bytes.length < 20) throw new Error('GLB 文件不完整。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length) throw new Error('无效的 GLB 2.0 文件头或长度。');
  let offset = 12;
  let json: Record<string, unknown> | undefined;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('GLB chunk 头不完整。');
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    offset += 8;
    if (length % 4 || offset + length > bytes.length) throw new Error('GLB chunk 长度非法。');
    if (offset === 20 && type !== 0x4e4f534a) throw new Error('GLB 首个 chunk 不是 JSON。');
    if (type === 0x4e4f534a) {
      if (json) throw new Error('GLB 包含重复 JSON chunk。');
      json = parseJson(bytes.subarray(offset, offset + length), 'GLB JSON');
    }
    offset += length;
  }
  if (!json) throw new Error('GLB 缺少 JSON 数据。');
  const references: string[] = [];
  for (const group of [json.buffers, json.images]) {
    for (const item of Array.isArray(group) ? group : []) {
      const uri = objectRecord(item).uri;
      if (typeof uri === 'string' && !uri.startsWith('data:')) references.push(safeAssetPath(decodeURIComponent(uri)));
    }
  }
  return [...new Set(references)];
}

function declaredPath(entries: Record<string, Uint8Array>, value: unknown, base: string): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const path = safeAssetPath(value);
  if (Object.hasOwn(entries, path)) return path;
  const local = safeAssetPath(base + path);
  if (Object.hasOwn(entries, local)) return local;
  // 原始批量导出目录被单独压缩时，声明仍可能保留 models/编号/ 前缀。
  const matches = Object.keys(entries).filter(key => path.endsWith('/' + key) || key === local);
  if (matches.length === 1) return matches[0];
  return undefined;
}

function discoverCandidates(entries: Record<string, Uint8Array>): ArchiveCandidate[] {
  const candidates: ArchiveCandidate[] = [];
  const covered = new Set<string>();
  for (const path of Object.keys(entries).filter(name => !/(^|\/)originals\//.test(name) && /(^|\/)model\.json$/i.test(name))) {
    const model = parseJson(entries[path], path), base = directory(path);
    const localGlbs = Object.keys(entries).filter(name => name.startsWith(base) && /\.glb$/i.test(name));
    const modelPath = declaredPath(entries, model.filePath ?? model.fileName, base) ?? (localGlbs.length === 1 ? localGlbs[0] : undefined);
    if (!modelPath || !/\.glb$/i.test(modelPath)) continue;
    const scripts: string[] = [];
    for (const item of Array.isArray(model.scriptFiles) ? model.scriptFiles : []) {
      const record = objectRecord(item);
      const found = declaredPath(entries, record.filePath ?? record.fileName, base);
      if (!found) throw new Error(`脚本资产缺失：${String(record.fileName ?? record.filePath)}`);
      scripts.push(found);
    }
    if (!scripts.length) scripts.push(...Object.keys(entries).filter(name => name.startsWith(base) && /\.ts$/i.test(name)));
    const metaPath = declaredPath(entries, model.metaFilePath ?? model.metaFileName, base) ?? Object.keys(entries).find(name => name.startsWith(base) && /(^|\/)meta\.json$/i.test(name));
    if ((model.metaFilePath || model.metaFileName) && !metaPath) throw new Error(`模型 ${path} 缺少声明的 meta.json。`);
    candidates.push({ id: path, name: String(model.modelName ?? baseName(modelPath)), modelPath, modelJsonPath: path, metaPath, scriptPaths: scripts, thumbnailPath: declaredPath(entries, model.thumbnailFilePath, base) });
    covered.add(modelPath);
  }
  for (const path of Object.keys(entries).filter(name => !/(^|\/)originals\//.test(name) && /\.glb$/i.test(name) && !covered.has(name))) {
    const base = directory(path);
    candidates.push({ id: path, name: baseName(path), modelPath: path, metaPath: Object.hasOwn(entries, base + 'meta.json') ? base + 'meta.json' : undefined,
      scriptPaths: Object.keys(entries).filter(name => directory(name) === base && /\.ts$/i.test(name)) });
  }
  if (!candidates.length) throw new Error('压缩包内没有可打开的 GLB 模型。');
  return candidates;
}

function primitive(value: unknown): value is ParameterValue {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

/** 多份声明共同读取，保留原 metadata；同 key 优先采用正式 modelParameters 定义。 */
export function originalParameterDefinitions(meta: Record<string, unknown>): Record<string, unknown>[] {
  const result = new Map<string, Record<string, unknown>>();
  for (const group of [meta.parameterScripts, meta.animationScripts]) {
    for (const script of Array.isArray(group) ? group : []) {
      const fields = objectRecord(script).fields;
      for (const field of Array.isArray(fields) ? fields : []) {
        const record = objectRecord(field);
        if (typeof record.key === 'string') result.set(record.key, { ...objectRecord(record.configuration), ...record });
      }
    }
  }
  for (const config of [meta.parameterConfig, meta.modelParameters]) {
    const fields = objectRecord(config).parameters;
    for (const field of Array.isArray(fields) ? fields : []) {
      const record = objectRecord(field);
      if (typeof record.key === 'string') result.set(record.key, { ...result.get(record.key), ...record });
    }
  }
  return [...result.values()];
}

function readParameters(meta: Record<string, unknown>): AuthoringParameter[] {
  const values: Record<string, unknown> = {};
  for (const group of [meta.parameterScripts, meta.animationScripts]) for (const script of Array.isArray(group) ? group : []) Object.assign(values, objectRecord(objectRecord(script).values));
  Object.assign(values, objectRecord(meta.parameterValues));
  return originalParameterDefinitions(meta).flatMap(record => {
    if (typeof record.key !== 'string' || !primitive(record.defaultValue)) return [];
    const type = record.type === 'texture' || record.type === 'enum' ? 'string' : record.type;
    if (type !== 'number' && type !== 'boolean' && type !== 'color' && type !== 'string') return [];
    const stored = values[record.key];
    const currentValue = primitive(stored) ? stored : objectRecord(stored).value;
    const parameter: AuthoringParameter = { key: record.key, label: String(record.label ?? record.key), type, defaultValue: record.defaultValue, value: primitive(currentValue) ? currentValue : record.defaultValue };
    if (typeof record.unit === 'string') parameter.unit = record.unit;
    for (const key of ['min', 'max', 'step'] as const) if (typeof record[key] === 'number' && Number.isFinite(record[key])) parameter[key] = record[key];
    const scale = parameter.unit === 'mm' ? 1000 : parameter.unit === 'cm' ? 100 : 1;
    if (parameter.type === 'number' && scale !== 1) {
      parameter.value = Number(parameter.value) / scale; parameter.defaultValue = Number(parameter.defaultValue) / scale;
      for (const key of ['min', 'max', 'step'] as const) if (parameter[key] !== undefined) parameter[key] = parameter[key]! / scale;
    }
    return [parameter];
  });
}

export async function openArchiveCandidate(archive: ImportedArchive, id: string): Promise<AuthoringSession> {
  const candidate = archive.candidates.find(item => item.id === id);
  if (!candidate) throw new Error('模型候选不存在。');
  const entries = archive.entries;
  if (!Object.hasOwn(entries, candidate.modelPath)) throw new Error('模型文件缺失。');
  const originalMeta = candidate.metaPath ? parseJson(entries[candidate.metaPath], candidate.metaPath) : {};
  const originalModelJson = candidate.modelJsonPath ? parseJson(entries[candidate.modelJsonPath], candidate.modelJsonPath) : {};
  const root = candidate.modelJsonPath ? directory(candidate.modelJsonPath) : directory(candidate.modelPath);
  const paths = new Set(Object.keys(entries).filter(path => path.startsWith(root)));
  for (const path of [candidate.modelPath, ...candidate.scriptPaths, candidate.metaPath, candidate.thumbnailPath]) if (path) paths.add(path);
  const assets = new Map<string, BinaryAsset>();
  const byPath = new Map<string, BinaryAsset>();
  for (const path of paths) {
    if (!Object.hasOwn(entries, path)) throw new Error(`资产缺失：${path}`);
    const asset = await makeAsset(path, entries[path]);
    assets.set(asset.id, asset); byPath.set(path, asset);
  }
  const model = byPath.get(candidate.modelPath)!;
  const unitValue = originalMeta.lengthUnit ?? originalModelJson.lengthUnit ?? 'meter';
  if (!['meter', 'centimeter', 'millimeter'].includes(String(unitValue))) throw new Error(`暂不支持源长度单位：${String(unitValue)}`);
  const unit = unitValue as 'meter' | 'centimeter' | 'millimeter';
  const project = createEmptyProject();
  project.name = candidate.name;
  project.parameters = readParameters(originalMeta);
  project.source = {
    id: newId('source'), name: candidate.name, fileName: model.fileName, modelAssetId: model.id, sha256: model.sha256,
    unit, unitScale: { meter: 1, centimeter: 0.01, millimeter: 0.001 }[unit], originalMeta, originalModelJson,
    scripts: candidate.scriptPaths.map(path => {
      const declarations = Array.isArray(originalModelJson.scriptFiles) ? originalModelJson.scriptFiles : [];
      const declaration = declarations.map(objectRecord).find(item => typeof item.filePath === 'string' && (item.filePath === path || item.filePath.endsWith('/' + path)));
      const metaScripts = Array.isArray(originalMeta.animationScripts) ? originalMeta.animationScripts.map(objectRecord) : [];
      const metaName = metaScripts.find(item => typeof item.scriptFilename === 'string' && baseName(path).endsWith(item.scriptFilename))?.scriptFilename;
      return { fileName: typeof declaration?.fileName === 'string' ? declaration.fileName : typeof metaName === 'string' ? metaName : baseName(path), path, assetId: byPath.get(path)!.id };
    }),
    ...(candidate.thumbnailPath ? { thumbnailAssetId: byPath.get(candidate.thumbnailPath)!.id } : {}),
  };
  const templateId = candidate.scriptPaths.length === 1 ? await identifyTrustedTemplate(entries[candidate.scriptPaths[0]]) : undefined;
  project.legacy = templateId ? { enabled: true, templateId } : { enabled: false, reason: candidate.scriptPaths.length ? '原脚本未命中内置摘要白名单，仅保留、不执行。请为参数配置可视化规则；导出的活动脚本只运行新配方，原脚本另存于 originals。' : '此模型没有原参数脚本。' };
  const session = { project, assets };
  await validateSessionAssets(session);
  return session;
}

export async function readImportFile(file: File): Promise<AuthoringSession | ImportedArchive> {
  if (file.size > MAX_FILE) throw new Error('文件超过 256 MiB 上限。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.glb$/i.test(file.name)) {
    const path = safeAssetPath(file.name);
    const references = glbReferences(bytes);
    if (references.length) throw new Error('GLB 引用了外部资源，请连同依赖一起打包为 ZIP 导入。');
    return openArchiveCandidate({ entries: { [path]: bytes }, candidates: [{ id: path, name: path.replace(/\.glb$/i, ''), modelPath: path, scriptPaths: [] }] }, path);
  }
  if (!/\.zip$/i.test(file.name)) throw new Error('只支持 GLB、模型 ZIP 和 .pa.zip 工程。');
  const entries = readZip(bytes);
  if (Object.hasOwn(entries, 'integrity.json')) {
    const integrity = parseJson(entries['integrity.json'], 'integrity.json');
    if (integrity.schema !== 'zending.model-integrity' || integrity.version !== 1 || !integrity.files || typeof integrity.files !== 'object') throw new Error('模型完整性清单格式无效。');
    const hashes = objectRecord(integrity.files);
    for (const [path, expected] of Object.entries(hashes)) {
      safeAssetPath(path);
      if (typeof expected !== 'string' || !/^[a-f\d]{64}$/.test(expected) || !Object.hasOwn(entries, path) || await sha256(entries[path]) !== expected) throw new Error(`模型资产 SHA-256 校验失败：${path}`);
    }
    if (Object.keys(entries).some(path => path !== 'integrity.json' && !Object.hasOwn(hashes, path))) throw new Error('模型压缩包存在未声明摘要的资产。');
  }
  if (Object.hasOwn(entries, PROJECT_ENTRY)) return restoreProjectEntries(entries);
  if (/\.pa\.zip$/i.test(file.name)) throw new Error('编辑工程缺少 authoring.json。');
  return { entries, candidates: discoverCandidates(entries) };
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetchRuntimeAsset(url, undefined, undefined, MAX_FILE);
  if (!response.ok) throw new Error(`读取资产失败（${response.status}）：${url}`);
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_FILE) { await response.body?.cancel(); throw new Error('远程资产过大。'); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_FILE) { await reader.cancel(); throw new Error('远程资产过大。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function loadCatalogModel(item: CatalogModel): Promise<AuthoringSession> {
  const entries: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  const [modelBytes, metaBytes, modelJsonBytes, thumbnailBytes] = await Promise.all([
    fetchBytes(item.modelUrl), item.metaUrl ? fetchBytes(item.metaUrl) : null,
    item.modelJsonUrl ? fetchBytes(item.modelJsonUrl) : null, item.thumbnailUrl ? fetchBytes(item.thumbnailUrl) : null,
  ]);
  const modelJson = modelJsonBytes ? parseJson(modelJsonBytes, 'model.json') : {};
  const modelPath = safeAssetPath(baseName(typeof modelJson.fileName === 'string' ? modelJson.fileName : decodeURIComponent(new URL(item.modelUrl, location.href).pathname)));
  entries[modelPath] = modelBytes;
  const candidate: ArchiveCandidate = { id: item.id, name: item.name, modelPath, scriptPaths: [] };
  if (metaBytes) { entries['meta.json'] = metaBytes; candidate.metaPath = 'meta.json'; }
  if (modelJsonBytes) { entries['model.json'] = modelJsonBytes; candidate.modelJsonPath = 'model.json'; }
  if (thumbnailBytes) {
    const name = typeof modelJson.thumbnailFileName === 'string' ? modelJson.thumbnailFileName : 'thumbnail.png';
    candidate.thumbnailPath = 'thumbnail/' + safeAssetPath(baseName(name));
    entries[candidate.thumbnailPath] = thumbnailBytes;
  }
  for (const script of item.scripts) {
    const path = 'scripts/' + safeAssetPath(script.name);
    if (Object.hasOwn(entries, path)) throw new Error(`目录脚本重名：${script.name}`);
    entries[path] = await fetchBytes(script.url); candidate.scriptPaths.push(path);
  }
  const references = glbReferences(entries[modelPath]);
  if (candidate.metaPath) {
    const meta = parseJson(entries[candidate.metaPath], 'meta.json');
    for (const field of originalParameterDefinitions(meta)) {
      if (field.type !== 'texture') continue;
      const parameter = readParameters(meta).find(item => item.key === field.key);
      const refs = [field.defaultValue, parameter?.value, ...(Array.isArray(field.options) ? field.options.map(option => objectRecord(option).value) : [])];
      for (const value of refs) if (typeof value === 'string' && value) references.push(safeAssetPath(value));
    }
  }
  for (const reference of new Set(references)) if (!Object.hasOwn(entries, reference)) entries[reference] = await fetchBytes(new URL(reference, new URL(item.modelUrl, location.href)).href);
  return openArchiveCandidate({ entries, candidates: [candidate] }, item.id);
}

export async function addImageAsset(file: File): Promise<BinaryAsset> {
  if (file.size > 32 * 1024 * 1024) throw new Error('图像超过 32 MiB 上限。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = bytes.length >= 24 && bytes[0] === 137 && decoder.decode(bytes.subarray(1, 4)) === 'PNG';
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
  if (!png && !jpeg && !webp) throw new Error('图片只支持有效的 PNG、JPEG 或 WebP，不接受 SVG/脚本。');
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes).buffer]));
  try {
    if (bitmap.width > 16384 || bitmap.height > 16384 || bitmap.width * bitmap.height > 64 * 1024 * 1024) throw new Error('图片像素尺寸过大。');
  } finally { bitmap.close(); }
  const id = newId('image');
  const extension = png ? 'png' : jpeg ? 'jpg' : 'webp';
  return makeAsset(`textures/${id}.${extension}`, bytes, id);
}

export function validateProjectShape(value: unknown): asserts value is AuthoringProject {
  const project = objectRecord(value);
  if (project.schema !== 'zending.parametric-authoring' || project.version !== 1 || typeof project.id !== 'string' || typeof project.name !== 'string') throw new Error('不支持的参数化工程格式或版本。');
  for (const key of ['nodes', 'parts', 'parameters', 'rules', 'regions', 'layers', 'textureAssets']) {
    if (!Array.isArray(project[key]) || (project[key] as unknown[]).length > 100000) throw new Error(`工程 ${key} 格式错误或数量过多。`);
  }
  if (!project.source || typeof project.source !== 'object' || !Array.isArray(objectRecord(project.source).scripts)) throw new Error('工程缺少源模型声明。');
  if (typeof objectRecord(project.legacy).enabled !== 'boolean' || !project.limits) throw new Error('工程运行配置不完整。');
}

export async function validateSessionAssets(session: AuthoringSession): Promise<void> {
  validateProjectShape(session.project);
  const source = session.project.source!;
  const units: Record<string, number> = { meter: 1, centimeter: 0.01, millimeter: 0.001 };
  if (!Object.hasOwn(units, source.unit) || source.unitScale !== units[source.unit]) throw new Error('源模型单位与倍率不一致。');
  for (const parameter of session.project.parameters) {
    if (!parameter || typeof parameter.key !== 'string' || ['__proto__', 'prototype', 'constructor', 'node', 'onStart', 'onUpdate', 'onStop', 'runtimeMode', 'runtimeTelemetry', 'assetCode'].includes(parameter.key) || parameter.key.startsWith('__pa')) throw new Error('参数名与宿主保留成员冲突。');
  }
  if (session.assets.size > MAX_ENTRIES) throw new Error('工程资产过多。');
  let total = 0;
  const paths = new Set<string>();
  for (const [id, asset] of session.assets) {
    if (id !== asset.id || !(asset.bytes instanceof Uint8Array) || !/^[a-f\d]{64}$/.test(asset.sha256)) throw new Error('资产索引格式错误。');
    const path = safeAssetPath(asset.path).toLowerCase();
    if (paths.has(path)) throw new Error(`资产路径重复：${asset.path}`);
    paths.add(path);
    total += asset.bytes.length;
    if (asset.bytes.length > MAX_FILE || total > MAX_TOTAL) throw new Error('工程资产尺寸超过限制。');
    if (await sha256(asset.bytes) !== asset.sha256) throw new Error(`资产 SHA-256 校验失败：${asset.fileName}`);
  }
  const model = session.assets.get(source.modelAssetId);
  if (!model || model.sha256 !== source.sha256) throw new Error('源模型丢失或摘要发生变化，必须重新绑定。');
  const unitScale = { meter: 1, centimeter: 0.01, millimeter: 0.001 }[source.unit];
  if (!unitScale || source.unitScale !== unitScale) throw new Error('源模型单位及倍率不一致。');
  if (source.fileName !== baseName(source.fileName) || source.fileName !== model.fileName) throw new Error('源模型文件名与资产索引不一致。');
  const pathsExact = new Set([...session.assets.values()].map(asset => asset.path));
  for (const reference of glbReferences(model.bytes)) if (!pathsExact.has(directory(model.path) + reference)) throw new Error(`模型外部资源缺失：${reference}`);
  for (const script of source.scripts) {
    const asset = session.assets.get(script.assetId);
    if (!asset || asset.path !== script.path) throw new Error(`原脚本资产丢失或路径不一致：${script.fileName}`);
  }
  for (const definition of originalParameterDefinitions(source.originalMeta)) {
    if (definition.type !== 'texture') continue;
    const parameter = session.project.parameters.find(item => item.key === definition.key);
    const references = [definition.defaultValue, parameter?.value, ...(Array.isArray(definition.options) ? definition.options.map(option => objectRecord(option).value) : [])];
    for (const reference of references) if (typeof reference === 'string' && reference && !pathsExact.has(directory(model.path) + safeAssetPath(reference))) throw new Error(`模型参数图像资源缺失：${reference}`);
  }
  if (source.thumbnailAssetId && !session.assets.has(source.thumbnailAssetId)) throw new Error('模型缩略图资产丢失。');
  for (const descriptor of session.project.textureAssets) {
    const asset = session.assets.get(descriptor.id);
    if (!asset || asset.sha256 !== descriptor.sha256 || asset.path !== descriptor.path || !asset.mediaType.startsWith('image/')) throw new Error(`图像资产缺失或摘要不一致：${descriptor.fileName}`);
  }
  for (const layer of session.project.layers) if (layer.textureId && !session.assets.has(layer.textureId)) throw new Error(`图层「${layer.label}」缺少图像。`);
  await trustedTemplate(session.project, session.assets);
}

type StoredAsset = AssetDescriptor & { entry: string };
function descriptor(asset: BinaryAsset): AssetDescriptor {
  return { id: asset.id, path: asset.path, fileName: asset.fileName, mediaType: asset.mediaType, sha256: asset.sha256 };
}

async function projectEntries(session: AuthoringSession): Promise<Record<string, Uint8Array>> {
  await validateSessionAssets(session);
  const entries: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  const manifest: StoredAsset[] = [];
  let index = 0;
  for (const asset of session.assets.values()) {
    const entry = `assets/${String(++index).padStart(5, '0')}/${safeAssetPath(asset.fileName)}`;
    entries[entry] = asset.bytes;
    manifest.push({ ...descriptor(asset), entry });
  }
  entries[PROJECT_ENTRY] = strToU8(JSON.stringify(session.project, null, 2));
  entries[MANIFEST_ENTRY] = strToU8(JSON.stringify({ schema: 'zending.authoring-assets', version: 1, assets: manifest }, null, 2));
  return entries;
}

async function restoreProjectEntries(entries: Record<string, Uint8Array>): Promise<AuthoringSession> {
  if (!entries[MANIFEST_ENTRY]) throw new Error('工程缺少资产清单。');
  const project = parseJson(entries[PROJECT_ENTRY], PROJECT_ENTRY);
  validateProjectShape(project);
  const manifest = parseJson(entries[MANIFEST_ENTRY], MANIFEST_ENTRY);
  if (manifest.schema !== 'zending.authoring-assets' || manifest.version !== 1 || !Array.isArray(manifest.assets)) throw new Error('资产清单版本或结构无效。');
  const assets = new Map<string, BinaryAsset>();
  const used = new Set([PROJECT_ENTRY, MANIFEST_ENTRY]);
  for (const value of manifest.assets) {
    const item = objectRecord(value);
    for (const key of ['id', 'path', 'fileName', 'mediaType', 'sha256', 'entry']) if (typeof item[key] !== 'string') throw new Error('资产声明字段不完整。');
    const record = item as unknown as StoredAsset;
    safeAssetPath(record.entry); safeAssetPath(record.path); safeAssetPath(record.fileName);
    if (!entries[record.entry] || assets.has(record.id) || used.has(record.entry)) throw new Error(`工程资产缺失或重复：${record.path}`);
    used.add(record.entry);
    assets.set(record.id, { id: record.id, path: record.path, fileName: record.fileName, mediaType: record.mediaType, sha256: record.sha256, bytes: entries[record.entry] });
  }
  if (Object.keys(entries).some(path => !used.has(path))) throw new Error('工程含有未列入资产清单的文件。');
  const session: AuthoringSession = { project, assets };
  await validateSessionAssets(session);
  return session;
}

export function downloadBytes(bytes: Uint8Array, name: string, mime = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = baseName(name); anchor.style.display = 'none';
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
}

export async function saveProjectFile(session: AuthoringSession): Promise<void> {
  const entries = await projectEntries(structuredClone(session));
  const bytes = zipSync(entries, { level: 6 });
  if (bytes.length > MAX_FILE) throw new Error('工程 ZIP 超过可重开上限 256 MiB，请缩小资产。');
  downloadBytes(bytes, `${session.project.name}.pa.zip`, 'application/zip');
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('zending-parametric-authoring', 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('sessions')) request.result.createObjectStore('sessions'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地工程数据库。'));
    request.onblocked = () => reject(new Error('工程数据库升级被其他窗口阻塞，请关闭旧窗口。'));
  });
}

let persistenceQueue: Promise<void> = Promise.resolve();
export function persistSession(session: AuthoringSession): Promise<void> {
  // 立即快照，再按调用顺序落盘，避免较慢的旧摘要覆盖更新的编辑状态。
  const snapshot = structuredClone(session);
  const operation = persistenceQueue.catch(() => undefined).then(async () => {
    const entries = await projectEntries(snapshot);
    const db = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('sessions', 'readwrite');
        transaction.objectStore('sessions').put(entries, 'latest');
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('本地保存失败，可能存储空间不足。'));
      });
    } finally { db.close(); }
  });
  persistenceQueue = operation;
  return operation;
}

export async function readSavedSession(): Promise<AuthoringSession | null> {
  await persistenceQueue;
  const db = await openDatabase();
  try {
    const entries = await new Promise<Record<string, Uint8Array> | undefined>((resolve, reject) => {
      const transaction = db.transaction('sessions', 'readonly');
      const request = transaction.objectStore('sessions').get('latest');
      transaction.oncomplete = () => resolve(request.result as Record<string, Uint8Array> | undefined);
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('读取本地工程失败。'));
    });
    return entries ? restoreProjectEntries(entries) : null;
  } finally { db.close(); }
}
