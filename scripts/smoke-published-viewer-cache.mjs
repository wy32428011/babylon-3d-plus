import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const [scenePath, modelPath] = process.argv.slice(2);
if (!scenePath || !modelPath) throw new Error('用法：node scripts/smoke-published-viewer-cache.mjs <已有发布scene.json> <含Draco的GLB>');
const source = JSON.parse(await readFile(scenePath, 'utf8'));
const model = await readFile(modelPath);
const logicalUrl = 'editor-asset://local/project%2Fassets%2Fmodel.glb';
const scene = structuredClone(source);
// 从合法发布文档构造只有一个无业务绑定模型的最小夹具，源场景不写回。
scene.scene.entities = { model: { id: 'model', name: '缓存验收模型', isFolder: false, visible: true, locked: false,
  parentId: null, childrenIds: [], components: {
    transform: { position: { x: 0,y: 0,z: 0 }, rotation: { x: 0,y: 0,z: 0 }, scale: { x: 1,y: 1,z: 1 } },
    modelAsset: { sourcePath: logicalUrl, sourceUrl: logicalUrl, assetRevision: 'fixture', lengthUnit: 'meter', unitScaleToMeters: 1 },
  } } };
scene.scene.entityIds = ['model']; scene.scene.selectedEntityId = null;
scene.scene.fetchConfig = {url:'',apiKey:''};
scene.scene.sceneSettings = { camera: { savedPose: { alpha: -Math.PI/3, beta: Math.PI/3, radius: 6, target: {x:0,y:0,z:0} },
  savedOrientation: 'orbit', savedProjection: 'perspective', viewDistance: 1000 } };
const mqtt = { enabled:false,ip:'',address:'',topic:'',subscriptions:[],simulatorEnabled:false,simulatorAssetCode:'',simulatorScenario:'cycle',simulatorIntervalMs:500 };
scene.scene.mqttConfig = mqtt;
let revision = 'release-1';
const template = path.resolve('dist-viewer-template');
const output = path.resolve('output/playwright/published-viewer-cache');
await mkdir(output, {recursive:true});
const counts = new Map();
const config = () => ({version:2,cacheRevision:revision,page:{title:'发布缓存验收',loadingText:'场景加载中...',backgroundColor:'#141414'},
  paths:{scene:'./project/scene.json',assetManifest:'./project/asset-manifest.json',assetBase:'./project/assets/'},
  viewer:{showGrid:false,allowCameraControl:true,showStatusOverlay:false},mqtt,
  digitalTwin:{projectId:'9001',runtimeConfigEndpoint:'/api/runtime-config'} });
const server = createServer((request,response)=>{ void (async()=>{
  const pathname = decodeURIComponent(new URL(request.url,'http://fixture').pathname);
  counts.set(pathname,(counts.get(pathname)??0)+1);
  response.setHeader('Cache-Control','no-store');
  if(pathname==='/favicon.ico') { response.statusCode=204; response.end(); return; }
  if(pathname==='/api/runtime-config') {
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({success:true,data:{projectId:'9001',runtimeEnabled:true,mqttBrokerUrl:null,apiBaseUrl:null,configJson:'{}'}})); return;
  }
  if(!pathname.startsWith('/published/')) { response.statusCode=404;response.end();return; }
  const relative=pathname.slice('/published/'.length)||'index.html';
  if(relative==='runtime-config.json') { response.setHeader('Content-Type','application/json');response.end(JSON.stringify(config()));return; }
  if(relative==='project/scene.json') {response.setHeader('Content-Type','application/json');response.end(JSON.stringify(scene));return;}
  if(relative==='project/asset-manifest.json') {response.setHeader('Content-Type','application/json');response.end(JSON.stringify({version:1,assets:{[logicalUrl]:'model.glb'}}));return;}
  if(relative==='project/assets/model.glb') {response.setHeader('Content-Type','model/gltf-binary');response.end(model);return;}
  const file=path.resolve(template,relative);
  assert.ok(file.startsWith(template+path.sep));
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.png':'image/png','.svg':'image/svg+xml'};
  response.setHeader('Content-Type',types[path.extname(file)]??'application/octet-stream');response.end(await readFile(file));
})().catch(error=>{response.statusCode=500;response.end(String(error));}); });
let browser;
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1000,height:700}});
  page.setDefaultTimeout(120000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.decodedReads=0;
    window.decodedWrites=0;
    const get=IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get=function(key){
      const request=get.call(this,key);
      if(this.name==='values'&&String(key).includes(':decoded:'))request.addEventListener('success',()=>{if(request.result)window.decodedReads++;});
      return request;
    };
    const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,key){
      if(this.name==='values'&&String(key).includes(':decoded:'))window.decodedWrites++;
      return key===undefined?put.call(this,value):put.call(this,value,key);
    };
  });
  const url=`http://127.0.0.1:${server.address().port}/published/?performance=1`;
  const samples=[];
  for(const [name,version,downloads] of [['cold','release-1',1],['refresh','release-1',1],['republish','release-2',2],['rollback','release-1',2]]) {
    revision=version;
    if(samples.length)await page.reload();else await page.goto(url);
    await page.locator('.player-performance').waitFor({state:'visible'});
    await page.getByRole('progressbar').waitFor({state:'detached'});
    assert.equal(await page.locator('.player-status-blocked').count(),0);
    const decodedReads=await page.evaluate(()=>window.decodedReads);
    const decodedWrites=await page.evaluate(()=>window.decodedWrites);
    if(name==='refresh'||name==='rollback')assert.ok(decodedReads>0,'实际发布Viewer应读取已解码数据');
    if(name==='refresh'||name==='rollback')assert.equal(decodedWrites,0,'已缓存压缩网格不应重新解码写入');
    for(const resource of ['project/scene.json','project/asset-manifest.json','project/assets/model.glb']) {
      assert.equal(counts.get('/published/'+resource),downloads,resource);
    }
    assert.equal(counts.get('/api/runtime-config'),samples.length+1,'实时项目配置必须每次读取');
    await page.screenshot({path:path.join(output,name+'.png')});
    const sample={name,decodedReads,decodedWrites,modelDownloads:counts.get('/published/project/assets/model.glb'),runtimeConfigReads:counts.get('/api/runtime-config')};
    samples.push(sample);console.log(JSON.stringify(sample));
  }
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'report.json'),JSON.stringify({samples,errors},null,2));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
