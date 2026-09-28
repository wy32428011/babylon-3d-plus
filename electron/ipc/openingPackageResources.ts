import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getOpeningPackageProblem, type OpeningPackageBinding, type OpeningAssetOverride } from '../shared/openingPackage.js';
import { authorizeAssetRoot, authorizeAssetFile, encodeAssetUrl } from './assetRegistry.js';
import { assertTrustedPathWithinRoot } from './digitalTwinSourceEnvironmentRelink.js';
import { readOpeningPackageDirectory, resolveOpeningPackageDirectory } from './openingPackageStore.js';
import { validateOpeningImageFile } from './openingAssetStore.js';
import type { OpeningPackageFile } from './openingPackageFiles.js';
import type { SourceResourceBundle } from './digitalTwinSourceResourcePlan.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const LOCAL_URL = 'editor-asset://local/';

export type ResolvedOpeningResources = {
  binding: OpeningPackageBinding;
  packageRoot: string;
  manifestPath: string;
  files: OpeningPackageFile[];
  overrides: Array<{ value: OpeningAssetOverride; file: OpeningPackageFile }>;
};

export function getSceneOpeningPackage(sceneValue: unknown): OpeningPackageBinding | null {
  const scene = record(sceneValue) && record(sceneValue.scene) ? sceneValue.scene : sceneValue;
  const opening = record(scene) && record(scene.sceneSettings) ? scene.sceneSettings.openingAnimation : null;
  if (!record(opening) || (opening.package === undefined && opening.template !== 'package')) return null;
  const problem = getOpeningPackageProblem(opening.package);
  if (problem) throw new Error(problem);
  return opening.package as OpeningPackageBinding;
}

