import type { AssetContainer } from '@babylonjs/core/assetContainer.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { ViewerDetails } from '@babylonjs/viewer';

/** partKey 是业务身份；nodePath 仅用于定位当前版本的节点。 */
export interface InspectionPartConfiguration {
  readonly partKey: string;
  readonly name?: string;
  /** 相对于加载根的节点名称路径；'.' 表示加载根。 */
  readonly nodePath?: string;
  /** 世界坐标方向；与 distanceMeters、fixed 一起提供时生成对应的装配组。 */
  readonly axis?: Readonly<{ x: number; y: number; z: number }>;
  readonly distanceMeters?: number;
  readonly fixed?: boolean;
}

/** 位移是 100% 展开时的世界坐标位移，单位为米。 */
export interface InspectionViewerAssemblyGroup {
  readonly id: string;
  readonly partKeys: readonly string[];
  readonly fixed?: boolean;
  readonly worldOffset?: Readonly<{ x: number; y: number; z: number }>;
}

export interface InspectionViewerModelOptions {
  /** 完整的零件配置；通过 nodePath 或 glTF extras.partKey 与节点一一对应。 */
  readonly parts: readonly InspectionPartConfiguration[];
  readonly groups?: readonly InspectionViewerAssemblyGroup[];
  readonly initialPercent?: number;
  /** 模型源单位到米的比例；默认 1，仅缩放此详情模型的加载根。 */
  readonly unitScaleToMeters?: number;
  /** URL 不含可识别扩展名时显式指定 glTF 加载器。 */
  readonly pluginExtension?: '.glb' | '.gltf';
}

export interface InspectionViewerOptions {
  readonly onSelectionChange?: (partKey: string | null) => void;
  readonly onFaulted?: (error: Error) => void;
  /** 仅控制异步创建；创建成功后由调用方调用 dispose。 */
  readonly signal?: AbortSignal;
}

export interface InspectionViewerController {
  /** 新请求使旧请求失效；过期请求以 AbortError 拒绝。 */
  loadModel(url: string, options: InspectionViewerModelOptions): Promise<void>;
  readonly selectedPartKey: string | null;
  readonly explodePercent: number;
  getPartKeys(): readonly string[];
  /** 节点仅供装配等受控适配使用，调用方须保持层级并避免启动动画。 */
  getPartNode(partKey: string): TransformNode | undefined;
  selectPart(partKey: string | null): void;
  /** 坐标为相对画布左上角的 CSS 像素。 */
  pickPart(x: number, y: number): string | null;
  /** null 解除隔离；选中父零件时包含其所有后代。 */
  isolateParts(partKeys: readonly string[] | null): void;
  setExplodePercent(percent: number): void;
  /** 对当前可见姿态取景；无可取景几何时返回 false。 */
  frameAll(): boolean;
  focusPart(partKey: string): boolean;
  /** 恢复装配与可见性、清除选择，并按当前姿态取景。 */
  reset(): void;
  /** 立即停止交互和渲染，等待正在加载的模型结束后释放资源。 */
  dispose(): Promise<void>;
}

// 与 src/runtime/babylon/createEngine.ts 的发布视口规则保持一致，避免引入完整视口模块。
const SOFTWARE_WEBGL_RENDERER_PATTERNS = [
  /swiftshader/i,
  /llvmpipe/i,
  /lavapipe/i,
  /softpipe/i,
  /software (?:adapter|rasterizer|renderer)/i,
  /microsoft basic render driver/i,
  /\bwarp\b/i,
];
const UNKNOWN_WEBGL_RENDERER_PATTERN = /^unknown(?:\s+renderer)?$/i;

