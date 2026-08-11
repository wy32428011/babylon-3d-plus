export type SceneModelSelectionPointerStart = {
  pointerId: number;
  button: number;
  clientX: number;
  clientY: number;
  isPrimary: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
};

export type SceneModelSelectionPointerMove = {
  pointerId: number;
  clientX: number;
  clientY: number;
};

export type SceneModelSelectionPointerEnd = SceneModelSelectionPointerMove & {
  button: number;
};

export type SceneModelSelectionPointerSnapshot = {
  pointerId: number;
  button: number;
  startClientX: number;
  startClientY: number;
  maxTravelDistancePx: number;
  toggleSelection: boolean;
};

export type SceneModelSelectionPointerResult = {
  clientX: number;
  clientY: number;
  toggleSelection: boolean;
};

/** 只为主指针的左键/单指轻触创建候选点击会话。 */
export function createSceneModelSelectionPointerSnapshot(
  input: SceneModelSelectionPointerStart,
): SceneModelSelectionPointerSnapshot | null {
  if (!input.isPrimary || input.button !== 0) return null;
  return {
    pointerId: input.pointerId,
    button: input.button,
    startClientX: input.clientX,
    startClientY: input.clientY,
    maxTravelDistancePx: 0,
    toggleSelection: input.ctrlKey || input.metaKey,
  };
}

/** 累计指针相对按下位置的最大位移，保证拖出后返回仍按拖拽处理。 */
export function updateSceneModelSelectionPointerSnapshot(
  snapshot: SceneModelSelectionPointerSnapshot,
  input: SceneModelSelectionPointerMove,
): SceneModelSelectionPointerSnapshot {
  if (snapshot.pointerId !== input.pointerId) return snapshot;
  const travelDistancePx = Math.hypot(
    input.clientX - snapshot.startClientX,
    input.clientY - snapshot.startClientY,
  );
  if (travelDistancePx <= snapshot.maxTravelDistancePx) return snapshot;
  return { ...snapshot, maxTravelDistancePx: travelDistancePx };
}

/** 只依据真实指针轨迹完成点击，不把自动巡检产生的相机位姿变化算作拖拽。 */
export function completeSceneModelSelectionPointer(
  snapshot: SceneModelSelectionPointerSnapshot,
  input: SceneModelSelectionPointerEnd,
  clickTolerancePx: number,
): SceneModelSelectionPointerResult | null {
  if (snapshot.pointerId !== input.pointerId || snapshot.button !== input.button) return null;
  const completedSnapshot = updateSceneModelSelectionPointerSnapshot(snapshot, input);
  if (completedSnapshot.maxTravelDistancePx > clickTolerancePx) return null;
  return {
    clientX: input.clientX,
    clientY: input.clientY,
    toggleSelection: snapshot.toggleSelection,
  };
}

export type SceneModelSelectionPointerBindingOptions = {
  clickTolerancePx: number;
  onSelectionClick: (result: SceneModelSelectionPointerResult) => void;
  onDragStarted: () => void;
};

/** 绑定模型点击会话；拖拽越过阈值后只通知一次相机手动接管。 */
export function bindSceneModelSelectionPointer(
  target: EventTarget,
  options: SceneModelSelectionPointerBindingOptions,
): () => void {
  let snapshot: SceneModelSelectionPointerSnapshot | null = null;

  const handlePointerDown = (rawEvent: Event): void => {
    const event = rawEvent as PointerEvent;
    snapshot = createSceneModelSelectionPointerSnapshot({
      pointerId: event.pointerId,
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      isPrimary: event.isPrimary,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    });
  };

  const handlePointerMove = (rawEvent: Event): void => {
    const event = rawEvent as PointerEvent;
    if (!snapshot || snapshot.pointerId !== event.pointerId || (event.buttons & 1) === 0) return;
    const nextSnapshot = updateSceneModelSelectionPointerSnapshot(snapshot, event);
    if (
      snapshot.maxTravelDistancePx <= options.clickTolerancePx
      && nextSnapshot.maxTravelDistancePx > options.clickTolerancePx
    ) options.onDragStarted();
    snapshot = nextSnapshot;
  };

  const handlePointerUp = (rawEvent: Event): void => {
    const event = rawEvent as PointerEvent;
    if (!snapshot || snapshot.pointerId !== event.pointerId || snapshot.button !== event.button) return;
    const completed = completeSceneModelSelectionPointer(snapshot, event, options.clickTolerancePx);
    snapshot = null;
    if (completed) options.onSelectionClick(completed);
  };

  const handlePointerCancel = (rawEvent: Event): void => {
    const event = rawEvent as PointerEvent;
    if (snapshot?.pointerId === event.pointerId) snapshot = null;
  };

  target.addEventListener('pointerdown', handlePointerDown);
  target.addEventListener('pointermove', handlePointerMove);
  target.addEventListener('pointerup', handlePointerUp);
  target.addEventListener('pointercancel', handlePointerCancel);
  return () => {
    snapshot = null;
    target.removeEventListener('pointerdown', handlePointerDown);
    target.removeEventListener('pointermove', handlePointerMove);
    target.removeEventListener('pointerup', handlePointerUp);
    target.removeEventListener('pointercancel', handlePointerCancel);
  };
}
