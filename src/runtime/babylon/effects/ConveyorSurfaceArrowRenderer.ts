import {
  AbstractMesh, Color3, Constants, Matrix, Mesh, MeshBuilder, ShaderMaterial, TransformNode, Vector3, type Scene,
} from '@babylonjs/core';
import type { ConveyorSurfaceArrowsConfig } from '../../../editor/model/conveyorSurfaceArrows';
import type { ModelRuntimeEntry } from '../SceneRuntime';
import { getModelTransformNodes, getNodeMeshes, isFiniteVector3 } from '../runtimeNodeGeometry';
import { readConveyorCargoTravelConfig } from '../telemetry/specialized/specializedModelAssets';

const EPSILON = 1e-8;
const DEFAULT_SURFACE_PATTERN = /conveyor|roller|chain|rail|GT|输送|滚筒|链条|轨道/i;

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
float segmentDistance(vec2 point, vec2 start, vec2 end) {
  vec2 span = end - start;
  float progress = clamp(dot(point - start, span) / max(dot(span, span), 0.000001), 0.0, 1.0);
  return length(point - start - span * progress);
}
void main(void) {
  // 在米空间中绘制重复箭头；同一方向符号同时控制朝向和相位移动。
  float along = (vUV.x - 0.5) * stripLength;
  float across = abs((vUV.y - 0.5) * stripWidth);
  float x = mod(along * direction - phase + spacing * 0.5, spacing) - spacing * 0.5;
  // 对两条斜臂取距离场生成无柄 >，柔边仅在当前平面内发光，不穿透货物。
  float distanceToArm = segmentDistance(vec2(x, across), vec2(-arrowLength * 0.5, arrowWidth * 0.5), vec2(arrowLength * 0.5, 0.0));
  float stroke = min(arrowLength, arrowWidth) * 0.09;
  float core = 1.0 - smoothstep(stroke * 0.6, stroke, distanceToArm);
  float halo = (1.0 - smoothstep(stroke, stroke * 2.8, distanceToArm)) * 0.28;
  float alpha = max(core, halo) * opacity;
  if (alpha < 0.001) discard;
  gl_FragColor = vec4(arrowColor * (1.0 + core * 0.15), alpha);
}`;

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
    const entry = this.entries.get(entityId) ?? this.createEntry(entityId);
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
    if (visible && direction !== 0 && config.opacity > 0) {
      const delta = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
      entry.phase = (entry.phase + config.speed * delta) % config.spacing;
      entry.material.setFloat('phase', entry.phase);
      entry.material.setFloat('direction', direction);
      entry.material.setFloat('stripLength', length);
      entry.material.setFloat('stripWidth', width);
      entry.material.setFloat('arrowLength', config.arrowLength);
      entry.material.setFloat('arrowWidth', Math.min(config.arrowWidth, width));
      entry.material.setFloat('spacing', config.spacing);
      entry.material.setFloat('opacity', config.opacity);
      entry.material.setColor3('arrowColor', Color3.FromHexString(config.color));
      entry.mesh.setEnabled(true);
    }
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
        uniforms: ['worldViewProjection', 'arrowColor', 'opacity', 'stripLength', 'stripWidth', 'arrowLength', 'arrowWidth', 'spacing', 'phase', 'direction'],
        needAlphaBlending: true,
      });
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.depthFunction = Constants.LEQUAL;
    mesh.material = material;
    const entry = { root, mesh, material, surface: null, phase: 0 };
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
