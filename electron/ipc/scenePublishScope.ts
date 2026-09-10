import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readDataPlatformBinding } from './dataPlatformBindingStore.js';

export type ScenePublishScope = Readonly<{
  kind: 'unspecified' | 'local-file' | 'bound-project';
  generation: number;
  sceneFilePath?: string;
  projectRoot?: string;
}>;

let updateSequence = 0;
let currentScope: ScenePublishScope = Object.freeze({ kind: 'unspecified', generation: 0 });
let pendingFile: { token: number; filePath: string } | null = null;

export function getScenePublishScope(): ScenePublishScope {
  return currentScope;
}

/** 读取开始只撤销迟到任务的提交资格；取消或失败仍保留当前场景归属。 */
export function beginScenePublishScopeUpdate(): number {
  pendingFile = null;
  return ++updateSequence;
}

export function resetScenePublishScope(): void {
  pendingFile = null;
  currentScope = Object.freeze({ kind: 'unspecified', generation: ++updateSequence });
}

/** 仅由成功激活工程的主进程调用，renderer 不可直接指定发布归属。 */
export function setBoundScenePublishScope(projectRoot: string, sceneFilePath?: string): void {
  pendingFile = null;
  currentScope = Object.freeze({
    kind: 'bound-project', generation: ++updateSequence, projectRoot: path.resolve(projectRoot),
    ...(sceneFilePath ? { sceneFilePath: path.resolve(sceneFilePath) } : {}),
  });
}

/** 成功读取的路径只暂存，等待 renderer 完成 SceneSerializer 校验后确认。 */
export function stageScenePublishScopeFile(token: number, filePath: string): boolean {
  if (token !== updateSequence) return false;
  pendingFile = { token, filePath };
  return true;
}

export async function confirmScenePublishScopeFile(token: number, assertCanCommit?: () => void): Promise<boolean> {
  const candidate = pendingFile;
  if (!candidate || candidate.token !== token || token !== updateSequence) return false;
  const committed = await commitScenePublishScopeFromFile(token, candidate.filePath, assertCanCommit);
  if (committed && pendingFile === candidate) pendingFile = null;
  return committed;
}

/** 按实际场景文件的父目录识别绑定，不按模型路径或上次资产库根目录推断。 */
export async function commitScenePublishScopeFromFile(token: number, sceneFilePath: string, assertCanCommit?: () => void): Promise<boolean> {
  if (token !== updateSequence) return false;
  const actualFilePath = await fs.realpath(sceneFilePath);
  let directory = path.dirname(actualFilePath);
  let projectRoot: string | undefined;
  // 有界扫描避免深层目录产生无界磁盘读取；绑定损坏应报告，不能静默视为未绑定。
  for (let depth = 0; depth < 16; depth += 1) {
    if (token !== updateSequence) return false;
    if (await readDataPlatformBinding(directory)) {
      projectRoot = directory;
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (token !== updateSequence) return false;
  assertCanCommit?.();
  currentScope = Object.freeze({
    kind: projectRoot ? 'bound-project' : 'local-file', generation: token,
    sceneFilePath: actualFilePath, ...(projectRoot ? { projectRoot } : {}),
  });
  return true;
}
