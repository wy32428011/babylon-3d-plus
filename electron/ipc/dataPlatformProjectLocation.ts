import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  assertDataPlatformBindingTarget,
  normalizeDataPlatformBaseUrl,
  readDataPlatformBinding,
  resolveDataPlatformProjectRoot,
} from './dataPlatformBindingStore.js';

export type DataPlatformProjectLocationInput = {
  workspaceRoot: string;
  baseUrl: string;
  projectId: string;
  /** 仅传入当前场景所属、已经绑定的工程根；不传资源库根或上次工程根。 */
  preferredProjectRoot?: string | null;
};

/** 仅读取目录身份，不创建目录或绑定；新工程按中台来源隔离，同源历史工程继续复用。 */
export async function resolveDataPlatformProjectLocation(
  input: DataPlatformProjectLocationInput,
): Promise<{ projectRoot: string; legacy: boolean }> {
  if (typeof input.workspaceRoot !== 'string' || !path.isAbsolute(input.workspaceRoot.trim())) {
    throw new Error('数据中台工作区路径必须是绝对路径。');
  }
  const workspaceRoot = path.resolve(input.workspaceRoot.trim());
  const baseUrl = normalizeDataPlatformBaseUrl(input.baseUrl);
  const legacyRoot = resolveDataPlatformProjectRoot(workspaceRoot, input.projectId);
  const projectId = path.basename(legacyRoot);
  const sourceKey = createHash('sha256').update(baseUrl).digest('hex');
  const isolatedRoot = path.join(workspaceRoot, 'Platforms', sourceKey, 'Projects', projectId);
  if (input.preferredProjectRoot) {
    const preferred = input.preferredProjectRoot;
    if (!path.isAbsolute(preferred)) throw new Error('当前工程路径必须是绝对路径。');
    const projectRoot = path.resolve(preferred);
    if (samePath(projectRoot, workspaceRoot) || inside(path.join(workspaceRoot, 'SharedResources'), projectRoot)
      || ['projects', 'platforms', 'sharedresources'].includes(path.basename(projectRoot).toLowerCase())) {
      throw new Error('工作区或共享资源目录不能作为已绑定工程。');
    }
    await assertNoLinks(projectRoot);
    await assertNoLinks(path.join(projectRoot, '.babylon-editor', 'data-platform-binding.json'), true);
    const binding = await readDataPlatformBinding(projectRoot);
    if (!binding) throw new Error('当前工程未绑定数据中台项目，不能继承发布归属。');
    assertDataPlatformBindingTarget(binding, projectId, baseUrl);
    return { projectRoot, legacy: samePath(projectRoot, legacyRoot) };
  }

  await assertNoLinks(isolatedRoot);
  await assertNoLinks(path.join(isolatedRoot, '.babylon-editor', 'data-platform-binding.json'), true);
  const isolatedBinding = await readDataPlatformBinding(isolatedRoot);
  if (isolatedBinding) {
    assertDataPlatformBindingTarget(isolatedBinding, projectId, baseUrl);
    return { projectRoot: isolatedRoot, legacy: false };
  }
  if (await hasEntries(isolatedRoot)) throw new Error(`目标来源目录已有未绑定内容，请检查工程归属：${isolatedRoot}`);

  await assertNoLinks(legacyRoot);
  await assertNoLinks(path.join(legacyRoot, '.babylon-editor', 'data-platform-binding.json'), true);
  const legacyBinding = await readDataPlatformBinding(legacyRoot);
  if (legacyBinding?.baseUrl === baseUrl && legacyBinding.projectId === projectId) {
    return { projectRoot: legacyRoot, legacy: true };
  }
  // 未绑定旧目录无法证明来源，即使为空也不新建旧式工程，避免下一次切换中台再次冲突。
  return { projectRoot: isolatedRoot, legacy: false };
}

async function hasEntries(directory: string): Promise<boolean> {
  try { return (await fs.readdir(directory)).length > 0; }
  catch (error) { if (isMissing(error)) return false; throw error; }
}

/** 检查每一级现有路径，包含 workspace 自身，拒绝 junction/符号链接穿透。 */
async function assertNoLinks(target: string, allowFile = false): Promise<void> {
  const normalized = path.resolve(target);
  const root = path.parse(normalized).root;
  let current = root;
  for (const segment of normalized.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (isMissing(error)) return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`工程目录包含符号链接或 junction，无法安全确认来源：${current}`);
    if (!stat.isDirectory() && !(allowFile && samePath(current, normalized) && stat.isFile())) {
      throw new Error(`工程目录路径不是目录：${current}`);
    }
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
