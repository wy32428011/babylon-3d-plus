import assert from 'node:assert/strict';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { _electron as electron } from 'playwright';

const output = path.resolve('output/playwright/chart-marker-background');
await mkdir(output, { recursive: true });
const formats = ['png', 'jpeg', 'webp', 'gif', 'svg'];
const entries = formats.map(format => ({
  id: 'fixture-' + format, name: '同步背景 ' + format, reference: 'editor-image://platform/bg_' + format,
  sourceUrl: 'editor-asset://local/' + encodeURIComponent(path.join(output, 'fixture.' + format)),
  filePath: path.join(output, 'fixture.' + format), fileName: 'fixture.' + format, iconKey: 'bg_' + format,
}));
const temporary = [...entries.map(e => e.filePath), path.join(output, `main-fixture-${process.pid}.mjs`)];
const moduleSource = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChartMarkerInspector } from '/src/editor/panels/ChartMarkerInspector.tsx';
import { useEditorStore } from '/src/editor/store/editorStore.ts';
import { setSyncedImageAssets } from '/src/assets/syncedImageAssets.ts';
import { BUILT_IN_IMAGE_ASSETS } from '/src/assets/imageAssets.ts';
import { encodeImageAssetDragPayload, IMAGE_ASSET_DRAG_MIME_TYPE } from '/src/editor/assets/AssetDatabase.ts';
import '/src/styles/global.css';
const entries=${JSON.stringify(entries)};
setSyncedImageAssets(entries);
useEditorStore.getState().newScene();useEditorStore.getState().createChartMarker({x:0,y:0,z:0});
function App(){const entity=useEditorStore(s=>s.scene.entities[s.scene.selectedEntityId]);return React.createElement('div',{className:'inspector-panel',style:{width:380,padding:16}},
React.createElement('div',{},[BUILT_IN_IMAGE_ASSETS[0],...entries].map(asset=>React.createElement('button',{key:asset.id,draggable:true,onDragStart:e=>e.dataTransfer.setData(IMAGE_ASSET_DRAG_MIME_TYPE,encodeImageAssetDragPayload(asset))},asset.name))),
React.createElement(ChartMarkerInspector,{entity,disabled:false}));}
createRoot(document.querySelector('#root')).render(React.createElement(App));
window.backgroundFixture={store:useEditorStore,entries,marker(){const s=useEditorStore.getState();return s.scene.entities[s.scene.selectedEntityId].components.chartMarker;}};
`;
const fixtureHtml = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#202124"><div id="root"></div><script type="module" src="/__background_inspector__.tsx"></script></body></html>';
const server = await createServer({
  cacheDir: path.join(output, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  plugins: [{ name: 'background-inspector-fixture', configureServer(server) {
    server.middlewares.use((req,res,next)=>{
      if(req.url!=='/__background_inspector__')return next();
      server.transformIndexHtml(req.url,fixtureHtml).then(html=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);},next);
    });
  }, resolveId(id){if(id==='/__background_inspector__.tsx')return '\0background-inspector.tsx';}, load(id){if(id==='\0background-inspector.tsx')return moduleSource;} }],
});
let app;
try {
  await server.listen();
  const url=server.resolvedUrls.local[0];
  const readerUrl=pathToFileURL(path.resolve('dist-electron/ipc/syncedImageRead.js')).href;
  const main=`import {app,BrowserWindow,ipcMain} from 'electron';import {readRegisteredSyncedImage} from ${JSON.stringify(readerUrl)};
