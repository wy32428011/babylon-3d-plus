import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const { getSceneShadowBakeSignatureContract, getSceneShadowBakeErrorContract } = require(
  `../shared/sceneShadowBakeContract${extension}`,
) as typeof import('../shared/sceneShadowBakeContract.js');

/**
 * 从发布快照中移除 CAD 参考组件。
 * 仅修改传入的已解析场景对象；本地编辑器场景和普通 Web 导出不调用此函数。
 */
export function stripCadReferencesFromSceneFile(sceneFile: unknown): number {
  if (!isPlainObject(sceneFile) || !isPlainObject(sceneFile.scene)) return 0;
  const entities = sceneFile.scene.entities;
  if (!isPlainObject(entities)) return 0;

  const settings = isPlainObject(sceneFile.scene.sceneSettings) ? sceneFile.scene.sceneSettings : null;
  const shadows = settings && isPlainObject(settings.shadows) ? settings.shadows : null;
  const bake = shadows && isPlainObject(shadows.bake) ? shadows.bake : null;
  const wasValidBake = Boolean(bake && getSceneShadowBakeErrorContract(sceneFile.scene) === null
    && bake.signature === getSceneShadowBakeSignatureContract(sceneFile.scene));
  let onlyReferenceComponentsRemoved = true;
  let removedCount = 0;
  for (const entity of Object.values(entities)) {
    if (!isPlainObject(entity) || !isPlainObject(entity.components)) continue;
    if (!Object.prototype.hasOwnProperty.call(entity.components, 'cadReference')) continue;
    // 纯 CAD 实体剔除组件后只剩 Transform；实际几何和父子关系没有变化。
    if (Object.keys(entity.components).some(key => key !== 'cadReference' && key !== 'transform')) {
      onlyReferenceComponentsRemoved = false;
    }
    delete entity.components.cadReference;
    removedCount += 1;
  }
  // 签名原先排除 CAD 实体，剔除后会包含其空 Transform 节点；仅迁移此前有效的烘焙。
  if (removedCount > 0 && onlyReferenceComponentsRemoved && wasValidBake && bake) {
    bake.signature = getSceneShadowBakeSignatureContract(sceneFile.scene);
  }
  return removedCount;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
