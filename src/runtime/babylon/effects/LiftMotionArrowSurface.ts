import { AbstractMesh, Matrix, Mesh, TransformNode, Vector3, type Scene } from '@babylonjs/core';
import type { LiftMotionArrowChannel, LiftMotionArrowChannelConfig } from '../../../editor/model/liftMotionArrows';
import type { ModelRuntimeEntry } from '../SceneRuntime';
import { getModelAxis, getModelTransformNodes, getNodeMeshes, mergeWorldBounds, transformWorldBounds, type RuntimeWorldBounds } from '../runtimeNodeGeometry';
import { readStringArrayPath } from '../runtimeValueUtils';

type MeasuredMesh = { mesh: AbstractMesh; matrix?: Matrix; bounds?: RuntimeWorldBounds; transformed?: RuntimeWorldBounds | null };
export type LiftArrowAxis = { x: number; y: number; z: number };
export type LiftArrowSurface = {
  host: ModelRuntimeEntry;
  signature: string;
  meshes: MeasuredMesh[];
  platformMeshes: MeasuredMesh[];
  sharedPlatform: boolean;
  issue: string | null;
};

function validMatrix(matrix: Matrix): boolean {
  return matrix.asArray().every(Number.isFinite) && Math.abs(matrix.determinant()) > 1e-12;
}

function decoration(node: TransformNode): boolean {
  let current: TransformNode | null = node;
  while (current) {
    if (current.metadata?.directionArrowVisual || current.metadata?.liftMotionArrow || current.metadata?.rgvMotionArrow
      || current.metadata?.stackerMotionArrow || current.metadata?.conveyorSurfaceArrow) return true;
    current = current.parent instanceof TransformNode ? current.parent : null;
  }
  return false;
}

function sourceName(node: TransformNode): string {
  return node.metadata?.generatedByParametricRuntime === true
    ? node.metadata.motionSourceNodeName ?? node.metadata.sourceNodeName ?? node.name : node.name;
}

function matchesPath(node: TransformNode, root: TransformNode, selector: string): boolean {
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
  return parts.join('/') === normalized || parts.join('/').endsWith('/' + normalized);
}

function measuredNodes(nodes: TransformNode[]): MeasuredMesh[] {
  return [...new Set(nodes.flatMap(getNodeMeshes))]
    .filter(mesh => !decoration(mesh) && !mesh.isDisposed() && mesh.getTotalVertices() > 0).map(mesh => ({ mesh }));
}

function locallyVisible(mesh: AbstractMesh, root: TransformNode): boolean {
  if (mesh.isVisible === false || mesh.visibility <= 0) return false;
  let current: TransformNode | null = mesh;
  while (current && current !== root) {
    if (!current.isEnabled(false)) return false;
    current = current.parent instanceof TransformNode ? current.parent : null;
  }
  return true;
}

function measure(meshes: MeasuredMesh[], inverseRoot: Matrix): RuntimeWorldBounds | null {
  let combined: RuntimeWorldBounds | null = null;
  for (const item of meshes) {
    if (item.mesh.isDisposed()) continue;
    const local = item.mesh instanceof Mesh && item.mesh.thinInstanceCount > 0
      ? item.mesh.geometry?.extend ?? item.mesh.getBoundingInfo().boundingBox : item.mesh.getBoundingInfo().boundingBox;
    const matrix = item.mesh.computeWorldMatrix(true).multiply(inverseRoot);
    if (!item.matrix?.equals(matrix) || !item.bounds?.minimum.equals(local.minimum) || !item.bounds.maximum.equals(local.maximum)) {
      item.matrix = matrix;
      item.bounds = { minimum: local.minimum.clone(), maximum: local.maximum.clone() };
      item.transformed = transformWorldBounds(item.bounds, matrix);
    }
    if (item.transformed) combined = combined ? mergeWorldBounds(combined, item.transformed) : item.transformed;
  }
  return combined;
}