function assertInspectionHardwareWebGL(canvas: HTMLCanvasElement): void {
  // 从当前上下文读取，不能依赖 getGlInfo() 在恢复后仍可能保留的旧 renderer 缓存。
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    ?? canvas.getContext('experimental-webgl2' as 'webgl2')
    ?? canvas.getContext('experimental-webgl' as 'webgl');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  const value: unknown = (info && gl?.getParameter(info.UNMASKED_RENDERER_WEBGL))
    || gl?.getParameter(gl.RENDERER);
  const renderer = typeof value === 'string' ? value.trim() : '';
  if (!renderer || UNKNOWN_WEBGL_RENDERER_PATTERN.test(renderer)) {
    throw new Error('无法识别 WebGL renderer，设备详情无法确认硬件 GPU，已阻止加载。');
  }
  if (SOFTWARE_WEBGL_RENDERER_PATTERNS.some((pattern) => pattern.test(renderer))) {
    throw new Error(`检测到软件 WebGL 渲染器（${renderer}）。设备详情要求显卡硬件加速，禁止使用软件 renderer。`);
  }
}

function inspectionViewerStartupError(error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`无法启动设备详情。请检查显卡驱动和系统硬件加速设置。${reason}`, { cause: error });
}

function disposeAfterInspectionStartupFailure(resource: { dispose(): void } | undefined): void {
  if (!resource) return;
  try {
    resource.dispose();
  } catch (error) {
    console.error('[Inspection] 初始化失败后的资源释放出错。', error);
  }
}

type AssemblyController = {
  readonly percent: number;
  setPercent(percent: number): void;
  reset(): void;
  dispose(): void;
};

type ModelState = {
  readonly container: AssetContainer;
  readonly nodes: Map<string, TransformNode>;
  readonly meshParts: Map<AbstractMesh, string>;
  readonly meshes: Set<AbstractMesh>;
  assembly: AssemblyController | null;
  isolatedVisibility: Map<AbstractMesh, boolean> | null;
  isolatedMeshes: Set<AbstractMesh> | null;
  selectedBoxes: Map<AbstractMesh, boolean>;
};

function aborted(): DOMException {
  return new DOMException('Inspection viewer operation was superseded or disposed.', 'AbortError');
}

function requirePartKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error('Inspection partKey must be a non-empty string without surrounding whitespace.');
  }
  return value;
}

function getNodePartKey(node: TransformNode): string | undefined {
  const metadata: unknown = node.metadata;
  if (!metadata || typeof metadata !== 'object' || !('gltf' in metadata)) return undefined;
  const gltf = metadata.gltf;
  if (!gltf || typeof gltf !== 'object' || !('extras' in gltf)) return undefined;
  const extras = gltf.extras;
  if (!extras || typeof extras !== 'object' || !('partKey' in extras)) return undefined;
  return requirePartKey(extras.partKey);
}

function getModelRoot(container: AssetContainer): TransformNode {
  const nodes = new Set<TransformNode>([...container.transformNodes, ...container.meshes]);
  const roots = [...nodes].filter((node) => !node.parent || !nodes.has(node.parent as TransformNode));
  if (roots.length !== 1) throw new Error('Inspection model must have exactly one loaded root.');
  return roots[0];
}

