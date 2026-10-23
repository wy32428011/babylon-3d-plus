/** 混合光照日志保留在控制台；历史失败不能覆盖普通提示并冒充当前诊断。 */
export function updatePlayerRuntimeMessage(previous: string | null, message: string): string | null {
  return message.startsWith('混合光照：') || message.startsWith('混合光照已恢复实时基线：') ? previous : message;
}

/** 模型首帧就绪后才展示实时诊断；恢复时移除错误，不生成虚假的成功提示。 */
export function resolvePlayerLightingRuntimeStatus(initialLoadCompleted: boolean, currentError: string | null): string | null {
  return initialLoadCompleted && currentError ? `混合光照：${currentError}` : null;
}