/** 仅在已声明的固定框架中按细长竖直几何识别立柱，不把任意整机包围盒当作升降通道。 */
function fixedColumnMeshes(nodes: TransformNode[], host: ModelRuntimeEntry): MeasuredMesh[] {
  const root = host.root.computeWorldMatrix(true);
  if (!validMatrix(root)) return [];
  const inverse = root.clone().invert();
  return measuredNodes(nodes).filter(item => {
    const bounds = measure([item], inverse);
    if (!bounds) return false;
    const span = bounds.maximum.subtract(bounds.minimum);
    return span.y > .2 && span.x > 1e-8 && span.z > 1e-8 && span.y >= Math.max(span.x, span.z) * 3;
  });
}

/** 优先使用模型的固定立柱和载货台声明；共享载货台按真实交接轴分成来料、送料两半。 */
export function createLiftArrowSurface(model: ModelRuntimeEntry, channel: LiftMotionArrowChannel,
  config: LiftMotionArrowChannelConfig, signature: string, scene: Scene): LiftArrowSurface {
  const host = model.telemetryProxySource ?? model;
  const nodes = getModelTransformNodes(host, scene).filter(node => !node.isDisposed() && !decoration(node));
  const declarations = host.externalScriptRuntime?.getDataDrivenConfigs() ?? [];
  const namesAt = (path: string[]): string[] => {
    for (const declaration of declarations) {
      const values = readStringArrayPath(declaration, path);
      if (values.length) return values;
    }
    return [];
  };
  const byNames = (names: string[]) => nodes.filter(node => names.includes(node.name) || names.includes(sourceName(node)));
  const moving = byNames(namesAt(['motion', 'lift', 'nodes']));
  const isMoving = (node: TransformNode) => moving.some(part => node === part || node.isDescendantOf(part));
  const cargoNames = namesAt(['cargo', 'nodes']);
  const platformNodes = cargoNames.length ? byNames(cargoNames) : moving;
  const platformMeshes = measuredNodes(platformNodes);
  let meshes: MeasuredMesh[], issue: string | null = null, sharedPlatform = false;
  if (config.surfaceNode) {
    const selected = nodes.filter(node => matchesPath(node, host.root, config.surfaceNode));
    if (selected.length !== 1) issue = selected.length ? '挂点节点不唯一，请填写完整或唯一尾部路径。'
      : '未找到挂点节点「' + config.surfaceNode + '」。';
    else if (channel === 'lift' && (isMoving(selected[0]) || moving.some(part => part.isDescendantOf(selected[0])))) {
      issue = '升降挂点包含载货台运动部件，请选择固定立柱。';
    }
    meshes = measuredNodes(selected);
  } else if (channel === 'lift') {
    const declared = namesAt(['motion', 'lift', 'columnNodes']);
    const mastNames = namesAt(['motion', 'lift', 'mastNodes']);
    const fixedNames = namesAt(['fixedNodes']);
    const pattern = /mast|columns?|lizhu|立柱/i;
    const semantic = nodes.filter(node => pattern.test(sourceName(node)) && !isMoving(node));
    if (declared.length || mastNames.length) meshes = measuredNodes(byNames(declared.length ? declared : mastNames).filter(node => !isMoving(node)));
    else if (fixedNames.length) meshes = fixedColumnMeshes(byNames(fixedNames).filter(node => !isMoving(node)), host);
    else meshes = measuredNodes(semantic);
    meshes = meshes.filter(({ mesh }) => !isMoving(mesh));
    if (!meshes.length) issue = '未找到固定升降立柱，请声明 motion.lift.columnNodes / fixedNodes 或指定立柱挂点。';
  } else {
    const declared = namesAt(['cargo', channel + 'Nodes']);
    const pattern = channel === 'front' ? /front.*(?:deck|platform)|(?:deck|platform).*front|前.*(?:台面|输送台)/i
      : /back.*(?:deck|platform)|(?:deck|platform).*back|后.*(?:台面|输送台)/i;
    const semantic = nodes.filter(node => pattern.test(sourceName(node)));
    if (declared.length) meshes = measuredNodes(byNames(declared));
    else if (semantic.length) meshes = measuredNodes(semantic);
    else { meshes = platformMeshes; sharedPlatform = true; }
    if (!meshes.length) issue = '未找到' + (channel === 'front' ? '前' : '后') + '工位载货台，请声明 cargo.nodes / cargo.' + channel + 'Nodes 或指定挂点。';
  }
  if (!issue && !meshes.length) issue = '挂点没有可测量的模型几何。';
  if (!issue && channel === 'lift' && !platformMeshes.length) issue = '未找到升降载货台，无法避让平台，请检查 motion.lift.nodes / cargo.nodes 声明。';
  return { host, signature, meshes, platformMeshes, sharedPlatform, issue };
}