function buildModelState(
  container: AssetContainer,
  root: TransformNode,
  parts: readonly InspectionPartConfiguration[],
): ModelState {
  const allNodes = new Set<TransformNode>([...container.transformNodes, ...container.meshes]);
  const extrasNodes = new Map<string, TransformNode>();
  const children = new Map<TransformNode, Map<string, TransformNode[]>>();
  for (const node of allNodes) {
    const key = getNodePartKey(node);
    if (key !== undefined) {
      if (extrasNodes.has(key)) throw new Error(`Duplicate glTF partKey: ${key}`);
      extrasNodes.set(key, node);
    }
    const parent = node.parent as TransformNode | null;
    if (parent && allNodes.has(parent)) {
      const byName = children.get(parent) ?? new Map<string, TransformNode[]>();
      const matches = byName.get(node.name) ?? [];
      matches.push(node);
      byName.set(node.name, matches);
      children.set(parent, byName);
    }
  }

  const resolvePath = (path: string): TransformNode => {
    if (path === '.') return root;
    if (typeof path !== 'string' || !path || /[,;\r\n]/.test(path)) {
      throw new Error(`Invalid inspection nodePath: ${String(path)}`);
    }
    const segments = path.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error(`Invalid inspection nodePath: ${path}`);
    }
    let current = root;
    for (const segment of segments) {
      const matches = children.get(current)?.get(segment) ?? [];
      if (matches.length !== 1) {
        throw new Error(`Inspection nodePath is ${matches.length ? 'ambiguous' : 'absent'}: ${path}`);
      }
      current = matches[0];
    }
    return current;
  };
  const nodes = new Map<string, TransformNode>();
  const keysByNode = new Map<TransformNode, string>();
  for (const part of parts) {
    const key = requirePartKey(part.partKey);
    if (nodes.has(key)) throw new Error(`Duplicate configured partKey: ${key}`);
    let node = extrasNodes.get(key);
    if (part.nodePath !== undefined) {
      const resolved = resolvePath(part.nodePath);
      if (node && node !== resolved) throw new Error(`nodePath conflicts with glTF partKey: ${key}`);
      node = resolved;
    }
    if (!node) throw new Error(`Configured partKey is absent from the model: ${key}`);
    const nodeKey = getNodePartKey(node);
    if (nodeKey !== undefined && nodeKey !== key) {
      throw new Error(`nodePath conflicts with glTF partKey: ${key}`);
    }
    if (keysByNode.has(node)) {
      throw new Error(`Multiple inspection partKeys map to the same node: ${key}`);
    }
    nodes.set(key, node);
    keysByNode.set(node, key);
  }
  if (nodes.size === 0) throw new Error('Inspection model configuration contains no parts.');
  for (const key of extrasNodes.keys()) {
    if (!nodes.has(key)) throw new Error(`Model partKey is absent from the configuration: ${key}`);
  }

  const meshes = new Set(container.meshes);
  const meshParts = new Map<AbstractMesh, string>();
  for (const mesh of meshes) {
    let node: TransformNode | null = mesh;
    while (node && allNodes.has(node)) {
      const key = keysByNode.get(node);
      if (key !== undefined) {
        meshParts.set(mesh, key);
        break;
      }
      node = node.parent as TransformNode | null;
    }
  }
  return {
    container,
    nodes,
    meshParts,
    meshes,
    assembly: null,
    isolatedVisibility: null,
    isolatedMeshes: null,
    selectedBoxes: new Map(),
  };
}

function isUnderNode(mesh: AbstractMesh, root: TransformNode): boolean {
  return mesh === root || mesh.isDescendantOf(root);
}

function findAssemblyRoot(container: AssetContainer, nodes: readonly TransformNode[]): TransformNode {
  const modelNodes = new Set<TransformNode>([...container.transformNodes, ...container.meshes]);
  const topmost = (node: TransformNode): TransformNode => {
    let current = node;
    while (current.parent && modelNodes.has(current.parent as TransformNode)) {
      current = current.parent as TransformNode;
    }
    return current;
  };
  const root = nodes[0] && topmost(nodes[0]);
  if (!root || nodes.some((node) => topmost(node) !== root)) {
    throw new Error('Inspection assembly groups must belong to one model root.');
  }
  return root;
}

function requirePercent(percent: number): void {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new RangeError('Inspection explode percent must be between 0 and 100.');
  }
}

function resolveAssemblyGroups(options: InspectionViewerModelOptions): readonly InspectionViewerAssemblyGroup[] {
  const hasPartMotion = options.parts.some((part) =>
    part.axis !== undefined || part.distanceMeters !== undefined || part.fixed !== undefined,
  );
  if (options.groups !== undefined) {
    if (hasPartMotion) throw new Error('Specify inspection motion on parts or groups, not both.');
    return options.groups;
  }
  if (!hasPartMotion) return [];
  return options.parts.map((part) => {
    const axis = part.axis;
    const distance = part.distanceMeters;
    if (!axis || ![axis.x, axis.y, axis.z].every(Number.isFinite) ||
        !Number.isFinite(distance) || distance === undefined || distance < 0 ||
        typeof part.fixed !== 'boolean') {
      throw new Error(`Invalid inspection motion configuration for partKey: ${part.partKey}`);
    }
    const scale = Math.max(Math.abs(axis.x), Math.abs(axis.y), Math.abs(axis.z));
    if (scale === 0) throw new Error(`Inspection axis must be nonzero: ${part.partKey}`);
    const x = axis.x / scale;
    const y = axis.y / scale;
    const z = axis.z / scale;
    const length = Math.hypot(x, y, z);
    return {
      id: part.partKey,
      partKeys: [part.partKey],
      fixed: part.fixed,
      worldOffset: { x: x / length * distance, y: y / length * distance, z: z / length * distance },
    };
  });
}

