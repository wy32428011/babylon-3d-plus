import type { LightingBakeDeviceSelection } from './sceneLightingBakeDevices.ts';
import type { LightingBakePreflight } from './sceneLightingBakePreflight.ts';
export type LightingBakeTaskStatus = 'preparing' | 'baking' | 'applying' | 'completed' | 'cancelled' | 'error' | 'interrupted';
export type LightingBakeTaskRecord = {
  version: 1; format: 'babylon-lighting-bake-task'; taskId: string; jobId: string; sceneName: string; signature: string;
  status: LightingBakeTaskStatus; phase: string; progress: number; message: string; startedAt: string; updatedAt: string;
  completedAt?: string; durationMs: number; engineVersion: string; enginePid?: number; stagingBytes: number;
  captureMetrics?: import('./sceneLightingBakeContract.ts').LightingBakeCaptureMetrics;
  inputBytes?: number; expandedGeometryBytes?: number; device?: LightingBakeDeviceSelection;
  phaseMetrics?: Array<{ phase: string; durationMs: number; mainRssBytes: number | null; mainHeapUsedBytes: number | null; cyclesPeakRssBytes: number | null }>;
  outputBytes: number; logAvailable: boolean; error?: string; preflight: LightingBakePreflight;
};
export type LightingBakeTaskHistory = { tasks: LightingBakeTaskRecord[]; totalStagingBytes: number };
export type LightingBakeTaskCleanup = { removedTaskIds: string[]; removedBytes: number };
