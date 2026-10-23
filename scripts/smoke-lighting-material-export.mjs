/* global window */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { build } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/lighting-material-export');
const harness = `
import { Constants, Engine, Material, PBRMaterial, RawTexture, Scene, Texture } from '@babylonjs/core';
import { createLightingTextureCapture, exportLightingMaterial } from '/src/runtime/babylon/lightingGeometry.ts';
window.checkExport = async () => {
  const engine = new Engine(document.querySelector('canvas'),false,{preserveDrawingBuffer:true});
  const scene = new Scene(engine), capture = createLightingTextureCapture();
  try {
    const source = new Uint8Array([201,103,47,0,79,151,223,2,0,0,255,255,255,255,255,255]);
    const texture = RawTexture.CreateRGBATexture(source,2,2,scene,false,false,Texture.NEAREST_SAMPLINGMODE);
    texture.name='opaque-zero-alpha';texture.hasAlpha=true;texture.gammaSpace=false;
    const material=new PBRMaterial('opaque-source',scene);
    material.transparencyMode=Material.MATERIAL_OPAQUE;material.albedoTexture=texture;material.useAlphaFromAlbedoTexture=true;
    const exported=await exportLightingMaterial(material,capture);
    const hdr=[];
    for(const value of [2,-0.1]){
      const item=RawTexture.CreateRGBATexture(new Float32Array([value,0.5,0.5,1]),1,1,scene,false,false,Texture.NEAREST_SAMPLINGMODE,Constants.TEXTURETYPE_FLOAT);
      item.name='hdr-'+value;item.gammaSpace=false;
      try{await capture(item);hdr.push({value,rejected:false});}
      catch(error){hdr.push({value,rejected:true,message:String(error.message)});}
    }
    return {renderer:engine.getGlInfo().renderer,webGLVersion:engine.webGLVersion,
      png:exported.textures.baseColor.url,colorSpace:exported.textures.baseColor.colorSpace,
      invertY:exported.textures.baseColor.invertY,
      alphaMode:exported.alphaMode,useTextureAlpha:exported.useTextureAlpha,hdr};
  }finally{scene.dispose();engine.dispose();}
};
`;
const bundle = await build({
  configFile: false, logLevel: 'warn',
  build: { write: false, minify: false, rollupOptions: { input: '/__material_export__.js', output: { codeSplitting: false } } },
  plugins: [{
    name: 'material-export-fixture',
    resolveId(id) {
      if (id === '/__material_export__.js') return '\0material-export';
      if (id.startsWith('/src/')) return path.resolve(id.slice(1));
    },
    load(id) { if (id === '\0material-export') return harness; },
  }],
});
const entry = bundle.output.find(item => item.type === 'chunk' && item.isEntry);
assert.ok(entry);
const server = createServer((request, response) => {
  if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (request.url === '/__material_export__.js') {
    response.setHeader('Content-Type', 'text/javascript'); response.end(entry.code); return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><canvas width="8" height="8"></canvas><script type="module" src="/__material_export__.js"></script>');
});
let browser;
const errors = [];
try {
  await mkdir(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.checkExport === 'function', null, { timeout: 120_000 });
  const { png: dataUrl, ...result } = await page.evaluate(() => window.checkExport());
  const png = Buffer.from(dataUrl.split(',')[1], 'base64'), data = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') data.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const rawPixels = [...inflateSync(Buffer.concat(data))];
  await writeFile(path.join(output, 'opaque-zero-alpha.png'), png);
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ ...result, rawPixels, errors }, null, 2));
  assert.deepEqual(errors, []);
  assert.equal(result.webGLVersion, 2);
  assert.equal(result.colorSpace, 'linear');
  assert.equal(result.invertY, true);
  assert.equal(result.alphaMode, 'opaque');
  assert.equal(result.useTextureAlpha, false);
  assert.deepEqual(rawPixels, [0, 201, 103, 47, 0, 79, 151, 223, 2, 0, 0, 0, 255, 255, 255, 255, 255, 255],
    'GPU捕获必须保留透明像素内原RGB字节和原始行顺序');
  assert.ok(result.hdr.every(item => item.rejected && /HDR/.test(item.message)), '真实浮点GPU纹理不得被夹成PNG');
  console.log(JSON.stringify({ ...result, rawPixels, errors }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
