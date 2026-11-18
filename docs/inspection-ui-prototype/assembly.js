import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector.js';
import '@babylonjs/core/Culling/ray.js';
import '@babylonjs/core/Rendering/outlineRenderer.js';

export const PARTS = [
  { key: 'drive.motor', name: '驱动电机', short: '电机', code: 'M-01', direction: '+X', distance: 1.5, status: '温度预警', fixed: false, x: 1.18, offset: [1.8, 0.28, 0], color: '#507d9c' },
  { key: 'drive.coupling', name: '弹性联轴器', short: '联轴器', code: 'C-01', direction: '+X', distance: 0.65, status: '正常', fixed: false, x: 0.25, offset: [0.7, 0, 0], color: '#9ba7b5' },
  { key: 'drive.reducer', name: '减速机总成', short: '减速机', code: 'G-01', direction: '固定', distance: 0, status: '正常', fixed: true, x: -0.65, offset: [0, 0, 0], color: '#8997a3' },
  { key: 'drive.output', name: '输出轴与法兰', short: '输出法兰', code: 'S-01', direction: '−X', distance: 1.15, status: '正常', fixed: false, x: -1.44, offset: [-1.1, 0.08, 0], color: '#c0c9d2' },
  { key: 'drive.guard', name: '上部防护罩', short: '防护罩', code: 'H-01', direction: '+Y', distance: 1.05, status: '无数据绑定', fixed: false, x: -0.65, offset: [0, 1.45, -0.08], color: '#47656d' },
  { key: 'drive.bearing', name: '前端轴承', short: '轴承', code: 'B-01', direction: '−X', distance: 0.65, status: '正常', fixed: false, x: -1.07, offset: [-0.48, 0.12, 0], color: '#87909b' },
];

