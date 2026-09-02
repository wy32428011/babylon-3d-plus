// 验证俯视 45° 点击货格的归格算法：旧（z=0 平面兜底）vs 新（前表面平面/slab）。
// 货格：4 列 3 层，单格 1.2(长x) × 1.5(高y) × 1.2(深z)，无间隔，startColumn/startLayer=1。
import { NullEngine, Scene, ArcRotateCamera, Vector3, Matrix } from '@babylonjs/core';

const engine = new NullEngine({ renderWidth: 1600, renderHeight: 900 });
const scene = new Scene(engine);

const COLUMNS = 4, LAYERS = 3, LEN = 1.2, HGT = 1.5, DEP = 1.2;
const spanX = COLUMNS * LEN, spanY = LAYERS * HGT;
// 格子中心公式：x = col*stepX（0 列在 x=0），y = HGT/2 + layer*stepY
// 范围盒：x ∈ [-LEN/2, (C-1)*LEN + LEN/2]，y ∈ [0, spanY]，z ∈ [-DEP/2, DEP/2]

// 相机：货架前方 +z 侧，俯视 45°
const target = new Vector3((COLUMNS - 1) * LEN / 2, spanY / 2, 0);
const camera = new ArcRotateCamera('cam', Math.PI / 2, Math.PI / 4, 15, target, scene);
camera.minZ = 0.1;
camera.update();
camera.getViewMatrix();
camera.getProjectionMatrix();

function project(worldPoint) {
  const viewport = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
  const transform = camera.getViewMatrix().multiply(camera.getProjectionMatrix());
  const p = Vector3.Project(worldPoint, Matrix.IdentityReadOnly, transform, viewport);
  return { x: p.x, y: p.y };
}

function resolveOld(px, py) { // z=0 平面
  const ray = scene.createPickingRay(px, py, Matrix.Identity(), camera);
  if (Math.abs(ray.direction.z) < 1e-8) return null;
  const t = -ray.origin.z / ray.direction.z;
  if (t <= 0) return null;
  const local = ray.origin.add(ray.direction.scale(t));
  return snap(local);
}

function resolveNew(px, py) { // slab 进入点归格（与 SceneRuntime.pickBuiltInSlotCellAtCanvasPoint 同源）
  const ray = scene.createPickingRay(px, py, Matrix.Identity(), camera);
  const origin = ray.origin, direction = ray.direction;
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
  return snap(new Vector3(
    Math.min(maxX, Math.max(minX, local.x)),
    Math.min(maxY, Math.max(minY, local.y)),
    local.z,
  ));
}

function snap(local) {
  const col = Math.min(COLUMNS - 1, Math.max(0, Math.round(local.x / LEN)));
  const layer = Math.min(LAYERS - 1, Math.max(0, Math.round((local.y - HGT / 2) / HGT)));
  return { col, layer };
}

function run(betaDeg, label) {
  camera.beta = betaDeg * Math.PI / 180;
  camera.update();
  let oldCorrect = 0, newCorrect = 0, total = 0;
  const oldErrors = [];
  for (let layer = 0; layer < LAYERS; layer += 1) {
    for (let col = 0; col < COLUMNS; col += 1) {
      for (const fy of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        // 点击该格前表面（z=+DEP/2）内的不同高度 —— 即用户看到的格面
        const frontPoint = new Vector3(col * LEN, (layer + fy) * HGT, DEP / 2);
        const p = project(frontPoint);
        const o = resolveOld(p.x, p.y);
        const n = resolveNew(p.x, p.y);
        total += 1;
        const okO = o && o.col === col && o.layer === layer;
        const okN = n && n.col === col && n.layer === layer;
        if (okO) oldCorrect += 1;
        if (okN) newCorrect += 1;
        if (!okO && okN) oldErrors.push(`格(${col},${layer})@${(fy * 100) | 0}% 旧→(${o?.col},${o?.layer}) 新→(${n?.col},${n?.layer})`);
      }
    }
  }
  console.log(`${label}：旧算法 ${oldCorrect}/${total}，新算法 ${newCorrect}/${total}`);
  for (const e of oldErrors) console.log('  旧错新对:', e);
}

run(45, '俯视45°');
run(60, '俯视60°');
run(75, '俯视75°');
run(20, '平缓20°');

// 侧面视角：相机在货架 -x 端（列端面）看过去，点击近端面各层应归到最近列（列索引 0）且层正确。
{
  camera.target = target; // 先设 target：setTarget 会保持相机位置反推 alpha/beta，必须最后再设角度
  camera.alpha = Math.PI; // 实测该 alpha 相机落在 -x 侧
  camera.beta = Math.PI / 2.5;
  camera.update();
  const nearFaceX = -LEN / 2; // -x 侧近端面
  let ok = 0, total = 0;
  const errors = [];
  for (let layer = 0; layer < LAYERS; layer += 1) {
    for (const fy of [0.2, 0.5, 0.8]) {
      const sidePoint = new Vector3(nearFaceX, (layer + fy) * HGT, 0);
      const p = project(sidePoint);
      const n = resolveNew(p.x, p.y);
      total += 1;
      if (n && n.col === 0 && n.layer === layer) ok += 1;
      else errors.push(`层${layer}@${(fy * 100) | 0}% → (${n?.col},${n?.layer})`);
    }
  }
  console.log(`侧面端面点击：${ok}/${total} 归到最近列+正确层`);
  for (const e of errors) console.log('  错:', e);
}
engine.dispose();
