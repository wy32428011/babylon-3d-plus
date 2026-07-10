import { useEffect, useRef, useState } from 'react';
import genericMqttDemoSceneContent from '../examples/scenes/generic-mqtt-motion-demo.scene.json?raw';
import stackerMqttDemoSceneContent from '../examples/scenes/stacker-mqtt-demo.scene.json?raw';
import { HomePage } from './editor/home/HomePage';
import { EditorLayout } from './editor/layout/EditorLayout';
import { useEditorStore } from './editor/store/editorStore';

type AppView = 'home' | 'editor';

const DEMO_SCENES: Record<string, { label: string; content: string }> = {
  'mqtt-generic': {
    label: '通用 MQTT 无 Broker 运动演示场景',
    content: genericMqttDemoSceneContent,
  },
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

  return <EditorLayout />;
}
