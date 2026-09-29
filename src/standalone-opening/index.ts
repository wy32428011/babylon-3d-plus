import { createReferenceOpening } from '../runtime/opening/reference/index';
import './standalone-opening.css';
import { getReferenceOpeningFrame } from '../runtime/opening/referenceOpeningTimeline.ts';
import { createOpeningController } from './controller.ts';
import { defaultSettings as createDefaultSettings, normalizeStandaloneSettings } from './settings.ts';
import type { OpeningController, OpeningOptions, OpeningSettings } from './types.ts';

export type { OpeningController, OpeningDestination, OpeningOptions, OpeningPhase, OpeningPoint,
  OpeningReferenceSettings, OpeningSettings, OpeningStageDurations, OpeningState, OpeningStatus } from './types.ts';
export const VERSION = '1.0.0';

export function defaultSettings(): OpeningSettings { return createDefaultSettings(); }

function assertDedicatedContainer(container: HTMLElement, requireSize: boolean): void {
  if (typeof HTMLElement === 'undefined' || !(container instanceof HTMLElement)
    || container.ownerDocument !== document) throw new TypeError('开场动画需要当前页面中的 HTMLElement 容器。');
  if (container.childElementCount > 0 || container.textContent?.trim()) throw new TypeError('开场动画需要专用的空容器，请将业务内容放在另一个容器中。');
  const bounds = container.getBoundingClientRect();
  if (requireSize && (bounds.width <= 0 || bounds.height <= 0)) throw new TypeError('开场容器需要明确且大于零的宽度和高度。');
}

/** 在专用容器内播放独立开场；完成后的业务切换交给 onComplete。 */
export function createOpening(container: HTMLElement, options: OpeningOptions = {}): OpeningController {
  assertDedicatedContainer(container, true);
  const settings = normalizeStandaloneSettings(options.settings);
  const total = settings.reference.stageDurations.reduce((sum, value) => sum + value, 0);
  const reduced = settings.motionPreference === 'reduced'
    || (settings.motionPreference === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const initialElapsedSeconds = reduced ? total - Math.min(.8, settings.reference.stageDurations[8] * .25) : 0;
  let intersectsViewport = typeof IntersectionObserver === 'undefined';
  const containerVisible = (): boolean => {
    const bounds = container.getBoundingClientRect();
    if (!intersectsViewport || bounds.width <= 0 || bounds.height <= 0 || bounds.right <= 0 || bounds.bottom <= 0
      || bounds.left >= window.innerWidth || bounds.top >= window.innerHeight) return false;
    for (let element: HTMLElement | null = container; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0'
        || style.contentVisibility === 'hidden') return false;
    }
    return true;
  };
  return createOpeningController(options, {
    totalDurationSeconds: total, initialElapsedSeconds, allowSkip: settings.allowSkip,
    now: () => performance.now(), getFrame: seconds => getReferenceOpeningFrame(seconds, settings.reference),
    requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
    setTimer: (callback, milliseconds) => window.setTimeout(callback, milliseconds), clearTimer: id => window.clearTimeout(id),
    isDocumentVisible: () => !document.hidden, isContainerVisible: containerVisible,
    subscribeVisibility: listener => {
      document.addEventListener('visibilitychange', listener);
      window.addEventListener('resize', listener);
      const needsScrollFallback = typeof IntersectionObserver === 'undefined';
      if (needsScrollFallback) window.addEventListener('scroll', listener, true);
      const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(listener);
      const intersection = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
        intersectsViewport = entries.some(entry => entry.target === container && entry.isIntersecting
          && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0);
        listener();
      });
      const mutation = typeof MutationObserver === 'undefined' ? null : new MutationObserver(listener);
      resize?.observe(container); intersection?.observe(container);
      for (let element: HTMLElement | null = container; element; element = element.parentElement) {
        mutation?.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
      }
      const transitionEnd = (event: Event): void => {
        if (event.target instanceof Element && event.target.contains(container)) listener();
      };
      document.addEventListener('transitionend', transitionEnd, true);
      document.addEventListener('animationend', transitionEnd, true);
      return () => {
        document.removeEventListener('visibilitychange', listener); window.removeEventListener('resize', listener);
        if (needsScrollFallback) window.removeEventListener('scroll', listener, true);
        document.removeEventListener('transitionend', transitionEnd, true); document.removeEventListener('animationend', transitionEnd, true);
        resize?.disconnect(); intersection?.disconnect(); mutation?.disconnect();
      };
    },
    createRuntime: actions => {
      assertDedicatedContainer(container, false);
      const mount = document.createElement('div');
      mount.className = 'zending-opening-root';
      Object.assign(mount.style, { position: 'relative', width: '100%', height: '100%', overflow: 'hidden' });
      const stage = document.createElement('div');
      Object.assign(stage.style, { position: 'relative', width: '100%', height: '100%' });
      mount.appendChild(stage); container.appendChild(mount);
      try {
        const renderer = createReferenceOpening(stage, { settings, ...actions });
        renderer.element.style.minHeight = '0';
        return {
          ready: renderer.ready,
          render: (seconds, paused) => {
            const frame = getReferenceOpeningFrame(seconds, settings.reference);
            renderer.renderAt(frame.referenceSeconds, { elapsedSeconds: seconds, totalDurationSeconds: total,
              isPaused: paused, opacity: frame.opacity, stageIndex: frame.stageIndex });
          },
          dispose: () => { try { renderer.dispose(); } finally { mount.remove(); } },
        };
      } catch (error) { mount.remove(); throw error; }
    },
  });
}
