import { getScenePreparationSnapshot } from '../loading/scenePreparationProgress';
import { environmentPreparationStore } from '../loading/environmentPreparationProgress';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { repairPublishSceneModels } from './repairPublishSceneModels';
import { repairPublishSceneSkyboxes } from './repairPublishSceneSkyboxes';
import { executeCommand } from '../commands/CommandHistory';
import { updateSceneDocumentCommand } from '../commands/entityCommands';
import { serializeScene } from '../project/SceneSerializer';
import { getSceneShadowBakeError } from '../model/sceneShadowBake';
import { useEditorStore } from '../store/editorStore';

export type DigitalTwinPublishStatus =
  | 'idle'
  | 'loading-context'
  | 'ready'
  | 'publishing'
  | 'confirmation-required'
  | 'conflict'
  | 'completed'
  | 'canceled'
  | 'error';

export type DigitalTwinPublishState = {
  status: DigitalTwinPublishStatus;
  context: DigitalTwinPublishContext | null;
  progress: DigitalTwinPublishProgress | null;
  result: DigitalTwinPublishResult | null;
  error: string | null;
};

export type StartDigitalTwinPublishOptions = {
  projectId: string | null;
  publishName: string;
  remark: string;
  overwriteExisting: boolean;
  forceOverwrite: boolean;
  confirmResourceBindings: boolean;
  allowedParentOrigins: string[];
};

export type DigitalTwinPublishController = {
  state: DigitalTwinPublishState;
  isBusy: boolean;
  loadContext: (projectId?: string | null) => Promise<void>;
  start: (options: StartDigitalTwinPublishOptions) => Promise<DigitalTwinPublishResult | null>;
  cancel: () => Promise<void>;
  reset: () => void;
};

const INITIAL_STATE: DigitalTwinPublishState = {
  status: 'idle',
  context: null,
  progress: null,
  result: null,
  error: null,
};

