/* global window */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer as createPortProbe } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output/animation-frame-cost-20261023');
await mkdir(output, { recursive: true });
try { await copyFile(path.join(output,'results.json'),path.join(output,'previous-attempt-results.json')); }
catch(error) { if(error.code!=='ENOENT')throw error; }
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const changed = new Set(git('diff', '--name-only', 'HEAD').trim().split(/\r?\n/));
for (const filename of git('ls-files', '--others', '--exclude-standard', 'src', 'electron').trim().split(/\r?\n/)) changed.add(filename);
const fallbacks = new Set();
const baselineCommit = '81a78c16504fe4b2dd198428ab076327efb745dc';
const currentCommit = git('rev-parse', 'HEAD').trim();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const originalGeometry = git('show', baselineCommit + ':src/runtime/babylon/lightingRuntimeCapture.ts');
const originalMotion = git('show', baselineCommit + ':src/runtime/babylon/runtimeNodeGeometry.ts');
const sourcePaths = ['src/runtime/babylon/runtimeNodeGeometry.ts', 'src/runtime/babylon/lightingRuntimeCapture.ts',
  'src/runtime/babylon/lightingGeometrySignatureCache.ts'];
const currentSourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async filename => [filename, sha256(await readFile(path.join(root, filename)))])));
const baselineSourceHashes = {'src/runtime/babylon/runtimeNodeGeometry.ts':sha256(originalMotion),
  'src/runtime/babylon/lightingRuntimeCapture.ts':sha256(originalGeometry)};
const geometryStart = originalGeometry.indexOf('export function getLightingGeometrySignature(');
const geometryEnd = originalGeometry.indexOf('\nfunction isDynamicLight(', geometryStart);
const motionStart = originalMotion.indexOf('export function filterTopLevelMotionNodes(');
const motionEnd = originalMotion.indexOf('\n/**', motionStart);
assert.ok(geometryStart >= 0 && geometryEnd > geometryStart && motionStart >= 0 && motionEnd > motionStart);
// 参考函数直接来自修改前提交；不以重写后的实现推导期望结果。
const reference = `
import { VertexBuffer, Mesh } from '@babylonjs/core';
import { lightingContentHash } from '/electron/shared/sceneLightingBakeContract.ts';
import { sourceGeometryMesh, lightingSourceVisible } from '/src/runtime/babylon/lightingRuntimeCapture.ts';
import type { TransformNode } from '@babylonjs/core';
import type { LightingRuntimeSource } from '/src/runtime/babylon/lightingClassificationRuntime.ts';
const uniqueTransformNodes = (nodes: TransformNode[]) => [...new Set(nodes)];
${originalGeometry.slice(geometryStart, geometryEnd).replace('getLightingGeometrySignature(', 'referenceSignature(')}
${originalMotion.slice(motionStart, motionEnd).replace('filterTopLevelMotionNodes(', 'referenceFilter(')}
`;

