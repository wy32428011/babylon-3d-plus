export type OpeningPoint = { x: number; y: number };
export type OpeningDestination = OpeningPoint & { name: string };
export type OpeningStageDurations = [number, number, number, number, number, number, number, number, number];

/** 开场专用配置，与业务页面或数字孪生场景格式无关。 */
export type OpeningReferenceSettings = {
  brandName: string;
  companyName: string;
  heroTitle: string;
  heroSubtitle: string;
  finaleTitle: string;
  quality: 'high' | 'low';
  showUI: boolean;
  stageDurations: OpeningStageDurations;
  worldOrigin: OpeningPoint;
  chinaOrigin: OpeningPoint;
  worldDestinations: OpeningDestination[];
  chinaDestinations: OpeningDestination[];
};

export type OpeningSettings = {
  reference: OpeningReferenceSettings;
  allowSkip: boolean;
  breathingEnabled: boolean;
  breathingIntensity: number;
  breathingPeriodSeconds: number;
  motionPreference: 'normal' | 'reduced' | 'system';
};

export type OpeningStatus = 'loading' | 'ready' | 'playing' | 'paused' | 'completed' | 'skipped' | 'failed' | 'destroyed';
export type OpeningPhase = 'playing' | 'globe' | 'unfold' | 'routes' | 'china' | 'jiangsu-highlight' | 'china-routes'
  | 'jiangsu' | 'wuxi' | 'huishan' | 'handoff' | 'complete';
export type OpeningState = {
  status: OpeningStatus;
  phase: OpeningPhase;
  elapsedSeconds: number;
  totalDurationSeconds: number;
  progress: number;
  stageIndex: number;
  isPaused: boolean;
  hostVisible: boolean;
  documentVisible: boolean;
  error: string | null;
};

export type OpeningOptions = {
  settings?: Partial<Omit<OpeningSettings, 'reference'>> & { reference?: Partial<OpeningReferenceSettings> };
  autoplay?: boolean;
  hostVisible?: boolean;
  onProgress?: (state: OpeningState) => void;
  onComplete?: (event: { reason: 'completed' | 'skipped' }) => void;
  onError?: (error: Error) => void;
};

export type OpeningController = {
  /** 本轮素材与首帧准备完成；restart 后返回新一轮 Promise。取消准备会以 AbortError 拒绝。 */
  readonly ready: Promise<void>;
  play(): void;
  pause(): void;
  resume(): void;
  skip(): void;
  seek(seconds: number): void;
  restart(): void;
  setHostVisible(visible: boolean): void;
  getState(): OpeningState;
  destroy(): void;
};
