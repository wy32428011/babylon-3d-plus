import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';

// 使用真实 Host/Viewer 构建；仅业务接口与模型数据使用本地可重复的夹具。
assert.ok(process.argv[2], '请传入已经构建的数据中台 frontend 目录');
const frontendRoot = path.resolve(process.argv[2]);
const viewerRoot = path.resolve('dist-viewer-template');
const hostRoot = path.join(frontendRoot, 'dist');
const output = path.resolve('output/playwright/bound-screen-selection');
await mkdir(output, { recursive: true });
const moduleRoot = await mkdtemp(path.resolve('node_modules/.bound-screen-selection-'));
let server;
let browser;
try {
  await build({ configFile: false, publicDir: false, logLevel: 'error', build: {
    ssr: true, outDir: moduleRoot,
    rollupOptions: { input: { document: 'src/editor/model/SceneDocument.ts', serializer: 'src/editor/project/SceneSerializer.ts' }, output: { entryFileNames: '[name].mjs' } },
  } });
  const { AUTHORIZED_LOCAL_ASSET_URL_PREFIX, createEmptySceneDocument, createModelEntity, createClickEventBindingEntity } = await import(pathToFileURL(path.join(moduleRoot, 'document.mjs')).href);
  const { serializeScene, deserializeScene } = await import(pathToFileURL(path.join(moduleRoot, 'serializer.mjs')).href);
  const scene = createEmptySceneDocument('关闭大屏取消设备选择');
  const logicalUrl = AUTHORIZED_LOCAL_ASSET_URL_PREFIX + 'bound-screen-device.glb';
  const model = createModelEntity('Assets/Models/device.glb', logicalUrl, '测试设备');
  model.components.modelAsset.assetCode = '001005';
  const secondModel = createModelEntity('Assets/Models/device.glb', logicalUrl, '测试设备 B');
  secondModel.components.modelAsset.assetCode = '002006';
  secondModel.components.transform.position.x = 3;
  const binding = createClickEventBindingEntity();
  binding.components.clickEventBinding = {
    deviceSlots: [{ id: 'device-slot', deviceType: { id: 'device', assetId: 'Assets/Models/device.glb', displayName: model.name, sourcePath: 'Assets/Models/device.glb', sourceUrl: logicalUrl } }],
    events: [{ id: 'click', eventType: 'click', effects: ['highlight', 'show-chart'], chart: { id: 'data-platform-screen:1:3', projectId: '1', screenId: '3', name: '设备详情' } }],
  };
  scene.entityIds = [model.id, secondModel.id, binding.id];
  scene.entities = { [model.id]: model, [secondModel.id]: secondModel, [binding.id]: binding };
  const serializedScene = JSON.parse(serializeScene(scene));
  deserializeScene(JSON.stringify(serializedScene));

  // 自包含的立方体 GLB，不依赖网络下载或用户工程资产。
  const positions = new Float32Array([-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1]);
  const indices = new Uint16Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5]);
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const gltf = { asset:{version:'2.0'}, scene:0, scenes:[{nodes:[0]}], nodes:[{mesh:0}], meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}], materials:[{doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[0.1,0.7,0.7,1],metallicFactor:0,roughnessFactor:1}}], buffers:[{byteLength:bin.length}], bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.byteLength},{buffer:0,byteOffset:positions.byteLength,byteLength:indices.byteLength}], accessors:[{bufferView:0,componentType:5126,count:8,type:'VEC3',min:[-1,-1,-1],max:[1,1,1]},{bufferView:1,componentType:5123,count:indices.length,type:'SCALAR'}] };
  const json = Buffer.from(JSON.stringify(gltf).padEnd(Math.ceil(JSON.stringify(gltf).length/4)*4,' '));
  const glb = Buffer.alloc(12+8+json.length+8+bin.length);
  glb.writeUInt32LE(0x46546c67,0); glb.writeUInt32LE(2,4); glb.writeUInt32LE(glb.length,8);
  glb.writeUInt32LE(json.length,12); glb.writeUInt32LE(0x4e4f534a,16); json.copy(glb,20);
  glb.writeUInt32LE(bin.length,20+json.length); glb.writeUInt32LE(0x004e4942,24+json.length); bin.copy(glb,28+json.length);
  const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.json':'application/json', '.woff2':'font/woff2' };
  server = createServer(async (req,res) => {
    try {
      const pathname = new URL(req.url,'http://localhost').pathname;
      if (pathname === '/__viewer__/assets/device.glb') { res.writeHead(200,{'Content-Type':'model/gltf-binary'}).end(glb); return; }
      const viewer = pathname.startsWith('/__viewer__/');
      const root = viewer ? viewerRoot : hostRoot;
      const relative = viewer ? pathname.slice('/__viewer__/'.length) : pathname.slice(1);
      const file = path.resolve(root, relative || 'index.html');
      if (!file.startsWith(root+path.sep)) { res.writeHead(403).end(); return; }
      res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'}).end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel:'chrome',headless:true });
  for (const mode of ['preview','published']) for (const referenced of [false,true]) {
    const page = await browser.newPage({viewport:{width:1200,height:800}});
    page.setDefaultTimeout(30000);
    const errors=[];
    const logs=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{ if(message.type()==='error'||message.type()==='warning') logs.push(message.text()); });
    page.on('requestfailed',request=>logs.push(request.url()+': '+request.failure()?.errorText));
    await page.addInitScript(()=>{
      window.bridgeMessages=[];
      window.addEventListener('message',event=>window.bridgeMessages.push(event.data));
    });
    const text=(id,label,pageKey)=>({id,type:'TEXT',name:label,pageKey,x:850,y:130,w:320,h:150,zIndex:10,visible:true,style:{fontSize:26,color:'#ffffff',showTitle:false},data:{text:label}});
    const theme={version:1,projectId:'1',canvas:{width:1200,height:800},widgets:[text('detail','设备详情')]};
    const home={version:1,projectId:'1',canvas:{width:1200,height:800,backgroundColor:'#101827'},pages:[{key:'home',name:'首页'},...(referenced?[{key:'detail',name:'设备详情',sourceScreenId:'3'}]:[])],activePageKey:'home',widgets:[
      {id:'runtime',type:'BABYLON_RUNTIME',name:'数字孪生',x:0,y:0,w:800,h:800,zIndex:1,visible:true,style:{showTitle:false},data:{sourceType:'externalRuntime',digitalTwinBinding:{mode:'manualUrl',runtimeUrl:origin+'/__viewer__/index.html'}}},text('home','设备总览','home'),
    ]};
    const detail=id=>({id,projectId:'1',screenName:id==='1'?'总览':'设备详情',jsonContent:JSON.stringify(id==='1'?home:theme)});
    await page.route('**/api/**',route=>{
      const request=route.request(); const url=new URL(request.url());
      if(url.pathname==='/api/v1/screens/detail') return route.fulfill({json:{code:200,data:detail(String(request.postDataJSON().id))}});
      const match=url.pathname.match(/^\/api\/v1\/screens\/(\d+)\/published$/);
      if(match) return route.fulfill({json:{code:200,data:{id:'10',screenId:match[1],versionNumber:1,publishNumber:1,versionStatus:'PUBLISHED',snapshotJson:JSON.stringify({jsonContent:detail(match[1]).jsonContent,referencedScreenJsonContents:{'3':JSON.stringify(theme)}})}}});
      return route.fulfill({json:{code:200,data:[]}});
    });
    await page.route('**/__viewer__/runtime-config.json',route=>route.fulfill({json:{version:1,page:{title:'设备选择联动',loadingText:'加载中',backgroundColor:'#101827'},paths:{scene:'./scene.json',assetManifest:'./asset-manifest.json',assetBase:'./'},viewer:{showGrid:false,allowCameraControl:true,showStatusOverlay:false},mqtt:{...scene.mqttConfig,enabled:false,address:'',subscriptions:[]}}}));
    await page.route('**/__viewer__/scene.json',route=>route.fulfill({json:serializedScene}));
    await page.route('**/__viewer__/asset-manifest.json',route=>route.fulfill({json:{version:1,assets:[{logicalUrl,path:'assets/device.glb'}]}}));
    try {
      await page.goto(`${origin}/#/bigscreen-designer/${mode}/1`);
      const iframe=page.locator('iframe[src*="/__viewer__/index.html"]');
      await iframe.waitFor({state:'attached'});
      const viewer=await (await iframe.elementHandle()).contentFrame();
      await page.waitForFunction(()=>window.bridgeMessages.some(message=>message.type==='viewer.ready'));
      assert.ok(await page.evaluate(()=>window.bridgeMessages.find(message=>message.type==='viewer.ready').payload.capabilities.includes('clearSelection')));
      // 只读获取真实 React 持有的 Runtime，不向生产代码增加调试接口或替换清理实现。
      await viewer.evaluate(()=>{
        const canvas=document.querySelector('canvas');
        let fiber=canvas[Object.keys(canvas).find(key=>key.startsWith('__reactFiber$'))];
        while(fiber){
          let hook=fiber.memoizedState;
          while(hook){
            const value=hook.memoizedState?.current;
            if(value?.setLocalHighlightEntityIds) window.selectionSmokeRuntime=value;
            if(value?.getCameraPose) window.selectionSmokeViewport=value;
            hook=hook.next;
          }
          fiber=fiber.return;
        }
        window.selectionSmokeInstance=crypto.randomUUID();
      });
      const instance=await viewer.evaluate(()=>window.selectionSmokeInstance);
      await viewer.waitForFunction(id=>window.selectionSmokeRuntime?.getEntitiesFocusBounds([id])?.geometryReady,model.id);
      const getPoint=async entityId=>viewer.evaluate(id=>{
        const runtime=window.selectionSmokeRuntime; const scene=runtime.scene; const camera=scene.activeCamera;
        const bounds=runtime.getEntitiesFocusBounds([id]);
        const V=camera.position.constructor; const M=scene.getTransformMatrix().constructor;
        const engine=scene.getEngine();
        const p=V.Project(new V(bounds.center.x,bounds.center.y,bounds.center.z),M.Identity(),scene.getTransformMatrix(),camera.viewport.toGlobal(engine.getRenderWidth(),engine.getRenderHeight()));
        const rect=engine.getRenderingCanvas().getBoundingClientRect();
        return {x:p.x/engine.getRenderWidth()*rect.width,y:p.y/engine.getRenderHeight()*rect.height};
      },entityId);
      const pose=await viewer.evaluate(()=>window.selectionSmokeViewport.getCameraPose());
      let firstOpening;
      for(let attempt=0;attempt<3;attempt++) {
        const target=attempt===1?secondModel:model;
        const point=await getPoint(target.id);
        await viewer.locator('canvas').first().click({position:point});
        await page.getByRole('button',{name:'关闭并返回首页'}).waitFor();
        await viewer.waitForFunction(id=>window.selectionSmokeRuntime.localHighlightedEntityIds.has(id),target.id);
        const opening=await page.evaluate(()=>window.bridgeMessages.findLast(m=>m.type==='viewer.showScreen'));
        if(attempt===0) {
          firstOpening=opening;
          // 大屏仍打开时透过空白区域选择 B，再回放 A 的迟到关闭。
          await viewer.locator('canvas').first().click({position:await getPoint(secondModel.id)});
          await viewer.waitForFunction(id=>window.selectionSmokeRuntime.localHighlightedEntityIds.has(id),secondModel.id);
          await page.waitForFunction(token=>window.bridgeMessages.filter(m=>m.type==='viewer.showScreen').at(-1)?.payload.selectionToken!==token,firstOpening.payload.selectionToken);
          await iframe.evaluate((element,previous)=>element.contentWindow.postMessage({
            channel:previous.channel,version:previous.version,sessionId:previous.sessionId,
            type:'command.clearSelection',requestId:'late-close-a',payload:{selectionToken:previous.payload.selectionToken},
          },location.origin),firstOpening);
          await page.waitForFunction(()=>window.bridgeMessages.some(m=>m.requestId==='late-close-a'&&m.ok&&m.payload?.cleared===false));
          assert.deepEqual(await viewer.evaluate(()=>[...window.selectionSmokeRuntime.localHighlightedEntityIds]),[secondModel.id]);
        }
        assert.equal(await viewer.evaluate(()=>window.selectionSmokeRuntime.modelSelectionOutlineLayer.shouldRender()),true);
        if(attempt===0) await page.screenshot({path:path.join(output,`${mode}-${referenced?'page':'overlay'}-selected.png`)});
        await page.getByRole('button',{name:'关闭并返回首页'}).click();
        await page.getByText('设备总览',{exact:true}).waitFor();
        await viewer.waitForFunction(()=>window.selectionSmokeRuntime.localHighlightedEntityIds.size===0);
        assert.equal(await viewer.evaluate(()=>window.selectionSmokeRuntime.externalHighlightedEntityIds.size),0);
        assert.equal(await viewer.evaluate(()=>window.selectionSmokeRuntime.localSlotHighlight),null);
        assert.equal(await viewer.evaluate(()=>window.selectionSmokeRuntime.modelSelectionOutlineLayer.shouldRender()),false);
        assert.equal(await viewer.evaluate(()=>window.selectionSmokeInstance),instance);
        assert.deepEqual(await viewer.evaluate(()=>window.selectionSmokeViewport.getCameraPose()),pose);
        await page.waitForFunction(count=>window.bridgeMessages.filter(m=>m.type==='command.result'&&m.payload?.action==='clearSelection'&&m.payload.cleared).length>=count,attempt+1);
      }
      // 搜索定位走正式聚焦命令，确认外部高亮与点击产生的本地选择一并清除。
      await iframe.evaluate((element,previous)=>element.contentWindow.postMessage({
        channel:previous.channel,version:previous.version,sessionId:previous.sessionId,
        type:'command.focusAsset',requestId:'search-device-b',payload:{assetCode:'002006'},
      },location.origin),firstOpening);
      await page.getByRole('button',{name:'关闭并返回首页'}).waitFor();
      await viewer.waitForFunction(id=>window.selectionSmokeRuntime.localHighlightedEntityIds.has(id)&&window.selectionSmokeRuntime.externalHighlightedEntityIds.has(id),secondModel.id);
      const focusedPose=await viewer.evaluate(()=>window.selectionSmokeViewport.getCameraPose());
      await page.getByRole('button',{name:'关闭并返回首页'}).click();
      await viewer.waitForFunction(()=>window.selectionSmokeRuntime.localHighlightedEntityIds.size===0&&window.selectionSmokeRuntime.externalHighlightedEntityIds.size===0);
      assert.deepEqual(await viewer.evaluate(()=>window.selectionSmokeViewport.getCameraPose()),focusedPose);
      assert.equal(await viewer.evaluate(()=>window.selectionSmokeInstance),instance);
      await page.screenshot({path:path.join(output,`${mode}-${referenced?'page':'overlay'}-cleared.png`)});
      assert.deepEqual(errors,[]);
      console.log(`PASS ${mode}/${referenced?'引用页':'弹出层'}: 真实 Viewer 设备点击及搜索定位、取消选择、光晕消失、旧关闭不清新设备、相机保持、重复打开、Runtime 保留`);
    } catch(error) {
      await page.screenshot({path:path.join(output,`${mode}-failure.png`)});
      console.error('浏览器错误',errors);
      console.error('浏览器日志',logs.slice(-20));
      console.error('桥接消息',await page.evaluate(()=>window.bridgeMessages));
      for(const frame of page.frames().slice(1)) console.error('Viewer',frame.url(),(await frame.locator('body').innerText()).slice(0,1500));
      console.error((await page.locator('body').innerText()).slice(0,1500));
      throw error;
    } finally { await page.close(); }
  }
} finally {
  await browser?.close();
  if(server) await new Promise(resolve=>server.close(resolve));
  // moduleRoot 由本任务在 node_modules 下唯一创建。
  assert.ok(moduleRoot.startsWith(path.resolve('node_modules')+path.sep));
  await rm(moduleRoot,{recursive:true,force:true});
}