function radiusOnAxis(half: Vector3, axis: Vector3): number {
  return Math.abs(axis.x) * half.x + Math.abs(axis.y) * half.y + Math.abs(axis.z) * half.z;
}

/** 矩形先按条带横向半宽内缩，再求穿过中心的直线交段，保证斜向条带的四个角仍在台面内。 */
function surfaceLineSpan(half: Vector3, axis: Vector3, across = Vector3.Zero(), width = 0): number {
  let radius = Infinity;
  for (const key of ['x', 'y', 'z'] as const) {
    const available = half[key] - Math.abs(across[key]) * width * .5;
    const component = Math.abs(axis[key]);
    if (available < -1e-8) return 0;
    if (component > 1e-8) radius = Math.min(radius, Math.max(0, available) / component);
  }
  return Number.isFinite(radius) ? radius * 2 : 0;
}

/** 预览沿已解析轴或模型声明轴；运行时由同帧驱动传入实际世界轴。 */
function localTravelAxis(surface: LiftArrowSurface, model: ModelRuntimeEntry, inverseTarget: Matrix, axis?: LiftArrowAxis): Vector3 {
  const cached = axis ?? model.liftTelemetry?.travelAxis?.axis;
  if (cached && [cached.x, cached.y, cached.z].every(Number.isFinite)) {
    const local = Vector3.TransformNormal(new Vector3(cached.x, cached.y, cached.z), inverseTarget);
    if (local.lengthSquared() > 1e-8) return local.normalize();
  }
  for (const declaration of surface.host.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
    const value = (declaration as { motion?: { lift?: { travelAxis?: unknown } } } | null)?.motion?.lift?.travelAxis;
    if (typeof value === 'string' && /^-?[xz]$/i.test(value.trim())) {
      const result = /z/i.test(value) ? Vector3.Forward() : Vector3.Right();
      return value.trim().startsWith('-') ? result.negate() : result;
    }
    if (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) {
      const result = new Vector3(value[0], value[1], value[2]);
      if (result.lengthSquared() > 1e-8) return result.normalize();
    }
  }
  return Vector3.Right();
}

