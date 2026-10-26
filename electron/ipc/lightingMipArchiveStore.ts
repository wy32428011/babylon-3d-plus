import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isLightingLightmapMipEncoding, validateLightingLightmapMipAsset } from '../shared/sceneLightingLightmapMips.ts';

type MipAsset = Parameters<typeof validateLightingLightmapMipAsset>[0] & { sha256?: unknown };
type SceneEntry = { relativePath: string; content: string };

/** directory回调只改变已验证的精确条目；其它bin/PNG/旧文件仍沿原压缩策略。 */
export function applyLightingMipArchiveStore<T extends { name: string; type?: string; store?: boolean }>(entry: T,
  stored: ReadonlySet<string>): T {
  return entry.type !== 'directory' && stored.has(entry.name) ? { ...entry, store: true } : entry;
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** 只将清单引用、SHA与容器全验证通过的新mip资产设为STORE，保留ZIP压缩比保护。 */
export async function collectLightingMipArchiveStorePaths(root: string, scenes: readonly SceneEntry[], signal: AbortSignal): Promise<ReadonlySet<string>> {
  const realRoot = await fs.realpath(root), stored = new Set<string>();
  for (const entry of scenes) {
    signal.throwIfAborted();
    const file = object(JSON.parse(entry.content)), scene = object(file?.scene), settings = object(scene?.sceneSettings);
    const lighting = object(settings?.lighting), result = object(lighting?.result), rawAssets = result?.assets;
    if (!Array.isArray(rawAssets)) continue;
    const mips = rawAssets.map(object).filter((asset): asset is Record<string, unknown> => Boolean(asset && isLightingLightmapMipEncoding(asset.encoding)));
    if (!mips.length) continue;
    // 仅新mip分支使用新增路径门；旧场景有效的#等文件名不因此改变打包行为。
    if (!entry.relativePath || /[\\:?#\0]/.test(entry.relativePath)
      || entry.relativePath.split('/').some(part => !part || part === '.' || part === '..')
      || !inside(realRoot, path.resolve(realRoot, entry.relativePath))) throw new Error('mip归档场景路径无效。');
    if (lighting?.version !== 3) throw new Error('新mip资产归档需要光照配置v3。');
    const maximumMiB = object(lighting.bake)?.maxTextureMiB;
    if (typeof maximumMiB !== 'number' || !Number.isFinite(maximumMiB) || maximumMiB < 16 || maximumMiB > 4096) throw new Error('mip归档纹理预算无效。');
    const maximumBytes = Math.min(Math.floor(maximumMiB * 1024 * 1024), 0xffffffff);
    let textureBytes = 0;
    for (const raw of mips) {
      signal.throwIfAborted();
      const asset = raw as unknown as MipAsset;
      const virtual = typeof asset.url === 'string' && asset.url.startsWith('editor-asset://local/');
      if (typeof asset.url !== 'string' || asset.url.includes('\\') || asset.url.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(asset.url)
        && !virtual || /[?#\0]/.test(asset.url) || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('mip归档资产路径或SHA无效。');
      // 在URL根路径归一化前检查真实相对路径，不能让../../被URL钳到根目录后逃过边界。
      const reference = decodeURIComponent(virtual ? asset.url.slice('editor-asset://local/'.length) : asset.url);
      if (!reference || /[\\:\0]/.test(reference)) throw new Error('mip归档资产路径无效。');
      const destination = path.resolve(realRoot, virtual ? '' : path.dirname(entry.relativePath), reference);
      if (!inside(realRoot, destination)) throw new Error('mip归档资产越过暂存区。');
      // ZIP目录枚举不跟随链接；即使中间junction仍指向根内也不能让场景引用别名资产。
      let directory = realRoot;
      for (const part of path.relative(realRoot, destination).split(path.sep).slice(0, -1)) {
        signal.throwIfAborted(); directory = path.join(directory, part);
        const directoryStat = await fs.lstat(directory);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('mip归档资产包含链接或无效目录。');
      }
      const stat = await fs.lstat(destination);
      const realDestination = await fs.realpath(destination);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.byteLength || !inside(realRoot, realDestination)) throw new Error('mip归档资产缺失、链接或大小不符。');
      // 先限制实读分配，再由共享parser校验精确头长；512MiB不扩大现有接收端单项上限。
      if (stat.size > Math.min(maximumBytes + 1024, 512 * 1024 * 1024)) throw new Error('mip归档文件超过有界读取预算。');
      const bytes = await fs.readFile(destination, { signal });
      if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('mip归档资产SHA不符。');
      const decoded = validateLightingLightmapMipAsset(asset, bytes, maximumBytes);
      textureBytes += decoded.totalTextureBytes;
      if (textureBytes > maximumBytes) throw new Error('mip归档纹理总量超过场景预算。');
      // Windows引用大小写可能与实际条目不同；用真实路径生成与目录枚举一致的精确STORE键。
      stored.add(path.relative(realRoot, realDestination).replaceAll('\\', '/'));
    }
  }
  return stored;
}
