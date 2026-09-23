import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PoiEffectComponent } from '../model/components';
import type { EffectConfiguration, EffectDataBinding, EffectDeviceIdentity, EffectFieldMapping } from '../model/effectConfiguration';
import { getEffectParameterDefinitions } from '../model/effectParameterRegistry';
import { effectDeviceIdentity, resolveEffectTargets } from '../model/effectTargets';
import { DIGITAL_TWIN_EFFECT_DEFINITIONS } from '../model/digitalTwinEffect';
import { applyEffectDataMappings } from '../model/effectDataMapping';
import { EffectDataRuntime, type EffectDataResult } from '../../runtime/effects/EffectDataRuntime';
import { useEditorStore } from '../store/editorStore';
import { getEffectDiagnostic, subscribeEffectDiagnostics } from '../../runtime/effects/effectDiagnostics';
import './EffectDataBindingInspector.css';

type Props = { component: PoiEffectComponent; configuration: EffectConfiguration; disabled: boolean; onChange: (configuration: EffectConfiguration, label: string) => void };
type Probe = { runtime: EffectDataRuntime; cancelled: boolean; timer?: ReturnType<typeof setTimeout> };
const STATUS: Record<EffectDataResult['status'], string> = { static: '静态', waiting: '等待数据', online: '在线', stale: '已过期', missing: '设备不存在', invalid: '配置无效', error: '取数失败' };
const SENSITIVE_FIELD = /password|passwd|secret|token|authorization|cookie|credential|api[_-]?key/i;
const FIELD_PATH = /^(?:\$\.)?[\w$\u0080-\uffff-]+(?:\[\d+\])*(?:\.[\w$\u0080-\uffff-]+(?:\[\d+\])*)*$/;
function safePath(value: string, empty = false): boolean {
  return (empty && (value === '' || value === '$')) || (value.length <= 512 && FIELD_PATH.test(value) && !value.split(/[.\[\]]/).some(key => ['__proto__', 'prototype', 'constructor'].includes(key)));
}
function clone(value: EffectDataBinding): EffectDataBinding { return structuredClone(value); }

/** 诊断只显示有界样例，业务返回中的凭据字段不进入界面。 */
function preview(value: unknown, depth = 0): unknown {
  if (depth > 3) return '…';
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 8).map(item => preview(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, child]) => [key, SENSITIVE_FIELD.test(key) ? '（已隐藏）' : preview(child, depth + 1)]));
  return value;
}
function paths(value: unknown, prefix = '', depth = 0): string[] {
  if (!value || typeof value !== 'object' || depth > 3) return [];
  return Object.entries(value).slice(0, 24).flatMap(([key, child]) => {
    if (SENSITIVE_FIELD.test(key)) return [];
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === 'object' ? paths(child, path, depth + 1) : [path];
  }).slice(0, 64);
}

