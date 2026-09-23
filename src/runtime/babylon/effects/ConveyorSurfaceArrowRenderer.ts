import {
  AbstractMesh, Color3, Constants, Matrix, Mesh, MeshBuilder, ShaderMaterial, TransformNode, Vector3, type Scene,
} from '@babylonjs/core';
import type { ConveyorSurfaceArrowsConfig } from '../../../editor/model/conveyorSurfaceArrows';
import type { ModelRuntimeEntry } from '../SceneRuntime';
import { getModelTransformNodes, getNodeMeshes, isFiniteVector3 } from '../runtimeNodeGeometry';
import { readConveyorCargoTravelConfig } from '../telemetry/specialized/specializedModelAssets';

import { CONVEYOR_ARROW_GLSL } from './ConveyorArrowShaders';

const EPSILON = 1e-8;
const DEFAULT_SURFACE_PATTERN = /conveyor|roller|chain|rail|GT|输送|滚筒|链条|轨道/i;
const ARROW_STYLE_UNIFORMS = {
  'conveyor-direction': 0,
  'moving-double-arrow': 1,
  'pipeline-flow-arrows': 2,
  'flow-arrows': 3,
  'conveyor-arrow-single': 4,
  'conveyor-arrow-chevron': 5,
  'conveyor-arrow-segmented': 6,
  'conveyor-arrow-ribbon': 7,
  'conveyor-arrow-double': 8,
  'conveyor-arrow-speed': 9,
} as const;

