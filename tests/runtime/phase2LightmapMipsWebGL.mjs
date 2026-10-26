/** 专属GPU窗口才执行：真实adapter每级FBO/textureLod/有限sampler/context restore。 */
/* global window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import { _electron } from 'playwright';
import electron from 'electron';

const { values } = parseArgs({ options: { output: { type: 'string' } } });
assert.ok(values.output, '--output 必须指向全新的 output 子目录。');
const output = path.resolve(values.output), outputRoot = path.resolve('output');
const relative = path.relative(outputRoot, output);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
await fs.mkdir(output, { recursive: false });
const bootstrap = path.join(output, 'owned-bootstrap.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = ['electron/shared/sceneLightingLightmapMips.ts', 'src/runtime/babylon/lightingLightmapMipTexture.ts'];
const sourceSha256 = Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await fs.readFile(file))])));
const report = { status: 'RUNNING', scope: 'actual standalone Babylon WebGL2 adapter; no Editor/Viewer integration or performance claim',
  sourceSha256, resourcesClosed: false, cases: [] };

const renderer = String.raw`
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { encodeLightingLightmapMips, decodeLightingLightmapMips } from './electron/shared/sceneLightingLightmapMips.ts';
import { createLightingLightmapMipTexture } from './src/runtime/babylon/lightingLightmapMipTexture.ts';

window.__phase2Run = async () => {
  const canvas=document.getElementById('gpu');
  const engine=new Engine(canvas,false,{preserveDrawingBuffer:true,stencil:false,disableWebGL2Support:false});
  const scene=new Scene(engine), gl=engine._gl, records=[];
  const check=(value,message)=>{if(!value)throw new Error(message);};
  let texture;
  try {
    check(engine.webGLVersion===2,'Actual WebGL2 required');
    const debug=gl.getExtension('WEBGL_debug_renderer_info');
    const hardware={vendor:gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL??gl.VENDOR),renderer:gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL??gl.RENDERER),
      version:gl.getParameter(gl.VERSION),fragmentHighp:gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT).precision};
    check(!/swiftshader|llvmpipe|software/i.test(hardware.renderer),'Software renderer cannot prove hardware adapter behavior');
    const levels=[64,32,16,8,4].map((size,lod)=>{
      const rgba=new Uint8Array(size*size*4);
      for(let y=0;y<size;y++)for(let x=0;x<size;x++)rgba.set([20+lod*40+x%40,10+lod*20+y%40,200-lod*35,50+lod*35],(y*size+x)*4);
      return {width:size,height:size,rgba};
    });
    const maxLod=levels.length-1;
    const total=levels.reduce((sum,level)=>sum+level.rgba.length,0);
    const bytes=encodeLightingLightmapMips({baseEncoding:'rgbm',rgbmRange:4,levels,maxTextureBytes:total});
    const decoded=decodeLightingLightmapMips(bytes,{maxTextureBytes:total});
    let generated=0;
    const originalGenerate=gl.generateMipmap.bind(gl);
    gl.generateMipmap=(...args)=>{generated++;return originalGenerate(...args);};
    const sceneTextureCount=scene.textures.length;
    const aborted=new AbortController(); aborted.abort(new Error('gpu pre-cancel fixture'));
    let canceled=false;
    try{createLightingLightmapMipTexture(scene,decoded,{maxTextureBytes:total,signal:aborted.signal});}catch(error){canceled=/pre-cancel/.test(error.message);}
    check(canceled&&scene.textures.length===sceneTextureCount,'Pre-cancel leaked texture');
    const shorterChains=[];
    for(const levelCount of [2,3,4]){
      const shortLevels=levels.slice(0,levelCount),shortTotal=shortLevels.reduce((sum,level)=>sum+level.rgba.length,0);
      const shortDecoded=decodeLightingLightmapMips(encodeLightingLightmapMips({baseEncoding:'rgbm',rgbmRange:4,levels:shortLevels,maxTextureBytes:shortTotal}),{maxTextureBytes:shortTotal});
      const shortTexture=createLightingLightmapMipTexture(scene,shortDecoded,{maxTextureBytes:shortTotal});
      const gpu=shortTexture.getInternalTexture()._hardwareTexture.underlyingResource;
      engine.wipeCaches(true);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,gpu);
      const actualMax=gl.getTexParameter(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL),actualMaxLod=gl.getTexParameter(gl.TEXTURE_2D,gl.TEXTURE_MAX_LOD);
      check(actualMax===levelCount-1&&actualMaxLod===levelCount-1,'Short finite chain not bounded');
      gl.bindTexture(gl.TEXTURE_2D,null);engine.wipeCaches(true);shortTexture.dispose();check(!gl.isTexture(gpu),'Short chain disposal leaked');
      shorterChains.push({levelCount,actualMax,actualMaxLod,disposed:true});
    }
    texture=createLightingLightmapMipTexture(scene,decoded,{maxTextureBytes:total,onRestoreError:error=>records.push({restoreError:error.message})});
    const internal=texture.getInternalTexture();
    const resource=()=>internal._hardwareTexture.underlyingResource;
    const anisotropic=engine.getCaps().textureAnisotropicFilterExtension;
    const states=()=>{
      engine.wipeCaches(true);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,resource());
      const read=key=>gl.getTexParameter(gl.TEXTURE_2D,key);
      const actual={base:read(gl.TEXTURE_BASE_LEVEL),max:read(gl.TEXTURE_MAX_LEVEL),minLod:read(gl.TEXTURE_MIN_LOD),maxLod:read(gl.TEXTURE_MAX_LOD),
        min:read(gl.TEXTURE_MIN_FILTER),mag:read(gl.TEXTURE_MAG_FILTER),wrapS:read(gl.TEXTURE_WRAP_S),wrapT:read(gl.TEXTURE_WRAP_T),
        anisotropy:anisotropic?read(anisotropic.TEXTURE_MAX_ANISOTROPY_EXT):null,ready:texture.isReady(),cpuLevelCount:decoded.levels.length};
      check(actual.base===0&&actual.max===maxLod&&actual.minLod===0&&actual.maxLod===maxLod,'Unbounded mip sampler');
      check(actual.min===gl.LINEAR_MIPMAP_LINEAR&&actual.mag===gl.LINEAR,'Wrong trilinear filter');
      check(actual.wrapS===gl.CLAMP_TO_EDGE&&actual.wrapT===gl.CLAMP_TO_EDGE,'Unbounded UV sampler');
      check(actual.anisotropy===null||actual.anisotropy===1,'Anisotropic footprint not certified');
      check(actual.ready,'Texture not ready after complete upload');
      gl.bindTexture(gl.TEXTURE_2D,null);engine.wipeCaches(true);return actual;
    };
    const readLevels=()=>{
      engine.wipeCaches(true);const fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);const result=[];
      try{
        for(let lod=0;lod<levels.length;lod++){
          const level=levels[lod];gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,resource(),lod);
          check(gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE,'Mip FBO incomplete at '+lod);
          const actual=new Uint8Array(level.rgba.length);gl.readPixels(0,0,level.width,level.height,gl.RGBA,gl.UNSIGNED_BYTE,actual);
          check(actual.every((value,index)=>value===level.rgba[index]),'Full mip RGBA differs at '+lod);
          result.push({lod,width:level.width,height:level.height,rgba:[...actual]});
        }
      }finally{gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(fbo);engine.wipeCaches(true);}
      return result;
    };
    const bilinear=(level,uv)=>{
      const x=uv[0]*level.width-.5,y=uv[1]*level.height-.5,x0=Math.floor(x),y0=Math.floor(y),tx=x-x0,ty=y-y0;
      const texel=(a,b,c)=>level.rgba[(Math.max(0,Math.min(level.height-1,b))*level.width+Math.max(0,Math.min(level.width-1,a)))*4+c];
      return [0,1,2,3].map(c=>(texel(x0,y0,c)*(1-tx)+texel(x0+1,y0,c)*tx)*(1-ty)+(texel(x0,y0+1,c)*(1-tx)+texel(x0+1,y0+1,c)*tx)*ty);
    };
    const sampleLods=()=>{
      engine.wipeCaches(true);
      const shader=(kind,source)=>{const shader=gl.createShader(kind);gl.shaderSource(shader,source);gl.compileShader(shader);check(gl.getShaderParameter(shader,gl.COMPILE_STATUS),gl.getShaderInfoLog(shader));return shader;};
      const vertex=shader(gl.VERTEX_SHADER,'#version 300 es\nprecision highp float;out highp vec2 sampleUv;void main(){vec2 p=gl_VertexID==0?vec2(-1.,-1.):gl_VertexID==1?vec2(3.,-1.):vec2(-1.,3.);sampleUv=p*.5+.5;gl_Position=vec4(p,0.,1.);}');
      const fragment=shader(gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float;precision highp int;in highp vec2 sampleUv;uniform highp sampler2D image;uniform highp float lod;uniform highp vec2 coordinate;out highp vec4 outColor;void main(){outColor=textureLod(image,coordinate+sampleUv*0.,lod);}');
      const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);check(gl.getProgramParameter(program,gl.LINK_STATUS),gl.getProgramInfoLog(program));
      const output=gl.createTexture(),fbo=gl.createFramebuffer(),vao=gl.createVertexArray();const result=[];
      try{
        gl.bindTexture(gl.TEXTURE_2D,output);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,output,0);
        check(gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE,'Sample FBO incomplete');
        gl.viewport(0,0,1,1);gl.disable(gl.BLEND);gl.disable(gl.DITHER);gl.useProgram(program);gl.bindVertexArray(vao);
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,resource());gl.uniform1i(gl.getUniformLocation(program,'image'),0);
        for(const uv of [[.5/64,.5/64],[1-.5/64,1-.5/64],[.347,.663]])for(const lod of [-2,0,.5,1,1.5,2,2.5,3,3.5,4,20]){
          gl.uniform2f(gl.getUniformLocation(program,'coordinate'),...uv);gl.uniform1f(gl.getUniformLocation(program,'lod'),lod);gl.drawArrays(gl.TRIANGLES,0,3);
          const rgba=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
          const bounded=Math.max(0,Math.min(maxLod,lod)),low=Math.floor(bounded),high=Math.ceil(bounded),weight=bounded-low;
          const left=bilinear(levels[low],uv),right=bilinear(levels[high],uv),expected=left.map((value,c)=>value*(1-weight)+right[c]*weight);
          const error=Math.max(...rgba.map((value,c)=>Math.abs(value-expected[c])));
          check(error<=2,'Actual textureLod differs for lod '+lod+' error '+error);result.push({uv,lod,rgba:[...rgba],expected,maxChannelError:error});
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,canvas.width,canvas.height);
        gl.uniform2f(gl.getUniformLocation(program,'coordinate'),.347,.663);gl.uniform1f(gl.getUniformLocation(program,'lod'),1.5);gl.drawArrays(gl.TRIANGLES,0,3);
      }finally{gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindVertexArray(null);gl.useProgram(null);gl.bindTexture(gl.TEXTURE_2D,null);
        gl.deleteFramebuffer(fbo);gl.deleteTexture(output);gl.deleteVertexArray(vao);gl.deleteProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);engine.wipeCaches(true);}
      check(gl.getError()===gl.NO_ERROR,'Actual WebGL error after sampling');return result;
    };
    const before={states:states(),levels:readLevels(),samples:sampleLods()};
    const extension=gl.getExtension('WEBGL_lose_context');check(extension,'Actual context-loss extension unavailable');
    let lost=false;const lostPromise=new Promise(resolve=>engine.onContextLostObservable.addOnce(()=>{lost=true;resolve();}));
    const restoredPromise=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('context restore timeout')),15000);engine.onContextRestoredObservable.addOnce(()=>{clearTimeout(timer);resolve();});});
    extension.loseContext();await lostPromise;await new Promise(resolve=>setTimeout(resolve,25));extension.restoreContext();await restoredPromise;
    check(lost,'No actual context loss observed');
    const after={states:states(),levels:readLevels(),samples:sampleLods()};
    check(JSON.stringify(before.levels)===JSON.stringify(after.levels),'Restored full mip bytes differ');
    check(JSON.stringify(before.samples)===JSON.stringify(after.samples),'Restored textureLod samples differ');
    check(generated===0,'GPU generateMipmap was called');
    const canvasPng=canvas.toDataURL('image/png');
    const hardwareTexture=resource();texture.dispose();
    check(!gl.isTexture(hardwareTexture),'Disposed GPU texture still live');
    check(internal.onRebuildCallback===null&&internal._bufferView===null,'Disposed CPU restore references remain');
    check(scene.textures.length===sceneTextureCount,'Scene texture registry leaked');
    return {status:'PASS',hardware,before,after,shorterChains,generatedMipmaps:generated,preCancelPassed:canceled,disposedGpuTexture:true,restoreErrors:records,canvasPng};
  }finally{texture?.dispose();scene.dispose();engine.dispose();}
};
`;

let application;
try {
  const entry = path.join(output, 'renderer.ts');
  const isolatedSource = renderer
    .replace("'./electron/shared/sceneLightingLightmapMips.ts'", JSON.stringify(path.resolve(sources[0]).replaceAll('\\', '/')))
    .replace("'./src/runtime/babylon/lightingLightmapMipTexture.ts'", JSON.stringify(path.resolve(sources[1]).replaceAll('\\', '/')));
  await fs.writeFile(entry, isolatedSource);
  // 只构建此独立GPU入口；不加载项目vite.config/.env/public，也不写dist或安装工具。
  await build({ configFile: false, root: output, envDir: output, publicDir: false, logLevel: 'silent',
    build: { target: 'chrome142', outDir: output, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry, name: 'Phase2MipProbe', formats: ['iife'], fileName: () => 'probe.js' } } });
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><title>B9 mip adapter GPU oracle</title><style>body{margin:0;background:#17212b;color:white;font:14px monospace}canvas{width:256px;height:256px;image-rendering:pixelated}p{margin:12px}</style><p>Actual WebGL2 mip / context restore oracle</p><canvas id="gpu" width="128" height="128"></canvas><script src="probe.js"></script>');
  await fs.writeFile(bootstrap, `import {app,BrowserWindow} from 'electron';app.setPath('userData',${JSON.stringify(path.join(output, 'userData'))});app.whenReady().then(()=>{const window=new BrowserWindow({width:460,height:390,show:true,webPreferences:{contextIsolation:true,sandbox:true}});void window.loadFile(${JSON.stringify(path.join(output, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: electron, args: [bootstrap], cwd: process.cwd(), env, timeout: 20000 });
  report.ownedPid = application.process().pid;
  const page = await application.firstWindow();
  report.consoleErrors = [];
  page.on('pageerror', error => report.consoleErrors.push(error.message));
  await page.waitForFunction(() => typeof window.__phase2Run === 'function');
  const result = await page.evaluate(() => window.__phase2Run());
  assert.ok(result.canvasPng.startsWith('data:image/png;base64,'));
  await fs.writeFile(path.join(output, 'actual-webgl-frame.png'), Buffer.from(result.canvasPng.split(',')[1], 'base64'));
  delete result.canvasPng;
  for (const phase of ['before', 'after']) {
    for (const level of result[phase].levels) {
      const rgba = Buffer.from(level.rgba), file = `${phase}-lod-${level.lod}.rgba`;
      await fs.writeFile(path.join(output, file), rgba);
      delete level.rgba; level.byteLength = rgba.length; level.sha256 = sha(rgba); level.file = file;
    }
  }
  report.result = result;
  assert.equal(result.status, 'PASS'); assert.deepEqual(result.restoreErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  await page.screenshot({ path: path.join(output, 'actual-webgl.png') });
  report.status = 'PASS_ACTUAL_WEBGL2_ALL_MIPS_AND_RESTORE';
} catch (error) { report.status = 'FAIL'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (application) {
    const owned = application.process();
    try { await application.close(); }
    catch (error) {
      report.closeError = String(error);
      // 只处理本次launch返回的精确child handle，不扫描/按名称结束其它Electron。
      if (owned.exitCode === null && owned.signalCode === null) owned.kill();
      if (owned.exitCode === null && owned.signalCode === null) await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000); owned.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    report.resourcesClosed = owned.exitCode !== null || owned.signalCode !== null;
    report.ownedProcessExitCode = owned.exitCode;
    report.ownedProcessSignal = owned.signalCode;
  } else report.resourcesClosed = true;
  if (!report.resourcesClosed) { report.status = 'FAIL'; process.exitCode = 1; }
  await fs.rm(bootstrap, { force: true });
  report.bootstrapRemoved = true;
  report.sourceUnchanged = Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await fs.readFile(file)) === sourceSha256[file]])));
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, output, resourcesClosed: report.resourcesClosed, error: report.error }));
}
