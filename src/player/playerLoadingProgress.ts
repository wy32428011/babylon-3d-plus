import type { SceneRuntimeModelLoadProgress } from '../runtime/babylon/SceneRuntime';

/** 发布 Viewer 首次场景加载的最长等待时间；超时后强制收起蒙版避免永久阻塞。 */
export const PLAYER_SCENE_LOADING_TIMEOUT_MS = 120_000;

export type PlayerLoadingProgressInput = {
  /** 当前启动阶段。 */
  phase: 'loading' | 'ready' | 'blocked';
  /** 启动阶段（配置、场景文档、引擎创建等）已完成的百分比。 */
  startupPercent: number;
  /** 场景模型/环境资源加载进度；尚无加载单元时为 null。 */
  modelLoadProgress: Pick<
    SceneRuntimeModelLoadProgress,
    'completedCount' | 'currentFile' | 'loading' | 'percent' | 'totalCount'
  > | null;
  /** 首次场景加载是否已全部结算；结算后按需加载（如 MQTT 货物模板）不再弹出蒙版。 */
  initialLoadCompleted: boolean;
  /** 启动阶段文案（runtime-config.json 的 page.loadingText）。 */
  message: string;
};

export type PlayerLoadingProgress = {
  /** 是否应显示全屏加载蒙版。 */
  visible: boolean;
  /** 0-100 的总体进度。 */
  percent: number;
  /** 蒙版标题。 */
  label: string;
  /** 蒙版详情；无在途加载时为 null。 */
  detail: string | null;
};

/**
 * 计算发布 Viewer 首次加载蒙版的状态。
 * 启动阶段按固定里程碑推进，模型/环境资源加载开始后由实际进度单元接管剩余百分比。
 */
export function computePlayerLoadingProgress(
  input: PlayerLoadingProgressInput,
): PlayerLoadingProgress {
  const { phase, startupPercent, modelLoadProgress, initialLoadCompleted, message } = input;
  const modelPercent = modelLoadProgress
    ? Math.min(1, Math.max(0, modelLoadProgress.percent))
    : (phase === 'ready' ? 1 : 0);
  const percent = Math.round(startupPercent + (100 - startupPercent) * modelPercent);
  const loadingInProgress = modelLoadProgress?.loading === true
    && modelLoadProgress.totalCount > 0
    && !initialLoadCompleted;
  const visible = (phase !== 'ready' && phase !== 'blocked') || loadingInProgress;
  const detail = loadingInProgress
    ? `模型 ${modelLoadProgress.completedCount}/${modelLoadProgress.totalCount}`
      + (modelLoadProgress.currentFile ? ` · ${modelLoadProgress.currentFile}` : '')
    : null;
  return {
    visible,
    percent: Math.max(0, Math.min(100, percent)),
    label: loadingInProgress ? '正在加载场景模型' : message,
    detail,
  };
}
