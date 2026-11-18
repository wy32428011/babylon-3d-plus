/* global window, document, requestAnimationFrame -- 页面回调由 Playwright 在隔离浏览器执行。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const { chromium } = createRequire(import.meta.url)('playwright');
const projectRoot = process.cwd();
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {InspectionBindingInspector} from '/src/editor/panels/InspectionBindingInspector';
import {createEmptySceneDocument,createModelEntity} from '/src/editor/model/SceneDocument';
import {useEditorStore} from '/src/editor/store/editorStore';
const toUrl=path=>'editor-asset://local/'+encodeURIComponent(path);
const config={schema:'babylon-editor.model-parameters',version:1,parameters:[{key:'width',label:'宽度',type:'number',defaultValue:6}],bindings:[]};
const scene=createEmptySceneDocument('详情测试');
const entity=createModelEntity('C:/low/device.glb',toUrl('C:/low/device.glb'),'设备',undefined,undefined,config);
scene.entities[entity.id]=entity;scene.entityIds.push(entity.id);scene.selectedEntityId=entity.id;
useEditorStore.setState({scene,runtimeMode:'edit',sceneSessionId:'test-a',hierarchySelectionIds:[entity.id]});
const parts=[{partKey:'base',name:'底座',nodePath:'.',axis:{x:0,y:1,z:0},distanceMeters:0,fixed:true}];
const result=versionId=>({model:{dataPlatformModel:{sourceKey:'a'.repeat(64),kind:'model',resourceId:'9007199254740993',modelPath:'part.glb'},versionId,contentSha256:(versionId==='1'?'b':'c').repeat(64),sourcePath:'C:/fixed/part.glb',sourceUrl:toUrl('C:/fixed/part.glb'),metaPath:'C:/fixed/meta.json',metaUrl:toUrl('C:/fixed/meta.json'),unitScaleToMeters:1},...(versionId==='2'?{parts,configuration:{id:'metadata-cfg',parameters:{width:6}}}:versionId==='3'?{parts,configuration:{id:'other-cfg',parameters:{width:9}}}:{})});
const mock={calls:[],failList:false,defer:false,pending:null,result,parts,entityId:entity.id};
window.editorApi={
 listInspectionModels:async()=>{mock.calls.push('models');if(mock.failList)throw Error('网络不可用');return [{resourceId:'9007199254740993',displayName:'高模 A'}]},
 listInspectionModelVersions:async request=>{mock.calls.push(request);return [{versionId:'1',label:'版本一'},{versionId:'2',label:'版本二'},{versionId:'3',label:'版本三'}]},
 prepareInspectionModelVersion:async request=>{mock.calls.push(request);if(mock.defer)return await new Promise(resolve=>{mock.pending=()=>resolve(result(request.versionId))});return result(request.versionId)},
};
window.inspectionFixture={mock,getBinding:()=>useEditorStore.getState().scene.entities[entity.id].components.modelAsset.inspection,undo:()=>useEditorStore.getState().undo(),redo:()=>useEditorStore.getState().redo(),refreshClone:()=>useEditorStore.setState(state=>({scene:structuredClone(state.scene)})),newSession:()=>useEditorStore.setState({sceneSessionId:'test-b'})};
function App(){const asset=useEditorStore(state=>state.scene.entities[entity.id].components.modelAsset);return <InspectionBindingInspector modelAsset={asset}/>}
createRoot(document.getElementById('root')).render(<App/>);
`;

test('详情表单选择固定版本、校验规则并隔离失效请求', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'inspection-ui-test-'));
  const entry = path.join(temp, 'harness.tsx');
  const bundle = path.join(temp, 'bundle');
  let browser;
  let server;
  const pageErrors = [];
  try {
    await writeFile(entry, harness, 'utf8');
    await build({ configFile: false, root: projectRoot, plugins: [react()], publicDir: false, logLevel: 'error',
      resolve: { alias: [{ find: 'react-dom', replacement: path.join(projectRoot, 'node_modules/react-dom') },
        { find: 'react', replacement: path.join(projectRoot, 'node_modules/react') }] },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: { lib: { entry, formats: ['es'], fileName: 'fixture' }, outDir: bundle, minify: false } });
    server = createServer(async (request, response) => {
      try {
        if (request.url === '/') {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>');
        } else {
          const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
          const file = path.resolve(bundle, '.' + pathname);
          if (!file.startsWith(bundle + path.sep)) throw new Error('测试资源路径越界');
          response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'application/octet-stream');
          response.end(await readFile(file));
        }
      } catch { response.statusCode = 500; response.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => { if (response.status() >= 400 && new URL(response.url()).pathname.endsWith('.js')) pageErrors.push(response.status() + ' ' + response.url()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByRole('button', { name: '读取高模列表' }).click();
    await page.getByLabel('高模', { exact: true }).selectOption('9007199254740993');
    await page.getByRole('button', { name: '读取模型版本' }).click();
    await page.getByLabel('固定版本').selectOption('1');
    await page.getByRole('button', { name: '准备固定版本' }).click();
    await page.getByRole('status').filter({ hasText: '资源未提供适用的零件规则' }).waitFor();
    assert.equal(await page.evaluate(() => window.inspectionFixture.getBinding()), undefined);
    await page.getByRole('button', { name: '应用详情绑定' }).click();
    await page.getByRole('alert').filter({ hasText: 'parts' }).waitFor();
    await page.getByLabel('零件规则 JSON').fill(JSON.stringify([{partKey:'base',name:'底座',nodePath:'.',axis:{x:0,y:1,z:0},distanceMeters:0,fixed:true}]));
    await page.getByLabel('设备命名空间').fill('factory');
    await page.getByRole('button', { name: '应用详情绑定' }).click();
    await page.getByRole('alert').filter({ hasText: 'device' }).waitFor();
    await page.getByLabel('设备类型').fill('conveyor');
    await page.getByLabel('设备编号').fill('CV021');
    await page.getByRole('button', { name: '应用详情绑定' }).click();
    await page.waitForFunction(() => window.inspectionFixture.getBinding()?.device?.deviceNo === 'CV021');
    const first = await page.evaluate(() => window.inspectionFixture.getBinding());
    assert.equal(first.model.versionId, '1');
    assert.equal(first.model.contentSha256, 'b'.repeat(64));
    assert.equal(first.model.dataPlatformModel.resourceId, '9007199254740993');
    assert.equal(first.configuration.parameters.width, 6);
    await page.getByLabel('设备编号').fill('尚未应用');
    await page.evaluate(() => window.inspectionFixture.refreshClone());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByLabel('设备编号').inputValue(), '尚未应用');
    await page.getByLabel('设备编号').fill('CV021');
    await page.evaluate(() => window.inspectionFixture.undo());
    await page.waitForFunction(() => !window.inspectionFixture.getBinding());
    await page.evaluate(() => window.inspectionFixture.redo());
    await page.waitForFunction(() => window.inspectionFixture.getBinding()?.device?.deviceNo === 'CV021');
    await page.getByLabel('固定版本').selectOption('2');
    assert.equal(await page.getByRole('button', { name: '应用详情绑定' }).isDisabled(), true);
    await page.getByRole('button', { name: '准备固定版本' }).click();
    await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('底座'));
    await page.getByRole('button', { name: '应用详情绑定' }).click();
    await page.waitForFunction(() => window.inspectionFixture.getBinding()?.model.versionId === '2');
    const second = await page.evaluate(() => window.inspectionFixture.getBinding());
    assert.equal(second.model.contentSha256, 'c'.repeat(64));
    assert.equal(second.configuration.id, 'metadata-cfg');
    assert.notEqual(second.configuration.id, first.configuration.id);
    assert.deepEqual(second.parts, first.parts);
    await page.getByLabel('固定版本').selectOption('3');
    await page.getByRole('button', { name: '准备固定版本' }).click();
    await page.getByRole('alert').filter({ hasText: '参数快照与当前模型不匹配' }).waitFor();
    assert.deepEqual(JSON.parse(await page.getByLabel('零件规则 JSON').inputValue()), []);
    assert.equal((await page.evaluate(() => window.inspectionFixture.getBinding())).model.versionId, '2');
    await page.getByLabel('固定版本').selectOption('1');
    await page.evaluate(() => { window.inspectionFixture.mock.defer = true; });
    await page.getByRole('button', { name: '准备固定版本' }).click();
    await page.waitForFunction(() => !!window.inspectionFixture.mock.pending);
    await page.evaluate(() => { window.inspectionFixture.newSession(); window.inspectionFixture.mock.pending(); });
    await page.waitForFunction(() => !document.querySelector('fieldset').disabled);
    assert.equal(await page.getByLabel('固定版本').inputValue(), '2');
    assert.equal((await page.evaluate(() => window.inspectionFixture.getBinding())).model.versionId, '2');
    await page.evaluate(() => { window.inspectionFixture.mock.failList = true; });
    await page.getByRole('button', { name: '读取高模列表' }).click();
    await page.getByRole('alert').filter({ hasText: '网络不可用' }).waitFor();
    assert.deepEqual(pageErrors, []);
  } catch (error) {
    if (pageErrors.length) error.message += '\n浏览器错误：' + pageErrors.join(' | ');
    throw error;
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await rm(temp, { recursive: true, force: true });
  }
});
