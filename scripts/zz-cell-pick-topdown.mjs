// 复现「近似俯视点击最顶层货格：焦点跳到起始/终结格或镜像位置」。
// 用中鼎场景真实布局：8 个内置货格 locator（宿主 rot.y=π 或 π/2），逐排做解析拾取取最近。
import { NullEngine, Scene, ArcRotateCamera, Vector3, Matrix, Quaternion } from '@babylonjs/core';

const AXIS_Y = new Vector3(0, 1, 0);
const engine = new NullEngine({ renderWidth: 1600, renderHeight: 900 });
const scene = new Scene(engine);

// 真实布局：[name, T.x, T.z, rotY, cols, layers, L, H, W]
const RACKS = [
  ['货架1', 24.2, -9.12, Math.PI, 42, 7, 1.3, 1.5, 1.2],
  ['货架2', 24.2, -7.84, Math.PI, 42, 7, 1.3, 1.5, 1.2],
  ['货架3', 24.2, -5.13, Math.PI, 42, 7, 1.3, 1.5, 1.2],
  ['货架4', 24.2, -3.82, Math.PI, 42, 7, 1.3, 1.5, 1.2],
  ['横梁A', 24.2, -2.13, Math.PI, 17, 7, 3.1, 1.5, 1.2],
  ['横梁B', 24.2, 0.97, Math.PI, 17, 7, 3.1, 1.5, 1.2],
  ['东侧A', 53.31, 3.95, Math.PI / 2, 14, 7, 2.5, 1.5, 1.1],
  ['东侧B', 50.72, 3.95, Math.PI / 2, 14, 7, 2.5, 1.5, 1.1],
].map(([name, tx, tz, rotY, cols, layers, L, H, W]) => ({
  name, cols, layers, L, H, W,
  world: Matrix.Compose(Vector3.One(), Quaternion.RotationAxis(AXIS_Y, rotY), new Vector3(tx, 0, tz)),
}));

const camera = new ArcRotateCamera('cam', 0, Math.PI / 4, 30, Vector3.Zero(), scene);
camera.minZ = 0.1;

// —— 与 SceneRuntime.pickBuiltInSlotCellAtCanvasPoint 同源 ——
function resolveCell(px, py) {
  const ray = scene.createPickingRay(px, py, Matrix.Identity(), camera);
  let best = null, bestDistance = Infinity;
  for (const rack of RACKS) {
    const inverseWorld = Matrix.Invert(rack.world); // invert() 原地修改会污染 rack.world（循环复用）
    const origin = Vector3.TransformCoordinates(ray.origin, inverseWorld);
    const direction = Vector3.TransformNormal(ray.direction, inverseWorld);
    const { L, H, W, cols, layers } = rack;
    const minX = -L / 2, maxX = (cols - 1) * L + L / 2;
    const minY = 0, maxY = (layers - 1) * H + H, minZ = -W / 2, maxZ = W / 2;
    const slabs = [
      { o: origin.x, d: direction.x, min: minX, max: maxX, axis: 'x' },
      { o: origin.y, d: direction.y, min: minY, max: maxY, axis: 'y' },
      { o: origin.z, d: direction.z, min: minZ, max: maxZ, axis: 'z' },
    ];
    let tEnter = -Infinity, tExit = Infinity, ok = true;
    for (const s of slabs) {
      if (Math.abs(s.d) < 1e-8) { if (s.o < s.min || s.o > s.max) { ok = false; break; } continue; }
      let t0 = (s.min - s.o) / s.d, t1 = (s.max - s.o) / s.d;
      if (t0 > t1) [t0, t1] = [t1, t0];
      if (t0 > tEnter) tEnter = t0;
      tExit = Math.min(tExit, t1);
      if (tEnter > tExit) { ok = false; break; }
    }
    if (!ok || tExit <= 0) continue;
    let local, tHit;
    if (tEnter > 0) {
      local = origin.add(direction.scale(tEnter));
      tHit = tEnter;
    } else {
      const faceZ = direction.z >= 0 ? maxZ : minZ;
      if (Math.abs(direction.z) < 1e-8) continue;
      const tFace = (faceZ - origin.z) / direction.z;
      if (tFace <= 0) continue;
      local = origin.add(direction.scale(tFace));
      tHit = tFace;
    }
    const clamped = new Vector3(
      Math.min(maxX, Math.max(minX, local.x)),
      Math.min(maxY, Math.max(minY, local.y)),
      local.z,
    );
    const worldPoint = Vector3.TransformCoordinates(origin.add(direction.scale(tHit)), rack.world);
    const distance = Vector3.Distance(ray.origin, worldPoint);
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    const col = Math.min(cols - 1, Math.max(0, Math.round(clamped.x / L)));
    const layer = Math.min(layers - 1, Math.max(0, Math.round((clamped.y - H / 2) / H)));
    best = { rack, col, layer, distance };
  }
  return best;
}