app.setPath('userData',${JSON.stringify(path.join(output,'user-data'))});globalThis.readReferences=[];
ipcMain.handle('data-platform:readSyncedImage',(event,reference)=>{if(event.senderFrame!==event.sender.mainFrame)throw new Error('主窗口');globalThis.readReferences.push(reference);return readRegisteredSyncedImage(reference,${JSON.stringify(entries)});});
app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,width:900,height:1000,webPreferences:{preload:${JSON.stringify(path.resolve('dist-electron/preload.cjs'))},contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await window.loadURL(${JSON.stringify(url+'__background_inspector__')});});`;
  await writeFile(temporary.at(-1),main);
  const electronEnv={...process.env};delete electronEnv.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[temporary.at(-1)],env:electronEnv,timeout:60_000});
  app.process().stderr.on('data',data=>{if(String(data).includes('Error'))process.stderr.write(data);});
  const page=await app.firstWindow({timeout:60_000});page.setDefaultTimeout(90_000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>window.backgroundFixture);
  assert.equal(await page.evaluate(()=>typeof window.editorApi.readSyncedImage),'function','打包用 preload.cjs 必须暴露读取桥接');
  const images=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=32;const ctx=canvas.getContext('2d');ctx.fillStyle='#27ac86';ctx.fillRect(0,0,32,32);
    return Object.fromEntries(['png','jpeg','webp'].map(type=>[type,canvas.toDataURL('image/'+type).split(',')[1]]));
  });
  for(const format of ['png','jpeg','webp'])await writeFile(path.join(output,'fixture.'+format),Buffer.from(images[format],'base64'));
  await writeFile(path.join(output,'fixture.gif'),Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'));
  await writeFile(path.join(output,'fixture.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="2500"><rect width="2500" height="2500" fill="#27ac86"/></svg>');
  assert.equal(await page.evaluate(()=>window.backgroundFixture.marker().backgroundColor),'transparent');
  const color=page.getByLabel('背景颜色',{exact:true});
  await color.evaluate(input=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'#123456');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForFunction(()=>window.backgroundFixture.marker().backgroundColor==='#123456');
  await page.getByRole('button',{name:'无色',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.backgroundFixture.marker().backgroundColor),'transparent');
  await page.evaluate(()=>window.backgroundFixture.store.getState().undo());assert.equal(await page.evaluate(()=>window.backgroundFixture.marker().backgroundColor),'#123456');
  await page.evaluate(()=>window.backgroundFixture.store.getState().redo());assert.equal(await page.evaluate(()=>window.backgroundFixture.marker().backgroundColor),'transparent');
  const slot=page.getByLabel('图表立标背景图片槽位');
  await page.getByRole('button',{name:'方向箭头发光贴图',exact:true}).dragTo(slot);
  await page.waitForFunction(()=>window.backgroundFixture.marker().backgroundImage.startsWith('data:image/png;base64,'));
  for(const format of formats){
    await page.getByRole('button',{name:'恢复默认',exact:true}).click();
    await page.getByRole('button',{name:'同步背景 '+format,exact:true}).dragTo(slot);
    await page.waitForFunction(()=>!!window.backgroundFixture.marker().backgroundImage);
    const info=await page.evaluate(async()=>{const value=window.backgroundFixture.marker().backgroundImage;const image=new Image();image.src=value;await image.decode();return {width:image.naturalWidth,height:image.naturalHeight,type:value.slice(0,value.indexOf(';'))};});
    assert.equal(info.type, 'data:image/'+(['svg','gif'].includes(format)?'png':format));
    assert.ok(info.width<=4096&&info.height<=4096);
    if(format==='svg')assert.equal(info.width,4096,'库内超大图片自动适配');
    assert.equal(await page.getByRole('alert').count(),0);
  }
  await page.evaluate(async()=>{const {serializeScene,deserializeScene}=await import('/src/editor/project/SceneSerializer.ts');const s=window.backgroundFixture.store.getState().scene;const a=s.entities[s.selectedEntityId].components.chartMarker,b=deserializeScene(serializeScene(s)).entities[s.selectedEntityId].components.chartMarker;if(a.backgroundColor!==b.backgroundColor||a.backgroundImage!==b.backgroundImage)throw new Error('背景保存重开不一致');});
  assert.deepEqual(await app.evaluate(()=>globalThis.readReferences),entries.map(e=>e.reference));
  await page.screenshot({path:path.join(output,'inspector.png')});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,formats,checks:['packaged preload','builtin drag','synced image IPC drag','transparent color','undo redo','large image resize','save reload'],screenshot:path.join(output,'inspector.png')}));
} finally {
  await app?.close();await server.close();
  for(const file of temporary)await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
}
