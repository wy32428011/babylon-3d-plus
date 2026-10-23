import { restoreFailedSceneResources } from '../../assets/restoreFailedSceneResources';
import { executeCommand } from '../../commands/CommandHistory';
import { updateSceneDocumentCommand } from '../../commands/entityCommands';
import { prependLog, isRuntimePreviewState } from './editorMutationGuard';
import type { EditorSlice } from './editorStoreTypes';

/** 资源同步事务与发布前的恢复门控。 */
export const createDataPlatformAndPublishSlice: EditorSlice<
  "latestSceneResourceTransaction" |
  "latestSceneResourceRecovery" |
  "sceneResourceIssues" |
  "sceneResourcePolicy" |
  "sceneStartupResourceSessionId" |
  "sceneSourceFilePath" |
  "localSceneEnvironmentRecoveryChoice" |
  "localSceneEnvironmentRecoveryAcceptance" |
  "environmentStartupRelinkSessionId" |
  "recordSceneResourceIssues" |
  "finishLatestSceneResources" |
  "commitLatestSceneResources" |
  "finishSceneStartupResourcePreparation" |
  "beginLocalSceneResourceRecovery" |
  "setLocalSceneEnvironmentRecoveryChoice" |
  "acceptLocalSceneEnvironmentRecoveryChoice" |
  "commitRecoveredLocalSceneResources"
