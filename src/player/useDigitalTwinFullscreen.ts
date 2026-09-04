import { useCallback, useEffect, useMemo, useState } from 'react';

import { useElementFullscreen } from '../shared/ui/useElementFullscreen';
import {
  createDigitalTwinHostFullscreenRequest,
  parseDigitalTwinHostFullscreenState,
} from './digitalTwinFullscreenBridge';

export type DigitalTwinFullscreenControls = {
  isEmbedded: boolean;
  isFullscreen: boolean;
  toggle: () => Promise<void>;
};

/**
 * 独立 Viewer 全屏自身；内嵌 Viewer 把请求交给宿主，避免 iframe 全屏遮掉大屏其它组件。
 */
export function useDigitalTwinFullscreen(
  elementRef: { current: HTMLElement | null },
): DigitalTwinFullscreenControls {
  const nativeFullscreen = useElementFullscreen(elementRef);
  const isEmbedded = typeof window !== 'undefined' && window.parent !== window;
  const [hostFullscreen, setHostFullscreen] = useState(false);

  useEffect(() => {
    if (!isEmbedded) return undefined;
    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== window.parent) return;
      const state = parseDigitalTwinHostFullscreenState(event.data);
      if (state) setHostFullscreen(state.fullscreen);
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isEmbedded]);

  const toggle = useCallback(async (): Promise<void> => {
    if (!isEmbedded) {
      await nativeFullscreen.toggle();
      return;
    }
    window.parent.postMessage(createDigitalTwinHostFullscreenRequest(), '*');
  }, [isEmbedded, nativeFullscreen.toggle]);

  return useMemo(() => ({
    isEmbedded,
    isFullscreen: isEmbedded ? hostFullscreen : nativeFullscreen.isFullscreen,
    toggle,
  }), [hostFullscreen, isEmbedded, nativeFullscreen.isFullscreen, toggle]);
}
