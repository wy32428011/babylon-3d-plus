import { PARTS, createStage } from './assembly.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const paths = {
  cube: '<path d="m12 3 9 5v9l-9 5-9-5V8z"/><path d="m3 8 9 5 9-5M12 13v9M7.5 5.5l9 5"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9zM2 13l10 6 10-6M2 17l10 6 10-6"/>',
  alert: '<path d="M10.3 4.2 2.1 18.4A1.5 1.5 0 0 0 3.4 21h17.2a1.5 1.5 0 0 0 1.3-2.6L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9v5M12 17h.01"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6"/>',
  reset: '<path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  tag: '<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  chart: '<path d="M3 3v18h18M6 15l4-5 4 3 6-8"/>',
  gear: '<path d="m9 3 1-2h4l1 2 3 2 2 .2 2 3-1 2v4l1 2-2 3-2 .2-3 2-1 2h-4l-1-2-3-2-2-.2-2-3 1-2v-4l-1-2 2-3L6 5z"/><circle cx="12" cy="12" r="4"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  book: '<path d="M3 3h7l2 2 2-2h7v17h-7l-2 2-2-2H3zM12 5v17"/>',
};
function icon(name, size = 16) { return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.cube}</svg>`; }
const state = {
  view: ['runtime', 'editor', 'platform'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'runtime',
  open: true, part: 'drive.motor', progress: 68, isolated: false, labels: true, dataTab: 'live', chartTable: false,
  editorStep: 2, platformStep: 1, editorDirty: false, editorSaved: false, platformSaved: false,
  editor: { assetCode: 'CV-021', namespace: 'warehouse_demo', deviceType: 'conveyor', deviceNo: 'CV021', model: '6m', version: 'v1.3', direction: '+X', distance: '1.5', click: true },
  partSettings: Object.fromEntries(PARTS.map((item) => [item.key, { direction: item.direction === '固定' ? '+X' : item.direction, distance: String(item.distance) }])),
  config: { enabled: true, layout: 'side', scene: 'warehouse', binding: 'stable', event: 'open', keys: ['namespace', 'deviceType', 'deviceNo', 'partKey'], required: true },
};
let stages = [];
let detailStage;
let toastTimer;
let lastFocus;
let modalCleanup;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3800);
}
function disposeStages() { stages.forEach((stage) => stage.dispose()); stages = []; detailStage = undefined; }
function addStage(selector, options) {
  const target = $(selector);
  if (!target) return undefined;
  const loading = document.createElement('div');
  loading.className = 'stage-loading';
  loading.textContent = '正在准备三维示意…';
  target.append(loading);
  const stage = createStage(target, { ...options, onReady: (ready) => { loading.remove(); options?.onReady?.(ready); } });
  stages.push(stage);
  return stage;
}
function part() { return PARTS.find((item) => item.key === state.part) ?? PARTS[0]; }
function go(view) {
  state.view = view;
  if (view === 'editor' && !state.part) { state.part = 'drive.motor'; state.editor.direction = state.partSettings[state.part].direction; state.editor.distance = state.partSettings[state.part].distance; }
  history.replaceState(null, '', `#${view}`);
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function header() {
  const tabs = [['runtime', '01', '运行大屏'], ['editor', '02', '孪生编辑器'], ['platform', '03', '中台大屏配置']];
  return `<header class="app-header"><div class="brand"><div class="brand-mark">${icon('layers', 34)}</div><div><b>ZENDING</b><small>设备全景 · 零件洞察</small></div></div><nav class="view-nav" aria-label="三个环节的界面">${tabs.map(([key, number, title]) => `<button data-view="${key}" class="${state.view === key ? 'active' : ''}" ${state.view === key ? 'aria-current="page"' : ''}><span class="nav-number">${number}</span>${title}</button>`).join('')}</nav><div class="header-end"><span class="prototype-pill">UI / 交互原型</span><button class="btn ghost small" data-action="guide">${icon('book', 14)}操作说明</button></div></header><div class="prototype-note"><span><b>新增界面设计</b><span class="dot"></span>程序化示意模型 · 模拟数据 · 不连接实际工程</span><span class="note-end">同一设备贯穿三个环节：CV-021 / 输送线驱动总成</span></div>`;
}
function runtime() {
  const stats = [['设备总数', '128', '台', 'cube'], ['示例运行设备', '126', '台', 'screen'], ['待处理告警', '02', '项', 'alert'], ['示例设备可用率', '98.4', '%', 'chart']];
  return `<main id="main" class="runtime ${state.config.layout === 'dialog' ? 'dialog-mode' : ''}" tabindex="-1"><div class="screen-title between"><div><div class="eyebrow">OPERATIONS / 设备运行总览</div><h1>华东智能物流中心</h1></div><div class="right-meta"><span>总览 / 输送系统 / CV-021</span><span>${icon('screen', 14)} 示例运行画面</span></div></div><div class="metrics-strip">${stats.map(([name, value, unit, symbol]) => `<div class="summary-stat"><div><div class="stat-name">${name}</div><strong>${value}</strong><span class="unit">${unit}</span></div><span class="stat-icon">${icon(symbol, 26)}</span></div>`).join('')}</div><div class="runtime-grid"><aside class="overview card"><div class="overview-title between"><h2>场景总览</h2><span class="badge">低模</span></div><div id="overview-stage" class="mini-stage"><span class="stage-caption">输送区 · 当前设备 CV-021</span></div><div class="overview-device"><div class="flex gap"><span class="dot good"></span><small>设备已定位</small></div><h3>辊道输送线 · 021</h3><div class="mono muted">${esc(state.editor.assetCode)}</div><button class="btn ${state.open ? 'ghost' : 'primary'}" data-action="open">${icon('cube', 14)}${state.open ? '当前设备详情' : '查看设备拆解'}</button></div><div class="alarm-title between"><h3>关联告警</h3><span class="badge warn">1 项</span></div><button class="alarm-card" data-action="alarm"><span class="badge warn">${icon('alert', 12)}温度预警</span><div class="alarm-name">驱动电机温度偏高</div><small class="muted">CV-021 / 驱动电机</small><div class="alarm-foot"><span>示例 14:32:08</span><span>定位零件 ${icon('arrow', 12)}</span></div></button><div class="overview-note">场景保留总体态势。<br>高模在详情中按需打开，关闭后回到当前设备。</div></aside>${state.open ? inspection() : overviewOnly()}</div><footer class="runtime-footer"><span>${icon('link', 13)} ${state.open ? `联动上下文：${esc(state.editor.assetCode)} → ${state.part ? esc(part().name) : '未选零件 · 零件源不请求'}` : `设备上下文：${esc(state.editor.assetCode)} · 零件选择已清除`}</span><span>几何、指标与告警均为交互示例，不代表现场状态</span></footer></main>`;
}
function overviewOnly() {
  return `<section class="full-overview card"><div class="overview-card card"><span class="section-label">设备已选择</span><h2>辊道输送线 · 021</h2><p class="muted" style="font-size:12px;margin:10px 0 16px">点击选中设备或“查看设备拆解”，打开独立高模。</p><button class="btn primary" data-action="open">${icon('cube')}查看设备拆解</button></div><div id="full-overview-stage" style="height:100%"></div></section>`;
}
function partsList() {
  return `<div class="subhead between"><span>装配结构</span><span>6 组</span></div><div class="assembly-root">${icon('chevron', 11)}${icon('cube', 13)}驱动总成</div><div class="part-list">${PARTS.map((item, index) => `<button class="part-row ${item.key === state.part ? 'selected' : ''}" data-part="${item.key}" aria-pressed="${item.key === state.part}"><span class="part-index">${String(index + 1).padStart(2, '0')}</span><span><span class="part-name">${item.name}</span><span class="part-meta" style="display:block">${item.code}${item.fixed ? ' · 固定组' : ''}</span></span>${item.key === 'drive.motor' ? '<span class="warn-dot" aria-label="有温度预警"></span>' : ''}</button>`).join('')}</div><div class="parts-legend">点击零件或模型同步选择。<br>重复物料按装配位置区分。</div>`;
}
function progressControl(editor = false) {
  return `<div class="explode-control"><div class="between"><label for="${editor ? 'editor-' : ''}explode" class="title">零件展开</label><output id="${editor ? 'editor-' : ''}progress-label" for="${editor ? 'editor-' : ''}explode">${state.progress}%</output></div><div class="slider-line"><button class="btn icon small" data-action="assembled" aria-label="恢复装配姿态">${icon('cube', 14)}</button><input id="${editor ? 'editor-' : ''}explode" data-progress type="range" min="0" max="100" value="${state.progress}" aria-label="零件展开进度"/><button class="btn icon small" data-action="exploded" aria-label="完全展开">${icon('expand', 14)}</button></div><div class="slider-ends"><span>装配姿态</span><span>完全展开</span></div></div>`;
}
function inspection() {
  return `<section class="inspection card" aria-label="设备高模详情"><header class="inspection-header"><div><div class="inspection-title">${icon('layers', 20)}<h2>输送线驱动总成</h2><span class="badge good">高模详情</span></div><div class="inspection-sub">${esc(state.editor.assetCode)}<span style="margin:0 8px">/</span>6 米 · 有站台<span style="margin:0 8px">/</span>固定版本 ${esc(state.editor.version)}</div></div><div class="flex gap"><button class="btn small ghost" data-action="restore">${icon('reset', 13)}复原</button><button class="btn icon small ghost" data-action="close" aria-label="关闭高模详情，保留设备选择">${icon('close', 17)}</button></div></header><div class="inspection-body"><aside class="parts-panel">${partsList()}</aside><section class="viewer-panel" aria-label="高精度装配查看区"><div class="viewer-toolbar"><button class="btn" data-action="fit">${icon('expand', 12)}整体取景</button><button class="btn" data-action="focus">${icon('target', 12)}聚焦</button><button class="btn" data-action="isolate" aria-pressed="${state.isolated}">${icon('eye', 12)}${state.isolated ? '退出隔离' : '隔离所选'}</button><button class="btn" data-action="labels" aria-pressed="${state.labels}">${icon('tag', 12)}标注</button><button class="btn" data-action="clear-part">取消选择</button></div><div id="detail-stage" class="model-stage"><div class="model-watermark">三维装配示意<br>拖动旋转 · 滚轮缩放 · 点击零件</div><span class="axis-key">Y ↑ &nbsp; X →</span></div>${progressControl()}</section><aside id="part-data" class="data-panel" aria-label="当前零件的数据">${dataPanel()}</aside></div><footer class="inspection-footer"><span>${icon('check', 12)}模型选择与右侧零件数据联动</span><span>展开进度属于查看状态，不触发指标查询</span></footer></section>`;
}
const samples = {
  'drive.motor': { temperature: '76.8', vibration: '4.6', speed: '1450', warn: true, temperatures: [58.2, 59.1, 61.8, 62.4, 65.3, 68.2, 72.6, 76.8] },
  'drive.reducer': { temperature: '48.3', vibration: '1.7', speed: '58', warn: false, temperatures: [43.2, 43.6, 44.1, 44.0, 45.3, 46.0, 47.2, 48.3] },
  'drive.bearing': { temperature: '45.2', vibration: '1.3', speed: '58', warn: false, temperatures: [40.6, 41.2, 40.8, 42.3, 43.1, 43.9, 44.1, 45.2] },
};
function dataPanel() {
  if (!state.part) return `<div class="part-data-heading"><span class="section-label">零件运行参数</span><h3>尚未选择零件</h3><div class="part-key mono">设备 ${esc(state.editor.assetCode)}</div><span class="badge">零件源未请求</span></div><div class="empty-panel">${icon('target', 28)}<h3>请选择一个零件</h3>从装配树或三维模型中选择。<br>必填参数未齐，不请求零件数据。<br>整机数据仍保持原有筛选。</div>`;
  const current = part();
  const sample = samples[current.key];
  const bound = state.config.keys.includes('partKey');
  const head = `<div class="part-data-heading"><span class="section-label">当前零件</span><h3>${current.name}</h3><div class="part-key mono">${current.key}</div><span class="badge ${sample?.warn ? 'warn' : 'good'}">${sample?.warn ? `${icon('alert', 11)}温度预警` : sample ? `${icon('check', 11)}示例状态正常` : '未配置数据'}</span><div class="info-tabs"><button data-data-tab="live" class="${state.dataTab === 'live' ? 'active' : ''}">运行参数</button><button data-data-tab="info" class="${state.dataTab === 'info' ? 'active' : ''}">零件资料</button></div></div>`;
  if (state.dataTab === 'info') return `${head}<div><div class="field"><span class="field-label">装配位置标识</span><div class="mono">${current.key}</div></div><div class="field"><span class="field-label">所属设备</span><div>${esc(state.editor.assetCode)}</div></div><div class="field"><span class="field-label">配置适用范围</span><div>6 米输送线 · 有站台</div></div></div><div><div class="field"><span class="field-label">高模版本</span><div>${esc(state.editor.version)} · 固定</div></div><div class="field"><span class="field-label">实际零件序列号</span><div class="muted">未绑定</div></div></div><div class="data-footnote">装配位标识与实际零件序列号分开管理。更换零件不改变装配位。</div>`;
  if (!bound) return `${head}<div class="empty-panel">${icon('link', 28)}<h3>零件参数未声明</h3>请在中台数据源中声明 partKey。<br>当前不显示整机数据替代零件数据。<br><button class="btn small" style="margin-top:12px" data-action="configure-data">前往配置</button></div>`;
  if (!sample) return `${head}<div class="empty-panel">${icon('link', 28)}<h3>未配置零件数据</h3>此零件仍可选择、展开与隔离。<br>绑定数据源后展示对应指标。<br><button class="btn small" style="margin-top:12px" data-action="configure-data">查看数据配置</button></div>`;
  return `${head}<div class="part-stats"><div class="part-stat"><div class="label"><span>零件温度</span>${sample.warn ? '<span class="warning">高于示例阈值</span>' : ''}</div><div class="value">${sample.temperature}<span class="unit">°C</span></div><div class="limit">示例预警阈值 70 °C</div></div><div class="part-stat"><div class="label">振动速度</div><div class="value">${sample.vibration}<span class="unit">mm/s</span></div></div><div class="part-stat"><div class="label">转速</div><div class="value">${sample.speed}<span class="unit">rpm</span></div></div></div><div class="chart-block"><div class="between"><span class="chart-title">温度趋势 / °C</span><button class="btn ghost small" style="font-size:10px;min-height:25px;padding:3px 5px" data-action="chart-table">${state.chartTable ? '查看曲线' : '查看表格'}</button></div>${state.chartTable ? chartTable(sample.temperatures) : chart(sample.temperatures)}</div><div class="data-footnote">${icon('link', 11)} 当前筛选：${esc(state.editor.deviceNo)} / ${current.short}<br>模拟样本 · 示例采集时间 14:32:08<br>切换零件更新数据；旋转、展开不发起查询。</div>`;
}
function chart(values) {
  const points = values.map((value, i) => [30 + i * 23, 107 - value * .85]);
  const line = points.map(([x, y]) => `${x},${y}`).join(' ');
  return `<svg viewBox="0 0 216 134" role="img" aria-label="${part().name}温度示例趋势，范围0到100摄氏度；可查看表格获得全部数值"><title>${part().name}温度趋势（模拟样本）</title>${[0, 50, 100].map((value) => `<line x1="30" y1="${107 - value * .85}" x2="198" y2="${107 - value * .85}" stroke="#344050" stroke-width=".6"/><text x="23" y="${110 - value * .85}" text-anchor="end" fill="#abb9ca" font-size="9">${value}</text>`).join('')}<polyline points="${line}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round"/>${points.map(([x, y], i) => `<circle class="chart-point" cx="${x}" cy="${y}" r="4"/><circle class="chart-hit" tabindex="0" role="img" aria-label="14:${String(25 + i).padStart(2, '0')}，${values[i]}摄氏度" data-chart-point="14:${String(25 + i).padStart(2, '0')} · ${values[i]} °C" cx="${x}" cy="${y}" r="12"><title>14:${25 + i} · ${values[i]} °C</title></circle>`).join('')}<text x="30" y="126" fill="#abb9ca" font-size="9">14:25</text><text x="191" y="126" text-anchor="end" fill="#abb9ca" font-size="9">14:32</text></svg><div class="chart-tooltip" id="chart-tooltip">指向或用键盘选择数据点查看样本</div>`;
}
function chartTable(values) { return `<div class="chart-table"><table><caption class="dim" style="text-align:left;font-size:10px">${part().name} · 温度模拟样本</caption><thead><tr><th>时间</th><th>温度 / °C</th></tr></thead><tbody>${values.map((value, index) => `<tr><td>14:${25 + index}</td><td>${value}</td></tr>`).join('')}</tbody></table></div>`; }
function field(id, label, value, help = '', { readonly = false, type = 'text', marker = '' } = {}) { return `<div class="field"><label for="${id}">${label}${marker}</label><input id="${id}" value="${esc(value)}" type="${type}" ${readonly ? 'readonly' : ''} ${help ? `aria-describedby="${id}-help"` : ''}/>${help ? `<div class="help" id="${id}-help">${help}</div>` : ''}</div>`; }
function editor() {
  return `<main id="main" class="editor" tabindex="-1"><div class="editor-menubar"><b style="font-size:13px">ZENDING 3D EDITOR</b><div class="menus"><span>工程</span><span>场景</span><span>对象</span><span>视图</span></div><span class="editor-project">物流中心 / 输送系统.scene</span><div class="flex gap"><button class="btn small" data-action="editor-check">${icon('check', 14)}发布到数据中台</button><button class="btn primary small" data-action="editor-save">${icon('save', 14)}保存场景</button></div></div><div class="editor-body"><aside class="hierarchy"><h2>场景层级</h2><div class="tree-row">${icon('folder', 14)}物流中心</div><div class="tree-row child">${icon('chevron', 10)}建筑环境</div><div class="tree-row child">${icon('chevron', 10)}输送系统</div><div class="tree-row child">${icon('cube', 13)}输送线 020</div><div class="tree-row child selected">${icon('cube', 13)}输送线 021</div><div class="tree-row child">${icon('cube', 13)}输送线 022</div><div class="tree-row child">${icon('cube', 13)}提升机 01</div><div class="hierarchy-hint">先在场景中选中设备。<br>在属性面板新增的“高精度详情”分组完成绑定。</div><div class="callout" style="margin-top:12px">高模只用于设备详情，不替换场景低模。</div></aside><section class="editor-main"><div class="editor-viewbar"><span>${icon('cube', 13)} 高模配置预览 <span class="badge new">拟新增</span></span><span>原场景布局保持不变</span></div><div class="editor-preview"><div class="preview-banner"><span class="badge">驱动总成 · ${esc(state.editor.version)}</span><span class="badge good">独立预览</span></div><div id="editor-stage" class="model-stage"><div class="model-watermark">程序化装配示意 · 非实际高精度资产<br>点击零件可在配置面板中编辑</div></div>${progressControl(true)}</div><div class="editor-bottom">${state.editorStep === 3 ? `<div class="between"><h3>零件装配映射</h3><span class="badge">6 / 6 已映射（示例）</span></div><table class="part-table"><thead><tr><th>零件</th><th>稳定装配位</th><th>展开方向</th><th>距离 / m</th></tr></thead><tbody>${PARTS.map((item) => `<tr class="${item.key === state.part ? 'selected' : ''}"><td><button data-part="${item.key}">${item.name}</button></td><td class="mono">${item.key}</td><td>${item.key === state.part && !item.fixed ? esc(state.editor.direction) : item.direction}</td><td>${item.key === state.part && !item.fixed ? esc(state.editor.distance) : item.distance}</td></tr>`).join('')}</tbody></table>` : `<h3>当前设备的模型表示</h3><div class="asset-cards"><div class="asset-thumb">${icon('cube', 26)}<div class="name">场景模型</div><div class="meta">总体态势 · 已有</div></div><div class="asset-thumb" style="border-color:#4b9388">${icon('layers', 26)}<div class="name">高精度详情模型</div><div class="meta">固定版本 · 拟新增绑定</div></div></div>`}</div></section><aside class="inspector"><div class="inspector-header"><div class="between"><h2>Inspector / 高精度详情</h2><span class="badge new">拟新增</span></div><div class="inspector-sub">当前设备：辊道输送线 · ${esc(state.editor.assetCode)}</div></div><nav class="setup-steps" aria-label="编辑器配置步骤">${['设备身份', '绑定高模', '零件与展开', '点击与发布'].map((title, index) => `<button class="setup-step ${state.editorStep === index + 1 ? 'active' : ''}" data-editor-step="${index + 1}" ${state.editorStep === index + 1 ? 'aria-current="step"' : ''}><span class="number">${index + 1}</span>${title}</button>`).join('')}</nav><div class="setup-content">${editorStep()}</div><div class="config-footer"><small>${state.editorDirty ? '配置已修改 · 尚未保存' : state.editorSaved ? '原型内已暂存' : '示例工程配置'}</small><button class="btn primary small" data-action="editor-next">${state.editorStep === 4 ? '检查并保存' : '下一步'}${icon('arrow', 13)}</button></div></aside></div><footer class="editor-statusbar"><span>${icon('check', 11)} 预览姿态不写入工程；绑定配置支持撤销 / 重做（正式功能要求）</span><span>原型中的保存仅暂存内存，不写入真实工程</span></footer></main>`;
}
function editorStep() {
  if (state.editorStep === 1) return `<div class="setup-title"><h3>确认设备与数据身份</h3><p>设备业务编号与中台设备数据键显式关联。</p></div>${field('editor-assetCode', '资产编号（设备业务编号）', state.editor.assetCode, '场景设备身份，例如 CV-021。')}${field('editor-namespace', '数据命名空间', state.editor.namespace)}<div class="field-pair">${field('editor-deviceType', '设备类型', state.editor.deviceType)}${field('editor-deviceNo', '数据设备编号', state.editor.deviceNo)}</div><div class="callout">设备业务编号 CV-021 与数据设备编号 CV021 可以不同，不能自动视为同一字段。</div>`;
  if (state.editorStep === 2) return `<div class="setup-title"><h3>绑定独立高精度装配模型</h3><p>绑定模型库中的固定版本，并确认适用于当前设备配置。</p></div><div class="field"><label for="editor-model">高精度详情模型</label><select id="editor-model"><option value="6m" ${state.editor.model === '6m' ? 'selected' : ''}>输送线驱动总成 · 6 米有站台</option><option value="10m" ${state.editor.model === '10m' ? 'selected' : ''}>输送线驱动总成 · 10 米无站台</option></select></div><div class="field-pair"><div class="field"><label for="editor-version">固定模型版本</label><select id="editor-version"><option ${state.editor.version === 'v1.3' ? 'selected' : ''}>v1.3</option><option ${state.editor.version === 'v1.2' ? 'selected' : ''}>v1.2</option></select></div>${field('editor-unit', '模型单位', '米（m）', '', { readonly: true })}</div>${field('editor-variant', '当前设备配置', '6 米 · 有站台', '', { readonly: true })}<div id="model-validation" class="callout ${state.editor.model === '10m' ? 'error' : ''}">${state.editor.model === '10m' ? `${icon('alert', 13)}配置不匹配：当前设备为 6 米有站台，所选高模为 10 米无站台。请更换适用模型。` : `${icon('check', 13)}示例配置匹配 · 零件可独立变换<br>正式接入还需校验真实模型精度、分件和摘要。`}</div><p class="muted" style="font-size:10px;line-height:1.8;margin-top:12px">发布时携带高模及零件清单。模型库产生新版本不会自动替换此绑定。</p>`;
  if (state.editorStep === 3) return `<div class="setup-title"><h3>配置零件与展开方式</h3><p>从左侧模型或下方表格选中零件，再调整该装配组。</p></div><div class="field"><label for="editor-part">当前零件</label><select id="editor-part">${PARTS.map((item) => `<option value="${item.key}" ${item.key === state.part ? 'selected' : ''}>${item.name}</option>`).join('')}</select></div>${field('editor-partKey', '稳定装配位标识', part().key, '用来匹配大屏零件数据；不使用网格名称。', { readonly: true })}<div class="field"><label for="editor-node">关联模型节点</label><input id="editor-node" value="Assembly/${part().code}" readonly/><div class="help">示例节点映射；正式配置需要校验目标节点。</div></div><div class="field"><span class="field-label">展开方向</span><div class="direction-controls">${['−X', '+X', '+Y', '−Y', '+Z', '−Z'].map((direction) => `<button data-direction="${direction}" class="${state.editor.direction === direction && !part().fixed ? 'active' : ''}" ${part().fixed ? 'disabled' : ''}>${direction}</button>`).join('')}</div></div>${field('editor-distance', '完全展开距离 / m', part().fixed ? '0' : state.editor.distance, '原型支持修改方向与距离后预览；固定组保持原位。', { type: 'number', readonly: part().fixed })}<div class="callout">${part().fixed ? '当前减速机总成为固定组，其他零件围绕它展开。' : '展开参数写入配置；上方滑块只用于预览。'} 零件层级由高模清单提供。</div>`;
  return `<div class="setup-title"><h3>设置入口并检查发布</h3><p>让设备点击能向中台宿主请求打开详情。</p></div><label class="check"><input id="editor-click" type="checkbox" ${state.editor.click ? 'checked' : ''}/><span>启用“打开设备详情”动作<small>POI库 → 点击事件绑定 → 事件列表 → 点击 → 事件效果 → 打开设备详情（新增）。已有图表、漫游和聚焦按原规则保留。</small></span></label><div class="field" style="margin-top:18px"><span class="field-label">中台将读取</span><div class="callout">设备身份与配置<br>固定高模版本与资源清单<br>零件装配位与展开规则</div></div><div class="field"><span class="field-label">发布检查</span><div class="stack" style="gap:8px;font-size:11px"><span>${icon('check', 12)}设备身份已配置（示例）</span><span>${icon(state.editor.model === '6m' ? 'check' : 'alert', 12)}高模配置${state.editor.model === '6m' ? '匹配' : '不匹配'}</span><span>${icon('check', 12)}固定版本 ${esc(state.editor.version)} 与 6 个装配位</span><span>${icon('alert', 12)}真实资源与离线加载仍需实施验收</span></div></div><button class="btn" data-action="editor-check">查看发布检查详情</button><div class="callout" style="margin-top:15px">保存并发布孪生工程后，到中台配置联动。这里不配置图表接口。</div>`;
}
function platform() {
  return `<main id="main" class="platform" tabindex="-1"><header class="platform-topbar"><div><h1>数据中台 / 大屏设计器</h1><div class="breadcrumb">物流中心运行大屏 / 数字孪生组件 / 联动配置</div></div><div class="flex gap"><span class="badge new">配置原型</span><button class="btn small" data-action="platform-preview">${icon('screen', 14)}联动预览</button><button class="btn primary small" data-action="platform-save">应用配置</button></div></header><div class="platform-body"><aside class="widget-sidebar"><div class="sidebar-tabs"><b>图层</b><span class="muted">组件</span></div><h2>当前大屏</h2><div class="widget-row">${icon('tag', 14)}大屏标题</div><div class="widget-row">${icon('grid', 14)}运行概况</div><div class="widget-row selected">${icon('cube', 14)}数字孪生</div><div class="widget-row">${icon('chart', 14)}驱动运行指标</div><div class="widget-row">${icon('alert', 14)}设备告警列表</div><div class="context-note">选择数字孪生组件，在右侧配置场景和详情联动。<br><br>图表的数据源依赖单独声明，整机图表不跟随零件重复刷新。</div></aside><section class="designer-main"><div class="canvas-toolbar"><span>画布 1920 × 1080 · 16:9</span><span>适应画布</span></div><div class="design-canvas"><h3>华东智能物流中心</h3><div class="designer-stats"><span>设备数<b>128</b></span><span>运行设备<b>126</b></span><span>待处理告警<b>02</b></span></div><div class="canvas-widget"><span class="widget-label">数字孪生 / 已选择</span><div id="platform-stage" class="mini-stage"></div><i class="resize-handle tl"></i><i class="resize-handle tr"></i><i class="resize-handle bl"></i><i class="resize-handle br"></i></div><div class="canvas-under"><div>驱动运行指标<b>随当前零件更新</b></div><div>设备告警列表<b>可反向定位零件</b></div></div></div><section class="designer-flow"><h3>${icon('link', 14)}这套配置会如何生效</h3><div class="flow-route"><span>场景设备点击</span>${icon('arrow', 12)}<span class="active">高模详情</span>${icon('arrow', 12)}<span>零件指标</span></div><p>模型与零件清单来自孪生工程。中台只配置展示方式、事件动作与数据映射，不重复上传高模。</p><button class="btn small" style="margin-top:12px" data-action="platform-test">${icon('target', 13)}模拟告警：定位驱动电机</button></section></section><aside class="platform-inspector"><div class="inspector-header"><div><h2>数字孪生 · 联动配置</h2><div class="inspector-sub">新增配置分组</div></div><span class="badge new">拟新增</span></div><nav class="setup-steps" aria-label="中台配置步骤">${['场景与详情', '事件与动作', '零件数据源'].map((title, index) => `<button class="setup-step ${state.platformStep === index + 1 ? 'active' : ''}" data-platform-step="${index + 1}" ${state.platformStep === index + 1 ? 'aria-current="step"' : ''}><span class="number">${index + 1}</span>${title}</button>`).join('')}</nav><div class="setup-content">${platformStep()}</div><div class="config-footer"><small>${state.platformSaved ? '原型配置已应用' : '预览环境 · 不写入中台'}</small><button class="btn primary small" data-action="platform-next">${state.platformStep === 3 ? '校验并预览' : '下一步'}${icon('arrow', 13)}</button></div></aside></div><footer class="designer-footer"><span>预览与发布页沿用同一套设备 / 零件上下文</span><span>这里演示配置，不访问中台接口</span></footer></main>`;
}
function platformStep() {
  if (state.platformStep === 1) return `<div class="setup-title"><h3>绑定发布 Viewer，启用详情</h3><p>“运行方式”和“绑定模式”为已有配置；详情联动是新增分组。</p></div><div class="field"><label for="platform-runtime">运行方式 <span class="badge">已有</span></label><select id="platform-runtime"><option>发布 Viewer（支持大屏联动）</option></select></div>${field('platform-project', '当前大屏项目', '物流中心（示例）', '', { readonly: true })}<div class="field"><label for="platform-binding">绑定模式 <span class="badge">已有</span></label><select id="platform-binding"><option value="stable" ${state.config.binding === 'stable' ? 'selected' : ''}>当前项目稳定版本</option><option value="fixed" ${state.config.binding === 'fixed' ? 'selected' : ''}>固定已完成发布记录</option></select><div class="help">${state.config.binding === 'stable' ? '跟随当前项目稳定发布。当前示例解析为 R-013。' : '固定示例发布 R-013；不跟随后续项目发布。'} 每份发布内部的高模版本保持固定。</div></div>${state.config.binding === 'fixed' ? '<div class="field"><label for="platform-release">已完成发布记录</label><select id="platform-release"><option>R-013 · 输送系统（示例 / COMPLETED）</option></select></div>' : ''}<label class="check"><input id="platform-enabled" type="checkbox" ${state.config.enabled ? 'checked' : ''}/><span>启用设备高模详情 <span class="badge new">拟新增</span><small>允许展示工程中已配置的详情；打开入口来自编辑器的点击动作或明确的告警联动。</small></span></label><div class="field" style="margin-top:16px"><label for="platform-layout">详情展示方式</label><select id="platform-layout"><option value="side" ${state.config.layout === 'side' ? 'selected' : ''}>右侧工作区（保留场景总览）</option><option value="dialog" ${state.config.layout === 'dialog' ? 'selected' : ''}>居中弹窗（桌面宽屏）</option></select></div><div class="callout">高模与零件读取孪生工程发布的固定绑定，无需再次上传模型。设备未绑定高模时，不使用场景低模冒充详情。</div>`;
  if (state.platformStep === 2) return `<div class="setup-title"><h3>配置双向事件与动作</h3><p>设备级和零件级分别路由，关闭详情保留当前设备。</p></div><div class="event-card"><div class="event-title">${icon('cube', 14)}场景 · 设备点击</div><div class="event-action">${icon('arrow', 12)}<select id="platform-event" aria-label="设备点击后的动作"><option value="open" ${state.config.event === 'open' ? 'selected' : ''}>打开设备详情</option><option value="device" ${state.config.event === 'device' ? 'selected' : ''}>仅更新设备级筛选</option></select></div><small class="muted">设备参数从孪生工程绑定读取。</small></div><div class="event-card"><div class="event-title">${icon('layers', 14)}高模 · 零件选择</div><div class="event-action">${icon('arrow', 12)}更新当前零件 → 驱动运行指标</div><small class="muted">携带设备键与 partKey；不携带相机和展开进度。</small></div><div class="event-card"><div class="event-title">${icon('alert', 14)}告警列表 · 行点击</div><div class="event-action">${icon('arrow', 12)}定位设备 + 打开详情 + 选择零件</div><small class="muted">设备字段：assetCode / 零件字段：partKey</small></div><button class="btn small" data-action="platform-test">${icon('target', 13)}测试告警定位</button>`;
  const valid = state.config.keys.includes('partKey');
  const values = { namespace: state.editor.namespace, deviceType: state.editor.deviceType, deviceNo: state.editor.deviceNo, partKey: state.part };
  return `<div class="setup-title"><h3>声明零件数据源的参数</h3><p>示例：驱动运行指标。只有依赖零件的图表接收零件参数。</p></div><div class="field-pair"><div class="field"><label for="platform-data-source">目标数据源</label><select id="platform-data-source"><option>驱动运行指标（HTTP）</option></select></div><div class="field"><label for="platform-policy">点击参数策略</label><select id="platform-policy"><option>仅传递声明参数</option></select></div></div><span class="field-label">声明的点击参数 <span class="badge">已有</span></span><div class="declared-keys">${Object.keys(values).map((key) => `<label><input type="checkbox" data-key="${key}" ${state.config.keys.includes(key) ? 'checked' : ''}/>${key}</label>`).join('')}</div><div class="callout ${valid ? '' : 'error'}" id="parameter-validation" role="${valid ? 'note' : 'alert'}">${valid ? `${icon('check', 12)}已声明 partKey：同一设备切换零件会更新查询。` : `${icon('alert', 12)}缺少 partKey：同设备切换零件不会改变有效查询参数。请勾选后再应用。`}</div><div class="field" style="margin:12px 0 4px"><span class="field-label">必填参数未齐不请求 <span class="badge new">拟新增</span></span><div class="help">namespace、deviceType、deviceNo、partKey。未选零件或关闭详情时停止零件源，清空旧零件值。</div></div><table class="mapping-table"><thead><tr><th>请求参数</th><th>取值来源</th></tr></thead><tbody>${[['namespace', '当前设备 → 命名空间'], ['deviceType', '当前设备 → 设备类型'], ['deviceNo', '当前设备 → 数据设备编号'], ['partKey', '当前选择 → 装配位标识']].map(([key, label]) => `<tr><td class="mono">${key}</td><td>${label}</td></tr>`).join('')}</tbody></table><div class="request-preview"><b>有效请求示例（模拟，不发送）</b><br><code>${esc(JSON.stringify(Object.fromEntries(Object.entries(values).filter(([key]) => state.config.keys.includes(key))), null, 2)).replace(/\n/g, '<br>').replace(/  /g, '&nbsp;&nbsp;')}</code></div><p class="muted" style="font-size:10px;line-height:1.8">整机产量等数据源只声明设备参数。不要将零件展开进度、相机位置加入查询参数。</p>`;
}
function syncPart() {
  detailStage?.select(state.part);
  detailStage?.isolate(state.isolated);
  detailStage?.labels(state.labels);
  $$('[data-part]').forEach((button) => { const selected = button.dataset.part === state.part; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
  if ($('#part-data')) { $('#part-data').innerHTML = dataPanel(); bindDataPanel(); }
  if (state.view === 'editor') render();
  else { const footer = $('.runtime-footer span'); if (footer) footer.innerHTML = `${icon('link', 13)} 联动上下文：${esc(state.editor.assetCode)} → ${part().name}`; }
}
function selectPart(key) {
  if (!PARTS.some((item) => item.key === key)) return;
  state.part = key;
  state.dataTab = 'live';
  state.chartTable = false;
  state.editor.direction = state.partSettings[key].direction;
  state.editor.distance = state.partSettings[key].distance;
  syncPart();
}
function setProgress(value) {
  state.progress = Math.max(0, Math.min(100, Number(value)));
  detailStage?.setProgress(state.progress);
  $$('[data-progress]').forEach((input) => { input.value = state.progress; });
  $$('output').forEach((output) => { output.value = `${state.progress}%`; output.textContent = `${state.progress}%`; });
}
function bindDataPanel() {
  $$('[data-data-tab]').forEach((button) => { button.onclick = () => { state.dataTab = button.dataset.dataTab; $('#part-data').innerHTML = dataPanel(); bindDataPanel(); }; });
  $$('[data-chart-point]').forEach((point) => {
    const show = () => { if ($('#chart-tooltip')) $('#chart-tooltip').textContent = point.dataset.chartPoint; };
    point.addEventListener('mouseenter', show);
    point.addEventListener('focus', show);
  });
  const chartButton = $('[data-action="chart-table"]');
  if (chartButton) chartButton.onclick = () => { state.chartTable = !state.chartTable; $('#part-data').innerHTML = dataPanel(); bindDataPanel(); };
  const configure = $('[data-action="configure-data"]');
  if (configure) configure.onclick = () => { state.platformStep = 3; go('platform'); };
}
function openInspection(fromAlarm = false) {
  if (!state.config.enabled || !state.editor.click && !fromAlarm) { toast('示例配置尚未启用高模详情，请到编辑器或中台启用。'); return; }
  if (state.editor.model !== '6m') { toast('高模配置与设备不匹配，请在编辑器选择“6 米有站台”。'); return; }
  if (!fromAlarm && state.config.event === 'device') { toast('当前事件配置为“仅更新设备级筛选”，未打开高模。'); return; }
  state.open = true;
  state.isolated = false;
  state.dataTab = 'live';
  if (fromAlarm) { state.part = 'drive.motor'; state.progress = 68; }
  else { state.part = null; state.progress = 0; }
  render();
  if (fromAlarm) toast('告警已定位到 CV-021 / 驱动电机，右侧同步显示该零件的模拟数据。');
}
function validateEditor() { return Boolean(state.editor.assetCode.trim() && state.editor.namespace.trim() && state.editor.deviceType.trim() && state.editor.deviceNo.trim() && state.editor.model === '6m' && Object.values(state.partSettings).every((setting) => setting.distance.trim() !== '' && Number.isFinite(Number(setting.distance)) && Number(setting.distance) >= 0)); }
function validatePlatform() {
  if (!state.config.keys.includes('partKey')) { state.platformStep = 3; render(); toast('零件数据源缺少 partKey，无法应用。请在“接收参数”中勾选。'); $('#parameter-validation')?.scrollIntoView({ block: 'nearest' }); return false; }
  const required = ['namespace', 'deviceType', 'deviceNo'];
  if (required.some((key) => !state.config.keys.includes(key))) { state.platformStep = 3; render(); toast('示例查询需要完整设备键：namespace、deviceType、deviceNo。'); return false; }
  return true;
}
function saveEditor() {
  if (!validateEditor()) { toast('配置未通过：检查设备身份、高模适用配置和非负展开距离。'); return; }
  state.editorDirty = false; state.editorSaved = true;
  render();
  toast('配置已在原型内暂存。未保存真实工程，也未上传或发布资源。');
}
function modal(title, content) {
  lastFocus = document.activeElement;
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">${title}</h2><button class="btn icon ghost" data-modal-close aria-label="关闭说明">${icon('close', 18)}</button></div><div class="modal-body">${content}</div></section></div>`;
  const root = $('#modal-root');
  const close = () => { modalCleanup?.(); root.innerHTML = ''; lastFocus?.focus(); };
  $('[data-modal-close]').onclick = close;
  $('.modal-backdrop').onclick = (event) => { if (event.target.classList.contains('modal-backdrop')) close(); };
  const keydown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key !== 'Tab') return;
    const focusable = $$('button, a[href], input, select, [tabindex="0"]', root).filter((node) => !node.disabled);
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', keydown);
  modalCleanup = () => document.removeEventListener('keydown', keydown);
  $('[data-modal-close]').focus();
}
function guide() {
  modal('三个环节，完成一次设备到零件的联动', `<div class="check-result">${icon('screen', 22)}<div><b>01 / 运行大屏：看设备、拆零件、查数据</b><span>拖动展开滑块，点击电机或零件列表，尝试隔离、聚焦和复原；点击左侧告警可反向定位。关闭详情保留设备。</span></div></div><div class="check-result">${icon('cube', 22)}<div><b>02 / 孪生编辑器：绑定高模，定义装配关系</b><span>选设备 → 确认身份 → 绑定适用配置的固定高模 → 配置零件与展开 → 设置点击入口并保存发布。</span></div></div><div class="check-result">${icon('link', 22)}<div><b>03 / 中台大屏：配置展示、动作与取数</b><span>选已发布场景 → 启用高模详情 → 配置双向动作 → 声明设备键与 partKey → 校验联动预览。无需再次上传高模。</span></div></div><p style="margin-top:18px">本交付为拟新增界面的交互原型。三维由 Babylon.js 原生 WebGL 渲染，使用程序化装配示意；没有加载实际高精度 GLB，也没有连接现场数据或中台接口。正式方案使用官方 Babylon Viewer 承载真实分件高模。</p>`);
}
function publishCheck() {
  const valid = validateEditor();
  modal('发布前检查 / 原型校验', `<div class="check-result">${icon(state.editor.assetCode.trim() ? 'check' : 'alert', 20)}<div><b>设备身份</b><span>${esc(state.editor.assetCode)} → ${esc(state.editor.namespace)} / ${esc(state.editor.deviceType)} / ${esc(state.editor.deviceNo)}</span></div></div><div class="check-result">${icon(state.editor.model === '6m' ? 'check' : 'alert', 20)}<div><b>高模适用配置</b><span>${state.editor.model === '6m' ? '示例配置匹配：6 米 · 有站台' : '配置不匹配：不能给 6 米设备使用 10 米无站台高模'}</span></div></div><div class="check-result">${icon('check', 20)}<div><b>固定版本和零件映射</b><span>固定 ${esc(state.editor.version)}；示例中 6 个装配位均已映射。真实资源摘要校验尚未实施。</span></div></div><div class="check-result">${icon('alert', 20)}<div><b>正式实施仍需验收</b><span>高模分件、源单位、尺寸精度、资源摘要、打包、离线加载，以及目标设备上的 WebGL 性能。</span></div></div><p style="margin-top:16px">${valid ? '当前示例配置通过原型校验。' : '当前示例配置未通过原型校验。'} 本按钮不会上传文件、生成发布包或调用生产接口。</p>`);
}
function updateEditorAssembly() {
  for (const item of PARTS) {
    const setting = state.partSettings[item.key];
    const distance = Number(setting.distance);
    if (!Number.isFinite(distance) || distance < 0 || item.fixed) continue;
    const offset = [0, 0, 0];
    const axis = setting.direction.slice(-1);
    offset[{ X: 0, Y: 1, Z: 2 }[axis]] = (setting.direction.startsWith('−') ? -1 : 1) * distance;
    detailStage?.setOffset(item.key, offset);
  }
  detailStage?.setProgress(state.progress);
}
function bind() {
  $$('[data-view]').forEach((button) => { button.onclick = () => go(button.dataset.view); });
  $$('[data-part]').forEach((button) => { button.onclick = () => selectPart(button.dataset.part); });
  $$('[data-progress]').forEach((input) => { input.addEventListener('input', () => setProgress(input.value)); });
  $$('[data-editor-step]').forEach((button) => { button.onclick = () => { state.editorStep = Number(button.dataset.editorStep); render(); }; });
  $$('[data-platform-step]').forEach((button) => { button.onclick = () => { state.platformStep = Number(button.dataset.platformStep); render(); }; });
  $$('[data-direction]').forEach((button) => { button.onclick = () => { state.editor.direction = button.dataset.direction; state.partSettings[state.part].direction = state.editor.direction; state.editorDirty = true; render(); }; });
  const actions = {
    guide,
    open: () => openInspection(),
    close: () => { state.open = false; state.part = null; state.isolated = false; render(); $('[data-action="open"]')?.focus(); toast('详情已关闭，零件上下文已清除；设备 CV-021 仍保持选中。'); },
    'clear-part': () => { state.part = null; state.isolated = false; detailStage?.isolate(false); detailStage?.select(null); render(); toast('零件选择已清除：不请求零件数据，设备上下文保留。'); },
    alarm: () => openInspection(true),
    assembled: () => setProgress(0),
    exploded: () => setProgress(100),
    fit: () => detailStage?.reset(),
    focus: () => detailStage?.focus(state.part),
    restore: () => { state.isolated = false; setProgress(0); detailStage?.isolate(false); detailStage?.reset(); const button = $('[data-action="isolate"]'); if (button) { button.setAttribute('aria-pressed', 'false'); button.innerHTML = `${icon('eye', 12)}隔离所选`; } toast('已恢复装配姿态与整体取景，当前零件选择保留。'); },
    isolate: () => { state.isolated = !state.isolated; detailStage?.isolate(state.isolated); const button = $('[data-action="isolate"]'); button.setAttribute('aria-pressed', String(state.isolated)); button.innerHTML = `${icon('eye', 12)}${state.isolated ? '退出隔离' : '隔离所选'}`; },
    labels: () => { state.labels = !state.labels; detailStage?.labels(state.labels); $('[data-action="labels"]').setAttribute('aria-pressed', String(state.labels)); },
    'editor-next': () => { if (state.editorStep === 4) return saveEditor(); state.editorStep += 1; render(); },
    'editor-save': saveEditor,
    'editor-check': publishCheck,
    'platform-next': () => { if (state.platformStep < 3) { state.platformStep += 1; render(); } else if (validatePlatform()) { state.platformSaved = true; state.open = true; go('runtime'); toast('按当前原型配置打开联动预览，未请求中台接口。'); } },
    'platform-save': () => { if (validatePlatform()) { state.platformSaved = true; render(); toast('原型配置已应用。未写入真实中台。'); } },
    'platform-preview': () => { if (validatePlatform()) { state.open = state.config.enabled; go('runtime'); } },
    'platform-test': () => { if (!state.config.enabled) { toast('请先在“场景与详情”启用设备高模详情。'); return; } if (validatePlatform()) { state.view = 'runtime'; history.replaceState(null, '', '#runtime'); openInspection(true); } },
  };
  $$('[data-action]').forEach((button) => { if (actions[button.dataset.action]) button.onclick = actions[button.dataset.action]; });
  for (const key of ['assetCode', 'namespace', 'deviceType', 'deviceNo', 'distance']) {
    const input = $(`#editor-${key}`);
    if (input && !input.readOnly) input.oninput = () => {
      state.editor[key] = input.value;
      state.editorDirty = true;
      if (key === 'distance') { state.partSettings[state.part].distance = input.value; const valid = Number(input.value) >= 0 && input.value !== ''; input.setAttribute('aria-invalid', String(!valid)); if (valid) updateEditorAssembly(); }
      const footer = $('.config-footer small'); if (footer) footer.textContent = '配置已修改 · 尚未保存';
    };
  }
  for (const key of ['model', 'version']) { const input = $(`#editor-${key}`); if (input) input.onchange = () => { state.editor[key] = input.value; state.editorDirty = true; render(); }; }
  const partInput = $('#editor-part'); if (partInput) partInput.onchange = () => selectPart(partInput.value);
  const clickInput = $('#editor-click'); if (clickInput) clickInput.onchange = () => { state.editor.click = clickInput.checked; state.editorDirty = true; };
  const enabled = $('#platform-enabled'); if (enabled) enabled.onchange = () => { state.config.enabled = enabled.checked; state.platformSaved = false; };
  const layout = $('#platform-layout'); if (layout) layout.onchange = () => { state.config.layout = layout.value; state.platformSaved = false; };
  const binding = $('#platform-binding'); if (binding) binding.onchange = () => { state.config.binding = binding.value; state.platformSaved = false; render(); };
  const event = $('#platform-event'); if (event) event.onchange = () => { state.config.event = event.value; state.platformSaved = false; };
  $$('[data-key]').forEach((input) => { input.onchange = () => { state.config.keys = input.checked ? [...state.config.keys, input.dataset.key] : state.config.keys.filter((key) => key !== input.dataset.key); state.platformSaved = false; const scrollY = window.scrollY; render(); window.scrollTo({ top: scrollY, behavior: 'instant' }); }; });
  bindDataPanel();
}
function render() {
  disposeStages();
  $('#app').innerHTML = header() + (state.view === 'runtime' ? runtime() : state.view === 'editor' ? editor() : platform());
  bind();
  if (state.view === 'runtime') {
    addStage('#overview-stage', { overview: true, onPick: () => openInspection() });
    if (!state.open) addStage('#full-overview-stage', { overview: true, onPick: () => openInspection() });
    else detailStage = addStage('#detail-stage', { onPick: selectPart });
  } else if (state.view === 'editor') detailStage = addStage('#editor-stage', { onPick: selectPart });
  else addStage('#platform-stage', { overview: true, onPick: () => toast('这是设计器中的场景示意。使用“联动预览”查看高模详情。') });
  if (detailStage) {
    detailStage.setProgress(state.progress);
    detailStage.select(state.part);
    detailStage.isolate(state.view === 'runtime' && state.isolated);
    detailStage.labels(state.labels);
    updateEditorAssembly();
  }
}
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); if (['runtime', 'editor', 'platform'].includes(next)) { state.view = next; render(); } });
window.addEventListener('pagehide', disposeStages);
render();