/** 管理桌面端数字孪生发布 IPC、进度、确认重试和场景保存基线。 */
export function useDigitalTwinPublish(): DigitalTwinPublishController {
  const [state, setState] = useState<DigitalTwinPublishState>(INITIAL_STATE);
  const [isRefreshingPublishContext, setIsRefreshingPublishContext] = useState(false);
  const activeRequestIdRef = useRef<string | null>(null);
  const contextRequestIdRef = useRef(0);
  const contextRef = useRef<{ context: DigitalTwinPublishContext; sceneSessionId: string } | null>(null);
  const pushLog = useEditorStore((store) => store.pushLog);

  useEffect(() => {
    if (!window.editorApi?.onDigitalTwinPublishProgress) return undefined;
    return window.editorApi.onDigitalTwinPublishProgress((progress) => {
      if (progress.requestId !== activeRequestIdRef.current) return;
      setState((current) => ({ ...current, progress }));
    });
  }, []);

  const loadContext = useCallback(async (projectId: string | null = null): Promise<void> => {
    const requestId = contextRequestIdRef.current + 1;
    contextRequestIdRef.current = requestId;
    contextRef.current = null;
    const sceneSessionId = useEditorStore.getState().sceneSessionId;
    if (!window.editorApi?.getDigitalTwinPublishContext) {
      setState((current) => ({
        ...current,
        context: null,
        status: 'error',
        error: '发布到数据中台需要 Electron 桌面环境。',
      }));
      return;
    }
    setState((current) => ({ ...current, context: null, status: 'loading-context', error: null, result: null }));
    try {
      const context = await window.editorApi.getDigitalTwinPublishContext({ projectId });
      if (requestId !== contextRequestIdRef.current || useEditorStore.getState().sceneSessionId !== sceneSessionId) return;
      contextRef.current = { context, sceneSessionId };
      setState((current) => ({ ...current, context, status: 'ready', error: null }));
    } catch (error) {
      if (requestId !== contextRequestIdRef.current || useEditorStore.getState().sceneSessionId !== sceneSessionId) return;
      const message = getErrorMessage(error);
      setState((current) => ({ ...current, status: 'error', error: message }));
      pushLog(`读取数字孪生发布上下文失败：${message}`);
    }
  }, [pushLog]);

  const canceledRequestIdRef = useRef<string | null>(null);

  const start = useCallback(async (options: StartDigitalTwinPublishOptions): Promise<DigitalTwinPublishResult | null> => {
    if (!window.editorApi?.publishDigitalTwin) return null;
    if (activeRequestIdRef.current) return null;
    const prepared = contextRef.current;
    if (!prepared?.context.available || prepared.sceneSessionId !== useEditorStore.getState().sceneSessionId
      || (options.projectId && options.projectId !== prepared.context.projectId)) {
      setState((current) => ({ ...current, context: null, status: 'error', error: '发布目标已变化或尚未就绪，请重新打开发布窗口选择目标。' }));
      return null;
    }
    const targetToken = prepared.context.targetToken;
    const requestId = crypto.randomUUID();
    let sceneContent: string;
    canceledRequestIdRef.current = null;
    const contextRequestId = ++contextRequestIdRef.current;
    activeRequestIdRef.current = requestId;
    setState((current) => ({
      ...current,
      status: 'publishing',
      progress: {
        requestId,
        phase: 'saving',
        detail: '正在提交发布任务…',
        percent: 0,
        uploadedBytes: 0,
        totalBytes: 0,
      },
      result: null,
      error: null,
    }));

    try {
      const editorState = useEditorStore.getState();
      if ((editorState.sceneResourcePolicy === 'data-platform-refresh' || editorState.sceneResourcePolicy === 'local-refresh') && (
        !getScenePreparationSnapshot().completed || editorState.latestSceneResourceTransaction
        || editorState.sceneResourceIssues.length > 0
        || getScenePreparationSnapshot().runtime.forcedSettled
        || environmentPreparationStore.getSnapshot().error)) throw new Error('当前场景仍有资源同步或加载问题，请在资源提示中重新同步并完成校验后发布。');
      if (typeof window.editorApi.recoverDigitalTwinModels !== 'function') {
        throw new Error('当前窗口尚未加载模型恢复接口，请先保存场景，再完全退出并重新启动编辑器后发布。');
      }
      const originalScene = useEditorStore.getState().scene;
      const recovery = await window.editorApi.recoverDigitalTwinModels({
        requestId, projectId: options.projectId, targetToken, sceneContent: serializeScene(originalScene),
      });
      if (canceledRequestIdRef.current === requestId) throw new Error('模型恢复已取消。');
      if (prepared.sceneSessionId !== useEditorStore.getState().sceneSessionId || contextRequestIdRef.current !== contextRequestId) {
        throw new Error('模型恢复期间场景或发布目标已变化，请重新选择发布目标。');
      }
      const repaired = repairPublishSceneModels(originalScene, recovery);
      const repairedSkyboxes = repairPublishSceneSkyboxes(repaired.scene, recovery);
      const restoredScene = repairedSkyboxes.scene;
      useEditorStore.setState((current) => {
        if (current.scene !== originalScene) throw new Error('恢复模型期间场景已修改，请重新发布以包含最新编辑内容。');
        if (restoredScene === originalScene) return current;
        if (current.runtimeMode === 'preview') throw new Error('请先退出运行预览，再恢复发布模型。');
        return executeCommand(current.scene, current.history, updateSceneDocumentCommand('恢复发布模型、天空盒与点击事件绑定', () => restoredScene));
      });
      if (repaired.scene !== originalScene) {
        pushLog(
          '发布前已恢复 ' + repaired.restoredCount + ' 个模型引用，新增 ' + repaired.addedCount
          + ' 个场景模型，重新关联 ' + repaired.reboundCount + ' 个点击设备槽位。'
          + (repaired.addedCount ? ' 新模型放在场景原点，可调整位置与业务资产编号。' : ''),
        );
      }
      if (repairedSkyboxes.restoredCount) pushLog(`发布前已恢复 ${repairedSkyboxes.restoredCount} 个天空盒引用，保留原有强度和旋转参数。`);
      const shadowError = getSceneShadowBakeError(restoredScene);
      if (shadowError) throw new Error(shadowError);
      sceneContent = serializeScene(restoredScene);
      const result = await window.editorApi.publishDigitalTwin({
        requestId,
        targetToken,
        publishName: options.publishName,
        remark: options.remark,
        sceneContent,
        projectId: options.projectId,
        overwriteExisting: options.overwriteExisting,
        forceOverwrite: options.forceOverwrite,
        confirmResourceBindings: options.confirmResourceBindings,
        allowedParentOrigins: options.allowedParentOrigins,
      });
      const status: DigitalTwinPublishStatus = result.status === 'completed'
        ? 'completed'
        : result.status === 'confirmation-required'
          ? 'confirmation-required'
          : result.status === 'conflict'
            ? 'conflict'
            : 'canceled';
      const isCurrentContext = contextRequestIdRef.current === contextRequestId
        && useEditorStore.getState().sceneSessionId === prepared.sceneSessionId;
      const refreshContext = isCurrentContext && (result.status === 'conflict' || result.status === 'confirmation-required');
      if (refreshContext) setIsRefreshingPublishContext(true);
      if (isCurrentContext) setState((current) => ({ ...current, status, result, error: null }));
      for (const warning of result.warnings) pushLog(`数字孪生发布提示：${warning}`);
      if (result.status === 'completed') {
        // 发布返回时用户可能已经切换场景，旧任务不能改变新场景的保存基线。
        if (useEditorStore.getState().sceneSessionId === prepared.sceneSessionId) {
          useEditorStore.getState().markScenePersisted(sceneContent);
        }
        pushLog(`数字孪生发布完成：${result.stableUrl ?? result.releaseUrl ?? result.editorProjectVersionId ?? '已创建新版本'}`);
      } else if (result.status === 'conflict') {
        pushLog(`数字孪生发布冲突：${result.message}${result.conflictCopyPath ? `；冲突副本：${result.conflictCopyPath}` : ''}`);
      } else if (result.status === 'confirmation-required') {
        pushLog(`数字孪生发布需要确认：${result.message}`);
      }
      if (refreshContext) {
        // 保留冲突副本、确认结果和进度；刷新期间仍禁用重试，避免按钮可点而请求锁尚未释放。
        try {
          if (!window.editorApi.getDigitalTwinPublishContext) throw new Error('当前编辑器不支持读取发布上下文。');
          const context = await window.editorApi.getDigitalTwinPublishContext({ projectId: options.projectId });
          if (activeRequestIdRef.current === requestId && contextRequestIdRef.current === contextRequestId) {
            if (prepared.sceneSessionId !== useEditorStore.getState().sceneSessionId) return result;
            contextRef.current = { context, sceneSessionId: prepared.sceneSessionId };
            setState((current) => ({ ...current, context, error: null }));
          }
        } catch (error) {
          if (activeRequestIdRef.current === requestId && contextRequestIdRef.current === contextRequestId) {
            const message = `发布结果已保留，但刷新发布上下文失败：${getErrorMessage(error)}`;
            setState((current) => ({ ...current, error: message }));
            pushLog(message);
          }
        }
      }
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      const canceled = canceledRequestIdRef.current === requestId;
      if (contextRequestIdRef.current === contextRequestId) {
        setState((current) => ({ ...current, status: canceled ? 'canceled' : 'error', error: canceled ? null : message }));
      }
      pushLog(canceled ? '数字孪生发布已取消。' : '数字孪生发布失败：' + message);
      return null;
    } finally {
      if (activeRequestIdRef.current === requestId) {
        activeRequestIdRef.current = null;
        setIsRefreshingPublishContext(false);
      }
    }
  }, [pushLog]);

  const cancel = useCallback(async (): Promise<void> => {
    const requestId = activeRequestIdRef.current;
    if (!requestId || !window.editorApi?.cancelDigitalTwinPublish) return;
    canceledRequestIdRef.current = requestId;
    await window.editorApi.cancelDigitalTwinPublish({ requestId }).catch(() => false);
  }, []);

  const reset = useCallback((): void => {
    if (activeRequestIdRef.current) return;
    contextRequestIdRef.current += 1;
    contextRef.current = null;
    setState(INITIAL_STATE);
  }, []);

  const isBusy = isRefreshingPublishContext || state.status === 'loading-context' || state.status === 'publishing';
  return useMemo(() => ({ state, isBusy, loadContext, start, cancel, reset }), [cancel, isBusy, loadContext, reset, start, state]);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
