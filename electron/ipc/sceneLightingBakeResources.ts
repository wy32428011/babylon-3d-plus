import { CURRENT_SCENE_FILE_VERSION, isSupportedSceneFileVersion } from '../shared/sceneFileVersion.js';
import { createHash } from 'node:crypto';
import { constants, createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { validateSceneLightingBakeSnapshot, type LightingBakeAsset } from '../shared/sceneLightingBakeContract.js';
import { captureSceneLightingBakeRelocation } from '../shared/sceneLightingBakeRelocation.js';
import { migrateSceneLightingDocument } from '../shared/sceneLightingConfig.js';

type JsonObject = Record<string, unknown>;
type ResourceOptions = { projectRoot?: string | null; isAuthorizedFile?: (file: string) => boolean; signal?: AbortSignal };
export type ResolvedLightingBakeAsset = { asset: LightingBakeAsset; sourcePath: string; relativePath: string; sha256: string; byteLength: number };
const object = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const localUrl = (value: string) => 'editor-asset://local/' + encodeURIComponent(value);
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };

function assetReferences(scene: unknown): LightingBakeAsset[] {
  const result = object(object(object(scene)?.sceneSettings)?.lighting)?.result;
  if (result === undefined || result === null) return [];
  if (!validateSceneLightingBakeSnapshot(result)) throw new Error('光照烘焙结果格式无效，不能保存或发布独立资产。');
  return (result as { assets: LightingBakeAsset[] }).assets;
}

/** 三种产物都必须位于专用资产目录，不能把任意 JSON 文件借烘焙引用读取或发布。 */
function decodeLightingReference(asset: LightingBakeAsset, projectRoot?: string | null): { sourcePath: string; relativePath: string; ownerRoot: string } {
  let source = asset.url;
  if (source.startsWith('editor-asset://local/')) {
    const url = new URL(source);
    if (url.username || url.password || url.port || url.search || url.hash) throw new Error('光照烘焙资产 URL 无效。');
    source = decodeURIComponent(url.pathname.slice(1));
  } else if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) throw new Error('光照烘焙产物必须是当前工程内的本地资产。');
  const normalized = source.replace(/\\/g, '/');
  if (source.includes('\0') || normalized.split('/').includes('..')) throw new Error('光照烘焙资产路径包含非法片段。');
  const match = /(?:^|\/)(Assets\/LightingBakes\/[^/]+\/.+)$/i.exec(normalized);
  if (!match) throw new Error('光照烘焙资产必须位于 Assets/LightingBakes/<任务>/ 目录。');
  const extension = path.extname(source).toLowerCase();
  if (asset.encoding !== undefined && (asset.kind !== 'geometry' || asset.encoding !== 'json' && asset.encoding !== 'binary-v1')) throw new Error('光照烘焙资产编码无效。');
  if (extension !== (asset.kind === 'lightmap' ? '.png' : asset.kind === 'geometry' && asset.encoding === 'binary-v1' ? '.bin' : '.json')) throw new Error('光照烘焙资产的类型与扩展名不一致。');
  if (!path.isAbsolute(source) && !projectRoot) throw new Error('便携光照资产缺少工程目录。');
  const sourcePath = path.isAbsolute(source) ? path.resolve(source) : path.resolve(projectRoot!, ...normalized.split('/'));
  const relativePath = match[1];
  const ownerRoot = path.resolve(sourcePath, ...Array(relativePath.split('/').length).fill('..'));
  return { sourcePath, relativePath, ownerRoot };
}

async function assertRegularResource(root: string, file: string): Promise<number> {
  if (!inside(root, file)) throw new Error('光照资产超出允许目录。');
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('光照资产根目录不能是符号链接。');
  let current = root;
  const parts = path.relative(root, file).split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error('光照资产路径包含符号链接或非普通文件。');
  }
  if (!inside(await fs.realpath(root), await fs.realpath(file))) throw new Error('光照资产真实路径超出允许目录。');
  return (await fs.stat(file)).size;
}

/** 协议读取前再次校验专用资产路径，避免授权后被替换为 Junction 或符号链接。 */
export async function assertLightingBakeResourceFile(filePath: string): Promise<void> {
  const reference = decodeLightingReference({
    id: 'protocol-resource', kind: path.extname(filePath).toLowerCase() === '.png' ? 'lightmap' : 'geometry',
    url: filePath, byteLength: 0, ...(path.extname(filePath).toLowerCase() === '.bin' ? { encoding: 'binary-v1' as const } : {}),
  });
  await assertRegularResource(reference.ownerRoot, reference.sourcePath);
}

async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  try { for await (const chunk of stream) { signal?.throwIfAborted(); hash.update(chunk); } }
  finally { stream.destroy(); }
  return hash.digest('hex');
}

/** 显式收集 lightmap PNG、geometry JSON/bin、probes JSON，校验内容后才允许复制。 */
export async function resolveSceneLightingBakeAssets(scene: unknown, options: ResourceOptions = {}): Promise<ResolvedLightingBakeAsset[]> {
  const output: ResolvedLightingBakeAsset[] = [];
  for (const asset of assetReferences(scene)) {
    options.signal?.throwIfAborted();
    const reference = decodeLightingReference(asset, options.projectRoot);
    const project = options.projectRoot ? path.resolve(options.projectRoot) : null;
    const boundary = project && inside(project, reference.sourcePath) ? project
      : options.isAuthorizedFile?.(reference.sourcePath) ? reference.ownerRoot : null;
    if (!boundary) throw new Error('光照烘焙资产未获当前工程授权：' + reference.sourcePath);
    const byteLength = await assertRegularResource(boundary, reference.sourcePath);
    if (byteLength !== asset.byteLength) throw new Error('光照烘焙资产大小与原结果不一致：' + asset.id);
    const sha256 = await hashFile(reference.sourcePath, options.signal);
    if (asset.sha256 && asset.sha256.toLowerCase() !== sha256) throw new Error('光照烘焙资产内容校验失败：' + asset.id);
    output.push({ ...reference, asset, sha256, byteLength });
  }
  return output;
}

