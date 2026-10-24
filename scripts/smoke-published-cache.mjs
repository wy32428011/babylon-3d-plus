import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { build } from 'vite';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

// 使用含 Draco 的真实业务模型作为只读输入；测试发布目录和浏览器存储均隔离。
const modelPath = process.argv[2];
if (!modelPath) throw new Error('用法：node scripts/smoke-published-cache.mjs <含Draco的GLB路径> [含KTX2的GLB路径] [新输出目录]');
const model = await readFile(modelPath);
const gltf = JSON.parse(model.subarray(20, 20 + model.readUInt32LE(12)).toString());
assert.ok(gltf.extensionsUsed?.includes('KHR_draco_mesh_compression'), '输入必须实际执行 Draco 解码');
let texture = null;
if (process.argv[3]) {
  const bytes = await readFile(process.argv[3]);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const image = json.images.find(image => image.mimeType === 'image/ktx2');
  assert.ok(image, '输入必须包含 KTX2 图片');
  const view = json.bufferViews[image.bufferView];
  texture = Buffer.from(bytes.subarray(28 + jsonLength + view.byteOffset, 28 + jsonLength + view.byteOffset + view.byteLength));
}
const output = path.resolve(process.argv[4] ?? 'output/playwright/published-cache');
if (process.argv[4]) { await mkdir(path.dirname(output), { recursive: true }); await mkdir(output); }
else await mkdir(output, { recursive: true });
const inputs = [];
for (const file of [modelPath, process.argv[3], 'src/runtime/babylon/ktx2WorkerDecoder.ts', 'src/runtime/babylon/ktx2DecodeWorkerPool.ts', 'src/player/publishedBabylonCache.ts'].filter(Boolean)) inputs.push({path:path.resolve(file),sha256:createHash('sha256').update(await readFile(file)).digest('hex')});
let revision = 'release-1';
const counts = new Map();
const config = () => ({ version: 1, cacheRevision: revision,
  page: { title: '缓存回归', loadingText: '场景加载中...', backgroundColor: '#141414' },
  paths: { scene: './project/scene.json', assetManifest: './project/asset-manifest.json', assetBase: './project/assets/' },
  viewer: { showGrid: false, allowCameraControl: true, showStatusOverlay: false },
  mqtt: { enabled: false, ip: '', address: '', topic: '', subscriptions: [], simulatorEnabled: false,
    simulatorAssetCode: '', simulatorScenario: 'cycle', simulatorIntervalMs: 500 } });
