import type { EditorState } from '../store/slices/editorStoreTypes';
import { requestSceneLeaveDecision } from './sceneLeaveDecision';
import { serializeScene } from './SceneSerializer';

type SceneState = Pick<EditorState, 'scene' | 'sceneSessionId' | 'hasUnsavedChanges' | 'saveScene' | 'pushLog'>;
export type SceneLeaveApproval = { sessionId: string; content: string };

function capture(state: SceneState): SceneLeaveApproval {
  return { sessionId: state.sceneSessionId, content: serializeScene(state.scene, { includePreparedSkybox: false }) };
}

/** 确认只对当时的文档有效，异步对话框或加载不能丢弃后来产生的编辑。 */
export function isSceneLeaveApprovalCurrent(state: SceneState, approval: SceneLeaveApproval): boolean {
  return state.sceneSessionId === approval.sessionId
    && serializeScene(state.scene, { includePreparedSkybox: false }) === approval.content;
}

export async function confirmSceneLeave(get: () => SceneState, action: string): Promise<SceneLeaveApproval | null> {
  const approval = capture(get());
  if (!get().hasUnsavedChanges()) return approval;
  const decision = await requestSceneLeaveDecision(action);
  if (decision === 'cancel') return null;
  if (!isSceneLeaveApprovalCurrent(get(), approval)) {
    get().pushLog('确认期间场景已变化，已取消离开，请重试。');
    return null;
  }
  if (decision === 'discard') return approval;
  if (!await get().saveScene() || get().sceneSessionId !== approval.sessionId) return null;
  if (get().hasUnsavedChanges()) {
    get().pushLog('保存期间产生了新的修改，已取消离开，请再次保存。');
    return null;
  }
  return capture(get());
}
