import { ZipArchive } from 'archiver';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createOpeningPackageBinding, validateOpeningPackageDefinition, type OpeningPackageBinding } from '../shared/openingPackage.js';
import { authorizeAssetRoot, encodeAssetUrl } from './assetRegistry.js';
import { assertTrustedPathWithinRoot } from './digitalTwinSourceEnvironmentRelink.js';
import { assertOpeningPackageRelativePath, extractOpeningPackageArchive, inspectOpeningPackageFiles, type OpeningPackageFile } from './openingPackageFiles.js';
import { ensureOpeningDirectory } from './openingPackageDirectory.js';

export type OpeningPackageIdentity = Pick<OpeningPackageBinding, 'id' | 'version' | 'contentHash'>;
const DOCUMENTS = ['manifest.json', 'config.schema.json', 'ui.schema.json', 'defaults.json', 'timeline.json'] as const;
const importing = new Map<string, Promise<unknown>>();
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function openingPackagesRoot(projectRoot: string): string { return path.join(projectRoot, 'Assets', 'OpeningPackages'); }

export function resolveOpeningPackageDirectory(projectRoot: string, identity: OpeningPackageIdentity): string {
  if (!identity || typeof identity.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(identity.id)
    || typeof identity.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(identity.version)
    || typeof identity.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(identity.contentHash)) throw new Error('开场包身份无效。');
  assertOpeningPackageRelativePath(`assets/${identity.id}/${identity.version}-${identity.contentHash}`, true);
  return path.join(openingPackagesRoot(projectRoot), identity.id, `${identity.version}-${identity.contentHash}`);
}

/** 校验完整目录、素材声明与 JSON；内容身份绑定文件路径、大小和摘要。 */
export async function readOpeningPackageDirectory(directory: string, signal = new AbortController().signal) {
  const files = await inspectOpeningPackageFiles(directory, signal), byName = new Map(files.map(file => [file.relativePath, file]));
  const read = async (name: string) => {
    const file = byName.get(name); if (!file) throw new Error(`开场包缺少 ${name}。`);
    const bytes = await fs.readFile(file.sourcePath);
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`开场包读取期间发生变化：${name}`);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error(`开场包 ${name} 不是有效 UTF-8 JSON。`); }
  };
  const [manifest, schema, uiSchema, defaults, timeline] = await Promise.all(DOCUMENTS.map(read));
  const definition = validateOpeningPackageDefinition({ manifest, schema, uiSchema, defaults, timeline });
  const declared = new Set<string>();
  for (const asset of definition.manifest.assets) {
    const file = byName.get(asset.path);
    if (!file || file.size !== asset.size || file.sha256 !== asset.sha256.toLowerCase()) throw new Error(`开场包素材校验失败：${asset.id} (${asset.path})`);
    declared.add(asset.path);
  }
  for (const file of files) if (file.relativePath.startsWith('assets/') && !declared.has(file.relativePath)) throw new Error(`开场包含未声明素材：${file.relativePath}`);
  const contentHash = createHash('sha256').update(JSON.stringify(files.map(file => [file.relativePath, file.size, file.sha256]))).digest('hex');
  return { definition, contentHash, files };
}

/** 项目内固定版本永不覆盖；导入失败或同版冲突仅删除本次暂存。 */
export function importOpeningPackageArchive(projectRoot: string, archivePath: string, signal = new AbortController().signal): Promise<OpeningPackageBinding> {
  const key = path.resolve(projectRoot).toLowerCase(), previous = importing.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(() => importIntoProject(projectRoot, archivePath, signal));
  importing.set(key, task);
  void task.finally(() => { if (importing.get(key) === task) importing.delete(key); }).catch(() => undefined);
  return task;
}

