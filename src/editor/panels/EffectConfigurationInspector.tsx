import { useMemo, useState, useSyncExternalStore, type DragEvent } from 'react';
import type { PoiEffectComponent } from '../model/components';
import type { EffectConfiguration, EffectParameterDefinition, EffectParameterValue, EffectTargetBinding } from '../model/effectConfiguration';
import { createDefaultEffectConfiguration, sanitizeEffectConfiguration, sanitizeEffectParameter, safeEffectJson } from '../model/effectConfigurationValidation';
import { effectRequiresTarget, getEffectParameterDefinitions } from '../model/effectParameterRegistry';
import { getLegacyEffectParameters } from '../model/legacyEffectParameters';
import { createEffectModelReference, effectDeviceIdentity, resolveEffectTargets } from '../model/effectTargets';
import { isEnvironmentBuildingEffectKind } from '../model/environmentBuildingEffect';
import { createModelGeneratorTargetFromAsset } from '../model/modelGenerator';
import { MODEL_ASSET_DRAG_MIME_TYPE, decodeModelAssetDragPayload } from '../assets/AssetDatabase';
import { useEditorStore } from '../store/editorStore';
import { getEffectDiagnostic, subscribeEffectDiagnostics, resumeEffectFollow } from '../../runtime/effects/effectDiagnostics';
import { EffectDataBindingInspector } from './EffectDataBindingInspector';
import './EffectConfigurationInspector.css';

type Props = { component: PoiEffectComponent; disabled: boolean; onChange: (component: PoiEffectComponent, label: string) => void };

function ParameterInput({ definition, value, disabled, commit }: { definition: EffectParameterDefinition; value: EffectParameterValue; disabled: boolean; commit: (value: EffectParameterValue) => void }) {
  const [draft, setDraft] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState('');
  if (definition.type === 'rows') return <div className="effect-parameter-rows"><label>{definition.label}<textarea aria-label={definition.label} value={draft} rows={5} disabled={disabled} maxLength={32000} onChange={event=>{setDraft(event.target.value);setError('');}}/></label>
    <button type="button" disabled={disabled} onClick={()=>{try{const next=JSON.parse(draft);if(!Array.isArray(next)||!safeEffectJson(next))throw Error('请输入有界 JSON 数组');const message=definition.validate?.(next);if(message)throw Error(message);commit(next);setError('');}catch(e){setError(e instanceof Error?e.message:'配置无效');}}}>应用{definition.label}</button>
    {definition.description&&<p className="muted">{definition.description}</p>}{error&&<p role="alert">{error}</p>}</div>;
  if (definition.type === 'vector') {
    const vector = value as {x:number;y:number;z:number};
    return <div className="effect-vector"><span>{definition.label}</span>{(['x','y','z'] as const).map(axis=><label key={axis}>{axis.toUpperCase()}<input aria-label={`${definition.label} ${axis.toUpperCase()}`} type="number" disabled={disabled} value={vector[axis]} step="0.1" onChange={e=>{if(e.target.value&&Number.isFinite(Number(e.target.value)))commit({...vector,[axis]:Number(e.target.value)});}}/></label>)}</div>;
  }
  return <label className="inspector-row" title={definition.description}><span>{definition.label}</span>
    {definition.type === 'boolean' ? <input aria-label={definition.label} type="checkbox" disabled={disabled} checked={value === true} onChange={event=>commit(event.target.checked)}/>
      : definition.type === 'select' ? <select aria-label={definition.label} disabled={disabled} value={String(value)} onChange={event=>commit(event.target.value)}>{definition.options?.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>
        : definition.type === 'color' ? <input aria-label={definition.label} type="color" disabled={disabled} value={String(value)} onChange={event=>commit(event.target.value)}/>
          : <input aria-label={definition.label} key={JSON.stringify(value)} disabled={disabled} type={definition.type==='number'?'number':'text'} defaultValue={String(value)} min={definition.min} max={definition.max} step={definition.step??.1} maxLength={4096}
            onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur();}}
            onBlur={event=>{const next=definition.type==='number'?Number(event.target.value):event.target.value;if(definition.type==='number'&&(!event.target.value||!Number.isFinite(next)))return;commit(sanitizeEffectParameter(next,definition));}}/>}
  </label>;
}