const vertexSource = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main(void) {
  vUV = uv;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

const fragmentSource = `
precision highp float;
varying vec2 vUV;
uniform vec3 arrowColor;
uniform float opacity;
uniform float stripLength;
uniform float stripWidth;
uniform float arrowLength;
uniform float arrowWidth;
uniform float spacing;
uniform float phase;
uniform float direction;
uniform float arrowStyle;
uniform float breathingFactor;
${CONVEYOR_ARROW_GLSL}
float segmentDistance(vec2 point, vec2 start, vec2 end) {
  vec2 span = end - start;
  float progress = clamp(dot(point - start, span) / max(dot(span, span), 0.000001), 0.0, 1.0);
  return length(point - start - span * progress);
}
float singleChevronDistance(vec2 point) {
  float arm = segmentDistance(point, vec2(-arrowLength * 0.5, arrowWidth * 0.5), vec2(arrowLength * 0.5, 0.0));
  return arm - min(arrowLength, arrowWidth) * 0.065;
}
float doubleChevronDistance(vec2 point) {
  float trailing = segmentDistance(point, vec2(-arrowLength * 0.5, arrowWidth * 0.5), vec2(arrowLength * 0.08, 0.0));
  float leading = segmentDistance(point, vec2(-arrowLength * 0.08, arrowWidth * 0.5), vec2(arrowLength * 0.5, 0.0));
  return min(trailing, leading) - min(arrowLength, arrowWidth) * 0.06;
}
float rectangleDistance(vec2 point, vec2 center, vec2 halfSize) {
  vec2 delta = abs(point - center) - halfSize;
  return length(max(delta, 0.0)) + min(max(delta.x, delta.y), 0.0);
}
float pipelineArrowDistance(vec2 point) {
  // 对应旧管线箭头的长柄与实心三角头，不需要额外几何。
  float headStart = arrowLength * 0.03;
  float tip = arrowLength * 0.5;
  vec2 base = vec2(headStart, arrowWidth * 0.5);
  float triangle = min(segmentDistance(point, base, vec2(tip, 0.0)), segmentDistance(point, vec2(headStart, -arrowWidth * 0.5), base));
  float headWidth = arrowWidth * 0.5 * (tip - point.x) / (tip - headStart);
  bool insideHead = point.x >= headStart && point.x <= tip && point.y <= headWidth;
  float head = insideHead ? -triangle : triangle;
  float shaft = rectangleDistance(point, vec2(-arrowLength * 0.2, 0.0), vec2(arrowLength * 0.3, arrowWidth * 0.16));
  return min(head, shaft);
}
float flowArrowDistance(vec2 point) {
  // 沿用 SpatialEffects 六顶点宽带箭头的轮廓比例，保留尾部凹口，区别于细折线。
  vec2 innerCenter = vec2(arrowLength * 0.10869565, 0.0);
  vec2 outerCenter = vec2(arrowLength * 0.5, 0.0);
  vec2 innerTail = vec2(-arrowLength * 0.5, arrowWidth * 0.5);
  vec2 outerTail = vec2(-arrowLength * 0.19565217, arrowWidth * 0.5);
  float edge = min(min(segmentDistance(point, innerCenter, innerTail), segmentDistance(point, outerCenter, outerTail)), segmentDistance(point, innerTail, outerTail));
  float acrossFraction = point.y / arrowWidth;
  float innerX = arrowLength * (0.10869565 - 1.2173913 * acrossFraction);
  float outerX = arrowLength * (0.5 - 1.39130434 * acrossFraction);
  bool inside = point.y <= arrowWidth * 0.5 && point.x >= innerX && point.x <= outerX;
  return inside ? -edge : edge;
}
void main(void) {
  if (arrowStyle > 3.5) {
    vec2 uv = vec2(direction < 0.0 ? 1.0-vUV.x : vUV.x, 0.5+(vUV.y-0.5)*stripWidth/arrowWidth);
    float style = arrowStyle-4.0;
    bool repeated = (style > 0.5 && style < 2.5) || (style > 3.5 && style < 4.5);
    float count = repeated ? clamp(floor(stripLength/spacing+0.5),1.0,32.0) : 5.0;
    vec4 color = renderConveyorArrow(uv,vec2(stripLength,arrowWidth),style,count,phase,arrowColor,arrowColor,1.0,opacity*breathingFactor);
    if (color.a < 0.001) discard;
    gl_FragColor = color;
    return;
  }
  // 在米空间中绘制重复箭头；同一方向符号同时控制朝向和相位移动。
  float along = (vUV.x - 0.5) * stripLength;
  float across = abs((vUV.y - 0.5) * stripWidth);
  float x = mod(along * direction - phase + spacing * 0.5, spacing) - spacing * 0.5;
  vec2 point = vec2(x, across);
  float shapeDistance;
  if (arrowStyle < 0.5) shapeDistance = singleChevronDistance(point);
  else if (arrowStyle < 1.5) shapeDistance = doubleChevronDistance(point);
  else if (arrowStyle < 2.5) shapeDistance = pipelineArrowDistance(point);
  else shapeDistance = flowArrowDistance(point);
  float softness = min(arrowLength, arrowWidth) * 0.025;
  float core = 1.0 - smoothstep(0.0, softness, shapeDistance);
  float halo = (1.0 - smoothstep(0.0, softness * 5.0, shapeDistance)) * 0.28;
  // 呼吸主要调制透明度，少量调制亮度；零透明度与黑色仍严格为零。
  float alpha = max(core, halo) * opacity * breathingFactor;
  if (alpha < 0.001) discard;
  gl_FragColor = vec4(arrowColor * (1.0 + core * 0.15) * mix(0.9, 1.0, breathingFactor), alpha);
}`;

// 设备运动箭头共用同一套样式和材质程序，挂点几何由各设备独立解析。
export { vertexSource as SURFACE_ARROW_VERTEX_SOURCE, fragmentSource as SURFACE_ARROW_FRAGMENT_SOURCE, ARROW_STYLE_UNIFORMS };

type Bounds = { minimum: Vector3; maximum: Vector3 };
type MeshBoundsCache = { mesh: AbstractMesh; matrix: Matrix | null; bounds: Bounds | null; transformed: Bounds | null };
type SurfaceCache = {
  host: ModelRuntimeEntry;
  signature: string;
  meshesReference: AbstractMesh[];
  scriptRuntime: ModelRuntimeEntry['externalScriptRuntime'];
  frame: TransformNode;
  unitScale: number;
  explicit: boolean;
  axis: 'x' | 'z';
  meshes: MeshBoundsCache[];
  diagnostic: string | null;
};
type ArrowEntry = {
  root: TransformNode;
  mesh: Mesh;
  material: ShaderMaterial;
  surface: SurfaceCache | null;
  phase: number;
  breathingPhase: number;
};

function validMatrix(matrix: Matrix): boolean {
  return matrix.asArray().every(Number.isFinite) && Math.abs(matrix.determinant()) > 1e-12;
}

function readLocalBounds(mesh: AbstractMesh): Bounds {
  // thinInstance 的 BoundingInfo 已包含整批实例；几何自身范围才属于当前逻辑设备。
  const geometry = mesh instanceof Mesh && mesh.thinInstanceCount > 0 ? mesh.geometry : null;
  const bounds = geometry?.extend ?? mesh.getBoundingInfo().boundingBox;
  return { minimum: bounds.minimum, maximum: bounds.maximum };
}

function transformBounds(bounds: Bounds, matrix: Matrix): Bounds | null {
  let minimum = new Vector3(Infinity, Infinity, Infinity);
  let maximum = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const x of [bounds.minimum.x, bounds.maximum.x]) {
    for (const y of [bounds.minimum.y, bounds.maximum.y]) {
      for (const z of [bounds.minimum.z, bounds.maximum.z]) {
        const point = Vector3.TransformCoordinates(new Vector3(x, y, z), matrix);
        if (!isFiniteVector3(point)) return null;
        minimum = Vector3.Minimize(minimum, point);
        maximum = Vector3.Maximize(maximum, point);
      }
    }
  }
  return { minimum, maximum };
}