/** 在模型局部米中定位，导入单位/预旋转只影响几何；根节点旋转、镜像和阵列代理保留。 */
export function resolveLiftArrowPlacement(surface: LiftArrowSurface, model: ModelRuntimeEntry,
  channel: LiftMotionArrowChannel, config: LiftMotionArrowChannelConfig, axis?: LiftArrowAxis): {
    matrix: Matrix; length: number; width: number; liftGap?: { min: number; max: number };
  } | string {
  if (surface.issue) return surface.issue;
  const hostRoot = surface.host.root.computeWorldMatrix(true), targetRoot = model.root.computeWorldMatrix(true);
  if (!validMatrix(hostRoot) || !validMatrix(targetRoot)) return '模型变换退化，无法定位箭头。';
  if (surface.meshes.some(({ mesh }) => mesh.isDisposed() || !locallyVisible(mesh, surface.host.root))) return '挂点已隐藏或释放，等待完整几何重新就绪。';
  const inverseHost = hostRoot.clone().invert();
  let bounds = measure(surface.meshes, inverseHost);
  if (!bounds) return '挂点没有有效几何范围。';
  const lift = channel === 'lift', side = lift || config.face === 'side';
  // 多根立柱优先贴在最外侧实际柱面上，避免合并包围盒的中心落在两柱之间的空隙。
  if (lift && surface.meshes.length > 1) {
    const measured = surface.meshes.map(item => ({ item, bounds: measure([item], inverseHost) })).filter(item => item.bounds !== null);
    measured.sort((a, b) => b.bounds!.maximum.x - a.bounds!.maximum.x);
    const outer = measured[0]?.bounds;
    if (outer) bounds = outer;
  }
  const along = lift ? Vector3.TransformNormal(getModelAxis(model.root, 'y'), targetRoot.clone().invert()).normalize()
    : localTravelAxis(surface, model, targetRoot.clone().invert(), axis);
  let normal = lift ? Vector3.Right() : Vector3.Up();
  if (!lift) {
    if (side) {
      // 斜向交接轴没有对应的斜切盒侧面，选择实际 X/Z 侧面并投影运动方向，避免条带悬在外侧空中。
      const desired = Vector3.Cross(along, Vector3.Up());
      normal = Math.abs(desired.x) > Math.abs(desired.z)
        ? Vector3.Right().scale(Math.sign(desired.x)) : Vector3.Forward().scale(Math.sign(desired.z));
    }
    along.subtractInPlace(normal.scale(Vector3.Dot(normal, along)));
    if (along.lengthSquared() < 1e-10) return '挂点表面与运动方向垂直，请校准台面挂点和运动轴。';
    along.normalize();
  }
  const across = Vector3.Cross(normal, along).normalize();
  const half = bounds.maximum.subtract(bounds.minimum).scale(.5);
  const width = config.width || Math.min(lift ? radiusOnAxis(half, across) * 2 : surfaceLineSpan(half, across), lift ? .28 : .38);
  const spanAlong = lift ? radiusOnAxis(half, along) * 2 : surfaceLineSpan(half, along, across, width);
  const shared = !lift && surface.sharedPlatform;
  const length = lift ? spanAlong : config.length || spanAlong * (shared ? .45 : .9);
  if (!(length > 1e-8 && width > 1e-8)) return '箭头可用长度或宽度为零，请检查挂点几何与尺寸。';
  const center = bounds.minimum.add(bounds.maximum).scale(.5)
    .add(normal.scale(radiusOnAxis(half, normal) + config.surfaceOffset));
  if (!lift) {
    if (shared) center.addInPlace(along.scale(spanAlong * (channel === 'front' ? -.25 : .25)));
    center.addInPlace(along.scale(config.offsetAlong)).addInPlace(across.scale(config.offsetAcross));
  }
  const local = Matrix.FromValues(
    along.x * length, along.y * length, along.z * length, 0,
    normal.x, normal.y, normal.z, 0,
    across.x * width, across.y * width, across.z * width, 0,
    center.x, center.y, center.z, 1,
  );
  let liftGap: { min: number; max: number } | undefined;
  if (lift) {
    if (surface.platformMeshes.some(({ mesh }) => mesh.isDisposed() || !locallyVisible(mesh, surface.host.root))) return '升降载货台已隐藏或释放，箭头隐藏。';
    const platform = measure(surface.platformMeshes, local.multiply(hostRoot).invert());
    if (!platform) return '升降载货台几何已失效，箭头隐藏。';
    const min = Math.max(0, platform.minimum.x + .5 - .03 / length);
    const max = Math.min(1, platform.maximum.x + .5 + .03 / length);
    if (min < max) liftGap = { min, max };
  }
  return { matrix: local.multiply(targetRoot), length, width, ...(liftGap ? { liftGap } : {}) };
}
