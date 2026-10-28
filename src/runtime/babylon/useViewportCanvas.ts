import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

type PendingCanvas = {
  previous: HTMLCanvasElement;
  resolve: (canvas: HTMLCanvasElement) => void;
  reject: (error: unknown) => void;
};

/** React 自己更换已取得 context 的 canvas；回退只重试引擎创建，不重跑业务启动。 */
export function useViewportCanvas(canvasRef: MutableRefObject<HTMLCanvasElement | null>) {
  const [revision, setRevision] = useState(0);
  const pendingRef = useRef<PendingCanvas | null>(null);
  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    const pending = pendingRef.current;
    if (canvas && pending && canvas !== pending.previous) pending.resolve(canvas);
  }, [canvasRef]);
  const replaceCanvas = useCallback((previous: HTMLCanvasElement, signal: AbortSignal): Promise<HTMLCanvasElement> => {
    signal.throwIfAborted();
    const current = canvasRef.current;
    if (current && current !== previous) return Promise.resolve(current);
    if (pendingRef.current) return Promise.reject(new Error('视口画布正在更换，不能并发重试。'));
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener('abort', abort);
        if (pendingRef.current === pending) pendingRef.current = null;
      };
      const pending: PendingCanvas = {
        previous,
        resolve: canvas => { finish(); resolve(canvas); },
        reject: error => { finish(); reject(error); },
      };
      const abort = () => pending.reject(signal.reason);
      pendingRef.current = pending;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else setRevision(value => value + 1);
    });
  }, [canvasRef]);
  useEffect(() => () => {
    pendingRef.current?.reject(new DOMException('视口已卸载。', 'AbortError'));
  }, []);
  return { revision, attachCanvas, replaceCanvas };
}
