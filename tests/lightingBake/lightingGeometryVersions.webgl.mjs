/* global document */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = path.resolve('output/render-optimization-q1-20261024/b6');
const output = path.join(root, 'hardware-webgl');
await fs.mkdir(output, { recursive: true });
const payloads = new Map();
const png = await fs.readFile(path.join(root, 'real-cpu-comparison/candidate-atlas-0.png'));
payloads.set('png', png);
payloads.set('probes', Buffer.from(JSON.stringify({ version: 1, encoding: 'ambient-cube', spacing: 1,
  probes: [{ position: [0, 0, 0], irradiance: Array(18).fill(0.5) }] })));
const cases = ['weld', 'uv-seam', 'absent-channels', 'winding', 'grid'];
for (const label of cases) for (const version of [1, 2]) {
  payloads.set(label + '-v' + version, await fs.readFile(path.join(root, 'weld-complete', label + '-v' + version + '.json')));
}
const snapshots = cases.map(label => ({ label, variants: [1, 2].map(version => {
  const ids = [label + '-v' + version, 'png', 'probes'];
  return { version: 1, signature: label, createdAt: '2026-10-24T00:00:00Z', engineVersion: 'actual Blender export',
    assets: ids.map((id, index) => ({ id, kind: index === 0 ? 'geometry' : index === 1 ? 'lightmap' : 'probes',
      ...(index === 0 ? { geometryVersion: version } : {}), url: '/__b6_asset__/' + id, byteLength: payloads.get(id).byteLength,
      sha256: createHash('sha256').update(payloads.get(id)).digest('hex'), ...(index === 1 ? { rgbmRange: 3 } : {}) })),
    surfaces: [{ key: 'a/root', entityId: 'a', nodeKey: 'root', geometryAssetId: ids[0], lightmapAssetId: 'png' }], probeAssetId: 'probes',
    statistics: { meshCount: 1, triangleCount: 2, atlasCount: 1, probeCount: 1, textureBytes: 1024 * 1024 * 4, durationMs: 0 } };
}) }));
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(output, 'vite-cache'), appType: 'custom',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true } });
server.middlewares.use('/__b6__', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html'); response.end(await server.transformIndexHtml('/__b6__',
    '<!doctype html><meta charset="utf-8"><title>B6 v1/v2 GPU</title><canvas width="256" height="256"></canvas>'));
});
server.middlewares.use('/__b6_asset__', (request, response) => {
  const id = new URL(request.url, 'http://localhost').pathname.slice(1);
  response.setHeader('Content-Type', id === 'png' ? 'image/png' : 'application/json'); response.end(payloads.get(id));
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.B6_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__b6__');
  const report = await page.evaluate(async cases => {
    // 拾取依赖 Babylon 的显式注册；不能把未注册时的空结果当作等价证据。
    await import('/node_modules/@babylonjs/core/Culling/ray.js');
    const { Color4 } = await import('/node_modules/@babylonjs/core/Maths/math.color.js');
    const [{ Engine }, { Scene }, { Mesh }, { VertexData }, { ArcRotateCamera }, { Vector3, Matrix }, { ShaderMaterial }, { Effect }, { loadLightingResources }] = await Promise.all([
      import('/node_modules/@babylonjs/core/Engines/engine.js'), import('/node_modules/@babylonjs/core/scene.js'),
      import('/node_modules/@babylonjs/core/Meshes/mesh.js'), import('/node_modules/@babylonjs/core/Meshes/mesh.vertexData.js'),
      import('/node_modules/@babylonjs/core/Cameras/arcRotateCamera.js'), import('/node_modules/@babylonjs/core/Maths/math.vector.js'),
      import('/node_modules/@babylonjs/core/Materials/shaderMaterial.js'), import('/node_modules/@babylonjs/core/Materials/effect.js'),
      import('/src/runtime/babylon/lightingRuntimeResources.ts'),
    ]);
    Effect.ShadersStore.b6VertexShader = 'precision highp float; attribute vec3 position; attribute vec3 normal; attribute vec2 uv; attribute vec2 uv2; attribute vec4 color; attribute vec4 tangent; attribute vec2 lightmapUv; uniform mat4 worldViewProjection; varying vec3 tint; void main(){ gl_Position=worldViewProjection*vec4(position,1.0); tint=vec3(.17+.21*uv.x+.13*uv2.x+.11*lightmapUv.y+.07*color.r+.03*tangent.w, .23+.19*uv.y+.17*lightmapUv.x+.05*color.g+.02*normal.y, .31+.11*uv2.y+.13*color.b+.02*normal.z); }';
    Effect.ShadersStore.b6FragmentShader = 'precision highp float; varying vec3 tint; void main(){gl_FragColor=vec4(tint,1.0);}';
    const canvas = document.querySelector('canvas');
    const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
    const results = [];
    try {
      for (const item of cases) {
        const variants = [];
        for (const snapshot of item.variants) {
          const scene = new Scene(engine);
          scene.clearColor = new Color4(0, 0, 0, 1);
          const camera = new ArcRotateCamera('camera', Math.PI / 2, Math.PI / 2, 2, new Vector3(.5, .5, 0), scene);
          camera.minZ = .01;
          const resources = await loadLightingResources(snapshot, scene);
          try {
            const geometry = resources.geometries.get(snapshot.assets[0].id), mesh = new Mesh('b6', scene), data = new VertexData();
            const count = geometry.positions.length / 3;
            data.positions = geometry.positions; data.normals = geometry.normals; data.indices = geometry.indices; data.uvs = geometry.uvs;
            data.uvs2 = geometry.uvs2 ?? Array(count * 2).fill(.25);
            data.colors = geometry.colors ?? Array(count * 4).fill(.7);
            data.tangents = geometry.tangents ?? Array.from({ length: count }, () => [1, 0, 0, -1]).flat();
            data.applyToMesh(mesh, false); mesh.setVerticesData('lightmapUv', geometry.bakeUvs, false, 2);
            const material = new ShaderMaterial('all-attributes', scene, 'b6', { attributes: ['position', 'normal', 'uv', 'uv2', 'color', 'tangent', 'lightmapUv'], uniforms: ['worldViewProjection'] });
            material.backFaceCulling = false; mesh.material = material;
            await scene.whenReadyAsync(); scene.render(); scene.render();
            const pixels = Array.from(await engine.readPixels(0, 0, 256, 256));
            const points = [[128, 128], [100, 145], [145, 100]].map(([x, y]) => {
              const hit = scene.pick(x, y);
              if (!hit.hit) throw new Error('Fixture pick missed ' + item.label + ':' + x + ',' + y);
              return { hit: hit.hit, faceId: hit.faceId, bu: hit.bu, bv: hit.bv, distance: hit.distance,
                point: hit.pickedPoint?.asArray(), normal: hit.getNormal()?.asArray() };
            });
            const bounds = mesh.getBoundingInfo().boundingBox;
            variants.push({ version: geometry.version, pixels, picks: points, bounds: [bounds.minimum.asArray(), bounds.maximum.asArray()],
              vertices: count, worldIdentity: mesh.getWorldMatrix().equals(Matrix.Identity()) });
          } finally { resources.dispose(); scene.dispose(); }
        }
        const different = variants[0].pixels.reduce((count, value, index) => count + (value !== variants[1].pixels[index] ? 1 : 0), 0);
        const colorComponents = variants[0].pixels.reduce((count, value, index) => count + (index % 4 < 3 && value > 40 ? 1 : 0), 0);
        if (different || colorComponents < 1000 || colorComponents >= 256 * 256 * 3) throw new Error('Invalid raster comparison ' + item.label + ': ' + different + '/' + colorComponents);
        if (JSON.stringify(variants[0].picks) !== JSON.stringify(variants[1].picks) || JSON.stringify(variants[0].bounds) !== JSON.stringify(variants[1].bounds)) throw new Error('CPU pick/bounds mismatch ' + item.label);
        results.push({ label: item.label, differentPixelComponents: different, comparedComponents: variants[0].pixels.length, colorComponents,
          v1Vertices: variants[0].vertices, v2Vertices: variants[1].vertices, picks: variants[0].picks, bounds: variants[0].bounds });
      }
      return { status: 'PASS', webglVersion: engine.webGLVersion, glInfo: engine.getGlInfo(), cases: results, preview: canvas.toDataURL('image/png') };
    } finally { engine.dispose(); }
  }, snapshots);
  assert.deepEqual(errors, []);
  assert.equal(report.webglVersion, 2);
  assert.doesNotMatch(report.glInfo.renderer, /swiftshader|llvmpipe|software/i);
  await fs.writeFile(path.join(output, 'grid-v2.png'), Buffer.from(report.preview.split(',')[1], 'base64'));
  delete report.preview;
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log('LIGHTING_GEOMETRY_VERSIONS_WEBGL_PASS ' + JSON.stringify(report));
} finally { await browser?.close(); await server.close(); }
