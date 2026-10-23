/* global window, document -- Playwright 回调仅在实际浏览器执行。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const projectRoot = process.cwd();
const output = path.resolve('output/project-optimization-p4-20261022/hook-lifecycles');

// 实际组件和真实 Store/巡检控制器都参与执行；IPC 仅用可控 Promise 观察异步所有权。
const harness = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConveyorSurfaceArrowDirectionInspector} from '/src/editor/panels/ConveyorSurfaceArrowDirectionInspector';
import {EffectDataBindingInspector} from '/src/editor/panels/EffectDataBindingInspector';
import {EffectPathDrawingControls} from '/src/editor/panels/EffectPathDrawingControls';
import {DigitalTwinPublishDialog} from '/src/editor/deployment/DigitalTwinPublishDialog';
import {CompositionLibrary} from '/src/editor/composition/CompositionLibrary';
import {useAutoPatrolInspectionHistory} from '/src/shared/ui/useAutoPatrolInspectionHistory';
import {createDefaultEffectConfiguration} from '/src/editor/model/effectConfigurationValidation';
import {createEmptySceneDocument} from '/src/editor/model/SceneDocument';
import {useEditorStore} from '/src/editor/store/editorStore';
import {getEffectPathDrawing} from '/src/editor/model/effectPathDrawing';

const observed = {loads:0,resets:0,lists:[],syncs:0,historyLists:[],scopes:[],errors:[],commits:0};
const loadContext = async () => {observed.loads++};
const reset = () => {observed.resets++};
const context = {available:true,projectId:'42',projectName:'生命周期项目',allowedParentOrigins:[]};
const publishState = {status:'ready',context,progress:null,result:null,error:null};
const applyCamera = () => {};
const onError = message => observed.errors.push(message);
const recordStore = {
  setScope:scope => observed.scopes.push(scope),
  listRecords:() => new Promise(resolve => observed.historyLists.push(resolve)),
};
window.editorApi = {
  listCompositions:() => new Promise(resolve => observed.lists.push(resolve)),
  syncCompositions:async () => {observed.syncs++;return []},
};
useEditorStore.setState({scene:createEmptySceneDocument('Hook 生命周期'),sceneSessionId:'hooks-a'});
const effect = {effectKind:'data-bars',enabled:true,primaryColor:'#22ffff',secondaryColor:'#ffffff',intensity:1,speed:1,density:1};
const initialData = createDefaultEffectConfiguration(effect);
function App() {
  const [revision,setRevision] = useState(0);
  const [savedDirectionField,setSavedDirectionField] = useState('movement_x');
  const [readOnly,setReadOnly] = useState(true);
  const [entityId,setEntityId] = useState('region-a');
  const [firstRegion,setFirstRegion] = useState('区域A');
  const [publishOpen,setPublishOpen] = useState(true);
  const [showLibrary,setShowLibrary] = useState(true);
  const [scope,setScope] = useState('scope-a');
  const [configuration,setConfiguration] = useState(initialData);
  const history = useAutoPatrolInspectionHistory({recordStore,scopeId:scope,applyCamera,onError});
  const regionComponent = {...effect,effectKind:'region-level',configuration:{...initialData,parameters:{regions:[{id:firstRegion,name:firstRegion}]}}};
  window.p4Hooks = {
    observed,history,bump:()=>setRevision(v=>v+1),setSavedDirectionField,setReadOnly,setEntityId,setFirstRegion,setPublishOpen,setShowLibrary,setScope,
    session:id=>useEditorStore.setState({sceneSessionId:id}),
    drawing:getEffectPathDrawing,
    installSignedZeroData:()=>setConfiguration(current=>({...current,data:{...structuredClone(current.data),mode:'mqtt',sourceId:'default',deviceType:'rgv',assetCode:'000317',mappings:[{field:'speed',target:'speed',scale:-0,offset:-0,values:[{value:'0',output:-0}]}]}})),
  };
  return <main data-revision={revision}>
    <section id="direction"><ConveyorSurfaceArrowDirectionInspector value={{mode:'point',field:savedDirectionField,forwardValue:'1',reverseValue:'2',stopValue:'0'}} disabled={false} onChange={()=>observed.commits++}/></section>
    <section id="data"><EffectDataBindingInspector component={{...effect}} configuration={structuredClone(configuration)} disabled={false} onChange={value=>{observed.commits++;observed.lastData=value.data;setConfiguration(value)}}/></section>
    <section id="drawing"><EffectPathDrawingControls entityId={entityId} component={regionComponent} disabled={readOnly} onChange={()=>observed.commits++}/></section>
    <section id="library">{showLibrary&&<CompositionLibrary readOnly={readOnly} search="" onSearchChange={()=>{}}/>}</section>
    <section id="publish"><DigitalTwinPublishDialog open={publishOpen} controller={{state:publishState,isBusy:false,loadContext,reset,start:async()=>null,cancel:async()=>{}}} onClose={()=>setPublishOpen(false)}/></section>
  </main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;

test('P4 实际 React 组件保留草稿、会话门控、回调及异步失效生命周期', async () => {
  await mkdir(output, { recursive: true });
  const entry = path.join(output, 'harness.tsx');
  const bundle = path.join(output, 'bundle');
  await writeFile(entry, harness, 'utf8');
  await build({
    configFile: false,
    root: projectRoot,
    plugins: [react()],
    publicDir: false,
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' },
    build: { lib: { entry, formats: ['es'], fileName: 'fixture', cssFileName: 'fixture' }, outDir: bundle, minify: false },
  });
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      const requested = new URL(request.url, 'http://127.0.0.1').pathname;
      if (requested === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
        return;
      }
      const file = path.resolve(bundle, '.' + requested);
      if (!file.startsWith(bundle + path.sep)) throw new Error('测试资源路径越界');
      response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'application/javascript');
      response.end(await readFile(file));
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  let browser;
  const checks = [];
  const check = (name, value, expected) => { assert.deepEqual(value, expected, name); checks.push(name); };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.p4Hooks?.observed.loads === 1 && window.p4Hooks.observed.lists.length === 1 && window.p4Hooks.observed.historyLists.length === 1);

    const direction = page.locator('#direction');
    await direction.locator('summary').click();
    await direction.locator('input').first().fill('unsaved_direction');
    await page.evaluate(() => window.p4Hooks.bump());
    check('同内容方向绑定新对象不覆盖未应用草稿', await direction.locator('input').first().inputValue(), 'unsaved_direction');

    await page.evaluate(() => window.p4Hooks.setSavedDirectionField('server_direction'));
    await page.waitForFunction(() => document.querySelector('#direction input').value === 'server_direction');
    check('实际保存的方向签名变化仍刷新草稿', await direction.locator('input').first().inputValue(), 'server_direction');

    const data = page.locator('#data');
    await data.getByLabel('特效数据来源', { exact: true }).selectOption('mqtt');
    await data.getByLabel('资产编号', { exact: true }).fill('000317');
    await page.evaluate(() => window.p4Hooks.bump());
    check('同签名数据配置新对象保留数据绑定草稿', await data.getByLabel('资产编号', { exact: true }).inputValue(), '000317');
    await data.getByRole('button', { name: '添加字段映射', exact: true }).click();
    await data.locator('details.effect-data-enum summary').click();
    await data.getByLabel('映射 1 枚举 JSON', { exact: true }).fill('[{"value":"1","output":2}]');
    await page.evaluate(() => window.p4Hooks.bump());
    check('枚举未应用草稿跨父级回调身份变化保留', await data.getByLabel('映射 1 枚举 JSON', { exact: true }).inputValue(), '[{"value":"1","output":2}]');
    check('枚举待应用门禁保持生效且不重复通知循环', await data.getByRole('button', { name: '应用数据配置', exact: true }).isDisabled(), true);
    check('仅编辑和父组件重绘不提交业务配置', await page.evaluate(() => window.p4Hooks.observed.commits), 0);

    await page.evaluate(() => window.p4Hooks.installSignedZeroData());
    await data.getByLabel('预期更新间隔 (ms)', { exact: true }).fill('1500');
    await data.getByRole('button', { name: '应用数据配置', exact: true }).click();
    await page.waitForFunction(() => window.p4Hooks.observed.commits === 1);
    check('签名只作门禁且真实草稿保留合法负零', await page.evaluate(() => { const mapping = window.p4Hooks.observed.lastData.mappings[0]; return [mapping.scale,mapping.offset,mapping.values[0].output].map(value => Object.is(value,-0)); }), [true,true,true]);

    await page.evaluate(() => window.p4Hooks.setReadOnly(false));
    const drawing = page.locator('#drawing');
    await drawing.getByLabel('绘制区域 ID', { exact: true }).fill('尚未应用区域');
    await page.evaluate(() => window.p4Hooks.setFirstRegion('区域B'));
    check('同实体区域参数刷新不重置绘制草稿', await drawing.getByLabel('绘制区域 ID', { exact: true }).inputValue(), '尚未应用区域');
    await page.evaluate(() => window.p4Hooks.setEntityId('region-b'));
    await page.waitForFunction(() => document.querySelector('#drawing input').value === '区域B');
    check('切换实际实体按最新区域初始化', await drawing.getByLabel('绘制区域 ID', { exact: true }).inputValue(), '区域B');

    const publish = page.locator('#publish');
    await publish.getByLabel('发布名称', { exact: true }).fill('用户发布草稿');
    await page.evaluate(() => window.p4Hooks.bump());
    check('新controller包装对象不重复读取context', await page.evaluate(() => window.p4Hooks.observed.loads), 1);
    check('新controller包装对象不重置发布草稿', await publish.getByLabel('发布名称', { exact: true }).inputValue(), '用户发布草稿');

    await page.evaluate(() => window.p4Hooks.setReadOnly(false));
    check('readOnly变化不重新读取组合库', await page.evaluate(() => window.p4Hooks.observed.lists.length), 1);
    await page.evaluate(() => window.p4Hooks.observed.lists[0]([]));
    await page.waitForTimeout(50);
    check('组合首次读取保留原只读会话快照', await page.evaluate(() => window.p4Hooks.observed.syncs), 0);
    await drawing.getByRole('button', { name: '场景绘制', exact: true }).click();
    check('可编辑状态能启动真实绘制会话', await page.evaluate(() => window.p4Hooks.drawing()?.entityId), 'region-b');
    await page.evaluate(() => window.p4Hooks.setReadOnly(true));
    await page.waitForFunction(() => window.p4Hooks.drawing() === null);
    check('只读切换取消真实绘制会话', await page.evaluate(() => window.p4Hooks.drawing()), null);

    await page.evaluate(() => { window.p4Hooks.setReadOnly(false); window.p4Hooks.session('hooks-b'); });
    await page.waitForFunction(() => window.p4Hooks.observed.lists.length === 2 && window.p4Hooks.observed.loads === 2);
    await page.evaluate(() => window.p4Hooks.session('hooks-c'));
    await page.waitForFunction(() => window.p4Hooks.observed.lists.length === 3 && window.p4Hooks.observed.loads === 3);
    await page.evaluate(() => window.p4Hooks.observed.lists[1]([{ id:'old',name:'过期组合不应显示' }]));
    await page.waitForTimeout(50);
    check('旧会话组合结果不显示', await page.locator('#library').getByText('过期组合不应显示').count(), 0);
    check('旧会话组合结果不触发同步', await page.evaluate(() => window.p4Hooks.observed.syncs), 0);
    await page.evaluate(() => window.p4Hooks.observed.lists[2]([]));
    await page.waitForFunction(() => window.p4Hooks.observed.syncs === 1);
    check('新可编辑会话仅自动同步一次', await page.evaluate(() => window.p4Hooks.observed.syncs), 1);

    check('父组件无关重绘不重建巡检历史控制器', await page.evaluate(() => window.p4Hooks.observed.historyLists.length), 1);
    await page.evaluate(() => window.p4Hooks.setScope('scope-b'));
    await page.waitForFunction(() => window.p4Hooks.observed.historyLists.length === 2);
    await page.evaluate(() => window.p4Hooks.observed.historyLists[0]([{taskId:'stale'}]));
    await page.waitForTimeout(50);
    check('旧scope历史结果不污染当前列表', await page.evaluate(() => window.p4Hooks.history.history.records.length), 0);
    await page.evaluate(() => window.p4Hooks.observed.historyLists[1]([]));
    await page.waitForFunction(() => !window.p4Hooks.history.history.loading);
    check('巡检历史仅按实际scope重新读取', await page.evaluate(() => window.p4Hooks.observed.scopes), ['scope-a', 'scope-b']);
    check('实际组件执行无pageerror', errors, []);
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, errors }, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
