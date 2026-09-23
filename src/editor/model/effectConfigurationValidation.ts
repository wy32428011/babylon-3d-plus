import type { PoiEffectComponent } from './components';
import type { EffectConfiguration, EffectDataBinding, EffectParameterDefinition, EffectParameterValue } from './effectConfiguration';
import { effectRequiresTarget, getEffectParameterDefinitions } from './effectParameterRegistry';
import { ENVIRONMENT_EFFECT_TARGET_ID } from './environmentBuildingEffect';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, length = 200) => typeof v === 'string' ? v.trim().slice(0, length) : '';
const num = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
const choice = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => options.includes(v as T) ? v as T : fallback;
const vector = (v: unknown) => { const p = object(v) ? v : {}; return { x: num(p.x, 0, -100000, 100000), y: num(p.y, 0, -100000, 100000), z: num(p.z, 0, -100000, 100000) }; };
export function safeEffectJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 4096;
  if (Array.isArray(value)) return value.length <= 128 && value.every(v => safeEffectJson(v, depth + 1));
  return object(value) && Object.keys(value).length <= 64 && Object.entries(value).every(([key, val]) => !['__proto__', 'constructor', 'prototype'].includes(key) && safeEffectJson(val, depth + 1));
}
export function createDefaultEffectDataBinding(): EffectDataBinding {
  return { mode: 'none', sourceId: '', deviceType: '', assetCode: '', expectedIntervalMs: 500, staleAfterMs: 3000, missing: 'pause',
    http: { mode: 'data-source', dataSourceId: '', namespace: '', pollIntervalMs: 2000, timeoutMs: 10000 }, mappings: [],
    dataset: { enabled: false, rowsPath: '', idPath: 'id', xPath: 'x', yPath: 'y', zPath: 'z', valuePath: 'value', labelPath: 'name' },
    trigger: { enabled: false, field: '', operator: 'eq', value: 'true', debounceMs: 0 } };
}
export function createDefaultEffectConfiguration(component: PoiEffectComponent): EffectConfiguration {
  const id = component.visual?.targetEntityId ?? null;
  return { version: 2, target: { mode: id === ENVIRONMENT_EFFECT_TARGET_ID ? 'environment' : id ? 'entity' : component.effectKind === 'target-follow' ? 'model' : effectRequiresTarget(component.effectKind) ? 'entity' : 'point', entityId: id,
    model: null, sourceId: '', deviceType: '', assetCode: '', selection: 'single', maxTargets: 32, anchor: 'origin', nodePath: '', offset: { x: 0, y: 0, z: 0 } },
    data: createDefaultEffectDataBinding(), parameters: {} };
}

export function sanitizeEffectParameter(value: unknown, definition: EffectParameterDefinition): EffectParameterValue {
  switch (definition.type) {
    case 'number': return num(value, Number(definition.default), definition.min ?? -1000000, definition.max ?? 1000000);
    case 'boolean': return typeof value === 'boolean' ? value : definition.default;
    case 'color': return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : definition.default;
    case 'select': return definition.options?.some(o => o.value === value) ? String(value) : definition.default;
    case 'string': return text(value, 4096);
    case 'vector': return vector(value);
    case 'rows': return Array.isArray(value) && safeEffectJson(value) && value.every(object) ? structuredClone(value) : [];
  }
}

