import type { LocalSceneResourceSyncResult } from '../../../electron/types';
import type { SceneDocument } from '../model/SceneDocument';

type PreparedSceneUpdate = { scene: SceneDocument; updatedCount: number; issues: string[]; warnings?: string[] };

let publishing: { sessionId: string; token: symbol } | null = null;
const publishListeners = new Set<() => void>();
export const getSceneModelPublishSession = (): string | null => publishing?.sessionId ?? null;
export function subscribeSceneModelPublishOperation(listener: () => void): () => void {
  publishListeners.add(listener);
  return () => { publishListeners.delete(listener); };
}
/** 占用覆盖整次发布及自动重试，避免后台库同步取消发布中的下一场景下载。 */
export function acquireSceneModelPublishOperation(sessionId: string): () => void {
  if (publishing) throw new Error('已有场景发布操作正在准备资源。');
  const operation = { sessionId, token: Symbol('scene-publish') };
  publishing = operation;
  publishListeners.forEach(listener => listener());
  return () => {
    if (publishing !== operation) return;
    publishing = null;
    publishListeners.forEach(listener => listener());
  };
}

/** 普通快照打开也能主动升级，运行时失败检查必须跟随更新事务，不能仅依赖打开模式。 */
export function shouldValidateSceneModelResources(state: {
  sceneResourcePolicy: string;
  latestSceneResourceTransaction?: { after: SceneDocument } | null;
  latestSceneResourceRecovery?: { after: SceneDocument } | null;
}, scene: SceneDocument): boolean {
  return state.sceneResourcePolicy !== 'preserve-snapshot'
    || state.latestSceneResourceTransaction?.after === scene
    || state.latestSceneResourceRecovery?.after === scene;
}

/** 下载和环境准备期间允许文档变化；重新校验最新文档后才能提交，最多补查一次。 */
export async function runSceneModelSyncTransaction(options: {
  sceneSessionId: string;
  syncLibrary: boolean;
  getSnapshot: () => { sceneSessionId: string; scene: SceneDocument };
  prepare: (scene: SceneDocument, syncLibrary: boolean) => Promise<LocalSceneResourceSyncResult>;
  apply: (scene: SceneDocument, resources: LocalSceneResourceSyncResult) => Promise<PreparedSceneUpdate>;
  commit: (before: SceneDocument, after: SceneDocument, issues: string[]) => boolean;
}): Promise<(PreparedSceneUpdate & { libraryErrors: string[] }) | null> {
  const libraryErrors = new Set<string>();
  const isCurrent = () => options.getSnapshot().sceneSessionId === options.sceneSessionId;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!isCurrent()) return null;
    const before = options.getSnapshot().scene;
    const resources = await options.prepare(before, options.syncLibrary && attempt === 0);
    if (!isCurrent()) return null;
    for (const error of resources.libraryErrors ?? []) libraryErrors.add(error);
    if (!resources.configured || !resources.sourceKey || !resources.modelReplacements) {
      throw new Error('数据中台未返回完整的场景模型同步结果，请检查连接配置。');
    }
    if (options.getSnapshot().scene !== before) continue;
    const prepared = await options.apply(before, resources);
    if (!isCurrent()) return null;
    if (options.getSnapshot().scene !== before) continue;
    if (!options.commit(before, prepared.scene, prepared.issues)) {
      throw new Error('当前场景无法提交模型更新，请退出运行预览或等待当前操作完成后重试。');
    }
    return { ...prepared, libraryErrors: [...libraryErrors] };
  }
  throw new Error('同步期间场景持续发生变化，已保留最新编辑内容，请重新同步。');
}
