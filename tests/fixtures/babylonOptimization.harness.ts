import '../../src/runtime/babylon/babylonSideEffects';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { EntityArrayThinInstanceBatch } from '../../src/runtime/babylon/EntityArrayThinInstanceBatch';
import { getMatrixUploadMetrics, setSparseMatrixUploadsEnabled } from '../../src/runtime/babylon/thinInstanceSparseUpdates';

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const status = document.querySelector('#status')!;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(.07, .09, .12, 1);
const camera = new ArcRotateCamera('camera', -1.1, .7, 105, new Vector3(15, 0, 31), scene);
camera.minZ = .1; camera.maxZ = 1000;
new HemisphericLight('light', new Vector3(0, 1, 0), scene);
const source = MeshBuilder.CreateBox('source', { size: 1.3 }, scene);
const material = new StandardMaterial('surface', scene); material.diffuseColor = new Color3(.15, .65, .9); source.material = material;
const batch = EntityArrayThinInstanceBatch.create('source', [source], { interactive: true, resolveLayerMask: () => 0x0fffffff })!;
source.layerMask = 0;
const instances = Array.from({ length: 512 }, (_, i) => ({ entityId: 'e' + i, pickable: true,
  transform: { position: { x: (i % 16) * 2, y: 0, z: Math.floor(i / 16) * 2 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }));
batch.updateEntityTransforms(Matrix.Identity(), instances);
engine.runRenderLoop(() => scene.render());
window.addEventListener('resize', () => engine.resize()); engine.resize();
const api = window as typeof window & { __babylonOptimization?: unknown };
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const frame = () => new Promise<void>(resolve => scene.onAfterRenderObservable.addOnce(() => resolve()));
async function pixels() {
  return new Promise<Uint8Array>(resolve => scene.onAfterRenderObservable.addOnce(() => {
    const gl = engine._gl as WebGL2RenderingContext;
    const data = new Uint8Array(engine.getRenderWidth() * engine.getRenderHeight() * 4);
    gl.readPixels(0, 0, engine.getRenderWidth(), engine.getRenderHeight(), gl.RGBA, gl.UNSIGNED_BYTE, data);
    resolve(data);
  }));
}
const different = (a: Uint8Array, b: Uint8Array) => a.reduce((n, value, index) => n + Number(value !== b[index]), 0);
function matrixBytes() {
  const mesh = batch.meshes.find(value => value.thinInstanceCount > 0)!;
  const gl = engine._gl as WebGL2RenderingContext;
  const storage = mesh._thinInstanceDataStorage;
  const gpu = new Uint8Array(storage.matrixData!.byteLength);
  const previous = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
  try {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.getVertexBuffer('world0')!.getBuffer()!.underlyingResource);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, gpu);
  } finally { gl.bindBuffer(gl.ARRAY_BUFFER, previous); }
  const cpu = new Uint8Array(storage.matrixData!.buffer, storage.matrixData!.byteOffset, storage.matrixData!.byteLength);
  check(different(cpu, gpu) === 0, 'CPU与GPU矩阵字节不一致');
  return { gpu, mesh };
}

async function run() {
  const result: Record<string, unknown> = { status: 'RUNNING', renderer: engine.getGlInfo(), size: [engine.getRenderWidth(), engine.getRenderHeight()], scope: 'real EntityArrayThinInstanceBatch/WebGL; not factory FPS' };
  api.__babylonOptimization = result;
  try {
    await scene.whenReadyAsync(); await frame();
    const initial = await pixels();
    setSparseMatrixUploadsEnabled(scene, true);
    const before = getMatrixUploadMetrics(scene);
    instances[7].transform.position.y = 4;
    batch.updateEntityTransforms(Matrix.Identity(), instances);
    await frame();
    const current = matrixBytes();
    check(batch.getEntityIdForThinInstance(current.mesh, 7) === 'e7', '局部上传后实体索引改变');
    const changed = await pixels();
    check(different(initial, changed) > 0, '移动实例未改变实际画面');
    const after = getMatrixUploadMetrics(scene);
    result.upload = { before, after };
    check(after.partialUploads > before.partialUploads, '实际批次没有命中局部上传');
    check(after.uploadedBytes - before.uploadedBytes < 512 * 64, '稀疏修改仍整批上传');

    const control = current.gpu;
    current.mesh.thinInstanceBufferUpdated('matrix');
    check(different(changed, await pixels()) === 0, '局部上传与全量上传的实际像素不同');
    const extension = (engine._gl as WebGL2RenderingContext).getExtension('WEBGL_lose_context');
    check(extension, '缺少WEBGL_lose_context，恢复未验证');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebGL恢复超时')), 20000);
      const observer = engine.onContextRestoredObservable.addOnce(() => { clearTimeout(timeout); resolve(); });
      engine.onContextLostObservable.addOnce(() => setTimeout(() => extension!.restoreContext(), 100));
      extension!.loseContext();
      void observer;
    });
    await scene.whenReadyAsync(); await frame(); await frame();
    check(different(control, matrixBytes().gpu) === 0, '上下文恢复后矩阵改变');
    result.restorePixelDifference = different(changed, await pixels());
    check(result.restorePixelDifference === 0, '上下文恢复后实际像素改变');
    result.metrics = getMatrixUploadMetrics(scene);
    result.status = 'PASS'; status.textContent = '通过：局部上传、实体映射、像素与上下文恢复一致';
  } catch (error) {
    result.status = 'FAIL'; result.error = error instanceof Error ? error.stack : String(error);
    status.textContent = String(result.error);
  }
}
document.querySelector<HTMLButtonElement>('#run')!.onclick = () => { void run(); };
await scene.whenReadyAsync(); status.textContent = '512 个真实几何实例已就绪';
