import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const project = path.resolve();
const require = createRequire(path.join(project, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
const { chromium } = require('playwright');
const output = path.join(project, 'output/playwright/generated-follow-ui');
await mkdir(output, { recursive: true });
const harness = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {EffectConfigurationInspector} from '/src/editor/panels/EffectConfigurationInspector';
import {RuntimeFollowControls} from '/src/shared/ui/RuntimeFollowControls';
import {useEditorStore} from '/src/editor/store/editorStore';
import {deviceTelemetryStore} from '/src/runtime/mqtt/deviceTelemetry';
import {publishEffectDiagnostic,clearEffectDiagnostic,registerEffectFollowSelection,registerEffectFollowResume} from '/src/runtime/effects/effectDiagnostics';
import '/src/styles/global.css';
const scene={entityIds:['generator'],entities:{generator:{id:'generator',name:'货物生成器',components:{modelGenerator:{}}}},sceneSettings:{environment:null},selectedEntityId:'follow',mqttConfig:{subscriptions:[{topic:'fixture',adapter:{kind:'epv',sourceId:'factory-a'}}]}};
useEditorStore.setState({scene});
const state={commits:0,selection:[],resumes:0};
let sequence=0;
const publish=(assetCode)=>deviceTelemetryStore.upsert({sourceId:'factory-a',assetCode,deviceType:'rgv',topic:'fixture',payloadDeviceCode:null,sourceTimestamp:Date.now(),sequence:++sequence,receivedAt:Date.now(),fields:{speed:2},currentLocationKey:null,targetLocationKey:null,hasTargetLocation:false,faulted:false,message:''});
function App(){
  const [component,setComponent]=useState({effectKind:'target-follow',enabled:true,primaryColor:'#22ffff',secondaryColor:'#ffffff',intensity:1,speed:1,density:1});
  const [disabled,setDisabled]=useState(false);
  const diagnostic=(patch={})=>{const value={status:'waiting',message:'等待运行时生成',candidates:[],identity:null,updatedAt:null,fields:{},effectKind:'target-follow',effectName:'货物跟随',selectedTargetId:null,bindingSignature:JSON.stringify(component.configuration?.target),...patch};publishEffectDiagnostic('follow',value);return value;};
  registerEffectFollowSelection('follow',id=>{state.selection.push(id);diagnostic({selectedTargetId:id,message:id?'已选择运行实例':'等待重新选择',candidates:[{id:'cargo-1',name:'货物 1',assetCode:'',containerCode:'000031',origin:'generated',state:'ready'}]});});
  registerEffectFollowResume('follow',()=>{state.resumes++;});
  window.followUi={state,component,setDisabled,publish,diagnostic,clear:()=>clearEffectDiagnostic('follow')};
  return <><main style={{width:460,padding:18,marginLeft:360,background:'#17232f',color:'#e7eff8'}}><h2>生成模型跟随配置</h2><EffectConfigurationInspector component={component} disabled={disabled} onChange={next=>{state.commits++;setComponent(next);}}/></main><RuntimeFollowControls/></>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
await writeFile(path.join(output, 'harness.tsx'), harness, 'utf8');
const storeFixture = { name: 'generated-follow-store-fixture', enforce: 'pre',
  resolveId(source, importer) {
    if (source === '/src/editor/store/editorStore' || source === '../store/editorStore' && /Effect(Configuration|DataBinding)Inspector\.tsx$/.test(importer ?? '')) return '\0generated-follow-store';
  },
  load(id) { if (id === '\0generated-follow-store') return "import {create} from 'zustand';export const useEditorStore=create(()=>({scene:null}));"; },
};
const bundle = path.join(output, 'bundle');
await build({ configFile: false, root: project, plugins: [storeFixture, react()], define: { 'process.env.NODE_ENV': '"production"' }, build: { lib: { entry: path.join(output, 'harness.tsx'), formats: ['es'], fileName: 'fixture', cssFileName: 'fixture' }, outDir: bundle, emptyOutDir: false, minify: false } });
const server = createServer(async (request, response) => {
  const file = request.url === '/fixture.js' ? 'fixture.js' : request.url === '/fixture.css' ? 'fixture.css' : null;
  response.setHeader('Content-Type', file?.endsWith('.js') ? 'application/javascript' : file ? 'text/css' : 'text/html');
  response.end(file ? await readFile(path.join(bundle, file)) : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');
});
const errors = [];
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('button', { name: '启用详细配置与数据绑定', exact: true }).click();
  assert.equal(await page.getByLabel('特效目标来源').inputValue(), 'model');
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.setData('application/x-babylon-editor-model-asset', JSON.stringify({ id: 'cargo-template', name: '货物模板.glb', path: 'C:/fixture/cargo.glb', sourceUrl: 'editor-asset://local/cargo.glb', kind: 'model', libraryKind: 'model' }));
    return data;
  });
  await page.getByRole('region', { name: '特效模型模板拖放区' }).dispatchEvent('drop', { dataTransfer: transfer });
  await page.getByRole('status').filter({ hasText: '模型类型已绑定' }).waitFor();
  await page.getByLabel('跟随实例来源').selectOption('generated');
  await page.getByLabel('跟随生成器范围').selectOption('generator');
  await page.getByLabel('跟随实例定位方式').selectOption('manual');
  await page.getByLabel('目标数据源', { exact: true }).selectOption('factory-a');
  await page.getByLabel('目标协议设备类型').fill('rgv');
  await page.getByLabel('目标资产编号').fill('000317');
  assert.equal(await page.evaluate(() => window.followUi.component.configuration.target.assetCode), '000317');
  await page.getByLabel('特效数据来源').selectOption('inherit');
  await page.evaluate(() => window.followUi.publish('000317'));
  await page.getByRole('button', { name: '测试取数', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '状态：在线' }).waitFor();
  await page.getByLabel('跟随实例编号类型').selectOption('containerCode');
  await page.getByLabel('目标资产编号').fill('000031');
  await page.getByRole('button', { name: '测试取数', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '容器编号不能代替设备号' }).waitFor();
  await page.getByLabel('继承数据身份').selectOption('carrier');
  await page.evaluate(() => { window.followUi.publish('carrier-007'); window.followUi.diagnostic({ carrierIdentity: { sourceId: 'factory-a', deviceType: 'rgv', assetCode: 'carrier-007' } }); });
  await page.getByRole('button', { name: '测试取数', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '状态：在线' }).waitFor();
  const persisted = await page.evaluate(() => ({ component: JSON.stringify(window.followUi.component), commits: window.followUi.state.commits }));
  await page.evaluate(() => {
    window.followUi.setDisabled(true);
    window.followUi.diagnostic({ status: 'ambiguous', message: '请选择一个运行实例', candidates: [
      { id: 'cargo-1', name: '货物 1', assetCode: '', containerCode: '000031', origin: 'generated', state: 'ready' },
      { id: 'cargo-2', name: '货物 2', assetCode: '', containerCode: '000032', origin: 'generated', state: 'loading' },
      { id: 'cargo-3', name: '货物 3', assetCode: '', containerCode: '000033', origin: 'generated', state: 'error' },
    ] });
  });
  await page.waitForFunction(() => document.querySelector('[aria-label="跟随实例来源"]')?.disabled === true && document.querySelector('option[value="cargo-2"]')?.disabled === true);
  assert.equal(await page.getByLabel('跟随实例来源').isDisabled(), true);
  assert.equal(await page.getByLabel('货物跟随 运行目标').isEnabled(), true);
  assert.equal(await page.getByLabel('货物跟随 运行目标').locator('option[value="cargo-2"]').evaluate(option => option.disabled), true);
  assert.equal(await page.getByLabel('货物跟随 运行目标').locator('option[value="cargo-3"]').evaluate(option => option.disabled), true);
  await page.getByLabel('货物跟随 运行目标').selectOption('cargo-1');
  await page.getByRole('region', { name: '运行时目标跟随' }).getByRole('button', { name: '恢复跟随', exact: true }).click();
  await page.getByRole('button', { name: '清除本次选择', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.followUi.state.selection), ['cargo-1', null]);
  assert.equal(await page.evaluate(() => window.followUi.state.resumes), 1);
  assert.deepEqual(await page.evaluate(() => ({ component: JSON.stringify(window.followUi.component), commits: window.followUi.state.commits })), persisted);
  await page.screenshot({ path: path.join(output, 'generated-follow-ui.png'), fullPage: false });
  await page.evaluate(() => window.followUi.clear());
  await page.getByRole('region', { name: '运行时目标跟随' }).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  const result = { passed: true, errors, scenarios: ['zero-instance model drop', 'source/generator/manual configuration', 'pre-generation exact device fetch', 'container identity rejected as device', 'explicit carrier identity fetch', 'locked inspector with active session selection', 'loading/error candidate disabled', 'selection/resume leave document unchanged', 'diagnostic cleanup'] };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
