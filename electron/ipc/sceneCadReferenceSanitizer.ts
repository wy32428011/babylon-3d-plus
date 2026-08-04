/**
 * 从发布快照中移除 CAD 参考组件。
 * 仅修改传入的已解析场景对象；本地编辑器场景和普通 Web 导出不调用此函数。
 */
export function stripCadReferencesFromSceneFile(sceneFile: unknown): number {
  if (!isPlainObject(sceneFile) || !isPlainObject(sceneFile.scene)) return 0;
  const entities = sceneFile.scene.entities;
  if (!isPlainObject(entities)) return 0;

  let removedCount = 0;
  for (const entity of Object.values(entities)) {
    if (!isPlainObject(entity) || !isPlainObject(entity.components)) continue;
    if (!Object.prototype.hasOwnProperty.call(entity.components, 'cadReference')) continue;
    delete entity.components.cadReference;
    removedCount += 1;
  }
  return removedCount;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
