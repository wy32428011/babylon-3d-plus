import { useEffect, useRef, useState } from 'react';
import stackerMqttDemoSceneContent from '../examples/scenes/stacker-mqtt-demo.scene.json?raw';
import { HomePage } from './editor/home/HomePage';
import {
  getReturnToHomePageBlockMessage,
  RETURN_TO_HOME_PAGE_UNSAVED_CONFIRM,
} from './editor/home/returnToHomePage';
import { EditorLayout } from './editor/layout/EditorLayout';
import { useEditorStore } from './editor/store/editorStore';

type AppView = 'home' | 'editor';

const DEMO_SCENES: Record<string, { label: string; content: string }> = {
  'stacker-mqtt': {
    label: 'Stacker MQTT 模拟演示场景',
    content: stackerMqttDemoSceneContent,
  },
};

/** 从 URL 查询参数读取需要自动加载的开发演示场景。 */
function readDemoSceneKey(): string | null {
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.get('demo') ?? searchParams.get('scene');
}

/** 应用根组件负责首页和编辑器工作台之间的启动状态切换。 */
export default function App() {
  const [view, setView] = useState<AppView>('home');
  const demoSceneLoadedRef = useRef(false);
  const deepLinkOpeningRef = useRef(false);
  const returningHomeRef = useRef(false);

  useEffect(() => {
    if (demoSceneLoadedRef.current) return;
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

          await window.editorApi.saveDataPlatformConfig({ baseUrl: deepLink.baseUrl });
          const project = await window.editorApi.getDataPlatformProject({ projectId: deepLink.projectId });
          const result = await window.editorApi.openDataPlatformProject({ projectId: project.id });
          if (result.sceneFilePath) {
            const loaded = await useEditorStore.getState().loadSceneFromFile(result.sceneFilePath);
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
  function enterEditorWithProject(): void {
    useEditorStore.getState().newScene();
    setView('editor');
  }

  /** 新建空白场景后进入编辑器，避免旧场景状态残留在首页启动流中。 */
  function handleNewScene(): void {
    useEditorStore.getState().newScene();
    setView('editor');
  }

  /** 通过系统文件选择器加载场景，成功后切换到编辑器。 */
  async function handleOpenSceneDialog(): Promise<boolean> {
    const loaded = await useEditorStore.getState().loadScene();
    if (loaded) setView('editor');
    return loaded;
  }

  /** 通过最近场景路径加载场景，成功后切换到编辑器。 */
  async function handleOpenRecentScene(filePath: string): Promise<boolean> {
    const loaded = await useEditorStore.getState().loadSceneFromFile(filePath);
    if (loaded) setView('editor');
    return loaded;
  }

  /** 从编辑器工作台返回首页，发布中阻断，未保存修改需确认。 */
  async function handleBackToHome(): Promise<void> {
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

      useEditorStore.getState().stopRuntimePreview();
      setView('home');
    } finally {
      returningHomeRef.current = false;
    }
  }

  if (view === 'home') {
    return (
      <HomePage
        onEnterBlankEditor={enterBlankEditor}
        onEnterProjectEditor={enterEditorWithProject}
        onNewScene={handleNewScene}
        onOpenRecentScene={handleOpenRecentScene}
        onOpenSceneDialog={handleOpenSceneDialog}
      />
    );
  }

  return <EditorLayout onBackToHome={() => void handleBackToHome()} />;
}