export function EffectConfigurationInspector({ component, disabled, onChange }: Props) {
  const scene = useEditorStore(state=>state.scene);
  const id = scene.selectedEntityId ?? '';
  const definitions = getEffectParameterDefinitions(component.effectKind);
  const configuration = component.configuration ?? createDefaultEffectConfiguration(component);
  const [dropActive, setDropActive] = useState(false), [error, setError] = useState('');
  const diagnostic = useSyncExternalStore(subscribeEffectDiagnostics,()=>getEffectDiagnostic(id),()=>undefined);
  const resolution = useMemo(()=>resolveEffectTargets(scene,configuration.target,component.effectKind),[scene,configuration.target,component.effectKind]);
  const follows = component.effectKind === 'target-follow';
  const generators = scene.entityIds.filter(entityId => !!scene.entities[entityId]?.components.modelGenerator);
  const typeWaiting = follows && configuration.target.mode === 'model' && !!configuration.target.model && resolution.status === 'missing-target';
  const global = ['environment-fog','day-night'].includes(component.effectKind);
  const sourceIds = [...new Set(['default',...(configuration.target.sourceId ? [configuration.target.sourceId] : []),...scene.mqttConfig.subscriptions.map(sub=>sub.adapter.sourceId).filter((s):s is string=>!!s),...Object.values(scene.entities).map(entity=>entity.components.telemetryBinding?.sourceId).filter((s):s is string=>!!s)])];
  function commit(next: EffectConfiguration, label: string) { if(!disabled)onChange({...component,configuration:sanitizeEffectConfiguration(next,component)},label); }
  function target(patch: Partial<EffectTargetBinding>) { commit({...configuration,target:{...configuration.target,...patch}},'更新特效目标绑定'); }
  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();event.stopPropagation();setDropActive(false);if(disabled)return;
    const asset=decodeModelAssetDragPayload(event.dataTransfer.getData(MODEL_ASSET_DRAG_MIME_TYPE));
    const model=asset?createModelGeneratorTargetFromAsset(asset):null;
    if(!model){setError('请从模型库拖入普通模型资源。');return;}
    target({mode:'model',entityId:null,model:createEffectModelReference(asset!,scene),deviceType:model.modelAsset.dataDrivenConfig?.device.devType??'',assetCode:''});setError('');
  }
  if(!component.configuration)return <div className="effect-configuration"><button type="button" disabled={disabled} onClick={()=>{
    const next=createDefaultEffectConfiguration(component);
    const legacy=getLegacyEffectParameters(component.effectKind);
    if(legacy.length&&component.effectKind!=='light-wall-fence')next.parameters=Object.fromEntries(legacy.map(d=>[d.key,structuredClone(d.default)]));
    commit(next,'启用特效详细配置');
  }}>启用详细配置与数据绑定</button><p className="muted">配置模型库匹配、资产编号、数据源和此特效专用参数。旧版效果启用后使用对应专用参数表现，可撤销。</p></div>;
  const groups=[...new Set(definitions.map(definition=>definition.group))];
  return <div className="effect-configuration">
    {!global&&<details open><summary>目标与锚点</summary>
      <label className="inspector-row"><span>目标来源</span><select aria-label="特效目标来源" disabled={disabled} value={configuration.target.mode} onChange={e=>target({mode:e.target.value as EffectTargetBinding['mode']})}>
        {!effectRequiresTarget(component.effectKind)&&<option value="point">特效自身坐标</option>}<option value="entity">场景对象</option><option value="model">模型类型（模型库模板）</option><option value="device">设备身份匹配</option>{isEnvironmentBuildingEffectKind(component.effectKind)&&<option value="environment">环境模型</option>}
      </select></label>
      {configuration.target.mode==='entity'&&<label className="inspector-row"><span>场景对象</span><select aria-label="详细配置场景对象" disabled={disabled} value={configuration.target.entityId??''} onChange={e=>target({entityId:e.target.value||null})}><option value="">请选择</option>{scene.entityIds.filter(e=>e!==id&&!scene.entities[e].components.poiEffect&&(scene.entities[e].components.modelAsset||scene.entities[e].components.meshRenderer)).map(e=><option key={e} value={e}>{scene.entities[e].name} · {effectDeviceIdentity(scene.entities[e])?.assetCode}</option>)}</select></label>}
      {configuration.target.mode==='model'&&<div className={dropActive?'effect-model-drop active':'effect-model-drop'} role="region" aria-label="特效模型模板拖放区" onDrop={drop}
        onDragOver={e=>{if(!disabled&&e.dataTransfer.types.includes(MODEL_ASSET_DRAG_MIME_TYPE)){e.preventDefault();e.stopPropagation();setDropActive(true);}}} onDragLeave={()=>setDropActive(false)}>
        {configuration.target.model?.name??'从模型库拖入一种模型'}<p className="muted">{follows ? '绑定该模型类型；实例可以已在场景中，也可以由生成器在运行时创建。没有实例时仍可保存，不按显示名称匹配。' : '限定该资源的场景实例；不会自动创建模型，也不按显示名称匹配。'}</p>
      </div>}
      {['model','device'].includes(configuration.target.mode)&&<>
        {follows && <>
          <label className="inspector-row"><span>实例来源</span><select aria-label="跟随实例来源" disabled={disabled} value={configuration.target.instanceSource ?? 'all'} onChange={e=>target({instanceSource:e.target.value as EffectTargetBinding['instanceSource']})}><option value="all">全部实例</option><option value="scene">编辑场景模型</option><option value="generated">运行时生成模型</option></select></label>
          {configuration.target.instanceSource !== 'scene' && <label className="inspector-row"><span>生成器范围</span><select aria-label="跟随生成器范围" disabled={disabled} value={configuration.target.generatorId ?? ''} onChange={e=>target({generatorId:e.target.value || null})}><option value="">全部生成器</option>{configuration.target.generatorId && !generators.includes(configuration.target.generatorId) && <option value={configuration.target.generatorId}>生成器不存在（{configuration.target.generatorId}）</option>}{generators.map(generatorId=><option key={generatorId} value={generatorId}>{scene.entities[generatorId].name}</option>)}</select></label>}
          <label className="inspector-row"><span>实例编号类型</span><select aria-label="跟随实例编号类型" disabled={disabled} value={configuration.target.instanceKey ?? 'assetCode'} onChange={e=>target({instanceKey:e.target.value as EffectTargetBinding['instanceKey'],assetCode:''})}><option value="assetCode">设备资产编号</option><option value="containerCode">货物容器编号</option><option value="carrierAssetCode">承载设备资产编号</option></select></label>
          <label className="inspector-row"><span>实例定位方式</span><select aria-label="跟随实例定位方式" disabled={disabled} value={configuration.target.followSelection ?? 'unique'} onChange={e=>target({followSelection:e.target.value as EffectTargetBinding['followSelection']})}><option value="unique">唯一匹配时自动跟随</option><option value="manual">运行时手动选择</option></select></label>
          <p className="muted">编号留空时按类型筛选。多实例需在运行预览或 Viewer 的“目标跟随”面板选择；临时选择不写回场景。</p>
        </>}
        <label className="inspector-row"><span>目标数据源</span><select aria-label="目标数据源" disabled={disabled} value={configuration.target.sourceId} onChange={e=>target({sourceId:e.target.value})}><option value="">不限定</option>{sourceIds.map(source=><option key={source} value={source}>{source}</option>)}</select></label>
        <label className="inspector-row"><span>协议设备类型</span><input aria-label="目标协议设备类型" disabled={disabled} value={configuration.target.deviceType} onChange={e=>target({deviceType:e.target.value})}/></label>
        <label className="inspector-row"><span>{follows && configuration.target.instanceKey === 'containerCode' ? '容器编号' : follows && configuration.target.instanceKey === 'carrierAssetCode' ? '承载设备编号' : '资产编号'}</span><input aria-label="目标资产编号" disabled={disabled} value={configuration.target.assetCode} onChange={e=>target({assetCode:e.target.value})} placeholder="保留前导零，例如 000317"/></label>
        {!follows && <label className="inspector-row"><span>匹配方式</span><select aria-label="目标匹配方式" disabled={disabled||['target-follow','motion-trail'].includes(component.effectKind)} value={configuration.target.selection} onChange={e=>target({selection:e.target.value as 'single'|'all'})}><option value="single">唯一对象</option><option value="all">全部匹配对象</option></select></label>}
        {configuration.target.selection==='all'&&<label className="inspector-row"><span>目标数量上限</span><input type="number" min={1} max={64} disabled={disabled} value={configuration.target.maxTargets} onChange={e=>target({maxTargets:Number(e.target.value)})}/></label>}
      </>}
      {configuration.target.mode!=='point'&&<>
        <label className="inspector-row"><span>锚点</span><select disabled={disabled} value={configuration.target.anchor} onChange={e=>target({anchor:e.target.value as EffectTargetBinding['anchor']})}><option value="origin">模型原点</option><option value="center">包围盒中心</option><option value="node">指定部件</option></select></label>
        {configuration.target.anchor==='node'&&<label className="inspector-row"><span>部件名称/ID</span><input disabled={disabled} value={configuration.target.nodePath} onChange={e=>target({nodePath:e.target.value})}/></label>}
        <ParameterInput definition={{key:'offset',label:'目标局部偏移 (m)',group:'',type:'vector',default:{x:0,y:0,z:0}}} value={configuration.target.offset} disabled={disabled} commit={v=>target({offset:v as EffectTargetBinding['offset']})}/>
      </>}
      <p role="status" className={resolution.status==='resolved'||typeWaiting?'muted':'effect-configuration-error'}>{typeWaiting ? '模型类型已绑定，等待运行时生成匹配实例。' : resolution.message}</p>
      {follows && resolution.candidates.length > 0 && <p className="muted">编辑场景候选 {resolution.candidates.length} 个；运行时将同时检查符合来源和生成器范围的实例。</p>}
      {!follows&&resolution.candidates.length>0&&<details><summary>候选对象（{resolution.candidates.length}）</summary>{resolution.candidates.slice(0,64).map(candidate=><button key={candidate.id} type="button" disabled={disabled} onClick={()=>{
        const identity=effectDeviceIdentity(scene.entities[candidate.id]);target(identity?{assetCode:identity.assetCode,deviceType:identity.deviceType,sourceId:identity.sourceId,selection:'single'}:{mode:'entity',entityId:candidate.id});
      }}>{candidate.name} · {candidate.assetCode||'无资产编号'}</button>)}</details>}
      {error&&<p role="alert">{error}</p>}
    </details>}
    {groups.map(group=><details key={group} open><summary>{group}</summary>{definitions.filter(d=>d.group===group).map(definition=><ParameterInput key={definition.key+JSON.stringify(configuration.parameters[definition.key]??definition.default)} definition={definition} value={configuration.parameters[definition.key]??definition.default} disabled={disabled} commit={value=>commit({...configuration,parameters:{...configuration.parameters,[definition.key]:value}},`更新特效${definition.label}`)}/>)}</details>)}
    <EffectDataBindingInspector component={component} configuration={configuration} disabled={disabled} onChange={commit}/>
    <details><summary>运行诊断</summary><p role="status">{diagnostic?.status??'未运行'}：{diagnostic?.message??'运行预览后查看数据与目标状态'}</p>
      {diagnostic?.identity&&<p className="muted">{diagnostic.identity.sourceId} / {diagnostic.identity.deviceType} / {diagnostic.identity.assetCode}</p>}
      {diagnostic?.updatedAt&&<p className="muted">数据更新：{new Date(diagnostic.updatedAt).toLocaleTimeString()}</p>}
      {component.effectKind==='target-follow'&&<button type="button" onClick={()=>resumeEffectFollow(id)}>恢复跟随</button>}
    </details>
    <button type="button" disabled={disabled} onClick={()=>{const {configuration:unused,...legacy}=component;void unused;onChange(legacy,'取消详细配置，恢复静态特效');}}>取消详细配置</button>
  </div>;
}
