import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Scene } from '@babylonjs/core/scene';
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import type { Observer } from '@babylonjs/core/Misc/observable';
import { SCENE_OPENING_MAX_DESTINATIONS, type SceneOpeningAnimationSettings, type SceneOpeningDestination } from '../../editor/model/sceneOpeningAnimation';
import { clamp01, getRoutePoint, projectGeographicPoint, smooth } from './geographicOpeningMath';
import { flightWindowOpacity, layoutFlightLabels, resolveFlightWindow, wrapFlightLabel, type FlightWindowOptions } from './geographicOpeningFlightsLayout';
import { normalizeOpeningBreathingPeriod, readOpeningBreathing } from './geographicOpeningBreathing';

export type GeographicOpeningFlightOptions = FlightWindowOptions & {
  destinations?: readonly SceneOpeningDestination[];
  referenceViewHeight?: number;
  namePrefix?: string;
  showOrigin?: boolean;
  showLabels?: boolean;
  animateBreathing?: boolean;
};

type FlightVisual = {
  arc: Mesh;
  trail: LinesMesh;
  trailPositions: Float32Array;
  trailColors: Float32Array;
  samples: Float32Array;
  head: Mesh;
  headCore: Mesh;
  endpoint: Mesh;
  delay: number;
  breathingPhase: number;
};

type FlightLabelVisual = {
  index: number;
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  mesh: Mesh;
  guide: LinesMesh;
  guidePositions: Float32Array;
};

const PATH_SEGMENTS = 96;
const TRAIL_POINTS = 28;
const REFERENCE_VIEW_HEIGHT = 1.9;

/**
 * 金白飞线与蓝青落点独立于底图；沿用同一经纬投影，地图中心经度变化时无需维护第二套坐标。
 * 发光贴片、航线与顶点缓冲只创建一次，每帧仅更新位置、透明度和缩放。
 */
