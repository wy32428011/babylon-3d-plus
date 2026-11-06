import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthoringViewport, type ViewportTool } from './viewport';
import { AppearancePanel, ParametersPanel, RulesPanel, RULE_NAMES } from './WorkbenchPanels';
import { addImageAsset, loadCatalogModel, openArchiveCandidate, persistSession, readImportFile, readSavedSession, saveProjectFile } from './io';
import { exportModelPackage, generateModelScript, createGeneratedArtifacts } from './generator';
import { createEmptyProject, newId, type AppearanceLayer, type AuthoringIssue, type AuthoringProject, type AuthoringSession, type CatalogModel, type GeometryRule, type ImportedArchive, type PickedSurface, type SurfaceRegion } from './types';
import './workbench.css';

interface Props { onBackToHome: () => void; onDirtyChange?: (dirty: boolean) => void }
type InspectorTab = 'parameters' | 'rules' | 'appearance';
const TOOLS: { id: ViewportTool; label: string; icon: string }[] = [
  { id: 'select', label: '选部件', icon: 'M5 3l13 9-6 1-3 6z' },
  { id: 'faces', label: '选表面', icon: 'M4 17l6-13 10 13z M10 4l2 13 M4 17l13-7' },
  { id: 'place', label: '放置贴图', icon: 'M3 4h18v16H3z M6 16l5-6 4 4 3-3 M8 8h.01' },
  { id: 'rectangle', label: '矩形区域', icon: 'M4 5h16v14H4z' },
  { id: 'polygon', label: '多边形区域', icon: 'M4 9l8-5 8 6-4 10H7z' },
];
function Icon({ path }: { path: string }) { return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>; }