const harness = `
import { Color3, DirectionalLight, DynamicTexture, Engine, FreeCamera, HemisphericLight, Matrix,
  MeshBuilder, PBRMaterial, Scene, SceneInstrumentation, ShadowGenerator, TransformNode, Vector3, VertexBuffer } from '@babylonjs/core';
import { filterTopLevelMotionNodes } from '/src/runtime/babylon/runtimeNodeGeometry.ts';
import { getLightingGeometrySignature } from '/src/runtime/babylon/lightingRuntimeCapture.ts';
import { referenceFilter, referenceSignature } from '/__animation_reference__.ts';
const canvas = document.querySelector('canvas');
const engine = new Engine(canvas, true, {preserveDrawingBuffer:true, stencil:true}, true);
engine.setHardwareScalingLevel(1);
const scene = new Scene(engine);
// 原生计数器由 SceneInstrumentation 负责逐帧归零，避免将累计调用数当作单帧数据。
const instrumentation = new SceneInstrumentation(scene);
scene.clearColor.set(0.12,0.16,0.22,1);
const camera = new FreeCamera('camera',new Vector3(10,8,-12),scene);
camera.setTarget(new Vector3(0,1,0)); camera.minZ=0.1; camera.maxZ=80;
const sun = new DirectionalLight('sun', new Vector3(-0.5,-1,0.4),scene);
sun.position.set(8,14,-8); sun.intensity=2.2;
const ambient = new HemisphericLight('ambient',Vector3.Up(),scene); ambient.intensity=0.35;
const shadows = new ShadowGenerator(1024,sun);
shadows.usePercentageCloserFiltering=true; shadows.filteringQuality=ShadowGenerator.QUALITY_HIGH;
shadows.bias=0.0005; shadows.normalBias=0.02;
const material = new PBRMaterial('device-pbr',scene);
material.albedoColor = new Color3(0.24,0.62,0.87); material.metallic=0.2; material.roughness=0.35;
const groundMaterial = new PBRMaterial('ground-pbr',scene);
groundMaterial.albedoColor = new Color3(0.75,0.75,0.75); groundMaterial.metallic=0; groundMaterial.roughness=0.85;
const texture = new DynamicTexture('checker', {width:64,height:64},scene,false);
const ctx=texture.getContext();
for(let y=0;y<8;y++)for(let x=0;x<8;x++) {ctx.fillStyle=(x+y)%2?'#b0bac7':'#596778';ctx.fillRect(x*8,y*8,8,8);}
texture.update(); groundMaterial.albedoTexture=texture;
const floor=MeshBuilder.CreateGround('floor',{width:16,height:12,updatable:true},scene);
floor.material=groundMaterial; floor.receiveShadows=true;
const root = new TransformNode('device-root',scene);
const body=MeshBuilder.CreateBox('body',{width:2,height:1,depth:1.5},scene);
body.parent=root;body.position.y=0.7;body.material=material;body.receiveShadows=true;
const forkRoot=new TransformNode('fork-root',scene);forkRoot.parent=root;forkRoot.position.y=1.5;
const fork=MeshBuilder.CreateBox('fork',{width:1.6,height:0.25,depth:2},scene);
fork.parent=forkRoot;fork.position.z=0.6;fork.material=material;fork.receiveShadows=true;
const independent=MeshBuilder.CreateBox('independent-motion',{size:1.2},scene);
independent.position.set(3,0.7,1);independent.material=material;independent.receiveShadows=true;
const carrier=MeshBuilder.CreateBox('thin-array',{width:0.8,height:2,depth:0.8},scene);
carrier.material=material;carrier.receiveShadows=true;
const matrices=[-3,0,3].map(x=>Matrix.Translation(x,1,3));
const buffer=new Float32Array(matrices.length*16);
matrices.forEach((matrix,index)=>matrix.copyToArray(buffer,index*16));
carrier.thinInstanceSetBuffer('matrix',buffer,16,false);
for(const mesh of [body,fork,independent,carrier])shadows.addShadowCaster(mesh);
const source=(mesh,key,mobility='static',getWorldMatrix=()=>mesh.computeWorldMatrix(true))=>({mesh,
  entry:{key,name:key,mobility,bakeIndirect:true,castShadows:true,receiveShadows:true},getWorldMatrix});
const sources=[source(floor,'floor'),source(body,'moving-body','dynamic')];
matrices.forEach((matrix,index)=>sources.push({...source(carrier,'array-'+index,'static',()=>matrix.multiply(carrier.computeWorldMatrix(true))),
  instance:{mesh:carrier,sourceIndex:index,batch:{isLightingInstanceVisible:()=>carrier.isEnabled()&&carrier.isVisible}}}));
const check=(condition,message)=>{if(!condition)throw new Error(message);};
const equal=(a,b,message)=>check(JSON.stringify(a)===JSON.stringify(b),message);
const filterCases=[];
const candidates=[fork,root,forkRoot,independent,root,body,independent];
const checkFilter=(label,nodes)=>{const a=referenceFilter(nodes),b=filterTopLevelMotionNodes(nodes);
  check(a.length===b.length&&a.every((node,index)=>node===b[index]),label+' 引用或顺序变化');
  filterCases.push({label,input:nodes.length,outputCount:b.length,first:b.slice(0,8).map(node=>node.name),last:b.slice(-8).map(node=>node.name)});};
checkFilter('hierarchy-duplicates',candidates);checkFilter('reordered',candidates.slice().reverse());checkFilter('empty',[]);
const siblings=Array.from({length:3100},(_,index)=>{const node=new TransformNode('sibling-'+index,scene);node.parent=forkRoot;return node;});
checkFilter('3100-siblings',[...siblings,...siblings.slice(0,30)]);siblings.forEach(node=>node.dispose());
const originalCheck=independent.isDescendantOf;
independent.isDescendantOf=candidate=>candidate===root;
checkFilter('script-method-override',[independent,root]);independent.isDescendantOf=originalCheck;
const signatures=[];
const checkSignature=label=>{const current=getLightingGeometrySignature(sources),reference=referenceSignature(sources);
  check(current===reference,label+' geometry-v1 不一致');signatures.push({label,current,reference});return current;};
const state=()=>({geometry:scene.meshes.map(mesh=>({name:mesh.name,positions:Array.from(mesh.getVerticesData('position')??[]),
  indices:Array.from(mesh.getIndices()??[]),uv:Array.from(mesh.getVerticesData('uv')??[]),thinCount:mesh.thinInstanceCount})),
  materials:[material,groundMaterial].map(mat=>({name:mat.name,albedo:mat.albedoColor.asArray(),metallic:mat.metallic,
    roughness:mat.roughness,alpha:mat.alpha,texture:mat.albedoTexture?.uniqueId??null})),
  shadow:{size:shadows.getShadowMap().getSize(),pcf:shadows.usePercentageCloserFiltering,quality:shadows.filteringQuality,
    bias:shadows.bias,normalBias:shadows.normalBias,casters:shadows.getShadowMap().renderList.map(mesh=>mesh.name)},
  lighting:{sun:sun.direction.asArray(),intensity:sun.intensity,ambient:ambient.intensity},
  render:{width:engine.getRenderWidth(),height:engine.getRenderHeight(),hardwareScaling:engine.getHardwareScalingLevel()}});
const render=async()=>{for(let i=0;i<4;i++){engine.beginFrame();scene.render();engine.endFrame();await new Promise(requestAnimationFrame);}
  return {pixels:Array.from(await engine.readPixels(0,0,640,480)),png:canvas.toDataURL('image/png'),draws:instrumentation.drawCallsCounter.current};};
const pose=(filter,t)=>{root.position.set(0,0,0);independent.position.set(3,0.7,1);forkRoot.position.y=1.5;
  for(const node of filter(candidates))node.position.x+=Math.sin(t)*1.8;
  forkRoot.position.y+=0.25*Math.cos(t);scene.meshes.forEach(mesh=>mesh.computeWorldMatrix(true));};
const comparisons=[],images={};let firstPosePixels;
window.runAnimationFrameCostSmoke=async()=>{
  const info=engine.getGlInfo();check(info.renderer&&!/swiftshader|llvmpipe|software|basic render|unknown/i.test(info.renderer),'需要真实硬件 WebGL renderer: '+info.renderer);
  window.animationFrameCostEvidence={renderer:info.renderer,vendor:info.vendor,webGLVersion:engine.webGLVersion,filterCases,signatures,comparisons};
  await render();await scene.whenReadyAsync();await shadows.forceCompilationAsync();await render();
  const initialSignature=checkSignature('stable');checkSignature('stable-repeat');
  pose(filterTopLevelMotionNodes,0.9);check(checkSignature('dynamic-motion')===initialSignature,'动态运动错误改变静态签名');
  floor.position.x=0.2;check(checkSignature('static-world')!==initialSignature,'静态变换未被检测');floor.position.x=0;
  const uv=floor.getVerticesData(VertexBuffer.UVKind),oldUV=uv[0];uv[0]+=0.2;
  check(checkSignature('static-uv-in-place')!==initialSignature,'静态原位 UV 修改未被检测');
  floor.updateVerticesData(VertexBuffer.UVKind,uv);checkSignature('static-uv-uploaded');uv[0]=oldUV;floor.updateVerticesData(VertexBuffer.UVKind,uv);
  check(checkSignature('static-uv-restored')===initialSignature,'还原 UV 后签名未恢复');
  matrices[1].setTranslation(new Vector3(0.3,1,3));matrices[1].copyToArray(buffer,16);carrier.thinInstanceBufferUpdated('matrix');
  check(checkSignature('thin-instance-world')!==initialSignature,'薄实例矩阵修改未被检测');
  matrices[1].setTranslation(new Vector3(0,1,3));matrices[1].copyToArray(buffer,16);carrier.thinInstanceBufferUpdated('matrix');
  floor.isVisible=false;checkSignature('static-hidden');floor.isVisible=true;
  for(const t of [0,0.4,0.9,1.5,2.2,3]){
    pose(referenceFilter,t);const before=state();const reference=checkSignature('pose-reference-'+t);const a=await render();
    pose(filterTopLevelMotionNodes,t);const current=getLightingGeometrySignature(sources);equal(state(),before,'调用后几何/材质/光照/阴影参数变化');
    check(current===reference,'运动姿态签名不一致');const b=await render();
    let maxDifference=0,differentPixels=0,coloredPixels=0;
    for(let i=0;i<a.pixels.length;i+=4){const d=Math.max(...[0,1,2,3].map(c=>Math.abs(a.pixels[i+c]-b.pixels[i+c])));
      maxDifference=Math.max(maxDifference,d);if(d)differentPixels++;if(a.pixels[i]>70||a.pixels[i+1]>70)coloredPixels++;}
    check(coloredPixels>30000,'画面缺少实际可见几何');check(differentPixels===0,'固定姿态像素不一致');check(a.draws===b.draws&&b.draws>0,'绘制调用变化: '+a.draws+' / '+b.draws);
    firstPosePixels??=a.pixels;
    let motionPixels=0;for(let i=0;i<a.pixels.length;i+=4)if(Math.abs(firstPosePixels[i]-a.pixels[i])>8)motionPixels++;
    if(t===1.5)check(motionPixels>100,'确定性运动姿态未产生可见画面变化');
    comparisons.push({t,maxDifference,differentPixels,coloredPixels,motionPixels,referenceDraws:a.draws,currentDraws:b.draws});
    if(t===0||t===1.5){images['reference-'+t]=a.png;images['optimized-'+t]=b.png;}
  }
  // 使用原生 darkness uniform 对照实际阴影；不切换 PCF sampler 或重建 shader 定义。
  const shadowOn=await render(),darkness=shadows.getDarkness();
  shadows.setDarkness(1);const shadowOff=await render();shadows.setDarkness(darkness);
  let shadowPixels=0;for(let i=0;i<shadowOn.pixels.length;i+=4)if(shadowOff.pixels[i]-shadowOn.pixels[i]>8)shadowPixels++;
  check(shadowPixels>100,'实际画面未产生可辨认阴影');await render();
  const glErrors=[];for(let code=engine._gl.getError();code!==engine._gl.NO_ERROR;code=engine._gl.getError())glErrors.push(code);
  check(!glErrors.length,'WebGL 错误: '+glErrors.join(','));
  return {renderer:info.renderer,vendor:info.vendor,webGLVersion:engine.webGLVersion,filterCases,signatures,comparisons,
    shadowPixels,glErrors,parameters:state(),images};
};
window.animationFrameCostReady=true;
`;

