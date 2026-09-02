import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  exitElementFullscreen,
  getFullscreenElement,
  isElementFullscreen,
  isOwnedFullscreenElement,
  requestElementFullscreen,
  subscribeFullscreenChange,
} from './elementFullscreen';

export type ElementFullscreenControls = {
  /** 当前是否处于场景全屏（含系统全屏失败后的窗口内最大化）。 */
  isFullscreen: boolean;
  /** 进入系统全屏；失败时仍保持窗口内最大化。 */
  enter: () => Promise<void>;
  /** 退出系统全屏并取消窗口内最大化。 */
  exit: () => Promise<void>;
  /** 按当前状态切换全屏。 */
  toggle: () => Promise<void>;
};

export type UseElementFullscreenOptions = {
  /**
   * 系统全屏被拒绝时是否仍保持 isFullscreen。
   * 编辑器用它做窗口内最大化；Viewer 已铺满窗口，失败时应回到未按下状态。
   */
  fallbackToLayoutMaximize?: boolean;
};

/**
 * 把指定元素接到系统 Fullscreen API。
 * 浏览器拒绝系统全屏时，仅在 fallbackToLayoutMaximize 时保持 isFullscreen。
 */
export function useElementFullscreen(
  elementRef: { current: HTMLElement | null },
  options: UseElementFullscreenOptions = {},
): ElementFullscreenControls {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fallbackToLayoutMaximize = options.fallbackToLayoutMaximize === true;
  /** 系统全屏被拒绝后仍要保持窗口内最大化，直到用户显式退出。 */
  const layoutMaximizeRef = useRef(false);
  /** 记录是否曾经拿到系统全屏，便于 Esc 退出时连布局最大化一起关掉。 */
  const hadNativeFullscreenRef = useRef(false);
  /** 丢弃过期的 requestFullscreen，避免 exit 之后又被迟到的成功回调拉回去。 */
  const fullscreenGenerationRef = useRef(0);
  const isFullscreenRef = useRef(false);

  /** 同步 React state 与即时 ref，供连续按键在重渲染前读取。 */
  const setFullscreenState = (next: boolean): void => {
    isFullscreenRef.current = next;
    setIsFullscreen(next);
  };

  useEffect(() => {
    const syncFromDocument = (): void => {
      const element = elementRef.current;
      if (isElementFullscreen(element)) {
        hadNativeFullscreenRef.current = true;
        setFullscreenState(true);
        return;
      }
      if (hadNativeFullscreenRef.current && !getFullscreenElement()) {
        hadNativeFullscreenRef.current = false;
        layoutMaximizeRef.current = false;
        setFullscreenState(false);
        return;
      }
      if (layoutMaximizeRef.current && fallbackToLayoutMaximize && !getFullscreenElement()) {
        setFullscreenState(true);
        return;
      }
      if (!getFullscreenElement()) {
        setFullscreenState(false);
      }
    };

    syncFromDocument();
    return subscribeFullscreenChange(syncFromDocument);
  }, [elementRef, fallbackToLayoutMaximize]);

  useEffect(() => {
    const element = elementRef.current;
    return () => {
      fullscreenGenerationRef.current += 1;
      layoutMaximizeRef.current = false;
      hadNativeFullscreenRef.current = false;
      isFullscreenRef.current = false;
      if (isOwnedFullscreenElement(element)) {
        void exitElementFullscreen(element);
      }
    };
  }, [elementRef]);

  const enter = useCallback(async (): Promise<void> => {
    const element = elementRef.current;
    if (!element) return;
    const generation = fullscreenGenerationRef.current + 1;
    fullscreenGenerationRef.current = generation;
    if (fallbackToLayoutMaximize) {
      layoutMaximizeRef.current = true;
    }
    setFullscreenState(true);
    try {
      await requestElementFullscreen(element);
      if (generation !== fullscreenGenerationRef.current) return;
      if (isElementFullscreen(element)) {
        hadNativeFullscreenRef.current = true;
        return;
      }
      if (!fallbackToLayoutMaximize) {
        layoutMaximizeRef.current = false;
        setFullscreenState(false);
      }
    } catch {
      if (generation !== fullscreenGenerationRef.current) return;
      if (!fallbackToLayoutMaximize) {
        layoutMaximizeRef.current = false;
        setFullscreenState(false);
      }
    }
  }, [elementRef, fallbackToLayoutMaximize]);

  const exit = useCallback(async (): Promise<void> => {
    fullscreenGenerationRef.current += 1;
    layoutMaximizeRef.current = false;
    hadNativeFullscreenRef.current = false;
    setFullscreenState(false);
    try {
      await exitElementFullscreen(elementRef.current);
    } catch {
      // 已经不在系统全屏时忽略，避免打断退出布局最大化。
    }
  }, [elementRef]);

  const toggle = useCallback(async (): Promise<void> => {
    if (isFullscreenRef.current || layoutMaximizeRef.current || isElementFullscreen(elementRef.current)) {
      await exit();
      return;
    }
    await enter();
  }, [elementRef, enter, exit]);

  return useMemo(
    () => ({ isFullscreen, enter, exit, toggle }),
    [enter, exit, isFullscreen, toggle],
  );
}
