/* global window */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'vite';
import { chromium } from 'playwright';

const outputDir = path.resolve('output/playwright/hybrid-shadows');
const harness = `
import {
  Color3, DirectionalLight, DynamicTexture, Engine, FreeCamera, Material, Matrix, MeshBuilder, PBRMaterial,
  PointLight, Scene, SpotLight, StandardMaterial, Vector3, VertexBuffer,
} from '@babylonjs/core';
import { SceneShadowRuntime } from '/src/runtime/babylon/SceneShadowRuntime.ts';
const canvas = document.querySelector('canvas');
const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: false });
window.runHybridShadowCase = async ({ kind, materialKind, quality, depthClamp, mode = 'hybrid', textureCase, groupCase, clearGroups, depthPrePass=false, softTransparent=false }) => {
  const scene = new Scene(engine);
  scene.clearColor.set(0.12, 0.12, 0.12, 1);
  const camera = new FreeCamera('camera', new Vector3(0, 20, -16), scene);
  camera.minZ = 0.1; camera.maxZ = 100;
  camera.setTarget(Vector3.Zero());
  const light = kind === 'point'
    ? new PointLight('light', new Vector3(-5, 12, -4), scene)
    : kind === 'spot'
      ? new SpotLight('light', new Vector3(-5, 16, -4), new Vector3(5, -16, 4).normalize(), Math.PI * 0.7, 1, scene)
      : new DirectionalLight('light', new Vector3(0.35, -1, 0.2).normalize(), scene);
  light.position.set(-5, 16, -4);
  light.intensity = kind === 'directional' ? 2 : 240;
  light.range = 70;
  const material = materialKind === 'pbr' ? new PBRMaterial('receiver', scene) : new StandardMaterial('receiver', scene);
  if (materialKind === 'pbr') {
    material.albedoColor.set(0.65, 0.65, 0.65); material.metallic = 0; material.roughness = 0.8;
    material.emissiveColor.set(0.02, 0.02, 0.02);
  } else {
    material.diffuseColor.set(0.65, 0.65, 0.65); material.specularColor.set(0.08, 0.08, 0.08);
    material.emissiveColor.set(0.02, 0.02, 0.02);
  }
  let businessTexture;
  if(textureCase==='opaque-dynamic'||textureCase==='alpha-dynamic'){
    const texture=new DynamicTexture('opaque-business-display',{width:16,height:16},scene,false);
    texture.hasAlpha=textureCase==='alpha-dynamic';const context=texture.getContext();context.fillStyle='#ffffff';context.fillRect(0,0,16,16);texture.update();
    if(materialKind==='pbr')material.albedoTexture=texture;else material.diffuseTexture=texture;
    if(textureCase==='alpha-dynamic')material.transparencyMode=Material.MATERIAL_ALPHATEST;
    businessTexture=texture;
  }
  material.needDepthPrePass=depthPrePass;
  if(softTransparent)material.alpha=0.7;
  const roles = new Map(), tiles = [], casters = [];
  const combinations = [['static','static'],['static','dynamic'],['dynamic','static'],['dynamic','dynamic']];
  combinations.forEach(([casterMobility,receiverMobility], index) => {
    const x = index % 2 ? 3.5 : -3.5, z = index < 2 ? -3.5 : 3.5;
    const tile = MeshBuilder.CreateGround('receiver-' + index, {width:6,height:6,updatable:true}, scene);
    tile.position.set(x, 0, z); tile.material = material; tile.metadata = {editorEnvironmentMesh:true};
    roles.set(tile, {mobility:receiverMobility, castShadows:true, receiveShadows:true});
    const caster = MeshBuilder.CreateBox('caster-' + index, {width:1.4,depth:1.4,height:2}, scene);
    caster.position.set(x, 1, z); caster.material = material;
    roles.set(caster,{mobility:casterMobility,castShadows:true,receiveShadows:true});
    tiles.push(tile); casters.push(caster);
  });
  if(groupCase){
    for(const [mesh,role]of roles)mesh.renderingGroupId=groupCase==='mixed'?Number(mesh.name.split('-').at(-1))%2
      :groupCase==='first-dynamic'?Number(role.mobility==='static'):Number(role.mobility==='dynamic');
    if(groupCase==='inactive'){
      for(const mesh of roles.keys())mesh.renderingGroupId=0;
      const hidden=MeshBuilder.CreateBox('inactive-other-group',{size:1},scene);hidden.material=material;
      hidden.renderingGroupId=2;hidden.setEnabled(false);roles.set(hidden,{mobility:'static',castShadows:true,receiveShadows:true});
    }
  }
  const runtime = new SceneShadowRuntime(scene);
  runtime.syncLight('light', light);
  runtime.setHybridMeshRoles(roles);
  const settings = {
    enabled:true, mode, quality, darkness:0, catcherEnabled:false, sunAzimuthDegrees:56,
    sunElevationDegrees:63, sunIntensity:0, distanceMeters:65, bias:0.002, normalBias:0.03,
    fillIntensity:0, iblIntensityMax:1,
  };
  runtime.applySettings(settings);
  if(softTransparent){
    const generator=light.getShadowGenerator(camera)??light.getShadowGenerator();
    generator.transparencyShadow=true;generator.enableSoftTransparentShadow=true;
  }
  if(clearGroups!==undefined){
    const map=(light.getShadowGenerator(camera)??light.getShadowGenerator()).getShadowMap();
    for(let group=0;group<4;group++)map.setRenderingAutoClearDepthStencil(group,clearGroups);
  }
  if (depthClamp !== undefined) {
    const generator = light.getShadowGenerator(camera) ?? light.getShadowGenerator();
    generator.depthClamp = depthClamp;
  }
  const images = {}, results = [];
  const render = async (frames = 5) => {
    for (let i = 0; i < frames; i++) {
      engine.beginFrame(); scene.render(); engine.endFrame();
      await new Promise(resolve=>setTimeout(resolve,12));
    }
    return Array.from(await engine.readPixels(0,0,512,512));
  };
  const compare = async label => {
    runtime.setHybridMeshRoles(roles,{cacheStaticShadows:true});
    const cached = await render();
    const metrics = runtime.getHybridMetrics();
    images[label] = canvas.toDataURL('image/png');
    runtime.setHybridMeshRoles(roles,{cacheStaticShadows:false});
    const uncached = await render();
    let maxDifference=0,differentPixels=0;
    for(let i=0;i<cached.length;i+=4){
      const difference=Math.max(Math.abs(cached[i]-uncached[i]),Math.abs(cached[i+1]-uncached[i+1]),Math.abs(cached[i+2]-uncached[i+2]));
      maxDifference=Math.max(maxDifference,difference);if(difference>1)differentPixels++;
    }
    results.push({label,maxDifference,differentPixels,metrics,
      litPixels:cached.filter((value,index)=>index%4===0&&value>65).length,
      readDefault:engine._gl.getParameter(engine._gl.READ_FRAMEBUFFER_BINDING)===null,
      drawDefault:engine._gl.getParameter(engine._gl.DRAW_FRAMEBUFFER_BINDING)===null,
      colorWrite:engine.getColorWrite(), activeMeshes:scene.getActiveMeshes().length,
    });
    runtime.setHybridMeshRoles(roles,{cacheStaticShadows:true});
    await render();
    return cached;
  };
  try {
    await render(1);
    await scene.whenReadyAsync();
    await Promise.all(scene.lights.map(item => item.getShadowGenerator(camera) ?? item.getShadowGenerator())
      .filter(Boolean).map(generator => generator.forceCompilationAsync()));
    await render(12);
    const shadowed = await compare('initial');
    const overlapping = MeshBuilder.CreateBox('overlapping-dynamic', {width:1.4,depth:1.4,height:2}, scene);
    overlapping.position.copyFrom(casters[0].position); overlapping.material=material;
    roles.set(overlapping,{mobility:'dynamic',castShadows:true,receiveShadows:true});
    runtime.setHybridMeshRoles(roles);
    const overlapPixels=await render();
    let overlapDifference=0;
    for(let i=0;i<shadowed.length;i+=4)if(Math.abs(shadowed[i]-overlapPixels[i])>1)overlapDifference++;
    roles.delete(overlapping);overlapping.dispose();runtime.setHybridMeshRoles(roles);await render();
    const offRoles = new Map([...roles].map(([mesh,role])=>[mesh,{...role,castShadows:!casters.includes(mesh)}]));
    runtime.setHybridMeshRoles(offRoles);
    const unshadowed = await render();
    images['unshadowed'] = canvas.toDataURL('image/png');
    const viewport = camera.viewport.toGlobal(512,512);
    const relationshipPixels = tiles.map((tile,index)=>{
      const bounds=[[-2.8,-2.8],[-2.8,2.8],[2.8,-2.8],[2.8,2.8]].map(([x,z])=>
        Vector3.Project(new Vector3(tile.position.x+x,0,tile.position.z+z),Matrix.Identity(),scene.getTransformMatrix(),viewport));
      const minX=Math.max(0,Math.ceil(Math.min(...bounds.map(v=>v.x)))),maxX=Math.min(511,Math.floor(Math.max(...bounds.map(v=>v.x))));
      const minY=Math.max(0,Math.ceil(Math.min(...bounds.map(v=>v.y)))),maxY=Math.min(511,Math.floor(Math.max(...bounds.map(v=>v.y))));
      let darker=0;
      for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
        const i=((511-y)*512+x)*4;
        if(unshadowed[i]-shadowed[i]>8)darker++;
      }
      return {caster:combinations[index][0],receiver:combinations[index][1],darker};
    });
    runtime.setHybridMeshRoles(roles);
    await render();
    const stableBefore = runtime.getHybridMetrics();
    await render(5);
    const stableAfter = runtime.getHybridMetrics();
    if(textureCase==='alpha-dynamic'){
      businessTexture.getContext().clearRect(0,0,8,16);businessTexture.update();
      await compare('alpha-updated');
      // 后续楼板遮挡用完整实体比较；先独立验证裁剪恢复也能刷新实际阴影。
      const context=businessTexture.getContext();context.fillStyle='#ffffff';context.fillRect(0,0,16,16);businessTexture.update();
      await compare('alpha-restored');
    }
    casters[2].position.x += 0.45; casters[3].position.z += 0.3;
    await compare('dynamic-moved');
    casters[0].position.x -= 0.7;
    await compare('static-moved');
    const positions=tiles[0].getVerticesData(VertexBuffer.PositionKind);
    positions[1]+=0.2;tiles[0].updateVerticesData(VertexBuffer.PositionKind,positions,true);
    await compare('static-geometry');
    casters[1].isVisible=false;
    await compare('static-hidden');
    light.position.x += 1.1;
    if(kind==='directional') light.direction.x += 0.04;
    await compare('light-moved');
    camera.position.x += 1; camera.setTarget(Vector3.Zero());
    await compare('camera-moved');
    const device=casters[0];
    roles.set(device,{mobility:'dynamic',castShadows:true,receiveShadows:true});
    const slab=MeshBuilder.CreateBox('environment-upper-slab',{width:5,height:0.2,depth:5},scene);
    slab.position.set(device.position.x,4,device.position.z);slab.material=material;slab.metadata={editorEnvironmentMesh:true};
    roles.set(slab,{mobility:'static',castShadows:true,receiveShadows:true});
    camera.position.set(device.position.x,2,device.position.z-10);camera.setTarget(device.position);
    runtime.setHybridMeshRoles(roles);
    const slabOn=await render();images['slab-on']=canvas.toDataURL('image/png');
    roles.set(slab,{mobility:'static',castShadows:false,receiveShadows:true});runtime.setHybridMeshRoles(roles);
    const slabOff=await render();images['slab-off']=canvas.toDataURL('image/png');
    const projected=device.getBoundingInfo().boundingBox.vectorsWorld.map(position=>
      Vector3.Project(position,Matrix.Identity(),scene.getTransformMatrix(),camera.viewport.toGlobal(512,512)));
    let slabOcclusionPixels=0;
    for(let y=Math.max(0,Math.ceil(Math.min(...projected.map(v=>v.y))));y<=Math.min(511,Math.floor(Math.max(...projected.map(v=>v.y))));y++)
      for(let x=Math.max(0,Math.ceil(Math.min(...projected.map(v=>v.x))));x<=Math.min(511,Math.floor(Math.max(...projected.map(v=>v.x))));x++){
        const i=((511-y)*512+x)*4;if(slabOff[i]-slabOn[i]>8)slabOcclusionPixels++;
      }
    const finalMetrics=runtime.getHybridMetrics();
    runtime.applySettings({...settings,enabled:false});
    await render();
    const disabledMetrics=runtime.getHybridMetrics();
    const glErrors=[];
    for(let error=engine._gl.getError();error!==engine._gl.NO_ERROR;error=engine._gl.getError())glErrors.push(error);
    return {
      kind,materialKind,quality,textureCase,groupCase,clearGroups,depthPrePass,softTransparent,renderer:engine.getGlInfo().renderer,webGLVersion:engine.webGLVersion,
      relationshipPixels,overlapDifference,slabOcclusionPixels,stableBefore,stableAfter,finalMetrics,disabledMetrics,results,images,glErrors,
    };
  } finally {runtime.dispose();scene.dispose();}
};
`;

