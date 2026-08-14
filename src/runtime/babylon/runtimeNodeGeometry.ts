import { AbstractMesh, Matrix, Quaternion, TransformNode, Vector3, type Scene } from '@babylonjs/core';

/** 世界空间轴对齐包围盒。 */
export type RuntimeWorldBounds = {
  minimum: Vector3;
  maximum: Vector3;
};

/** getModelTransformNodes 需要的最小模型结构，ModelRuntimeEntry 天然满足。 */
export type ModelTransformNodeSource = {
  root: TransformNode;
  contentRoot: TransformNode;
  meshes: AbstractMesh[];
};

/** 过滤异常包围盒数值，避免相机被移动到 NaN/Infinity。 */
export function isFiniteVector3(vector: Vector3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

/** 合并两个世界包围盒。 */
export function mergeWorldBounds(left: RuntimeWorldBounds, right: RuntimeWorldBounds): RuntimeWorldBounds {
  return {
    minimum: Vector3.Minimize(left.minimum, right.minimum),
    maximum: Vector3.Maximize(left.maximum, right.maximum),
  };
}

/** 使用一个世界坐标点构造最小可用包围盒。 */
export function createPointWorldBounds(point: Vector3): RuntimeWorldBounds {
  const center = isFiniteVector3(point) ? point : Vector3.Zero();
  const padding = new Vector3(0.25, 0.25, 0.25);

  return {
    minimum: center.subtract(padding),
    maximum: center.add(padding),
  };
}

/** 组合相对矩阵：把源根节点世界系中的点换算到目标根节点世界系（M_target × M_source⁻¹），源变换奇异时返回 null。 */
export function computeRootRelativeWorldMatrix(sourceRoot: TransformNode, targetRoot: TransformNode): Matrix | null {
  sourceRoot.computeWorldMatrix(true);
  targetRoot.computeWorldMatrix(true);
  const inverseSourceWorld = sourceRoot.getWorldMatrix().clone();
  const determinant = inverseSourceWorld.determinant();
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-12) return null;
  inverseSourceWorld.invert();
  return targetRoot.getWorldMatrix().multiply(inverseSourceWorld);
}

/** 世界 AABB 按矩阵变换 8 个角点后重建，旋转/缩放下仍保持轴对齐；出现非法数值时返回 null。 */
export function transformWorldBounds(bounds: RuntimeWorldBounds, matrix: Matrix): RuntimeWorldBounds | null {
  const { minimum, maximum } = bounds;
  const corners = [
    new Vector3(minimum.x, minimum.y, minimum.z),
    new Vector3(minimum.x, minimum.y, maximum.z),
    new Vector3(minimum.x, maximum.y, minimum.z),
    new Vector3(minimum.x, maximum.y, maximum.z),
    new Vector3(maximum.x, minimum.y, minimum.z),
    new Vector3(maximum.x, minimum.y, maximum.z),
    new Vector3(maximum.x, maximum.y, minimum.z),
    new Vector3(maximum.x, maximum.y, maximum.z),
  ];

  let merged: RuntimeWorldBounds | null = null;
  for (const corner of corners) {
    const transformed = Vector3.TransformCoordinates(corner, matrix);
    if (!isFiniteVector3(transformed)) return null;
    const pointBounds = { minimum: transformed, maximum: transformed };
    merged = merged ? mergeWorldBounds(merged, pointBounds) : pointBounds;
  }
  return merged;
}

/** 从 Mesh 的 Babylon BoundingInfo 读取世界空间包围盒。 */
export function getMeshWorldBounds(mesh: AbstractMesh): RuntimeWorldBounds | null {
  mesh.computeWorldMatrix(true);
  const boundingBox = mesh.getBoundingInfo().boundingBox;
  if (!isFiniteVector3(boundingBox.minimumWorld) || !isFiniteVector3(boundingBox.maximumWorld)) return null;

  return {
    minimum: boundingBox.minimumWorld.clone(),
    maximum: boundingBox.maximumWorld.clone(),
  };
}

/** 收集节点自身和后代 Mesh，用于从真实几何范围计算轨道端点。 */
export function getNodeMeshes(node: TransformNode): AbstractMesh[] {
  const meshes = new Set<AbstractMesh>();
  if (node instanceof AbstractMesh) meshes.add(node);
  for (const childMesh of node.getChildMeshes(false)) {
    meshes.add(childMesh);
  }
  return [...meshes];
}

