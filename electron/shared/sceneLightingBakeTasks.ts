import type { LightingBakeDeviceSelection } from './sceneLightingBakeDevices.ts';
import type { LightingBakePreflight } from './sceneLightingBakePreflight.ts';
export type LightingBakeTaskStatus = 'preparing' | 'baking' | 'applying' | 'completed' | 'cancelled' | 'error' | 'interrupted';
/** 仅任务诊断，不写入场景或正式光照资产；求解耗时只统计实际烘焙调用。 */
export type LightingBakePreprocessDiagnostic = {
  status: 'hit' | 'miss' | 'skipped'; reason: string; key?: string;
  lookupDurationMs: number; restoreDurationMs?: number; prepareDurationMs?: number; writeDurationMs?: number;
  bakeDurationMs?: number; bytes?: number;
};
export function isLightingBakePreprocessDiagnostic(value: unknown): value is LightingBakePreprocessDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const item = value as LightingBakePreprocessDiagnostic;
  return ['hit', 'miss', 'skipped'].includes(item.status) && typeof item.reason === 'string' && item.reason.length <= 1024
    && (item.key === undefined || typeof item.key === 'string' && /^[a-f0-9]{64}$/.test(item.key))
    && Number.isFinite(item.lookupDurationMs) && item.lookupDurationMs >= 0
    && ['restoreDurationMs', 'prepareDurationMs', 'writeDurationMs', 'bakeDurationMs', 'bytes'].every(key => {
      const number = item[key as keyof LightingBakePreprocessDiagnostic];
      return number === undefined || typeof number === 'number' && Number.isFinite(number) && number >= 0;
    });
}
export type LightingBakeTaskRecord = {
  version: 1; format: 'babylon-lighting-bake-task'; taskId: string; jobId: string; sceneName: string; signature: string;
  status: LightingBakeTaskStatus; phase: string; progress: number; message: string; startedAt: string; updatedAt: string;
  completedAt?: string; durationMs: number; engineVersion: string; enginePid?: number; stagingBytes: number;
  captureMetrics?: import('./sceneLightingBakeContract.ts').LightingBakeCaptureMetrics;
  inputBytes?: number; expandedGeometryBytes?: number; device?: LightingBakeDeviceSelection;
  preprocessCache?: LightingBakePreprocessDiagnostic;
  phaseMetrics?: Array<{ phase: string; durationMs: number; mainRssBytes: number | null; mainHeapUsedBytes: number | null; cyclesPeakRssBytes: number | null }>;
  outputBytes: number; logAvailable: boolean; error?: string; preflight: LightingBakePreflight;
};
export type LightingBakeTaskHistory = { tasks: LightingBakeTaskRecord[]; totalStagingBytes: number };
export type LightingBakeTaskCleanup = { removedTaskIds: string[]; removedBytes: number };
