import { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { DigitalTwinInspectionController } from '../player/DigitalTwinInteractionController';
import type { DigitalTwinInspectionIdentity } from '../player/digitalTwinInteractionProtocol';
import { InspectionDetailView, type InspectionDetailPart } from './InspectionDetailView';
import { toDetailParts } from './inspectionParts';
import { initializeInspectionRuntime, type InspectionRuntimeContext } from './inspectionRuntime';
import { createInspectionViewer, type InspectionViewerController } from './inspectionViewer';
import { prepareInspectionModelVersionAsset } from './inspectionModelVersionAsset';
import './inspectionPage.css';

type ViewState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  assetCode: string;
  modelVersion?: string;
  parts: InspectionDetailPart[];
  selectedPartKey: string | null;
  percent: number;
  isolated: boolean;
  error?: string;
};

const emptyView: ViewState = {
  status: 'idle', assetCode: '', parts: [], selectedPartKey: null, percent: 0, isolated: false,
};

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : '设备详情操作失败。';
}

function InspectionApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<InspectionViewerController | null>(null);
  const bridgeRef = useRef<DigitalTwinInspectionController | null>(null);
  const activeRef = useRef<DigitalTwinInspectionIdentity | null>(null);
  const pendingRef = useRef<DigitalTwinInspectionIdentity | null>(null);
  const closeResourcesRef = useRef<(() => void) | null>(null);
  const isolatedRef = useRef(false);
  const [view, setView] = useState<ViewState>(emptyView);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const startup = new AbortController();
    let runtime: InspectionRuntimeContext | null = null;
    let viewer: InspectionViewerController | null = null;
    let bridge: DigitalTwinInspectionController | null = null;

    const start = async () => {
      try {
        runtime = await initializeInspectionRuntime(startup.signal);
        startup.signal.throwIfAborted();
        viewer = await createInspectionViewer(canvas, {
          signal: startup.signal,
          onSelectionChange(partKey) {
            const identity = activeRef.current;
            if (!identity) return;
            if (partKey === null && isolatedRef.current) {
              viewerRef.current?.isolateParts(null);
              isolatedRef.current = false;
            }
            setView((previous) => ({ ...previous, selectedPartKey: partKey, isolated: isolatedRef.current }));
            bridgeRef.current?.notifyPartSelected({ ...identity, partKey });
          },
          onFaulted(error) {
            if (!startup.signal.aborted) setView((previous) => ({ ...previous, status: 'error', error: displayError(error) }));
          },
        });
        if (startup.signal.aborted) {
          await viewer.dispose();
          return;
        }
        viewerRef.current = viewer;
        const context = runtime;
        const modelViewer = viewer;
        bridge = new DigitalTwinInspectionController({
          parentWindow: window.parent,
          viewerOrigin: window.location.origin,
          subscribeToMessages(listener) {
            const handle = (event: MessageEvent<unknown>) => listener({ data: event.data, origin: event.origin, source: event.source });
            window.addEventListener('message', handle);
            return () => window.removeEventListener('message', handle);
          },
          postToParent: (message, origin) => window.parent.postMessage(message, origin),
          async load(payload, signal) {
            activeRef.current = null;
            pendingRef.current = { loadId: payload.loadId, assetCode: payload.assetCode };
            isolatedRef.current = false;
            setView({ ...emptyView, status: 'loading', assetCode: payload.assetCode, modelVersion: payload.inspection.model.versionId });
            try {
              const inspection = payload.inspection;
              const parts = toDetailParts(inspection.parts);
              const sourceUrl = inspection.schemaVersion === 2
                ? context.resolveModelVersionUrl(inspection.model.fileUrl)
                : context.resolveAssetUrl(inspection.model.sourceUrl);
              const prepared = inspection.schemaVersion === 2
                ? await prepareInspectionModelVersionAsset(sourceUrl, inspection.model.fileExtension, signal)
                : null;
              try {
                signal.throwIfAborted();
                await modelViewer.loadModel(prepared?.url ?? sourceUrl, {
                  parts: inspection.parts,
                  unitScaleToMeters: inspection.model.unitScaleToMeters,
                  pluginExtension: inspection.schemaVersion === 2 ? inspection.model.fileExtension
                    : inspection.model.sourcePath.toLowerCase().endsWith('.gltf') ? '.gltf' : '.glb',
                });
              } finally {
                prepared?.dispose();
              }
              signal.throwIfAborted();
              activeRef.current = { loadId: payload.loadId, assetCode: payload.assetCode };
              pendingRef.current = null;
              setView({ status: 'ready', assetCode: payload.assetCode, modelVersion: payload.inspection.model.versionId,
                parts, selectedPartKey: null, percent: 0, isolated: false });
            } catch (error) {
              if (!signal.aborted) setView((previous) => ({ ...previous, status: 'error', error: displayError(error) }));
              throw error;
            }
          },
          selectPart(payload, signal) {
            signal.throwIfAborted();
            modelViewer.selectPart(payload.partKey);
            if (isolatedRef.current) {
              modelViewer.isolateParts(payload.partKey ? [payload.partKey] : null);
              if (!payload.partKey) isolatedRef.current = false;
            }
          },
          setProgress(payload, signal) {
            signal.throwIfAborted();
            modelViewer.setExplodePercent(payload.progress * 100);
            setView((previous) => ({ ...previous, percent: payload.progress * 100 }));
          },
          reset(_payload, signal) {
            signal.throwIfAborted();
            modelViewer.reset();
            isolatedRef.current = false;
            setView((previous) => ({ ...previous, selectedPartKey: null, percent: 0, isolated: false }));
          },
        });
        bridgeRef.current = bridge;
        bridge.setAllowedParentOrigins(context.allowedParentOrigins);
        bridge.markViewerReady();
      } catch (error) {
        if (startup.signal.aborted) {
          if (viewer) void viewer.dispose();
          runtime?.dispose();
        } else {
          setView((previous) => ({ ...previous, status: 'error', error: displayError(error) }));
        }
      }
    };
    const closeResources = () => {
      startup.abort();
      activeRef.current = null;
      pendingRef.current = null;
      bridge?.dispose();
      bridgeRef.current = null;
      viewerRef.current = null;
      if (viewer) void viewer.dispose();
      runtime?.dispose();
    };
    closeResourcesRef.current = closeResources;
    void start();
    return () => {
      closeResources();
      closeResourcesRef.current = null;
    };
  }, []);

  const perform = (action: (viewer: InspectionViewerController) => void) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    try {
      action(viewer);
    } catch (error) {
      setView((previous) => ({ ...previous, status: 'error', error: displayError(error) }));
    }
  };

  return (
    <InspectionDetailView
      canvasRef={canvasRef}
      deviceName={view.assetCode}
      assetCode={view.assetCode}
      modelVersion={view.modelVersion}
      parts={view.parts}
      selectedPartKey={view.selectedPartKey}
      percent={view.percent}
      isolated={view.isolated}
      status={view.status}
      error={view.error}
      onSelectPart={(partKey) => perform((viewer) => {
        viewer.selectPart(partKey);
        if (isolatedRef.current) {
          viewer.isolateParts(partKey ? [partKey] : null);
          if (!partKey) isolatedRef.current = false;
        }
      })}
      onChangePercent={(percent) => perform((viewer) => {
        viewer.setExplodePercent(percent);
        setView((previous) => ({ ...previous, percent }));
      })}
      onToggleIsolation={() => perform((viewer) => {
        if (!view.selectedPartKey) return;
        const isolated = !isolatedRef.current;
        viewer.isolateParts(isolated ? [view.selectedPartKey] : null);
        isolatedRef.current = isolated;
        setView((previous) => ({ ...previous, isolated }));
      })}
      onFrameAll={() => perform((viewer) => { viewer.frameAll(); })}
      onFocusPart={() => perform((viewer) => { if (view.selectedPartKey) viewer.focusPart(view.selectedPartKey); })}
      onReset={() => perform((viewer) => {
        viewer.reset();
        isolatedRef.current = false;
        setView((previous) => ({ ...previous, selectedPartKey: null, percent: 0, isolated: false }));
      })}
      onClose={() => {
        const identity = activeRef.current ?? pendingRef.current;
        if (identity) bridgeRef.current?.notifyClosed(identity);
        closeResourcesRef.current?.();
        setView(emptyView);
      }}
    />
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('未找到设备详情挂载节点 #root。');
ReactDOM.createRoot(root).render(<InspectionApp />);
