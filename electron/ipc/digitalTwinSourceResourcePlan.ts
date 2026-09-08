import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { DeploymentCopyFile } from './deploymentExportFileSystem.js';

export type SourceResourceIntegrity = {
  relativePath: string;
  expectedSize: number;
  expectedSha256: string;
  label: string;
};
export type SourceResourceBundle = {
  sourcePath: string;
  destinationRelativePath: string;
  copyFile?: DeploymentCopyFile;
  integrityFiles?: readonly SourceResourceIntegrity[];
};
export type SourceResourceFile = {
  sourcePath: string;
  expectedSize: number;
  expectedSha256: string;
};
type SnapshotBundle = SourceResourceBundle & {
  originalDestination: string;
  contentSha256: string;
  isDirectory: boolean;
  members: Map<string, { relative: string; kind: string }>;
};
const LOCAL_URL = 'editor-asset://local/';
const PATH_FIELDS = new Set(['sourcePath', 'packagePath', 'metadataPath', 'thumbnailPath', 'path', 'scriptPaths']);
const URL_FIELDS = new Set(['sourceUrl', 'thumbnailUrl', 'activeVariantUrl']);
const key = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const targetKey = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
const abort = (signal: AbortSignal): void => { signal.throwIfAborted(); };

/** 每次发布独立形成清单；内容指纹覆盖完整包，而不是仅模型主文件或 mtime。 */
export async function createSourceResourcePlan(bundles: readonly SourceResourceBundle[], projectRoot: string, signal: AbortSignal) {
  const snapshots: SnapshotBundle[] = [];
  const files: SourceResourceFile[] = [];
  let totalBytes = 0;
  let totalFiles = 0;
  for (const bundle of bundles) {
    abort(signal);
    const rootStat = await fs.lstat(bundle.sourcePath);
    if (rootStat.isSymbolicLink()) throw new Error(`资源路径不能是符号链接或 Junction：${bundle.sourcePath}`);
    const integrity: SourceResourceIntegrity[] = [];
    const inventory: Array<[string, string, number?, string?]> = [];
    const pending = [{ absolute: bundle.sourcePath, relative: '' }];
    while (pending.length) {
      abort(signal);
      const item = pending.pop()!;
      const stat = await fs.lstat(item.absolute);
      if (stat.isSymbolicLink()) throw new Error(`资源包包含符号链接或 Junction：${item.absolute}`);
      if (stat.isDirectory()) {
        if (item.relative) inventory.push([item.relative, 'directory']);
        const children = await fs.readdir(item.absolute);
        if (pending.length + children.length + inventory.length > 200_000) throw new Error('源工程资源文件数量超过 200000 项限制。');
        for (const child of children.sort()) pending.push({ absolute: path.join(item.absolute, child), relative: item.relative ? `${item.relative}/${child}` : child });
      } else if (stat.isFile()) {
        if (++totalFiles > 200_000 || (totalBytes += stat.size) > 8 * 1024 ** 3) throw new Error('源工程资源快照超过文件数量或 8 GB 安全上限。');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(item.absolute, { signal })) hash.update(chunk);
        const after = await fs.lstat(item.absolute);
        if (!after.isFile() || after.isSymbolicLink() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) {
          throw new Error(`源工程资源在生成清单时发生变化：${bundle.destinationRelativePath}/${item.relative}`);
        }
        const digest = hash.digest('hex');
        const relative = item.relative || path.basename(item.absolute);
        const required = bundle.integrityFiles?.find(f => targetKey(f.relativePath) === targetKey(relative));
        const expectedSize = required?.expectedSize ?? bundle.copyFile?.expectedSize;
        const expectedSha256 = required?.expectedSha256 ?? bundle.copyFile?.expectedSha256;
        if ((expectedSize !== undefined && expectedSize !== stat.size) || (expectedSha256 !== undefined && expectedSha256 !== digest)) {
          throw new Error(`${required?.label ?? bundle.copyFile?.integrityLabel ?? bundle.destinationRelativePath} SHA-256 或大小与完整性索引不一致。`);
        }
        integrity.push({ relativePath: relative, expectedSize: stat.size, expectedSha256: digest, label: `源工程资源快照 ${bundle.destinationRelativePath}/${relative}` });
        inventory.push([relative, 'file', stat.size, digest]);
        // DIST 使用 realpath 扫描；保留两种键，让相同快照校验覆盖原始引用和扫描结果。
        files.push({ sourcePath: item.absolute, expectedSize: stat.size, expectedSha256: digest });
        const realPath = await fs.realpath(item.absolute);
        if (key(realPath) !== key(item.absolute)) files.push({ sourcePath: realPath, expectedSize: stat.size, expectedSha256: digest });
      } else throw new Error(`资源包包含不支持的特殊文件：${item.absolute}`);
    }
    for (const required of bundle.integrityFiles ?? []) {
      if (!integrity.some(f => targetKey(f.relativePath) === targetKey(required.relativePath))) throw new Error(`${required.label} 缺少完整性校验文件。`);
    }
    inventory.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const contentSha256 = createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
    snapshots.push({ ...bundle, originalDestination: bundle.destinationRelativePath, contentSha256,
      isDirectory: rootStat.isDirectory(), integrityFiles: integrity,
      members: new Map(inventory.map(([relative, kind]) => [process.platform === 'win32' ? relative.toLowerCase() : relative, { relative, kind }])),
      copyFile: bundle.copyFile ? { ...bundle.copyFile, expectedSize: integrity[0]?.expectedSize, expectedSha256: integrity[0]?.expectedSha256 } : undefined });
  }

  const bySource = new Map(snapshots.map(bundle => [key(bundle.sourcePath), bundle]));
  const groups = new Map<string, SnapshotBundle[]>();
  for (const bundle of snapshots) {
    const group = targetKey(bundle.originalDestination);
    const entries = groups.get(group) ?? [];
    entries.push(bundle);
    groups.set(group, entries);
  }
  const selected: SnapshotBundle[] = [];
  const reserved = new Set(groups.keys());
  for (const entries of groups.values()) {
    entries.sort((a, b) => a.originalDestination.localeCompare(b.originalDestination, 'en') || key(a.sourcePath).localeCompare(key(b.sourcePath), 'en'));
    const versions = new Map<string, SnapshotBundle>();
    for (const entry of entries) if (!versions.has(entry.contentSha256)) versions.set(entry.contentSha256, entry);
    for (const [digest, representative] of versions) {
      let destination = entries[0].originalDestination;
      if (versions.size > 1) {
        const extension = representative.isDirectory ? '' : path.posix.extname(destination);
        const stem = extension ? destination.slice(0, -extension.length) : destination;
        let width = 16;
        do {
          destination = `${stem}__zsrc-${digest.slice(0, width)}${extension}`;
          width += 8;
        } while (reserved.has(targetKey(destination)) && width <= 72);
        if (reserved.has(targetKey(destination))) throw new Error(`资源内容目标无法唯一分配：${representative.originalDestination}`);
      }
      reserved.add(targetKey(destination));
      for (const entry of entries.filter(entry => entry.contentSha256 === digest)) entry.destinationRelativePath = destination;
      representative.copyFile && (representative.copyFile = { ...representative.copyFile, destinationRelativePath: destination });
      selected.push(representative);
    }
  }
  const destinations = selected.map(bundle => targetKey(bundle.destinationRelativePath)).sort();
  const destinationSet = new Set(destinations);
  for (const destination of destinations) {
    let parent = path.posix.dirname(destination);
    while (parent !== '.') {
      if (destinationSet.has(parent)) throw new Error(`源工程资源目标冲突：${parent} 与 ${destination}`);
      parent = path.posix.dirname(parent);
    }
  }

  function reference(value: string) {
    let localPath = value;
    let suffix = '';
    if (value.startsWith(LOCAL_URL)) {
      const parsed = new URL(value);
      localPath = decodeURIComponent(parsed.pathname.slice(1));
      suffix = parsed.search + parsed.hash;
    }
    if (!path.isAbsolute(localPath)) {
      if (!/^Assets\//i.test(localPath.replace(/\\/g, '/'))) return null;
      localPath = path.resolve(projectRoot, localPath);
    }
    let ancestor = path.resolve(localPath);
    while (true) {
      const bundle = bySource.get(key(ancestor));
      if (bundle) {
        const relative = path.relative(bundle.sourcePath, path.resolve(localPath)).replace(/\\/g, '/');
        if (relative && !bundle.isDirectory) return null;
        const member = relative || (bundle.isDirectory ? '' : path.basename(bundle.sourcePath));
        const found = member ? bundle.members.get(process.platform === 'win32' ? member.toLowerCase() : member) : { relative: '', kind: 'directory' };
        // Windows 的大小写别名归到实际文件清单，避免便携包引用拼写与 ZIP 条目不一致。
        const destination = relative ? `${bundle.destinationRelativePath}/${found?.relative ?? relative}` : bundle.destinationRelativePath;
        return { bundle, destination, suffix, kind: found?.kind };
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return null;
      ancestor = parent;
    }
  }

  /** 同一实例若把同名包的两版本拼接在一起，无法确定完整运行语义，必须指出具体字段。 */
  function validateModelReferences(value: unknown, location = 'scene', field = ''): void {
    if (typeof value === 'string' && (value.startsWith(LOCAL_URL) || PATH_FIELDS.has(field) || URL_FIELDS.has(field))) {
      const found = reference(value);
      if (found && (!found.kind || ((URL_FIELDS.has(field) || ['sourcePath', 'scriptPaths', 'metadataPath', 'thumbnailPath'].includes(field)) && found.kind !== 'file'))) {
        throw new Error(`场景资源引用不存在或不是文件：${location}；${value}`);
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    const source = typeof object.sourcePath === 'string' ? reference(object.sourcePath) : null;
    if (source && /\.(glb|gltf)$/i.test(source.destination)) {
      const visit = (child: unknown, field: string, at: string): void => {
        if (typeof child === 'string' && (PATH_FIELDS.has(field) || URL_FIELDS.has(field))) {
          const other = reference(child);
          if (other && targetKey(other.bundle.originalDestination) === targetKey(source.bundle.originalDestination)
            && other.bundle.contentSha256 !== source.bundle.contentSha256) throw new Error(`资源版本混用：${at}；${source.bundle.sourcePath} 与 ${other.bundle.sourcePath}`);
        } else if (child && typeof child === 'object') for (const [k, v] of Object.entries(child)) visit(v, Array.isArray(child) ? field : k, `${at}.${k}`);
      };
      visit(object, '', location);
    }
    for (const [name, child] of Object.entries(object)) validateModelReferences(child, `${location}.${name}`, Array.isArray(value) ? field : name);
  }
  /** 仅逆向映射本清单分配的目录，用于验证改名没有改变烘焙依赖的资源语义。 */
  function originalReference(value: string): string {
    const isUrl = value.startsWith(LOCAL_URL);
    let candidate = value;
    if (isUrl) candidate = decodeURIComponent(new URL(value).pathname.slice(1));
    for (const bundle of selected) {
      if (candidate === bundle.destinationRelativePath || (bundle.isDirectory && candidate.startsWith(`${bundle.destinationRelativePath}/`))) {
        const original = bundle.originalDestination + candidate.slice(bundle.destinationRelativePath.length);
        return isUrl ? `${LOCAL_URL}${encodeURIComponent(original)}` : original;
      }
    }
    return value;
  }
  return { bundles: selected.sort((a, b) => a.destinationRelativePath.localeCompare(b.destinationRelativePath, 'en')),
    files, reference, originalReference, validateModelReferences };
}

export type SourceResourcePlan = Awaited<ReturnType<typeof createSourceResourcePlan>>;

/** DIST 仍使用既有资源解析和授权；最终复制字节必须匹配本次 SOURCE 清单。 */
export function bindSourceResourceIntegrity(assetFiles: readonly DeploymentCopyFile[], sourceFiles: readonly SourceResourceFile[]): DeploymentCopyFile[] {
  const byPath = new Map(sourceFiles.map(file => [key(file.sourcePath), file]));
  return assetFiles.map(file => {
    const source = byPath.get(key(file.sourcePath));
    if (!source) throw new Error(`Viewer 资源未包含在本次源工程快照中：${file.relativePath}`);
    if ((file.expectedSha256 && file.expectedSha256 !== source.expectedSha256)
      || (file.expectedSize !== undefined && file.expectedSize !== source.expectedSize)) {
      throw new Error(`SOURCE 与 Viewer 资源版本不一致：${file.relativePath}`);
    }
    return { ...file, expectedSize: source.expectedSize, expectedSha256: source.expectedSha256,
      integrityLabel: `SOURCE/Viewer 资源快照 ${file.relativePath}` };
  });
}
