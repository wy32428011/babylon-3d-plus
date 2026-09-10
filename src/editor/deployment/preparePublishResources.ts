/** 每次同步有独立取消 ID，发布取消不会误停模型库或其他场景的任务。 */
export async function preparePublishResources(sceneContent: string, assertCurrent: () => void): Promise<LocalSceneResourceSyncResult> {
  assertCurrent();
  const api = window.editorApi;
  if (!api?.prepareLocalSceneResources) throw new Error('当前编辑器不支持发布前同步模型，请更新编辑器。');
  const requestId = `publish-models-${crypto.randomUUID()}`;
  let monitor: ReturnType<typeof setInterval> | undefined;
  const canceled = new Promise<never>((_, reject) => {
    monitor = setInterval(() => {
      try { assertCurrent(); } catch (error) {
        clearInterval(monitor);
        void api.cancelSceneModelSync({ requestId }).catch(() => false);
        reject(error);
      }
    }, 100);
  });
  try {
    const resources = await Promise.race([api.prepareLocalSceneResources({ requestId, mode: 'scene-latest', sceneContent }), canceled]);
    assertCurrent();
    return resources;
  } finally {
    clearInterval(monitor);
  }
}
