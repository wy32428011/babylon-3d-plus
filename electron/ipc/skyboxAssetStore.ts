import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ProjectSkyboxAssetEntry, SkyboxAssetFormat } from '../types.js';

const require = createRequire(import.meta.url);
type AssetRegistryModule = typeof import('./assetRegistry.js');
const runtimeExtension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const { encodeAssetUrl } = require(`./assetRegistry${runtimeExtension}`) as AssetRegistryModule;

export const MAX_SKYBOX_FILE_BYTES = 512 * 1024 * 1024;
const HDR_HEADER_MAX_BYTES = 4096;
const EXR_HEADER_MAX_BYTES = 1024 * 1024;
const EXR_MAGIC = Buffer.from([0x76, 0x2f, 0x31, 0x01]);
const WINDOWS_RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function getSkyboxFormat(filePath: string): SkyboxAssetFormat | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.hdr') return 'hdr';
  if (extension === '.exr') return 'exr';
  return null;
}

function assertPathInside(rootPath: string, targetPath: string, label: string): void {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label}不在天空盒资源根目录内。`);
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function toSafeSkyboxFileName(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const rawStem = path.basename(filePath, path.extname(filePath));
  let stem = rawStem
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .replace(/^[.]+/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
  if (!stem) stem = 'skybox';
  if (WINDOWS_RESERVED_NAMES.test(stem)) stem = `_${stem}`;
  return `${stem}${extension}`;
}

type RadianceHdrInfo = {
  width: number;
  height: number;
  dataPosition: number;
};

export type SkyboxAssetFileInspection = {
  format: SkyboxAssetFormat;
  fileSizeBytes: number;
};

type InternalSkyboxAssetFileInspection = SkyboxAssetFileInspection & {
  hdrInfo?: RadianceHdrInfo;
};

const MAX_SKYBOX_PANORAMA_PIXELS = 32 * 1024 * 1024;
const HDR_STREAM_BUFFER_BYTES = 64 * 1024;

async function readHeader(filePath: string, length: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function parseRadianceHdrHeader(header: Buffer): RadianceHdrInfo {
  let position = 0;
  const readLine = (): string => {
    const lineEnd = header.indexOf(0x0a, position);
    if (lineEnd < 0) throw new Error('HDR 文件头不完整。');
    const line = header.subarray(position, lineEnd).toString('ascii');
    position = lineEnd + 1;
    return line;
  };

  const signature = readLine();
  if (signature !== '#?RADIANCE' && signature !== '#?RGBE') {
    throw new Error('HDR 文件头无效。');
  }

  let hasSupportedFormat = false;
  for (;;) {
    const line = readLine();
    if (!line) break;
    if (line === 'FORMAT=32-bit_rle_rgbe') hasSupportedFormat = true;
  }
  if (!hasSupportedFormat) {
    throw new Error('HDR 不是 Babylon 支持的 RGBE 全景格式。');
  }

  const sizeLine = readLine();
  const sizeMatch = /^-Y ([1-9]\d*) \+X ([1-9]\d*)$/.exec(sizeLine);
  if (!sizeMatch) throw new Error('HDR 尺寸或朝向不受支持，仅支持 -Y height +X width。');

  const height = Number(sizeMatch[1]);
  const width = Number(sizeMatch[2]);
  if (width < 8 || width > 0x7fff) {
    throw new Error('HDR 宽度超出 Babylon 支持范围（8-32767）。');
  }
  if (!Number.isSafeInteger(height) || width * height > MAX_SKYBOX_PANORAMA_PIXELS) {
    throw new Error('HDR 全景分辨率超过安全解码上限。');
  }

  return { width, height, dataPosition: position };
}

function readExrHeaderString(header: Buffer, startPosition: number, label: string): { value: string; nextPosition: number } {
  const endPosition = header.indexOf(0x00, startPosition);
  if (endPosition < 0) throw new Error(`EXR ${label}不完整或头部超过安全上限。`);
  if (endPosition - startPosition > 255) throw new Error(`EXR ${label}过长。`);
  return {
    value: header.subarray(startPosition, endPosition).toString('ascii'),
    nextPosition: endPosition + 1,
  };
}

/** 读取 EXR dataWindow 并限制解码像素数，避免小文件声明超大图像导致内存耗尽。 */
function validateExrHeader(header: Buffer): void {
  if (header.length < 8 || !header.subarray(0, EXR_MAGIC.length).equals(EXR_MAGIC)) {
    throw new Error('EXR 文件头无效。');
  }

  let position = 8;
  let dataWindow: { xMin: number; yMin: number; xMax: number; yMax: number } | null = null;
  let terminated = false;

  for (let attributeIndex = 0; attributeIndex < 4096 && position < header.length; attributeIndex += 1) {
    const nameResult = readExrHeaderString(header, position, '属性名');
    position = nameResult.nextPosition;
    if (!nameResult.value) {
      terminated = true;
      break;
    }

    const typeResult = readExrHeaderString(header, position, '属性类型');
    position = typeResult.nextPosition;
    if (position + 4 > header.length) throw new Error('EXR 属性长度不完整。');
    const valueLength = header.readUInt32LE(position);
    position += 4;
    if (valueLength > header.length - position) {
      throw new Error('EXR 属性数据不完整或头部超过安全上限。');
    }

    if (nameResult.value === 'dataWindow') {
      if (typeResult.value !== 'box2i' || valueLength !== 16) throw new Error('EXR dataWindow 格式无效。');
      dataWindow = {
        xMin: header.readInt32LE(position),
        yMin: header.readInt32LE(position + 4),
        xMax: header.readInt32LE(position + 8),
        yMax: header.readInt32LE(position + 12),
      };
    }
    position += valueLength;
  }

  if (!terminated) throw new Error('EXR 文件头不完整或属性数量超过安全上限。');
  if (!dataWindow) throw new Error('EXR 文件头缺少 dataWindow。');
  const width = dataWindow.xMax - dataWindow.xMin + 1;
  const height = dataWindow.yMax - dataWindow.yMin + 1;
  if (width <= 0 || height <= 0 || width * height > MAX_SKYBOX_PANORAMA_PIXELS) {
    throw new Error('EXR 全景分辨率无效或超过安全解码上限。');
  }
}

async function inspectSkyboxAssetFileInternal(filePath: string): Promise<InternalSkyboxAssetFileInspection> {
  const normalizedPath = path.resolve(filePath);
  const format = getSkyboxFormat(normalizedPath);
  if (!format) throw new Error('天空盒仅支持 .hdr 或 .exr 文件。');

  const stat = await fs.lstat(normalizedPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('请选择安全的普通天空盒文件。');
  if (stat.size <= 0) throw new Error('天空盒文件不能为空。');
  if (stat.size > MAX_SKYBOX_FILE_BYTES) {
    throw new Error(`天空盒文件超过 ${MAX_SKYBOX_FILE_BYTES / 1024 / 1024} MiB 安全上限。`);
  }

  const headerLimit = format === 'hdr' ? HDR_HEADER_MAX_BYTES : EXR_HEADER_MAX_BYTES;
  const header = await readHeader(normalizedPath, Math.min(headerLimit, stat.size));
  if (format === 'hdr') {
    return { format, fileSizeBytes: stat.size, hdrInfo: parseRadianceHdrHeader(header) };
  }
  validateExrHeader(header);
  return { format, fileSizeBytes: stat.size };
}

export async function inspectSkyboxAssetFile(filePath: string): Promise<SkyboxAssetFileInspection> {
  const inspection = await inspectSkyboxAssetFileInternal(filePath);
  return { format: inspection.format, fileSizeBytes: inspection.fileSizeBytes };
}

/** 流式校验 RGBE 扫描线，避免损坏文件进入资源库后才在 Babylon 运行时失败。 */
async function validateRadianceHdrPayload(
  filePath: string,
  fileSizeBytes: number,
  hdrInfo: RadianceHdrInfo,
): Promise<void> {
  const pixelCount = hdrInfo.width * hdrInfo.height;
  const handle = await fs.open(filePath, 'r');
  const buffer = Buffer.allocUnsafe(HDR_STREAM_BUFFER_BYTES);
  let bufferOffset = 0;
  let bufferLength = 0;
  let position = hdrInfo.dataPosition;

  const readByte = async (): Promise<number> => {
    if (bufferOffset >= bufferLength) {
      const result = await handle.read(buffer, 0, buffer.length, position);
      bufferOffset = 0;
      bufferLength = result.bytesRead;
      if (bufferLength === 0) throw new Error('HDR 像素数据提前结束。');
    }
    const value = buffer[bufferOffset];
    bufferOffset += 1;
    position += 1;
    return value;
  };

  const skipBytes = async (count: number): Promise<void> => {
    for (let remaining = count; remaining > 0;) {
      if (bufferOffset >= bufferLength) {
        const result = await handle.read(buffer, 0, buffer.length, position);
        bufferOffset = 0;
        bufferLength = result.bytesRead;
        if (bufferLength === 0) throw new Error('HDR 像素数据提前结束。');
      }
      const skipped = Math.min(remaining, bufferLength - bufferOffset);
      bufferOffset += skipped;
      position += skipped;
      remaining -= skipped;
    }
  };

  try {
    const firstScanlineHeader = [await readByte(), await readByte(), await readByte(), await readByte()];
    const isRle = firstScanlineHeader[0] === 2
      && firstScanlineHeader[1] === 2
      && (firstScanlineHeader[2] & 0x80) === 0
      && ((firstScanlineHeader[2] << 8) | firstScanlineHeader[3]) === hdrInfo.width;
    if (!isRle) {
      if (hdrInfo.dataPosition + pixelCount * 4 > fileSizeBytes) {
        throw new Error('HDR 像素数据不完整。');
      }
      return;
    }

    for (let scanlineIndex = 0; scanlineIndex < hdrInfo.height; scanlineIndex += 1) {
      if (scanlineIndex > 0) {
        const scanlineHeader = [await readByte(), await readByte(), await readByte(), await readByte()];
        const scanlineWidth = (scanlineHeader[2] << 8) | scanlineHeader[3];
        if (scanlineHeader[0] !== 2 || scanlineHeader[1] !== 2 || (scanlineHeader[2] & 0x80) !== 0 || scanlineWidth !== hdrInfo.width) {
          throw new Error(`HDR 第 ${scanlineIndex + 1} 行扫描线头无效。`);
        }
      }

      for (let channelIndex = 0; channelIndex < 4; channelIndex += 1) {
        let decoded = 0;
        while (decoded < hdrInfo.width) {
          const code = await readByte();
          if (code === 0) {
            throw new Error(`HDR 第 ${scanlineIndex + 1} 行通道 ${channelIndex + 1} 包含零长度数据段。`);
          }
          const count = code > 128 ? code - 128 : code;
          if (count > hdrInfo.width - decoded) {
            throw new Error(`HDR 第 ${scanlineIndex + 1} 行通道 ${channelIndex + 1} 的 RLE 数据越界。`);
          }
          if (code > 128) await readByte();
          else await skipBytes(count);
          decoded += count;
        }
      }
    }
  } finally {
    await handle.close();
  }
}

/** 校验扩展名、普通文件属性、体积，以及 Babylon 可解码的 HDR/EXR 基础格式。 */
export async function validateSkyboxSourceFile(
  filePath: string,
): Promise<{ format: SkyboxAssetFormat; fileSizeBytes: number }> {
  const metadata = await inspectSkyboxAssetFileInternal(filePath);
  if (metadata.format === 'hdr' && metadata.hdrInfo) {
    await validateRadianceHdrPayload(path.resolve(filePath), metadata.fileSizeBytes, metadata.hdrInfo);
  }
  return { format: metadata.format, fileSizeBytes: metadata.fileSizeBytes };
}

function createAssetRevision(stat: { mtimeMs: number; size: number }): string {
  return `${Math.trunc(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}`;
}

async function createSkyboxAsset(packagePath: string, filePath: string): Promise<ProjectSkyboxAssetEntry> {
  const validation = await inspectSkyboxAssetFile(filePath);
  const stat = await fs.stat(filePath);
  const name = path.basename(filePath);
  return {
    id: path.resolve(filePath),
    name,
    displayName: path.basename(name, path.extname(name)),
    path: path.resolve(filePath),
    sourceUrl: encodeAssetUrl(filePath),
    assetRevision: createAssetRevision(stat),
    packagePath: path.resolve(packagePath),
    kind: 'skybox',
    libraryKind: 'skybox',
    format: validation.format,
    fileSizeBytes: validation.fileSizeBytes,
    source: 'project',
    availability: 'active',
  };
}

/** 扫描项目 Assets/Skyboxes 下由编辑器创建的单文件资源包。 */
export async function listSkyboxAssetsInRoot(skyboxRoot: string): Promise<ProjectSkyboxAssetEntry[]> {
  const normalizedRoot = path.resolve(skyboxRoot);
  await fs.mkdir(normalizedRoot, { recursive: true });
  const entries = await fs.readdir(normalizedRoot, { withFileTypes: true });
  const assets: ProjectSkyboxAssetEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const packagePath = path.join(normalizedRoot, entry.name);
    assertPathInside(normalizedRoot, packagePath, '天空盒资源包');
    const packageEntries = await fs.readdir(packagePath, { withFileTypes: true });
    const candidateFiles = packageEntries.filter((item) => item.isFile() && getSkyboxFormat(item.name));
    if (candidateFiles.length !== 1) continue;

    const filePath = path.join(packagePath, candidateFiles[0].name);
    try {
      assets.push(await createSkyboxAsset(packagePath, filePath));
    } catch {
      // 单个损坏资源不应阻断整个项目资源库加载；应用时不会暴露该卡片。
    }
  }

  return assets.sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'));
}

async function removeTemporaryDirectory(skyboxRoot: string, targetPath: string): Promise<void> {
  assertPathInside(skyboxRoot, targetPath, '天空盒临时目录');
  await fs.rm(targetPath, { recursive: true, force: true });
}

/** 把单个 HDR/EXR 原子导入项目天空盒目录，同名资源失败时恢复旧包。 */
export async function importSkyboxFileIntoRoot(
  sourceFilePath: string,
  skyboxRoot: string,
): Promise<ProjectSkyboxAssetEntry> {
  const normalizedSourcePath = path.resolve(sourceFilePath);
  await validateSkyboxSourceFile(normalizedSourcePath);

  const normalizedRoot = path.resolve(skyboxRoot);
  await fs.mkdir(normalizedRoot, { recursive: true });
  const safeFileName = toSafeSkyboxFileName(normalizedSourcePath);
  const targetPackagePath = path.join(normalizedRoot, safeFileName);
  const stagingPackagePath = path.join(normalizedRoot, `.${safeFileName}.import-${randomUUID()}`);
  const backupPackagePath = path.join(normalizedRoot, `.${safeFileName}.backup-${randomUUID()}`);
  const stagedFilePath = path.join(stagingPackagePath, safeFileName);
  const targetFilePath = path.join(targetPackagePath, safeFileName);
  for (const candidate of [targetPackagePath, stagingPackagePath, backupPackagePath, stagedFilePath, targetFilePath]) {
    assertPathInside(normalizedRoot, candidate, '天空盒导入路径');
  }

  let previousPackageMoved = false;
  let stagedPackagePromoted = false;
  let importCommitted = false;
  try {
    await fs.mkdir(stagingPackagePath, { recursive: false });
    await fs.copyFile(normalizedSourcePath, stagedFilePath);
    await validateSkyboxSourceFile(stagedFilePath);

    if (await pathExists(targetPackagePath)) {
      const targetStat = await fs.lstat(targetPackagePath);
      if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        throw new Error('同名天空盒目标不是安全目录，拒绝覆盖。');
      }
      await fs.rename(targetPackagePath, backupPackagePath);
      previousPackageMoved = true;
    }

    await fs.rename(stagingPackagePath, targetPackagePath);
    stagedPackagePromoted = true;
    const importedAsset = await createSkyboxAsset(targetPackagePath, targetFilePath);
    importCommitted = true;
    return importedAsset;
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (stagedPackagePromoted && await pathExists(targetPackagePath)) {
      try {
        await removeTemporaryDirectory(normalizedRoot, targetPackagePath);
      } catch (rollbackError) {
        rollbackErrors.push(`移除失败的新天空盒：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (previousPackageMoved && await pathExists(backupPackagePath)) {
      try {
        await fs.rename(backupPackagePath, targetPackagePath);
      } catch (rollbackError) {
        rollbackErrors.push(`恢复旧天空盒：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}；天空盒导入回滚不完整：${rollbackErrors.join('；')}`);
    }
    throw error;
  } finally {
    if (await pathExists(stagingPackagePath)) {
      await removeTemporaryDirectory(normalizedRoot, stagingPackagePath);
    }
    if (importCommitted && await pathExists(backupPackagePath)) {
      try {
        await removeTemporaryDirectory(normalizedRoot, backupPackagePath);
      } catch {
        // 新资源已提交，孤立备份清理失败不应把成功导入误报为失败。
      }
    }
  }
}
