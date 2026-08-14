import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import zendingLogoUrl from '../../assets/branding/zending-scene-loading-logo.png';
import {
  getScenePreparationSnapshot,
  subscribeScenePreparation,
} from './scenePreparationProgress';
import styles from './ScenePreparationOverlay.module.css';

type ProgressStyle = CSSProperties & {
  '--scene-preparation-progress': string;
};

/** 覆盖整个编辑器的场景准备蒙版，直到同步、刷新、加载和合批全部落定。 */
export function ScenePreparationOverlay() {
  const overlayRef = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(
    subscribeScenePreparation,
    getScenePreparationSnapshot,
    getScenePreparationSnapshot,
  );

  useEffect(() => {
    if (state.completed) return undefined;
    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    overlayRef.current?.focus();
    return () => {
      if (previousActiveElement?.isConnected) previousActiveElement.focus();
    };
  }, [state.completed, state.sceneSessionId]);

  if (state.completed) return null;

  const percent = Math.max(0, Math.min(100, Math.round(state.percent)));
  const progressStyle: ProgressStyle = {
    '--scene-preparation-progress': `${percent}%`,
  };

  return (
    <div
      aria-busy="true"
      className={styles.overlay}
      data-scene-preparation-phase={state.phase}
      ref={overlayRef}
      tabIndex={-1}
    >
      <section
        aria-describedby="scene-preparation-detail"
        aria-label={state.label}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        aria-valuetext={`${percent}%，${state.label}`}
        className={styles.panel}
        role="progressbar"
      >
        <div aria-hidden="true" className={styles.brandProgress} style={progressStyle}>
          <img alt="" className={styles.brandTrack} draggable={false} src={zendingLogoUrl} />
          <span className={styles.brandFill} />
        </div>
        <div className={styles.progressHeader}>
          <strong>{state.label}</strong>
          <span>{percent}%</span>
        </div>
        <div aria-hidden="true" className={styles.progressTrack}>
          <span className={styles.progressFill} style={{ width: `${percent}%` }} />
        </div>
        <p aria-live="polite" id="scene-preparation-detail">{state.detail}</p>
      </section>
    </div>
  );
}
