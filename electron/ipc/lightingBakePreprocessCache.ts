import { createHash, type Hash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { LightingBakeBinaryAttribute } from '../shared/sceneLightingBakeBinary.ts';
import type { LightingBakeMeshInput, SceneLightingBakeSettings } from '../shared/sceneLightingBakeContract.ts';
import type { LightingBakeResourceBudget } from '../shared/sceneLightingBakeResources.ts';
import type { LightingBakePreprocessDiagnostic } from '../shared/sceneLightingBakeTasks.ts';
import { LIGHTING_LIGHTMAP_MIP_RECIPE } from '../shared/sceneLightingTextureCodec.ts';
import { inspectLightingBakePreprocessHistory, revalidateLightingBakePreprocessCandidate } from './lightingBakeTaskHistory.ts';

const FORMAT = 'lighting-bake-packed-uv-v1';
const FIELDS = ['positions', 'normals', 'indices', 'uvs', 'uvs2', 'colors', 'tangents'] as const;
const WIDTHS = { positions: 3, normals: 3, indices: 1, uvs: 2, uvs2: 2, colors: 4, tangents: 4 };
type Field = typeof FIELDS[number];
type StagedMesh = Omit<LightingBakeMeshInput, Field> & {
  geometryBinary: { version: number; file: string; byteLength: number; attributes: Partial<Record<Field, LightingBakeBinaryAttribute>> };
};
type StagedInput = { version: number; settings: SceneLightingBakeSettings; meshes: StagedMesh[]; preprocessCache?: LightingBakePreprocessControl };
type Attribute = { byteOffset: number; length: number; type: 'float64' | 'uint32' | 'float32' };
type PackedObject = {
  sourceIndex: number; key: string; vertexCount: number; triangleCount: number; atlas: number | null; repairCount: number;
  attributes: Partial<Record<Field, Attribute>>; loopVertices: Attribute; winding: Attribute; lightmapUvs: Attribute;
};
type Manifest = {
  format: string; stage: string; inputKey: string; algorithmKey: string; key: string; blenderVersion: string; blenderBuild: string;
  inputCount: number; objects: PackedObject[]; pages: number[][]; payload: { byteLength: number; sha256: string };
};
export type LightingBakePreprocessControl = {
  version: 1; inputKey: string; algorithmKey: string; maxPayloadBytes: number; maxManifestBytes: number; maxObjects: number;
  maxWorkingBytes: number; maxWriteBytes: number; chunkBytes: number; lookupDurationMs: number; reason: string;
  candidate?: { manifestSha256: string; payloadSha256: string; key: string };
};
type Options = {
  projectRoot: string; directory: string; resourceBudget: LightingBakeResourceBudget; backendEstimateBytes: number;
  engineVersion?: string; assertActive: () => void;
};
type ReadBudget = { remaining: number; chunkBytes: number; assertActive: () => void };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
const digestPattern = /^[a-f0-9]{64}$/;
function requireCache(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function keys(value: object, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function sameDevice(left: number, right: number): boolean {
  // Windows/libuv 的路径 lstat 可返回 dev=0，而同文件 fstat 返回真实卷号；路径+inode 仍严格核对。
  return left === right || process.platform === 'win32' && (left === 0 || right === 0);
}

/** 数字按 IEEE-754 编码，避免 JS/Python 的指数/负零 JSON 表示差异；不使用场景总 signature。 */
function hashValue(hash: Hash, value: unknown): void {
  const count = (number: number) => { const bytes = Buffer.allocUnsafe(4); bytes.writeUInt32LE(number); hash.update(bytes); };
  if (value === null) { hash.update('n'); return; }
  if (typeof value === 'boolean') { hash.update(value ? 't' : 'f'); return; }
  if (typeof value === 'number') {
    requireCache(Number.isFinite(value), 'UV 缓存身份含非有限数值。');
    const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleLE(value); hash.update('d'); hash.update(bytes); return;
  }
  if (typeof value === 'string') { const bytes = Buffer.from(value); hash.update('s'); count(bytes.length); hash.update(bytes); return; }
  if (Array.isArray(value)) { hash.update('a'); count(value.length); for (const item of value) hashValue(hash, item); return; }
  requireCache(value && typeof value === 'object', 'UV 缓存身份字段无效。');
  const record = value as Record<string, unknown>, names = Object.keys(record).sort();
  hash.update('o'); count(names.length); for (const name of names) { hashValue(hash, name); hashValue(hash, record[name]); }
}
function identityHash(value: unknown): string { const hash = createHash('sha256'); hashValue(hash, value); return hash.digest('hex'); }
function consume(budget: ReadBudget, bytes: number): void {
  budget.assertActive(); requireCache(integer(bytes) && bytes <= budget.remaining, 'UV 缓存超过本任务读取预算。'); budget.remaining -= bytes;
}
async function openRegular(directory: string, name: string, maximum: number) {
  requireCache(path.basename(name) === name && name !== '.' && name !== '..', 'UV 缓存文件名无效。');
  const file = path.join(directory, name), before = await fs.lstat(file);
  requireCache(before.isFile() && !before.isSymbolicLink() && before.size <= maximum
    && await fs.realpath(directory) === directory && await fs.realpath(file) === file, 'UV 缓存文件非普通文件、越界或超过预算。');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    requireCache(opened.isFile() && integer(before.ino, 1) && sameDevice(opened.dev, before.dev) && opened.ino === before.ino
      && opened.size === before.size && opened.mtimeMs === before.mtimeMs, 'UV 缓存文件读取期间发生替换。');
    return { handle, file, stat: opened };
  } catch (error) { await handle.close(); throw error; }
}
async function unchanged(opened: Awaited<ReturnType<typeof openRegular>>): Promise<void> {
  const after = await fs.lstat(opened.file), current = await opened.handle.stat();
  requireCache(after.isFile() && !after.isSymbolicLink() && after.ino === opened.stat.ino && sameDevice(after.dev, opened.stat.dev)
    && after.size === opened.stat.size && after.mtimeMs === opened.stat.mtimeMs && current.size === opened.stat.size && current.mtimeMs === opened.stat.mtimeMs
    && await fs.realpath(opened.file) === opened.file, 'UV 缓存文件读取期间发生变化。');
}
async function readSmall(directory: string, name: string, maximum: number, budget: ReadBudget): Promise<Buffer> {
  const opened = await openRegular(directory, name, maximum);
  try {
    consume(budget, opened.stat.size);
    const bytes = Buffer.allocUnsafe(opened.stat.size);
    for (let offset = 0; offset < bytes.length;) {
      budget.assertActive(); const count = Math.min(budget.chunkBytes, bytes.length - offset);
      const { bytesRead } = await opened.handle.read(bytes, offset, count, offset);
      requireCache(bytesRead === count, 'UV 缓存清单读取不完整。'); offset += count;
    }
    await unchanged(opened); return bytes;
  } finally { await opened.handle.close(); }
}
async function hashRange(opened: Awaited<ReturnType<typeof openRegular>>, start: number, length: number, budget: ReadBudget): Promise<string> {
  requireCache(integer(start) && integer(length) && start + length <= opened.stat.size, 'UV 输入属性范围无效。');
  consume(budget, length);
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.min(budget.chunkBytes, Math.max(1, length)));
  for (let offset = 0; offset < length;) {
    budget.assertActive(); const count = Math.min(buffer.length, length - offset);
    const { bytesRead } = await opened.handle.read(buffer, 0, count, start + offset);
    requireCache(bytesRead === count, 'UV 输入属性读取不完整。'); hash.update(buffer.subarray(0, count)); offset += count;
  }
  return hash.digest('hex');
}
function materialUvIdentity(mesh: StagedMesh): unknown {
  const material = mesh.material, textures = material.textures ?? {};
  return { fields: Object.keys(material).sort(), textures: Object.keys(textures).sort().map(kind => {
    const entry = textures[kind as keyof typeof textures];
    return [kind, entry && typeof entry === 'object' ? entry.coordinatesIndex ?? null : null];
  }) };
}
async function inputKey(input: StagedInput, directory: string, budget: ReadBudget): Promise<string> {
  requireCache(input.version === 1 && Array.isArray(input.meshes), 'UV 输入版本无效。');
  const settings = input.settings, levels = settings.lightmapMipLevels ?? 0;
  const hash = createHash('sha256');
  hashValue(hash, { format: FORMAT, recipe: 'world-partition64-24-smart66-margin002-repair-jacobian-shelf-v1',
    materialSlots: 'source-order-single-slot0', inputVersion: input.version, count: input.meshes.length,
    atlasSize: settings.atlasSize, density: settings.texelsPerMeter, textureBudgetMiB: settings.maxTextureMiB,
    mipLevels: levels, mipRecipe: LIGHTING_LIGHTMAP_MIP_RECIPE, encoding: settings.lightmapEncoding ?? 'rgbm',
    gutter: levels === 0 ? 4 : Math.ceil(1.5 * (1 << levels)) + 2 });
  for (const mesh of input.meshes) {
    const binary = mesh.geometryBinary;
    requireCache(binary?.version === 1 && /^geometry-input-\d+\.bin$/.test(binary.file), 'UV 缓存仅支持已验证的二进制输入。');
    const opened = await openRegular(directory, binary.file, budget.remaining);
    try {
      requireCache(opened.stat.size === binary.byteLength, 'UV 输入几何字节数无效。');
      const attributes: Record<string, unknown> = {}, ranges: Array<[number, number]> = [];
      for (const field of FIELDS) {
        const attribute = binary.attributes[field]; if (!attribute) continue;
        const width = field === 'indices' ? 4 : 8;
        requireCache(attribute.type === (field === 'indices' ? 'uint32' : 'float64') && integer(attribute.byteOffset, 8)
          && attribute.byteOffset % width === 0 && integer(attribute.length) && integer(attribute.length * width)
          && !ranges.some(([start, end]) => attribute.byteOffset < end && attribute.byteOffset + attribute.length * width > start), 'UV 输入属性布局无效。');
        ranges.push([attribute.byteOffset, attribute.byteOffset + attribute.length * width]);
        attributes[field] = { type: attribute.type, length: attribute.length,
          sha256: await hashRange(opened, attribute.byteOffset, attribute.length * width, budget) };
      }
      requireCache(attributes.positions && attributes.normals && attributes.indices, 'UV 输入缺少必需几何。');
      hashValue(hash, { key: mesh.key, entityId: mesh.entityId, nodeKey: mesh.nodeKey, name: mesh.name,
        worldMatrix: mesh.worldMatrix, receiver: mesh.receiver ?? true, materialUv: materialUvIdentity(mesh), attributes });
      await unchanged(opened);
    } finally { await opened.handle.close(); }
  }
  return hash.digest('hex');
}
function validateManifest(value: unknown, input: StagedInput, control: LightingBakePreprocessControl): Manifest {
  const manifest = value as Manifest;
  requireCache(manifest && typeof manifest === 'object' && keys(manifest, ['format', 'stage', 'inputKey', 'algorithmKey', 'key', 'blenderVersion', 'blenderBuild', 'inputCount', 'objects', 'pages', 'payload'])
    && manifest.format === FORMAT && manifest.stage === 'packed' && manifest.inputKey === control.inputKey && manifest.algorithmKey === control.algorithmKey
    && typeof manifest.blenderVersion === 'string' && manifest.blenderVersion.length <= 128 && typeof manifest.blenderBuild === 'string' && manifest.blenderBuild.length <= 128
    && manifest.key === identityHash([FORMAT, manifest.inputKey, manifest.algorithmKey, manifest.blenderVersion, manifest.blenderBuild]), 'UV 缓存身份或版本不匹配。');
  requireCache(manifest.inputCount === input.meshes.length && Array.isArray(manifest.objects) && manifest.objects.length <= control.maxObjects
    && manifest.objects.length >= manifest.inputCount && Array.isArray(manifest.pages) && manifest.pages.length <= manifest.objects.length
    && manifest.payload && keys(manifest.payload, ['byteLength', 'sha256']) && integer(manifest.payload.byteLength, 8)
    && manifest.payload.byteLength <= control.maxPayloadBytes && digestPattern.test(manifest.payload.sha256), 'UV 缓存清单数量或载荷预算无效。');
  let offset = 8;
  const attribute = (item: Attribute | undefined, type: Attribute['type'], length: number) => {
    const width = type === 'float64' ? 8 : 4; offset = Math.ceil(offset / width) * width;
    requireCache(item && keys(item, ['byteOffset', 'length', 'type']) && item.type === type && item.byteOffset === offset
      && integer(length) && item.length === length && integer(length * width) && offset + length * width <= manifest.payload.byteLength, 'UV 缓存属性偏移、类型或数量无效。');
    offset += length * width;
  };
  const sourceCounts = new Array<number>(input.meshes.length).fill(0), keysSeen = new Set<string>();
  let previousSource = 0;
  manifest.objects.forEach((object, index) => {
    requireCache(object && keys(object, ['sourceIndex', 'key', 'vertexCount', 'triangleCount', 'atlas', 'repairCount', 'attributes', 'loopVertices', 'winding', 'lightmapUvs'])
      && integer(object.sourceIndex) && object.sourceIndex >= previousSource && object.sourceIndex < input.meshes.length
      && typeof object.key === 'string' && object.key.length <= control.maxManifestBytes && !keysSeen.has(object.key)
      && integer(object.vertexCount, 1) && integer(object.triangleCount, 1) && integer(object.repairCount) && object.repairCount <= object.triangleCount,
    'UV 缓存来源顺序或对象数量无效。');
    previousSource = object.sourceIndex; sourceCounts[object.sourceIndex]++; keysSeen.add(object.key);
    const source = input.meshes[object.sourceIndex], expected = source.geometryBinary.attributes;
    requireCache(object.attributes && keys(object.attributes, [...FIELDS]) && FIELDS.every(field => Boolean(expected[field]) === Boolean(object.attributes[field])), 'UV 缓存属性映射不匹配。');
    for (const field of FIELDS) if (object.attributes[field]) attribute(object.attributes[field], field === 'indices' ? 'uint32' : 'float64', field === 'indices' ? object.triangleCount * 3 : object.vertexCount * WIDTHS[field]);
    attribute(object.loopVertices, 'uint32', object.triangleCount * 3);
    attribute(object.winding, 'uint32', object.triangleCount);
    attribute(object.lightmapUvs, 'float32', object.triangleCount * 6);
    requireCache(source.receiver === false ? object.atlas === null && object.key === source.key
      : integer(object.atlas) && object.atlas < manifest.pages.length, 'UV 缓存 receiver/图集映射无效。');
    requireCache(index < control.maxObjects, 'UV 缓存对象预算无效。');
  });
  requireCache(offset === manifest.payload.byteLength && sourceCounts.every(count => count > 0), 'UV 缓存载荷长度或整包覆盖无效。');
  const members = new Set<number>();
  manifest.pages.forEach((page, atlas) => {
    requireCache(Array.isArray(page) && page.length > 0, 'UV 缓存包含空图集。');
    for (const index of page) {
      requireCache(integer(index) && index < manifest.objects.length && !members.has(index) && manifest.objects[index].atlas === atlas, 'UV 缓存图集成员无效。'); members.add(index);
    }
  });
  requireCache(manifest.objects.every((object, index) => (object.atlas !== null) === members.has(index)), 'UV 缓存图集覆盖不完整。');
  return manifest;
}
async function stageCandidate(directory: string, target: string, manifestBytes: Buffer, manifest: Manifest, budget: ReadBudget,
  revalidate: () => Promise<void>): Promise<void> {
  const owned = new Set<string>();
  try {
    const opened = await openRegular(directory, 'preprocess-cache.bin', manifest.payload.byteLength);
    try {
      requireCache(opened.stat.size === manifest.payload.byteLength, 'UV 缓存载荷长度不一致。'); consume(budget, opened.stat.size);
      const output = await fs.open(path.join(target, 'preprocess-cache.bin.tmp'), 'wx'); owned.add('preprocess-cache.bin.tmp');
      try {
        const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.min(budget.chunkBytes, opened.stat.size));
        for (let offset = 0; offset < opened.stat.size;) {
          budget.assertActive(); const count = Math.min(buffer.length, opened.stat.size - offset);
          const { bytesRead } = await opened.handle.read(buffer, 0, count, offset);
          requireCache(bytesRead === count && (offset !== 0 || buffer.subarray(0, 8).equals(Buffer.from('BLUV0001'))), 'UV 缓存载荷头或读取长度无效。');
          hash.update(buffer.subarray(0, count)); await output.writeFile(buffer.subarray(0, count)); offset += count;
        }
        requireCache(hash.digest('hex') === manifest.payload.sha256, 'UV 缓存载荷 SHA 不匹配。'); await output.sync();
      } finally { await output.close(); }
      await unchanged(opened);
    } finally { await opened.handle.close(); }
    await revalidate(); budget.assertActive();
    await fs.writeFile(path.join(target, 'preprocess-cache.json.tmp'), manifestBytes, { flag: 'wx' }); owned.add('preprocess-cache.json.tmp');
    await fs.rename(path.join(target, 'preprocess-cache.bin.tmp'), path.join(target, 'preprocess-cache.bin')); owned.delete('preprocess-cache.bin.tmp'); owned.add('preprocess-cache.bin');
    budget.assertActive();
    await fs.rename(path.join(target, 'preprocess-cache.json.tmp'), path.join(target, 'preprocess-cache.json')); owned.delete('preprocess-cache.json.tmp'); owned.add('preprocess-cache.json');
  } catch (error) {
    for (const name of owned) await fs.unlink(path.join(target, name)).catch(() => {});
    throw error;
  }
}

