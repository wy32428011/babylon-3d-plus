import type { EntityLightingSettings } from '../../../electron/shared/sceneLightingBakeContract';

export type LightingMobilityDecision = { mobility: 'static' | 'dynamic'; reason: string };
/** 驱动解析之后提供的事实；这里不再用节点名或设备名称猜测运动部件。 */
export type LightingMobilityEvidence = {
  parentDynamic?: boolean;
  hasGeometryAnimation?: boolean;
  hasUnknownScriptMotion?: boolean;
  parameterGeometryOnly?: boolean;
  movingNodeKeys?: readonly string[];
  resolvedMobility?: 'static' | 'dynamic';
  reason?: string;
};
type MobilityEntity = { components: Record<string, unknown> };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

/** 自动分类只使用显式配置和运行时证据；仅状态遥测不等于几何运动。 */
export function classifyEntityMobility(entity: MobilityEntity, evidence: LightingMobilityEvidence = {}): LightingMobilityDecision {
  const components = entity.components;
  const manual = object(components.lighting).mobility;
  if (evidence.parentDynamic) return { mobility: 'dynamic', reason: '动态祖先带动当前部件，不能作为静态几何烘焙。' };
  if (manual === 'static' || manual === 'dynamic') return { mobility: manual, reason: manual === 'static' ? '已手动标记为静态。' : '已手动标记为动态。' };
  if (evidence.resolvedMobility) return { mobility: evidence.resolvedMobility, reason: evidence.reason ?? '由实际运动驱动确认。' };
  if (evidence.hasGeometryAnimation || evidence.movingNodeKeys?.length) return { mobility: 'dynamic', reason: '实际动画或运动驱动会改变几何姿态。' };
  if (components.deviceSpawner || components.manualRoamSpawn || components.autoPatrol) return { mobility: 'dynamic', reason: '运行时生成、漫游或巡检对象。' };
  if (evidence.hasUnknownScriptMotion) return { mobility: 'dynamic', reason: '脚本运动范围未知，保守按动态处理。' };
  const asset = object(components.modelAsset);
  const data = object(asset.dataDrivenConfig);
  if (Object.hasOwn(data, 'motion') || Object.hasOwn(data, 'specializedMotion')) return { mobility: 'dynamic', reason: '模型声明运动配置，不依赖当前遥测连接状态。' };
  if (evidence.parameterGeometryOnly) return { mobility: 'static', reason: '运行时已确认仅生成固定参数几何。' };
  if ((Array.isArray(asset.scriptAssets) && asset.scriptAssets.length) || (Array.isArray(asset.animationScriptMetadata) && asset.animationScriptMetadata.length)) {
    return { mobility: 'dynamic', reason: '模型脚本的运动范围尚未确认，保守按动态处理。' };
  }
  return { mobility: 'static', reason: components.telemetryBinding ? '仅有状态遥测，未发现几何运动来源。' : '未发现几何运动来源。' };
}

/** 覆盖仅绑定稳定节点身份；资源变化后保留旧项提示用户，不误套同名节点。 */
export function resolveLightingNodeSettings(
  settings: Partial<EntityLightingSettings> | undefined,
  nodeKey: string,
  automatic: LightingMobilityDecision,
  parentDynamic: boolean,
  resourceIdentity?: string,
): LightingMobilityDecision & { castShadows: boolean; receiveShadows: boolean; bakeIndirect: boolean; parentDynamic: boolean; unmatchedOverride?: boolean } {
  const override = settings?.nodeOverrides?.[nodeKey];
  const unmatchedOverride = Boolean(override && settings?.resourceIdentity && settings.resourceIdentity !== resourceIdentity);
  const matching = unmatchedOverride ? undefined : override;
  const requested = matching?.mobility && matching.mobility !== 'auto' ? matching.mobility : settings?.mobility;
  const mobility = parentDynamic ? 'dynamic' : requested === 'static' || requested === 'dynamic' ? requested : automatic.mobility;
  const reason = parentDynamic ? '动态祖先带动当前部件，静态标记不能抵消祖先运动。'
    : unmatchedOverride ? automatic.reason + ' 旧覆盖与当前资源身份失配，未应用。'
      : requested === 'static' || requested === 'dynamic' ? (matching ? '部件' : '对象') + '已手动标记为' + (mobility === 'static' ? '静态。' : '动态。') : automatic.reason;
  return { mobility, reason, castShadows: matching?.castShadows ?? settings?.castShadows ?? true,
    receiveShadows: matching?.receiveShadows ?? settings?.receiveShadows ?? true,
    bakeIndirect: matching?.bakeIndirect ?? settings?.bakeIndirect ?? true,
    parentDynamic, ...(unmatchedOverride ? { unmatchedOverride: true } : {}) };
}