function validateDraft(data: EffectDataBinding, sinks: Set<string>, hasRegionPolygons = false): void {
  const between = (value: number, min: number, max: number, name: string) => { if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name}必须在 ${min}～${max} 之间。`); };
  if (data.mode === 'mqtt' && (!data.sourceId.trim() || !data.deviceType.trim() || !data.assetCode.trim())) throw new Error('独立 MQTT 绑定需要数据源、设备类型和资产编号。');
  if (data.mode === 'http') {
    if (data.http.mode === 'data-source' && !/^[1-9]\d{0,63}$/.test(data.http.dataSourceId)) throw new Error('托管数据源 ID 必须是正整数字符串。');
    if (data.http.mode === 'mqtt-latest' && !data.http.namespace.trim()) throw new Error('最新遥测查询必须配置存储空间，不能使用 MQTT sourceId 代替。');
    between(data.http.pollIntervalMs, 500, 3600000, '轮询间隔'); between(data.http.timeoutMs, 500, 30000, '请求超时');
  }
  between(data.expectedIntervalMs, 50, 60000, '预期更新间隔'); between(data.staleAfterMs, 100, 3600000, '数据过期时长');
  for (const [index, mapping] of data.mappings.entries()) {
    if (!safePath(mapping.field) || !sinks.has(mapping.target)) throw new Error(`第 ${index + 1} 条映射的字段路径或目标属性无效。`);
    between(mapping.scale, -1000000, 1000000, '倍率'); between(mapping.offset, -1000000, 1000000, '偏移');
    if (mapping.values.length > 32) throw new Error('每条映射最多支持 32 个枚举值。');
    if (mapping.values.some(item => typeof item.value !== 'string' || item.value.length > 200 || !['string', 'number', 'boolean'].includes(typeof item.output) || typeof item.output === 'number' && !Number.isFinite(item.output) || typeof item.output === 'string' && item.output.length > 512)) throw new Error(`第 ${index + 1} 条枚举映射无效。`);
    if (new Set(mapping.values.map(item => item.value)).size !== mapping.values.length) throw new Error(`第 ${index + 1} 条枚举映射存在重复值。`);
  }
  if (data.dataset.enabled) {
    between(data.dataset.unitScale ?? 1, .000001, 1000000, '坐标换算倍率');
    for (const [key, value] of Object.entries(data.dataset)) if (key !== 'enabled' && typeof value === 'string' && !safePath(value, ['rowsPath', 'labelPath'].includes(key) || hasRegionPolygons && ['xPath', 'yPath', 'zPath'].includes(key))) throw new Error(`数据集 ${key} 字段路径无效。`);
  }
  if (data.trigger.enabled && !safePath(data.trigger.field)) throw new Error('触发条件字段路径无效。');
  between(data.trigger.debounceMs, 0, 60000, '触发去抖');
}

function EnumDraft({ value, disabled, onChange, onPending, label }: { value: EffectFieldMapping['values']; disabled: boolean; onChange: (value: EffectFieldMapping['values']) => void; onPending: (pending: boolean) => void; label: string }) {
  const saved = JSON.stringify(value, null, 2); const [draft, setDraft] = useState(saved); const [error, setError] = useState('');
  useEffect(() => { setDraft(saved); setError(''); }, [saved]);
  useEffect(() => { onPending(draft !== saved); }, [draft, saved]);
  return <details className="effect-data-enum"><summary>枚举映射（{value.length} 项）</summary>
    <p className="muted">例如 [{'{'}"value":"running","output":"#22ff88"{'}'}]。有枚举时优先匹配，未命中会提示。</p>
    <textarea aria-label={`${label}枚举 JSON`} rows={4} disabled={disabled} maxLength={16384} spellCheck={false} value={draft} onChange={event => { setDraft(event.target.value); setError(''); }} />
    <button type="button" disabled={disabled || draft === saved} onClick={() => {
      try { const parsed = JSON.parse(draft) as unknown;
        if (!Array.isArray(parsed) || parsed.length > 32 || parsed.some(item => !item || typeof item !== 'object' || Object.keys(item).some(key => key !== 'value' && key !== 'output') || typeof item.value !== 'string' || !['string', 'number', 'boolean'].includes(typeof item.output))) throw new Error('请填写最多 32 项的 value/output 数组。');
        onChange(parsed as EffectFieldMapping['values']); setError('');
      } catch (cause) { setError(cause instanceof Error ? cause.message : '枚举 JSON 无效。'); }
    }}>应用枚举草稿</button>
    {draft !== saved && <p className="muted">枚举草稿尚未应用到下方数据配置。</p>}
    {error && <p className="effect-data-error" role="alert">{error}</p>}
  </details>;
}

/** 绑定配置整组应用；试取数只由用户点击启动，不随输入或渲染自动请求。 */
export function EffectDataBindingInspector({ component, configuration, disabled, onChange }: Props) {
  const scene = useEditorStore(state => state.scene); const selectedId = scene.selectedEntityId;
  const saved = JSON.stringify(configuration.data), targetSignature = JSON.stringify(configuration.target);
  const [draft, setDraft] = useState(() => clone(configuration.data));
  const [error, setError] = useState(''); const [result, setResult] = useState<EffectDataResult | null>(null);
  const [issues, setIssues] = useState<string[]>([]); const [busy, setBusy] = useState(false);
  const [pendingEnums, setPendingEnums] = useState<Record<string, boolean>>({});
  const probe = useRef<Probe | null>(null); const inputId = useId();
  // 行身份仅存在于编辑草稿，删除前一行不会把尚未应用的枚举传给后一行。
  const mappingKeys = useRef(new WeakMap<EffectFieldMapping, string>());
  const mappingSequence = useRef(0);
  function mappingKey(mapping: EffectFieldMapping): string {
    let key = mappingKeys.current.get(mapping);
    if (!key) { key = 'mapping-' + ++mappingSequence.current; mappingKeys.current.set(mapping, key); }
    return key;
  }
  const parameterDefinitions = useMemo(() => getEffectParameterDefinitions(component.effectKind), [component.effectKind]);
  const sources = [...new Set(['default', ...scene.mqttConfig.subscriptions.map(subscription => subscription.adapter?.sourceId || 'default')])];
  const genericFields = DIGITAL_TWIN_EFFECT_DEFINITIONS.find(definition => definition.kind === component.effectKind)?.fields ?? [];
  const sinkOptions = [
    { value: 'enabled', label: '启用 / 显隐' }, { value: 'primaryColor', label: '主色' }, { value: 'secondaryColor', label: '辅助色' },
    { value: 'intensity', label: '强度（0～3）' }, { value: 'speed', label: '速度系数（0～5）' }, { value: 'density', label: '密度系数（0～2）' },
    ...Object.entries({ radius: '范围半径', height: '高度', width: '线宽', opacity: '不透明度（0～1）', duration: '周期（秒）', progress: '进度（0～1）', amount: '数量 / 距离' }).filter(([key]) => (genericFields as readonly string[]).includes(key)).map(([key, label]) => ({ value: `visual.${key}`, label })),
    ...parameterDefinitions.filter(definition => definition.bindable).map(definition => ({ value: `configuration.parameters.${definition.key}`, label: definition.label })),
  ];
  const sinkKeys = new Set(sinkOptions.map(option => option.value));
  const hasChanges = JSON.stringify(draft) !== saved;
  const resolution = useMemo(() => resolveEffectTargets(scene, configuration.target, component.effectKind), [scene, targetSignature, component.effectKind]);
  const sceneIdentity = resolution.status === 'resolved' && resolution.ids.length === 1 ? effectDeviceIdentity(scene.entities[resolution.ids[0]]) : null;
  const target = configuration.target;
  // 只有资产编号的完整设备三元组可以脱离实例测试，容器编号不能当作设备号查询。
  const configuredIdentity: EffectDeviceIdentity | null = ['model', 'device'].includes(target.mode)
    && (target.instanceKey ?? 'assetCode') === 'assetCode' && target.sourceId.trim() && target.deviceType.trim() && target.assetCode.trim()
    ? { sourceId: target.sourceId.trim(), deviceType: target.deviceType.trim().toLowerCase(), assetCode: target.assetCode.trim() } : null;
  const diagnostic = useSyncExternalStore(subscribeEffectDiagnostics, () => getEffectDiagnostic(selectedId ?? ''), () => undefined);
  const runtimeIdentity = diagnostic?.bindingSignature === targetSignature
    ? draft.inheritFrom === 'carrier' ? diagnostic.carrierIdentity : diagnostic.targetIdentity : null;
  const identity: EffectDeviceIdentity | null = runtimeIdentity ?? (draft.inheritFrom === 'carrier' ? null : configuredIdentity ?? sceneIdentity);
  const identitySignature = JSON.stringify(identity);
  const hasPendingEnums = draft.mode !== 'none' && draft.mappings.some(mapping => pendingEnums[mappingKey(mapping)]);
  const suggestions = result ? paths(result.fields) : [];
  const hasRegionPolygons = component.effectKind === 'region-level' && Array.isArray(configuration.parameters.regions) && configuration.parameters.regions.length > 0;

  function cancelProbe(): void { const current = probe.current; if (!current) return; current.cancelled = true; if (current.timer) clearTimeout(current.timer); current.runtime.dispose(); probe.current = null; }
  useEffect(() => { cancelProbe(); setBusy(false); setResult(null); setIssues([]); setError(''); setPendingEnums({}); setDraft(clone(configuration.data)); }, [selectedId, saved, component.effectKind]);
  useEffect(() => { cancelProbe(); setBusy(false); setResult(null); setIssues([]); setError(''); }, [targetSignature, identitySignature, disabled]);
  useEffect(() => () => cancelProbe(), []);

  function edit(patch: Partial<EffectDataBinding>): void { cancelProbe(); setBusy(false); setResult(null); setIssues([]); setError(''); setDraft(value => ({ ...value, ...patch })); }
  function editMapping(index: number, patch: Partial<EffectFieldMapping>): void {
    edit({ mappings: draft.mappings.map((mapping, i) => {
      if (i !== index) return mapping;
      const next = { ...mapping, ...patch };
      mappingKeys.current.set(next, mappingKey(mapping));
      return next;
    }) });
  }
  function apply(): void {
    if (disabled || hasPendingEnums) return;
    try { if (draft.mode !== 'none') validateDraft(draft, sinkKeys, hasRegionPolygons); onChange({ ...configuration, data: clone(draft) }, '更新特效数据绑定'); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '数据配置无效。'); }
  }
  function testData(): void {
    if (disabled || busy || hasPendingEnums || draft.mode === 'none') return;
    try { validateDraft(draft, sinkKeys, hasRegionPolygons); } catch (cause) { setError(cause instanceof Error ? cause.message : '数据配置无效。'); return; }
    if (draft.mode === 'inherit' && !identity) { setError(resolution.status === 'ambiguous' || resolution.ids.length > 1 ? '测试继承绑定需要唯一目标，请先按资产编号限定设备。' : '目标尚无完整设备数据身份；可填写目标数据源、协议设备类型和资产编号后测试，容器编号不能代替设备号。'); return; }
    cancelProbe(); setError(''); setBusy(true); setResult(null); setIssues([]);
    const current: Probe = { runtime: new EffectDataRuntime({ maxEntries: 1, maxConcurrent: 1 }), cancelled: false }; probe.current = current;
    const deadline = Date.now() + (draft.mode === 'http' ? draft.http.timeoutMs + 500 : 10000);
    const testBinding = clone(draft);
    const tick = () => {
      if (current.cancelled) return;
      let next = current.runtime.read(testBinding, identity, true);
      if (next.status === 'waiting' && Date.now() >= deadline) next = { ...next, status: 'error', message: '测试等待超时。MQTT 仅复用已有连接，请确认运行预览已接收对应设备数据。' };
      if (next.status !== 'waiting') {
        setResult(next); setIssues(applyEffectDataMappings({ ...component, configuration: { ...configuration, data: testBinding } }, next, { parameterDefinitions }).issues);
        setBusy(false); cancelProbe(); return;
      }
      setResult(next); current.timer = setTimeout(tick, 100);
    };
    tick();
  }
  const number = (label: string, value: number, min: number, max: number, update: (value: number) => void, step = 1) => <label className="number-row"><span>{label}</span><input aria-label={label} disabled={disabled} type="number" min={min} max={max} step={step} value={value} onChange={event => { if (event.target.value !== '' && Number.isFinite(Number(event.target.value))) update(Number(event.target.value)); }} /></label>;
  const text = (label: string, value: string, update: (value: string) => void, placeholder = '', maxLength = 512) => <label className="inspector-row"><span>{label}</span><input aria-label={label} disabled={disabled} value={value} maxLength={maxLength} placeholder={placeholder} spellCheck={false} onChange={event => update(event.target.value)} /></label>;

  return <fieldset className="transform-fieldset effect-data-inspector" disabled={disabled}>
    <legend>数据绑定</legend>
    <label className="inspector-row"><span>数据来源</span><select aria-label="特效数据来源" disabled={disabled} value={draft.mode} onChange={event => edit({ mode: event.target.value as EffectDataBinding['mode'] })}>
      <option value="none">静态配置</option><option value="inherit">继承目标模型 MQTT</option><option value="mqtt">独立 MQTT 设备</option><option value="http">中台托管 HTTP</option>
    </select></label>
    {draft.mode === 'none' ? <p className="muted">使用当前特效参数，无需数据源。切换来源后可配置字段映射和条件触发。</p> : <>
      {draft.mode === 'inherit' && <>
        {component.effectKind === 'target-follow' && <label className="inspector-row"><span>继承身份</span><select aria-label="继承数据身份" disabled={disabled} value={draft.inheritFrom ?? 'target'} onChange={event => edit({ inheritFrom: event.target.value as 'target' | 'carrier' })}><option value="target">目标自身设备</option><option value="carrier">承载目标的设备</option></select></label>}
        <p className="muted">{identity ? `继承：${identity.sourceId} / ${identity.deviceType} / ${identity.assetCode}` : draft.inheritFrom === 'carrier' ? '承载设备身份由生成器在运行时提供；未生成前可使用独立 MQTT 或 HTTP 明确填写设备身份测试。' : '完整的目标数据源、协议类型、资产编号可在模型生成前测试；运行时优先使用实际匹配实例身份。'}</p>
      </>}
      {draft.mode === 'mqtt' && <>
        <label className="inspector-row"><span>MQTT 数据源</span><input aria-label="MQTT 数据源" list={`${inputId}-sources`} disabled={disabled} value={draft.sourceId} maxLength={200} onChange={event => edit({ sourceId: event.target.value })} /></label>
        <datalist id={`${inputId}-sources`}>{sources.map(source => <option key={source} value={source} />)}</datalist>
        {text('协议设备类型', draft.deviceType, value => edit({ deviceType: value }), '例如 rgv', 64)}
        {text('资产编号', draft.assetCode, value => edit({ assetCode: value }), '例如 000317', 128)}
        <p className="muted">复用场景已有 MQTT 连接。数据源、设备类型和资产编号共同确定设备，编号保留前导零。</p>
      </>}
      {draft.mode === 'http' && <>
        <label className="inspector-row"><span>取数方式</span><select aria-label="HTTP 取数方式" disabled={disabled} value={draft.http.mode} onChange={event => edit({ http: { ...draft.http, mode: event.target.value as EffectDataBinding['http']['mode'] } })}>
          <option value="data-source">已注册 HTTP JSON 数据源</option><option value="mqtt-latest">中台设备最新遥测</option>
        </select></label>
        {draft.http.mode === 'data-source' ? text('托管数据源 ID', draft.http.dataSourceId, value => edit({ http: { ...draft.http, dataSourceId: value } }), '数据编排 → 数据源管理中的 ID', 64) : <>
          {text('存储空间 namespace', draft.http.namespace, value => edit({ http: { ...draft.http, namespace: value } }), '与中台存储配置一致', 64)}
          {text('协议设备类型', draft.deviceType, value => edit({ deviceType: value }), identity?.deviceType || '留空时继承唯一目标', 64)}
        </>}
        {text('资产编号', draft.assetCode, value => edit({ assetCode: value }), identity?.assetCode || '留空时继承唯一目标', 128)}
        {number('轮询间隔 (ms)', draft.http.pollIntervalMs, 500, 3600000, value => edit({ http: { ...draft.http, pollIntervalMs: value } }), 100)}
        {number('请求超时 (ms)', draft.http.timeoutMs, 500, 30000, value => edit({ http: { ...draft.http, timeoutMs: value } }), 100)}
        <p className="muted">地址和认证沿用已配置中台。托管数据源接收 runParams.assetCode；存储空间需独立配置，不等同 MQTT 数据源。</p>
      </>}
      <details open><summary>数据时效与失联行为</summary>
        {number('预期更新间隔 (ms)', draft.expectedIntervalMs, 50, 60000, value => edit({ expectedIntervalMs: value }), 50)}
        {number('数据过期时长 (ms)', draft.staleAfterMs, 100, 3600000, value => edit({ staleAfterMs: value }), 100)}
        <label className="inspector-row"><span>缺失 / 过期行为</span><select aria-label="缺失数据行为" disabled={disabled} value={draft.missing} onChange={event => edit({ missing: event.target.value as EffectDataBinding['missing'] })}>
          <option value="pause">暂停效果</option><option value="hide">隐藏效果</option><option value="hold">保持最后有效值</option>
        </select></label>
      </details>
      <details open><summary>字段映射（{draft.mappings.length} / 64）</summary>
        <p className="muted">输入字段使用点分路径，例如 speed 或 data.temperature。倍率和偏移用于单位换算，缺失字段会保留原参数并提示。</p>
        <datalist id={`${inputId}-fields`}>{suggestions.map(path => <option value={path} key={path} />)}</datalist>
        {draft.mappings.map((mapping, index) => <div className="effect-data-mapping" key={mappingKey(mapping)}>
          <div className="effect-data-line"><strong>映射 {index + 1}</strong><button type="button" aria-label={`删除映射 ${index + 1}`} disabled={disabled} onClick={() => edit({ mappings: draft.mappings.filter((_, i) => i !== index) })}>删除</button></div>
          <label className="inspector-row"><span>数据字段</span><input aria-label={`映射 ${index + 1} 数据字段`} disabled={disabled} list={`${inputId}-fields`} maxLength={512} value={mapping.field} spellCheck={false} onChange={event => editMapping(index, { field: event.target.value })} /></label>
          <label className="inspector-row"><span>目标属性</span><select aria-label={`映射 ${index + 1} 目标属性`} disabled={disabled} value={mapping.target} onChange={event => editMapping(index, { target: event.target.value })}>
            {!sinkKeys.has(mapping.target) && <option value={mapping.target}>{mapping.target || '请选择'}（此类型不支持）</option>}
            {sinkOptions.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select></label>
          {!mapping.values.length && <div className="effect-data-two-columns">
            {number(`映射 ${index + 1} 倍率`, mapping.scale, -1000000, 1000000, value => editMapping(index, { scale: value }), 0.01)}
            {number(`映射 ${index + 1} 偏移`, mapping.offset, -1000000, 1000000, value => editMapping(index, { offset: value }), 0.01)}
          </div>}
          <EnumDraft label={`映射 ${index + 1} `} value={mapping.values} disabled={disabled} onChange={value => editMapping(index, { values: value })}
            onPending={pending => { if (pending) { cancelProbe(); setBusy(false); setResult(null); setIssues([]); } setPendingEnums(current => current[mappingKey(mapping)] === pending ? current : { ...current, [mappingKey(mapping)]: pending }); }} />
        </div>)}
        <button type="button" disabled={disabled || draft.mappings.length >= 64} onClick={() => edit({ mappings: [...draft.mappings, { field: '', target: 'enabled', scale: 1, offset: 0, values: [] }] })}>添加字段映射</button>
      </details>
      {['heatmap', 'region-level', 'data-bars'].includes(component.effectKind) && <details open><summary>空间数据集</summary>
        <label className="effect-data-checkbox"><input aria-label="启用空间数据集" disabled={disabled} type="checkbox" checked={draft.dataset.enabled} onChange={event => edit({ dataset: { ...draft.dataset, enabled: event.target.checked } })} />使用数组记录生成空间数据</label>
        {draft.dataset.enabled && <>
          {Object.entries({ rowsPath: '记录数组路径', idPath: '记录 ID 字段', xPath: 'X 坐标字段', yPath: 'Y 坐标字段', zPath: 'Z 坐标字段', valuePath: '数值字段', labelPath: '标签字段（可空）' }).map(([key, label]) => <div key={key}>{text(label, draft.dataset[key as 'rowsPath' | 'idPath' | 'xPath' | 'yPath' | 'zPath' | 'valuePath' | 'labelPath'], value => edit({ dataset: { ...draft.dataset, [key]: value } }), key === 'rowsPath' ? '例如 data.rows，根数组填 $' : '', key === 'rowsPath' ? 512 : 128)}</div>)}
          {number('坐标换算倍率', draft.dataset.unitScale ?? 1, .000001, 1000000, value => edit({ dataset: { ...draft.dataset, unitScale: value } }), .001)}
          <label className="inspector-row"><span>坐标空间</span><select aria-label="数据集坐标空间" disabled={disabled} value={draft.dataset.coordinateSpace ?? 'local'} onChange={event => edit({ dataset: { ...draft.dataset, coordinateSpace: event.target.value as 'local' | 'world' } })}><option value="local">相对特效的局部坐标</option><option value="world">场景世界坐标</option></select></label>
          <p className="muted">最多 64 条记录，换算后单位为米；毫米坐标倍率填 0.001。记录 ID 保持稳定；区域按 ID 对齐，重复 ID 或无效数值会提示。</p>
        </>}
      </details>}
      <details><summary>条件触发</summary>
        <label className="effect-data-checkbox"><input aria-label="启用条件触发" disabled={disabled} type="checkbox" checked={draft.trigger.enabled} onChange={event => edit({ trigger: { ...draft.trigger, enabled: event.target.checked } })} />满足字段条件时启用效果</label>
        {draft.trigger.enabled && <>
          {text('触发字段', draft.trigger.field, value => edit({ trigger: { ...draft.trigger, field: value } }), '例如 runningState')}
          <label className="inspector-row"><span>比较关系</span><select aria-label="触发比较关系" disabled={disabled} value={draft.trigger.operator} onChange={event => edit({ trigger: { ...draft.trigger, operator: event.target.value as EffectDataBinding['trigger']['operator'] } })}>
            {Object.entries({ eq: '等于', ne: '不等于', gt: '大于', gte: '大于或等于', lt: '小于', lte: '小于或等于' }).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></label>
          {text('比较值', draft.trigger.value, value => edit({ trigger: { ...draft.trigger, value } }), '例如 true 或 1', 200)}
          {number('触发去抖 (ms)', draft.trigger.debounceMs, 0, 60000, value => edit({ trigger: { ...draft.trigger, debounceMs: value } }), 50)}
        </>}
      </details>
      <div className="effect-data-actions"><button type="button" disabled={disabled || busy || hasPendingEnums} onClick={testData}>{busy ? '正在测试…' : '测试取数'}</button>
        {busy && <button type="button" disabled={disabled} onClick={() => { cancelProbe(); setBusy(false); }}>停止测试</button>}</div>
      <p className="muted">测试当前草稿，不保存。HTTP 仅点击时取数；MQTT 读取已有连接快照。测试结束后自动停止请求。</p>
      {result && <div className="effect-data-diagnostic" role="status"><strong>状态：{STATUS[result.status]}</strong><p>{result.message}</p>
        <p>最后接收：{result.receivedAt === null ? '—' : new Date(result.receivedAt).toLocaleString()}</p>
        <pre aria-label="特效数据字段样例">{JSON.stringify(preview(Object.keys(result.fields).length ? result.fields : result.data), null, 2) || '暂无字段'}</pre>
        {issues.map((issue, index) => <p className="effect-data-error" key={index}>{issue}</p>)}
      </div>}
    </>}
    <div className="effect-data-actions"><button type="button" disabled={disabled || !hasChanges || hasPendingEnums} onClick={apply}>应用数据配置</button>
      {hasChanges && <button type="button" disabled={disabled} onClick={() => { cancelProbe(); setBusy(false); setDraft(clone(configuration.data)); setError(''); setResult(null); }}>放弃修改</button>}</div>
    {hasChanges && <p className="muted">有尚未应用的数据配置修改。</p>}
    {hasPendingEnums && <p className="muted">请先应用枚举草稿，再测试或应用整组数据配置。</p>}
    {error && <p className="effect-data-error" role="alert">{error}</p>}
  </fieldset>;
}
