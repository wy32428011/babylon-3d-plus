import { modelTypePathKey } from './modelTypeIdentity.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);

/** 特效类型是查询元数据；不进入模型加载和资源收集。 */
export function collectEffectModelReferences(value: unknown): RecordValue[] {
  const scene = record(value) && record(value.scene) ? value.scene : value;
  if (!record(scene) || !record(scene.entities)) return [];
  return Object.values(scene.entities).flatMap(entity => {
    if (!record(entity) || !record(entity.components) || !record(entity.components.poiEffect)) return [];
    const configuration = entity.components.poiEffect.configuration;
    return record(configuration) && record(configuration.target) && record(configuration.target.model) ? [configuration.target.model] : [];
  });
}

/** 兼容旧配置的实体搬迁证据；新类型绑定不依赖编辑实例。 */
export function relocateLegacyEffectModelReferences(value: unknown): void {
  const scene = record(value) && record(value.scene) ? value.scene : value;
  if (!record(scene) || !record(scene.entities)) return;
  const entities = scene.entities;
  for (const model of collectEffectModelReferences(scene)) {
    if (record(model.identity) || !Array.isArray(model.entityIds)) continue;
    const proofs = model.entityIds.flatMap(id => {
      const entity = typeof id === 'string' ? entities[id] : null;
      return record(entity) && record(entity.components) && record(entity.components.modelAsset) ? [entity.components.modelAsset] : [];
    });
    const keys = new Set(proofs.map(asset => JSON.stringify(asset.dataPlatformModel ?? modelTypePathKey(asset.sourcePath))));
    if (keys.size !== 1) continue;
    model.sourcePath = proofs[0].sourcePath;
    model.sourceUrl = proofs[0].sourceUrl;
    if (record(proofs[0].dataPlatformModel)) model.identity = structuredClone(proofs[0].dataPlatformModel);
  }
}

/** DIST 复用实际生产者的文件映射，未被加载的筛选模板不会额外打包或暴露本机路径。 */
export function normalizeEffectDeploymentReferences(scene: unknown, sourceUrlMap: ReadonlyMap<string, string> = new Map()): void {
  if (!record(scene) || !record(scene.entities)) return;
  const entities = scene.entities;
  const urls = new Map([...sourceUrlMap].map(([source, destination]) => [modelTypePathKey(source), destination]));
  relocateLegacyEffectModelReferences(scene);
  for (const model of collectEffectModelReferences(scene)) {
    if (!record(model.identity) && Array.isArray(model.entityIds)) {
      const existing = new Set(Array.isArray(model.entityIds) ? model.entityIds.filter(id => typeof id === 'string' && record(entities[id])) : []);
      const sourcePath = modelTypePathKey(model.sourcePath), sourceUrl = modelTypePathKey(model.sourceUrl);
      const matches = Object.entries(entities).flatMap(([id, candidate]) => {
        if (!record(candidate) || !record(candidate.components) || !record(candidate.components.modelAsset)) return [];
        const asset = candidate.components.modelAsset;
        const samePath = sourcePath && sourcePath === modelTypePathKey(asset.sourcePath);
        const sameUrl = sourceUrl && sourceUrl === modelTypePathKey(asset.sourceUrl);
        return existing.has(id) || samePath || sameUrl ? [id] : [];
      });
      if (matches.length || Array.isArray(model.entityIds)) model.entityIds = matches.slice(0, 64);
    }
    const destination = urls.get(modelTypePathKey(model.sourcePath)) ?? urls.get(modelTypePathKey(model.sourceUrl));
    model.sourcePath = destination ?? '';
    model.sourceUrl = destination ?? '';
  }
}