export function sanitizeEffectConfiguration(value: unknown, component: PoiEffectComponent): EffectConfiguration {
  const defaults = createDefaultEffectConfiguration(component), input = object(value) ? value : {};
  const t = object(input.target) ? input.target : {}, d = object(input.data) ? input.data : {}, h = object(d.http) ? d.http : {};
  const ds = object(d.dataset) ? d.dataset : {}, tr = object(d.trigger) ? d.trigger : {}, p = object(input.parameters) ? input.parameters : {};
  const model = object(t.model) ? t.model : null, identity = model && object(model.identity) ? model.identity : null;
  const parameters: Record<string, EffectParameterValue> = {};
  for (const definition of getEffectParameterDefinitions(component.effectKind)) if (Object.prototype.hasOwnProperty.call(p, definition.key)) parameters[definition.key] = sanitizeEffectParameter(p[definition.key], definition);
  return { version: 2, target: {
    mode: choice(t.mode, ['entity','environment','model','device','point'], defaults.target.mode), entityId: text(t.entityId) || null,
    model: model ? { name: text(model.name), sourceUrl: text(model.sourceUrl, 2048), sourcePath: text(model.sourcePath, 2048), deviceType: text(model.deviceType),
      ...(Array.isArray(model.entityIds)?{entityIds:model.entityIds.slice(0,64).map(id=>text(id)).filter(Boolean)}:{}),
      ...(identity && text(identity.sourceKey) && text(identity.resourceId) ? { identity: { sourceKey: text(identity.sourceKey), kind: choice(identity.kind, ['model','combo'], 'model'), resourceId: text(identity.resourceId), modelPath: text(identity.modelPath, 1024) } } : {}) } : null,
    sourceId: text(t.sourceId), deviceType: text(t.deviceType).toLowerCase(), assetCode: text(t.assetCode), selection: ['target-follow','motion-trail'].includes(component.effectKind)?'single':choice(t.selection,['single','all'],'single'),
    ...(t.instanceSource !== undefined ? {instanceSource: choice<'all'|'scene'|'generated'>(t.instanceSource,['all','scene','generated'],'all')} : {}),
    ...(t.generatorId !== undefined ? {generatorId: text(t.generatorId) || null} : {}),
    ...(t.instanceKey !== undefined ? {instanceKey: choice<'assetCode'|'containerCode'|'carrierAssetCode'>(t.instanceKey,['assetCode','containerCode','carrierAssetCode'],'assetCode')} : {}),
    ...(t.followSelection !== undefined ? {followSelection: choice<'unique'|'manual'>(t.followSelection,['unique','manual'],'unique')} : {}),
    maxTargets: Math.round(num(t.maxTargets,32,1,64)), anchor: choice(t.anchor,['origin','center','node'],'origin'), nodePath: text(t.nodePath,1024), offset: vector(t.offset),
  }, data: {
    mode: choice(d.mode,['none','inherit','mqtt','http'],'none'), sourceId: text(d.sourceId), deviceType: text(d.deviceType).toLowerCase(), assetCode: text(d.assetCode),
    ...(d.inheritFrom !== undefined ? {inheritFrom: choice<'target'|'carrier'>(d.inheritFrom,['target','carrier'],'target')} : {}),
    expectedIntervalMs: num(d.expectedIntervalMs,500,50,60000), staleAfterMs: num(d.staleAfterMs,3000,100,3600000), missing: choice(d.missing,['pause','hide','hold'],'pause'),
    http: { mode: choice(h.mode,['data-source','mqtt-latest'],'data-source'), dataSourceId: text(h.dataSourceId), namespace: text(h.namespace,64), pollIntervalMs:num(h.pollIntervalMs,2000,500,3600000),timeoutMs:num(h.timeoutMs,10000,500,30000) },
    mappings: (Array.isArray(d.mappings) ? d.mappings.slice(0,64) : []).filter(object).map(m=>({field:text(m.field,512),target:text(m.target,128),scale:num(m.scale,1,-1000000,1000000),offset:num(m.offset,0,-1000000,1000000),values:(Array.isArray(m.values)?m.values.slice(0,32):[]).filter(object).filter(v=>['string','number','boolean'].includes(typeof v.output)).map(v=>({value:text(v.value),output:v.output as string|number|boolean}))})),
    dataset: { enabled:ds.enabled===true,unitScale:num(ds.unitScale,1,0.000001,1000000),coordinateSpace:choice<'local'|'world'>(ds.coordinateSpace,['local','world'],'local'),rowsPath:text(ds.rowsPath,512),idPath:text(ds.idPath,128),xPath:text(ds.xPath,128),yPath:text(ds.yPath,128),zPath:text(ds.zPath,128),valuePath:text(ds.valuePath,128),labelPath:text(ds.labelPath,128) },
    trigger:{enabled:tr.enabled===true,field:text(tr.field,512),operator:choice(tr.operator,['eq','ne','gt','gte','lt','lte'],'eq'),value:text(tr.value),debounceMs:num(tr.debounceMs,0,0,60000)},
  }, parameters };
}

export function validateEffectConfiguration(value: unknown, kind?: string): void {
  if (!object(value) || value.version !== 2 || !safeEffectJson(value)) throw new Error('特效扩展配置格式无效或超过安全范围。');
  if (!object(value.target) || !object(value.data) || !object(value.parameters)) throw new Error('特效扩展配置缺少目标、数据或参数。');
  if(kind)for(const definition of getEffectParameterDefinitions(kind)){if(Object.prototype.hasOwnProperty.call(value.parameters,definition.key)){const error=definition.validate?.(value.parameters[definition.key]);if(error)throw new Error(error);}}
  if (!['entity','environment','model','device','point'].includes(String(value.target.mode)) || !['none','inherit','mqtt','http'].includes(String(value.data.mode))) throw new Error('特效目标或数据模式无效。');
}
