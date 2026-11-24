export type AppUpdateStage =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface AppUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface AppUpdateState {
  stage: AppUpdateStage;
  currentVersion: string;
  availableVersion: string | null;
  releaseName: string | null;
  releaseDate: string | null;
  releaseNotes: string | null;
  progress: AppUpdateProgress | null;
  errorMessage: string | null;
  /** 本次检查是否由用户手动触发；自动静默检查在无新版本或网络异常时不主动弹窗。 */
  manual: boolean;
  checkedAt: string | null;
}

export interface CheckForAppUpdateRequest {
  manual?: boolean;
}

export const APP_UPDATE_UNSUPPORTED_MESSAGE = '当前为开发运行模式，仅打包后的 Windows 安装包支持检测与安装更新。';

/** 生成初始更新状态；非打包态直接标记为 unsupported。 */
export function createInitialAppUpdateState(currentVersion: string, supported: boolean): AppUpdateState {
  return {
    stage: supported ? 'idle' : 'unsupported',
    currentVersion,
    availableVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    progress: null,
    errorMessage: supported ? null : APP_UPDATE_UNSUPPORTED_MESSAGE,
    manual: false,
    checkedAt: null,
  };
}

/** 去除 GitHub Release 说明中的简单 HTML 标签并折叠多余空行，避免渲染未净化 HTML。 */
function stripHtmlTags(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 将 electron-updater 返回的字符串或分段数组 releaseNotes 规范化为可读纯文本。 */
export function normalizeReleaseNotes(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const cleaned = stripHtmlTags(raw);
    return cleaned.length > 0 ? cleaned : null;
  }
  if (Array.isArray(raw)) {
    const sections = raw
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return '';
        const item = entry as { version?: unknown; note?: unknown };
        const note = typeof item.note === 'string' ? stripHtmlTags(item.note) : '';
        if (!note) return '';
        const version = typeof item.version === 'string' && item.version.trim() ? `v${item.version.trim().replace(/^v/i, '')}\n` : '';
        return `${version}${note}`;
      })
      .filter(Boolean);
    return sections.length > 0 ? sections.join('\n\n') : null;
  }
  return null;
}

/** 将常见网络或发布源错误转换为用户可读的中文提示。 */
export function formatAppUpdateErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return '检查或下载更新失败，请稍后重试。';
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN/i.test(trimmed)) {
    return '无法连接到 GitHub 更新服务器，请检查网络连接后重试。';
  }
  if (/ETIMEDOUT|ECONNRESET|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_REFUSED|socket hang up/i.test(trimmed)) {
    return '连接 GitHub 更新服务器超时或被中断，请稍后重试。';
  }
  if (/404|Cannot find latest\.yml|No published versions on GitHub/i.test(trimmed)) {
    return 'GitHub Releases 中暂未找到可用的 Windows 安装包更新清单（latest.yml）。';
  }
  if (/sha512|checksum/i.test(trimmed)) {
    return '安装包完整性校验失败，请重新下载更新。';
  }
  return trimmed;
}

/** 判断在当前状态下是否需要自动弹出更新对话框（静默检查仅在发现新版本或已下载完成时提示）。 */
export function shouldAutoOpenUpdateDialog(state: AppUpdateState): boolean {
  return state.stage === 'available' || state.stage === 'downloaded';
}

/** 格式化字节数为人类可读大小。 */
export function formatUpdateBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