/** 可选缓存受同一资源预算约束：读取总量<=maxInputBytes；项目缓存<=maxInputBytes；
 * 单包额外内存按载荷8倍+清单8倍预留，磁盘保留双份原子写空间。不删除历史腾额度。 */
export async function prepareLightingBakePreprocessCache(options: Options): Promise<{
  input?: StagedInput; diagnostic: LightingBakePreprocessDiagnostic;
}> {
  const started = Date.now(), resource = options.resourceBudget;
  const budget: ReadBudget = { remaining: resource.maxInputBytes, chunkBytes: resource.chunkBytes, assertActive: options.assertActive };
  try {
    const working = Math.floor(Math.min(resource.workingBytes, Math.max(0, resource.backendBytes - options.backendEstimateBytes)));
    requireCache(working >= resource.chunkBytes * 16, 'UV 缓存额外工作内存不足，沿原路径。');
    const history = await inspectLightingBakePreprocessHistory(options.projectRoot, options.directory, budget.remaining, options.assertActive);
    consume(budget, history.readBytes);
    const disk = await fs.statfs(options.directory), freeBytes = disk.bavail * disk.bsize;
    const writeLimit = Math.floor(Math.min(resource.maxInputBytes - history.cacheBytes, freeBytes - resource.reserveBytes) / 2);
    const maxManifestBytes = Math.min(resource.chunkBytes, Math.floor(working / 32));
    const maxPayloadBytes = Math.floor(Math.min(working / 8 - maxManifestBytes, writeLimit - maxManifestBytes));
    requireCache(maxPayloadBytes >= resource.chunkBytes, 'UV 缓存项目或磁盘额度不足，沿原路径。');
    const inputBytes = await readSmall(options.directory, 'input.json', maxManifestBytes, budget);
    const input = JSON.parse(inputBytes.toString('utf8')) as StagedInput;
    const currentInputKey = await inputKey(input, options.directory, budget);
    const scripts: Array<[string, string]> = [];
    for (const name of ['cycles_bake.py', 'preprocess_cache.py', ...((input.settings.lightmapMipLevels ?? 0) ? ['lightmap_mips.py'] : [])]) {
      scripts.push([name, sha(await readSmall(options.directory, name, resource.chunkBytes, budget))]);
    }
    const control: LightingBakePreprocessControl = { version: 1, inputKey: currentInputKey, algorithmKey: identityHash(scripts),
      maxPayloadBytes, maxManifestBytes, maxObjects: Math.floor(maxManifestBytes / 512), maxWorkingBytes: working,
      maxWriteBytes: maxPayloadBytes + maxManifestBytes, chunkBytes: resource.chunkBytes, lookupDurationMs: 0, reason: '无匹配的已完成 UV/布局缓存' };
    let invalid = 0;
    for (const candidate of history.candidates) {
      options.assertActive();
      try {
        const bytes = await readSmall(candidate.directory, 'preprocess-cache.json', maxManifestBytes, budget);
        const manifest = validateManifest(JSON.parse(bytes.toString('utf8')), input, control);
        if (options.engineVersion && manifest.blenderVersion.match(/^\d+\.\d+(?:\.\d+)?/)?.[0] !== options.engineVersion.match(/\d+\.\d+(?:\.\d+)?/)?.[0]) continue;
        requireCache(bytes.length + manifest.payload.byteLength <= control.maxWriteBytes, 'UV 缓存整包超过磁盘额度。');
        await stageCandidate(candidate.directory, options.directory, bytes, manifest, budget, async () => {
          requireCache(await revalidateLightingBakePreprocessCandidate(options.projectRoot, candidate.taskId) === candidate.directory, 'UV 缓存目录发生变化。');
        });
        control.candidate = { manifestSha256: sha(bytes), payloadSha256: manifest.payload.sha256, key: manifest.key };
        control.reason = '已暂存同工程已完成任务的 UV/布局包，等待 Blender 身份与密度复验'; break;
      } catch (error) {
        options.assertActive();
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') && !(error instanceof Error && error.message.includes('身份或版本不匹配'))) invalid++;
      }
    }
    if (!control.candidate && invalid) control.reason += `（${invalid} 个候选缺损或不满足预算/校验）`;
    control.lookupDurationMs = Date.now() - started; input.preprocessCache = control;
    return { input, diagnostic: { status: 'miss', reason: control.reason, lookupDurationMs: control.lookupDurationMs } };
  } catch (error) {
    options.assertActive();
    return { diagnostic: { status: 'skipped', reason: (error instanceof Error ? error.message : String(error)).slice(0, 1024), lookupDurationMs: Date.now() - started } };
  }
}
