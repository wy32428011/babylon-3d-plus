import { inspectSkyboxEnvironmentBytes, normalizeSkyboxEnvironmentResource, type SkyboxEnvironmentFaceSize, type SkyboxEnvironmentResource } from '../shared/sceneSkyboxContract.ts';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectSkyboxAssetEntry } from '../types.js';

const require = createRequire(import.meta.url);
const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const { authorizeAssetFile, encodeAssetUrl } = require(`./assetRegistry${extension}`) as typeof import('./assetRegistry.js');
export const BUILTIN_SKYBOX_FILE_NAME = 'partly-cloudy-light.hdr';
export const BUILTIN_SKYBOX_FILE_SIZE = 1_441_554;
export const BUILTIN_SKYBOX_SHA256 = 'b35653ca75a00d75392649d29cd27001e5af79dcc6412aa557241bb3ecda1420';

export function builtinSkyboxRoot(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  // 已安装应用的资源在 asar 外；开发及编译后的主进程共用 public 目录。
  return resourcesPath && !process.defaultApp
    ? path.join(resourcesPath, 'builtin-skyboxes')
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/builtin-skyboxes');
}

export function builtinSkyboxPackageForPath(candidate: string): string | null {
  const packagePath = path.join(builtinSkyboxRoot(), 'partly-cloudy-light');
  const normalized = path.resolve(candidate);
  return normalized === packagePath || normalized === path.join(packagePath, BUILTIN_SKYBOX_FILE_NAME) ? packagePath : null;
}

/** 仅信任登记的单文件包，校验真实路径和内容，禁止把相邻目录扩展为发布权限。 */
export async function validateBuiltinSkyboxPackage(packagePath: string): Promise<void> {
  if (builtinSkyboxPackageForPath(packagePath) !== packagePath) throw new Error('内置天空盒目录未登记。');
  for (const target of [builtinSkyboxRoot(), packagePath, path.join(packagePath, BUILTIN_SKYBOX_FILE_NAME)]) {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || path.resolve(await fs.realpath(target)).toLowerCase() !== path.resolve(target).toLowerCase()) {
      throw new Error('内置天空盒路径不能通过符号链接或 Junction 重定向。');
    }
  }
  const entries = await fs.readdir(packagePath);
  if (entries.length !== 1 || entries[0] !== BUILTIN_SKYBOX_FILE_NAME) throw new Error('内置天空盒目录内容与登记不一致。');
  const filePath = path.join(packagePath, BUILTIN_SKYBOX_FILE_NAME);
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.size !== BUILTIN_SKYBOX_FILE_SIZE) throw new Error('内置天空盒文件大小与登记不一致。');
  if (createHash('sha256').update(await fs.readFile(filePath)).digest('hex') !== BUILTIN_SKYBOX_SHA256) {
    throw new Error('内置天空盒 SHA-256 与登记不一致。');
  }
}

/** 内置源包继续保持单文件；预过滤产物在独立登记目录中按 manifest 校验。 */
export async function getBuiltinSkyboxEnvironment(faceSize: SkyboxEnvironmentFaceSize): Promise<SkyboxEnvironmentResource> {
  const root = path.join(path.dirname(builtinSkyboxRoot()), 'builtin-skybox-environments');
  const manifestPath = path.join(root, 'manifest.json');
  for (const candidate of [root, manifestPath]) {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink() || path.resolve(await fs.realpath(candidate)).toLowerCase() !== path.resolve(candidate).toLowerCase()) throw new Error('内置 ENV 路径不能通过链接重定向。');
    if (candidate === manifestPath && (!stat.isFile() || stat.size > 64 * 1024)) throw new Error('内置 ENV 清单无效。');
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { version?: unknown; sourceSha256?: unknown; resources?: Array<Record<string, unknown>> };
  const matches = manifest.resources?.filter(resource => resource?.faceSize === faceSize) ?? [];
  if (manifest.version !== 1 || manifest.sourceSha256 !== BUILTIN_SKYBOX_SHA256 || matches.length !== 1 || matches[0].file !== `${faceSize}.env`) throw new Error('内置 ENV 清单未登记所需规格。');
  const file = path.join(root, `${faceSize}.env`);
  const resource = normalizeSkyboxEnvironmentResource({ ...matches[0], sourcePath: file, packagePath: root, sourceUrl: encodeAssetUrl(file) });
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== resource.byteLength
    || path.resolve(await fs.realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase()
    || resource.sourceSha256 !== BUILTIN_SKYBOX_SHA256) throw new Error('内置 ENV 产物身份无效。');
  const bytes = await fs.readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== resource.sha256) throw new Error('内置 ENV SHA-256 不一致。');
  inspectSkyboxEnvironmentBytes(bytes, faceSize);
  authorizeAssetFile(file);
  return resource;
}

export async function listBuiltinSkyboxAssets(): Promise<ProjectSkyboxAssetEntry[]> {
  const packagePath = path.join(builtinSkyboxRoot(), 'partly-cloudy-light');
  await validateBuiltinSkyboxPackage(packagePath);
  const filePath = path.join(packagePath, BUILTIN_SKYBOX_FILE_NAME);
  authorizeAssetFile(filePath);
  return [{ id: 'builtin-skybox:partly-cloudy-light', name: BUILTIN_SKYBOX_FILE_NAME, displayName: '多云天空（轻量）',
    path: filePath, sourceUrl: encodeAssetUrl(filePath), assetRevision: BUILTIN_SKYBOX_SHA256, packagePath,
    kind: 'skybox', libraryKind: 'skybox', format: 'hdr', fileSizeBytes: BUILTIN_SKYBOX_FILE_SIZE,
    source: 'builtin', availability: 'active', environment: await getBuiltinSkyboxEnvironment(512) }];
}