/** 按需创建独立的 Babylon 官方 Viewer；不会创建页面或加载模型。 */
export async function createInspectionViewer(
  canvas: HTMLCanvasElement,
  options: InspectionViewerOptions = {},
): Promise<InspectionViewerController> {
  options.signal?.throwIfAborted();
  const [viewerModule, pointerModule, vectorModule] = await Promise.all([
    import('@babylonjs/viewer'),
    import('@babylonjs/core/Events/pointerEvents.js'),
    import('@babylonjs/core/Maths/math.vector.js'),
    import('@babylonjs/core/Culling/ray.js'),
    import('@babylonjs/core/Meshes/instancedMesh.js'),
    import('@babylonjs/core/Rendering/boundingBoxRenderer.js'),
  ]);
  options.signal?.throwIfAborted();

  let initialized: Readonly<ViewerDetails> | undefined;
  let startupEngine: ConstructorParameters<typeof viewerModule.Viewer>[0] | undefined;
  let startupViewer: InstanceType<typeof viewerModule.Viewer> | undefined;
  let disposed = false;
  let created = false;
  let faulted: Error | null = null;

  // 官方工厂直到返回前才包装 dispose；在此捕获中途已创建的引擎和 Viewer。
  // Viewer 激活模型时会选择并采样动画，因此静态详情始终禁止选择动画。
  class StaticInspectionViewer extends viewerModule.Viewer {
    constructor(...args: ConstructorParameters<typeof viewerModule.Viewer>) {
      const engine = args[0];
      startupEngine = engine;
      try {
        assertInspectionHardwareWebGL(canvas);
        super(...args);
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- 工厂失败时需要销毁尚未返回的 Viewer。
        startupViewer = this;
      } catch (error) {
        startupEngine = undefined;
        disposeAfterInspectionStartupFailure(engine);
        throw error;
      }
    }

    protected override _selectAnimation(_index: number, interpolateCamera?: boolean): void {
      super._selectAnimation(-1, interpolateCamera);
    }
  }

  let viewer: StaticInspectionViewer;
  try {
    viewer = await viewerModule.CreateViewerForCanvas(canvas, {
      engine: 'WebGL',
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: true,
      viewerClass: StaticInspectionViewer,
      animationAutoPlay: false,
      selectedAnimation: -1,
      onInitialized: (details) => { initialized = details; },
      onFaulted: (error) => {
        if (!disposed && (created || !options.signal?.aborted)) options.onFaulted?.(error);
      },
    });
  } catch (error) {
    disposed = true;
    disposeAfterInspectionStartupFailure(startupViewer);
    disposeAfterInspectionStartupFailure(startupEngine);
    if (options.signal?.aborted) options.signal.throwIfAborted();
    throw inspectionViewerStartupError(error);
  }
  if (!initialized || options.signal?.aborted) {
    disposed = true;
    viewer.dispose();
    if (options.signal?.aborted) options.signal.throwIfAborted();
    throw inspectionViewerStartupError(new Error('Babylon Viewer 未提供场景。'));
  }
  created = true;
  const details = initialized;
  const { scene, camera } = details;
  const engine = scene.getEngine();
  const restoredObserver = engine.onContextRestoredObservable.add(() => {
    if (disposed || faulted) return;
    try {
      assertInspectionHardwareWebGL(canvas);
    } catch (error) {
      faulted = new Error(`设备详情的 WebGL 上下文恢复失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
      // 保留暂停令牌，并停止引擎循环，防止 SDK 之后恢复软件渲染。
      for (const stop of [
        () => engine.stopRenderLoop(),
        () => details.suspendRendering(),
        () => camera.detachControl(),
      ]) {
        try {
          stop();
        } catch (stopError) {
          console.error('[Inspection] 停止故障中的详情视口失败。', stopError);
        }
      }
      try {
        options.onFaulted?.(faulted);
      } catch (callbackError) {
        console.error('[Inspection] 详情故障回调失败。', callbackError);
      }
    }
  });
  const { Vector3 } = vectorModule;
  const { PointerEventTypes } = pointerModule;
  let state: ModelState | null = null;
  let selectedPartKey: string | null = null;
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();
  let disposal: Promise<void> | null = null;

  const assertAlive = (): void => {
    if (disposed) throw new Error('Inspection viewer is disposed.');
    if (faulted) throw faulted;
  };
  const requireState = (): ModelState => {
    assertAlive();
    if (!state) throw new Error('No inspection model is loaded.');
    return state;
  };
  const requireNode = (current: ModelState, key: string): TransformNode => {
    const node = current.nodes.get(key);
    if (!node) throw new Error(`Unknown inspection partKey: ${key}`);
    return node;
  };
  const visualMutation = (): void => {
    details.model?.resetWorldBounds();
    details.markSceneMutated();
  };
  const restoreBoxes = (current: ModelState): void => {
    for (const [mesh, original] of current.selectedBoxes) {
      if (!mesh.isDisposed()) mesh.showBoundingBox = original;
    }
    current.selectedBoxes.clear();
  };
  const applyBoxes = (current: ModelState): void => {
    restoreBoxes(current);
    const node = selectedPartKey === null ? undefined : current.nodes.get(selectedPartKey);
    if (!node) return;
    for (const mesh of current.meshes) {
      if (mesh.getTotalVertices() > 0 && isUnderNode(mesh, node)) {
        current.selectedBoxes.set(mesh, mesh.showBoundingBox);
        mesh.showBoundingBox = true;
      }
    }
  };
  const clearState = (notify: boolean): void => {
    if (state) {
      restoreBoxes(state);
      if (state.isolatedVisibility) {
        for (const [mesh, original] of state.isolatedVisibility) {
          if (!mesh.isDisposed()) mesh.isVisible = original;
        }
      }
      state.assembly?.dispose();
      state = null;
    }
    const hadSelection = selectedPartKey !== null;
    selectedPartKey = null;
    if (notify && hadSelection) options.onSelectionChange?.(null);
  };
  const selectPart = (key: string | null): void => {
    const current = requireState();
    if (key !== null) requireNode(current, key);
    if (selectedPartKey === key) return;
    selectedPartKey = key;
    applyBoxes(current);
    details.markSceneMutated();
    options.onSelectionChange?.(key);
  };
  const isVisible = (mesh: AbstractMesh): boolean =>
    !mesh.isDisposed() && mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0 &&
    (mesh.layerMask & camera.layerMask) !== 0;
  const pickPart = (x: number, y: number): string | null => {
    const current = requireState();
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Invalid pick coordinates.');
    const result = scene.pick(x, y, (mesh) =>
      current.meshes.has(mesh) && current.meshParts.has(mesh) &&
      (!current.isolatedMeshes || current.isolatedMeshes.has(mesh)) &&
      isVisible(mesh) && mesh.isPickable,
    );
    return result?.hit && result.pickedMesh ? current.meshParts.get(result.pickedMesh) ?? null : null;
  };
  const frame = (root?: TransformNode): boolean => {
    const current = requireState();
    let minimum: InstanceType<typeof Vector3> | null = null;
    let maximum: InstanceType<typeof Vector3> | null = null;
    for (const mesh of current.meshes) {
      if (!isVisible(mesh) || mesh.getTotalVertices() === 0 ||
          (current.isolatedMeshes && !current.isolatedMeshes.has(mesh)) ||
          (root && !isUnderNode(mesh, root))) continue;
      mesh.refreshBoundingInfo({ applySkeleton: true, applyMorph: true });
      mesh.computeWorldMatrix(true);
      const box = mesh.getBoundingInfo().boundingBox;
      const min = box.minimumWorld;
      const max = box.maximumWorld;
      if (![min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite)) continue;
      minimum = minimum ? Vector3.Minimize(minimum, min) : min.clone();
      maximum = maximum ? Vector3.Maximize(maximum, max) : max.clone();
    }
    if (!minimum || !maximum) return false;

    const center = minimum.add(maximum).scale(0.5);
    const halfDiagonal = Math.max(maximum.subtract(minimum).length() * 0.5, 0.001);
    const engine = scene.getEngine();
    const width = engine.getRenderWidth() * camera.viewport.width;
    const height = engine.getRenderHeight() * camera.viewport.height;
    const aspect = width > 0 && height > 0 ? width / height : 1;
    const halfFov = Math.max(0.001, Math.min(camera.fov * 0.5, Math.PI * 0.499));
    const otherHalfFov = Math.atan(Math.tan(halfFov) * (camera.fovMode === 0 ? aspect : 1 / aspect));
    const radius = halfDiagonal / Math.sin(Math.min(halfFov, otherHalfFov)) * 1.1;
    camera.stopInterpolation();
    camera.inertialAlphaOffset = 0;
    camera.inertialBetaOffset = 0;
    camera.inertialRadiusOffset = 0;
    camera.inertialPanningX = 0;
    camera.inertialPanningY = 0;
    camera.lowerRadiusLimit = radius * 0.001;
    camera.upperRadiusLimit = radius * 20;
    camera.minZ = Math.max(radius * 0.001, 0.00001);
    camera.maxZ = Math.max(radius * 1000, camera.minZ * 10);
    camera.setTarget(center);
    camera.radius = radius;
    details.markSceneMutated();
    return true;
  };
  const frameAll = (): boolean => frame();
  const focusPart = (key: string): boolean => frame(requireNode(requireState(), key));
  const isolateParts = (keys: readonly string[] | null): void => {
    const current = requireState();
    if (keys !== null && keys.length === 0) throw new Error('Use null to clear inspection isolation.');
    const roots = keys?.map((key) => requireNode(current, key)) ?? null;
    if (roots && !current.isolatedVisibility) {
      current.isolatedVisibility = new Map([...current.meshes].map((mesh) => [mesh, mesh.isVisible]));
    }
    current.isolatedMeshes = roots
      ? new Set([...current.meshes].filter((mesh) => roots.some((root) => isUnderNode(mesh, root))))
      : null;
    if (current.isolatedVisibility) {
      for (const [mesh, original] of current.isolatedVisibility) {
        mesh.isVisible = original && (!current.isolatedMeshes || current.isolatedMeshes.has(mesh));
      }
      if (!roots) current.isolatedVisibility = null;
    }
    visualMutation();
  };
  const setExplodePercent = (percent: number): void => {
    const current = requireState();
    requirePercent(percent);
    if (!current.assembly) {
      if (percent !== 0) throw new Error('No inspection assembly groups are configured.');
      return;
    }
    current.assembly.setPercent(percent);
    visualMutation();
  };

  // Viewer 内部先 start 再 pause；必须 stop 才不会保留可采样的动画组。
  const modelObserver = viewer.onModelChanged.add(() => {
    details.model?.assetContainer.animationGroups.forEach((group) => group.stop());
  });
  const pointerObserver = scene.onPointerObservable.add((info) => {
    if (!disposed && !faulted && state && info.event.button === 0) {
      selectPart(pickPart(scene.pointerX, scene.pointerY));
    }
  }, PointerEventTypes.POINTERTAP);
  const prePointerObserver = scene.onPrePointerObservable.add((info) => {
    info.skipOnPointerObservable = true;
    if (!disposed && !faulted && state) {
      const key = pickPart(scene.pointerX, scene.pointerY);
      if (key === null) frameAll();
      else {
        selectPart(key);
        focusPart(key);
      }
    }
  }, PointerEventTypes.POINTERDOUBLETAP);

  const controller: InspectionViewerController = {
    loadModel(url, modelOptions) {
      assertAlive();
      if (typeof url !== 'string' || !url.trim()) throw new Error('An inspection model URL is required.');
      if (modelOptions.initialPercent !== undefined) requirePercent(modelOptions.initialPercent);
      const unitScale = modelOptions.unitScaleToMeters ?? 1;
      if (!Number.isFinite(unitScale) || unitScale <= 0) {
        throw new RangeError('Inspection unitScaleToMeters must be finite and positive.');
      }
      const groups = resolveAssemblyGroups(modelOptions);
      const request = ++generation;
      clearState(true);
      const operation = queue.then(async () => {
        if (faulted) throw faulted;
        if (disposed || request !== generation) throw aborted();
        try {
          // 串行加载避免 Viewer 在内部加载完成前被销毁或被新请求中断后遗留容器。
          await viewer.loadModel(url, {
            pluginExtension: modelOptions.pluginExtension,
            // GLTFLoaderAnimationStartMode.NONE；直接导入 glTFFileLoader 会覆盖 Viewer 的异步加载器注册。
            pluginOptions: { gltf: { animationStartMode: 0 } },
          });
          if (faulted) throw faulted;
          if (disposed || request !== generation) throw aborted();
          const model = details.model;
          if (!model) throw new Error('Babylon Viewer did not expose the loaded model.');
          const root = getModelRoot(model.assetContainer);
          if (![root.scaling.x, root.scaling.y, root.scaling.z].every((value) =>
            Number.isFinite(value * unitScale) && value * unitScale !== 0,
          )) throw new Error('Inspection model root has an invalid unit scale.');
          root.scaling.scaleInPlace(unitScale);
          root.computeWorldMatrix(true);
          const next = buildModelState(model.assetContainer, root, modelOptions.parts);
          if (groups.length) {
            const resolved = groups.map((group) => ({
              id: group.id,
              nodes: group.partKeys.map((key) => requireNode(next, key)),
              fixed: group.fixed,
              worldOffset: group.worldOffset,
            }));
            const root = findAssemblyRoot(next.container, resolved.flatMap((group) => group.nodes));
            const { createInspectionAssemblyController } = await import('./inspectionAssembly');
            if (faulted) throw faulted;
            if (disposed || request !== generation) throw aborted();
            next.assembly = createInspectionAssemblyController({
              root,
              groups: resolved,
              onChange: () => {
                if (!disposed && request === generation) visualMutation();
              },
            });
          }
          state = next;
          setExplodePercent(modelOptions.initialPercent ?? 0);
          visualMutation();
          frameAll();
        } catch (error) {
          if (request === generation) clearState(false);
          // 队列保证此时还没有后续请求取得模型所有权。
          details.model?.dispose();
          if (disposed || request !== generation) throw aborted();
          if (faulted) throw faulted;
          throw error;
        }
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    get selectedPartKey() { return selectedPartKey; },
    get explodePercent() { return state?.assembly?.percent ?? 0; },
    getPartKeys() { return [...requireState().nodes.keys()]; },
    getPartNode(key) { return requireState().nodes.get(key); },
    selectPart,
    pickPart,
    isolateParts,
    setExplodePercent,
    frameAll,
    focusPart,
    reset() {
      const current = requireState();
      current.assembly?.reset();
      isolateParts(null);
      selectPart(null);
      visualMutation();
      frameAll();
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      generation++;
      engine.onContextRestoredObservable.remove(restoredObserver);
      scene.onPointerObservable.remove(pointerObserver);
      scene.onPrePointerObservable.remove(prePointerObserver);
      viewer.onModelChanged.remove(modelObserver);
      clearState(false);
      camera.detachControl();
      // 不释放这个暂停令牌：释放会重新启动已关闭的渲染循环。
      details.suspendRendering();
      disposal = queue.then(() => { viewer.dispose(); });
      return disposal;
    },
  };
  return controller;
}
