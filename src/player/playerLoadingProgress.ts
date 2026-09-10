import type { SceneRuntimeModelLoadProgress } from '../runtime/babylon/SceneRuntime';

/** 发布 Viewer 首次资源与首帧验证的最长等待时间；超时后显示阻断错误。 */
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

/** 仅格式化加载详情；先移除 URL 后缀，避免误删文件名中编码后的 ? 或 #。 */
function formatLoadingFileName(currentFile: string | null): string {
  const fileName = (currentFile ?? '').split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(fileName);
  } catch {
    // 旧资源可能含有裸 % 或不完整转义，保留原名，避免显示文案异常阻断场景加载。
    return fileName;
  }
}

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
  const verifyingRender = phase === 'ready' && !initialLoadCompleted && !loadingInProgress;
  const visible = phase !== 'blocked' && (phase !== 'ready' || loadingInProgress || verifyingRender);
  const currentFile = loadingInProgress ? formatLoadingFileName(modelLoadProgress.currentFile) : '';
  const detail = loadingInProgress
    ? `模型 ${modelLoadProgress.completedCount}/${modelLoadProgress.totalCount}`
      + (currentFile ? ` · ${currentFile}` : '')
    : null;
  return {
    visible,
    percent: Math.max(0, Math.min(verifyingRender ? 99 : 100, percent)),
    label: verifyingRender ? '正在验证场景首帧' : loadingInProgress ? '正在加载场景模型' : message,
    detail: verifyingRender ? '模型资源已准备，等待材质与实际渲染完成…' : detail,
  };
}