export default function ParametricWorkbench({ onBackToHome, onDirtyChange }: Props) {
  const [session, setSession] = useState<AuthoringSession>(() => ({ project: createEmptyProject(), assets: new Map() }));
  const sessionRef = useRef(session);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const selectedRef = useRef(selected);
  const [selectedFaces, setSelectedFaces] = useState<Record<string, number[]>>({});
  const [tab, setTab] = useState<InspectorTab>('parameters');
  const [treeTab, setTreeTab] = useState<'parts' | 'regions'>('parts');
  const [tool, setTool] = useState<ViewportTool>('select');
  const [activeLayer, setActiveLayer] = useState<string | null>(null);
  const activeLayerRef = useRef(activeLayer);
  const [issues, setIssues] = useState<AuthoringIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [isolated, setIsolated] = useState(false);
  const [original, setOriginal] = useState(false);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [archive, setArchive] = useState<ImportedArchive | null>(null);
  const [recoverable, setRecoverable] = useState<AuthoringSession | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'model' | 'parts' | 'inspector'>('model');
  const [ready, setReady] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<AuthoringViewport | null>(null);
  const modelInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const pendingImage = useRef<string | null>(null);
  const pendingImageRatio = useRef(1);
  const loadedKey = useRef('');
  const history = useRef<{ past: AuthoringProject[]; future: AuthoringProject[] }>({ past: [], future: [] });
  const [, updateHistory] = useState(0);
  const callbacksRef = useRef({ pick: (_p: PickedSurface, _a: boolean) => {}, place: (_p: PickedSurface) => {}, region: (_r: Omit<SurfaceRegion, 'id' | 'label'>) => {} });
  const project = session.project;
  const sourceKey = project.source ? `${project.id}:${project.source.sha256}:${project.legacy.enabled}` : '';
  const faceCount = Object.values(selectedFaces).reduce((sum, faces) => sum + faces.length, 0);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    let cancelled = false;
    void fetch('/__authoring/catalog').then(response => response.ok && response.headers.get('content-type')?.includes('application/json') ? response.json() : []).then(data => { if (!cancelled && Array.isArray(data)) setCatalog(data); }).catch(() => {});
    void readSavedSession().then(saved => { if (!cancelled) setRecoverable(saved); }).catch(error => { if (!cancelled) setNotice(`本机恢复副本不可用：${String(error)}`); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!canvas.current) return;
    const instance = new AuthoringViewport(canvas.current, {
      onPick: (pick, additive) => callbacksRef.current.pick(pick, additive),
      onPlace: pick => callbacksRef.current.place(pick),
      onRegion: region => callbacksRef.current.region(region),
      onIssues: setIssues, onBusy: setBusy,
    });
    viewport.current = instance; setReady(true);
    return () => { viewport.current = null; instance.dispose(); };
  }, []);
  useEffect(() => {
    if (!ready || !sourceKey || !viewport.current) return;
    let cancelled = false;
    loadedKey.current = '';
    setIssues([]); setOriginal(false);
    const current = sessionRef.current;
    void viewport.current.load(current).then(nodes => {
      if (cancelled) return;
      const latest = sessionRef.current;
      if (!latest.project.nodes.length) {
        const next = { ...latest, project: { ...latest.project, nodes } };
        sessionRef.current = next; setSession(next);
      }
      loadedKey.current = sourceKey;
      viewport.current?.updateSession(sessionRef.current);
      setNotice(`${current.project.name} 已加载，可选择部件开始编排。`);
    }).catch(error => { if (!cancelled) setIssues([{ code: 'load', severity: 'error', message: error instanceof Error ? error.message : String(error) }]); });
    return () => { cancelled = true; };
  }, [ready, sourceKey]);
  useEffect(() => { if (loadedKey.current === sourceKey && sourceKey) viewport.current?.updateSession(session); }, [session, sourceKey]);
  useEffect(() => { selectedRef.current = selected; viewport.current?.setSelection(selected); }, [selected]);
  useEffect(() => { activeLayerRef.current = activeLayer; }, [activeLayer]);
  useEffect(() => { viewport.current?.setTool(tool); }, [tool]);
  useEffect(() => { viewport.current?.setIsolation(isolated); }, [isolated]);
  useEffect(() => { viewport.current?.setFaceSelection(selectedFaces); }, [selectedFaces]);

  const edit = useCallback((mutate: (draft: AuthoringProject) => void) => {
    const current = sessionRef.current;
    const draft = structuredClone(current.project);
    mutate(draft); draft.updatedAt = new Date().toISOString();
    history.current.past.push(current.project); if (history.current.past.length > 60) history.current.past.shift(); history.current.future = [];
    const next = { ...current, project: draft }; sessionRef.current = next; setSession(next); setDirty(true);
    updateHistory(value => value + 1);
  }, []);
  const undo = useCallback((forward = false) => {
    const state = history.current, from = forward ? state.future : state.past, to = forward ? state.past : state.future;
    const nextProject = from.pop(); if (!nextProject) return;
    to.push(sessionRef.current.project);
    const next = { ...sessionRef.current, project: nextProject }; sessionRef.current = next; setSession(next); setDirty(true); updateHistory(value => value + 1);
  }, []);
  const run = async (label: string, action: () => Promise<void>) => {
    setOperation(label); setNotice('');
    try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setOperation(''); }
  };
  const save = useCallback(async () => {
    const snapshot = sessionRef.current;
    if (!snapshot.project.source) return;
    setOperation('正在打包工程');
    try { await persistSession(snapshot); await saveProjectFile(snapshot); if (sessionRef.current === snapshot) setDirty(false); setNotice('工程文件已生成，本机恢复副本已保存。'); }
    catch (error) { setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setOperation(''); }
  }, []);
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
      const input = e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if (!input && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey); }
      if (!input && e.key.toLowerCase() === 'y') { e.preventDefault(); undo(true); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [save, undo]);

  function replaceSession(next: AuthoringSession, isSaved = false) {
    sessionRef.current = next; setSession(next); setDirty(!isSaved);
    history.current = { past: [], future: [] }; updateHistory(value => value + 1);
    setSelected([]); setSelectedFaces({}); setActiveLayer(null); setIsolated(false); setOriginal(false); setCode(null); setTool('select');
    setCatalogOpen(false); setArchive(null); setMobilePanel('model');
  }
  function approveReplace(): boolean { return !dirty || window.confirm('当前工程有未保存修改。是否放弃修改并打开另一模型？'); }
  function importModel(file: File) {
    if (!approveReplace()) return;
    void run('正在读取模型文件', async () => {
      const result = await readImportFile(file);
      if ('project' in result) replaceSession(result);
      else setArchive(result);
    });
  }
  function chooseCatalog(item: CatalogModel) {
    if (!approveReplace()) return;
    void run(`正在打开${item.name}`, async () => replaceSession(await loadCatalogModel(item)));
  }
  function pickNode(id: string, additive = false) {
    setSelected(previous => additive ? previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id] : [id]);
  }
  function makeLayer(region: SurfaceRegion, kind: AppearanceLayer['kind'], imageId?: string) {
    const id = newId('layer');
    const layer: AppearanceLayer = {
      id, label: kind === 'color' ? `颜色区域 ${sessionRef.current.project.layers.length + 1}` : `贴图 ${sessionRef.current.project.layers.length + 1}`,
      kind, regionId: region.id, enabled: true, color: kind === 'color' ? '#247bab' : '#ffffff', opacity: 1, blend: 'replace', textureId: imageId,
      rotation: 0, width: region.width, height: region.height, offset: [0, 0], follow: kind === 'color' ? 'scale' : 'fixed', repeat: [1, 1], uvChannel: 0, lockAspect: kind !== 'color', bindings: {},
    };
    edit(draft => { draft.regions.push(region); draft.layers.push(layer); });
    setActiveLayer(id); setTab('appearance'); setTool('select');
    setNotice(kind === 'color' ? '颜色区域已创建，可调整颜色和范围。' : '贴图已放置，可调整位置、尺寸和角度。');
  }
  function wholeRegion(faces = false): SurfaceRegion {
    const ids = faces ? Object.keys(selectedFaces).filter(id => selectedFaces[id].length) : selectedRef.current;
    return { id: newId('region'), label: faces ? '所选表面' : '所选部件', kind: faces ? 'faces' : 'whole', targets: ids,
      faces: faces ? structuredClone(selectedFaces) : {}, width: 0.2, height: 0.2, depth: 0.02, rotation: 0, offset: [0, 0], points: [], backfaces: false };
  }
  callbacksRef.current.pick = (pick, additive) => {
    pickNode(pick.nodeId, additive);
    if (tool === 'faces') {
      setSelectedFaces(previous => {
        const next = additive ? { ...previous } : {};
        const faces = next[pick.nodeId] ?? [];
        next[pick.nodeId] = faces.includes(pick.faceIndex) ? faces.filter(id => id !== pick.faceIndex) : [...faces, pick.faceIndex];
        return next;
      });
      setTab('appearance');
    }
  };
  callbacksRef.current.place = pick => {
    const current = sessionRef.current.project;
    const layer = current.layers.find(item => item.id === activeLayerRef.current);
    if (!pendingImage.current && layer) {
      edit(draft => {
        const region = draft.regions.find(r => r.id === layer.regionId);
        if (region) { region.anchor = pick.anchor; region.targets = [pick.nodeId]; region.offset = [0, 0]; if (region.kind === 'whole' || region.kind === 'faces') region.kind = 'rectangle'; }
      });
      setNotice('贴图表面锚点已更新。'); return;
    }
    if (!pendingImage.current) { setNotice('请先导入图像，或选中已有贴图层。'); return; }
    const bounds = viewport.current?.getNodeBounds([pick.nodeId]);
    const extent = bounds ? Math.max(...bounds.max.map((v, i) => v - bounds.min[i])) : 1;
    const size = Math.max(0.02, extent * 0.25);
    const region: SurfaceRegion = { ...wholeRegion(), id: newId('region'), label: '贴图覆盖范围', targets: [pick.nodeId], kind: 'rectangle', anchor: pick.anchor, width: size, height: size / pendingImageRatio.current, depth: size * 0.15 };
    makeLayer(region, 'decal', pendingImage.current); pendingImage.current = null;
  };
  callbacksRef.current.region = draft => makeLayer({ ...draft, id: newId('region'), label: draft.kind === 'rectangle' ? '矩形颜色区域' : '多边形颜色区域' }, 'color');

  function addRule(type: GeometryRule['type']) {
    const ids = selectedRef.current;
    const bounds = viewport.current?.getNodeBounds(ids);
    const size = bounds ? Math.max(0.001, bounds.max[0] - bounds.min[0]) : 1;
    const rule: GeometryRule = { id: newId('rule'), label: RULE_NAMES[type], type, enabled: true, targets: [...ids], axis: 'x',
      expression: type === 'color' ? '#247bab' : type === 'visibility' ? '1' : type === 'resize' || type === 'stretch' ? size.toFixed(4) : '0', anchor: 'center', fixedStart: 0, fixedEnd: 0,
      arrayMode: 'count', counts: ['2', '1', '1'], steps: [(size + 0.05).toFixed(4), '1', '1'], fillSpan: (size * 3).toFixed(4), gap: '0.05' };
    edit(draft => draft.rules.push(rule)); setTab('rules');
  }
  function importImage(file: File) {
    if (!sessionRef.current.project.source) { setNotice('请先打开模型，再添加贴图。'); return; }
    void run('正在读取贴图', async () => {
      const asset = await addImageAsset(file);
      const bitmap = await createImageBitmap(file);
      pendingImageRatio.current = bitmap.width / bitmap.height;
      bitmap.close();
      const current = sessionRef.current;
      const assets = new Map(current.assets); assets.set(asset.id, asset);
      const next = { ...current, assets }; sessionRef.current = next; setSession(next);
      edit(draft => { if (!draft.textureAssets.some(a => a.id === asset.id)) { const { bytes: _bytes, ...descriptor } = asset; draft.textureAssets.push(descriptor); } });
      pendingImage.current = asset.id; setActiveLayer(null); setTab('appearance'); setTool('place');
      setNotice('贴图已就绪：在模型表面点击，或按住左键拖动定位。');
    });
  }
  function removeParameter(key: string) {
    const current = sessionRef.current.project;
    const references = JSON.stringify([current.rules, current.layers, current.parameters.filter(p => p.key !== key).map(p => p.expression)]);
    if (new RegExp(`\\b${key}\\b`).test(references)) { setNotice('该参数仍被规则或图层引用，请先解除绑定。'); return; }
    edit(draft => { draft.parameters = draft.parameters.filter(p => p.key !== key); });
  }
  const nodeList = project.nodes.filter(n => n.isMesh && (!search || n.name.toLowerCase().includes(search.toLowerCase())));
  const selectionBounds = viewport.current?.getNodeBounds(selected);
  const errors = issues.filter(issue => issue.severity === 'error');
  const canWork = Boolean(project.source) && !operation;
  const busyText = operation || (busy ? '正在更新模型' : errors.length ? `${errors.length} 项需要处理` : project.source ? '预览已更新' : '等待打开模型');
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const debug = { getProject: () => sessionRef.current.project, getDiagnostics: () => viewport.current?.getDiagnostics(), getScene: () => viewport.current?.scene, createArtifacts: () => createGeneratedArtifacts(sessionRef.current) };
    const host = window as unknown as { __PARAMETRIC_WORKBENCH__?: typeof debug };
    host.__PARAMETRIC_WORKBENCH__ = debug;
    return () => { delete host.__PARAMETRIC_WORKBENCH__; };
  }, []);

  return <main className="pa-workbench" data-mobile-panel={mobilePanel} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => {
    if (!event.dataTransfer.files.length) return; event.preventDefault();
    const file = event.dataTransfer.files[0]; if (file.type.startsWith('image/') && project.source) importImage(file); else importModel(file);
  }}>
    <input hidden ref={modelInput} type="file" accept=".glb,.zip,.pa" onChange={event => { const file = event.target.files?.[0]; if (file) importModel(file); event.target.value = ''; }} />
    <input hidden ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; if (file) importImage(file); event.target.value = ''; }} />
    <header className="pa-header">
      <div className="pa-brand"><button className="pa-back" aria-label="返回首页" type="button" onClick={() => { if (!dirty || window.confirm('工程有未保存修改，是否返回首页？')) onBackToHome(); }}><Icon path="M14 5l-7 7 7 7" /></button><span className="pa-brand-mark"><Icon path="M12 2l9 5v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10" /></span><div><strong>参数化工作台</strong><span>模型与表面编排</span></div></div>
      <div className="pa-document-title"><input aria-label="工程名称" value={project.name} onChange={e => edit(draft => { draft.name = e.target.value; })} /><span className={dirty ? 'pa-dirty' : 'pa-saved'}>{dirty ? '未保存' : '已保存'}</span></div>
      <div className="pa-header-actions"><button type="button" disabled={Boolean(operation)} onClick={() => modelInput.current?.click()}>打开文件</button>{catalog.length ? <button type="button" disabled={Boolean(operation)} onClick={() => setCatalogOpen(true)}>模型库</button> : null}<button type="button" disabled={!canWork} onClick={() => void save()}>保存工程</button><button type="button" className="pa-primary" disabled={!canWork || Boolean(errors.length) || busy} onClick={() => void run('正在生成模型包', async () => { await exportModelPackage(sessionRef.current); setNotice('模型包已生成，包含脚本、元数据及贴图资源。'); })}>导出模型包</button></div>
    </header>
    <div className="pa-commandbar"><div className="pa-history-controls"><button aria-label="撤销" title="撤销 Ctrl+Z" type="button" disabled={!history.current.past.length || Boolean(operation)} onClick={() => undo()}><Icon path="M8 5L3 10l5 5 M3 10h10a7 7 0 017 7" /></button><button aria-label="重做" title="重做 Ctrl+Shift+Z" type="button" disabled={!history.current.future.length || Boolean(operation)} onClick={() => undo(true)}><Icon path="M16 5l5 5-5 5 M21 10h-10a7 7 0 00-7 7" /></button></div><span className="pa-command-separator" /><span className="pa-source-label">{project.source ? `${project.source.fileName} · ${project.legacy.enabled ? '保留模板逻辑' : '可视化配方'}` : 'GLB / 模型 ZIP / 编排工程'}</span><div className="pa-command-right"><label className="pa-checkbox"><input type="checkbox" disabled={!canWork} checked={original} onChange={e => { setOriginal(e.target.checked); viewport.current?.setOriginal(e.target.checked); }} />原始对照</label><button type="button" disabled={!canWork} onClick={() => void run('正在生成脚本', async () => setCode(await generateModelScript(sessionRef.current.project, sessionRef.current.assets)))}>查看脚本</button></div></div>
    <div className="pa-mobile-tabs">{(['parts', 'model', 'inspector'] as const).map(panel => <button type="button" key={panel} className={mobilePanel === panel ? 'is-active' : ''} onClick={() => setMobilePanel(panel)}>{panel === 'parts' ? '部件与区域' : panel === 'model' ? '三维视图' : '参数与外观'}</button>)}</div>
    <div className="pa-body">
      <aside className="pa-sidebar">
        <div className="pa-sidebar-tabs"><button className={treeTab === 'parts' ? 'is-active' : ''} type="button" onClick={() => setTreeTab('parts')}>部件<span>{project.nodes.filter(n => n.isMesh).length}</span></button><button className={treeTab === 'regions' ? 'is-active' : ''} type="button" onClick={() => setTreeTab('regions')}>表面区域<span>{project.regions.length}</span></button></div>
        <div className="pa-search"><Icon path="M10 3a7 7 0 100 14 7 7 0 000-14 M15 15l6 6" /><input aria-label="搜索部件" placeholder="搜索部件名称" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <div className="pa-tree" role="tree" aria-label="模型部件树">
          {project.source ? <div className="pa-tree-root"><Icon path="M12 2l9 5v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10" /><strong>{project.source.name}</strong></div> : null}
          {treeTab === 'parts' ? <>
            {project.parts.map(part => <div className="pa-part-group" key={part.id}><button type="button" aria-label={`选择分组 ${part.label}`} onClick={() => setSelected(part.nodeIds)}><Icon path="M3 6h7l2 2h9v12H3z" /></button><input aria-label="部件组名称" value={part.label} onChange={e => edit(draft => { const group = draft.parts.find(item => item.id === part.id); if (group) group.label = e.target.value; })} /><small>{part.nodeIds.length}</small><button aria-label={`删除分组${part.label}`} type="button" onClick={() => edit(draft => { draft.parts = draft.parts.filter(p => p.id !== part.id); })}>×</button></div>)}
            {nodeList.map(node => <button type="button" role="treeitem" aria-selected={selected.includes(node.id)} key={node.id} className={`pa-tree-node ${selected.includes(node.id) ? 'is-selected' : ''}`} title={`${node.name}\n${node.materialName ?? '无材质'}\n${node.vertexCount} 顶点`} onClick={e => pickNode(node.id, e.ctrlKey || e.metaKey || e.shiftKey)}><Icon path="M12 3l8 5v9l-8 4-8-4V8z M4 8l8 5 8-5 M12 13v8" /><span>{node.name || '未命名部件'}</span><small>{Math.round(node.indexCount / 3).toLocaleString()}</small></button>)}
          </> : project.regions.map(region => <button type="button" className="pa-tree-node" key={region.id} onClick={() => { setSelected(region.targets); const layer = project.layers.find(l => l.regionId === region.id); if (layer) setActiveLayer(layer.id); setTab('appearance'); }}><Icon path="M4 4h16v16H4z M4 12h16 M12 4v16" /><span>{region.label}</span></button>)}
          {project.source && !nodeList.length && treeTab === 'parts' ? <p className="pa-help">{busy ? '正在读取模型结构…' : '没有匹配的部件。'}</p> : null}
          {!project.source ? <p className="pa-empty-small">打开模型后，<br />部件层级将在这里显示。</p> : null}
        </div>
        <div className="pa-selection-info"><div className="pa-row"><strong>{selected.length ? `已选 ${selected.length} 个部件` : '尚未选择部件'}</strong>{faceCount ? <span>{faceCount} 个面</span> : null}</div>
          {selectionBounds ? <div className="pa-dimensions">{['X', 'Y', 'Z'].map((axis, index) => <span key={axis}><small>{axis}</small>{(selectionBounds.max[index] - selectionBounds.min[index]).toFixed(3)}<small>m</small></span>)}</div> : null}
          <div className="pa-two"><button type="button" disabled={!selected.length} onClick={() => viewport.current?.frameSelection()}>聚焦所选</button><button type="button" disabled={!selected.length} className={isolated ? 'is-active' : ''} onClick={() => setIsolated(!isolated)}>{isolated ? '退出隔离' : '隔离显示'}</button></div>
          <button className="pa-wide" disabled={!selected.length} type="button" onClick={() => edit(draft => draft.parts.push({ id: newId('part'), label: `部件组 ${draft.parts.length + 1}`, nodeIds: [...selected] }))}>将所选保存为部件组</button>
          {faceCount ? <button className="pa-text-button" type="button" onClick={() => setSelectedFaces({})}>清空表面选择</button> : null}
        </div>
      </aside>
      <section className="pa-viewport" aria-label="三维模型视口">
        <canvas ref={canvas} tabIndex={0} aria-label="三维模型，点击选择，按 F 聚焦，绘制多边形后按回车完成" />
        {project.source ? <>
          <div className="pa-viewport-tools" role="toolbar" aria-label="三维编辑工具">{TOOLS.map(item => <button type="button" key={item.id} title={item.label} aria-pressed={tool === item.id} className={tool === item.id ? 'is-active' : ''} onClick={() => { setTool(item.id); if (item.id !== 'select') setTab('appearance'); }}><Icon path={item.icon} /><span>{item.label}</span></button>)}</div>
          <div className="pa-view-controls"><button type="button" onClick={() => viewport.current?.setView('iso')}>透视</button><button type="button" onClick={() => viewport.current?.setView('front')}>正面</button><button type="button" onClick={() => viewport.current?.setView('top')}>顶面</button><button type="button" onClick={() => viewport.current?.frameAll()}>全览</button></div>
          <div className="pa-viewport-caption"><span className="pa-coordinate-mark">X <i>Y</i> Z</span><span>模型局部坐标 · 米</span></div>
          <div className="pa-viewport-hint">{tool === 'select' ? '点击选择 · Ctrl / Shift 多选 · 拖动旋转 · 滚轮缩放' : tool === 'faces' ? '点击选择三角面 · Ctrl / Shift 增减 · 右侧创建区域颜色' : tool === 'rectangle' ? '在表面按住左键拖出矩形 · Esc 取消' : tool === 'polygon' ? '在同一表面依次点击顶点 · Enter 完成 · Esc 取消' : '在模型表面点击或拖动定位贴图'}</div>
          {tool === 'polygon' ? <button className="pa-finish-polygon pa-primary" type="button" onClick={() => viewport.current?.finishPolygon()}>完成多边形</button> : null}
        </> : <div className="pa-welcome"><div className="pa-welcome-illustration"><svg viewBox="0 0 200 150" aria-hidden="true"><path d="M35 55L100 20l65 35v55l-65 35-65-35z M35 55l65 35 65-35 M100 90v55" /><path className="pa-illustration-accent" d="M35 55l65-35 65 35-65 35z" /><path className="pa-illustration-dimension" d="M22 61v53 M17 61h10 M17 114h10 M44 125l51 27" /></svg></div><h1>让模型成为可编辑的规则</h1><p>选择部件、定义尺寸、布置贴图与颜色区域。<br />每次操作都能保存，并生成参数化脚本。</p><div className="pa-welcome-actions"><button type="button" className="pa-primary" onClick={() => modelInput.current?.click()}>打开 GLB 或模型包</button>{catalog.length ? <button type="button" onClick={() => setCatalogOpen(true)}>从现有模型库开始</button> : null}</div><small>也可将文件拖入窗口 · 原始模型保持不变</small>{recoverable ? <button className="pa-restore" type="button" onClick={() => replaceSession(recoverable, true)}>恢复本机工程：{recoverable.project.name}</button> : null}</div>}
        {operation ? <div className="pa-operation-overlay" role="status"><span className="pa-spinner" />{operation}</div> : null}
      </section>
      <aside className="pa-inspector">
        <nav className="pa-inspector-tabs" aria-label="编辑器面板">{(['parameters', 'rules', 'appearance'] as const).map(value => <button type="button" key={value} className={tab === value ? 'is-active' : ''} onClick={() => setTab(value)}>{value === 'parameters' ? '参数' : value === 'rules' ? '规则' : '外观'}<span>{value === 'parameters' ? project.parameters.length : value === 'rules' ? project.rules.length : project.layers.length}</span></button>)}</nav>
        <div className="pa-inspector-content">
          {!project.source ? <div className="pa-empty-inspector"><Icon path="M4 7h16 M4 17h16 M9 4v6 M15 14v6" /><h2>从一个模型开始</h2><p>打开模型后，这里会显示参数定义、部件规则和外观设置。</p></div> : <>
            {project.legacy.enabled ? <div className="pa-template-note"><strong>已适配原有模板</strong><p>保留原脚本的尺寸与业务逻辑，新增规则在其后执行。</p></div> : project.legacy.reason ? <div className="pa-template-note"><p>{project.legacy.reason}</p></div> : null}
            {tab === 'parameters' ? <ParametersPanel project={project} issues={issues} change={(key, patch) => edit(draft => { const p = draft.parameters.find(item => item.key === key); if (p) Object.assign(p, patch); })} add={parameter => edit(draft => draft.parameters.push(parameter))} remove={removeParameter} /> : tab === 'rules' ? <RulesPanel project={project} selectedIds={selected} add={addRule} change={(id, patch) => edit(draft => { const rule = draft.rules.find(item => item.id === id); if (rule) Object.assign(rule, patch); })} remove={id => edit(draft => { draft.rules = draft.rules.filter(rule => rule.id !== id); })} selectTargets={setSelected} /> : <AppearancePanel project={project} activeId={activeLayer} setActive={setActiveLayer} selectedCount={selected.length} faceCount={faceCount}
              changeLayer={(id, patch) => edit(draft => {
                const layer = draft.layers.find(item => item.id === id); if (!layer) return;
                const changed = { ...patch };
                if (layer.lockAspect && patch.width !== undefined && patch.height === undefined) changed.height = layer.height * patch.width / layer.width;
                if (layer.lockAspect && patch.height !== undefined && patch.width === undefined) changed.width = layer.width * patch.height / layer.height;
                const region = draft.regions.find(item => item.id === layer.regionId);
                if (layer.kind === 'decal' && region?.kind === 'rectangle') {
                  if (changed.width !== undefined && Math.abs(region.width - layer.width) < 1e-8) region.width = changed.width;
                  if (changed.height !== undefined && Math.abs(region.height - layer.height) < 1e-8) region.height = changed.height;
                }
                Object.assign(layer, changed);
              })}
              changeRegion={(id, patch) => edit(draft => { const region = draft.regions.find(item => item.id === id); if (region) Object.assign(region, patch); })}
              remove={id => edit(draft => { const layer = draft.layers.find(l => l.id === id); draft.layers = draft.layers.filter(l => l.id !== id); if (layer && !draft.layers.some(l => l.regionId === layer.regionId)) draft.regions = draft.regions.filter(r => r.id !== layer.regionId); })}
              move={(id, delta) => edit(draft => { const index = draft.layers.findIndex(l => l.id === id); if (index + delta >= 0 && index + delta < draft.layers.length) { const [layer] = draft.layers.splice(index, 1); draft.layers.splice(index + delta, 0, layer); } })}
              addWhole={() => makeLayer(wholeRegion(), 'color')} addFaces={() => makeLayer(wholeRegion(true), 'color')}
              editFaces={(regionId, mode) => edit(draft => {
                const region = draft.regions.find(item => item.id === regionId); if (!region) return;
                const faces: Record<string, number[]> = mode === 'replace' ? {} : structuredClone(region.faces);
                for (const [nodeId, selected] of Object.entries(selectedFaces)) {
                  const previous = faces[nodeId] ?? [];
                  faces[nodeId] = mode === 'subtract' ? previous.filter(face => !selected.includes(face)) : [...new Set([...previous, ...selected])];
                }
                region.faces = Object.fromEntries(Object.entries(faces).filter(([, values]) => values.length));
                region.targets = Object.keys(region.faces);
                if (!region.targets.length) { draft.layers = draft.layers.filter(layer => layer.regionId !== regionId); draft.regions = draft.regions.filter(item => item.id !== regionId); }
              })}
              upload={() => imageInput.current?.click()} place={() => { pendingImage.current = null; setTool('place'); }} rectangle={() => setTool('rectangle')} polygon={() => setTool('polygon')} />}
          </>}
        </div>
      </aside>
    </div>
    {issues.length ? <div className="pa-issues" role="alert">{issues.map((issue, index) => <button type="button" key={`${issue.code}-${index}`} onClick={() => { if (issue.nodeId) setSelected([issue.nodeId]); if (issue.layerId) { setActiveLayer(issue.layerId); setTab('appearance'); } else if (issue.ruleId) setTab('rules'); else if (issue.parameterKey) setTab('parameters'); }}><span>{issue.severity === 'error' ? '!' : '△'}</span>{issue.message}</button>)}</div> : null}
    <footer className="pa-statusbar"><span className={`pa-status-dot ${errors.length ? 'is-error' : busy || operation ? 'is-busy' : ''}`} /><span role="status">{busyText}</span><span className="pa-status-message">{notice}</span><span>{project.nodes.filter(n => n.isMesh).length} 部件</span><span>{project.rules.length} 规则</span><span>{project.layers.length} 外观层</span></footer>
    {catalogOpen || archive ? <div className="pa-modal-backdrop"><section className="pa-modal" role="dialog" aria-modal="true" aria-label="选择模型"><header><div><h2>{archive ? '选择导入包中的模型' : '现有模型库'}</h2><p>读取原始资源，不覆盖模型包。</p></div><button type="button" aria-label="关闭模型选择" onClick={() => { setCatalogOpen(false); setArchive(null); }}>×</button></header><input className="pa-catalog-search" aria-label="搜索模型库" placeholder="搜索模型名称" value={catalogSearch} onChange={e => setCatalogSearch(e.target.value)} /><div className="pa-model-grid">{archive ? archive.candidates.filter(item => item.name.toLowerCase().includes(catalogSearch.toLowerCase())).map(item => <button type="button" key={item.id} disabled={Boolean(operation)} onClick={() => void run(`正在导入${item.name}`, async () => replaceSession(await openArchiveCandidate(archive, item.id)))}><Icon path="M12 2l9 5v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10" /><strong>{item.name}</strong><small>{item.scriptPaths.length ? '附原始脚本' : '静态模型'}</small></button>) : catalog.filter(item => item.name.toLowerCase().includes(catalogSearch.toLowerCase())).map(item => <button type="button" key={item.id} disabled={Boolean(operation)} onClick={() => chooseCatalog(item)}>{item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <Icon path="M12 2l9 5v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10" />}<strong>{item.name}</strong><small>{item.scripts.length ? '参数化模型' : '静态模型'}</small></button>)}</div>{operation ? <p className="pa-help">{operation}</p> : null}</section></div> : null}
    {code !== null ? <div className="pa-modal-backdrop"><section className="pa-modal pa-code-modal" role="dialog" aria-modal="true" aria-label="生成的参数化脚本"><header><div><h2>参数化脚本</h2><p>由当前配方生成；预览与导出共用规则实现。</p></div><button type="button" aria-label="关闭脚本预览" onClick={() => setCode(null)}>×</button></header><textarea readOnly aria-label="生成的 TypeScript 脚本" spellCheck={false} value={code} /></section></div> : null}
  </main>;
}
