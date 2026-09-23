import { AbstractMesh, Matrix, Mesh, TransformNode, Vector3, type Scene } from '@babylonjs/core';
import type { StackerMotionArrowChannel, StackerMotionArrowChannelConfig } from '../../../editor/model/stackerMotionArrows';
import type { ModelRuntimeEntry } from '../SceneRuntime';
import { getHorizontalModelAxis, getModelAxis, getModelTransformNodes, getNodeMeshes, mergeWorldBounds, transformWorldBounds, type RuntimeWorldBounds } from '../runtimeNodeGeometry';
import { readStringArrayPath } from '../runtimeValueUtils';

type MeasuredMesh = { mesh: AbstractMesh; matrix?: Matrix; bounds?: RuntimeWorldBounds; transformed?: RuntimeWorldBounds | null };
export type StackerArrowSurface = {
  host: ModelRuntimeEntry;
  signature: string;
  frame: TransformNode;
  meshes: MeasuredMesh[];
  platformMeshes: MeasuredMesh[];
  issue: string | null;
};

export function validArrowMatrix(matrix: Matrix): boolean {
  return matrix.asArray().every(Number.isFinite) && Math.abs(matrix.determinant()) > 1e-12;
}

function decoration(node: TransformNode): boolean {
  let current: TransformNode | null = node;
  while (current) {
    if (current.metadata?.directionArrowVisual || current.metadata?.stackerMotionArrow || current.metadata?.conveyorSurfaceArrow) return true;
    current = current.parent instanceof TransformNode ? current.parent : null;
  }
  return false;
}

function sourceName(node: TransformNode): string {
  return node.metadata?.generatedByParametricRuntime === true
    ? node.metadata.motionSourceNodeName ?? node.metadata.sourceNodeName ?? node.name : node.name;
}