function mergeBounds(left: Bounds | null, right: Bounds): Bounds {
  return left ? {
    minimum: Vector3.Minimize(left.minimum, right.minimum),
    maximum: Vector3.Maximize(left.maximum, right.maximum),
  } : right;
}

function isDecoration(node: TransformNode): boolean {
  let current: TransformNode | null = node;
  while (current) {
    const metadata = current.metadata as { directionArrowVisual?: unknown; conveyorSurfaceArrow?: unknown } | null;
    if (metadata?.directionArrowVisual === true || metadata?.conveyorSurfaceArrow === true) return true;
    current = current.parent instanceof TransformNode ? current.parent : null;
  }
  return false;
}

/** 节点名适合常规模型，完整路径或唯一尾部路径用于重名部件消歧。 */
function matchesSurfaceNode(node: TransformNode, root: TransformNode, selector: string): boolean {
  if (node.name === selector) return true;
  const normalized = selector.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized.includes('/')) return false;
  const parts: string[] = [];
  let current: TransformNode | null = node;
  while (current) {
    parts.unshift(current.name);
    if (current === root) break;
    current = current.parent instanceof TransformNode ? current.parent : null;
  }
  const path = parts.join('/');
  return path === normalized || path.endsWith(`/${normalized}`);
}

function readMotionSourceName(node: TransformNode): string | null {
  const metadata = node.metadata as Record<string, unknown> | null;
  if (metadata?.generatedByParametricRuntime !== true) return null;
  const name = typeof metadata.motionSourceNodeName === 'string' ? metadata.motionSourceNodeName : metadata.sourceNodeName;
  return typeof name === 'string' ? name.trim() || null : null;
}

