import { useState, type ReactNode } from 'react';
import { resolveParameterValues } from './expression';
import type { AppearanceLayer, AuthoringParameter, AuthoringProject, GeometryRule, SurfaceRegion, AuthoringIssue } from './types';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="pa-field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}
export function Numeric({ value, onChange, min, max, step = 0.01, label }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; label?: string }) {
  return <input aria-label={label} type="number" value={Number.isFinite(value) ? value : ''} min={min} max={max} step={step} onChange={e => { if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber)) onChange(e.target.valueAsNumber); }} />;
}
const displayScale = (parameter: AuthoringParameter) => parameter.unit === 'mm' ? 1000 : parameter.unit === 'cm' ? 100 : 1;
export const RULE_NAMES: Record<GeometryRule['type'], string> = { resize: '轴向尺寸', stretch: '固定两端伸缩', translate: '位置偏移', rotate: '绕中心旋转', array: '部件阵列', visibility: '显隐', color: '整件颜色' };

export function ParametersPanel({ project, issues, change, add, remove }: {
  project: AuthoringProject; issues: AuthoringIssue[];
  change: (key: string, patch: Partial<AuthoringParameter>) => void;
  add: (parameter: AuthoringParameter) => void; remove: (key: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('长度');
  const [key, setKey] = useState('length');
  const [type, setType] = useState<AuthoringParameter['type']>('number');
  const [error, setError] = useState('');
  const resolved = resolveParameterValues(project.parameters).values;
  const shownValue = (parameter: AuthoringParameter) => Number(parameter.expression ? resolved[parameter.key] ?? parameter.value : parameter.value) * displayScale(parameter);
  return <>
    <div className="pa-section-head"><div><h2>模型参数</h2><p>定义输入，驱动部件与外观。</p></div><button onClick={() => setCreating(!creating)} type="button">＋ 新增</button></div>
    {creating ? <form className="pa-create-form" onSubmit={e => {
      e.preventDefault();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) { setError('标识请使用英文字母开头的字母、数字或下划线。'); return; }
      if (project.parameters.some(p => p.key === key)) { setError('这个参数标识已存在。'); return; }
      const value = type === 'number' ? 1 : type === 'boolean' ? true : type === 'color' ? '#246da0' : '';
      add({ key, label: label || key, type, value, defaultValue: value, ...(type === 'number' ? { step: 0.01, unit: 'm' } : {}) });
      setCreating(false); setError(''); setKey(`parameter${project.parameters.length + 2}`);
    }}>
      <Field label="显示名称"><input value={label} onChange={e => setLabel(e.target.value)} /></Field>
      <Field label="参数标识" hint="在规则表达式中使用此标识。"><input value={key} onChange={e => setKey(e.target.value)} spellCheck={false} /></Field>
      <Field label="类型"><select value={type} onChange={e => setType(e.target.value as AuthoringParameter['type'])}><option value="number">数值</option><option value="boolean">开关</option><option value="color">颜色</option><option value="string">文本</option></select></Field>
      {error ? <p className="pa-error" role="alert">{error}</p> : null}<button className="pa-primary" type="submit">创建参数</button>
    </form> : null}
    {!project.parameters.length ? <div className="pa-empty-small">从尺寸、数量或颜色开始。<br />创建参数后，在“规则”中绑定选中的部件。</div> : null}
    <div className="pa-parameter-list">{project.parameters.map(parameter => <section className="pa-parameter" key={parameter.key} data-parameter={parameter.key}>
      <div className="pa-row"><label htmlFor={`pa-param-${parameter.key}`}>{parameter.label}</label><span className="pa-unit">{parameter.unit}</span></div>
      {parameter.type === 'number' ? <div className="pa-number-row"><input id={`pa-param-${parameter.key}`} aria-label={parameter.label} type="number" value={shownValue(parameter)} step={(parameter.step ?? 0.01) * displayScale(parameter)} min={parameter.min === undefined ? undefined : parameter.min * displayScale(parameter)} max={parameter.max === undefined ? undefined : parameter.max * displayScale(parameter)} disabled={Boolean(parameter.expression)} onChange={e => { if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber)) change(parameter.key, { value: e.target.valueAsNumber / displayScale(parameter) }); }} />{parameter.min !== undefined && parameter.max !== undefined ? <input aria-label={`${parameter.label}滑块`} type="range" min={parameter.min * displayScale(parameter)} max={parameter.max * displayScale(parameter)} step={(parameter.step ?? 0.01) * displayScale(parameter)} value={shownValue(parameter)} disabled={Boolean(parameter.expression)} onChange={e => change(parameter.key, { value: Number(e.target.value) / displayScale(parameter) })} /> : null}</div> : parameter.type === 'boolean' ? <label className="pa-checkbox"><input id={`pa-param-${parameter.key}`} type="checkbox" checked={Boolean(parameter.value)} onChange={e => change(parameter.key, { value: e.target.checked })} />{parameter.value ? '开启' : '关闭'}</label> : parameter.type === 'color' ? <div className="pa-color-row"><input id={`pa-param-${parameter.key}`} aria-label={parameter.label} type="color" value={String(parameter.value)} onChange={e => change(parameter.key, { value: e.target.value })} /><input aria-label={`${parameter.label}颜色值`} value={String(parameter.value)} onChange={e => change(parameter.key, { value: e.target.value })} /></div> : <input id={`pa-param-${parameter.key}`} value={String(parameter.value)} onChange={e => change(parameter.key, { value: e.target.value })} />}
      {issues.filter(i => i.parameterKey === parameter.key).map((i, index) => <p className="pa-error" key={index}>{i.message}</p>)}
      <details className="pa-details"><summary><code>{parameter.key}</code><span>定义与约束</span></summary><div className="pa-details-body">
        <Field label="显示名称"><input value={parameter.label} onChange={e => change(parameter.key, { label: e.target.value })} /></Field>
        {parameter.type === 'number' ? <><div className="pa-two"><Field label="最小值"><input type="number" value={parameter.min === undefined ? '' : parameter.min * displayScale(parameter)} onChange={e => change(parameter.key, { min: e.target.value === '' ? undefined : Number(e.target.value) / displayScale(parameter) })} /></Field><Field label="最大值"><input type="number" value={parameter.max === undefined ? '' : parameter.max * displayScale(parameter)} onChange={e => change(parameter.key, { max: e.target.value === '' ? undefined : Number(e.target.value) / displayScale(parameter) })} /></Field></div><div className="pa-two"><Field label="步进"><Numeric value={(parameter.step ?? 0.01) * displayScale(parameter)} min={0.000001} onChange={step => change(parameter.key, { step: step / displayScale(parameter) })} /></Field><Field label="显示单位" hint="mm/cm 仅切换显示；尺寸表达式和导出统一使用米。"><input value={parameter.unit ?? ''} onChange={e => change(parameter.key, { unit: e.target.value })} /></Field></div><Field label="派生表达式" hint="留空为自由输入；可引用其他参数，支持 min、max、floor、ceil、abs、clamp。"><input placeholder="例如 length - 0.2" value={parameter.expression ?? ''} onChange={e => change(parameter.key, { expression: e.target.value || undefined })} /></Field></> : null}
        <div className="pa-row"><button type="button" onClick={() => change(parameter.key, { defaultValue: parameter.value })}>设为默认值</button><button className="pa-danger-text" type="button" onClick={() => remove(parameter.key)}>删除参数</button></div>
      </div></details>
    </section>)}</div>
    {project.parameters.length ? <button className="pa-wide" onClick={() => project.parameters.forEach(p => change(p.key, { value: p.defaultValue }))} type="button">恢复参数默认值</button> : null}
  </>;
}