> = (set) => ({
  latestSceneResourceTransaction: null,
  latestSceneResourceRecovery: null,
  sceneResourceIssues: [],
  sceneResourcePolicy: 'preserve-snapshot',
  sceneStartupResourceSessionId: null,
  sceneSourceFilePath: null,
  localSceneEnvironmentRecoveryChoice: null,
  localSceneEnvironmentRecoveryAcceptance: null,
  environmentStartupRelinkSessionId: null,
  recordSceneResourceIssues: (sceneSessionId, issues) => {
    set(state => state.sceneSessionId !== sceneSessionId ? state : {
      sceneResourceIssues: [...new Set([...state.sceneResourceIssues, ...issues])],
    });
  },
  finishLatestSceneResources: (sceneSessionId, expectedScene, error, failed) => {
    set(state => {
      if (state.sceneSessionId !== sceneSessionId || state.scene !== expectedScene) return state;
      const transaction = state.latestSceneResourceTransaction;
      if (transaction && transaction.after !== expectedScene) return state;
      if (error && transaction?.kind === 'local-recovery') {
        // 恢复后的地址已通过完整依赖校验；运行时失败不能再回滚到旧机器上失效的路径。
        return { latestSceneResourceTransaction: null, latestSceneResourceRecovery: null,
          sceneResourceIssues: [...new Set([...state.sceneResourceIssues, error])],
          logs: prependLog(state.logs, `本地场景资源渲染失败，请重新检查资源：${error}`) };
      }
      const recovery = transaction ?? (state.latestSceneResourceRecovery?.after === expectedScene ? state.latestSceneResourceRecovery : null);
      // 局部运行时失败不回滚已经成功更新的资源组，参数保留，问题持续阻止发布。
      if (error) {
        const scene = recovery && failed ? restoreFailedSceneResources(recovery.before, state.scene, failed) : state.scene;
        return {
          scene,
          latestSceneResourceTransaction: null,
          latestSceneResourceRecovery: recovery ? { before: recovery.before, after: scene } : state.latestSceneResourceRecovery,
          ...(failed?.environment ? { environmentRuntimeOverride: null, environmentApplyRequest: null, environmentStartupRelinkSessionId: null } : {}),
          sceneResourceIssues: [...new Set([...state.sceneResourceIssues, ...(transaction?.issues ?? []), error])],
          logs: prependLog(state.logs, '部分场景资源未能完成加载，可继续编辑，发布前请重新同步：' + error),
        };
      }
      return transaction ? { latestSceneResourceTransaction: null, latestSceneResourceRecovery: null, sceneResourceIssues: transaction.issues } : state;
    });
  },
  commitLatestSceneResources: (sceneSessionId, before, after, issues = []) => {
    let committed = false;
    set(state => {
      if (state.sceneSessionId !== sceneSessionId || state.scene !== before || isRuntimePreviewState(state)) return state;
      const result = after === before ? { scene: before, history: state.history }
        : executeCommand(before, state.history, updateSceneDocumentCommand('同步新版模型与参数配置', () => after));
      committed = true;
      return { ...result, latestSceneResourceTransaction: { before, history: state.history, after, issues },
        sceneStartupResourceSessionId: null,
        latestSceneResourceRecovery: null,
        sceneResourceIssues: [...new Set([...state.sceneResourceIssues, ...issues])],
        environmentApplyRequest: null, environmentRuntimeOverride: null,
        environmentStartupRelinkSessionId: null,
        logs: prependLog(state.logs, after === before ? '场景模型已是当前版本。' : '场景模型资源和参数定义已更新，同名参数值和业务绑定已保留。') };
    });
    return committed;
  },
  finishSceneStartupResourcePreparation: (sceneSessionId) => {
    // 查询失败也必须允许原始快照首次加载；显式重试和旧会话不能重置现有运行时。
    set(state => state.sceneSessionId !== sceneSessionId || state.sceneStartupResourceSessionId !== sceneSessionId ? state : {
      sceneStartupResourceSessionId: null,
      environmentStartupRelinkSessionId: null,
    });
  },
  beginLocalSceneResourceRecovery: (sceneSessionId) => {
    set(state => state.sceneSessionId !== sceneSessionId || state.sceneResourcePolicy !== 'local-refresh' ? state : {
      sceneStartupResourceSessionId: sceneSessionId,
    });
  },
  setLocalSceneEnvironmentRecoveryChoice: (sceneSessionId, choice) => {
    set(state => {
      if (state.sceneSessionId !== sceneSessionId || state.sceneResourcePolicy !== 'local-refresh') return state;
      const acceptance = state.localSceneEnvironmentRecoveryAcceptance;
      const sameApprovedVersion = acceptance && choice && acceptance.resourceId === choice.resourceId
        && acceptance.fileRevision === choice.availableRevision && acceptance.sha256 === choice.sha256;
      return { localSceneEnvironmentRecoveryChoice: choice,
        // 其它依赖失败不撤销用户对这个精确版本的授权；候选版本改变时才重新确认。
        localSceneEnvironmentRecoveryAcceptance: choice && !sameApprovedVersion ? null : acceptance ?? null };
    });
  },
  acceptLocalSceneEnvironmentRecoveryChoice: (sceneSessionId, expectedChoice) => {
    let accepted = false;
    set(state => {
      if (state.sceneSessionId !== sceneSessionId || state.sceneResourcePolicy !== 'local-refresh'
        || state.localSceneEnvironmentRecoveryChoice !== expectedChoice) return state;
      accepted = true;
      return { localSceneEnvironmentRecoveryAcceptance: { resourceId: expectedChoice.resourceId,
        fileRevision: expectedChoice.availableRevision, sha256: expectedChoice.sha256 } };
    });
    return accepted;
  },
  commitRecoveredLocalSceneResources: (sceneSessionId, before, after) => {
    let committed = false;
    set(state => {
      if (state.sceneSessionId !== sceneSessionId || state.scene !== before
        || state.sceneResourcePolicy !== 'local-refresh' || isRuntimePreviewState(state)) return state;
      committed = true;
      // 工作区迁移是运行时依赖恢复，不加入撤销历史，避免一次撤销重新引入已失效地址。
      // persistedSceneContent 保留原文档，另存时仍能提示保存恢复后的资源引用。
      return { scene: after, history: state.history,
        localSceneEnvironmentRecoveryChoice: null,
        localSceneEnvironmentRecoveryAcceptance: null,
        latestSceneResourceTransaction: { before, history: state.history, after, issues: [], kind: 'local-recovery' as const },
        latestSceneResourceRecovery: null,
        sceneStartupResourceSessionId: null,
        environmentStartupRelinkSessionId: null,
        environmentApplyRequest: null, environmentRuntimeOverride: null,
        logs: prependLog(state.logs, '本地场景资源已校验并恢复，正在确认实际首帧。') };
    });
    return committed;
  },
});
