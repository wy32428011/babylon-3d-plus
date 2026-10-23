import { getRequiredEnvironmentResourceIds } from '../../../electron/shared/sceneEnvironmentReferences';
import { applyAvailableSceneModelUpdates } from '../assets/applySceneModelUpdates';
import { loadEnvironmentFromAsset } from '../assets/environmentAssets';
import { runSceneModelSyncTransaction } from '../assets/sceneModelSyncTransaction';
import { environmentPreparationStore } from '../loading/environmentPreparationProgress';
import { beginSceneModelAssetRefresh, getScenePreparationSnapshot, reportSceneModelSyncProgress, settleSceneModelAssetRefresh } from '../loading/scenePreparationProgress';
import { getSceneLightingBakeError } from '../../../electron/shared/sceneLightingBakeContract';
import { serializeScene } from '../project/SceneSerializer';
import { useEditorStore } from '../store/editorStore';
import { waitForPublishCondition } from './publishOrchestration';
import { preparePublishResources } from './preparePublishResources';

export async function synchronizePublishScene(sceneSessionId: string, assertCurrent: () => void,
  pushLog: (message: string) => void = message => useEditorStore.getState().pushLog(message)): Promise<void> {
  const api = window.editorApi;
  if (!api?.prepareLocalSceneResources) throw new Error('当前编辑器不支持发布前同步模型，请更新编辑器。');
  await waitForPublishCondition({ assertCurrent, ready: () => !useEditorStore.getState().latestSceneResourceTransaction });
  assertCurrent();
  if (useEditorStore.getState().runtimeMode !== 'edit') throw new Error('请先退出运行预览，再发布场景。');
  const runId = `publish-sync-${crypto.randomUUID()}`;
  const refreshId = crypto.randomUUID();
  const reportedWarnings = new Set<string>();
  environmentPreparationStore.clearError(sceneSessionId);
  reportSceneModelSyncProgress(sceneSessionId, { runId, phase: 'querying', completed: 0, total: 0, error: null, message: '发布前正在统一中台模型并保留场景配置…' });
  try {
    const result = await runSceneModelSyncTransaction({
      sceneSessionId, syncLibrary: false, getSnapshot: () => useEditorStore.getState(),
      prepare: async scene => {
        assertCurrent();
        const resources = await preparePublishResources(serializeScene(scene), assertCurrent);
        assertCurrent();
        return resources;
      },
      apply: async (scene, resources) => {
        assertCurrent();
        const issues = (resources.issues ?? []).map(issue => `[${issue.resourceKind} ${issue.resourceId ?? ''}] ${issue.message}`);
        const environment = scene.sceneSettings.environment;
        let nextEnvironment = environment;
        const resourceId = getRequiredEnvironmentResourceIds(scene)?.[0];
        if (environment && (resourceId || environment.source === 'data-platform')) {
          const asset = resources.environmentAssets.find(candidate => candidate.dataPlatformSourceKey === resources.sourceKey
            && (!resourceId || candidate.dataPlatformResourceId === resourceId));
          if (!asset) issues.push('中台环境模型未同步成功，原配置已保留。');
          else {
            nextEnvironment = await loadEnvironmentFromAsset(asset, environment);
            if (!nextEnvironment) throw new Error('新版环境配置无效，原环境配置已保留。');
          }
        }
        assertCurrent();
        const updated = applyAvailableSceneModelUpdates(scene, resources.modelReplacements!, resources.sourceKey!, nextEnvironment);
        // 参数契约变化只记录提示，不进入阻断首帧/发布的资源错误集合。
        for (const warning of [...(resources.warnings ?? []), ...(updated.warnings ?? [])]) {
          if (reportedWarnings.has(warning)) continue;
          reportedWarnings.add(warning);
          pushLog(`模型参数同步提示：${warning}`);
        }
        return { ...updated, issues: [...issues, ...updated.issues.map(issue => issue.message)] };
      },
      commit: (before, after, issues) => {
        assertCurrent();
        reportSceneModelSyncProgress(sceneSessionId, { runId, phase: 'completed', completed: 0, total: 0, error: null, message: '模型已同步，正在等待替换后的实际首帧…' });
        beginSceneModelAssetRefresh(sceneSessionId, refreshId);
        return useEditorStore.getState().commitLatestSceneResources(sceneSessionId, before, after, issues);
      },
    });
    assertCurrent();
    if (!result) throw new Error('场景已切换，发布准备已停止。');
    settleSceneModelAssetRefresh(sceneSessionId, result.issues.join('\n') || null, refreshId);
    if (result.issues.length) throw new Error(`以下资源暂时无法与中台对齐，原配置已保留：\n${result.issues.join('\n')}`);
    await waitForPublishRuntime(sceneSessionId, assertCurrent);
  } catch (error) {
    if (useEditorStore.getState().sceneSessionId === sceneSessionId) {
      const message = error instanceof Error ? error.message : String(error);
      reportSceneModelSyncProgress(sceneSessionId, { runId, phase: 'failed', completed: 0, total: 0, error: message, message });
      settleSceneModelAssetRefresh(sceneSessionId, message, refreshId);
    }
    throw error;
  }
}

export async function waitForPublishRuntime(sceneSessionId: string, assertCurrent: () => void): Promise<void> {
  // 让 React 提交资源替换，避免读取到上一文档的 completed 快照。
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await waitForPublishCondition({ assertCurrent, ready: () => {
    const state = useEditorStore.getState();
    const preparation = getScenePreparationSnapshot();
    if (preparation.sceneSessionId !== sceneSessionId) return false;
    if (preparation.runtime.forcedSettled) throw new Error('场景资源首帧校验失败，发布准备已停止。');
    if (state.latestSceneResourceTransaction || !preparation.runtime.stable || !preparation.completed) return false;
    if (state.sceneResourceIssues.length) throw new Error(state.sceneResourceIssues.join('\n'));
    const environment = environmentPreparationStore.getSnapshot();
    if (environment.sceneSessionId === sceneSessionId && environment.error) throw new Error(environment.error);
    return true;
  } });
}

/** 完整 GI 任务按实际进度和取消信号等待，不套用旧地面阴影的十分钟时限。 */
export async function preparePublishLightingBake(assertCurrent: () => void): Promise<void> {
  assertCurrent();
  if (!getSceneLightingBakeError(useEditorStore.getState().scene)) return;
  const existingRequestId = useEditorStore.getState().lightingBakeRequest?.id;
  useEditorStore.getState().requestLightingBake();
  const requestId = useEditorStore.getState().lightingBakeRequest?.id;
  if (!requestId) throw new Error(useEditorStore.getState().lightingBakeStatus.message ?? '无法开始材质与光照烘焙。');
  try {
    await waitForPublishCondition({ assertCurrent, timeoutMs: Number.POSITIVE_INFINITY, ready: () => {
      const state = useEditorStore.getState();
      if (state.lightingBakeStatus.phase === 'error' || state.lightingBakeStatus.phase === 'cancelled') throw new Error(state.lightingBakeStatus.message ?? '材质与光照烘焙已停止。');
      if (state.lightingBakeRequest && state.lightingBakeRequest.id !== requestId) throw new Error('光照烘焙任务已被替换，请重新开始发布。');
      return state.lightingBakeRequest === null;
    } });
    const error = getSceneLightingBakeError(useEditorStore.getState().scene);
    if (error) throw new Error(error);
  } catch (error) {
    if (!existingRequestId && useEditorStore.getState().lightingBakeRequest?.id === requestId) useEditorStore.getState().cancelLightingBake();
    throw error;
  }
}
