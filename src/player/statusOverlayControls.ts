/** MouseEvent.buttons 中主键与次键的位掩码。 */
const PRIMARY_AND_SECONDARY_BUTTONS_MASK = 1 | 2;

export type PlayerStatusOverlayPhase = 'loading' | 'ready' | 'blocked';

export type StatusOverlayChordTransition = {
  chordPressed: boolean;
  shouldToggle: boolean;
};

/** 数字孪生发布 Viewer 固定从隐藏状态启动；普通部署继续遵循 runtime-config。 */
export function resolveInitialPlayerStatusOverlayVisibility(
  configuredVisible: boolean,
  isDigitalTwin: boolean,
): boolean {
  return isDigitalTwin ? false : configuredVisible;
}

/**
 * 根据当前鼠标按键位图识别左右键组合，并保证同一次完整按压只触发一次切换。
 * Pointer Events 会把追加按键的变化作为 pointermove 上报，调用方应同时处理 pointerdown 与 pointermove。
 */
export function getStatusOverlayChordTransition(
  buttons: number,
  wasChordPressed: boolean,
): StatusOverlayChordTransition {
  const chordPressed = (buttons & PRIMARY_AND_SECONDARY_BUTTONS_MASK) === PRIMARY_AND_SECONDARY_BUTTONS_MASK;
  return {
    chordPressed,
    shouldToggle: chordPressed && !wasChordPressed,
  };
}

/** 绑定发布 Viewer 的鼠标组合键，并返回完整清理函数。 */
export function bindStatusOverlayPointerChordToggle(
  canvas: EventTarget,
  windowTarget: EventTarget,
  onToggle: () => void,
): () => void {
  let chordPressed = false;
  const handlePointerButtonsChanged = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (pointerEvent.pointerType !== 'mouse') return;
    const transition = getStatusOverlayChordTransition(pointerEvent.buttons, chordPressed);
    chordPressed = transition.chordPressed;
    if (transition.shouldToggle) onToggle();
  };
  const resetChord = (): void => {
    chordPressed = false;
  };
  const preventContextMenu = (event: Event): void => {
    event.preventDefault();
  };
  const captureOptions = { capture: true } as const;

  canvas.addEventListener('pointerdown', handlePointerButtonsChanged, captureOptions);
  canvas.addEventListener('pointermove', handlePointerButtonsChanged, captureOptions);
  canvas.addEventListener('contextmenu', preventContextMenu);
  windowTarget.addEventListener('pointerup', handlePointerButtonsChanged, captureOptions);
  windowTarget.addEventListener('pointercancel', resetChord, captureOptions);
  windowTarget.addEventListener('blur', resetChord, captureOptions);
  return () => {
    canvas.removeEventListener('pointerdown', handlePointerButtonsChanged, captureOptions);
    canvas.removeEventListener('pointermove', handlePointerButtonsChanged, captureOptions);
    canvas.removeEventListener('contextmenu', preventContextMenu);
    windowTarget.removeEventListener('pointerup', handlePointerButtonsChanged, captureOptions);
    windowTarget.removeEventListener('pointercancel', resetChord, captureOptions);
    windowTarget.removeEventListener('blur', resetChord, captureOptions);
  };
}

/** 加载、阻断和真实运行异常始终展示；正常运行态由用户控制状态层。 */
export function shouldShowPlayerStatusOverlay(
  phase: PlayerStatusOverlayPhase,
  requestedVisible: boolean,
  hasRuntimeIssue: boolean,
): boolean {
  return phase !== 'ready' || requestedVisible || hasRuntimeIssue;
}
