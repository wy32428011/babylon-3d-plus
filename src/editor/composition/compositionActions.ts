import type { CompositionLibraryEntry } from '../../../electron/shared/compositionTypes';
import { useEditorStore } from '../store/editorStore';
import { deserializeScene, serializeScene } from '../project/SceneSerializer';
import { instantiateComposition, type CompositionCapture, groupComposition } from './composition';
import type { SceneDocument } from '../model/SceneDocument';

export function placeComposition(entry: CompositionLibraryEntry, position = { x: 0, y: 0, z: 0 }) {
  const state = useEditorStore.getState();
  const { root, entities } = instantiateComposition(entry.definition, position, {
    libraryId: entry.id, revision: entry.revision, resourceType: 'ENV_MODEL', resourceId: entry.resourceId, sourceKey: entry.sourceKey,
    packagePath: entry.packagePath, contentSha256: entry.contentSha256,
  });
  const after = { ...state.scene, entities: { ...state.scene.entities, [root.id]: root, ...Object.fromEntries(entities.map(e => [e.id,e])) },
    entityIds: [...state.scene.entityIds, root.id, ...entities.map(e => e.id)], selectedEntityId: root.id };
  // 复用场景入口的完整组件校验，防止资源清单绕过正常导入约束。
  state.commitCompositionEdit(state.scene, deserializeScene(serializeScene(after)), '放置组合模型');
}
export function associateComposition(before: SceneDocument, capture: CompositionCapture, entry: CompositionLibraryEntry) {
  const state = useEditorStore.getState();
  if (state.scene !== before) { state.pushLog('组合已保存；场景随后发生变化，保留当前编辑内容。'); return; }
  const after = groupComposition(before, capture, { libraryId: entry.id, revision: entry.revision, resourceType: 'ENV_MODEL', resourceId: entry.resourceId,
    sourceKey: entry.sourceKey, packagePath: entry.packagePath, contentSha256: entry.contentSha256 });
  const nodes = new Map(entry.definition.nodes.map(node => [node.id, node]));
  const ids = new Map(capture.sourceIds.map(id => [before.entities[id].compositionNodeId ?? id, id]));
  for (const id of capture.sourceIds) {
    const entity = after.entities[id], original = before.entities[id];
    const snapshot = nodes.get(original.compositionNodeId ?? id)?.components.modelAsset;
    if (!original.components.modelAsset || !snapshot) continue;
    const modelAsset = { ...structuredClone(snapshot as typeof original.components.modelAsset),
      assetCode: original.components.modelAsset.assetCode, dataDrivenConfig: original.components.modelAsset.dataDrivenConfig };
    const components = { ...entity.components, modelAsset };
    const array = nodes.get(original.compositionNodeId ?? id)?.components.modelArrayInstance as {sourceEntityId:string} | undefined;
    if (array && ids.has(array.sourceEntityId)) components.modelArrayInstance = { sourceEntityId: ids.get(array.sourceEntityId)! };
    else delete components.modelArrayInstance;
    after.entities[id] = { ...entity, components };
  }
  state.commitCompositionEdit(before, after, '保存组合关联');
}