const html = `<!doctype html><html><body style="margin:0"><canvas id="canvas" style="width:800px;height:600px"></canvas>
<script type="module">
import { Engine, Scene, SceneLoader, ArcRotateCamera, Vector3, HemisphericLight, Texture } from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import { registerKtx2WorkerEngine, getLocalKtx2DecodeDiagnostics } from '/src/runtime/babylon/ktx2WorkerDecoder.ts';
import { installPublishedViewerCache } from '/src/player/publishedBabylonCache.ts';
import { parsePlayerRuntimeConfig } from '/src/player/runtimeConfig.ts';
import { fetchRuntimeAsset } from '/src/runtime/assets/runtimeAssetFetch.ts';
import { IndexedDbPublishedCacheStore, PUBLISHED_CACHE_MAX_ENTRY_BYTES } from '/src/runtime/assets/publishedCacheStore.ts';
window.checkPublishedCacheStorage = async()=> {

    const store = new IndexedDbPublishedCacheStore();
    // 使用小值与计费字节验证 LRU，不为测试分配 GiB 数据。
    await store.put('quota:first','one',400*1024*1024);
    await store.put('quota:second','two',400*1024*1024);
    // LRU按毫秒排序，确保这次命中晚于second写入，避免同毫秒并列掩盖访问顺序。
    await new Promise(resolve=>setTimeout(resolve,5));
    await store.get('quota:first');
    await store.put('quota:third','three',400*1024*1024);
    const retained = [await store.get('quota:first'), await store.get('quota:second'), await store.get('quota:third')];
    await store.put('quota:oversize','skip',PUBLISHED_CACHE_MAX_ENTRY_BYTES+1);
    const oversized = await store.get('quota:oversize');
    store.close(); return {retained,oversized};
  };
window.result = null;
try {
  const started = performance.now();
  const config = parsePlayerRuntimeConfig(await (await fetch('./runtime-config.json', {cache:'no-store'})).json());
  const cache = await installPublishedViewerCache(config, new URL('./', location.href).href);
  const engine = new Engine(document.querySelector('canvas'), true, {preserveDrawingBuffer:true});
  registerKtx2WorkerEngine(engine);
  const scene = new Scene(engine);
  cache?.attach(scene);
  const stamp = await (await fetchRuntimeAsset(new URL('./project/scene.json',location.href).href)).text();
  const container = await SceneLoader.LoadAssetContainerAsync(new URL('./project/assets/',location.href).href, 'model.glb', scene);
  container.addAllToScene();
  ${texture ? `const texture = await new Promise((resolve,reject)=>{const value = new Texture(new URL('./project/assets/texture.ktx2',location.href).href, scene, false, false, Texture.BILINEAR_SAMPLINGMODE, ()=>resolve(value), (_message,error)=>reject(error));});
  if(!texture.isReady()) throw new Error('KTX2 纹理未成功上传到 GPU');` : ''}
  const bounds = scene.getWorldExtends();
  const center = bounds.min.add(bounds.max).scale(0.5);
  const radius = Math.max(1, bounds.max.subtract(bounds.min).length());
  new ArcRotateCamera('camera', -Math.PI/3, Math.PI/3, radius*1.5, center, scene);
  new HemisphericLight('light', Vector3.Up(), scene);
  const geometry = container.meshes.filter(mesh=>mesh.getTotalVertices()>0).map(mesh=>({
    positions:Array.from(mesh.getVerticesData('position')??[]),indices:Array.from(mesh.getIndices()??[])}));
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(geometry)));
  const geometryHash = Array.from(new Uint8Array(hashBuffer),b=>b.toString(16).padStart(2,'0')).join('');
  await scene.whenReadyAsync(); scene.render();
  const pixels = await engine.readPixels(0,0,engine.getRenderWidth(),engine.getRenderHeight());
  const colors = new Set(); for(let i=0;i<pixels.length;i+=4) colors.add(pixels[i]+','+pixels[i+1]+','+pixels[i+2]);
  if(colors.size<5) throw new Error('三维模型没有产生可见像素');
  const metrics = {...cache.cache.metrics};
  window.result = {stamp,geometryHash,metrics,decoder:getLocalKtx2DecodeDiagnostics(),renderer:engine.getGlInfo(),colors:colors.size,meshes:geometry.length,ms:performance.now()-started};
  window.cacheSession = cache;
  window.addEventListener('beforeunload',()=>{cache.dispose();scene.dispose();engine.dispose();},{once:true});
} catch(error) { window.result = {error:error.stack??String(error)}; }
</script></body></html>`;
// 与实际DIST一样先打成单一模块图，避免dev预构建把Draco深入口和loader分成两份静态单例。
const entry=path.join(output,'fixture-entry.ts'),site=path.join(output,'site');
await writeFile(entry,html.slice(html.indexOf('<script type="module">')+22,html.indexOf('</script>')));
await build({configFile:false,root:process.cwd(),base:'./',publicDir:false,logLevel:'warn',
  build:{outDir:site,emptyOutDir:false,rollupOptions:{input:entry,output:{entryFileNames:'fixture.js'}}}});