async function importIntoProject(projectRoot: string, archivePath: string, signal: AbortSignal): Promise<OpeningPackageBinding> {
  signal.throwIfAborted();
  const library = openingPackagesRoot(projectRoot);
  await ensureOpeningDirectory(projectRoot, library);
  const staging = path.join(library, `.import-${randomUUID()}`);
  try {
    await extractOpeningPackageArchive(archivePath, staging, signal);
    const validated = await readOpeningPackageDirectory(staging, signal);
    const identity = { id: validated.definition.manifest.id, version: validated.definition.manifest.version, contentHash: validated.contentHash };
    const target = resolveOpeningPackageDirectory(projectRoot, identity), parent = path.dirname(target);
    await ensureOpeningDirectory(projectRoot, parent);
    for (const item of await fs.readdir(parent)) {
      if (!item.startsWith(`${identity.version}-`)) continue;
      const candidate = path.join(parent, item);
      await assertTrustedPathWithinRoot(projectRoot, candidate, '已有开场包');
      const existing = await readOpeningPackageDirectory(candidate, signal);
      if (existing.definition.manifest.version !== identity.version) continue;
      if (existing.contentHash !== identity.contentHash) throw new Error(`开场包 ${identity.id} 的同一版本 ${identity.version} 内容冲突，请升级包版本后导入。`);
      if (candidate !== target) throw new Error('已有开场包目录与内容指纹不一致。');
      authorizeAssetRoot(target);
      return createOpeningPackageBinding(existing.definition, encodeAssetUrl(path.join(target, 'manifest.json')), existing.contentHash);
    }
    signal.throwIfAborted();
    await fs.rename(staging, target);
    authorizeAssetRoot(target);
    return createOpeningPackageBinding(validated.definition, encodeAssetUrl(path.join(target, 'manifest.json')), validated.contentHash);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

/** 不把损坏条目当作可用模板；其它版本仍可独立使用。 */
export async function listOpeningPackagesInProject(projectRoot: string): Promise<{ packages: OpeningPackageBinding[]; warnings: string[] }> {
  const library = openingPackagesRoot(projectRoot), packages: OpeningPackageBinding[] = [], warnings: string[] = [];
  let ids: string[];
  try { await assertTrustedPathWithinRoot(projectRoot, library, '开场包目录'); ids = await fs.readdir(library); }
  catch (error) { if (isMissing(error)) return { packages, warnings }; throw error; }
  for (const id of ids) {
    if (id.startsWith('.')) continue;
    try {
      const parent = path.join(library, id); await assertTrustedPathWithinRoot(projectRoot, parent, '开场包目录');
      for (const version of await fs.readdir(parent)) {
        try {
          const directory = path.join(parent, version); await assertTrustedPathWithinRoot(projectRoot, directory, '开场包版本');
          const result = await readOpeningPackageDirectory(directory);
          const identity = { id: result.definition.manifest.id, version: result.definition.manifest.version, contentHash: result.contentHash };
          if (path.resolve(directory) !== resolveOpeningPackageDirectory(projectRoot, identity)) throw new Error('开场包目录与声明身份不一致。');
          authorizeAssetRoot(directory);
          packages.push(createOpeningPackageBinding(result.definition, encodeAssetUrl(path.join(directory, 'manifest.json')), result.contentHash));
        } catch (error) { warnings.push(`${id}/${version}：${error instanceof Error ? error.message : String(error)}`); }
      }
    } catch (error) { warnings.push(`${id}：${error instanceof Error ? error.message : String(error)}`); }
  }
  packages.sort((a, b) => a.definition.manifest.name.localeCompare(b.definition.manifest.name, 'zh-CN') || a.version.localeCompare(b.version));
  return { packages, warnings };
}

/** 只导出原始模板；场景参数继续保存在场景中，不改写固定版本。 */
export async function exportOpeningPackageArchive(projectRoot: string, identity: OpeningPackageIdentity, destination: string): Promise<void> {
  const directory = resolveOpeningPackageDirectory(projectRoot, identity);
  await assertTrustedPathWithinRoot(projectRoot, directory, '导出的开场包');
  const result = await readOpeningPackageDirectory(directory);
  if (result.contentHash !== identity.contentHash) throw new Error('开场包内容指纹与导出选择不一致。');
  const relative = path.relative(openingPackagesRoot(projectRoot), path.resolve(destination));
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('不能将开场导出 ZIP 写入开场包资源库。');
  const temporary = `${destination}.writing-${randomUUID()}`;
  const archive = new ZipArchive({ zlib: { level: 6 } }), output = createWriteStream(temporary, { flags: 'wx' });
  const completed = pipeline(archive, output);
  try {
    for (const file of result.files) archive.append(verifiedStream(file), { name: file.relativePath });
    await Promise.all([archive.finalize(), completed]);
    await fs.rename(temporary, destination);
  } catch (error) { void archive.abort(); output.destroy(); await completed.catch(() => undefined); throw error; }
  finally { await fs.rm(temporary, { force: true }); }
}

function verifiedStream(file: OpeningPackageFile) {
  const hash = createHash('sha256'); let bytes = 0;
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(bytes > file.size ? new Error('开场包导出期间发生变化。') : null, chunk); },
    flush(callback) { callback(bytes !== file.size || hash.digest('hex') !== file.sha256 ? new Error('开场包导出期间内容校验失败。') : null); },
  });
  const input = createReadStream(file.sourcePath);
  input.on('error', error => verify.destroy(error)); verify.on('close', () => input.destroy());
  return input.pipe(verify);
}
