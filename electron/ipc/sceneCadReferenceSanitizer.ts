import { createRequire } from 'node:module';


const require = createRequire(import.meta.url);
const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const { CURRENT_SCENE_FILE_VERSION, isSupportedSceneFileVersion } = require(
  `../shared/sceneFileVersion${extension}`,
) as typeof import('../shared/sceneFileVersion.js');
const { getSceneLightingBakeSignature, validateSceneLightingBakeSnapshot } = require(
  `../shared/sceneLightingBakeContract${extension}`,
) as typeof import('../shared/sceneLightingBakeContract.js');
const { migrateSceneLightingDocument } = require(
  `../shared/sceneLightingConfig${extension}`,
) as typeof import('../shared/sceneLightingConfig.js');

/**
 * 从发布快照中移除 CAD 参考组件。
 * 仅修改传入的已解析场景对象；本地编辑器场景和普通 Web 导出不调用此函数。
 */
export function stripCadReferencesFromSceneFile(sceneFile: unknown): number {
  if (!isPlainObject(sceneFile) || !isPlainObject(sceneFile.scene)) return 0;
  const sourceEntities = sceneFile.scene.entities;
  if (!isPlainObject(sourceEntities) || !Object.values(sourceEntities).some(entity => isPlainObject(entity)
    && isPlainObject(entity.components) && Object.hasOwn(entity.components, 'cadReference'))) return 0;
  // 发布只改自身副本；调用方还可能持有原场景引用用于保存或后续比对。
  const scene = migrateSceneLightingDocument(structuredClone(sceneFile.scene));
  sceneFile.scene = scene;
  if (isSupportedSceneFileVersion(sceneFile.version)) sceneFile.version = CURRENT_SCENE_FILE_VERSION;
  const entities = scene.entities as Record<string, unknown>;
  const lighting = scene.sceneSettings.lighting;
  const result = validateSceneLightingBakeSnapshot(lighting.result);
  const wasValidLighting = Boolean(result && result.signature.startsWith('lighting-v2-') && result.signature === getSceneLightingBakeSignature(scene));
  let onlyReferenceComponentsRemoved = true;
  let removedCount = 0;
  for (const entity of Object.values(entities)) {
    if (!isPlainObject(entity) || !isPlainObject(entity.components)) continue;
    if (!Object.prototype.hasOwnProperty.call(entity.components, 'cadReference')) continue;
    // 纯 CAD 实体剔除组件后只剩 Transform；实际几何和父子关系没有变化。
    if (Object.keys(entity.components).some(key => key !== 'cadReference' && key !== 'transform' && key !== 'lighting')) {
      onlyReferenceComponentsRemoved = false;
    }
    delete entity.components.cadReference;
    removedCount += 1;
  }
  // 签名原先排除 CAD 实体，剔除后会包含其空 Transform 节点；仅迁移此前有效的烘焙。
  if (removedCount > 0 && onlyReferenceComponentsRemoved && wasValidLighting && lighting.result) {
    lighting.result = { ...lighting.result, signature: getSceneLightingBakeSignature(scene) };
  }
  return removedCount;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