/** 读取单个节点自身或子网格包围盒，没有可见网格时退回节点世界位置。 */
export function getNodeWorldBounds(node: TransformNode): RuntimeWorldBounds | null {
  const meshes = getNodeMeshes(node);
  let mergedBounds: RuntimeWorldBounds | null = null;
  for (const mesh of meshes) {
    const bounds = getMeshWorldBounds(mesh);
    if (!bounds) continue;
    mergedBounds = mergedBounds ? mergeWorldBounds(mergedBounds, bounds) : bounds;
  }

  if (mergedBounds) return mergedBounds;
  node.computeWorldMatrix(true);
  return createPointWorldBounds(node.getAbsolutePosition());
}

/** 合并一组节点及其子网格的世界包围盒。 */
export function getNodesWorldBounds(nodes: TransformNode[]): RuntimeWorldBounds | null {
  let mergedBounds: RuntimeWorldBounds | null = null;
  for (const node of nodes) {
    const bounds = getNodeWorldBounds(node);
    if (!bounds) continue;
    mergedBounds = mergedBounds ? mergeWorldBounds(mergedBounds, bounds) : bounds;
  }
  return mergedBounds;
}

/** 将世界 AABB 投影到任意轴上，使用 8 个角点避免旋转模型时范围偏小。 */
export function projectWorldBoundsOntoAxis(bounds: RuntimeWorldBounds, axis: Vector3): { min: number; max: number } {
  const corners = [
    new Vector3(bounds.minimum.x, bounds.minimum.y, bounds.minimum.z),
    new Vector3(bounds.minimum.x, bounds.minimum.y, bounds.maximum.z),
    new Vector3(bounds.minimum.x, bounds.maximum.y, bounds.minimum.z),
    new Vector3(bounds.minimum.x, bounds.maximum.y, bounds.maximum.z),
    new Vector3(bounds.maximum.x, bounds.minimum.y, bounds.minimum.z),
    new Vector3(bounds.maximum.x, bounds.minimum.y, bounds.maximum.z),
    new Vector3(bounds.maximum.x, bounds.maximum.y, bounds.minimum.z),
    new Vector3(bounds.maximum.x, bounds.maximum.y, bounds.maximum.z),
  ];
  const values = corners.map((corner) => Vector3.Dot(corner, axis));
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** 读取一组节点的世界包围盒在指定轨道轴上的投影范围。 */
export function getNodesProjectedBounds(nodes: TransformNode[], axis: Vector3): { min: number; max: number } | null {
  const bounds = getNodesWorldBounds(nodes);
  return bounds ? projectWorldBoundsOntoAxis(bounds, axis) : null;
}

/** 读取任意节点的世界旋转，货物在叉上跟设备，落位后跟定位框。 */
export function getNodeWorldRotation(node: TransformNode): Quaternion {
  const rotation = Quaternion.Identity();
  node.computeWorldMatrix(true).decompose(undefined, rotation);
  return rotation;
}

/**
 * 读取节点世界位姿（旋转 + 缩放），镜像（负行列式，如 scale.z=-1）由缩放符号保留。
 * Matrix.decompose 无法把镜像表达为 quaternion，会把翻转折进旋转，导致货物落位后朝下。
 */
export function getNodeWorldPosePreservingMirror(node: TransformNode): { rotation: Quaternion; scaling: Vector3 } {
  const m = node.computeWorldMatrix(true).m;
  const sx = Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]);
  const sy = Math.sqrt(m[4] * m[4] + m[5] * m[5] + m[6] * m[6]);
  let sz = Math.sqrt(m[8] * m[8] + m[9] * m[9] + m[10] * m[10]);
  // 镜像轴取 z：R'·S' 与原矩阵恒等，渲染结果与完整世界矩阵一致
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  if (det < 0) sz = -sz;
  const rotationMatrix = Matrix.FromArray([
    m[0] / sx, m[1] / sx, m[2] / sx, 0,
    m[4] / sy, m[5] / sy, m[6] / sy, 0,
    m[8] / sz, m[9] / sz, m[10] / sz, 0,
    0, 0, 0, 1,
  ]);
  return {
    rotation: Quaternion.FromRotationMatrix(rotationMatrix),
    scaling: new Vector3(sx, sy, sz),
  };
}

/** 创建局部坐标轴单位向量。 */
export function createLocalAxis(axis: 'x' | 'y' | 'z'): Vector3 {
  if (axis === 'x') return new Vector3(1, 0, 0);
  if (axis === 'y') return new Vector3(0, 1, 0);
  return new Vector3(0, 0, 1);
}

/** 归一化向量，异常时使用兜底方向。 */
export function normalizeVector(vector: Vector3, fallback: Vector3): Vector3 {
  const length = vector.length();
  if (!Number.isFinite(length) || length <= 0.000001) return fallback.clone();
  return vector.scale(1 / length);
}

