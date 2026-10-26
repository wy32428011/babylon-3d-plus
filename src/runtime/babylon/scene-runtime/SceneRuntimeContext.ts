import type { AlarmActivation } from '../AlarmManagerRuntime';
import type { SceneModelStatisticsSnapshot } from '../../../editor/model/sceneModelStatistics';
import { Scene } from '@babylonjs/core/scene.js';
import type { EnvironmentRuntimeSnapshot } from '../../../editor/model/environmentRuntime';
import type { PublishedAssetCache } from '../../assets/publishedAssetCache';
import type { SceneRuntimeModelLoadProgress } from './sceneRuntimeTypes';
export type SceneRuntimeContext = {
  /** 仅用于恢复原始函数回调的 receiver，不向领域模块暴露协调器能力。 */
  readonly callbackReceiver: object;
  onModelStatisticsChanged?: (snapshot: SceneModelStatisticsSnapshot) => void;
  onAlarmActivated?: (event: AlarmActivation) => void;
  readonly scene: Scene;
  /** 仅宿主确实遮挡初始场景且尚未进入首帧验证时返回true。 */
  readonly canDeferPreparationClassification?: () => boolean;
  readonly pushLog: (message: string) => void;
  readonly onModelMeasurementChanged: (entityId: string) => void;
  readonly notifyEnvironmentSnapshot: (snapshot: EnvironmentRuntimeSnapshot) => void;
  readonly onModelLoadProgress?: (progress: SceneRuntimeModelLoadProgress) => void;
  readonly getResourceLoadDiagnostics?: () => ReturnType<PublishedAssetCache['getLoadDiagnostics']> | null;
};