/** 只遍历模型子树建立缓存；逐帧只访问已选网格的矩阵和包围盒，不读取顶点数组。 */
function createSurfaceCache(model: ModelRuntimeEntry, signature: string, config: ConveyorSurfaceArrowsConfig, scene: Scene): SurfaceCache {
  const host = model.telemetryProxySource ?? model;
  const travel = readConveyorCargoTravelConfig(model);
  const nodes = getModelTransformNodes(host, scene).filter(node => !isDecoration(node));
  let selected: TransformNode[] = [];
  let diagnostic: string | null = null;
  let frame = host.root;
  if (config.surfaceNode) {
    selected = nodes.filter(node => matchesSurfaceNode(node, host.root, config.surfaceNode));
    if (selected.length !== 1) diagnostic = selected.length === 0
      ? `未找到输送线表面节点「${config.surfaceNode}」。`
      : `输送线表面节点「${config.surfaceNode}」不唯一，请使用完整或唯一尾部路径。`;
    else frame = selected[0];
  } else {
    const names = new Set(travel.nodes);
    selected = nodes.filter(node => names.has(node.name) || names.has(readMotionSourceName(node) ?? ''));
    if (selected.length === 0 && travel.fallbackPattern) {
      try {
        const pattern = new RegExp(travel.fallbackPattern, 'i');
        selected = nodes.filter(node => pattern.test(node.name));
      } catch {
        diagnostic = '输送线 cargo.travel.fallbackPattern 无效，无法定位箭头表面。';
      }
    }
    if (selected.length === 0) selected = nodes.filter(node => DEFAULT_SURFACE_PATTERN.test(node.name));
  }
  const meshes = new Set<AbstractMesh>();
  for (const node of selected) for (const mesh of getNodeMeshes(node)) meshes.add(mesh);
  if (meshes.size === 0 && !config.surfaceNode) {
    for (const mesh of host.contentRoot.getChildMeshes(false)) meshes.add(mesh);
    for (const mesh of host.meshes) meshes.add(mesh);
  }
  const measured = [...meshes].filter(mesh => !isDecoration(mesh) && !mesh.isDisposed() && mesh.getTotalVertices() > 0);
  if (!diagnostic && measured.length === 0) diagnostic = '输送线表面没有可测量几何。';
  const configuredScale = host.entitySnapshot?.components.modelAsset?.unitScaleToMeters;
  const unitScale = config.surfaceNode && frame !== host.contentRoot
    ? (typeof configuredScale === 'number' && configuredScale > 0 ? configuredScale : Math.abs(host.contentRoot.scaling.x))
    : (config.surfaceNode ? Math.abs(host.contentRoot.scaling.x) : 1);
  return {
    host, signature, meshesReference: host.meshes, scriptRuntime: host.externalScriptRuntime,
    frame, unitScale: unitScale > 0 ? unitScale : 1, explicit: Boolean(config.surfaceNode), axis: travel.axis,
    meshes: measured.map(mesh => ({ mesh, matrix: null, bounds: null, transformed: null })), diagnostic,
  };
}

/** 以表面节点的米坐标计算范围；矩阵与本地包围盒未改变时直接复用测量结果。 */
function measureSurface(cache: SurfaceCache, inverseFrame: Matrix): Bounds | null {
  let combined: Bounds | null = null;
  for (const item of cache.meshes) {
    if (item.mesh.isDisposed()) continue;
    const bounds = readLocalBounds(item.mesh);
    const matrix = item.mesh.computeWorldMatrix(true).multiply(inverseFrame);
    if (!item.matrix?.equals(matrix) || !item.bounds?.minimum.equals(bounds.minimum) || !item.bounds.maximum.equals(bounds.maximum)) {
      item.matrix = matrix;
      item.bounds = { minimum: bounds.minimum.clone(), maximum: bounds.maximum.clone() };
      item.transformed = transformBounds(bounds, matrix);
    }
    if (item.transformed) combined = mergeBounds(combined, item.transformed);
  }
  return combined;
}

/** 表面箭头仅持有独立装饰节点，不参与模型测量、批处理、拾取或 MQTT 订阅。 */
export class ConveyorSurfaceArrowRenderer {
  private readonly entries = new Map<string, ArrowEntry>();

  constructor(private readonly scene: Scene) {}