function matches(node: TransformNode, root: TransformNode, selector: string): boolean {
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

/** 只在资源或挂点配置变化时解析模型子树；行走定位固定轨道，其余通道定位运动部件。 */
export function createStackerArrowSurface(model: ModelRuntimeEntry, channel: StackerMotionArrowChannel,
  config: StackerMotionArrowChannelConfig, signature: string, scene: Scene): StackerArrowSurface {
  const host = model.telemetryProxySource ?? model;
  const nodes = getModelTransformNodes(host, scene).filter(node => !node.isDisposed() && !decoration(node));
  const declarations = host.externalScriptRuntime?.getDataDrivenConfigs() ?? [];
  const namesAt = (path: string[]): string[] => {
    for (const declaration of declarations) { const values = readStringArrayPath(declaration, path); if (values.length) return values; }
    return [];
  };
  const byNames = (names: string[]) => nodes.filter(node => names.includes(node.name) || names.includes(sourceName(node)));
  let selected: TransformNode[];
  let frame = host.root;
  let issue: string | null = null;
  if (channel === 'travel') {
    const fixedNames = namesAt(['fixedNodes']);
    const fixed = byNames(fixedNames.length ? fixedNames : ['guidaoshang.1', 'guidaoxia.2']);
    const moving = byNames(namesAt(['motion', 'travel', 'nodes']));
    const isMoving = (node: TransformNode) => moving.some(parent => node === parent || node.isDescendantOf(parent));
    const railPattern = /rail|guidao|轨道|导轨/i;
    selected = fixed.length ? fixed : nodes.filter(node => railPattern.test(sourceName(node)) && !isMoving(node));
    if (config.surfaceNode && !fixed.length) {
      const explicit = nodes.filter(node => matches(node, host.root, config.surfaceNode));
      if (explicit.length !== 1) issue = explicit.length ? '轨道节点不唯一，请填写完整或唯一尾部路径。'
        : '未找到轨道节点「' + config.surfaceNode + '」。';
      else if (!selected.length && !isMoving(explicit[0]) && !/chassis|base|dibu|底盘|底座|底部/i.test(sourceName(explicit[0]))) selected = explicit;
      // 旧场景保存的底盘挂点只作兼容读取；全轨范围始终来自固定轨道，不随底盘移动。
    }
    if (!selected.length && !issue) issue = '未找到固定轨道，请检查 fixedNodes 或指定轨道部件。';
  } else if (config.surfaceNode) {
    selected = nodes.filter(node => matches(node, host.root, config.surfaceNode));
    if (selected.length !== 1) issue = selected.length ? '挂点节点不唯一，请填写完整或唯一尾部路径。' : '未找到挂点节点「' + config.surfaceNode + '」。';
    else frame = selected[0];
  } else if (channel === 'frontFork' || channel === 'backFork') {
    const prefix = channel === 'frontFork' ? 'front' : 'back';
    const second = namesAt(['motion', 'fork', prefix + 'StageTwoNodes']);
    const first = namesAt(['motion', 'fork', prefix + 'StageOneNodes']);
    selected = byNames(second.length ? second : first);
    if (!second.length && !first.length) {
      const pattern = channel === 'frontFork' ? /front.*fork|fork.*front|前.*叉|huocha\.9$/i : /back.*fork|fork.*back|后.*叉/i;
      selected = nodes.filter(node => pattern.test(sourceName(node)));
    }
    // 共享单叉模型不为后叉猜测同一挂点，避免两路相反指令叠加。
    if (!selected.length) issue = '未找到独立' + (channel === 'frontFork' ? '前叉' : '后叉') + '挂点，请指定货叉节点。';
  } else {
    const declared = namesAt(['motion', 'travel', 'nodes']);
    const fixed = new Set(namesAt(['fixedNodes']));
    const candidates = (declared.length ? byNames(declared) : nodes).filter(node => !fixed.has(node.name) && !fixed.has(sourceName(node)));
    const pattern = /mast|column|lizhu|立柱/i;
    selected = candidates.filter(node => pattern.test(sourceName(node)));
    if (!selected.length) issue = '无法自动识别立柱，请指定实际运动部件节点。';
  }
  let meshes = measuredNodes(selected);
  if (channel === 'travel' && meshes.length > 1) {
    // 展开父容器后筛选下轨，防止保留父节点又把上导轨带回来；同高度的分段合并全长。
    const rootMatrix = host.root.computeWorldMatrix(true);
    if (validArrowMatrix(rootMatrix)) {
      const inverseRoot = rootMatrix.clone().invert();
      const measured = meshes.map(item => ({ item, bounds: measure([item], inverseRoot) }));
      const minimumY = Math.min(...measured.flatMap(value => value.bounds ? [value.bounds.minimum.y] : []));
      meshes = measured.filter(value => value.bounds && value.bounds.minimum.y <= minimumY + .05).map(value => value.item);
    }
  }
  if (!issue && !meshes.length) issue = '挂点没有可测量的模型几何。';
  let platformMeshes: MeasuredMesh[] = [];
  if (channel === 'lift') {
    const forkNames = ['frontStageOneNodes','frontStageTwoNodes','backStageOneNodes','backStageTwoNodes']
      .flatMap(name => namesAt(['motion','fork',name]));
    const forkNodes = byNames(forkNames);
    const liftNodes = byNames(namesAt(['motion','lift','nodes']));
    const platformCandidates = liftNodes.filter(node => !forkNodes.some(fork => node === fork || node.isDescendantOf(fork))
      && !/fork|huocha|货叉/i.test(sourceName(node)));
    const platformPattern = /platform|carrier|cargo|bay|xiang|载货|货台|台|仓/i;
    const named = platformCandidates.filter(node => platformPattern.test(sourceName(node)));
    platformMeshes = measuredNodes(named.length ? named : platformCandidates.length ? platformCandidates
      : nodes.filter(node => platformPattern.test(sourceName(node)) && !/caozuo|操作/i.test(sourceName(node))));
    if (!issue && !platformMeshes.length) issue = '未找到载货台，无法确定升降箭头避让区间，请检查模型升降节点声明。';
  }
  return { host, signature, frame, meshes, platformMeshes, issue };
}

function measure(meshes: MeasuredMesh[], inverseFrame: Matrix): RuntimeWorldBounds | null {
  let combined: RuntimeWorldBounds | null = null;
  for (const item of meshes) {
    if (item.mesh.isDisposed()) continue;
    const local = item.mesh instanceof Mesh && item.mesh.thinInstanceCount > 0
      ? item.mesh.geometry?.extend ?? item.mesh.getBoundingInfo().boundingBox : item.mesh.getBoundingInfo().boundingBox;
    const matrix = item.mesh.computeWorldMatrix(true).multiply(inverseFrame);
    if (!item.matrix?.equals(matrix) || !item.bounds?.minimum.equals(local.minimum) || !item.bounds.maximum.equals(local.maximum)) {
      item.matrix = matrix;
      item.bounds = { minimum: local.minimum.clone(), maximum: local.maximum.clone() };
      item.transformed = transformWorldBounds(item.bounds, matrix);
    }
    if (item.transformed) combined = combined ? mergeWorldBounds(combined, item.transformed) : item.transformed;
  }
  return combined;
}

function radiusOnAxis(half: Vector3, axis: Vector3): number {
  return Math.abs(axis.x) * half.x + Math.abs(axis.y) * half.y + Math.abs(axis.z) * half.z;
}

/** 去掉导入单位和 GLB 部件建模缩放，保留挂点的方向/镜像/位置及用户模型根节点缩放。 */
function metricSurfaceFrame(surface: StackerArrowSurface, hostRoot: Matrix): Matrix | null {
  if (surface.frame === surface.host.root) return hostRoot.clone();
  const relative = surface.frame.computeWorldMatrix(true).multiply(hostRoot.clone().invert());
  const m = relative.asArray();
  const x = Math.hypot(m[0], m[1], m[2]), y = Math.hypot(m[4], m[5], m[6]), z = Math.hypot(m[8], m[9], m[10]);
  if (![x,y,z].every(value => Number.isFinite(value) && value > 1e-12)) return null;
  return Matrix.FromValues(
    m[0]/x,m[1]/x,m[2]/x,0, m[4]/y,m[5]/y,m[6]/y,0, m[8]/z,m[9]/z,m[10]/z,0,
    m[12],m[13],m[14],1,
  ).multiply(hostRoot);
}

/** 挂点面跟随完整矩阵，箭头沿模型运动轴在表面的投影，节点自身旋转不会反转真实运动语义。 */
export function resolveStackerArrowPlacement(surface: StackerArrowSurface, model: ModelRuntimeEntry,
  channel: StackerMotionArrowChannel, config: StackerMotionArrowChannelConfig): {
    matrix: Matrix; length: number; width: number; liftGap?: { min: number; max: number };
  } | string {
  if (surface.issue) return surface.issue;
  if (surface.frame.isDisposed()) return '挂点已释放，等待模型重新就绪。';
  const hostRoot = surface.host.root.computeWorldMatrix(true);
  if (!validArrowMatrix(hostRoot)) return '模型变换退化，无法定位箭头。';
  const hostFrame = metricSurfaceFrame(surface, hostRoot);
  if (!hostFrame || !validArrowMatrix(hostFrame)) return '模型变换退化，无法定位箭头。';
  const inverse = hostFrame.clone().invert();
  const bounds = measure(surface.meshes, inverse);
  if (!bounds) return '挂点没有有效几何范围。';
  const worldAxis = channel === 'travel' ? getHorizontalModelAxis(surface.host.root, 'z')
    : getModelAxis(surface.host.root, channel === 'lift' ? 'y' : 'x');
  const along = Vector3.TransformNormal(worldAxis, inverse).normalize();
  let normal = channel === 'lift' || (channel === 'travel' && config.face === 'side') ? Vector3.Right()
    : config.face === 'side' ? Vector3.Forward() : Vector3.Up();
  if (channel === 'lift' || config.face === 'side') {
    // 外置模型常将横向几何旋转成竖直立柱；侧面必须包含真实运动轴，不能锁死挂点的局部 X 法线。
    normal.subtractInPlace(along.scale(Vector3.Dot(normal, along)));
    if (normal.lengthSquared() < 1e-8) {
      normal = Math.abs(along.z) < .9 ? Vector3.Forward() : Vector3.Up();
      normal.subtractInPlace(along.scale(Vector3.Dot(normal, along)));
    }
    normal.normalize();
  } else along.subtractInPlace(normal.scale(Vector3.Dot(along, normal)));
  if (along.lengthSquared() < 1e-10) return '挂点表面与运动方向垂直，请切换顶面/侧面或选择其它挂点。';
  along.normalize();
  const across = Vector3.Cross(normal, along).normalize();
  const half = bounds.maximum.subtract(bounds.minimum).scale(.5);
  const length = channel === 'travel' ? radiusOnAxis(half, along) * 2
    : config.length || Math.min(radiusOnAxis(half, along) * 1.8, channel === 'lift' ? 10000 : 1.8);
  const width = config.width || Math.min(radiusOnAxis(half, across) * 2, channel === 'lift' ? .28 : .38);
  if (!(length > 1e-8 && width > 1e-8)) return '箭头可用长度或宽度为零，请检查挂点几何与尺寸。';
  const center = bounds.minimum.add(bounds.maximum).scale(.5)
    .add(normal.scale(radiusOnAxis(half, normal) + config.surfaceOffset))
    .add(along.scale(channel === 'travel' ? 0 : config.offsetAlong)).add(across.scale(config.offsetAcross));
  const local = Matrix.FromValues(
    along.x * length, along.y * length, along.z * length, 0,
    normal.x, normal.y, normal.z, 0,
    across.x * width, across.y * width, across.z * width, 0,
    center.x, center.y, center.z, 1,
  );
  const frame = model.telemetryProxySource ? hostFrame.multiply(hostRoot.clone().invert()).multiply(model.root.computeWorldMatrix(true)) : hostFrame;
  if (!validArrowMatrix(frame)) return '模型实例变换退化，无法定位箭头。';
  let liftGap: { min: number; max: number } | undefined;
  if (channel === 'lift') {
    // 平台角点直接投影到条带局部 X，避免旋转后的世界 AABB 夸大高度；两段共用相位，缺口只隐藏平台高度。
    const platformBounds = measure(surface.platformMeshes, local.multiply(hostFrame).invert());
    if (!platformBounds) return '载货台几何已失效，升降箭头隐藏。';
    const margin = .03 / length;
    const min = Math.max(0, platformBounds.minimum.x + .5 - margin);
    const max = Math.min(1, platformBounds.maximum.x + .5 + margin);
    if (min < max) liftGap = { min, max };
  }
  return { matrix: local.multiply(frame), length, width, ...(liftGap ? { liftGap } : {}) };
}
