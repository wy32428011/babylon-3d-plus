/** MouseEvent.buttons 中主键与次键的位掩码。 */
const PRIMARY_AND_SECONDARY_BUTTONS_MASK = 1 | 2;

/** 运行状态层低频刷新 FPS，避免为只读指标触发高频 React 渲染。 */
export const PLAYER_STATUS_FPS_SAMPLE_INTERVAL_MS = 1_000;

export type PlayerStatusOverlayPhase = 'loading' | 'ready' | 'blocked';

export type PlayerFloatingControl = 'auto-patrol' | 'manual-roam';

export type StatusOverlayChordTransition = {
  chordPressed: boolean;
  shouldToggle: boolean;
};

/** 同一大屏运行按钮再次点击时关闭浮窗，切换按钮时打开新的浮窗。 */
export function resolvePlayerFloatingControlToggle(
  currentControl: PlayerFloatingControl | null,
  requestedControl: PlayerFloatingControl,
): PlayerFloatingControl | null {
  return currentControl === requestedControl ? null : requestedControl;
}

/** 数字孪生发布 Viewer 固定从隐藏状态启动；普通部署继续遵循 runtime-config。 */
export function resolveInitialPlayerStatusOverlayVisibility(
  configuredVisible: boolean,
  isDigitalTwin: boolean,
): boolean {
  return isDigitalTwin ? false : configuredVisible;
}

/** 普通 Viewer 继续显示运行控制；数字孪生只显示已由大屏命令打开的浮窗。 */
export function shouldShowPlayerFloatingControl(
  isDigitalTwin: boolean,
  openedDigitalTwinControl: PlayerFloatingControl | null,
  control: PlayerFloatingControl,
): boolean {
  return !isDigitalTwin || openedDigitalTwinControl === control;
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

/** 绑定发布 Viewer 覆盖层的鼠标组合键，并返回完整清理函数。 */
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

/** 状态层只显示整数 FPS；引擎尚未产出有效采样时使用稳定占位符。 */
export function formatPlayerStatusFps(fps: number | null | undefined): string {
  return typeof fps === 'number' && Number.isFinite(fps) && fps >= 0
    ? String(Math.round(fps))
    : '--';
}
