import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { MAX_GLB_FILE_BYTES } from '../shared/glbFilePolicy.js';
import { analyzeManualRoamHumanoid, type ManualRoamHumanoidMetadata } from '../shared/manualRoamHumanoid.js';

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
type FileHandle = Awaited<ReturnType<typeof fs.open>>;
type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readExactly(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset);
    if (!bytesRead) throw new Error('GLB 文件提前结束。');
    offset += bytesRead;
  }
  return bytes;
}

async function writeExactly(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (!bytesWritten) throw new Error('人物 GLB 写入未完成。');
    offset += bytesWritten;
  }
}

function prepareAdaptation(gltf: JsonObject): ManualRoamHumanoidMetadata | null {
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  // 已有正式骨架声明继续交给原运行时严格验证，不覆盖其参考姿态或声明。
  if (nodes.some(node => object(node) && object(node.extras) && node.extras.manualRoamRig)) return null;
  if (!Array.isArray(gltf.skins) || !gltf.skins.length) return null;
  let analysis: ReturnType<typeof analyzeManualRoamHumanoid>;
  try {
    analysis = analyzeManualRoamHumanoid(gltf);
  } catch {
    // 不能识别的人物保留旧导入能力；预览运行时会显示原因并使用自带动画或静态外观。
    return null;
  }
  const root = nodes[analysis.rootNodeIndex];
  if (!object(root)) throw new Error('人物自动适配没有找到可保存的骨架根节点。');
  // glTF extras 允许任意 JSON；无法无损追加时由运行时即时识别，不能覆盖用户数据。
  if (root.extras !== undefined && !object(root.extras)) return null;
  const extras = root.extras as JsonObject | undefined;
  const existing = extras?.manualRoamHumanoid;
  if (object(existing) && existing.version === analysis.metadata.version
    && existing.algorithm === analysis.metadata.algorithm && existing.motionProfile === analysis.metadata.motionProfile
    && typeof existing.sourceHash === 'string' && /^[0-9a-f]{64}$/i.test(existing.sourceHash)
    && JSON.stringify(existing.joints) === JSON.stringify(analysis.metadata.joints)) return null;
  const metadata = { ...analysis.metadata, sourceHash: '0'.repeat(64) };
  root.extras = { ...extras, manualRoamHumanoid: metadata };
  return metadata;
}

function encodeJsonChunk(gltf: JsonObject): Buffer {
  const json = Buffer.from(JSON.stringify(gltf));
  const padding = (4 - json.length % 4) % 4;
  if (json.length + padding > MAX_JSON_BYTES) throw new Error('人物适配后的 GLB JSON chunk 超过 64 MiB 上限。');
  return padding ? Buffer.concat([json, Buffer.alloc(padding, 32)]) : json;
}

/**
 * 输入由导入器完成 GLB 自包含校验。仅在项目副本追加适配数据，BIN 及未知 chunk 原字节流复制。
 * SHA-256 在同一次复制中计算，再回填固定长度字段；无须把大型 GLB 整体载入内存。
 */
export async function copyManualRoamAvatarWithAdaptation(sourcePath: string, targetPath: string): Promise<void> {
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 20 || stat.size > MAX_GLB_FILE_BYTES) {
    throw new Error('人物 GLB 文件类型或长度无效。');
  }
  const source = await fs.open(sourcePath, 'r');
  let target: FileHandle | undefined;
  let created = false;
  try {
    const openedStat = await source.stat();
    if (!openedStat.isFile() || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino
      || openedStat.size !== stat.size || openedStat.mtimeMs !== stat.mtimeMs || openedStat.ctimeMs !== stat.ctimeMs) {
      throw new Error('人物 GLB 在读取前已发生变化，请重新上传。');
    }
    const sourceHeader = await readExactly(source, 20, 0);
    const jsonLength = sourceHeader.readUInt32LE(12);
    if (sourceHeader.toString('ascii', 0, 4) !== 'glTF' || sourceHeader.readUInt32LE(4) !== 2
      || sourceHeader.readUInt32LE(8) !== stat.size || sourceHeader.toString('ascii', 16, 20) !== 'JSON'
      || jsonLength === 0 || jsonLength % 4 || jsonLength > MAX_JSON_BYTES || jsonLength + 20 > stat.size) {
      throw new Error('人物 GLB 头或 JSON chunk 无效。');
    }
    const sourceJson = await readExactly(source, jsonLength, 20);
    let jsonEnd = sourceJson.length;
    while (jsonEnd > 0 && (sourceJson[jsonEnd - 1] === 0 || sourceJson[jsonEnd - 1] === 32)) jsonEnd--;
    const parsed: unknown = JSON.parse(sourceJson.toString('utf8', 0, jsonEnd));
    if (!object(parsed)) throw new Error('人物 GLB JSON 根节点无效。');
    const metadata = prepareAdaptation(parsed);
    const targetJson = metadata ? encodeJsonChunk(parsed) : sourceJson;
    const targetSize = stat.size - jsonLength + targetJson.length;
    if (targetSize > MAX_GLB_FILE_BYTES) throw new Error('人物适配后的 GLB 超过约 4 GiB 容器上限。');
    const targetHeader = Buffer.from(sourceHeader);
    targetHeader.writeUInt32LE(targetSize, 8);
    targetHeader.writeUInt32LE(targetJson.length, 12);
    target = await fs.open(targetPath, 'wx');
    created = true;
    await writeExactly(target, targetHeader, 0);
    await writeExactly(target, targetJson, 20);
    const hash = metadata ? createHash('sha256').update(sourceHeader).update(sourceJson) : null;
    const copyBuffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let readPosition = 20 + jsonLength;
    let writePosition = 20 + targetJson.length;
    while (readPosition < stat.size) {
      const { bytesRead } = await source.read(copyBuffer, 0, Math.min(copyBuffer.length, stat.size - readPosition), readPosition);
      if (!bytesRead) throw new Error('人物 GLB 复制时文件提前结束。');
      const bytes = copyBuffer.subarray(0, bytesRead);
      hash?.update(bytes);
      await writeExactly(target, bytes, writePosition);
      readPosition += bytesRead;
      writePosition += bytesRead;
    }
    const copiedStat = await source.stat();
    if (copiedStat.size !== openedStat.size || copiedStat.mtimeMs !== openedStat.mtimeMs || copiedStat.ctimeMs !== openedStat.ctimeMs) {
      throw new Error('人物 GLB 在复制期间已发生变化，请重新上传。');
    }
    if (metadata && hash) {
      metadata.sourceHash = hash.digest('hex');
      const finalJson = encodeJsonChunk(parsed);
      if (finalJson.length !== targetJson.length) throw new Error('人物适配指纹回填长度不一致。');
      await writeExactly(target, finalJson, 20);
    }
  } catch (error) {
    if (target) { await target.close(); target = undefined; }
    if (created) {
      try { await fs.unlink(targetPath); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], '人物适配失败，未完成文件清理失败。', { cause: cleanupError }); }
    }
    throw error;
  } finally {
    try { await target?.close(); } finally { await source.close(); }
  }
}
