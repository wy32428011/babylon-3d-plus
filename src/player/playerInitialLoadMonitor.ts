/** 总耗时只触发提示；连续五分钟无资源或阶段进展才判定停滞。 */
export const PLAYER_SCENE_LOADING_WARNING_MS = 120_000;
export const PLAYER_SCENE_LOADING_STALL_MS = 300_000;

type InitialLoadSnapshot = {
  startupStage?: string;
  resourceBytes?: number;
  progress: { loading: boolean; percent: number; completedCount: number; totalCount: number; currentFile: string | null; filePercent: number | null };
  skybox: { stage: string | null; receivedBytes: number; totalBytes: number | null };
};

/** 每个 Viewer 加载会话独立持有；不把重复通知、持续渲染或墙上时钟当作资源进展。 */
export class PlayerInitialLoadMonitor {
  private startedAt: number | null = null;
  private lastProgressAt = 0;
  private signature = '';

  sample(snapshot: InitialLoadSnapshot, now: number): { kind: 'loading' | 'slow' | 'stalled'; detail: string } {
    const { progress, skybox } = snapshot;
    const signature = JSON.stringify([progress.loading, progress.percent, progress.completedCount,
      progress.totalCount, progress.currentFile, progress.filePercent, skybox.stage, skybox.receivedBytes, snapshot.resourceBytes, snapshot.startupStage]);
    if (this.startedAt === null) this.startedAt = now;
    if (signature !== this.signature) { this.signature = signature; this.lastProgressAt = now; }
    const stage = snapshot.startupStage || (skybox.stage === 'reading' ? '下载天空盒' : skybox.stage === 'decoding' ? '解码天空盒'
      : skybox.stage === 'prefiltering' ? '准备天空盒光照' : progress.loading ? '加载模型资源' : '验证场景首帧');
    const bytes = skybox.stage === 'reading'
      ? ` ${(skybox.receivedBytes / 1_000_000).toFixed(1)}${skybox.totalBytes === null ? '' : ` / ${(skybox.totalBytes / 1_000_000).toFixed(1)}`} MB`
      : '';
    const kind = now - this.lastProgressAt >= PLAYER_SCENE_LOADING_STALL_MS ? 'stalled'
      : now - this.startedAt >= PLAYER_SCENE_LOADING_WARNING_MS ? 'slow' : 'loading';
    return { kind, detail: `${stage}${bytes}${progress.currentFile && !skybox.stage ? ` · ${progress.currentFile}` : ''}` };
  }
}
