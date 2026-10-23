import type { SyntheticEvent } from 'react';
import './OpeningReplayButton.css';

interface OpeningReplayButtonProps {
  onReplay(): void;
  disabled?: boolean;
}

function stopSceneInteraction(event: SyntheticEvent): void {
  event.stopPropagation();
}

/** 入口保持低存在感；透明热区与键盘提示保证仍可操作。 */
export function OpeningReplayButton({ onReplay, disabled = false }: OpeningReplayButtonProps) {
  return <button type="button" className="player-opening-replay" aria-label="返回开场动画"
    disabled={disabled}
    onPointerDown={stopSceneInteraction} onPointerUp={stopSceneInteraction}
    onPointerMove={stopSceneInteraction} onPointerCancel={stopSceneInteraction}
    onWheel={stopSceneInteraction} onDoubleClick={stopSceneInteraction}
    onKeyDown={stopSceneInteraction} onKeyUp={stopSceneInteraction}
    onClick={event => { event.stopPropagation(); onReplay(); }}>
    <svg className="player-opening-replay-icon" width="12" height="12" viewBox="0 0 12 12"
      fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      <path d="M2.1 4a4.3 4.3 0 1 1-.2 3.5M2.1 1.7V4h2.3" />
    </svg>
    <span className="player-opening-replay-tooltip" aria-hidden="true">返回开场动画</span>
  </button>;
}