await writeFile(path.join(output, 'reference.ts'), reference, 'utf8');
await writeFile(path.join(output, 'harness.ts'), harness, 'utf8');
// 动态端口由操作系统分配；只关闭本脚本创建的 Vite 和浏览器。
const listening = process.platform === 'win32'
  ? execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress'], { encoding: 'utf8' }).trim()
  : '操作系统动态分配端口，不复用未知服务';
await writeFile(path.join(output, 'ports-before.json'), listening, 'utf8');
const sourcePlugin = {name:'animation-frame-cost-source',enforce:'pre',
    resolveId(id){
      if(id==='/__animation_reference__.ts')return path.join(output,'reference.ts');
      if(id.startsWith('/src/')||id.startsWith('/electron/'))return path.join(root,id.slice(1));
    },
    async load(id){
      const relative=path.relative(root,id).replaceAll('\\','/');
      if(!/^(src|electron)\/.+\.(ts|tsx)$/.test(relative)||id.includes('?'))return;
      const contents=await readFile(id,'utf8');
      if(currentSourceHashes[relative])assert.equal(sha256(contents),currentSourceHashes[relative],'运行中源文件变化：'+relative);
      if(!contents.includes('\0')&&!contents.includes('\ufffd'))return;
      assert.ok(!changed.has(relative),'已修改源文件不可读取，拒绝使用提交版代替：'+relative);
      fallbacks.add(relative);return git('show',currentCommit+':'+relative);
    },
};
// 先转译真实 TS 文件并合并依赖，避免虚拟模块绕过 TS 转译及逐模块浏览器请求。
const bundle = await build({root,configFile:false,logLevel:'warn',plugins:[sourcePlugin],
  build:{write:false,minify:false,rollupOptions:{input:path.join(output,'harness.ts'),output:{codeSplitting:false}}}});
