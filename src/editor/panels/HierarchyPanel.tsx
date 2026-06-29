import { useEditorStore } from '../store/editorStore';

export function HierarchyPanel() {
  const entityIds = useEditorStore((state) => state.scene.entityIds);
  const entities = useEditorStore((state) => state.scene.entities);
  const selectedEntityId = useEditorStore((state) => state.scene.selectedEntityId);
  const selectEntity = useEditorStore((state) => state.selectEntity);

  return (
    <section className="panel">
      <h2>Hierarchy</h2>
      {entityIds.length === 0 ? <p className="muted">点击顶部工具栏创建对象。</p> : null}
      <div className="entity-list">
        {entityIds.map((entityId) => {
          const entity = entities[entityId];
          if (!entity) return null;

          return (
            <button
              className={entityId === selectedEntityId ? 'entity-item selected' : 'entity-item'}
              key={entityId}
              onClick={() => selectEntity(entityId)}
            >
              {entity.name}
            </button>
          );
        })}
      </div>
    </section>
  );
}
