import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import packageInfo from '../package.json' with { type: 'json' };
import { UnsavedSceneDialog } from './editor/ui/UnsavedSceneDialog';
import { AppUpdateDialog } from './editor/ui/AppUpdateDialog';
import {
  createInitialAppUpdateState,
  shouldAutoOpenUpdateDialog,
  type AppUpdateState,
} from '../electron/shared/appUpdate';
import { confirmSceneLeave, isSceneLeaveApprovalCurrent } from './editor/project/sceneLeaveGuard';
import stackerMqttDemoSceneContent from '../examples/scenes/stacker-mqtt-demo.scene.json?raw';
import virtualConveyorMqttDemoSceneContent from '../examples/scenes/virtual-conveyor-mqtt-demo.scene.json?raw';
import { HomePage } from './editor/home/HomePage';
import {
  getReturnToHomePageBlockMessage,
  RETURN_TO_HOME_PAGE_UNSAVED_CONFIRM,
} from './editor/home/returnToHomePage';
import { EditorLayout } from './editor/layout/EditorLayout';
import { useEditorStore } from './editor/store/editorStore';
import { beginProjectOpenSceneCommit, bindProjectOpenScene, completeProjectOpenResources } from './editor/loading/projectOpenTrace';
import type { ProjectOpenTraceContext } from '../electron/shared/projectOpenTrace';

type AppView = 'home' | 'editor' | 'parametric';
const ParametricWorkbench = lazy(() => import('./editor/authoring/ParametricWorkbench'));

const DEMO_SCENES: Record<string, { label: string; content: string }> = {
  'stacker-mqtt': {
    label: 'Stacker MQTT 模拟演示场景',
    content: stackerMqttDemoSceneContent,
  },
  'virtual-conveyor': {
    label: '虚拟输送线 MQTT 演示场景',
    content: virtualConveyorMqttDemoSceneContent,
  },
};

/** 从 URL 查询参数读取需要自动加载的开发演示场景。 */
function readDemoSceneKey(): string | null {
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.get('demo') ?? searchParams.get('scene');
}