export function RulesPanel({ project, selectedIds, add, change, remove, selectTargets }: {
  project: AuthoringProject; selectedIds: string[]; add: (type: GeometryRule['type']) => void;
  change: (id: string, patch: Partial<GeometryRule>) => void; remove: (id: string) => void; selectTargets: (ids: string[]) => void;
}) {
  const [kind, setKind] = useState<GeometryRule['type']>('resize');
  return <>
    <div className="pa-section-head"><div><h2>部件变化规则</h2><p>参数可以同时驱动多条规则。</p></div></div>
    <div className="pa-create-rule"><select aria-label="新规则类型" value={kind} onChange={e => setKind(e.target.value as GeometryRule['type'])}>{Object.entries(RULE_NAMES).map(([k, name]) => <option key={k} value={k}>{name}</option>)}</select><button className="pa-primary" type="button" disabled={!selectedIds.length} onClick={() => add(kind)}>绑定所选</button></div>
    <p className="pa-help">{selectedIds.length ? `将绑定当前选中的 ${selectedIds.length} 个部件。` : '先在视口或部件树中选择目标。'}</p>
    {!project.rules.length ? <div className="pa-empty-small">规则记录“哪个部件，沿哪条轴，如何变化”。<br />可引用参数标识，也可直接输入数值。</div> : null}
    {project.rules.map(rule => <details className="pa-rule-card" key={rule.id} open>
      <summary><span className="pa-rule-dot" /><strong>{rule.label}</strong><span>{RULE_NAMES[rule.type]}</span></summary>
      <div className="pa-rule-body">
        <div className="pa-row"><label className="pa-checkbox"><input type="checkbox" checked={rule.enabled} onChange={e => change(rule.id, { enabled: e.target.checked })} />启用</label><button type="button" onClick={() => selectTargets(rule.targets)}>{rule.targets.length} 个目标</button></div>
        <Field label="规则名称"><input value={rule.label} onChange={e => change(rule.id, { label: e.target.value })} /></Field>
        {!['visibility', 'color'].includes(rule.type) ? <div className="pa-two"><Field label="方向"><select value={rule.axis} onChange={e => change(rule.id, { axis: e.target.value as GeometryRule['axis'] })}><option value="x">X 轴</option><option value="y">Y 轴</option><option value="z">Z 轴</option></select></Field><Field label="基准"><select value={rule.anchor} onChange={e => change(rule.id, { anchor: e.target.value as GeometryRule['anchor'] })}><option value="min">负向端固定</option><option value="center">中心固定</option><option value="max">正向端固定</option></select></Field></div> : null}
        {rule.type !== 'array' ? <Field label={rule.type === 'color' ? '颜色值或颜色参数' : rule.type === 'visibility' ? '布尔参数或 0 / 1' : rule.type === 'rotate' ? '角度表达式（°）' : '目标值表达式（m）'}><input value={rule.expression} onChange={e => change(rule.id, { expression: e.target.value })} spellCheck={false} /></Field> : <>
          <Field label="排列方式"><select value={rule.arrayMode ?? 'count'} onChange={e => change(rule.id, { arrayMode: e.target.value as 'count' | 'fill' })}><option value="count">指定三轴数量</option><option value="fill">沿选定轴铺满范围</option></select></Field>
          {rule.arrayMode === 'fill' ? <div className="pa-two"><Field label="可用跨度（m）"><input value={rule.fillSpan ?? '1'} onChange={e => change(rule.id, { fillSpan: e.target.value })} /></Field><Field label="部件间隙（m）"><input value={rule.gap ?? '0.05'} onChange={e => change(rule.id, { gap: e.target.value })} /></Field></div> : <>{(['x', 'y', 'z'] as const).map((axis, index) => <div className="pa-two" key={axis}><Field label={`${axis.toUpperCase()} 数量`}><input value={rule.counts?.[index] ?? '1'} onChange={e => { const counts = [...(rule.counts ?? ['1', '1', '1'])] as [string, string, string]; counts[index] = e.target.value; change(rule.id, { counts }); }} /></Field><Field label={`${axis.toUpperCase()} 步距（m）`}><input value={rule.steps?.[index] ?? '1'} onChange={e => { const steps = [...(rule.steps ?? ['1', '1', '1'])] as [string, string, string]; steps[index] = e.target.value; change(rule.id, { steps }); }} /></Field></div>)}</>}
        </>}
        {rule.type === 'stretch' ? <div className="pa-two"><Field label="负向刚性区（m）"><Numeric value={rule.fixedStart ?? 0} min={0} onChange={fixedStart => change(rule.id, { fixedStart })} /></Field><Field label="正向刚性区（m）"><Numeric value={rule.fixedEnd ?? 0} min={0} onChange={fixedEnd => change(rule.id, { fixedEnd })} /></Field></div> : null}
        <div className="pa-row"><button disabled={!selectedIds.length} type="button" onClick={() => change(rule.id, { targets: [...selectedIds] })}>改绑当前选择</button><button className="pa-danger-text" type="button" onClick={() => remove(rule.id)}>删除规则</button></div>
      </div>
    </details>)}
  </>;
}

