import type { EditorState, EditorLog } from './editorStoreTypes';

/** 判断当前 store 是否处于运行预览只读模式。 */
export function isRuntimePreviewState(state: EditorState): boolean {
  return state.runtimeMode === 'preview';
}

/** 在运行预览中拦截会修改场景文档或历史记录的入口。 */
export function guardRuntimePreviewMutation(state: EditorState, actionLabel: string): EditorState {
  if (!isRuntimePreviewState(state)) return state;
  return {
    ...state,
    logs: prependLog(state.logs, `运行预览只读：已阻止${actionLabel}。`),
  };
}

export function createLog(message: string): EditorLog {
  return { id: crypto.randomUUID(), message };
}

export function prependLog(logs: EditorLog[], message: string): EditorLog[] {
  return [createLog(message), ...logs].slice(0, 100);
}
