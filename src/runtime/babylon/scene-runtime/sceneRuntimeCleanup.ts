import type { SceneRuntimeContext } from './SceneRuntimeContext';

/** 清理失败必须可见，但不能阻止其它独立资源释放；调用方仍负责有依赖的清理顺序。 */
export function runSceneRuntimeCleanup(context: SceneRuntimeContext, resource: string, cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    const message = `场景清理失败（${resource}）：${error instanceof Error ? error.message : String(error)}`;
    try {
      Reflect.apply(context.pushLog, context.callbackReceiver, [message]);
    } catch (logError) {
      console.error(message, error, logError);
    }
  }
}
