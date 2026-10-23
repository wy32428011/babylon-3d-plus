import { getRequiredEnvironmentResourceIds } from '../../../../electron/shared/sceneEnvironmentReferences';
import type { EditorState } from './editorStoreTypes';

/** 打开任意场景或新建空白场景后异步同步环境模型。 */
export async function syncDataPlatformEnvironmentsAfterWorkspaceOpen(getState: () => EditorState, pushLog: (message: string) => void): Promise<void> {
  if (!window.editorApi?.syncDataPlatformEnvironments) return;

  try {
    const currentEnvironment = getState().scene.sceneSettings.environment;
    const started = await window.editorApi.syncDataPlatformEnvironments({
      requiredResourceIds: getRequiredEnvironmentResourceIds(getState().scene),
      expectedSourceKey: currentEnvironment?.source === 'data-platform'
        ? currentEnvironment.dataPlatformSourceKey
        : undefined,
    });
    if (started) pushLog('编辑工作区已打开，正在后台同步数据中台环境模型。');
    else pushLog('编辑工作区已打开，但环境模型同步未启动；已阻止加载未重关联的旧缓存路径。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushLog(`编辑工作区已打开，但启动环境模型同步失败：${message}`);
  }
}

/** 本地场景成功加载后异步同步数据中台图片库；同步失败不影响已经打开的场景。 */
export async function syncDataPlatformImagesAfterLocalSceneLoad(pushLog: (message: string) => void): Promise<void> {
  if (!window.editorApi?.syncDataPlatformImages) return;

  try {
    const started = await window.editorApi.syncDataPlatformImages();
    if (started) pushLog('本地场景已加载，正在同步数据中台图片库。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushLog(`本地场景已加载，但启动数据中台图片同步失败：${message}`);
  }
}