const servedHtml=html.replace(/<script type="module">[\s\S]*?<\/script>/,'<script type="module" src="/fixture.js"></script>');
const server=createServer((request,response)=>{void(async()=>{
  const url=new URL(request.url,'http://fixture');
  if(url.pathname.startsWith('/viewer/'))counts.set(url.pathname,(counts.get(url.pathname)??0)+1);
  response.setHeader('Cache-Control','no-store');
  if(url.pathname==='/viewer/'){response.setHeader('Content-Type','text/html');response.end(servedHtml);return;}
  if(url.pathname==='/viewer/runtime-config.json'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify(config()));return;}
  if(url.pathname==='/viewer/project/scene.json'){response.end(revision);return;}
  if(url.pathname==='/viewer/project/assets/model.glb'){response.setHeader('Content-Type','model/gltf-binary');response.end(model);return;}
  if(url.pathname==='/viewer/project/assets/texture.ktx2'&&texture){response.setHeader('Content-Type','image/ktx2');response.end(texture);return;}
  const decoderPrefix='/viewer/babylon-decoders/';
  const root=url.pathname.startsWith(decoderPrefix)?path.resolve('public/babylon-decoders'):site;
  const relative=decodeURIComponent(url.pathname.startsWith(decoderPrefix)?url.pathname.slice(decoderPrefix.length):url.pathname.slice(1));
  const file=path.resolve(root,relative),delta=path.relative(root,file);
  if(!delta||delta.startsWith('..')||path.isAbsolute(delta)){response.writeHead(404).end();return;}
  try{const bytes=await readFile(file);response.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':'text/javascript');response.end(bytes);}catch{response.writeHead(404).end();}
})().catch(error=>{response.statusCode=500;response.end(String(error));});});
let browser;
try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 800,height: 600 } });
  page.setDefaultTimeout(120000);
  const errors = [], remote = [];
  await page.route('**/*', route => {
    const requested = new URL(route.request().url());
    if (!['http:', 'https:'].includes(requested.protocol) || requested.hostname === '127.0.0.1') return route.continue();
    remote.push(requested.href); return route.abort();
  });
  page.on('pageerror', error=>errors.push(error.message));
  page.on('console', message=> { if(message.type()==='error' || message.type()==='warning') console.log(message.text()); });
  const url = 'http://127.0.0.1:'+server.address().port+'/viewer/';
  const samples = [];
  let configRequests = 0;
  for (const [name,version,downloads,hit] of [['cold','release-1',1,false],['refresh','release-1',1,true],
    ['republish','release-2',2,false],['rollback','release-1',2,true]]) {
    revision = version;
    if (samples.length) await page.reload(); else await page.goto(url);
    await page.waitForFunction(()=>globalThis.result);
    const result = await page.evaluate(()=>globalThis.result);
    assert.equal(result.error,undefined,result.error);
    assert.equal(result.stamp,version);
    assert.equal(counts.get('/viewer/project/assets/model.glb'),downloads);
    assert.equal(counts.get('/viewer/project/scene.json'),downloads);
    if(texture) { assert.ok(hit ? result.decoder.completed === 0 : result.decoder.completed >= 1,'KTX2冷加载必须实际走worker，暖命中不重复转码'); }
    if(texture) assert.equal(counts.get('/viewer/project/assets/texture.ktx2'),downloads);
    assert.ok(hit ? result.metrics.decodeHits > 0 : result.metrics.decodes > 0,JSON.stringify(result));
    if(hit) { assert.equal(result.metrics.decodes,0); assert.equal(result.metrics.downloads,0); }
    if(hit) assert.equal(counts.get('/viewer/runtime-config.json')-configRequests,1,'缓存命中时仅检查一次发布版本');
    configRequests = counts.get('/viewer/runtime-config.json');
    if(samples.length) assert.equal(result.geometryHash,samples[0].geometryHash);
    await page.screenshot({ path: path.join(output,name+'.png') });
    samples.push({name,...result}); console.log(JSON.stringify({name,...result}));
  }
  assert.ok(counts.get('/viewer/runtime-config.json')>=4,'每次刷新必须确认最新版本');
  const storage = await page.evaluate(()=>globalThis.checkPublishedCacheStorage());
  assert.deepEqual(storage.retained,['one',undefined,'three']);
  assert.equal(storage.oversized,undefined);
  assert.deepEqual(errors,[]); assert.deepEqual(remote,[],'解码及资源不得访问CDN');
  for (const input of inputs) assert.equal(createHash('sha256').update(await readFile(input.path)).digest('hex'),input.sha256,'受测输入在期间发生变化：'+input.path);
  await writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,inputs,samples,requests:Object.fromEntries(counts),storage,errors,remote},null,2));
} finally { await browser?.close(); if(server.listening)await new Promise(resolve=>server.close(resolve)); }
