import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js';
import { Scene } from '@babylonjs/core/scene.js';
import type { OpeningEnvironmentSnapshot } from '../../shared/opening/OpeningEnvironmentSnapshot';
import type { OpeningPackageStage, OpeningScalar } from '../../shared/opening/openingPackage';
import type { OpeningControlledVisual, OpeningVisualControls, OpeningVisualRenderContext } from './TimelineOpeningVisual';
import { resolveOpeningStage } from './openingPackageTimeline';
import { getPrismaticOpeningState } from './prismaticOpeningMath';
import './prismaticOpening.css';

const vertexSource = `precision highp float;
attribute vec3 position;
uniform mat4 world, worldViewProjection;
varying vec3 vPosition;
void main() { vPosition = (world * vec4(position, 1.)).xyz; gl_Position = worldViewProjection * vec4(position, 1.); }`;
const fragmentSource = `precision highp float;
varying vec3 vPosition;
uniform vec3 cyan, magenta, gold;
uniform float reveal, height, time, wire, core;
void main() {
  float ceiling = .42 + height * reveal;
  if (core < .5 && (reveal < .001 || vPosition.y > ceiling)) discard;
  vec3 tint = mix(gold, magenta, smoothstep(-5., 0., vPosition.x));
  tint = mix(tint, cyan, smoothstep(0., 5., vPosition.x));
  float scan = exp(-abs(vPosition.y - ceiling) * 20.) * (1. - step(.999, reveal));
  float lattice = pow(max(0., cos(vPosition.y * 20.)), 24.) * .07;
  if (core > .5) {
    tint = mix(cyan, magenta, .5 + .5 * sin(vPosition.x * 1.4 + vPosition.y * 1.8 + time));
    lattice = pow(max(0., cos(vPosition.x * 5. + vPosition.y * 4. + time)), 20.);
  }
  gl_FragColor = vec4(tint * (.025 + wire * 1.25 + lattice + scan * 2. + core * .38), 1.);
}`;

