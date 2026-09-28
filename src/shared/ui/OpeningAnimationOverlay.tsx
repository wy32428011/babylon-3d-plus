import type { OpeningSnapshot } from '../../runtime/opening/GeographicOpeningRuntime';
import type { SceneOpeningAnimationSettings } from '../../editor/model/sceneOpeningAnimation';
import './OpeningAnimationOverlay.css';

/** 准备阶段遮住已加载业务视角；首帧之后由所选开场提供界面。 */
export function OpeningAnimationOverlay({ settings, snapshot, onSkip, preview = false }: {
  settings: SceneOpeningAnimationSettings;
  snapshot: OpeningSnapshot | null;
  onSkip(): void;
  preview?: boolean;
}) {
  return <section className={`opening-animation-overlay${snapshot ? ' is-ready' : ''}`} aria-label="开场动画" aria-busy={!snapshot}>
    {!snapshot && <div className="opening-animation-loading" role="status">
      <i aria-hidden="true" /><h2>{settings.template === 'package' ? '正在准备开场动画' : '正在构建全域视野'}</h2><p>加载开场画面与场景资源</p>
      {(settings.allowSkip || preview) && <button type="button" onClick={onSkip}>{preview ? '结束预览' : '跳过开场'}</button>}
    </div>}
    {snapshot && preview && <button type="button" className="opening-animation-preview-exit" onClick={onSkip}>结束预览 · Esc</button>}
    <div className="opening-animation-accessible-progress" role="progressbar" aria-label={snapshot?.label ?? '准备开场'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((snapshot?.progress ?? 0) * 100)} />
  </section>;
}