function project(worldPoint) {
  const viewport = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
  const transform = camera.getViewMatrix().multiply(camera.getProjectionMatrix());
  const p = Vector3.Project(worldPoint, Matrix.IdentityReadOnly, transform, viewport);
  return { x: p.x, y: p.y };
}

// 目标：货架1 顶层中间格 (col=20, layer=6)。分别点击「顶面中心」和「前表面中心」的投影。
const rack1 = RACKS[0];
const targetTopLocal = new Vector3(20 * 1.3, 6 * 1.5 + 1.5, 0);       // 顶面中心 y=maxY
const targetFrontLocal = new Vector3(20 * 1.3, 6 * 1.5 + 0.75, 0.6);  // 前表面中心 z=+W/2
const topWorld = Vector3.TransformCoordinates(targetTopLocal, rack1.world);
const frontWorld = Vector3.TransformCoordinates(targetFrontLocal, rack1.world);
console.log('货架1 目标格(20,6) 顶面世界=', topWorld.toString(), ' 前表面世界=', frontWorld.toString());

for (const [label, point] of [['点顶面中心', topWorld], ['点前表面中心', frontWorld]]) {
  for (const betaDeg of [45, 30, 20, 12, 6]) {
    // 相机放在目标点世界位置的「南侧上方」（z 负侧 + 俯视），模拟用户近似俯视
    camera.target = point.clone();
    camera.alpha = -Math.PI / 2; // 相机在 -z 侧看向 +z
    camera.beta = betaDeg * Math.PI / 180;
    camera.radius = 25;
    camera.update();
    const p = project(point);
    const n = resolveCell(p.x, p.y);
    if (!n) { console.log(`${label} β=${betaDeg}° → null`); continue; }
    // 高亮格中心世界坐标（模拟 overlay / focus 位置）
    const hl = Vector3.TransformCoordinates(new Vector3(n.col * n.rack.L, 6 * 0 + n.layer * n.rack.H + n.rack.H / 2, 0), n.rack.world);
    const mark = (n.rack === rack1 && n.col === 20 && n.layer === 6) ? 'OK' : '错';
    console.log(`${label} β=${betaDeg}° → ${mark} ${n.rack.name} 格(${n.col},${n.layer}) 进入面=${n.enterAxis} 高亮中心=(${hl.x.toFixed(1)},${hl.y.toFixed(1)},${hl.z.toFixed(1)})`);
  }
}

// 自由视角：固定俯视角度，8 个水平方位环绕点击顶面中心 —— 视线带 x 分量时前表面交点会沿 x 飞出。
console.log('--- 8 方位扫描（点顶面中心） ---');
for (const betaDeg of [20, 10]) {
  for (let k = 0; k < 8; k += 1) {
    camera.target = topWorld.clone();
    camera.alpha = k * Math.PI / 4;
    camera.beta = betaDeg * Math.PI / 180;
    camera.radius = 25;
    camera.update();
    const p = project(topWorld);
    const n = resolveCell(p.x, p.y);
    if (!n) { console.log(`β=${betaDeg}° α=${k * 45}° → null`); continue; }
    const hl = Vector3.TransformCoordinates(new Vector3(n.col * n.rack.L, n.layer * n.rack.H + n.rack.H / 2, 0), n.rack.world);
    const mark = (n.rack === rack1 && n.col === 20 && n.layer === 6) ? 'OK' : '错';
    console.log(`β=${betaDeg}° α=${k * 45}° → ${mark} ${n.rack.name} 格(${n.col},${n.layer}) 进入面=${n.enterAxis} 高亮中心=(${hl.x.toFixed(1)},${hl.y.toFixed(1)},${hl.z.toFixed(1)})`);
  }
}
engine.dispose();