const entry=bundle.output.find(item=>item.type==='chunk'&&item.isEntry);assert.ok(entry);
await writeFile(path.join(output,'harness-bundle.js'),entry.code,'utf8');
const probe=createPortProbe();
await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const allocatedPort=probe.address().port;
await new Promise(resolve=>probe.close(resolve));
const server = await createServer({ root, configFile:false, logLevel:'warn',
  cacheDir:path.join(output,'vite-cache'), optimizeDeps:{noDiscovery:true,include:[]},
  server:{host:'127.0.0.1',port:allocatedPort,strictPort:true,hmr:false,watch:null},
  plugins:[{name:'animation-frame-cost-page',
    configureServer(instance){instance.middlewares.use((request,response,next)=>{
      if(request.url==='/favicon.ico'){response.writeHead(204).end();return;}
      if(request.url==='/__animation_harness__.js'){
        response.setHeader('Content-Type','text/javascript');response.end(entry.code);return;
      }
      if(request.url!=='/')return next();
      response.setHeader('Content-Type','text/html');response.end('<!doctype html><style>body{margin:0;background:#1e293b}canvas{display:block}</style><canvas width="640" height="480"></canvas><script type="module" src="/__animation_harness__.js"></script>');
    });},
  }],
});
const errors=[],warnings=[],networkFailures=[];
let browser,page,result;
const onInterrupt=()=>{errors.push('Cancelled by SIGINT');void browser?.close();void server.close();};
process.once('SIGINT',onInterrupt);
try{
  await server.listen();const address=server.httpServer.address();assert.ok(address&&typeof address!=='string');
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=d3d11']});
  page=await browser.newPage({viewport:{width:640,height:480},deviceScaleFactor:1});
  page.on('pageerror',error=>{const message=error.stack||error.message||String(error);errors.push(message);console.error('browser pageerror:',message);});
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());if(message.type()==='warning')warnings.push(message.text());});
  page.on('response',response=>{if(response.status()>=400)networkFailures.push({url:response.url(),status:response.status()});});
  page.on('requestfailed',request=>networkFailures.push({url:request.url(),failure:request.failure()}));
  console.log('Loading isolated WebGL harness on port '+address.port);
  await page.goto('http://127.0.0.1:'+address.port,{waitUntil:'networkidle',timeout:120000});
  await page.waitForFunction(()=>window.animationFrameCostReady,undefined,{timeout:120000});
  console.log('Harness loaded; checking hardware renderer and rendering deterministic poses.');
  result=await page.evaluate(()=>window.runAnimationFrameCostSmoke());
  for(const [name,data]of Object.entries(result.images))await writeFile(path.join(output,name+'.png'),Buffer.from(data.split(',')[1],'base64'));
  delete result.images;
  await page.screenshot({path:path.join(output,'final.png')});
  for(const filename of sourcePaths)assert.equal(sha256(await readFile(path.join(root,filename))),currentSourceHashes[filename],
    '运行结束时源文件已变化，需对最终版本重跑：'+filename);
  assert.deepEqual(errors,[],'浏览器运行错误');
  console.log(JSON.stringify({status:'passed',renderer:result.renderer,comparisons:result.comparisons,shadowPixels:result.shadowPixels,output},null,2));
}catch(error){
  if(page&&!page.isClosed())result??=await page.evaluate(()=>window.animationFrameCostEvidence).catch(()=>undefined);
  if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'failed.png')}).catch(()=>undefined);
  errors.push(error.stack??String(error));throw error;
}
finally{
  process.removeListener('SIGINT',onInterrupt);
  await browser?.close();await server.close();
  await writeFile(path.join(output,'results.json'),JSON.stringify({status:errors.length?'failed':'passed',baselineCommit,currentCommit,
    baselineSourceHashes,currentSourceHashes,
    result,errors,warnings,networkFailures,readOnlyCommittedSourceFallbacks:[...fallbacks],
    limits:['隔离 Babylon 实际硬件 WebGL 场景，不是附件对应真实展会场景','未测量 FPS 或确认现场约 450 ms 长任务消失',
      '验证运动过滤、静态签名、几何材质光照阴影参数及六个运动姿态像素等价，不代替完整 Editor/Viewer 生命周期验证']},null,2),'utf8');
}
