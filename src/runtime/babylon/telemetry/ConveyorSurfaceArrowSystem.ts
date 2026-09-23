import type { ModelRuntimeEntry } from '../SceneRuntime';
import { resolveConveyorSurfaceArrowsConfig, type ConveyorSurfaceArrowsConfig } from '../../../editor/model/conveyorSurfaceArrows';
import { conveyorSurfaceArrowSession } from '../../conveyorSurfaceArrowSession';
import { deviceTelemetryStore } from '../../mqtt/deviceTelemetry';
import { readConveyorCargoTravelConfig } from './specialized/specializedModelAssets';
import { collectSpecializedTelemetryConflictKeys, resolveSpecializedTelemetryBinding, resolveSpecializedTelemetrySnapshot } from './specializedTelemetryBinding';
import { resolveConveyorTrajectoryForwardSign } from './conveyorMotionSignal';
import { resolveConveyorSurfaceArrowState } from './conveyorSurfaceArrowState';

export type ConveyorSurfaceArrowModel = {
  entityId: string;
  model: ModelRuntimeEntry;
  deviceType: string | null;
  visible: boolean;
};

export interface ConveyorSurfaceArrowVisual {
  update(id: string, model: ModelRuntimeEntry, config: ConveyorSurfaceArrowsConfig, direction: 1 | -1 | 0, deltaSeconds: number, visible: boolean): string | null;
  retain(ids: ReadonlySet<string>): void;
  clear(): void;
  dispose(): void;
}

/** 同一逐帧入口处理有效和失效状态；货物 Driver 的断流续行不影响箭头。 */
export class ConveyorSurfaceArrowSystem {
  private diagnosticIds = new Set<string>();
  private builtInCache = new WeakMap<ModelRuntimeEntry, {
    asset: unknown; parameters: unknown; signature: string; present: boolean;
  }>();

  constructor(private readonly renderer: ConveyorSurfaceArrowVisual) {}

  tick(models: Iterable<ConveyorSurfaceArrowModel>, running: boolean, deltaSeconds: number, now = Date.now()): void {
    const entries = [...models].map(entry => ({ ...entry, binding: running && entry.deviceType === 'conveyor'
      && entry.model.assetHandle && entry.model.stackerTelemetryReady
      ? resolveSpecializedTelemetryBinding({ modelAssetCode: entry.model.assetCode, deviceType: 'conveyor', binding: entry.model.telemetryBinding }) : null }));
    // 未启用箭头的设备也参与冲突判断，与现有专用设备绑定规则保持一致。
    const conflicts = running
      ? collectSpecializedTelemetryConflictKeys(entries.flatMap(entry => entry.binding ? [entry.binding] : []))
      : new Set<string>();
    const retained = new Set<string>();
    const diagnostics = new Set<string>();
    for (const { entityId, model, binding, visible, deviceType } of entries) {
      const config = resolveConveyorSurfaceArrowsConfig(model.telemetryBinding?.surfaceArrows,
        deviceType === 'conveyor' || model.telemetryBinding?.deviceType === 'conveyor');
      if (!config) continue;
      diagnostics.add(entityId);
      if (!config.enabled) {
        conveyorSurfaceArrowSession.setDiagnostic(entityId, '表面箭头未启用');
        continue;
      }
      if (!model.assetHandle || !model.stackerTelemetryReady || model.root.isDisposed()) {
        conveyorSurfaceArrowSession.setDiagnostic(entityId, '等待输送线模型准备完成');
        continue;
      }
      retained.add(entityId);
      const preview = running ? null : conveyorSurfaceArrowSession.getPreview(entityId);
      // 默认开启不应让空闲编辑场景逐帧读取所有模型的脚本/几何；停止只走隐藏复用路径。
      if (!running && (preview === null || preview === 0)) {
        this.renderer.update(entityId, model, config, 0, deltaSeconds, false);
        conveyorSurfaceArrowSession.setDiagnostic(entityId, preview === null
          ? '编辑状态：可预览正向、反向和停止' : '编辑预览：停止，箭头隐藏（模拟状态）');
        continue;
      }
      const travel = readConveyorCargoTravelConfig(model);
      let direction: 1 | -1 | 0;
      let message: string;
      if (running) {
        const state = resolveConveyorSurfaceArrowState({ binding,
          snapshot: binding ? resolveSpecializedTelemetrySnapshot(deviceTelemetryStore, binding) : null,
          config: travel, trajectoryDirection: model.telemetryBinding?.trajectoryDirection, directionBinding: config.directionBinding,
          now, conflict: binding ? conflicts.has(binding.key) : false });
        direction = state.direction;
        message = state.message;
      } else {
        direction = ((preview ?? 0) * resolveConveyorTrajectoryForwardSign(model.telemetryBinding?.trajectoryDirection, travel.axis)) as 1 | -1 | 0;
        message = `编辑预览：${preview === 1 ? '正向' : '反向'}（模拟状态）`;
      }
      if (this.hasBuiltInArrow(model)) {
        direction = 0;
        message = '保留模型自带箭头；使用通用箭头前，请在模型参数中关闭 showDirectionArrow，并校准输送面与正向';
      }
      const issue = this.renderer.update(entityId, model, config, direction, deltaSeconds, visible && direction !== 0);
      conveyorSurfaceArrowSession.setDiagnostic(entityId, issue ? `${message}；${issue}` : message);
    }
    this.renderer.retain(retained);
    for (const id of this.diagnosticIds) if (!diagnostics.has(id)) conveyorSurfaceArrowSession.remove(id);
    this.diagnosticIds = diagnostics;
  }

  private hasBuiltInArrow(model: ModelRuntimeEntry): boolean {
    const values = model.entitySnapshot?.components.modelAsset?.parameterValues;
    if (values?.showDirectionArrow === false) return false;
    const source = model.telemetryProxySource ?? model;
    const cached = this.builtInCache.get(source);
    const parameters = source.entitySnapshot?.components.modelAsset?.parameterValues;
    const signature = `${source.parameterSignature ?? ''}|${source.externalScriptSignature ?? ''}`;
    if (cached && cached.asset === source.assetHandle && cached.parameters === parameters && cached.signature === signature) return cached.present;
    const present = source.contentRoot.getChildMeshes(false).some(mesh => mesh.metadata?.directionArrowVisual === true);
    this.builtInCache.set(source, { asset: source.assetHandle, parameters, signature, present });
    return present;
  }

  clear(): void {
    this.renderer.clear();
    for (const id of this.diagnosticIds) conveyorSurfaceArrowSession.remove(id);
    this.diagnosticIds.clear();
    this.builtInCache = new WeakMap();
  }

  dispose(): void { this.clear(); this.renderer.dispose(); }
}