function sceneResourceRoot(sceneFilePath: string): string {
  const directory = path.dirname(path.resolve(sceneFilePath));
  for (let ancestor = directory; path.dirname(ancestor) !== ancestor; ancestor = path.dirname(ancestor)) {
    if (path.basename(ancestor).toLowerCase() === 'scenes') return path.dirname(ancestor);
  }
  return directory;
}

async function ensureAssetDirectory(root: string, directory: string): Promise<void> {
  if (!inside(root, directory)) throw new Error('光照资产目标目录越界。');
  await fs.mkdir(root, { recursive: true });
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('光照资产目标根目录不能是符号链接。');
  let current = root;
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('光照资产目标包含符号链接或非目录节点。');
  }
}

/** 另存为保留不可变任务资产；已有文件只有内容完全相同才复用，撤销不会删除资产。 */
export async function prepareLightingSceneSave(content: string, sceneFilePath: string, options: ResourceOptions = {}): Promise<{ content: string; files: string[] }> {
  const envelope = object(JSON.parse(content));
  const rawScene = object(envelope?.scene);
  if (!rawScene || !envelope) return { content, files: [] };
  if (!isSupportedSceneFileVersion(envelope.version)) throw new Error('场景文件版本不受支持。');
  const scene = migrateSceneLightingDocument(rawScene);
  envelope.scene = scene;
  envelope.version = CURRENT_SCENE_FILE_VERSION;
  if (!assetReferences(scene).length) return { content: JSON.stringify(envelope), files: [] };
  const restore = captureSceneLightingBakeRelocation(scene);
  const resources = await resolveSceneLightingBakeAssets(scene, options);
  const targetRoot = sceneResourceRoot(sceneFilePath), created: string[] = [], files: string[] = [];
  try {
    for (const resource of resources) {
      options.signal?.throwIfAborted();
      const destination = path.resolve(targetRoot, ...resource.relativePath.split('/'));
      await ensureAssetDirectory(targetRoot, path.dirname(destination));
      if (path.resolve(resource.sourcePath) !== destination) {
        try {
          await fs.copyFile(resource.sourcePath, destination, constants.COPYFILE_EXCL);
          created.push(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const size = await assertRegularResource(targetRoot, destination);
        if (size !== resource.byteLength || await hashFile(destination, options.signal) !== resource.sha256) throw new Error('目标工程已有不同内容的同名光照资产，未覆盖：' + destination);
      }
      resource.asset.url = localUrl(destination);
      files.push(destination);
    }
    if (restore && !restore(scene)) throw new Error('另存为改变了光照烘焙输入或产物身份，未保存场景。');
    return { content: JSON.stringify(envelope), files };
  } catch (error) {
    // 仅回收本次通过 COPYFILE_EXCL 创建且位于目标目录内的文件。
    const cleanup = await Promise.allSettled(created.filter(file => inside(targetRoot, file)).map(file => fs.unlink(file)));
    const failures = cleanup.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (failures.length) throw new AggregateError([error, ...failures.map(item => item.reason)], '光照资产保存失败，部分本次新建文件未能回收。', { cause: error });
    throw error;
  }
}

/** 打开工程时恢复便携资产 URL，校验成功后由 IPC 按实际文件逐项授权。 */
export async function prepareLightingSceneContent(content: string, sceneFilePath: string, options: ResourceOptions = {}): Promise<{ content: string; files: string[] }> {
  const envelope = object(JSON.parse(content));
  const rawScene = object(envelope?.scene);
  if (!rawScene || !envelope) return { content, files: [] };
  if (!isSupportedSceneFileVersion(envelope.version)) throw new Error('场景文件版本不受支持。');
  const scene = migrateSceneLightingDocument(rawScene);
  envelope.scene = scene;
  envelope.version = CURRENT_SCENE_FILE_VERSION;
  if (!assetReferences(scene).length) return { content: JSON.stringify(envelope), files: [] };
  const restore = captureSceneLightingBakeRelocation(scene);
  const targetRoot = sceneResourceRoot(sceneFilePath);
  for (const asset of assetReferences(scene)) {
    const relativePath = decodeLightingReference(asset, targetRoot).relativePath;
    const relocated = path.resolve(targetRoot, ...relativePath.split('/'));
    try { await fs.lstat(relocated); asset.url = localUrl(relocated); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const resources = await resolveSceneLightingBakeAssets(scene, {
    ...options, projectRoot: targetRoot,
    isAuthorizedFile: file => Boolean(options.isAuthorizedFile?.(file) || options.projectRoot && inside(path.resolve(options.projectRoot), file)),
  });
  if (restore && !restore(scene)) throw new Error('打开工程后的光照资源身份与原烘焙不一致。');
  return { content: JSON.stringify(envelope), files: resources.map(resource => resource.sourcePath) };
}
