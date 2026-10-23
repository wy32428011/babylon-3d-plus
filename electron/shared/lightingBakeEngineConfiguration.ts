import type { LightingBakeEngineStatus } from './sceneLightingBakeContract.js';

/** 当前系统用户的本机引擎设置，不能写入场景、工程归档或发布包。 */
export type LightingBakeEngineConfiguration = {
  configuredPath: string | null;
  configPath: string;
  environmentPath: string | null;
  source: 'environment' | 'configuration' | 'installation' | null;
  engine: LightingBakeEngineStatus;
  configurationError?: string;
  busy: boolean;
};