/** 应用根组件负责首页和编辑器工作台之间的启动状态切换。 */
export default function App() {
  const [view, setView] = useState<AppView>(() => new URLSearchParams(window.location.search).get('tool') === 'parametric' ? 'parametric' : 'home');
  const viewRef = useRef(view);
  viewRef.current = view;
  const authoringDirtyRef = useRef(false);
  const demoSceneLoadedRef = useRef(false);
  const deepLinkOpeningRef = useRef(false);
  const returningHomeRef = useRef(false);
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>(() =>
    createInitialAppUpdateState(import.meta.env.VITE_APP_VERSION || packageInfo.version, Boolean(window.editorApi?.checkForAppUpdate)),
  );
  const [isUpdateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [isInstallingUpdate, setInstallingUpdate] = useState(false);
  const autoOpenedUpdateKeyRef = useRef<string | null>(null);

  const applyAppUpdateState = useCallback((nextState: AppUpdateState) => {
    setAppUpdateState(nextState);
    if (shouldAutoOpenUpdateDialog(nextState)) {
      const key = `${nextState.stage}:${nextState.availableVersion ?? ''}`;
      if (autoOpenedUpdateKeyRef.current !== key) {
        autoOpenedUpdateKeyRef.current = key;
        setUpdateDialogOpen(true);
      }
    }
  }, []);

  useEffect(() => {
    const api = window.editorApi;
    if (!api?.onAppUpdateState) return undefined;
    const unsubscribe = api.onAppUpdateState(applyAppUpdateState);
    void api.getAppUpdateState?.().then((initial) => {
      if (initial) applyAppUpdateState(initial);
    }).catch(() => undefined);
    return unsubscribe;
  }, [applyAppUpdateState]);

  const handleOpenOrCheckUpdate = useCallback(() => {
    setUpdateDialogOpen(true);
    const api = window.editorApi;
    if (!api?.checkForAppUpdate) {
      setAppUpdateState((prev) => ({
        ...prev,
        stage: 'unsupported',
        manual: true,
        errorMessage: '检测软件更新需要在已安装的 Electron 桌面应用中使用。',
      }));
      return;
    }
    if (appUpdateState.stage === 'available' || appUpdateState.stage === 'downloading' || appUpdateState.stage === 'downloaded') {
      return;
    }
    void api.checkForAppUpdate({ manual: true }).then((next) => {
      if (next) setAppUpdateState(next);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setAppUpdateState((prev) => ({ ...prev, stage: 'error', manual: true, errorMessage: message }));
    });
  }, [appUpdateState.stage]);

  const handleRecheckUpdate = useCallback(() => {
    const api = window.editorApi;
    if (!api?.checkForAppUpdate) return;
    void api.checkForAppUpdate({ manual: true }).then((next) => {
      if (next) setAppUpdateState(next);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setAppUpdateState((prev) => ({ ...prev, stage: 'error', manual: true, errorMessage: message }));
    });
  }, []);

  const handleDownloadUpdate = useCallback(() => {
    const api = window.editorApi;
    if (!api?.downloadAppUpdate) return;
    void api.downloadAppUpdate().then((next) => {
      if (next) setAppUpdateState(next);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setAppUpdateState((prev) => ({ ...prev, stage: 'error', manual: true, errorMessage: message }));
    });
  }, []);

  const handleInstallUpdate = useCallback(() => {
    if (isInstallingUpdate) return;
    const api = window.editorApi;
    const installAppUpdate = api?.installAppUpdate;
    if (!api || !installAppUpdate) return;
    setInstallingUpdate(true);
    void (async () => {
      try {
        const publishContext = await api.getDigitalTwinPublishContext?.().catch(() => null);
        if (publishContext?.publishActive) {
          window.alert('数字孪生发布正在进行，请等待发布完成或取消后再重启安装更新。');
          return;
        }
        if (viewRef.current === 'parametric') {
          if (authoringDirtyRef.current && !window.confirm('参数化工程有未保存修改，是否放弃并重启安装新版本？')) {
            return;
          }
        } else if (viewRef.current === 'editor') {
          useEditorStore.getState().stopRuntimePreview();
          const approval = await confirmSceneLeave(useEditorStore.getState, '重启并安装新版本');
          if (!approval || !isSceneLeaveApprovalCurrent(useEditorStore.getState(), approval)) {
            return;
          }
        }
        await installAppUpdate();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setAppUpdateState((prev) => ({ ...prev, stage: 'error', manual: true, errorMessage: `启动安装程序失败：${message}` }));
      } finally {
        setInstallingUpdate(false);
      }
    })();
  }, [isInstallingUpdate]);

  useEffect(() => {
    if (demoSceneLoadedRef.current || viewRef.current === 'parametric') return;
    demoSceneLoadedRef.current = true;

    const demoSceneKey = readDemoSceneKey();
    if (!demoSceneKey) return;

    const demoScene = DEMO_SCENES[demoSceneKey];
    if (!demoScene) {
      useEditorStore.getState().pushLog(`未知演示场景：${demoSceneKey}`);
      return;
    }

    const loaded = useEditorStore.getState().loadSceneFromContent(demoScene.content, demoScene.label);
    if (loaded) setView('editor');
  }, []);

  useEffect(() => {
    if (!window.editorApi?.onDataPlatformDeepLink) return undefined;
    return window.editorApi.onDataPlatformDeepLink((deepLink) => {
      if (viewRef.current === 'parametric' && authoringDirtyRef.current && !window.confirm('参数化工程有未保存修改，是否放弃并打开数据中台项目？')) return;
      if (deepLinkOpeningRef.current) return;
      deepLinkOpeningRef.current = true;
      void (async () => {
        try {
          const publishContext = await window.editorApi.getDigitalTwinPublishContext?.().catch(() => null);
          if (publishContext?.publishActive) {
            window.alert('数字孪生发布正在进行，完成或取消发布后才能切换项目。');
            return;
          }
          if (useEditorStore.getState().hasUnsavedChanges()) {
            const confirmed = window.confirm('当前场景有未保存修改。切换数据中台项目会丢失这些修改，是否继续？');
            if (!confirmed) return;
          }

          await window.editorApi.saveDataPlatformConfig({
            baseUrl: deepLink.baseUrl,
            ...(deepLink.webBaseUrl ? { webBaseUrl: deepLink.webBaseUrl } : {}),
          });
          const project = await window.editorApi.getDataPlatformProject({ projectId: deepLink.projectId });
          const result = await window.editorApi.openDataPlatformProject({ projectId: project.id });
          if (result.sceneFilePath) {
            const loaded = await useEditorStore.getState().loadSceneFromFile(result.sceneFilePath, undefined, true);
            if (!loaded) throw new Error('数据中台项目入口场景加载失败。');
          } else {
            useEditorStore.getState().newScene();
          }
          if (result.warning) useEditorStore.getState().pushLog(`数据中台项目提示：${result.warning}`);
          if (result.conflictCopyPath) useEditorStore.getState().pushLog(`本地冲突副本：${result.conflictCopyPath}`);
          setView('editor');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          useEditorStore.getState().pushLog(`打开数据中台深链失败：${message}`);
          window.alert(`打开数据中台项目失败：${message}`);
        } finally {
          deepLinkOpeningRef.current = false;
        }
      })();
    });
  }, []);
  /** 进入空白编辑器工作台，显式重置场景状态。 */
  function enterBlankEditor(): void {
    useEditorStore.getState().newScene();
    setView('editor');
  }

  /** 打开项目目录后进入编辑器，项目入口默认以空白场景开始。 */
  function enterEditorWithProject(openTrace?: ProjectOpenTraceContext): void {
    if (openTrace) beginProjectOpenSceneCommit(openTrace);
    useEditorStore.getState().newScene();
    if (openTrace) { bindProjectOpenScene(openTrace, useEditorStore.getState().sceneSessionId); completeProjectOpenResources(openTrace, 'skipped'); }
    setView('editor');
  }

  /** 新建空白场景后进入编辑器，避免旧场景状态残留在首页启动流中。 */
  function handleNewScene(): void {
    useEditorStore.getState().newScene();
    setView('editor');
  }

  /** 通过系统文件选择器加载场景，成功后切换到编辑器。 */
  async function handleOpenSceneDialog(): Promise<boolean> {
    let failure: string | undefined;
    const loaded = await useEditorStore.getState().loadScene((message) => { failure = message; });
    if (failure !== undefined) throw new Error(failure);
    if (loaded) setView('editor');
    return loaded;
  }

  /** 通过最近场景路径加载场景，成功后切换到编辑器。 */
  async function handleOpenRecentScene(filePath: string, isCurrent: () => boolean = () => true, deferEnvironmentUntilSync = false, openTrace?: ProjectOpenTraceContext): Promise<boolean> {
    if (!isCurrent()) return false;
    const loaded = await useEditorStore.getState().loadSceneFromFile(filePath, isCurrent, deferEnvironmentUntilSync, openTrace);
    if (!isCurrent()) return false;
    if (loaded) setView('editor');
    return loaded;
  }

  /** 从编辑器工作台返回首页，发布中阻断，未保存修改需确认。 */
  async function handleBackToHome(beforeLeave?: () => Promise<void>): Promise<void> {
    if (returningHomeRef.current) return;
    returningHomeRef.current = true;

    try {
      const publishContext = await window.editorApi?.getDigitalTwinPublishContext?.().catch(() => null);
      const blockMessage = getReturnToHomePageBlockMessage({
        publishActive: Boolean(publishContext?.publishActive),
      });
      if (blockMessage) {
        window.alert(blockMessage);
        return;
      }

      if (useEditorStore.getState().hasUnsavedChanges()) {
        const confirmed = window.confirm(RETURN_TO_HOME_PAGE_UNSAVED_CONFIRM);
        if (!confirmed) return;
      }

      await beforeLeave?.();
      if (window.editorApi) {
        if (!window.editorApi.closeDataPlatformProject) throw new Error('当前编辑器不支持项目清理，请更新编辑器后重试。');
        await window.editorApi.closeDataPlatformProject();
      }
      useEditorStore.getState().stopRuntimePreview();
      useEditorStore.getState().resetSceneToBlank();
      setView('home');
    } finally {
      returningHomeRef.current = false;
    }
  }

  useEffect(() => {
    if (!window.editorApi?.onWindowCloseRequest) return undefined;
    return window.editorApi.onWindowCloseRequest(async requestId => {
      let allowed = false;
      try {
        if (viewRef.current === 'parametric') {
          allowed = !authoringDirtyRef.current || window.confirm('参数化工程有未保存修改，是否关闭编辑器？');
        } else {
          useEditorStore.getState().stopRuntimePreview();
          const approval = await confirmSceneLeave(useEditorStore.getState, '关闭编辑器');
          allowed = Boolean(approval && isSceneLeaveApprovalCurrent(useEditorStore.getState(), approval));
        }
      } catch (error) {
        useEditorStore.getState().pushLog(`关闭编辑器前检查失败：${error instanceof Error ? error.message : String(error)}`);
      }
      await window.editorApi.confirmWindowClose(requestId, allowed);
    });
  }, []);

  const updateDialog = (
    <AppUpdateDialog
      open={isUpdateDialogOpen}
      state={appUpdateState}
      installing={isInstallingUpdate}
      onClose={() => setUpdateDialogOpen(false)}
      onCheck={handleRecheckUpdate}
      onDownload={handleDownloadUpdate}
      onInstall={handleInstallUpdate}
    />
  );

  if (view === 'parametric') {
    return <>{updateDialog}<Suspense fallback={<main className="app-shell" role="status">正在打开参数化工作台…</main>}><ParametricWorkbench
      onDirtyChange={value => { authoringDirtyRef.current = value; }}
      onBackToHome={() => {
        authoringDirtyRef.current = false;
        const url = new URL(window.location.href);
        url.searchParams.delete('tool');
        window.history.replaceState(null, '', url);
        setView('home');
      }}
    /></Suspense></>;
  }

  if (view === 'home') {
    return (
      <><UnsavedSceneDialog />{updateDialog}<HomePage
        onEnterParametricWorkbench={() => setView('parametric')}
        onEnterBlankEditor={enterBlankEditor}
        onEnterProjectEditor={enterEditorWithProject}
        onNewScene={handleNewScene}
        onOpenRecentScene={handleOpenRecentScene}
        onOpenSceneDialog={handleOpenSceneDialog}
        appUpdateState={appUpdateState}
        onCheckForUpdate={handleOpenOrCheckUpdate}
      /></>
    );
  }

  return (
    <>
      <UnsavedSceneDialog />
      {updateDialog}
      <EditorLayout
        onBackToHome={handleBackToHome}
        appUpdateState={appUpdateState}
        onCheckForUpdate={handleOpenOrCheckUpdate}
      />
    </>
  );
}