/** 读取模型局部轴在世界空间中的方向，用于升降和货叉动作适配旋转后的模型。 */
export function getModelAxis(root: TransformNode, axis: 'x' | 'y' | 'z'): Vector3 {
  const localAxis = createLocalAxis(axis);
  const worldMatrix = root.computeWorldMatrix(true);
  const worldAxis = Vector3.TransformNormal(localAxis, worldMatrix);
  return normalizeVector(worldAxis, localAxis);
}

/** 读取模型局部轴在世界空间中的水平投影，用于把 distance_x 映射到行走方向。 */
export function getHorizontalModelAxis(root: TransformNode, axis: 'x' | 'z'): Vector3 {
  const worldAxis = getModelAxis(root, axis);
  worldAxis.y = 0;
  return normalizeVector(worldAxis, axis === 'x' ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1));
}

/** 把目标点投影到轨道轴上，保证有目标位时只沿轨道移动。 */
export function projectPointOntoAxis(origin: Vector3, axis: Vector3, point: Vector3): Vector3 {
  const distance = Vector3.Dot(point.subtract(origin), axis);
  return origin.add(axis.scale(distance));
}

/** 把世界位移转换为节点父级本地位移，避免 contentRoot 源单位缩放导致位移量错误。 */
export function worldDeltaToParentLocalDelta(node: TransformNode, worldOffset: Vector3): Vector3 {
  const parent = node.parent;
  const parentWorldMatrix = parent?.computeWorldMatrix?.(true) ?? parent?.getWorldMatrix?.();
  const inverseParentWorldMatrix = parentWorldMatrix?.clone?.();
  if (!inverseParentWorldMatrix?.invert) return worldOffset.clone();
  inverseParentWorldMatrix.invert();
  return Vector3.TransformNormal(worldOffset, inverseParentWorldMatrix);
}

/** 按引用去重 TransformNode 数组。 */
export function uniqueTransformNodes(nodes: TransformNode[]): TransformNode[] {
  return [...new Set(nodes)];
}

/** 过滤同一运动分组中的子级节点，避免父子同时写入相同动作后产生双倍位移。 */
export function filterTopLevelMotionNodes(nodes: TransformNode[]): TransformNode[] {
  const uniqueNodes = uniqueTransformNodes(nodes);
  return uniqueNodes.filter((node) => {
    return !uniqueNodes.some((candidate) => candidate !== node && node.isDescendantOf?.(candidate));
  });
}

/** 汇总模型内容根节点、TransformNode 与 Mesh，过滤模型实体根节点本身。 */
export function getModelTransformNodes(model: ModelTransformNodeSource, scene: Scene): TransformNode[] {
  const nodes = [
    model.contentRoot,
    ...model.root.getChildTransformNodes(false),
    ...model.meshes,
    ...scene.transformNodes,
    ...scene.meshes,
  ].filter((node) => node !== model.root && node.isDescendantOf?.(model.root));

  return uniqueTransformNodes(nodes);
}

/** 在导入模型子树中按精确名称查找节点。 */
export function findModelNodesByName(model: ModelTransformNodeSource, scene: Scene, names: string[]): TransformNode[] {
  const nameSet = new Set(names);
  return getModelTransformNodes(model, scene).filter((node) => nameSet.has(String(node.name ?? '')));
}

/** 在导入模型子树中按名称正则查找节点。 */
export function findModelNodes(model: ModelTransformNodeSource, scene: Scene, pattern: RegExp): TransformNode[] {
  return getModelTransformNodes(model, scene).filter((node) => pattern.test(String(node.name ?? '')));
}

/** 数值线性插值。 */
export function lerpNumber(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

/** 向目标数值移动指定最大步长。 */
export function moveNumberTowards(from: number, to: number, maxDelta: number): number {
  const delta = to - from;
  if (Math.abs(delta) <= maxDelta) return to;
  return from + Math.sign(delta) * maxDelta;
}

/** 向目标向量移动指定最大步长。 */
export function moveVectorTowards(from: Vector3, to: Vector3, maxDelta: number): Vector3 {
  const delta = to.subtract(from);
  const distance = delta.length();
  if (distance <= maxDelta || distance <= 0.000001) return to.clone();
  return from.add(delta.scale(maxDelta / distance));
}

/** 向量线性插值。 */
export function lerpVector(from: Vector3, to: Vector3, alpha: number): Vector3 {
  return from.add(to.subtract(from).scale(alpha));
}

/** 将数值限制在闭区间内。 */
export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
