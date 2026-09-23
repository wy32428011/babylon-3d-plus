import { AbstractMesh, Matrix, Mesh, TransformNode, Vector3, type Scene } from '@babylonjs/core';
import type { RgvMotionArrowChannel, RgvMotionArrowChannelConfig } from '../../../editor/model/rgvMotionArrows';
import type { ModelRuntimeEntry } from '../SceneRuntime';
import { getModelTransformNodes, getNodeMeshes, mergeWorldBounds, transformWorldBounds, type RuntimeWorldBounds } from '../runtimeNodeGeometry';
import { readStringArrayPath } from '../runtimeValueUtils';

type MeasuredMesh = { mesh: AbstractMesh; matrix?: Matrix; bounds?: RuntimeWorldBounds; transformed?: RuntimeWorldBounds | null };
export type RgvArrowSurface = {
  host: ModelRuntimeEntry;
  signature: string;
  meshes: MeasuredMesh[];
  issue: string | null;
};

function validMatrix(matrix: Matrix): boolean {
  return matrix.asArray().every(Number.isFinite) && Math.abs(matrix.determinant()) > 1e-12;
}

function decoration(node: TransformNode): boolean {
  let current: TransformNode | null = node;
  while (current) {
    if (current.metadata?.directionArrowVisual || current.metadata?.rgvMotionArrow
      || current.metadata?.stackerMotionArrow || current.metadata?.conveyorSurfaceArrow) return true;
    current = current.parent instanceof TransformNode ? current.parent : null;
  }
  return false;
}

function sourceName(node: TransformNode): string {
  return node.metadata?.generatedByParametricRuntime === true
    ? node.metadata.motionSourceNodeName ?? node.metadata.sourceNodeName ?? node.name : node.name;
}

