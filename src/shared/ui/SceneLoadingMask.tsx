import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react';
import zendingLogoUrl from '../../assets/branding/zending-scene-loading-logo.png';
import styles from './SceneLoadingMask.module.css';

type ProgressStyle = CSSProperties & {
  '--scene-loading-progress': string;
};

export type SceneLoadingMaskProps = {
  /** 总体加载进度（0-100）。 */
  percent: number;
  /** 进度标题文案。 */
  label: string;
  /** 进度详情（如“模型 3/5 · xxx.glb”）；为空时保留占位行避免布局跳动。 */
  detail?: string | null;
  /** 场景准备阶段标识，仅用于数据属性调试（编辑器使用）。 */
  phase?: string | null;
} & Omit<HTMLAttributes<HTMLDivElement>, 'aria-busy' | 'children' | 'className' | 'role'>;

/** 编辑器与发布 Viewer 共用的品牌加载蒙版：Logo 蓝色填充 + 进度条 + 百分数。 */
export const SceneLoadingMask = forwardRef<HTMLDivElement, SceneLoadingMaskProps>(
  function SceneLoadingMask({ percent, label, detail, phase, ...overlayProps }, forwardedRef) {
    const clampedPercent = Math.max(0, Math.min(100, Math.round(percent)));
    const progressStyle: ProgressStyle = {
      '--scene-loading-progress': `${clampedPercent}%`,
    };
    return (
      <div
        aria-busy="true"
        className={styles.overlay}
        data-scene-preparation-phase={phase ?? undefined}
        ref={forwardedRef}
        {...overlayProps}
      >
        <section
          aria-describedby="scene-loading-mask-detail"
          aria-label={label}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={clampedPercent}
          aria-valuetext={`${clampedPercent}%，${label}`}
          className={styles.panel}
          role="progressbar"
        >
          <div aria-hidden="true" className={styles.brandProgress} style={progressStyle}>
            <img alt="" className={styles.brandTrack} draggable={false} src={zendingLogoUrl} />
            <span className={styles.brandFill} />
          </div>
          <div className={styles.progressHeader}>
            <strong>{label}</strong>
            <span>{clampedPercent}%</span>
          </div>
          <div aria-hidden="true" className={styles.progressTrack}>
            <span className={styles.progressFill} style={{ width: `${clampedPercent}%` }} />
          </div>
          <p aria-live="polite" id="scene-loading-mask-detail">{detail ?? ''}</p>
        </section>
      </div>
    );
  },
);
