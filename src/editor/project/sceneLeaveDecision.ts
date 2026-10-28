export type SceneLeaveDecision = 'save' | 'discard' | 'cancel';
type Request = { action: string; resolve: (decision: SceneLeaveDecision) => void };
let request: Request | null = null;
const listeners = new Set<() => void>();
export const getSceneLeaveRequest = () => request;
export const subscribeSceneLeaveRequest = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** 同时到达的另一离开请求不复用前一次确认，避免一次确认授权两次切换。 */
export function requestSceneLeaveDecision(action: string): Promise<SceneLeaveDecision> {
  if (request) return Promise.resolve('cancel');
  return new Promise(resolve => {
    request = { action, resolve };
    for (const listener of listeners) listener();
  });
}

export function decideSceneLeave(decision: SceneLeaveDecision): void {
  const pending = request;
  request = null;
  for (const listener of listeners) listener();
  pending?.resolve(decision);
}