function named(node: TransformNode, name: string): boolean {
  return node.name === name || sourceName(node) === name;
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

/** 只解析声明或有明确语义的部件；缺少台面时不能把整机范围当作前后工位。 */
export function createRgvArrowSurface(model: ModelRuntimeEntry, channel: RgvMotionArrowChannel,
  config: RgvMotionArrowChannelConfig, signature: string, scene: Scene): RgvArrowSurface {
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
  const byNames = (names: string[]) => nodes.filter(node => names.some(name => named(node, name)));
  const fixedNames = namesAt(['fixedNodes']);
  const fixed = fixedNames.length ? byNames(fixedNames)
    : nodes.filter(node => /^A(?:3[7-9]|4[0-6])(?:[._]|$)/.test(sourceName(node)));
  const containsFixed = (node: TransformNode) => fixed.some(part => part === node || part.isDescendantOf(node) || node.isDescendantOf(part));
  let selected: TransformNode[] = [];
  let issue: string | null = null;
  if (config.surfaceNode) {
    selected = nodes.filter(node => matchesPath(node, host.root, config.surfaceNode));
    if (selected.length !== 1) issue = selected.length ? '挂点节点不唯一，请填写完整或唯一尾部路径。'
      : '未找到挂点节点「' + config.surfaceNode + '」。';
    else if (channel === 'travel') {
      if (!containsFixed(selected[0])) issue = '挂点未声明为固定轨道，请先在模型 fixedNodes 中声明轨道部件。';
      // 单轨只用于选择轨道来源，显示范围始终合并双轨，不能偏到选中的一侧。
      selected = fixed;
    } else if (containsFixed(selected[0])) issue = '工位台面挂点包含固定轨道，请选择随车移动的独立台面。';
  } else if (channel === 'travel') {
    selected = fixedNames.length ? fixed : fixed.filter(node => /^A(?:45|46)(?:[._]|$)/.test(sourceName(node)));
    if (!selected.length) issue = '未找到固定轨道，请检查 fixedNodes 或指定包含双轨的轨道节点。';
  } else {
    const declared = namesAt(['cargo', channel + 'Nodes']);
    const pattern = channel === 'front' ? /front.*(?:deck|platform)|(?:deck|platform).*front|前.*(?:台面|输送台)/i
      : /back.*(?:deck|platform)|(?:deck|platform).*back|后.*(?:台面|输送台)/i;
    selected = declared.length ? byNames(declared) : nodes.filter(node => pattern.test(sourceName(node)));
    if (!selected.length) issue = '未找到独立' + (channel === 'front' ? '前' : '后') + '工位台面，请声明 cargo.' + channel + 'Nodes 或指定挂点。';
    else if (selected.some(containsFixed)) issue = '工位台面声明包含固定轨道，请检查 cargo.' + channel + 'Nodes。';
  }
  let meshes = [...new Set(selected.flatMap(getNodeMeshes))]
    .filter(mesh => !decoration(mesh) && !mesh.isDisposed() && mesh.getTotalVertices() > 0);
  if (channel === 'travel') {
    // 导轨与端盖一起声明时，轨顶和全长以真正导轨为准，避免高盖板把箭头抬入车体。
    const rails = meshes.filter(mesh => /^(?:A45|A46)(?:[._]|$)|rail|guidao|轨道|导轨/i.test(sourceName(mesh)));
    if (rails.length) meshes = rails;
  }
  if (!issue && !meshes.length) issue = '挂点没有可测量的模型几何。';
  return { host, signature, meshes: meshes.map(mesh => ({ mesh })), issue };
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

function measure(surface: RgvArrowSurface, inverseRoot: Matrix): RuntimeWorldBounds | null {
  let combined: RuntimeWorldBounds | null = null;
  for (const item of surface.meshes) {
    if (item.mesh.isDisposed() || !locallyVisible(item.mesh, surface.host.root)) continue;
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

/** 所有部件先换算到模型局部米，兼容 GLB 的单位/预旋转；真实节点位移直接反映到台面。 */
export function resolveRgvArrowPlacement(surface: RgvArrowSurface, model: ModelRuntimeEntry,
  channel: RgvMotionArrowChannel, config: RgvMotionArrowChannelConfig): { matrix: Matrix; length: number; width: number } | string {
  if (surface.issue) return surface.issue;
  const root = surface.host.root.computeWorldMatrix(true);
  const targetRoot = model.root.computeWorldMatrix(true);
  if (!validMatrix(root) || !validMatrix(targetRoot)) return '模型变换退化，无法定位箭头。';
  if (channel === 'travel' && surface.meshes.some(({ mesh }) => mesh.isDisposed() || !locallyVisible(mesh, surface.host.root))) {
    return '固定轨道已隐藏或释放，等待完整轨道重新就绪。';
  }
  const bounds = measure(surface, root.clone().invert());
  if (!bounds) return '挂点已隐藏或没有有效几何范围。';
  const travel = channel === 'travel';
  const side = !travel && config.face === 'side';
  const span = bounds.maximum.subtract(bounds.minimum);
  const along = travel ? Vector3.Forward() : Vector3.Right();
  const normal = side ? Vector3.Forward() : Vector3.Up();
  const across = Vector3.Cross(normal, along);
  const length = travel ? span.z : config.length || span.x * .9;
  const width = config.width || Math.min(travel ? span.x : side ? span.y : span.z, .38);
  if (!(length > 1e-8 && width > 1e-8)) return '箭头可用长度或宽度为零，请检查挂点几何与尺寸。';
  const center = bounds.minimum.add(bounds.maximum).scale(.5)
    .add(normal.scale((side ? span.z : span.y) * .5 + config.surfaceOffset));
  // 行走通道始终位于双轨中心正上方，纵向起止覆盖整个轨道，历史侧向配置也不改变该约束。
  if (!travel) center.addInPlace(along.scale(config.offsetAlong)).addInPlace(across.scale(config.offsetAcross));
  const local = Matrix.FromValues(
    along.x * length, along.y * length, along.z * length, 0,
    normal.x, normal.y, normal.z, 0,
    across.x * width, across.y * width, across.z * width, 0,
    center.x, center.y, center.z, 1,
  );
  return { matrix: local.multiply(targetRoot), length, width };
}