export function AppearancePanel({ project, activeId, setActive, changeLayer, changeRegion, remove, move, addWhole, addFaces, upload, place, rectangle, polygon, selectedCount, faceCount, editFaces }: {
  project: AuthoringProject; activeId: string | null; setActive: (id: string) => void;
  changeLayer: (id: string, patch: Partial<AppearanceLayer>) => void;
  changeRegion: (id: string, patch: Partial<SurfaceRegion>) => void;
  remove: (id: string) => void; move: (id: string, delta: number) => void;
  addWhole: () => void; addFaces: () => void; upload: () => void; place: () => void;
  rectangle: () => void; polygon: () => void; selectedCount: number; faceCount: number;
  editFaces: (regionId: string, mode: 'replace' | 'add' | 'subtract') => void;
}) {
  const layer = project.layers.find(l => l.id === activeId);
  const region = project.regions.find(r => r.id === layer?.regionId);
  return <>
    <div className="pa-section-head"><div><h2>表面与颜色</h2><p>定位贴图，定义独立改色范围。</p></div></div>
    <div className="pa-surface-actions"><button type="button" disabled={!selectedCount} onClick={addWhole}>整件改色</button><button type="button" disabled={!faceCount} onClick={addFaces}>所选面改色</button><button type="button" onClick={rectangle}>绘制矩形区域</button><button type="button" onClick={polygon}>绘制多边形区域</button><button type="button" className="pa-primary" onClick={upload}>导入贴图并放置</button></div>
    <div className="pa-layer-list">{project.layers.map((item, index) => <div className={`pa-layer-row ${item.id === activeId ? 'is-active' : ''}`} key={item.id}>
      <input aria-label={`${item.label}显隐`} type="checkbox" checked={item.enabled} onChange={e => changeLayer(item.id, { enabled: e.target.checked })} />
      <button type="button" onClick={() => setActive(item.id)}><span className="pa-layer-swatch" style={{ background: item.kind === 'color' ? item.color : '#d4e4f0' }}>{item.kind !== 'color' ? '▧' : ''}</span><span>{item.label}<small>{item.kind === 'color' ? '区域颜色' : item.kind === 'decal' ? '表面贴花' : 'UV 纹理'}</small></span></button>
      <button aria-label={`上移${item.label}`} type="button" disabled={index === 0} onClick={() => move(item.id, -1)}>↑</button>
      <button aria-label={`下移${item.label}`} type="button" disabled={index === project.layers.length - 1} onClick={() => move(item.id, 1)}>↓</button>
    </div>)}</div>
    {!layer || !region ? <div className="pa-empty-small">选中部件后创建颜色层，<br />或导入一张图片，在模型表面点击放置。</div> : <section className="pa-appearance-properties">
      <div className="pa-row"><h3>图层属性</h3><button className="pa-danger-text" type="button" onClick={() => remove(layer.id)}>删除图层</button></div>
      <Field label="名称"><input value={layer.label} onChange={e => changeLayer(layer.id, { label: e.target.value })} /></Field>
      <Field label="外观方式"><select value={layer.kind} onChange={e => changeLayer(layer.id, { kind: e.target.value as AppearanceLayer['kind'] })}><option value="color">局部颜色</option><option value="decal">表面贴花</option><option value="texture">UV 表面纹理</option></select></Field>
      {layer.kind === 'color' ? <><Field label="颜色"><div className="pa-color-row"><input aria-label="区域颜色" type="color" value={layer.color} onChange={e => changeLayer(layer.id, { color: e.target.value })} /><input aria-label="区域颜色值" value={layer.color} onChange={e => changeLayer(layer.id, { color: e.target.value })} /></div></Field><Field label="颜色合成"><select value={layer.blend} onChange={e => changeLayer(layer.id, { blend: e.target.value as 'tint' | 'replace' })}><option value="replace">覆盖基础颜色</option><option value="tint">保留纹理细节调色</option></select></Field></> : <Field label="图像资源"><select value={layer.textureId ?? ''} onChange={e => changeLayer(layer.id, { textureId: e.target.value })}><option value="">选择图像</option>{project.textureAssets.map(image => <option key={image.id} value={image.id}>{image.fileName}</option>)}</select></Field>}
      <Field label={`不透明度 ${Math.round(layer.opacity * 100)}%`}><input aria-label="图层不透明度" type="range" min={0} max={1} step={0.01} value={layer.opacity} onChange={e => changeLayer(layer.id, { opacity: Number(e.target.value) })} /></Field>
      {layer.kind !== 'color' ? <>
        <div className="pa-two"><Field label="贴图宽度（m）"><Numeric value={layer.width} min={0.0001} onChange={width => changeLayer(layer.id, { width })} /></Field><Field label="贴图高度（m）"><Numeric value={layer.height} min={0.0001} onChange={height => changeLayer(layer.id, { height })} /></Field></div>
        <label className="pa-checkbox"><input type="checkbox" checked={Boolean(layer.lockAspect)} onChange={e => changeLayer(layer.id, { lockAspect: e.target.checked })} />锁定贴图宽高比</label>
        <Field label="贴图旋转（°）"><Numeric value={layer.rotation} step={1} onChange={rotation => changeLayer(layer.id, { rotation })} /></Field>
        <div className="pa-two">{[0, 1].map(index => <Field key={index} label={`${index ? '纵向' : '横向'}贴图偏移${layer.kind === 'texture' ? '（UV）' : '（m）'}`}><Numeric value={layer.offset[index]} onChange={value => { const offset = [...layer.offset] as [number, number]; offset[index] = value; changeLayer(layer.id, { offset }); }} /></Field>)}</div>
        {layer.kind === 'texture' ? <><div className="pa-two">{[0, 1].map(index => <Field key={index} label={`${index ? 'V' : 'U'} 重复次数`}><Numeric value={layer.repeat[index]} min={0.001} onChange={value => { const repeat = [...layer.repeat] as [number, number]; repeat[index] = value; changeLayer(layer.id, { repeat }); }} /></Field>)}</div><Field label="UV 通道"><select value={layer.uvChannel} onChange={e => changeLayer(layer.id, { uvChannel: Number(e.target.value) as 0 | 1 })}><option value={0}>UV 0</option><option value={1}>UV 1</option></select></Field></> : <button type="button" className="pa-wide" onClick={place}>在模型表面重新定位</button>}
      </> : null}
      <Field label="尺寸变化时"><select value={layer.follow} onChange={e => changeLayer(layer.id, { follow: e.target.value as AppearanceLayer['follow'] })}><option value="fixed">锚定表面，保持实际大小</option><option value="scale">随部件尺寸缩放</option><option value="tile">保持平铺密度</option></select></Field>
      <details className="pa-details" open><summary>区域范围<span>{region.kind === 'whole' ? '整个部件' : region.kind === 'faces' ? '所选面' : region.kind === 'rectangle' ? '矩形遮罩' : '多边形遮罩'}</span></summary><div className="pa-details-body">
        <Field label="区域名称"><input value={region.label} onChange={e => changeRegion(region.id, { label: e.target.value })} /></Field>
        {region.kind === 'faces' ? <><div className="pa-two"><button type="button" disabled={!faceCount} onClick={() => editFaces(region.id, 'add')}>加入所选面</button><button type="button" disabled={!faceCount} onClick={() => editFaces(region.id, 'subtract')}>减去所选面</button></div><button className="pa-wide" type="button" disabled={!faceCount} onClick={() => editFaces(region.id, 'replace')}>用当前面选择替换区域</button></> : null}
        {region.kind === 'polygon' ? <details className="pa-details"><summary>多边形顶点<span>相对宽高比例</span></summary><div className="pa-details-body">{region.points.map((point, index) => <div className="pa-two" key={index}><Field label={`顶点 ${index + 1} · U`}><Numeric value={point[0]} step={0.01} onChange={value => changeRegion(region.id, { points: region.points.map((p, i) => i === index ? [value, p[1]] : p) })} /></Field><Field label={`顶点 ${index + 1} · V`}><Numeric value={point[1]} step={0.01} onChange={value => changeRegion(region.id, { points: region.points.map((p, i) => i === index ? [p[0], value] : p) })} /></Field></div>)}</div></details> : null}
        {region.anchor ? <><div className="pa-two"><Field label="区域宽度（m）"><Numeric value={region.width} min={0.0001} onChange={width => changeRegion(region.id, { width })} /></Field><Field label="区域高度（m）"><Numeric value={region.height} min={0.0001} onChange={height => changeRegion(region.id, { height })} /></Field></div><div className="pa-two">{[0, 1].map(index => <Field key={index} label={`${index ? '纵向' : '横向'}区域偏移（m）`}><Numeric value={region.offset[index]} onChange={value => { const offset = [...region.offset] as [number, number]; offset[index] = value; changeRegion(region.id, { offset }); }} /></Field>)}</div><div className="pa-two"><Field label="区域旋转（°）"><Numeric value={region.rotation} step={1} onChange={rotation => changeRegion(region.id, { rotation })} /></Field><Field label="投影深度（m）"><Numeric value={region.depth} min={0.0001} onChange={depth => changeRegion(region.id, { depth })} /></Field></div><label className="pa-checkbox"><input type="checkbox" checked={region.backfaces} onChange={e => changeRegion(region.id, { backfaces: e.target.checked })} />允许作用于背面</label></> : <p className="pa-help">{region.targets.length} 个部件，{Object.values(region.faces).reduce((sum, ids) => sum + ids.length, 0)} 个指定面。</p>}
      </div></details>
      <details className="pa-details"><summary>绑定外观参数<span>位置、尺寸与颜色</span></summary><div className="pa-details-body">{(['color', 'visible', 'width', 'height', 'rotation', 'opacity', 'offsetU', 'offsetV'] as const).map(binding => <Field key={binding} label={({ color: '颜色参数', visible: '显隐参数', width: '宽度表达式', height: '高度表达式', rotation: '角度表达式', opacity: '透明度表达式', offsetU: '横向位置表达式', offsetV: '纵向位置表达式' })[binding]}><input placeholder="留空使用上方设置" value={layer.bindings[binding] ?? ''} onChange={e => changeLayer(layer.id, { bindings: { ...layer.bindings, [binding]: e.target.value || undefined } })} /></Field>)}</div></details>
    </section>}
  </>;
}
