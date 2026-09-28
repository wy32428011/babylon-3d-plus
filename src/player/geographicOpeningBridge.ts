import { parseDigitalTwinBridgeMessage } from './digitalTwinInteractionProtocol.ts';

export type GeographicOpeningPhase = 'disabled' | 'waiting' | 'playing' | 'handoff' | 'completed' | 'skipped' | 'failed';
type OpeningMessage = { channel: 'zending.opening.v1'; version: 1; sessionId: string } & (
  | { type: 'host.visible' }
  | { type: 'host.visibility'; visible: boolean }
  | { type: 'viewer.state'; phase: GeographicOpeningPhase }
);
type MessageEventLike = { data: unknown; source: unknown; origin: string };

export type GeographicOpeningBridgeOptions = {
  enabled: boolean;
  embedded: boolean;
  parentWindow: unknown;
  viewerOrigin: string;
  allowedParentOrigins?: readonly string[];
  subscribeToMessages: (listener: (event: MessageEventLike) => void) => () => void;
  postToParent: (message: OpeningMessage, targetOrigin: string) => void;
  timeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

/** 独立可选通道不向旧版 viewer.ready 添加 capability，避免旧宿主拒绝整个握手。 */
export class GeographicOpeningBridge {
  private readonly options: GeographicOpeningBridgeOptions;
  private readonly unsubscribe: () => void;
  private readonly setTimer: NonNullable<GeographicOpeningBridgeOptions['setTimer']>;
  private readonly clearTimer: NonNullable<GeographicOpeningBridgeOptions['clearTimer']>;
  private phase: GeographicOpeningPhase;
  private sessionId: string | null = null;
  private parentOrigin: string | null = null;
  private disposed = false;
  private pending: Promise<boolean> | null = null;
  private finishWait: ((visible: boolean) => void) | null = null;
  private legacyHostTimer: unknown | null = null;
  private legacyHostTimerGeneration = 0;
  private hostVisibilitySupported = false;
  private hostVisible = false;
  private readonly visibilityListeners = new Set<() => void>();

  constructor(options: GeographicOpeningBridgeOptions) {
    this.options = options;
    this.phase = options.enabled ? 'waiting' : 'disabled';
    this.setTimer = options.setTimer ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? (timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.unsubscribe = options.subscribeToMessages(this.handleMessage);
  }

  setPhase(phase: GeographicOpeningPhase): void {
    if (this.disposed || this.phase === phase) return;
    this.phase = phase;
    this.postState();
    if (phase === 'disabled' || phase === 'completed' || phase === 'skipped' || phase === 'failed') this.finishWait?.(false);
  }

  isHostVisible = (): boolean => !this.options.embedded || this.hostVisible;

  subscribeVisibility = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.visibilityListeners.add(listener);
    return () => { this.visibilityListeners.delete(listener); };
  };

  /** 旧宿主有界降级；新宿主明确上报隐藏时仅等待可见事件，避免后台加载消耗首播。 */
  waitForHostVisible(signal?: AbortSignal): Promise<boolean> {
    if (this.disposed || signal?.aborted || this.phase !== 'waiting') return Promise.resolve(false);
    if (!this.options.embedded) return Promise.resolve(true);
    if (this.pending) return this.pending;
    if (this.hostVisibilitySupported && this.hostVisible) return Promise.resolve(true);
    const pending = new Promise<boolean>(resolve => {
      const finish = (visible: boolean): void => {
        if (this.finishWait !== finish) return;
        this.finishWait = null;
        this.pending = null;
        this.clearLegacyHostTimer();
        signal?.removeEventListener('abort', abort);
        if (!visible && this.phase === 'waiting') { this.phase = 'skipped'; this.postState(); }
        resolve(visible);
      };
      const abort = (): void => finish(false);
      this.finishWait = finish;
      signal?.addEventListener('abort', abort, { once: true });
    });
    this.pending = pending;
    this.armLegacyHostTimer();
    this.postState();
    return pending;
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.phase === 'waiting' || this.phase === 'playing' || this.phase === 'handoff') this.setPhase('skipped');
    this.finishWait?.(false);
    this.disposed = true;
    this.unsubscribe();
    this.visibilityListeners.clear();
  }

  private readonly handleMessage = (event: MessageEventLike): void => {
    if (this.disposed || !this.options.embedded || event.source !== this.options.parentWindow) return;
    const allowed = this.options.allowedParentOrigins ?? [];
    if (event.origin !== this.options.viewerOrigin && !allowed.includes(event.origin) && !allowed.includes('*')) return;
    const hello = parseDigitalTwinBridgeMessage(event.data);
    if (hello?.type === 'host.hello') {
      if (this.sessionId !== hello.sessionId || this.parentOrigin !== event.origin) {
        this.hostVisibilitySupported = false;
        this.updateHostVisible(false);
        this.clearLegacyHostTimer();
      }
      this.sessionId = hello.sessionId;
      this.parentOrigin = event.origin;
      this.armLegacyHostTimer();
      this.postState();
      return;
    }
    const message = event.data as Partial<OpeningMessage> | null;
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || message.channel !== 'zending.opening.v1' || message.version !== 1
      || !this.sessionId || message.sessionId !== this.sessionId || event.origin !== this.parentOrigin) return;
    if (message.type === 'host.visibility' && Object.keys(message).length === 5 && typeof message.visible === 'boolean') {
      this.hostVisibilitySupported = true;
      this.clearLegacyHostTimer();
      this.updateHostVisible(message.visible);
      if (message.visible) this.finishWait?.(true);
    } else if (message.type === 'host.visible' && Object.keys(message).length === 4 && !this.hostVisibilitySupported) {
      this.updateHostVisible(true);
      this.finishWait?.(true);
    }
  };

  private updateHostVisible(visible: boolean): void {
    if (this.hostVisible === visible) return;
    this.hostVisible = visible;
    for (const listener of [...this.visibilityListeners]) listener();
  }

  private clearLegacyHostTimer(): void {
    this.legacyHostTimerGeneration += 1;
    if (this.legacyHostTimer === null) return;
    this.clearTimer(this.legacyHostTimer);
    this.legacyHostTimer = null;
  }

  private armLegacyHostTimer(): void {
    if (!this.finishWait || this.hostVisibilitySupported || this.legacyHostTimer !== null) return;
    const finish = this.finishWait;
    const generation = ++this.legacyHostTimerGeneration;
    const timeoutMs = this.options.timeoutMs ?? 2_500;
    this.legacyHostTimer = this.setTimer(() => {
      if (generation === this.legacyHostTimerGeneration && !this.hostVisibilitySupported && this.finishWait === finish) finish(false);
    }, Number.isFinite(timeoutMs) ? Math.max(1, Math.min(10_000, timeoutMs)) : 2_500);
  }

  private postState(): void {
    if (!this.sessionId || !this.parentOrigin || this.disposed) return;
    this.options.postToParent({ channel: 'zending.opening.v1', version: 1, sessionId: this.sessionId, type: 'viewer.state', phase: this.phase }, this.parentOrigin);
  }
}