  /** direction 已由驱动完成协议解释和正向校准；0 表示隐藏。 */
  update(entityId: string, model: ModelRuntimeEntry, config: ConveyorSurfaceArrowsConfig, direction: 1 | -1 | 0,
    deltaSeconds: number, visible: boolean): string | null {
    if (!config.enabled) {
      this.remove(entityId);
      return null;
    }
    const existing = this.entries.get(entityId);
    // 大场景默认开启箭头时，尚未运行的设备不分配材质、装饰节点或遍历几何。
    if (!visible || direction === 0 || config.opacity <= 0) {
      if (existing) {
        existing.mesh.setEnabled(false);
        existing.material.setFloat('opacity', config.opacity);
        existing.material.setColor3('arrowColor', Color3.FromHexString(config.color));
      }
      return null;
    }
    const entry = existing ?? this.createEntry(entityId);
    entry.mesh.setEnabled(false);
    const host = model.telemetryProxySource ?? model;
    if (host.root.isDisposed() || model.root.isDisposed()) return '输送线模型已释放。';
    const signature = JSON.stringify([host.assetSignature, host.assetRevision, host.loadToken, host.parameterSignature,
      host.externalScriptSignature, host.measurementReady, host.stackerTelemetryReady, config.surfaceNode, host.meshes.length,
      host.entitySnapshot?.components.modelAsset?.dataDrivenConfig]);
    if (!entry.surface || entry.surface.host !== host || entry.surface.signature !== signature
      || entry.surface.meshesReference !== host.meshes || entry.surface.scriptRuntime !== host.externalScriptRuntime) {
      entry.surface = createSurfaceCache(model, signature, config, this.scene);
    }
    const surface = entry.surface;
    if (surface.diagnostic) return surface.diagnostic;
    if (surface.frame.isDisposed()) return '输送线表面节点已释放，等待模型重新就绪。';
    // 去除导入单位倍率，让面内参数使用局部米；完整矩阵保留节点倾斜、缩放、镜像和父级变换。
    const hostFrame = surface.explicit
      ? Matrix.Scaling(1 / surface.unitScale, 1 / surface.unitScale, 1 / surface.unitScale).multiply(surface.frame.computeWorldMatrix(true))
      : host.root.computeWorldMatrix(true).clone();
    if (!validMatrix(hostFrame)) return '输送线表面变换退化，无法生成箭头。';
    const bounds = measureSurface(surface, hostFrame.clone().invert());
    if (!bounds) return '输送线表面没有有效包围盒。';
    if (model.telemetryProxySource && !validMatrix(host.root.computeWorldMatrix(true))) return '输送线宿主变换退化，无法映射阵列箭头。';
    const frame = model.telemetryProxySource
      ? hostFrame.multiply(host.root.computeWorldMatrix(true).clone().invert()).multiply(model.root.computeWorldMatrix(true))
      : hostFrame;
    if (!validMatrix(frame)) return '输送线实例变换退化，无法生成箭头。';
    const alongAxis = surface.axis;
    const acrossAxis = alongAxis === 'x' ? 'z' : 'x';
    const length = (config.length || bounds.maximum[alongAxis] - bounds.minimum[alongAxis]) - config.endMargin * 2;
    const width = config.width || bounds.maximum[acrossAxis] - bounds.minimum[acrossAxis];
    if (length <= EPSILON || width <= EPSILON) return '箭头可用长度或宽度为零，请减小端部留边或增大尺寸。';
    const center = bounds.minimum.add(bounds.maximum).scale(.5);
    const metadata = host.contentRoot.metadata as { conveyorSurfaceY?: unknown } | null;
    center.y = !surface.explicit && typeof metadata?.conveyorSurfaceY === 'number' && Number.isFinite(metadata.conveyorSurfaceY)
      ? metadata.conveyorSurfaceY : bounds.maximum.y;
    center.y += config.surfaceOffset;
    center[alongAxis] += config.offsetAlong;
    center[acrossAxis] += config.offsetAcross;
    const along = alongAxis === 'x' ? Vector3.Right() : Vector3.Forward();
    const across = acrossAxis === 'x' ? Vector3.Right() : Vector3.Forward();
    const local = Matrix.FromValues(
      along.x * length, 0, along.z * length, 0,
      0, 1, 0, 0,
      across.x * width, 0, across.z * width, 0,
      center.x, center.y, center.z, 1,
    );
    entry.root.freezeWorldMatrix(local.multiply(frame));
    const delta = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    // 两个有界时钟互不依赖：速度为零只暂停流动，关闭呼吸也不影响流动。
    // 新六款使用与独立 EFF 一致的视觉倍率，间距只控制重复数量；旧款保留米/秒语义。
    const styled = ARROW_STYLE_UNIFORMS[config.style] >= 4;
    const period = styled ? 1 : config.spacing;
    const rate = styled ? config.speed * 0.65 : config.speed;
    entry.phase %= period;
    if (rate > 0) entry.phase = (entry.phase + (delta % (period / rate)) * rate) % period;
    entry.breathingPhase = (entry.breathingPhase + (delta % config.breathingPeriod) / config.breathingPeriod) % 1;
    const strength = config.breathingEnabled ? config.breathingStrength : 0;
    const breathingFactor = 1 - strength * (1 - Math.cos(entry.breathingPhase * Math.PI * 2)) * .5;
    entry.material.setFloat('phase', entry.phase);
    entry.material.setFloat('direction', direction);
    entry.material.setFloat('arrowStyle', ARROW_STYLE_UNIFORMS[config.style] ?? 0);
    entry.material.setFloat('breathingPhase', entry.breathingPhase);
    entry.material.setFloat('breathingFactor', breathingFactor);
    entry.material.setFloat('stripLength', length);
    entry.material.setFloat('stripWidth', width);
    entry.material.setFloat('arrowLength', config.arrowLength);
    entry.material.setFloat('arrowWidth', Math.min(config.arrowWidth, width));
    entry.material.setFloat('spacing', config.spacing);
    entry.material.setFloat('opacity', config.opacity);
    entry.material.setColor3('arrowColor', Color3.FromHexString(config.color));
    entry.mesh.setEnabled(true);
    return null;
  }

