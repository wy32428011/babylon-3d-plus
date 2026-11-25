import {
  APP_UPDATE_UNSUPPORTED_MESSAGE,
  createInitialAppUpdateState,
  formatAppUpdateErrorMessage,
  normalizeReleaseNotes,
  type AppUpdateState,
  type CheckForAppUpdateRequest,
} from './appUpdate.ts';

export interface AutoUpdaterInfoLike {
  version?: string;
  releaseName?: string | null;
  releaseDate?: string;
  releaseNotes?: unknown;
}

export interface AutoUpdaterProgressLike {
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available', listener: (info: AutoUpdaterInfoLike) => void): unknown;
  on(event: 'update-not-available', listener: (info: AutoUpdaterInfoLike) => void): unknown;
  on(event: 'download-progress', listener: (progress: AutoUpdaterProgressLike) => void): unknown;
  on(event: 'update-downloaded', listener: (info: AutoUpdaterInfoLike) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface AppUpdateControllerOptions {
  isPackaged: boolean;
  currentVersion: string;
  getUpdater: () => AutoUpdaterLike;
  broadcast: (state: AppUpdateState) => void;
  approveWindowClose: () => void;
  now?: () => string;
}

export interface AppUpdateController {
  getState: () => AppUpdateState;
  checkForUpdates: (request?: CheckForAppUpdateRequest) => Promise<AppUpdateState>;
  downloadUpdate: () => Promise<AppUpdateState>;
  quitAndInstall: () => Promise<boolean>;
}

/** 创建可测试的应用自动更新状态机与控制器（无 Electron 运行时硬依赖）。 */
export function createAppUpdateController(options: AppUpdateControllerOptions): AppUpdateController {
  const now = options.now ?? (() => new Date().toISOString());
  let state: AppUpdateState = createInitialAppUpdateState(options.currentVersion, options.isPackaged);
  let updaterBound = false;
  let activeUpdater: AutoUpdaterLike | null = null;
  let inFlightCheck: Promise<AppUpdateState> | null = null;
  let inFlightDownload: Promise<AppUpdateState> | null = null;

  const setState = (patch: Partial<AppUpdateState>): AppUpdateState => {
    state = { ...state, ...patch };
    options.broadcast(state);
    return state;
  };

  const ensureUpdater = (): AutoUpdaterLike => {
    if (activeUpdater) return activeUpdater;
    const updater = options.getUpdater();
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    if (!updaterBound) {
      updaterBound = true;
      updater.on('checking-for-update', () => {
        setState({
          stage: 'checking',
          errorMessage: null,
          progress: null,
        });
      });
      updater.on('update-available', (info) => {
        setState({
          stage: 'available',
          availableVersion: info?.version ?? null,
          releaseName: typeof info?.releaseName === 'string' && info.releaseName.trim() ? info.releaseName.trim() : null,
          releaseDate: typeof info?.releaseDate === 'string' && info.releaseDate.trim() ? info.releaseDate.trim() : null,
          releaseNotes: normalizeReleaseNotes(info?.releaseNotes),
          progress: null,
          errorMessage: null,
          checkedAt: now(),
        });
      });
      updater.on('update-not-available', () => {
        setState({
          stage: 'not-available',
          availableVersion: null,
          releaseName: null,
          releaseDate: null,
          releaseNotes: null,
          progress: null,
          errorMessage: null,
          checkedAt: now(),
        });
      });
      updater.on('download-progress', (progress) => {
        setState({
          stage: 'downloading',
          progress: {
            percent: Math.max(0, Math.min(100, Number(progress?.percent ?? 0))),
            transferred: Math.max(0, Number(progress?.transferred ?? 0)),
            total: Math.max(0, Number(progress?.total ?? 0)),
            bytesPerSecond: Math.max(0, Number(progress?.bytesPerSecond ?? 0)),
          },
          errorMessage: null,
        });
      });
      updater.on('update-downloaded', (info) => {
        setState({
          stage: 'downloaded',
          availableVersion: info?.version ?? state.availableVersion,
          releaseName: typeof info?.releaseName === 'string' && info.releaseName.trim() ? info.releaseName.trim() : state.releaseName,
          releaseDate: typeof info?.releaseDate === 'string' && info.releaseDate.trim() ? info.releaseDate.trim() : state.releaseDate,
          releaseNotes: normalizeReleaseNotes(info?.releaseNotes) ?? state.releaseNotes,
          progress: state.progress
            ? { ...state.progress, percent: 100, transferred: state.progress.total || state.progress.transferred }
            : { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
          errorMessage: null,
        });
      });
      updater.on('error', (error) => {
        setState({
          stage: 'error',
          progress: null,
          errorMessage: formatAppUpdateErrorMessage(error),
          checkedAt: now(),
        });
      });
    }
    activeUpdater = updater;
    return updater;
  };

  return {
    getState: () => state,

    async checkForUpdates(request?: CheckForAppUpdateRequest): Promise<AppUpdateState> {
      const manual = Boolean(request?.manual);
      if (!options.isPackaged) {
        return setState({
          stage: 'unsupported',
          manual,
          errorMessage: APP_UPDATE_UNSUPPORTED_MESSAGE,
          checkedAt: now(),
        });
      }
      if (state.stage === 'downloading' || state.stage === 'downloaded') {
        return setState({ manual: state.manual || manual });
      }
      if (inFlightCheck) {
        if (manual && !state.manual) setState({ manual: true });
        return inFlightCheck;
      }

      const updater = ensureUpdater();
      setState({
        stage: 'checking',
        manual,
        errorMessage: null,
        progress: null,
      });

      const task = (async () => {
        try {
          await updater.checkForUpdates();
          return state;
        } catch (error) {
          return setState({
            stage: 'error',
            progress: null,
            errorMessage: formatAppUpdateErrorMessage(error),
            checkedAt: now(),
          });
        } finally {
          inFlightCheck = null;
        }
      })();

      inFlightCheck = task;
      return task;
    },

    async downloadUpdate(): Promise<AppUpdateState> {
      if (!options.isPackaged) {
        return setState({
          stage: 'unsupported',
          manual: true,
          errorMessage: APP_UPDATE_UNSUPPORTED_MESSAGE,
        });
      }
      if (state.stage === 'downloaded') return state;
      if (inFlightDownload) return inFlightDownload;
      if (state.stage !== 'available' && state.stage !== 'error') return state;

      const updater = ensureUpdater();
      setState({
        stage: 'downloading',
        manual: true,
        errorMessage: null,
        progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      });

      const task = (async () => {
        try {
          await updater.downloadUpdate();
          return state;
        } catch (error) {
          return setState({
            stage: 'error',
            progress: null,
            errorMessage: formatAppUpdateErrorMessage(error),
          });
        } finally {
          inFlightDownload = null;
        }
      })();

      inFlightDownload = task;
      return task;
    },

    async quitAndInstall(): Promise<boolean> {
      if (!options.isPackaged || state.stage !== 'downloaded') return false;
      const updater = ensureUpdater();
      options.approveWindowClose();
      updater.quitAndInstall(false, true);
      return true;
    },
  };
}