/** 仅使用 CPU 几何快照；所有相机、材质和 GPU 资源都归独立开场画布所有。 */
export function createPrismaticOpeningVisual(container: HTMLElement, options: {
  stages: readonly OpeningPackageStage[]; values: Record<string, OpeningScalar>; environment: OpeningEnvironmentSnapshot;
  allowSkip: boolean; reducedMotion: boolean; controls: OpeningVisualControls;
}): OpeningControlledVisual {
  const { environment, values } = options;
  if (!environment.parts.length) throw new Error('场景环境模型没有可绘制的几何，请等待环境加载完成。');
  const stages = options.stages.map(stage => resolveOpeningStage(stage, values));
  const highQuality = values.quality !== 'low';
  const colors = ['accentCyan', 'accentMagenta', 'accentGold'].map((key, i) => Color3.FromHexString(
    typeof values[key] === 'string' && /^#[\da-f]{6}$/i.test(values[key] as string)
      ? values[key] as string : ['#40e9ff', '#ff43d7', '#ffc55e'][i]));
  const wrapper = document.createElement('div'); wrapper.className = 'prismatic-opening'; wrapper.tabIndex = 0;
  wrapper.setAttribute('aria-label', '棱镜创生开场动画'); container.appendChild(wrapper);
  const artboard = document.createElement('div'); artboard.className = 'prismatic-artboard'; wrapper.appendChild(artboard);
  const canvas = document.createElement('canvas'); canvas.className = 'prismatic-world'; canvas.setAttribute('aria-hidden', 'true'); artboard.appendChild(canvas);
  const effects = document.createElement('canvas'); effects.className = 'prismatic-atmosphere'; effects.setAttribute('aria-hidden', 'true'); artboard.appendChild(effects);
  const ctx = effects.getContext('2d');
  if (!ctx) { wrapper.remove(); throw new Error('当前设备无法绘制开场数据隧道。'); }
  const brand = document.createElement('div'); brand.className = 'prismatic-brand';
  const emblem = document.createElement('span'); emblem.textContent = '◇';
  const brandText = document.createElement('div'); brandText.textContent = String(values.brandName ?? '中鼎智能');
  const brandCaption = document.createElement('small'); brandCaption.textContent = 'DIGITAL TWIN · PRISMATIC GENESIS';
  brandText.appendChild(brandCaption); brand.append(emblem, brandText); artboard.appendChild(brand);
  const edition = document.createElement('div'); edition.className = 'prismatic-edition'; edition.textContent = 'PRISMATIC GENESIS\n场景环境 · 实时构建'; artboard.appendChild(edition);
  const heading = document.createElement('div'); heading.className = 'prismatic-heading';
  const chapter = document.createElement('small'), title = document.createElement('h2'), subtitle = document.createElement('p');
  heading.append(chapter, title, subtitle); artboard.appendChild(heading);
  const percentage = document.createElement('div'); percentage.className = 'prismatic-percentage'; artboard.appendChild(percentage);
  const cards = document.createElement('div'); cards.className = 'prismatic-cards'; artboard.appendChild(cards);
  const size = Vector3.FromArray([environment.bounds.maximum.x - environment.bounds.minimum.x,
    environment.bounds.maximum.y - environment.bounds.minimum.y, environment.bounds.maximum.z - environment.bounds.minimum.z]);
  const card = (label: string, rows: string[]) => {
    const element = document.createElement('section'); const h = document.createElement('h3'); h.textContent = label; element.appendChild(h);
    rows.forEach(row => { const p = document.createElement('p'); p.textContent = row; element.appendChild(p); }); cards.appendChild(element);
  };
  card('空间概览', [`${size.x.toFixed(1)} m`, `长度 · ${size.z.toFixed(1)} m 宽度`, `${size.y.toFixed(1)} m 高度`, '来源 / 当前场景环境']);
  card('场景连接', ['环境已就绪', '实际模型 · 霓虹呈现', '空间结构已构建', '准备进入数字孪生']);
  const controls = document.createElement('div'); controls.className = 'prismatic-controls'; wrapper.appendChild(controls);
  controls.hidden = values.showUI === false;
  const listeners: (() => void)[] = [];
  const listen = (element: EventTarget, type: string, callback: EventListener) => {
    element.addEventListener(type, callback); listeners.push(() => element.removeEventListener(type, callback));
  };
  const button = (label: string, action: () => void) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; listen(b, 'click', action); controls.appendChild(b); return b;
  };
  const play = button('暂停', options.controls.onPauseToggle); button('重播', options.controls.onRestart);
  const progress = document.createElement('input'); progress.type = 'range'; progress.min = '0'; progress.step = '.01';
  progress.setAttribute('aria-label', '开场播放进度'); progress.disabled = !options.allowSkip; controls.appendChild(progress);
  listen(progress, 'input', () => options.controls.onSeek(Number(progress.value)));
  const readout = document.createElement('span'); controls.appendChild(readout);
  if (options.allowSkip) button('进入场景', options.controls.onSkip);
  listen(wrapper, 'keydown', event => {
    const key = event as KeyboardEvent;
    if ((key.target as HTMLElement)?.tagName === 'INPUT') return;
    if (key.key === ' ') { key.preventDefault(); key.stopPropagation(); options.controls.onPauseToggle(); }
    if (key.key === 'Escape' && options.allowSkip) { key.preventDefault(); key.stopPropagation(); options.controls.onSkip(); }
  });

  let engine: Engine | null = null, scene: Scene | null = null, disposed = false;
  let width = 1600, height = 900;
  let context: OpeningVisualRenderContext | null = null;
  let initializationFrame = 0;
  const dispose = () => {
    if (disposed) return; disposed = true; cancelAnimationFrame(initializationFrame);
    listeners.forEach(remove => remove());
    try { scene?.dispose(); } finally { engine?.dispose(); wrapper.remove(); effects.width = effects.height = 1; }
  };
  try {
    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, alpha: false });
    engine.setHardwareScalingLevel(1 / Math.min(highQuality ? 1.5 : 1, window.devicePixelRatio || 1));
    scene = new Scene(engine); scene.clearColor = new Color4(.006, .01, .026, 1);
    const camera = new ArcRotateCamera('prismatic-camera', -.94, 1.04, 25, new Vector3(0, 1, 0), scene);
    camera.fov = .7; camera.minZ = .05; camera.maxZ = 250; scene.activeCamera = camera;
    const emissive = (name: string, color: Color3, strength = 1) => {
      const material = new StandardMaterial(name, scene!); material.disableLighting = true;
      material.emissiveColor = color.scale(strength); material.diffuseColor = Color3.Black(); return material;
    };
    const platform = new TransformNode('prismatic-platform', scene);
    const disk = MeshBuilder.CreateCylinder('platform-base', { diameter: 15.3, height: .22, tessellation: 96 }, scene);
    disk.parent = platform; disk.position.y = .12; disk.material = emissive('platform-dark', new Color3(.012, .022, .048));
    const rings = [7.85, 7.6, 7.25, 6.7, 5.65].map((radius, i) => {
      const ring = MeshBuilder.CreateTorus(`platform-ring-${i}`, { diameter: radius * 2, thickness: i < 2 ? .045 : .022, tessellation: highQuality ? 160 : 80 }, scene!);
      ring.parent = platform; ring.position.y = .25 + i * .007; ring.material = emissive(`ring-material-${i}`, colors[i % 3], i < 2 ? 1.4 : .8); return ring;
    });
    const gridLines: Vector3[][] = [];
    for (let i = -6; i <= 6; i++) { gridLines.push([new Vector3(i, .245, -6), new Vector3(i, .245, 6)], [new Vector3(-6, .245, i), new Vector3(6, .245, i)]); }
    const grid = MeshBuilder.CreateLineSystem('platform-grid', { lines: gridLines }, scene); grid.color = colors[0].scale(.18); grid.parent = platform;
    const ticks = MeshBuilder.CreateLineSystem('platform-ticks', { lines: Array.from({ length: 120 }, (_, i) => {
      const a = i * Math.PI / 60; return [new Vector3(Math.cos(a) * 8.12, .27, Math.sin(a) * 8.12), new Vector3(Math.cos(a) * (i % 5 ? 8.2 : 8.35), .27, Math.sin(a) * (i % 5 ? 8.2 : 8.35))];
    }) }, scene); ticks.color = colors[0].scale(.6); ticks.parent = platform;

    const shader = (name: string, wire: boolean, core = false) => {
      const material = new ShaderMaterial(name, scene!, { vertexSource, fragmentSource }, {
        attributes: ['position'], uniforms: ['world', 'worldViewProjection', 'cyan', 'magenta', 'gold', 'reveal', 'height', 'time', 'wire', 'core'],
      });
      material.backFaceCulling = false; material.wireframe = wire; material.setColor3('cyan', colors[0]);
      material.setColor3('magenta', colors[1]); material.setColor3('gold', colors[2]);
      material.setFloat('wire', wire ? 1 : 0); material.setFloat('core', core ? 1 : 0);
      material.setFloat('time', 0); material.setFloat('reveal', 0); material.setFloat('height', 1);
      if (wire) material.zOffset = -1;
      return material;
    };
    const bodyMaterial = shader('environment-surface', false), wireMaterial = shader('environment-neon', true);
    const longest = Math.max(size.x, size.y, size.z, .001), scale = 11.8 / longest;
    const center = new Vector3((environment.bounds.maximum.x + environment.bounds.minimum.x) / 2, environment.bounds.minimum.y,
      (environment.bounds.maximum.z + environment.bounds.minimum.z) / 2);
    const normalization = Matrix.Translation(-center.x, -center.y, -center.z).multiply(Matrix.Scaling(scale, scale, scale)).multiply(Matrix.Translation(0, .42, 0));
    const geometry = new Map<string, Mesh>();
    const models: Mesh[] = [];
    for (const part of environment.parts) {
      const mesh = new Mesh(`environment-${part.name}`, scene);
      const source = geometry.get(part.sourceMeshId);
      if (source?.geometry) source.geometry.applyToMesh(mesh);
      else {
        mesh.setVerticesData(VertexBuffer.PositionKind, part.positions);
        if (part.indices) mesh.setIndices(part.indices); else mesh.isUnIndexed = true;
        geometry.set(part.sourceMeshId, mesh);
      }
      mesh.isUnIndexed = part.indices === null;
      mesh.material = bodyMaterial; mesh.isPickable = false;
      const world = Matrix.FromArray(part.worldMatrix).multiply(normalization); mesh.freezeWorldMatrix(world);
      const wire = new Mesh(`environment-wire-${part.name}`, scene); mesh.geometry!.applyToMesh(wire);
      wire.isUnIndexed = mesh.isUnIndexed; wire.material = wireMaterial; wire.isPickable = false; wire.freezeWorldMatrix(world);
      models.push(mesh, wire);
    }
    const modelHeight = Math.max(.02, size.y * scale);
    bodyMaterial.setFloat('height', modelHeight); wireMaterial.setFloat('height', modelHeight);
    const coreRoot = new TransformNode('energy-core', scene); coreRoot.position.y = 2.75;
    const crystal = MeshBuilder.CreatePolyhedron('prismatic-crystal', { type: 2, size: 1.7 }, scene); crystal.parent = coreRoot;
    const crystalMaterial = shader('core-surface', false, true); crystal.material = crystalMaterial;
    const crystalWire = MeshBuilder.CreatePolyhedron('prismatic-crystal-wire', { type: 2, size: 1.72 }, scene); crystalWire.parent = coreRoot;
    crystalWire.material = emissive('crystal-edges', colors[0], 1.6); crystalWire.material.wireframe = true;
    const orbits = [0, 1, 2, 3, 4].map(i => {
      const ring = MeshBuilder.CreateTorus(`core-orbit-${i}`, { diameter: 5.6 + i * .45, thickness: .015 + i * .002, tessellation: 120 }, scene!);
      ring.parent = coreRoot; ring.rotation.set(.4 + i * .6, i * .8, .7 + i * .5); ring.material = emissive(`orbit-color-${i}`, colors[i % 3], 1.5); return ring;
    });
    const particles = new Mesh('prismatic-data-particles', scene);
    const particlePositions = new Float32Array((highQuality ? 1500 : 650) * 3);
    // 固定种子让重播和寻帧可复现，不随刷新随机换一座星空。
    for (let i = 0; i < particlePositions.length / 3; i++) {
      const a = i * 2.399963, r = 4.5 + ((i * 73) % 997) / 997 * 15;
      particlePositions.set([Math.cos(a) * r, .8 + ((i * 113) % 991) / 991 * 14, Math.sin(a) * r], i * 3);
    }
    particles.setVerticesData(VertexBuffer.PositionKind, particlePositions); particles.isUnIndexed = true;
    const pointMaterial = emissive('particle-color', colors[0], .7); pointMaterial.pointsCloud = true; pointMaterial.pointSize = highQuality ? 2 : 1.5; particles.material = pointMaterial;
    if (highQuality) {
      const pipeline = new DefaultRenderingPipeline('prismatic-bloom', true, scene, [camera]);
      pipeline.imageProcessingEnabled = false; pipeline.bloomEnabled = true; pipeline.bloomThreshold = .25;
      pipeline.bloomWeight = .75; pipeline.bloomKernel = 96; pipeline.bloomScale = .5; pipeline.fxaaEnabled = true;
    }

    function atmosphere(state: ReturnType<typeof getPrismaticOpeningState>) {
      const c = ctx!; c.clearRect(0, 0, width, height);
      const sx = width / 1600, sy = height / 900, t = state.visualSeconds;
      c.save(); c.scale(sx, sy);
      const halo = c.createRadialGradient(800, 270, 20, 800, 310, 620);
      halo.addColorStop(0, '#9e20f912'); halo.addColorStop(.5, '#5124900d'); halo.addColorStop(1, '#05091800');
      c.fillStyle = halo; c.fillRect(0, 0, 1600, 900);
      c.globalCompositeOperation = 'lighter';
      if (state.phase === 'tunnel') {
        c.fillStyle = '#040617'; c.fillRect(0, 0, 1600, 900);
        const cx = 800, cy = 465, travel = state.progress;
        for (let i = 0; i < (highQuality ? 280 : 140); i++) {
          const a = i * 2.399963 + travel * .7, depth = ((i * .618034 + travel * 2.8) % 1);
          const r = 32 + depth * depth * 1040;
          c.strokeStyle = colors[i % 3].toHexString(); c.lineWidth = .6 + depth * 1.8; c.globalAlpha = .15 + depth * .65;
          c.beginPath(); c.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r * .8);
          c.lineTo(cx + Math.cos(a) * (r + 25 + depth * 220), cy + Math.sin(a) * (r + 25 + depth * 220) * .8); c.stroke();
        }
        for (let i = 0; i < 16; i++) {
          const z = ((i / 16 + travel * .9) % 1), r = 22 + z * z * 960;
          c.strokeStyle = colors[i % 3].toHexString(); c.globalAlpha = (1 - z) * .6; c.lineWidth = 1;
          c.beginPath(); c.ellipse(cx, cy, r, r * .8, travel * .35, 0, Math.PI * 2); c.stroke();
        }
        c.globalAlpha = 1;
        const flash = c.createRadialGradient(cx, cy, 0, cx, cy, 120); flash.addColorStop(0, '#ffffff'); flash.addColorStop(.2, '#ffcfff99'); flash.addColorStop(1, '#cd66ff00');
        c.fillStyle = flash; c.fillRect(cx - 120, cy - 120, 240, 240);
      } else if (state.phase === 'assembly' && !options.reducedMotion) {
        for (let i = 0; i < 70; i++) {
          const x = 500 + ((i * 73) % 610), drift = (t * .22 + i * .137) % 1;
          c.strokeStyle = colors[i % 3].toHexString(); c.globalAlpha = Math.sin(drift * Math.PI) * .45 * (1 - state.reveal);
          c.beginPath(); c.moveTo(x, 140 + drift * 270); c.lineTo(x, 170 + drift * 270); c.stroke();
        }
      }
      c.restore();
    }
    function draw() {
      if (!context || disposed) return;
      const state = getPrismaticOpeningState(context.elapsedSeconds, stages, options.reducedMotion);
      const t = state.visualSeconds, core = state.phase === 'core', tunnel = state.phase === 'tunnel';
      coreRoot.setEnabled(core); coreRoot.scaling.setAll(state.coreScale);
      coreRoot.rotation.set(t * .12, t * .26, Math.sin(t * .5) * .1);
      crystalMaterial.setFloat('time', t);
      orbits.forEach((ring, i) => { ring.rotation.y = i * .8 + t * (.12 + i * .04); });
      models.forEach(mesh => mesh.setEnabled(!core && !tunnel));
      bodyMaterial.setFloat('reveal', state.reveal); wireMaterial.setFloat('reveal', state.reveal);
      bodyMaterial.setFloat('time', t); wireMaterial.setFloat('time', t);
      platform.setEnabled(!tunnel); platform.scaling.setAll(core ? .65 : 1);
      rings.forEach((ring, i) => { ring.scaling.setAll(1 + Math.sin(t * 1.2 + i) * .003); });
      particles.rotation.y = t * .015; particles.position.y = state.phase === 'assembly' ? -(state.progress * 2) : 0;
      camera.alpha = core ? -.94 + t * .035 : state.orbit; camera.beta = core ? 1.04 : .94;
      camera.target.set(0, core ? 2 : .42 + modelHeight * .32, 0);
      const aspect = Math.max(.1, width / height), horizontalFov = Math.atan(Math.tan(camera.fov / 2) * aspect);
      const boundRadius = core ? 6 : Math.hypot(8.4, modelHeight * .5);
      camera.radius = boundRadius / Math.sin(Math.min(camera.fov / 2, horizontalFov)) * 1.06;
      scene!.render(); atmosphere(state);
      wrapper.style.opacity = String(context.opacity); artboard.dataset.phase = state.phase;
      const stage = stages[options.reducedMotion ? 3 : context.stageIndex];
      chapter.textContent = `CHAPTER / ${String((options.reducedMotion ? 3 : context.stageIndex) + 1).padStart(2, '0')}`;
      title.textContent = stage?.title ?? ''; subtitle.textContent = stage?.subtitle ?? '';
      heading.classList.toggle('is-centered', tunnel || state.phase === 'showcase');
      percentage.hidden = !core; percentage.textContent = `${Math.round(state.progress * 100)}%`;
      cards.style.opacity = state.phase === 'showcase' ? String(options.reducedMotion ? 1 : Math.min(1, state.progress * 5)) : '0';
      progress.max = String(context.totalDurationSeconds); progress.value = String(context.elapsedSeconds);
      readout.textContent = `${Math.floor(context.elapsedSeconds)} / ${Math.round(context.totalDurationSeconds)} s`;
      play.textContent = context.isPaused ? '播放' : '暂停';
    }
    function resize() {
      if (disposed) return;
      const rect = wrapper.getBoundingClientRect(); width = Math.max(1, Math.min(rect.width, rect.height * 16 / 9)); height = width * 9 / 16;
      Object.assign(artboard.style, { width: `${width}px`, height: `${height}px`, left: `${(rect.width - width) / 2}px`, top: `${(rect.height - height) / 2}px`, fontSize: `${Math.max(8, width / 100)}px` });
      effects.width = Math.round(width); effects.height = Math.round(height); engine!.resize(); draw();
    }
    resize();
    const ready = new Promise<void>((resolve, reject) => {
      // 初始化期只有有限帧用于编译材质；进入播放后统一由外层时钟调度。
      const started = performance.now();
      const prepare = () => {
        if (disposed) { resolve(); return; }
        try {
          scene!.render();
          const failed = scene!.materials.filter((m): m is ShaderMaterial => m instanceof ShaderMaterial)
            .find(m => m.getEffect()?.getCompilationError());
          if (failed) throw new Error(`棱镜开场着色器编译失败：${failed.getEffect()?.getCompilationError()}`);
          if (scene!.isReady()) { resolve(); return; }
          if (performance.now() - started > 20_000) throw new Error('棱镜开场画面准备超时。');
          initializationFrame = requestAnimationFrame(prepare);
        } catch (error) { reject(error); }
      };
      initializationFrame = requestAnimationFrame(prepare);
    });
    return { ready, renderAt(_seconds, next) { context = next; draw(); }, resize, dispose };
  } catch (error) { dispose(); throw error; }
}