  /** 移除退出调度集合的设备，包含代理切换和动态设备超时。 */
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) if (!ids.has(id)) this.remove(id);
  }

  clear(): void {
    for (const id of this.entries.keys()) this.remove(id);
  }

  dispose(): void {
    this.clear();
  }

  private createEntry(entityId: string): ArrowEntry {
    const root = new TransformNode(`__conveyorSurfaceArrowsRoot_${entityId}`, this.scene);
    const mesh = MeshBuilder.CreateGround(`__conveyorSurfaceArrows_${entityId}`, { width: 1, height: 1 }, this.scene);
    mesh.parent = root;
    mesh.metadata = { conveyorSurfaceArrow: true, entityId };
    mesh.isPickable = false;
    mesh.receiveShadows = false;
    mesh.renderingGroupId = 0;
    const material = new ShaderMaterial(`__conveyorSurfaceArrowsMaterial_${entityId}`, this.scene,
      { vertexSource, fragmentSource }, {
        attributes: ['position', 'uv'],
        uniforms: ['worldViewProjection', 'arrowColor', 'opacity', 'stripLength', 'stripWidth', 'arrowLength', 'arrowWidth', 'spacing', 'phase', 'direction', 'arrowStyle', 'breathingFactor'],
        needAlphaBlending: true,
      });
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.depthFunction = Constants.LEQUAL;
    mesh.material = material;
    const entry = { root, mesh, material, surface: null, phase: 0, breathingPhase: 0 };
    this.entries.set(entityId, entry);
    return entry;
  }

  private remove(entityId: string): void {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    entry.mesh.dispose(false, false);
    entry.material.dispose();
    entry.root.dispose();
    this.entries.delete(entityId);
  }
}
