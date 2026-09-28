import { DigitalTwinIframeBridgeController } from '@opening-host/bridge';
import { buildRuntimeInitialLoadStateMap, shouldShowBigscreenComponents } from '@opening-host/visibility';

const query = new URLSearchParams(location.search);
const legacyHost = query.get('mode') === 'legacy-host';
const iframe = document.querySelector<HTMLIFrameElement>('#viewer')!;
const panel = document.querySelector<HTMLElement>('#business-panel')!;
const mask = document.querySelector<HTMLElement>('#host-mask')!;
const status = document.querySelector<HTMLElement>('#state')!;
const viewerUrl = new URL(query.get('viewer') || '/published-viewer/', location.href);
const events: Array<Record<string, unknown>> = [];
let state: ReturnType<DigitalTwinIframeBridgeController['getState']> = { phase: 'loading' };
const widgets = [{ id: 'runtime', type: 'BABYLON_RUNTIME' }, { id: 'panel', type: 'TEXT' }] as never;
const record = (entry: Record<string, unknown>) => { events.push({ at: performance.now(), ...entry }); };
const controller = new DigitalTwinIframeBridgeController({
  runtimeWidgetId: 'runtime',
  subscribeToMessages: listener => {
    const handle = (event: MessageEvent) => {
      if (event.source === iframe.contentWindow && event.origin === viewerUrl.origin) {
        if (event.data?.channel === 'zending.opening.v1') record({ kind: 'opening-message', ...event.data });
      }
      if (legacyHost && event.data?.channel === 'zending.opening.v1') return;
      listener({ data: event.data, origin: event.origin, source: event.source });
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  },
  postToFrame: (target, message, origin) => (target as Window).postMessage(message, origin),
  postOpeningToFrame: legacyHost ? undefined : (target, message, origin) => {
    record({ kind: 'host-message', ...message });
    (target as Window).postMessage(message, origin);
  },
  isOpeningPresentationVisible: () => document.visibilityState !== 'hidden'
    && getComputedStyle(iframe).visibility === 'visible' && iframe.getBoundingClientRect().width > 0,
});

controller.subscribe(event => {
  if (event.type !== 'state') return;
  state = event.state;
  iframe.style.visibility = state.phase === 'viewerReady' ? 'visible' : 'hidden';
  mask.hidden = state.phase === 'viewerReady';
  panel.hidden = !shouldShowBigscreenComponents(widgets, buildRuntimeInitialLoadStateMap({ runtime: state }));
  status.textContent = JSON.stringify(state);
  record({ kind: 'state', state: structuredClone(state), iframeVisible: getComputedStyle(iframe).visibility === 'visible', panelVisible: !panel.hidden });
  if (state.phase === 'viewerReady' && !legacyHost) {
    requestAnimationFrame(() => requestAnimationFrame(() => controller.markOpeningPresentationVisible()));
  }
});
controller.configureTarget({ origin: viewerUrl.origin, getContentWindow: () => iframe.contentWindow });
iframe.addEventListener('load', () => controller.handleIframeLoad());
iframe.src = viewerUrl.href;

Object.assign(window, { __openingHost: {
  getState: () => ({ state, iframeVisible: getComputedStyle(iframe).visibility === 'visible', panelVisible: !panel.hidden, events: [...events] }),
  dispose: () => controller.dispose(),
} });
window.addEventListener('beforeunload', () => controller.dispose(), { once: true });
