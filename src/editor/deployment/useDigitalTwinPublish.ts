import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { serializeScene } from '../project/SceneSerializer';
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
  const activeRequestIdRef = useRef<string | null>(null);
  const contextRequestIdRef = useRef(0);
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
      if (requestId !== contextRequestIdRef.current) return;
      setState((current) => ({ ...current, context, status: 'ready', error: null }));
    } catch (error) {
      if (requestId !== contextRequestIdRef.current) return;
      const message = getErrorMessage(error);
      setState((current) => ({ ...current, status: 'error', error: message }));
      pushLog(`读取数字孪生发布上下文失败：${message}`);
    }
  }, [pushLog]);

  const start = useCallback(async (options: StartDigitalTwinPublishOptions): Promise<DigitalTwinPublishResult | null> => {
    if (!window.editorApi?.publishDigitalTwin) return null;
    const requestId = crypto.randomUUID();
    const sceneContent = serializeScene(useEditorStore.getState().scene);
    contextRequestIdRef.current += 1;
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
      const result = await window.editorApi.publishDigitalTwin({
        requestId,
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
      setState((current) => ({ ...current, status, result, error: null }));
      for (const warning of result.warnings) pushLog(`数字孪生发布提示：${warning}`);
      if (result.status === 'completed') {
        useEditorStore.getState().markScenePersisted(sceneContent);
        pushLog(`数字孪生发布完成：${result.stableUrl ?? result.releaseUrl ?? result.editorProjectVersionId ?? '已创建新版本'}`);
      } else if (result.status === 'conflict') {
        pushLog(`数字孪生发布冲突：${result.message}${result.conflictCopyPath ? `；冲突副本：${result.conflictCopyPath}` : ''}`);
      } else if (result.status === 'confirmation-required') {
        pushLog(`数字孪生发布需要确认：${result.message}`);
      }
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      setState((current) => ({ ...current, status: 'error', error: message }));
      pushLog(`数字孪生发布失败：${message}`);
      return null;
    } finally {
      activeRequestIdRef.current = null;
    }
  }, [pushLog]);

  const cancel = useCallback(async (): Promise<void> => {
    const requestId = activeRequestIdRef.current;
    if (!requestId || !window.editorApi?.cancelDigitalTwinPublish) return;
    await window.editorApi.cancelDigitalTwinPublish({ requestId }).catch(() => false);
  }, []);

  const reset = useCallback((): void => {
    if (activeRequestIdRef.current) return;
    contextRequestIdRef.current += 1;
    setState(INITIAL_STATE);
  }, []);

  const isBusy = state.status === 'loading-context' || state.status === 'publishing';
  return useMemo(() => ({ state, isBusy, loadContext, start, cancel, reset }), [cancel, isBusy, loadContext, reset, start, state]);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
