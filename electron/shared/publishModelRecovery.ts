import { getClickEventModelResourceKey } from './clickEventModelIdentity.js';

type JsonObject = Record<string, unknown>;
export type PublishModelReference = { asset: JsonObject; target?: JsonObject; clickTarget: boolean };
export type PublishModelRecoveryItem = {
  kind: 'model' | 'combo';
  resourceId: string;
  sourceUrls: string[];
  displayName: string;
};

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

/** 与发布支持的模型位置保持一致，生成器及报警目标也参与缺失资源恢复。 */
export function collectPublishModelReferences(scene: unknown): { models: PublishModelReference[]; devices: JsonObject[] } {
  const models: PublishModelReference[] = [], devices: JsonObject[] = [];
  const add = (asset: unknown, target?: JsonObject, clickTarget = false) => {
    const value = object(asset);
    if (value) models.push({ asset: value, target, clickTarget });
  };
  const addTarget = (value: unknown, clickTarget = false) => {
    const target = object(value);
    if (target?.kind === 'model') add(target.modelAsset, target, clickTarget);
  };
  for (const entity of Object.values(object(object(scene)?.entities) ?? {})) {
    const components = object(object(entity)?.components);
    if (!components) continue;
    add(components.modelAsset, undefined, true);
    add(object(components.manualRoamSpawn)?.avatar);
    const generator = object(components.modelGenerator);
    addTarget(generator?.defaultTarget, true);
    for (const rule of Array.isArray(generator?.rules) ? generator.rules : []) addTarget(object(rule)?.target, true);
    const alarm = object(components.alarmManager);
    addTarget(alarm?.appearanceModel);
    for (const slot of Array.isArray(alarm?.targets) ? alarm.targets : []) addTarget(object(slot)?.model);
    const binding = object(components.clickEventBinding);
    for (const slot of Array.isArray(binding?.deviceSlots) ? binding.deviceSlots : []) {
      const device = object(object(slot)?.deviceType);
      if (device) devices.push(device);
    }
  }
  return { models, devices };
}

export function publishModelMatchKey(sourceUrl: unknown): string {
  return getClickEventModelResourceKey(sourceUrl) ?? (typeof sourceUrl === 'string' ? sourceUrl : '');
}

/** 保留可用场景快照；缺失文件与没有任何场景目标的绑定都必须先拉取模型。 */
export async function planPublishModelRecovery(
  scene: unknown,
  isAvailable: (asset: JsonObject) => Promise<boolean>,
): Promise<PublishModelRecoveryItem[]> {
  const { models, devices } = collectPublishModelReferences(scene);
  const modelKeys = new Set(models.filter(({ clickTarget }) => clickTarget).map(({ asset }) => publishModelMatchKey(asset.sourceUrl)).filter(Boolean));
  const resourceFiles = new Map<string, Set<string>>();
  for (const asset of [...models.map((reference) => reference.asset), ...devices]) {
    const key = getClickEventModelResourceKey(asset.sourceUrl);
    if (!key) continue;
    const resourceKey = key.split(':').slice(0, 2).join(':');
    const files = resourceFiles.get(resourceKey) ?? new Set<string>();
    files.add(key);
    resourceFiles.set(resourceKey, files);
  }
  const plan = new Map<string, PublishModelRecoveryItem>();
  const requireRecovery = (asset: JsonObject): void => {
    const key = getClickEventModelResourceKey(asset.sourceUrl);
    const displayName = String(asset.displayName ?? asset.sourcePath ?? '未命名模型');
    if (!key) throw new Error(`「${displayName}」缺少可用场景模型，无法识别数据中台模型，请重新导入该模型后发布。`);
    const [kind, resourceId] = key.split(':') as ['model' | 'combo', string];
    const resourceKey = `${kind}:${resourceId}`;
    if ((resourceFiles.get(resourceKey)?.size ?? 0) > 1) {
      throw new Error('数据中台模型「' + displayName + '」引用多个不同包内模型，无法自动确定变体，请重新导入并核对绑定。');
    }
    const item = plan.get(resourceKey) ?? { kind, resourceId, sourceUrls: [], displayName };
    if (!item.sourceUrls.includes(asset.sourceUrl as string)) item.sourceUrls.push(asset.sourceUrl as string);
    plan.set(resourceKey, item);
  };
  const availability = new Map<string, boolean>();
  for (const { asset } of models) {
    // 多个实例共享同一资源时，主文件与脚本的检查只执行一次。
    const cacheKey = JSON.stringify([asset.sourceUrl, asset.scriptAssets]);
    let available = availability.get(cacheKey);
    if (available === undefined) {
      available = await isAvailable(asset);
      availability.set(cacheKey, available);
    }
    if (!available) requireRecovery(asset);
  }
  for (const device of devices) {
    if (!modelKeys.has(publishModelMatchKey(device.sourceUrl))) requireRecovery(device);
  }
  return [...plan.values()];
}
