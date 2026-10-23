/* global window */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'vite';
import { chromium } from 'playwright';

const outputDir = path.resolve('output/playwright/baked-lighting-material');
const harness = `
import {
  Color3, Constants, Engine, FreeCamera, Material, MeshBuilder, PBRMaterial,
  RawCubeTexture, RawTexture, Scene, SphericalPolynomial, StandardMaterial, Texture, Vector3,
} from '@babylonjs/core';
import { BakedLightingMaterialPlugin, LIGHTING_UV_ATTRIBUTE } from '/src/runtime/babylon/BakedLightingMaterialPlugin.ts';
const canvas=document.querySelector('canvas');
const engine=new Engine(canvas,false,{preserveDrawingBuffer:true});
window.checkBakedMaterial=async config=>{
  const scene=new Scene(engine);scene.clearColor.set(0,0,0,1);
  const camera=new FreeCamera('camera',new Vector3(0,0,-4),scene);camera.setTarget(Vector3.Zero());
  const sphere=MeshBuilder.CreateSphere('sphere',{diameter:2,segments:24},scene);
  sphere.setVerticesData(LIGHTING_UV_ATTRIBUTE,sphere.getVerticesData('uv'),false,2);
  const material=config.kind==='pbr'?new PBRMaterial('material',scene):new StandardMaterial('material',scene);
  sphere.material=material;
  let cube=null;
  if(config.ibl||config.refraction){
    const data=Array.from({length:6},(_,face)=>{
      const pixels=new Float32Array(8*8*4);
      for(let p=0;p<pixels.length;p+=4){pixels[p]=0.12+face*0.015;pixels[p+1]=0.16;pixels[p+2]=0.2;pixels[p+3]=1;}
      return pixels;
    });
    cube=new RawCubeTexture(scene,data,8,Constants.TEXTUREFORMAT_RGBA,Constants.TEXTURETYPE_FLOAT,true,false,Texture.TRILINEAR_SAMPLINGMODE);
    cube.gammaSpace=false;cube.coordinatesMode=Texture.CUBIC_MODE;
    const polynomial=new SphericalPolynomial();
    polynomial.xx.set(64/255,64/255,64/255);polynomial.yy.copyFrom(polynomial.xx);polynomial.zz.copyFrom(polynomial.xx);
    cube.sphericalPolynomial=polynomial;
    if(config.ibl)scene.environmentTexture=cube;
  }
  if(config.kind==='pbr'){
    material.albedoColor.set(0.6,0.5,0.4);material.metallic=config.metallic??0;material.roughness=0.45;
    if(config.clearcoat){
      material.clearCoat.isEnabled=true;material.clearCoat.intensity=1;material.clearCoat.isTintEnabled=true;
      material.clearCoat.tintColor.set(0.4,0.7,0.9);material.clearCoat.tintThickness=0.5;
    }
    if(config.refraction){
      material.subSurface.isRefractionEnabled=true;material.subSurface.refractionIntensity=0.4;
      material.subSurface.refractionTexture=cube;material.subSurface.minimumThickness=0.2;material.subSurface.maximumThickness=0.5;
    }
    if(config.translucency){
      material.subSurface.isTranslucencyEnabled=true;material.subSurface.translucencyIntensity=0.4;
      material.subSurface.tintColor=new Color3(0.8,0.6,0.5);
    }
  }else{
    material.diffuseColor.set(0.6,0.5,0.4);material.specularColor.set(0.1,0.1,0.1);
    if(config.ibl)material.reflectionTexture=cube;
  }
  const texture=RawTexture.CreateRGBATexture(new Uint8Array([64,64,64,255]),1,1,scene,false,false,Texture.NEAREST_SAMPLINGMODE);
  texture.gammaSpace=false;
  let enabled=false,mapMode=true,zero=false;
  const images={};
  const capture=async label=>{
    material.markAsDirty(Material.AllDirtyFlag);
    engine.beginFrame();scene.render();engine.endFrame();
    await material.forceCompilationAsync(sphere);
    await scene.whenReadyAsync();
    for(let i=0;i<5;i++){engine.beginFrame();scene.render();engine.endFrame();await new Promise(resolve=>setTimeout(resolve,10));}
    images[label]=canvas.toDataURL('image/png');
    const pixels=Array.from(await engine.readPixels(0,0,256,256));
    const center=(128*256+128)*4;
    const effect=sphere.subMeshes[0].effect;
    return {pixels,center:pixels.slice(center,center+3),defines:effect.defines,
      active:effect.getUniform('lightingBakeActive')?engine._gl.getUniform(effect.getPipelineContext().program,effect.getUniform('lightingBakeActive')):null,
      probePY:effect.getUniform('lightingProbePY')?engine._gl.getUniform(effect.getPipelineContext().program,effect.getUniform('lightingProbePY')):null,
      shader:effect.fragmentSourceCode.includes('vec3 bakedDiffuse'),
      unlit:effect.defines.includes('#define UNLIT'),
    };
  };
  const difference=(a,b)=>{
    let maxDifference=0,differentPixels=0;
    for(let i=0;i<a.length;i+=4){
      const d=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));
      maxDifference=Math.max(maxDifference,d);if(d>2)differentPixels++;
    }
    return {maxDifference,differentPixels};
  };
  try{
    const baseline=await capture('baseline');
    new BakedLightingMaterialPlugin(material,()=>({
      enabled,texture:mapMode?texture:undefined,rgbmRange:zero?0:1,
      probes:mapMode?undefined:Array(18).fill(zero?0:64/255),
    }));
    const disabled=await capture('disabled');
    enabled=true;
    sphere.removeVerticesData(LIGHTING_UV_ATTRIBUTE);
    const missingUv=await capture('missing-uv');
    sphere.setVerticesData(LIGHTING_UV_ATTRIBUTE,sphere.getVerticesData('uv'),false,2);
    const mapped=await capture('mapped');
    mapMode=false;
    const probed=await capture('probed');
    zero=true;
    const darkened=await capture('zero');
    const errors=[];for(let e=engine._gl.getError();e!==engine._gl.NO_ERROR;e=engine._gl.getError())errors.push(e);
    return {
      config,renderer:engine.getGlInfo().renderer,images,glErrors:errors,
      disabledDifference:difference(baseline.pixels,disabled.pixels),
      missingUvDifference:difference(baseline.pixels,missingUv.pixels),
      mapProbeDifference:difference(mapped.pixels,probed.pixels),
      bakedNativeDifference:difference(mapped.pixels,baseline.pixels),
      metalDifference:difference(probed.pixels,darkened.pixels),
      baseline:baseline.center,mapped:mapped.center,probed:probed.center,zero:darkened.center,
      mapCompiled:mapped.defines.includes('#define BAKED_INDIRECT_MAP'),
      probeCompiled:!probed.defines.includes('#define BAKED_INDIRECT_MAP'),
      reflectionCompiled:probed.defines.includes('#define REFLECTION'),
      debug:{mapped:{active:mapped.active,shader:mapped.shader,unlit:mapped.unlit},probed:{active:probed.active,probePY:probed.probePY,shader:probed.shader}},
    };
  }finally{scene.dispose();}
};
`;
const bundle = await build({
  configFile: false, logLevel: 'warn',
  build: { write: false, minify: false, rollupOptions: { input: '/__baked_material__.js', output: { codeSplitting: false } } },
  plugins: [{
    name: 'baked-material-fixture',
    resolveId(id) {
      if (id === '/__baked_material__.js') return '\0baked-material';
      if (id.startsWith('/src/')) return path.resolve(id.slice(1));
    },
    load(id) { if (id === '\0baked-material') return harness; },
  }],
});
const entry = bundle.output.find(item => item.type === 'chunk' && item.isEntry);
assert.ok(entry);
const server = createServer((request, response) => {
  if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (request.url === '/__baked_material__.js') {
    response.setHeader('Content-Type', 'text/javascript'); response.end(entry.code); return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><canvas width="256" height="256"></canvas><script type="module" src="/__baked_material__.js"></script>');
});
let browser;
const errors = [], results = [];
try {
  await mkdir(outputDir, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); } });
  await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.checkBakedMaterial === 'function', null, { timeout: 120_000 });
  const cases = [
    { kind: 'pbr', name: 'diffuse-no-ibl' },
    { kind: 'pbr', name: 'metal-no-ibl', metallic: 1 },
    { kind: 'pbr', name: 'diffuse-ibl', ibl: true },
    { kind: 'pbr', name: 'metal-ibl', ibl: true, metallic: 1 },
    { kind: 'pbr', name: 'clearcoat-tint', ibl: true, clearcoat: true, metallic: 0.2 },
    { kind: 'pbr', name: 'refraction', ibl: true, refraction: true },
    { kind: 'pbr', name: 'translucency', ibl: true, translucency: true },
    { kind: 'pbr', name: 'refraction-no-ibl', refraction: true, clearcoat: true },
    { kind: 'standard', name: 'diffuse-no-ibl' },
    { kind: 'standard', name: 'reflection', ibl: true },
  ];
  for (const config of cases) {
    console.log('baked-material', config.name);
    const { images, ...result } = await page.evaluate(config => window.checkBakedMaterial(config), config);
    results.push(result);
    await writeFile(path.join(outputDir, 'results.json'), JSON.stringify({ results, errors }, null, 2));
    for (const [label, image] of Object.entries(images)) {
      await writeFile(path.join(outputDir, config.kind + '-' + config.name + '-' + label + '.png'), Buffer.from(image.split(',')[1], 'base64'));
    }
    console.log(JSON.stringify(result));
    assert.deepEqual(errors, [], '所有实际材质组合必须通过真实 shader 编译');
    assert.deepEqual(result.glErrors, []);
    assert.equal(result.disabledDifference.differentPixels, 0, '关闭烘焙必须保持源材质');
    assert.equal(result.missingUvDifference.differentPixels, 0, '缺少 lightmap UV 时保留源材质');
    assert.ok(result.mapCompiled && result.probeCompiled);
    assert.equal(result.mapProbeDifference.differentPixels, 0, '常量 lightmap 与同值探针必须一致');
    if (config.metallic === 1) assert.equal(result.metalDifference.differentPixels, 0, '纯金属不得接收烘焙漫反射');
    else assert.ok(result.mapped[0] > result.zero[0], '非金属必须实际接收烘焙间接光');
    if (config.kind === 'pbr' && config.ibl) {
      assert.equal(result.bakedNativeDifference.differentPixels, 0, '等值 irradiance 必须保持原生 PBR 能量、清漆及透射处理');
    }
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