export function resolveOpeningLocalPath(value: string, projectRoot: string): string {
  let candidate = value;
  if (value.startsWith(LOCAL_URL)) {
    const url = new URL(value);
    if (url.search || url.hash) throw new Error('开场资源地址不能包含查询参数或片段。');
    candidate = decodeURIComponent(url.pathname.slice(1));
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !path.win32.isAbsolute(value)) throw new Error('开场包与替换素材必须位于当前工程，不能引用网络地址。');
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(projectRoot, candidate);
  const relative = path.relative(projectRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('开场资源不在当前工程内，请先导入开场包或素材。');
  return resolved;
}

/** 保存的定义只用于编辑；发布时须与固定版本实际文件一致，不能夹带另一套运行规则。 */
export async function resolveOpeningPackageResources(sceneValue: unknown, projectRoot: string, signal = new AbortController().signal): Promise<ResolvedOpeningResources | null> {
  const binding = getSceneOpeningPackage(sceneValue); if (!binding) return null;
  const manifestPath = resolveOpeningLocalPath(binding.manifestUrl, projectRoot);
  const packageRoot = resolveOpeningPackageDirectory(projectRoot, binding);
  if (path.resolve(manifestPath) !== path.join(packageRoot, 'manifest.json')) throw new Error('开场包位置与固定版本身份不一致，请重新导入此版本。');
  await assertTrustedPathWithinRoot(projectRoot, packageRoot, '场景开场包');
  const actual = await readOpeningPackageDirectory(packageRoot, signal);
  if (actual.contentHash !== binding.contentHash || canonical(actual.definition) !== canonical(binding.definition)) throw new Error(`开场包 ${binding.id}@${binding.version} 内容校验失败，请重新导入原版本。`);
  const overrides: ResolvedOpeningResources['overrides'] = [];
  for (const [assetId, override] of Object.entries(binding.config.assetOverrides ?? {})) {
    if (binding.definition.manifest.assets.find(asset => asset.id === assetId)?.type !== 'image') throw new Error('开场图片替换只能应用于图片槽位。');
    const sourcePath = resolveOpeningLocalPath(override.assetUrl, projectRoot);
    if (path.dirname(sourcePath) !== path.join(projectRoot, 'Assets', 'OpeningAssets')) throw new Error('开场替换图片必须先导入当前工程。');
    const file = await validateOpeningImageFile(projectRoot, sourcePath, signal);
    if (file.sha256 !== override.sha256.toLowerCase() || file.size !== override.size) throw new Error(`开场替换图片校验失败：${assetId}`);
    overrides.push({ value: override, file });
  }
  return { binding, packageRoot, manifestPath, files: actual.files, overrides };
}

export async function collectOpeningSourceBundles(sceneValues: readonly unknown[], projectRoot: string, signal: AbortSignal): Promise<SourceResourceBundle[]> {
  const bundles = new Map<string, SourceResourceBundle>();
  for (const sceneValue of sceneValues) {
    const resolved = await resolveOpeningPackageResources(sceneValue, projectRoot, signal); if (!resolved) continue;
    bundles.set(resolved.packageRoot, { sourcePath: resolved.packageRoot, destinationRelativePath: path.relative(projectRoot, resolved.packageRoot).replace(/\\/g, '/'),
      integrityFiles: resolved.files.map(file => ({ relativePath: file.relativePath, expectedSize: file.size, expectedSha256: file.sha256, label: `开场包 ${resolved.binding.id}/${file.relativePath}` })) });
    for (const { file } of resolved.overrides) bundles.set(file.sourcePath, { sourcePath: file.sourcePath,
      destinationRelativePath: `Assets/OpeningAssets/${file.relativePath}`,
      integrityFiles: [{ relativePath: file.relativePath, expectedSize: file.size, expectedSha256: file.sha256, label: '开场替换图片' }] });
  }
  return [...bundles.values()];
}

/** 本地工程搬目录后只回迁开场自己的受管路径，校验成功才返回新内容，原文件保留。 */
export async function prepareOpeningSceneContent(content: string, sceneFilePath: string): Promise<string> {
  try { return await relocateOpeningSceneContent(content, sceneFilePath); }
  catch (error) {
    // 开场是可选展示；本地恢复失败不阻断业务场景，发布仍走严格依赖校验。
    console.warn('[opening-package] 本地开场资源未恢复，已保留原配置。', error instanceof Error ? error.message : error);
    return content;
  }
}

async function relocateOpeningSceneContent(content: string, sceneFilePath: string): Promise<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return content; }
  let binding: OpeningPackageBinding | null;
  try { binding = getSceneOpeningPackage(parsed); } catch { return content; }
  if (!binding) return content;
  const projectRoot = await locateOpeningProjectRoot(binding, sceneFilePath);
  if (!projectRoot) return content;
  const expectedRoot = resolveOpeningPackageDirectory(projectRoot, binding);
  const candidate = structuredClone(binding);
  candidate.manifestUrl = encodeAssetUrl(path.join(expectedRoot, 'manifest.json'));
  for (const override of Object.values(candidate.config.assetOverrides ?? {})) {
    let source = override.assetUrl;
    if (source.startsWith(LOCAL_URL)) source = decodeURIComponent(new URL(source).pathname.slice(1));
    const fileName = path.win32.basename(source.replace(/\//g, '\\'));
    if (!/^[a-f0-9]{64}\.(?:png|jpe?g|webp|gif)$/.test(fileName)) throw new Error('开场替换图片身份无效，无法回迁。');
    override.assetUrl = encodeAssetUrl(path.join(projectRoot, 'Assets', 'OpeningAssets', fileName));
  }
  await resolveOpeningPackageResources({ sceneSettings: { openingAnimation: { template: 'package', package: candidate } } }, projectRoot);
  authorizeAssetRoot(expectedRoot);
  for (const override of Object.values(candidate.config.assetOverrides ?? {})) authorizeAssetFile(resolveOpeningLocalPath(override.assetUrl, projectRoot));
  if (canonical(binding) === canonical(candidate)) return content;
  Object.assign(binding, candidate);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function locateOpeningProjectRoot(binding: OpeningPackageBinding, sceneFilePath: string): Promise<string | null> {
  const sceneDirectory = path.dirname(path.resolve(sceneFilePath));
  let sceneRoot = sceneDirectory;
  for (let ancestor = sceneDirectory; ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
    if (path.basename(ancestor).toLowerCase() === 'scenes') { sceneRoot = path.dirname(ancestor); break; }
  }
  const roots = [sceneRoot];
  let originalManifest = binding.manifestUrl;
  if (originalManifest.startsWith(LOCAL_URL)) originalManifest = decodeURIComponent(new URL(originalManifest).pathname.slice(1));
  if (path.isAbsolute(originalManifest)) {
    const suffix = path.join('Assets', 'OpeningPackages', binding.id, `${binding.version}-${binding.contentHash}`, 'manifest.json');
    const normalized = path.normalize(originalManifest);
    if (normalized.toLowerCase().endsWith(path.sep + suffix.toLowerCase())) roots.push(normalized.slice(0, -suffix.length));
  }
  for (const root of roots) {
    const expected = path.join(resolveOpeningPackageDirectory(root, binding), 'manifest.json');
    try { await fs.access(expected); return path.resolve(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return null;
}

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : record(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])])) : item;
  // 包元数据已限制大小、深度；排序仅比较定义，不改写原 JSON 或字段顺序。
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}
