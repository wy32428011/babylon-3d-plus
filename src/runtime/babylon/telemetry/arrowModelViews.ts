import type { ModelRuntimeEntry } from '../SceneRuntime';
import type { ConveyorSurfaceArrowModel } from './ConveyorSurfaceArrowSystem';

export type ArrowSystemKind = 'conveyor' | 'stacker' | 'rgv' | 'lift';
export type ArrowModelViews = Readonly<Record<ArrowSystemKind, ConveyorSurfaceArrowModel[]>>;

/**
 * 一次遍历为已启用的箭头系统各自生成只含相关模型的视图。
 * 每个系统内部只处理（或据此参与绑定冲突判断）满足下列条件的条目，因此预过滤与交给它全量列表等价：
 * 输送线与堆垛机另外按配置的 telemetryBinding.deviceType 处理，RGV 与提升机只看解析出的设备类型。
 * 返回的条目仅限当前同步帧内使用，消费方不得修改或异步保留。
 */
export function buildArrowModelViews(
  models: Iterable<{ entityId: string; model: ModelRuntimeEntry }>,
  enabled: Readonly<Record<ArrowSystemKind, boolean>>,
  resolveDeviceType: (model: ModelRuntimeEntry) => string | null,
  isVisible: (entityId: string) => boolean,
): ArrowModelViews {
  const views: Record<ArrowSystemKind, ConveyorSurfaceArrowModel[]> = { conveyor: [], stacker: [], rgv: [], lift: [] };
  if (!enabled.conveyor && !enabled.stacker && !enabled.rgv && !enabled.lift) return views;
  for (const { entityId, model } of models) {
    const deviceType = resolveDeviceType(model);
    const configuredType = model.telemetryBinding?.deviceType;
    const toConveyor = enabled.conveyor && (deviceType === 'conveyor' || configuredType === 'conveyor');
    const toStacker = enabled.stacker && (deviceType === 'stacker' || configuredType === 'stacker');
    const toRgv = enabled.rgv && deviceType === 'rgv';
    const toLift = enabled.lift && (deviceType === 'lift' || deviceType === 'hclift');
    if (!toConveyor && !toStacker && !toRgv && !toLift) continue;
    const entry: ConveyorSurfaceArrowModel = { entityId, model, deviceType, visible: isVisible(entityId) };
    if (toConveyor) views.conveyor.push(entry);
    if (toStacker) views.stacker.push(entry);
    if (toRgv) views.rgv.push(entry);
    if (toLift) views.lift.push(entry);
  }
  return views;
}