export function createStage(container, { overview = false, onPick = () => {}, onReady = () => {} } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'model-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', overview ? '设备场景示意，点击输送线打开设备详情' : '可旋转的驱动总成三维示意；也可通过零件列表选择');
  container.append(canvas);
  let engine;
  try {
    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  } catch {
    container.innerHTML = '<div class="webgl-error">当前环境无法创建 WebGL 视口。仍可使用零件列表查看操作流程；这里没有切换软件渲染。</div>';
    onReady(false);
    return { setProgress() {}, setOffset() {}, select() {}, isolate() {}, labels() {}, focus() {}, reset() {}, dispose() {} };
  }
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 0);
  const camera = new ArcRotateCamera('camera', -Math.PI / 2.65, 1.13, overview ? 16 : 7.7, new Vector3(0, 0.3, 0), scene);
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = overview ? 6 : 2;
  camera.upperRadiusLimit = overview ? 28 : 15;
  camera.lowerBetaLimit = 0.15;
  camera.upperBetaLimit = Math.PI / 2.08;
  camera.wheelPrecision = 45;
  camera.panningSensibility = 80;
  camera.minZ = 0.05;
  const hemi = new HemisphericLight('soft', new Vector3(0.4, 1, 0.4), scene);
  hemi.intensity = 0.55;
  hemi.groundColor = Color3.FromHexString('#273548');
  const key = new DirectionalLight('key', new Vector3(-0.6, -1, 0.4), scene);
  key.intensity = 0.85;
  const fill = new DirectionalLight('fill', new Vector3(0.5, -0.5, -1), scene);
  fill.intensity = 0.4;
  fill.diffuse = Color3.FromHexString('#80a7b8');
  const mats = new Map();
  function material(hex, metallic = false) {
    const id = `${hex}:${metallic}`;
    if (mats.has(id)) return mats.get(id);
    const mat = new StandardMaterial(id, scene);
    mat.diffuseColor = Color3.FromHexString(hex);
    mat.specularColor = metallic ? new Color3(0.6, 0.67, 0.72) : new Color3(0.22, 0.25, 0.3);
    mat.specularPower = metallic ? 70 : 28;
    mats.set(id, mat);
    return mat;
  }
  function box(name, size, xyz, color, parent, metadata) {
    const m = MeshBuilder.CreateBox(name, { width: size[0], height: size[1], depth: size[2] }, scene);
    m.position.set(...xyz);
    m.material = material(color);
    m.parent = parent ?? null;
    m.metadata = metadata;
    return m;
  }
  function cylinder(name, diameter, length, xyz, color, parent, metadata, axis = 'x', tessellation = 48) {
    const m = MeshBuilder.CreateCylinder(name, { diameter, height: length, tessellation }, scene);
    if (axis === 'x') m.rotation.z = Math.PI / 2;
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    m.position.set(...xyz);
    m.material = material(color, true);
    m.parent = parent ?? null;
    m.metadata = metadata;
    return m;
  }
  function ring(name, diameter, thickness, xyz, color, parent, metadata, axis = 'x') {
    const m = MeshBuilder.CreateTorus(name, { diameter, thickness, tessellation: 56 }, scene);
    if (axis === 'x') m.rotation.z = Math.PI / 2;
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    m.position.set(...xyz);
    m.material = material(color, true);
    m.parent = parent ?? null;
    m.metadata = metadata;
    return m;
  }
  const roots = new Map();
  let progress = 0;
  let selected = 'drive.motor';
  let isolated = false;
  const bases = new Map();
  const offsets = new Map(PARTS.map((part) => [part.key, new Vector3(...part.offset)]));
  if (overview) {
    const ground = box('ground', [18, 0.05, 13], [0, -0.4, 0], '#182633');
    ground.isPickable = false;
    for (let i = -8; i <= 8; i++) {
      const line = box(`grid-x-${i}`, [0.012, 0.008, 13], [i, -0.366, 0], '#2b3e4d');
      line.isPickable = false;
    }
    for (let i = -6; i <= 6; i++) {
      const line = box(`grid-z-${i}`, [18, 0.008, 0.012], [0, -0.366, i], '#2b3e4d');
      line.isPickable = false;
    }
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 4; i++) {
        const x = -5 + i * 3.1;
        const z = -3.7 + row * 3.3;
        const active = row === 1 && i === 2;
        const md = active ? { device: 'CV-021' } : { device: 'other' };
        const frame = new TransformNode(`device-${row}-${i}`, scene);
        box('rail', [2.4, 0.22, 0.85], [x, 0.45, z], active ? '#297d84' : '#435d6e', frame, md);
        box('belt', [2.25, 0.06, 0.68], [x, 0.59, z], active ? '#8bb9b7' : '#738290', frame, md);
        for (const dx of [-0.85, 0.85]) {
          for (const dz of [-0.28, 0.28]) box('leg', [0.08, 0.8, 0.08], [x + dx, 0.04, z + dz], '#465867', frame, md);
        }
        for (let j = 0; j < 8; j++) cylinder('roller', 0.1, 0.64, [x - 0.95 + j * 0.27, 0.65, z], '#a2afb9', frame, md, 'z', 12);
        if (active) {
          const mark = ring('device-selection', 2.6, 0.035, [x, -0.32, z], '#51cfc0');
          mark.rotation.set(0, 0, 0);
          mark.scaling.z = 0.5;
          mark.isPickable = false;
        }
      }
    }
    camera.target.set(0, 0, 0);
    camera.alpha = -1.05;
    camera.beta = 0.9;
  } else {
    const floor = box('plinth', [6.3, 0.07, 3.1], [0, -0.61, 0], '#1f2b37');
    floor.isPickable = false;
    for (let i = -6; i <= 6; i++) {
      const line = box(`guide-${i}`, [0.008, 0.005, 3.1], [i * 0.5, -0.568, 0], '#31404d');
      line.isPickable = false;
    }
    for (const part of PARTS) {
      const root = new TransformNode(part.key, scene);
      root.position.x = part.x;
      roots.set(part.key, root);
      bases.set(part.key, root.position.clone());
      const md = { partKey: part.key };
      if (part.key === 'drive.motor') {
        cylinder('motor-shell', 0.91, 1.23, [0.1, 0, 0], part.color, root, md);
        for (let j = 0; j < 22; j++) {
          const angle = j * Math.PI * 2 / 22;
          const fin = box('cooling-fin', [1.12, 0.065, 0.13], [0.08, Math.cos(angle) * 0.47, Math.sin(angle) * 0.47], '#537c94', root, md);
          fin.rotation.x = angle;
        }
        cylinder('motor-rear', 0.96, 0.18, [0.79, 0, 0], '#3d5369', root, md);
        cylinder('motor-flange', 1.08, 0.12, [-0.59, 0, 0], '#8595a7', root, md);
        cylinder('motor-spindle', 0.19, 0.37, [-0.82, 0, 0], '#d1d9de', root, md);
        box('terminal-box', [0.46, 0.26, 0.4], [0.12, 0.57, 0], '#476f88', root, md);
        box('terminal-cover', [0.49, 0.055, 0.43], [0.12, 0.72, 0], '#6d8e9c', root, md);
        for (const dx of [-0.27, 0.48]) {
          box('motor-foot', [0.29, 0.11, 1.02], [dx, -0.49, 0], '#657d8b', root, md);
          for (const dz of [-0.42, 0.42]) cylinder('foot-bolt', 0.08, 0.1, [dx, -0.4, dz], '#c6ced3', root, md, 'y', 6);
        }
        for (let j = 0; j < 8; j++) {
          const a = j * Math.PI / 4;
          cylinder('flange-bolt', 0.07, 0.08, [-0.68, Math.sin(a) * 0.43, Math.cos(a) * 0.43], '#d5dce0', root, md, 'x', 6);
        }
      } else if (part.key === 'drive.reducer') {
        box('gearbox', [0.77, 0.77, 0.83], [0, -0.02, 0], '#627d8a', root, md);
        cylinder('front-face', 0.75, 0.1, [-0.44, 0.05, 0], '#7e909f', root, md);
        cylinder('back-face', 0.66, 0.14, [0.44, 0.05, 0], '#a5b3bd', root, md);
        for (let j = 0; j < 6; j++) box('gearbox-rib', [0.8, 0.065, 0.045], [0, -0.31 + j * 0.11, 0.442], '#95a2ab', root, md);
        for (const dx of [-0.3, 0.3]) {
          for (const dz of [-0.33, 0.33]) cylinder('gearbox-bolt', 0.06, 0.08, [dx, 0.41, dz], '#c8d2d7', root, md, 'y', 6);
        }
        box('gearbox-base', [1.0, 0.1, 1.06], [0, -0.49, 0], '#7e939f', root, md);
      } else if (part.key === 'drive.coupling') {
        cylinder('coupling-left', 0.48, 0.2, [-0.12, 0, 0], '#c9d4dd', root, md);
        cylinder('coupling-rubber', 0.44, 0.1, [0.04, 0, 0], '#243648', root, md);
        cylinder('coupling-right', 0.48, 0.2, [0.18, 0, 0], '#99adbc', root, md);
        for (let j = 0; j < 6; j++) {
          const a = j * Math.PI / 3;
          cylinder('coupling-screw', 0.055, 0.03, [0.3, Math.cos(a) * 0.17, Math.sin(a) * 0.17], '#e1e6e9', root, md, 'x', 6);
        }
      } else if (part.key === 'drive.output') {
        cylinder('output-shaft', 0.23, 0.8, [-0.15, 0.05, 0], '#c5d2db', root, md);
        cylinder('output-flange', 0.79, 0.12, [0.1, 0.05, 0], '#a9bbc8', root, md);
        for (let j = 0; j < 6; j++) {
          const a = j * Math.PI / 3;
          cylinder('output-bolt', 0.07, 0.07, [0.01, 0.05 + Math.sin(a) * 0.3, Math.cos(a) * 0.3], '#536d80', root, md, 'x', 6);
        }
        box('shaft-key', [0.4, 0.045, 0.07], [-0.3, 0.18, 0], '#e3e8eb', root, md);
      } else if (part.key === 'drive.guard') {
        box('cover-top', [0.9, 0.06, 0.95], [0, 0.48, 0], '#456471', root, md);
        for (const z of [-0.45, 0.45]) box('cover-side', [0.9, 0.25, 0.05], [0, 0.35, z], '#4d7180', root, md);
        for (const dx of [-0.34, 0.34]) {
          for (const dz of [-0.34, 0.34]) cylinder('cover-screw', 0.055, 0.045, [dx, 0.53, dz], '#b2c3cf', root, md, 'y', 6);
        }
      } else {
        ring('bearing-race', 0.52, 0.08, [-0.04, 0.05, 0], '#bdc9d4', root, md);
        ring('bearing-inner', 0.3, 0.055, [-0.04, 0.05, 0], '#62788e', root, md);
        for (let j = 0; j < 12; j++) {
          const a = j * Math.PI / 6;
          const ball = MeshBuilder.CreateSphere('bearing-ball', { diameter: 0.07, segments: 8 }, scene);
          ball.position.set(-0.04, 0.05 + Math.sin(a) * 0.21, Math.cos(a) * 0.21);
          ball.material = material('#e0e7eb', true);
          ball.parent = root;
          ball.metadata = md;
        }
      }
    }
  }
  const lineMat = new StandardMaterial('selected-edge', scene);
  lineMat.emissiveColor = Color3.FromHexString('#5cdbc7');
  let disposed = false;
  let labelLayer;
  let showLabels = false;
  let active = true;
  function render() {
    if (active && !disposed) scene.render();
  }
  engine.runRenderLoop(render);
  const resize = new ResizeObserver(() => { if (!disposed) engine.resize(); });
  resize.observe(container);
  const visibility = () => { active = !document.hidden; };
  document.addEventListener('visibilitychange', visibility);
  scene.onPointerObservable.add((info) => {
    if (info.type !== 2) return;
    const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => mesh.isVisible && mesh.isEnabled() && mesh.isPickable && Boolean(mesh.metadata));
    const md = pick?.pickedMesh?.metadata;
    if (overview && md?.device === 'CV-021') onPick('CV-021');
    if (!overview && md?.partKey) onPick(md.partKey);
  });
  const labels = () => {
    if (!labelLayer) {
      labelLayer = document.createElement('div');
      labelLayer.className = 'model-labels';
      labelLayer.setAttribute('aria-hidden', 'true');
      container.append(labelLayer);
    }
    labelLayer.hidden = !showLabels;
    labelLayer.innerHTML = showLabels ? PARTS.filter((part) => (!isolated || part.key === selected) && (['drive.motor', 'drive.reducer', 'drive.guard'].includes(part.key) || part.key === selected)).map((part) => `<span class="model-label ${part.key === selected ? 'selected' : ''}" data-label="${part.key}">${part.code} ${part.short}</span>`).join('') : '';
  };
  const afterRender = scene.onAfterRenderObservable.add(() => {
    if (!showLabels || overview || !labelLayer) return;
    const viewport = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
    for (const part of PARTS) {
      const label = labelLayer.querySelector(`[data-label="${part.key}"]`);
      if (!label) continue;
      const root = roots.get(part.key);
      const point = Vector3.Project(root.position.add(new Vector3(0, part.key === 'drive.guard' ? 0.8 : 0.65, 0)), Matrix.Identity(), scene.getTransformMatrix(), viewport);
      const x = Math.max(48, Math.min(canvas.clientWidth - 48, point.x / engine.getRenderWidth() * canvas.clientWidth));
      const y = Math.max(20, Math.min(canvas.clientHeight - 24, point.y / engine.getRenderHeight() * canvas.clientHeight));
      label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    }
  });
  function select(partKey) {
    selected = partKey;
    if (!overview) {
      for (const part of PARTS) {
        const root = roots.get(part.key);
        const isSelected = part.key === selected;
        root.setEnabled(!isolated || isSelected);
        for (const mesh of root.getChildMeshes()) {
          mesh.renderOutline = isSelected;
          mesh.outlineColor = Color3.FromHexString('#63dfc7');
          mesh.outlineWidth = 0.012;
        }
      }
      labels();
    }
  }
  // Outline rendering is optional; the material tint and list state remain available.
  select(selected);
  scene.executeWhenReady(() => { if (!disposed) onReady(true); });
  return {
    scene,
    engine,
    setProgress(value) {
      progress = Math.max(0, Math.min(100, Number(value))) / 100;
      for (const part of PARTS) roots.get(part.key)?.position.copyFrom(bases.get(part.key).add(offsets.get(part.key).scale(progress)));
    },
    setOffset(partKey, value) { if (offsets.has(partKey)) offsets.set(partKey, new Vector3(...value)); },
    select,
    isolate(value) { isolated = value; select(selected); },
    labels(value) { showLabels = value; labels(); },
    focus(partKey = selected) {
      const root = roots.get(partKey);
      if (root) { camera.target.copyFrom(root.position); camera.radius = 3.5; }
    },
    reset() {
      camera.target.set(0, 0.3, 0);
      camera.alpha = -Math.PI / 2.65;
      camera.beta = 1.13;
      camera.radius = overview ? 16 : 7.7;
    },
    dispose() {
      disposed = true;
      resize.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      scene.onAfterRenderObservable.remove(afterRender);
      engine.stopRenderLoop(render);
      scene.dispose();
      engine.dispose();
      canvas.remove();
      labelLayer?.remove();
    },
  };
}