const bundle = await build({
  configFile: false, logLevel: 'warn',
  build: { write: false, minify: false, rollupOptions: { input: '/__hybrid_shadow__.js', output: { codeSplitting: false } } },
  plugins: [{
    name: 'hybrid-shadow-fixture',
    resolveId(id) {
      if (id === '/__hybrid_shadow__.js') return '\0hybrid-shadow';
      if (id.startsWith('/src/')) return path.resolve(id.slice(1));
    },
    load(id) { if (id === '\0hybrid-shadow') return harness; },
  }],
});
const entry = bundle.output.find(item => item.type === 'chunk' && item.isEntry);
assert.ok(entry);
const server = createServer((request, response) => {
  if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (request.url === '/__hybrid_shadow__.js') {
    response.setHeader('Content-Type', 'text/javascript'); response.end(entry.code); return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><canvas width="512" height="512"></canvas><script type="module" src="/__hybrid_shadow__.js"></script>');
});
let browser;
const errors = [];
try {
  await mkdir(outputDir, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => {
    if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); }
  });
  await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.runHybridShadowCase === 'function', null, { timeout: 120_000 });
  const cases = process.env.HYBRID_SHADOW_CASES ? JSON.parse(process.env.HYBRID_SHADOW_CASES) : process.env.HYBRID_SHADOW_CASE
    ? [JSON.parse(process.env.HYBRID_SHADOW_CASE)]
    : ['pbr', 'standard'].flatMap(materialKind => [
      { kind: 'directional', materialKind, quality: 'balanced' },
      { kind: 'directional', materialKind, quality: 'quality' },
      { kind: 'point', materialKind, quality: 'balanced' },
      { kind: 'spot', materialKind, quality: 'balanced' },
    ]);
  for (const config of cases) {
    console.log('hybrid-shadow', JSON.stringify(config));
    const { images, ...result } = await page.evaluate(config => window.runHybridShadowCase(config), config);
    const prefix = [config.materialKind, config.kind, config.quality,config.textureCase,config.groupCase,
      config.clearGroups===undefined?'':config.clearGroups?'group-clear':'group-retain',
      config.depthPrePass?'prepass':'',config.softTransparent?'soft-transparent':''].filter(Boolean).join('-');
    await writeFile(path.join(outputDir, prefix + '.json'), JSON.stringify({ ...result, errors }, null, 2));
    for (const [label, image] of Object.entries(images)) {
      await writeFile(path.join(outputDir, prefix + '-' + label + '.png'), Buffer.from(image.split(',')[1], 'base64'));
    }
    console.log(JSON.stringify(result));
    assert.deepEqual(errors, [], '浏览器不得出现渲染错误');
    assert.deepEqual(result.glErrors, [], 'WebGL 不得出现复制深度或绘制错误');
    assert.equal(result.webGLVersion, 2);
    if(config.clearGroups===true&&config.groupCase!=='inactive'){
      assert.match(result.finalMetrics.unsupportedCacheReason,/清除深度/);
      assert.equal(result.finalMetrics.cachedFaces,0);
    }else assert.equal(result.finalMetrics.unsupportedCacheReason, null);
    if(config.clearGroups===true&&config.groupCase!=='inactive'){
      assert.ok(result.stableAfter.staticRenders>result.stableBefore.staticRenders,'显式组间清理保持原生实时语义');
    }else if(config.textureCase==='alpha-dynamic')assert.ok(result.stableAfter.staticRenders>result.stableBefore.staticRenders,'真实动态alpha继续逐帧更新深度');
    else{
      assert.ok(result.finalMetrics.cacheHits > 0, '必须实际复用静态深度');
      assert.equal(result.stableAfter.staticRenders, result.stableBefore.staticRenders, '稳定帧不可重画静态深度');
    }
    assert.ok(result.stableAfter.dynamicRenders > result.stableBefore.dynamicRenders);
    if(config.clearGroups!==true){
      // 半透明接收材质在主画面本就会叠色；仅实心表面可用整帧重叠比较隔离阴影重复压暗。
      if(!config.softTransparent)assert.equal(result.overlapDifference, 0, '同一盏灯的重叠静态/动态 caster 不得重复压暗');
      assert.ok(result.slabOcclusionPixels > 30, '静态环境楼板必须遮挡下方动态设备');
      for (const relation of result.relationshipPixels) assert.ok(relation.darker > 30, JSON.stringify(relation));
    }
    for (const comparison of result.results) {
      assert.equal(comparison.differentPixels, 0, comparison.label + ' 缓存与全量深度必须一致');
      assert.ok(comparison.litPixels > 1000, comparison.label + ' 必须保留正常受光表面，不能以全黑画面通过像素比较');
    }
    assert.equal(result.disabledMetrics.textureBytes, 0, '关闭阴影必须释放静态缓存和阴影目标');
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