export function createGeographicOpeningFlights(scene: Scene, settings: SceneOpeningAnimationSettings, options: GeographicOpeningFlightOptions = {}): {
  update(time: number, opacity: number, viewHeight: number, breathingTimeSeconds?: number): void;
  dispose(): void;
} {
  const meshes: Mesh[] = [];
  const materials: StandardMaterial[] = [];
  const textures: DynamicTexture[] = [];
  const flights: FlightVisual[] = [];
  const labels: FlightLabelVisual[] = [];
  const window = resolveFlightWindow(options);
  const showOrigin = options.showOrigin !== false;
  const showLabels = options.showLabels === true;
  const animateBreathing = options.animateBreathing !== false && settings.motionPreference !== 'reduced';
  const breathingIntensity = animateBreathing && settings.breathingEnabled
    ? clamp01(Number.isFinite(settings.breathingIntensity) ? settings.breathingIntensity : 0) : 0;
  const breathingPeriod = normalizeOpeningBreathingPeriod(settings.breathingPeriodSeconds);
  const destinations = options.destinations ?? settings.destinations;
  const prefix = options.namePrefix?.trim() || 'opening-flight';
  const resourceName = (name: string) => `${prefix}-${name}`;
  const referenceViewHeight = Number.isFinite(options.referenceViewHeight) && options.referenceViewHeight! > 0
    ? options.referenceViewHeight! : REFERENCE_VIEW_HEIGHT;
  // 国内构图更近，先缩小基准几何再按相机变化缩放，避免沪杭落点膨胀为大光团。
  const geometryScale = referenceViewHeight / REFERENCE_VIEW_HEIGHT;
  const flightGeometryScale = geometryScale * (showLabels ? 0.72 : 1);
  const trailAlphas = Float32Array.from({ length: TRAIL_POINTS }, (_, step) => Math.pow(step / (TRAIL_POINTS - 1), 1.8));
  let disposeObserver: Observer<Scene> | null = null;
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (disposeObserver) scene.onDisposeObservable.remove(disposeObserver);
    disposeObserver = null;
    for (const mesh of meshes) if (!mesh.isDisposed()) mesh.dispose(false, false);
    for (const material of materials) material.dispose(false, false);
    for (const texture of textures) texture.dispose();
    flights.length = labels.length = meshes.length = materials.length = textures.length = 0;
  };

  const material = (name: string, color: string): StandardMaterial => {
    const result = new StandardMaterial(resourceName(name), scene);
    materials.push(result);
    result.disableLighting = true;
    result.emissiveColor = Color3.FromHexString(color);
    result.diffuseColor = Color3.Black();
    result.specularColor = Color3.Black();
    result.backFaceCulling = false;
    result.disableDepthWrite = true;
    result.transparencyMode = Material.MATERIAL_ALPHABLEND;
    return result;
  };

  const prepareMesh = <T extends Mesh>(mesh: T): T => {
    meshes.push(mesh);
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.renderingGroupId = 1;
    mesh.setEnabled(false);
    return mesh;
  };

  const spriteMaterial = (name: string, kind: 'origin' | 'endpoint' | 'comet' | 'pulse'): StandardMaterial => {
    const size = kind === 'origin' ? 512 : 256;
    const texture = new DynamicTexture(resourceName(`${name}-texture`), { width: size, height: size }, scene, false);
    textures.push(texture);
    texture.hasAlpha = true;
    texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    const context = texture.getContext() as CanvasRenderingContext2D;
    const center = size / 2;
    const radius = size * 0.46;
    context.clearRect(0, 0, size, size);
    if (kind !== 'pulse') {
      const glow = context.createRadialGradient(center, center, 0, center, center, radius);
      glow.addColorStop(0, '#ffffff');
      glow.addColorStop(kind === 'origin' ? 0.09 : 0.07, kind === 'comet' ? '#fffce5' : '#efffff');
      glow.addColorStop(0.16, kind === 'comet' ? 'rgba(255,234,166,0.97)' : 'rgba(150,244,255,0.98)');
      glow.addColorStop(0.30, kind === 'comet' ? 'rgba(255,198,94,0.47)' : 'rgba(28,184,255,0.6)');
      glow.addColorStop(0.58, kind === 'comet' ? 'rgba(249,165,53,0.09)' : 'rgba(0,108,245,0.17)');
      glow.addColorStop(1, 'rgba(0,42,128,0)');
      context.fillStyle = glow;
      context.fillRect(0, 0, size, size);
    }
    if (kind !== 'comet') {
      const circles = kind === 'pulse' ? [0.76] : kind === 'origin' ? [0.25, 0.40, 0.60, 0.78] : [0.30, 0.49, 0.69];
      circles.forEach((fraction, index) => {
        context.beginPath();
        context.arc(center, center, radius * fraction, 0, Math.PI * 2);
        context.strokeStyle = index === 0 ? 'rgba(206,255,255,0.95)' : `rgba(64,195,255,${0.60 - index * 0.11})`;
        context.shadowColor = '#27baff';
        context.shadowBlur = size / 32;
        context.lineWidth = kind === 'origin' ? 2.6 - index * 0.35 : 1.3;
        context.stroke();
      });
    }
    if (kind === 'origin' || kind === 'comet') {
      // 十字微光让白核呈现参考图的摄影辉光；保留透明背景，不遮挡底图。
      context.shadowBlur = size / 40;
      context.shadowColor = kind === 'comet' ? '#fff0ba' : '#9df7ff';
      for (const horizontal of [true, false]) {
        const length = radius * (horizontal ? 0.66 : 0.48);
        const beam = horizontal
          ? context.createLinearGradient(center - length, center, center + length, center)
          : context.createLinearGradient(center, center - length, center, center + length);
        beam.addColorStop(0, 'rgba(255,255,230,0)');
        beam.addColorStop(0.46, 'rgba(255,255,241,0.5)');
        beam.addColorStop(0.5, '#ffffff');
        beam.addColorStop(0.54, 'rgba(255,255,241,0.5)');
        beam.addColorStop(1, 'rgba(255,255,230,0)');
        context.fillStyle = beam;
        if (horizontal) context.fillRect(center - length, center - 0.65, length * 2, 1.3);
        else context.fillRect(center - 0.65, center - length, 1.3, length * 2);
      }
    }
    texture.update(false);
    const result = material(name, '#ffffff');
    result.diffuseTexture = texture;
    result.emissiveTexture = texture;
    result.useAlphaFromDiffuseTexture = true;
    return result;
  };

  const sprite = (name: string, width: number, spriteSurface: StandardMaterial): Mesh => {
    const mesh = prepareMesh(MeshBuilder.CreatePlane(resourceName(name), { width, height: width }, scene));
    mesh.material = spriteSurface;
    return mesh;
  };

  try {
    // 空国内列表保持为空，不创建隐藏的默认航线、文字或第二个惠山标记。
    if (!showOrigin && destinations.length === 0) return { update: () => {}, dispose };
    const arcMaterial = material('gold-arc', '#f8dc97');
    const coreMaterial = material('white-core', '#fffce9');
    const originMaterial = showOrigin ? spriteMaterial('origin-halo', 'origin') : null;
    const endpointMaterial = spriteMaterial('endpoint-halo', 'endpoint');
    const cometMaterial = spriteMaterial('comet-halo', 'comet');
    const pulseMaterial = showOrigin && breathingIntensity > 0 ? spriteMaterial('pulse-ring', 'pulse') : null;
    const origin: [number, number] = [settings.destination.longitude, settings.destination.latitude];
    const originPoint = projectGeographicPoint(...origin, 1);
    const originHalo = originMaterial ? sprite('origin', 0.48 * geometryScale, originMaterial) : null;
    originHalo?.position.set(originPoint[0], originPoint[1], -0.115);
    const originCore = showOrigin ? prepareMesh(MeshBuilder.CreateSphere(resourceName('origin-white-core'), { diameter: 0.025 * geometryScale, segments: 8 }, scene)) : null;
    if (originCore) { originCore.position.set(originPoint[0], originPoint[1], -0.13); originCore.material = coreMaterial; }
    const pulses = pulseMaterial ? [0, 1, 2].map(index => {
      const pulse = sprite(`origin-pulse-${index}`, 0.46 * geometryScale, pulseMaterial);
      pulse.position.set(originPoint[0], originPoint[1], -0.10 - index * 0.001);
      return pulse;
    }) : [];

    const createLabel = (destination: SceneOpeningDestination, index: number, anchor: Vector3): void => {
      const lines = wrapFlightLabel(destination.name);
      const textureHeight = lines.length * 56 + 24;
      const texture = new DynamicTexture(resourceName(`label-${index}-texture`), { width: 512, height: textureHeight }, scene, false);
      textures.push(texture);
      let context = texture.getContext() as CanvasRenderingContext2D;
      const font = '600 42px "Microsoft YaHei", sans-serif';
      context.font = font;
      const textureWidth = Math.max(112, Math.ceil(Math.max(...lines.map(line => context.measureText(line).width)) + 32));
      texture.scaleTo(textureWidth, textureHeight);
      context = texture.getContext() as CanvasRenderingContext2D;
      context.clearRect(0, 0, textureWidth, textureHeight);
      context.fillStyle = 'rgba(2,13,26,0.84)'; context.fillRect(0, 0, textureWidth, textureHeight);
      context.strokeStyle = 'rgba(64,176,218,0.65)'; context.lineWidth = 1.5;
      context.strokeRect(1, 1, textureWidth - 2, textureHeight - 2);
      context.font = font; context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillStyle = '#ddf6ff';
      lines.forEach((line, lineIndex) => context.fillText(line, textureWidth / 2, 12 + lineIndex * 56 + 28));
      // 文字具有方向性，Canvas 左上原点需翻转到 Babylon 平面的 UV 方向。
      texture.hasAlpha = true; texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE; texture.update(true);
      const surface = material(`label-${index}-material`, '#ffffff');
      surface.diffuseTexture = surface.emissiveTexture = texture; surface.useAlphaFromDiffuseTexture = true;
      const height = referenceViewHeight * 0.078 * textureHeight / 80;
      const width = height * textureWidth / textureHeight;
      const mesh = prepareMesh(MeshBuilder.CreatePlane(resourceName(`label-${index}`), { width, height }, scene));
      mesh.material = surface; mesh.alphaIndex = 10;
      mesh.metadata = { openingRegionName: destination.name, openingCoordinateKind: 'schematic' };
      const guide = prepareMesh(MeshBuilder.CreateLines(resourceName(`label-guide-${index}`), {
        points: [anchor.clone(), anchor.clone(), anchor.clone()], updatable: true,
      }, scene));
      guide.color = Color3.FromHexString('#7bcde9'); guide.alphaIndex = 5;
      labels.push({ index, anchorX: anchor.x, anchorY: anchor.y, width, height, mesh, guide, guidePositions: new Float32Array(9) });
    };

    destinations.slice(0, SCENE_OPENING_MAX_DESTINATIONS).forEach((destination, index) => {
      const destinationPoint: [number, number] = [destination.longitude, destination.latitude];
      const points = Array.from({ length: PATH_SEGMENTS + 1 }, (_, step) => {
        const point = getRoutePoint(origin, destinationPoint, step / PATH_SEGMENTS);
        return new Vector3(point[0], point[1], point[2] - 0.055);
      });
      // 重合目的地没有可展示的弧长，避免退化 Tube 产生非法法线。
      if (Vector3.DistanceSquared(points[0], points[PATH_SEGMENTS]) < 1e-10) return;
      const samples = new Float32Array(points.length * 3);
      points.forEach((point, step) => point.toArray(samples, step * 3));
      const arc = prepareMesh(MeshBuilder.CreateTube(resourceName(`arc-${index}`), {
        path: points, radius: 0.00135 * flightGeometryScale, tessellation: 6,
      }, scene));
      arc.material = arcMaterial;
      const trailPositions = new Float32Array(TRAIL_POINTS * 3);
      const trailColors = new Float32Array(TRAIL_POINTS * 4);
      const colors = Array.from({ length: TRAIL_POINTS }, (_, step) => {
        const fraction = step / (TRAIL_POINTS - 1);
        const color = new Color4(1, 0.90 + fraction * 0.09, 0.59 + fraction * 0.32, trailAlphas[step]);
        color.toArray(trailColors, step * 4);
        return color;
      });
      const trail = prepareMesh(MeshBuilder.CreateLines(resourceName(`tail-${index}`), {
        points: Array.from({ length: TRAIL_POINTS }, () => points[0].clone()),
        colors,
        useVertexAlpha: true, updatable: true,
      }, scene));
      const head = sprite(`comet-${index}`, 0.12 * flightGeometryScale, cometMaterial);
      const headCore = prepareMesh(MeshBuilder.CreateSphere(resourceName(`comet-core-${index}`), { diameter: 0.013 * flightGeometryScale, segments: 6 }, scene));
      headCore.material = coreMaterial;
      const endpoint = sprite(`destination-${index}`, 0.19 * flightGeometryScale, endpointMaterial);
      endpoint.position.copyFrom(points[PATH_SEGMENTS]);
      endpoint.position.z = -0.09;
      if (showLabels) createLabel(destination, index, points[PATH_SEGMENTS]);
      flights.push({ arc, trail, trailPositions, trailColors, samples, head, headCore, endpoint,
        delay: (index % 8) * 0.055 + Math.floor(index / 8) * 0.035,
        breathingPhase: (0.13 + index * 0.61803398875) % 1 });
    });

    // 预采样的弧线与尾迹共用插值；不会每帧创建 Vector3、材质、纹理或 MeshBuilder 实例。
    const sampleTo = (samples: Float32Array, fraction: number, target: Float32Array, offset: number): void => {
      const location = clamp01(fraction) * PATH_SEGMENTS;
      const start = Math.min(PATH_SEGMENTS - 1, Math.floor(location));
      const mix = location - start;
      for (let axis = 0; axis < 3; axis++) {
        const a = samples[start * 3 + axis], b = samples[(start + 1) * 3 + axis];
        target[offset + axis] = a + (b - a) * mix;
      }
    };
    const headPoint = new Float32Array(3);
    let labelViewScale = Number.NaN;
    const updateLabels = (viewScale: number, alpha: number): void => {
      const visible = alpha > 0.001;
      if (visible && labels.length > 0 && (!Number.isFinite(labelViewScale) || Math.abs(labelViewScale - viewScale) > 0.001)) {
        labelViewScale = viewScale;
        const placements = layoutFlightLabels(labels.map(label => ({ index: label.index, anchorX: label.anchorX, anchorY: label.anchorY,
          width: label.width * viewScale, height: label.height * viewScale })),
        { originX: originPoint[0], originY: originPoint[1], referenceViewHeight: referenceViewHeight * viewScale });
        placements.forEach((placement, position) => {
          const label = labels[position];
          label.mesh.position.set(placement.x, placement.y, -0.155); label.mesh.scaling.setAll(viewScale);
          label.guidePositions.set([placement.anchorX, placement.anchorY, -0.14,
            placement.anchorX + (placement.edgeX - placement.anchorX) * 0.55, placement.edgeY, -0.14,
            placement.edgeX, placement.edgeY, -0.14]);
          label.guide.updateVerticesData(VertexBuffer.PositionKind, label.guidePositions, false, false);
        });
      }
      for (const label of labels) {
        label.mesh.setEnabled(visible); label.guide.setEnabled(visible);
        label.mesh.visibility = alpha; label.guide.alpha = alpha * 0.7;
      }
    };
    const update = (time: number, opacity: number, viewHeight: number, breathingTimeSeconds = time): void => {
      if (disposed) return;
      const seconds = Number.isFinite(time) ? Math.max(0, time) : 0;
      const breathingSeconds = Number.isFinite(breathingTimeSeconds) ? Math.max(0, breathingTimeSeconds) : 0;
      const alpha = Number.isFinite(opacity) ? clamp01(opacity) : 0;
      const viewScale = Math.max(0.00001, Number.isFinite(viewHeight) && viewHeight > 0 ? viewHeight / referenceViewHeight : 1);
      const originAlpha = smooth((seconds - (window.start - 0.15)) / 0.45) * alpha;
      const routesAlpha = flightWindowOpacity(time, window) * alpha;
      const originBreathing = readOpeningBreathing(breathingSeconds, settings, animateBreathing) - 1;
      if (originHalo && originCore) {
        originHalo.setEnabled(originAlpha > 0); originCore.setEnabled(originAlpha > 0);
        // 主枢纽最明显，白核只轻微变化；关闭时全部精确回到旧静态基线。
        originHalo.scaling.setAll(viewScale * (1 + originBreathing * 0.25));
        originHalo.visibility = originAlpha * clamp01(1 - breathingIntensity * 0.18 + originBreathing * 0.72);
        originCore.scaling.setAll(viewScale * (1 + originBreathing * 0.09));
        originCore.visibility = originAlpha * clamp01(1 - breathingIntensity * 0.07 + originBreathing * 0.20);
      }
      pulses.forEach((pulse, index) => {
        const progress = (breathingSeconds / breathingPeriod + index / pulses.length) % 1;
        pulse.setEnabled(originAlpha > 0 && breathingIntensity > 0);
        pulse.scaling.setAll(viewScale * (0.58 + progress * 1.12));
        pulse.visibility = originAlpha * (1 - progress) * breathingIntensity * 0.62;
      });
      // 文字和引导线只受阶段淡入淡出控制，避免可读内容随装饰光效闪烁。
      updateLabels(viewScale, routesAlpha);
      for (const flight of flights) {
        const visible = routesAlpha > 0.001;
        flight.arc.setEnabled(visible);
        flight.endpoint.setEnabled(visible);
        const travel = (seconds - window.start - flight.delay) / 1.85;
        const moving = visible && travel > 0;
        flight.trail.setEnabled(moving);
        flight.head.setEnabled(moving); flight.headCore.setEnabled(moving);
        if (!visible) continue;
        // 使用每个Mesh自己的透明度和缩放；共享材质不承载不同地点的相位。
        const endpointBreathing = readOpeningBreathing(breathingSeconds, settings, animateBreathing, flight.breathingPhase) - 1;
        const cometBreathing = readOpeningBreathing(breathingSeconds, settings, animateBreathing, flight.breathingPhase + 0.27) - 1;
        const tailBrightness = clamp01(1 - breathingIntensity * 0.04 + cometBreathing * 0.10);
        flight.arc.visibility = routesAlpha * 0.76;
        flight.endpoint.visibility = routesAlpha * clamp01(1 - breathingIntensity * 0.10 + endpointBreathing * 0.38);
        flight.endpoint.scaling.setAll(viewScale * (1 + endpointBreathing * 0.12));
        const progress = Math.max(0, travel) % 1;
        for (let step = 0; step < TRAIL_POINTS; step++) {
          sampleTo(flight.samples, progress - (1 - step / (TRAIL_POINTS - 1)) * 0.105, flight.trailPositions, step * 3);
          flight.trailColors[step * 4 + 3] = trailAlphas[step] * routesAlpha * tailBrightness;
        }
        flight.trail.updateVerticesData(VertexBuffer.PositionKind, flight.trailPositions, false, false);
        // LinesMesh 启用顶点颜色后不再使用 alpha uniform，整体淡出也必须写进顶点 alpha。
        flight.trail.updateVerticesData(VertexBuffer.ColorKind, flight.trailColors, false, false);
        sampleTo(flight.samples, progress, headPoint, 0);
        flight.head.position.set(headPoint[0], headPoint[1], headPoint[2] - 0.015);
        flight.headCore.position.set(headPoint[0], headPoint[1], headPoint[2] - 0.023);
        flight.head.scaling.setAll(viewScale * (1 + cometBreathing * 0.14));
        flight.headCore.scaling.setAll(viewScale * (1 + cometBreathing * 0.05));
        flight.head.visibility = routesAlpha * clamp01(1 - breathingIntensity * 0.08 + cometBreathing * 0.28);
        flight.headCore.visibility = routesAlpha * clamp01(1 - breathingIntensity * 0.025 + cometBreathing * 0.10);
      }
    };
    disposeObserver = scene.onDisposeObservable.addOnce(dispose);
    return { update, dispose };
  } catch (error) { dispose(); throw error; }
}
