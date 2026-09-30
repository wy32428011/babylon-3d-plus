import { useCallback, useEffect, useRef, useState } from 'react';
import type { SceneDocument } from '../model/SceneDocument';
import { resolvePackageOpeningSettings } from '../model/sceneOpeningAnimation';
import { isOpeningPackageInstalled } from '../../shared/opening/openingPackage';
import { useEditorStore } from '../store/editorStore';
import type { BabylonViewport } from '../../runtime/babylon/createEngine';
import type { OpeningSnapshot } from '../../runtime/opening/GeographicOpeningRuntime';
import { createSceneOpeningPlayback } from '../../shared/opening/createSceneOpeningPlayback';
import type { OpeningPlaybackCoordinator } from '../../shared/opening/OpeningPlaybackCoordinator';

export function useEditorOpeningAnimation(options: {
  viewport: BabylonViewport | null; ready: boolean;
  sceneDocument: SceneDocument; sceneSessionId: string; isRuntimePreview: boolean;
}) {
  const { viewport, ready, sceneDocument, sceneSessionId, isRuntimePreview } = options;
  const settings = resolvePackageOpeningSettings(sceneDocument.sceneSettings.openingAnimation);
  const request = useEditorStore(state => state.openingAnimationPreviewRequest);
  const playback = useRef<OpeningPlaybackCoordinator | null>(null);
  const previewHost = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState(false);
  const [snapshot, setSnapshot] = useState<OpeningSnapshot | null>(null);
  const [settled, setSettled] = useState(false);
  const played = useRef(false), mounted = useRef(true), generation = useRef(0);
  const latest = useRef(options); latest.current = options;
  const stop = useCallback(() => {
    generation.current++; playback.current?.dispose(); playback.current = null;
    previewHost.current?.remove(); previewHost.current = null;
    if (mounted.current) setSettled(true);
  }, []);
  const skip = useCallback(() => playback.current?.skip(), []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stop(); }; }, [stop]);
  useEffect(() => { stop(); played.current = false; setActive(false); setSnapshot(null); setSettled(false); }, [sceneSessionId, isRuntimePreview, stop]);
  useEffect(() => { stop(); setActive(false); setSnapshot(null); setSettled(false); }, [sceneDocument.sceneSettings.openingAnimation, stop]);

  const start = useCallback(async (preview: boolean) => {
    const current = latest.current;
    const config = resolvePackageOpeningSettings(current.sceneDocument.sceneSettings.openingAnimation);
    if (config.template !== 'package' || !config.package) { if (mounted.current) setSettled(true); return; }
    if (!preview && (!current.ready || !config.enabled)) return;
    stop(); if (mounted.current) setSettled(false); const token = generation.current;
    const failure = (error: unknown) => {
      console.warn('[编辑器开场动画]', error);
      useEditorStore.getState().pushLog('开场未播放，三维场景继续运行：' + (error instanceof Error ? error.message : String(error)));
    };
    try {
      // 桌面预览必须确认固定版本已导入，不能只凭场景中的定义快照冒充资源可用。
      if (window.editorApi?.listOpeningPackages) {
        const inventory = await window.editorApi.listOpeningPackages();
        if (!isOpeningPackageInstalled(config.package, inventory.packages)) throw new Error('当前开场包未导入或不可用，请重新导入所需版本。');
      }
      if (!mounted.current || token !== generation.current) return;
      let container = current.viewport?.engine.getRenderingCanvas()?.parentElement;
      if (preview) {
        // 编辑态只打开独立预览层，不读取或恢复业务相机，不暂停业务播放器。
        const host = document.createElement('div'); host.className = 'opening-editor-preview';
        host.setAttribute('role', 'dialog'); host.setAttribute('aria-label', '开场包独立预览');
        Object.assign(host.style, { position: 'fixed', inset: '8vh 8vw', zIndex: '10000', background: '#020815', border: '1px solid #579ac0', borderRadius: '8px', overflow: 'hidden' });
        const close = document.createElement('button'); close.textContent = '关闭开场预览 · Esc';
        Object.assign(close.style, { position: 'absolute', zIndex: '100', top: '8px', right: '8px' });
        close.onclick = stop; host.appendChild(close); document.body.appendChild(host); previewHost.current = host; container = host;
      }
      if (!container) throw new Error('开场展示容器尚未就绪。');
      const instance = createSceneOpeningPlayback({ container, settings: { ...config, enabled: true },
        onActiveChange: value => { if (mounted.current) setActive(value); },
        onProgress: value => { if (mounted.current) setSnapshot(value); },
        onTerminal: () => {
          if (mounted.current) { setActive(false); setSnapshot(null); setSettled(true); }
          previewHost.current?.remove(); previewHost.current = null;
        }, onError: failure });
      playback.current = instance; void instance.start();
    } catch (error) { if (token === generation.current) { stop(); failure(error); } }
  }, [stop]);
  useEffect(() => {
    if (!request || request.sceneSessionId !== sceneSessionId) return;
    useEditorStore.getState().consumeOpeningAnimationPreviewRequest(request.requestId, request.sceneSessionId);
    if (request.action === 'stop') stop(); else if (!isRuntimePreview) void start(true);
  }, [request, sceneSessionId, isRuntimePreview, start, stop]);
  useEffect(() => {
    if (!isRuntimePreview || !ready || !viewport || played.current || !settings.enabled) return;
    played.current = true; void start(false);
  }, [isRuntimePreview, ready, viewport, settings.enabled, start]);
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!isRuntimePreview) stop(); else if (settings.allowSkip) skip();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [active, isRuntimePreview, settings.allowSkip, stop, skip]);
  return { active, snapshot, settings, stop, skip, settled: !settings.enabled || settled };
}
