// 复现「-x 侧点击 100% 命中、+x 侧只能点顶/底面」：locator 局部系旋转 90° 后全方向扫描验证。
import { NullEngine, Scene, ArcRotateCamera, Vector3, Matrix, Quaternion } from '@babylonjs/core';

const AXIS_Y = new Vector3(0, 1, 0);

const engine = new NullEngine({ renderWidth: 1600, renderHeight: 900 });
const scene = new Scene(engine);

const COLUMNS = 4, LAYERS = 3, LEN = 1.2, HGT = 1.5, DEP = 1.2;
const spanY = LAYERS * HGT;

const camera = new ArcRotateCamera('cam', 0, Math.PI / 4, 15, Vector3.Zero(), scene);
camera.minZ = 0.1;
camera.update();

// —— 与 SceneRuntime.pickBuiltInSlotCellAtCanvasPoint 同源（参数化 worldMatrix）——
function resolveNew(px, py, worldMatrix) {
  const ray = scene.createPickingRay(px, py, Matrix.Identity(), camera);
  const inverseWorld = Matrix.Invert(worldMatrix); // invert() 原地修改会污染入参矩阵
  const origin = Vector3.TransformCoordinates(ray.origin, inverseWorld);
  const direction = Vector3.TransformNormal(ray.direction, inverseWorld);
  const minX = -LEN / 2, maxX = (COLUMNS - 1) * LEN + LEN / 2;
  const minY = 0, maxY = spanY, minZ = -DEP / 2, maxZ = DEP / 2;
  const slabs = [
    { o: origin.x, d: direction.x, min: minX, max: maxX },
    { o: origin.y, d: direction.y, min: minY, max: maxY },
    { o: origin.z, d: direction.z, min: minZ, max: maxZ },
  ];
  let tEnter = -Infinity, tExit = Infinity;
  for (const s of slabs) {
    if (Math.abs(s.d) < 1e-8) { if (s.o < s.min || s.o > s.max) return null; continue; }
    let t0 = (s.min - s.o) / s.d, t1 = (s.max - s.o) / s.d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tEnter) tEnter = t0;
    tExit = Math.min(tExit, t1);
    if (tEnter > tExit) return null;
  }
  if (tExit <= 0) return null;
  let local;
  if (tEnter > 0) {
    local = origin.add(direction.scale(tEnter));
  } else {
    const faceZ = direction.z >= 0 ? maxZ : minZ;
    if (Math.abs(direction.z) < 1e-8) return null;
    const tFace = (faceZ - origin.z) / direction.z;
    if (tFace <= 0) return null;
    local = origin.add(direction.scale(tFace));
  }
  const clamped = new Vector3(
    Math.min(maxX, Math.max(minX, local.x)),
    Math.min(maxY, Math.max(minY, local.y)),
    local.z,
  );
  const col = Math.min(COLUMNS - 1, Math.max(0, Math.round(clamped.x / LEN)));
  const layer = Math.min(LAYERS - 1, Math.max(0, Math.round((clamped.y - HGT / 2) / HGT)));
  return { col, layer };
}

function project(worldPoint) {
  const viewport = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
  const transform = camera.getViewMatrix().multiply(camera.getProjectionMatrix());
  const p = Vector3.Project(worldPoint, Matrix.IdentityReadOnly, transform, viewport);
  return { x: p.x, y: p.y };
}

// locator 局部系绕 Y 轴旋转 yaw（真实货架朝向可能任意），再平移到原点区域
for (const yawDeg of [0, 90, 180, 270]) {
  const yaw = yawDeg * Math.PI / 180;
  const worldMatrix = Matrix.Compose(
    Vector3.One(),
    Quaternion.RotationAxis(AXIS_Y, yaw),
    new Vector3(0, 0, 0),
  );
  const inverseWorld = Matrix.Invert(worldMatrix); // invert() 原地修改会污染 worldMatrix
  let ok = 0, total = 0, nulls = 0;
  const errors = [];
  // 8 个水平方向环绕点击；只统计前表面朝向相机的方位（其余方位前表面被盒体遮挡，
  // 命中近侧可见格是所见即所得的正确行为，不属于本用例）。
  for (let k = 0; k < 8; k += 1) {
    const azimuth = k * Math.PI / 4;
    // 必须先设 target 再设 alpha/beta：setTarget 会保持相机位置反推 alpha/beta（rebuildAnglesAndRadius）。
    camera.target = Vector3.TransformCoordinates(new Vector3((COLUMNS - 1) * LEN / 2, spanY / 2, 0), worldMatrix);
    camera.alpha = azimuth;
    camera.beta = Math.PI / 4;
    camera.getViewMatrix();
    const camLocalZ = Vector3.TransformCoordinates(camera.position, inverseWorld).z;
    if (camLocalZ <= DEP / 2) continue; // 相机不在局部 +z 前方，跳过
    for (let layer = 0; layer < LAYERS; layer += 1) {
      for (let col = 0; col < COLUMNS; col += 1) {
        // 格子的前表面（局部 z=+DEP/2）中心 → 世界坐标；点击其屏幕投影点
        const frontLocal = new Vector3(col * LEN, HGT / 2 + layer * HGT, DEP / 2);
        const frontWorld = Vector3.TransformCoordinates(frontLocal, worldMatrix);
        const p = project(frontWorld);
        const n = resolveNew(p.x, p.y, worldMatrix);
        total += 1;
        if (!n) { nulls += 1; continue; }
        if (n.col === col && n.layer === layer) ok += 1;
        else errors.push(`方位${k * 45}° 格(${col},${layer})→(${n.col},${n.layer})`);
      }
    }
  }
  console.log(`yaw=${yawDeg}°：${ok}/${total} 正确，null=${nulls}`);
  for (const e of errors.slice(0, 6)) console.log('  错:', e);
}
engine.dispose();
