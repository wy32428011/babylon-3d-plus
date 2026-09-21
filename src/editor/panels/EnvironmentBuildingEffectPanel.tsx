import './DigitalTwinEffectInspector.css';
import { useMemo, useState, type DragEvent } from 'react';
import { BUILT_IN_ASSET_DRAG_MIME_TYPE, decodeBuiltInAssetDragPayload } from '../assets/AssetDatabase';
import { ENVIRONMENT_BUILDING_EFFECT_KINDS, ENVIRONMENT_EFFECT_TARGET_ID, isEnvironmentBuildingEffectKind } from '../model/environmentBuildingEffect';
import { getPoiEffectDefinition } from '../model/poiEffect';
import { useEditorStore } from '../store/editorStore';

/** 场景属性提供快捷拖放入口，实际配置复用普通特效实体的环境绑定。 */
export function EnvironmentBuildingEffectPanel({ disabled = false }: { disabled?: boolean }) {
  const environment = useEditorStore(state => state.scene.sceneSettings.environment);
  const entities = useEditorStore(state => state.scene.entities);
  const ids = useEditorStore(state => state.scene.entityIds);
  const createPoiEffect = useEditorStore(state => state.createPoiEffect);
  const selectEntity = useEditorStore(state => state.selectEntity);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState('');
  const bound = useMemo(() => ids.map(id => entities[id]).filter(entity => entity?.components.poiEffect?.visual?.targetEntityId === ENVIRONMENT_EFFECT_TARGET_ID), [ids, entities]);
  const unavailable = disabled || !environment;

  function dragOver(event: DragEvent<HTMLDivElement>) {
    if (unavailable || !event.dataTransfer.types.includes(BUILT_IN_ASSET_DRAG_MIME_TYPE)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setDragging(true);
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); event.stopPropagation(); setDragging(false);
    if (unavailable) return;
    const payload = decodeBuiltInAssetDragPayload(event.dataTransfer.getData(BUILT_IN_ASSET_DRAG_MIME_TYPE));
    if (payload?.kind !== 'poi-effect' || !isEnvironmentBuildingEffectKind(payload.effectKind)) {
      setMessage('请拖入建筑外观特效：轮廓、棱线、发光、扫光、渐变、全息、透视或生长。'); return;
    }
    setMessage(''); createPoiEffect(payload.effectKind, undefined, ENVIRONMENT_EFFECT_TARGET_ID);
  }

  return <div className="scene-effect-section" aria-label="环境建筑物特效">
    <span className="scene-effect-title">建筑物特效</span>
    <div role="region" aria-label="环境建筑物特效拖放区" aria-disabled={unavailable}
      className={dragging ? 'environment-building-effect-drop active' : 'environment-building-effect-drop'}
      onDragEnter={dragOver} onDragOver={dragOver} onDrop={drop}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}>
      {environment ? '从特效库拖入建筑外观特效，自动绑定环境模型' : '请先选择环境模型'}
      <label className="inspector-row"><span>快捷添加</span>
        <select aria-label="添加环境建筑物特效" value="" disabled={unavailable}
          onChange={event => { if (isEnvironmentBuildingEffectKind(event.target.value)) createPoiEffect(event.target.value, undefined, ENVIRONMENT_EFFECT_TARGET_ID); }}>
          <option value="">选择特效…</option>
          {ENVIRONMENT_BUILDING_EFFECT_KINDS.map(kind => <option key={kind} value={kind}>{getPoiEffectDefinition(kind).name}</option>)}
        </select>
      </label>
    </div>
    {message && <p role="alert" className="digital-twin-effect-error">{message}</p>}
    {bound.map(entity => <button type="button" key={entity.id} disabled={disabled} onClick={() => selectEntity(entity.id)}>
      配置 {entity.name}{entity.components.poiEffect?.enabled === false ? '（已禁用）' : ''}
    </button>)}
    {bound.length > 1 && <p className="muted">同一环境的建筑特效按先绑定顺序生效；可在特效配置中禁用或删除当前效果。</p>}
    <p className="muted">也可在特效的“绑定目标”中选择“环境模型”。两处使用同一配置，替换环境资源后绑定保留。</p>
  </div>;
}
