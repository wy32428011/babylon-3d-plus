import type { SkyboxReadiness } from '../../runtime/babylon/SceneSkyboxRuntime';
import type { SkyboxPreparationStage } from '../../../electron/shared/sceneSkyboxContract';

type Snapshot = SkyboxReadiness & { sceneSessionId: string; stage: SkyboxPreparationStage | null };
const EMPTY: Snapshot = { sceneSessionId: '', phase: 'idle', message: null, sourceUrl: null, stage: null };
let snapshot = EMPTY;
let owner: object | null = null;
let retry: (() => void) | null = null;
const listeners = new Set<() => void>();
const publish = (next: Snapshot) => {
  if (Object.keys(next).every(key => next[key as keyof Snapshot] === snapshot[key as keyof Snapshot])) return;
  snapshot = next;
  for (const listener of listeners) listener();
};

/** 运行状态不进入场景文档；视口重建后旧回调不能覆盖新视口或触发旧重试。 */
export const skyboxRuntimeStatus = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  connect(onRetry: () => void) {
    const token = {}; owner = token; retry = onRetry; publish(EMPTY);
    return {
      publish(sceneSessionId: string, state: SkyboxReadiness, stage: SkyboxPreparationStage | null = null) {
        if (owner === token) publish({ ...state, sceneSessionId, stage });
      },
      dispose() { if (owner !== token) return; owner = null; retry = null; publish(EMPTY); },
    };
  },
  retry(sceneSessionId: string) { if (snapshot.sceneSessionId === sceneSessionId && snapshot.phase === 'error') retry?.(); },
};
