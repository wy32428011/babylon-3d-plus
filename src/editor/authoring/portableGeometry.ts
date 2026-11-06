/**
 * 可嵌入生成脚本的完整闭包，无模块级运行依赖。
 * evaluate 必须注入 createExpressionEvaluator().evaluateExpression；不提供时仅接受数值字面量。
 * 坐标约定：剥离 contentRoot 的世界摆放，再乘一次单位倍率，得到模型米制坐标。
 */
export function createAuthoringGeometry(
  B: any,
  root: any,
  options: { unitScale?: number; evaluate?: (expression: string, values: Record<string, any>) => number } = {},
) {
  type V3 = [number, number, number];
  type Issue = { code: string; message: string; severity: 'error' | 'warning'; ruleId?: string; nodeId?: string };
  type NodeInfo = {
    id: string; name: string; selector: { name: string; path: string[]; occurrence: number; gltfPointer?: string };
    parentId?: string; isMesh: boolean; vertexCount: number; indexCount: number; geometryFingerprint: string;
    bounds: { min: V3; max: V3 }; materialName?: string; hasUV?: boolean;
  };
  type Baseline = {
    id: string; mesh: any; geometry: any; positions: number[]; normals: number[] | null; tangents: number[] | null;
    indices: number[]; model: any; material: any; visible: boolean; visibility: number; enabled: boolean;
    subMeshes: number[][]; topology: string;
  };
  type Work = {
    base: Baseline; positions: number[]; normals: number[] | null; tangents: number[] | null;
    visible: boolean; visibility: number; color?: string; dirty: boolean;
  };
  type Generated = { sourceId: string; mesh: any };
  type Stage = { work: Work; geometry: any; material: any };
  const epsilon = 1e-10;
  const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
  const axes = ['x', 'y', 'z'];
  const unitScale = options.unitScale ?? Math.abs(root.scaling?.x ?? 1);
  if (!Number.isFinite(unitScale) || unitScale <= 0) throw new Error('模型单位倍率必须为正数');
  const scene = root.getScene();
  const ownedObjects = new WeakSet<object>();
  let nodes: NodeInfo[] = [];
  const meshes = new Map<string, any>();
  let baselines = new Map<string, Baseline>();
  const anchorReferences = new Map<string, Baseline>();
  let generated: Generated[] = [];
  let ownedGeometries = new Set<any>();
  let ownedMaterials = new Set<any>();
  let pendingObjects: Generated[] = [];
  let pendingGeometries = new Set<any>();
  let pendingMaterials = new Set<any>();
  let revision = 0;
  let serial = 0;
  let lastSignature = '';
  let restored = true;
  let disposed = false;
  const resourceName = (kind: string) => `__authoring_${kind}_${++serial}`;
  const vector = (v: ArrayLike<number>) => new B.Vector3(v[0], v[1], v[2]);
  const tuple = (v: any): V3 => [v.x, v.y, v.z];
  function checkFinite(value: number, label: string): number {
    if (!Number.isFinite(value)) throw new Error(`${label}不是有限数值`);
    return value;
  }
  function evaluate(expression: string, values: Record<string, any>): number {
    if (options.evaluate) return checkFinite(options.evaluate(expression, values), '表达式结果');
    if (typeof expression !== 'string' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(expression.trim())) {
      throw new Error('未注入安全表达式求值器 options.evaluate');
    }
    return checkFinite(Number(expression), '表达式结果');
  }
  function getModelMatrix(mesh: any) {
    root.computeWorldMatrix(true);
    mesh.computeWorldMatrix(true);
    const rootWorld = root.getWorldMatrix();
    if (Math.abs(rootWorld.determinant()) < Number.MIN_VALUE || !Number.isFinite(rootWorld.determinant())) throw new Error('模型根矩阵不可逆');
    return mesh.getWorldMatrix().multiply(rootWorld.clone().invert()).multiply(B.Matrix.Scaling(unitScale, unitScale, unitScale));
  }
  function invert(matrix: any) {
    const determinant = matrix.determinant();
    if (!Number.isFinite(determinant) || determinant === 0) throw new Error('目标节点变换不可逆');
    return matrix.clone().invert();
  }
  function mapPoints(positions: ArrayLike<number>, matrix: any): number[] {
    const result = new Array<number>(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      const p = B.Vector3.TransformCoordinates(new B.Vector3(positions[i], positions[i + 1], positions[i + 2]), matrix);
      result[i] = checkFinite(p.x, '顶点'); result[i + 1] = checkFinite(p.y, '顶点'); result[i + 2] = checkFinite(p.z, '顶点');
    }
    return result;
  }
  function mapDirections(data: number[] | null, matrix: any, stride: number): number[] | null {
    if (!data) return null;
    const result = data.slice();
    for (let i = 0; i < data.length; i += stride) {
      const v = B.Vector3.TransformNormal(new B.Vector3(data[i], data[i + 1], data[i + 2]), matrix);
      if (v.lengthSquared() > 0) v.normalize();
      result[i] = v.x; result[i + 1] = v.y; result[i + 2] = v.z;
    }
    return result;
  }
  function bounds(positions: number[]): { min: V3; max: V3 } {
    const min: V3 = [Infinity, Infinity, Infinity]; const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], positions[i + axis]); max[axis] = Math.max(max[axis], positions[i + axis]);
      }
    }
    return { min, max };
  }
  function hash(arrays: ArrayLike<number>[]): string {
    // 对数值的 IEEE 字节做双摘要，不依赖运行时 uniqueId、缓冲区类型或区域设置。
    let a = 2166136261; let b = 3339675911;
    const view = new DataView(new ArrayBuffer(8));
    for (const array of arrays) {
      const feed = (value: number) => {
        view.setFloat64(0, value, true);
        for (let byte = 0; byte < 8; byte++) {
          const n = view.getUint8(byte);
          a = Math.imul(a ^ n, 16777619); b = Math.imul(b ^ n, 2246822519);
        }
      };
      feed(array.length);
      for (let i = 0; i < array.length; i++) feed(array[i]);
    }
    return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
  }
  function subMeshesOf(mesh: any): number[][] {
    return (mesh.subMeshes ?? []).map((sub: any) => [sub.materialIndex, sub.verticesStart, sub.verticesCount, sub.indexStart, sub.indexCount]);
  }
  function setSubMeshes(mesh: any, descriptions: number[][]) {
    if (!descriptions.length) return;
    mesh.releaseSubMeshes();
    for (const description of descriptions) new B.SubMesh(...description, mesh);
  }
  function collect() {
    const candidates: any[] = root.getDescendants(false).filter((node: any) => !ownedObjects.has(node) && !node.isDisposed?.() && typeof node.computeWorldMatrix === 'function');
    if (root.getTotalVertices?.() > 0) candidates.unshift(root);
    const pointerCounts = new Map<string, number>();
    const descriptors = candidates.map(node => {
      const chain: any[] = [];
      let cursor = node;
      while (cursor && cursor !== root) { chain.unshift(cursor); cursor = cursor.parent; }
      const encoded: string[] = [];
      let occurrence = 0;
      for (const item of chain) {
        const siblings = item.parent?.getChildren(undefined, true) ?? [item];
        occurrence = siblings.filter((sibling: any) => sibling.name === item.name && !ownedObjects.has(sibling)).indexOf(item);
        encoded.push(`${encodeURIComponent(item.name ?? '')}[${Math.max(0, occurrence)}]`);
      }
      const pointers = node._internalMetadata?.gltf?.pointers ?? node.metadata?.gltf?.pointers ?? [];
      const pointer = Array.isArray(pointers) ? pointers.find((value: unknown) => typeof value === 'string' && /^\/nodes\/\d+(?:\/|$)/.test(value)) : undefined;
      if (pointer) pointerCounts.set(pointer, (pointerCounts.get(pointer) ?? 0) + 1);
      return { node, path: chain.map(item => String(item.name ?? '')), encoded: encoded.join('/'), occurrence: Math.max(0, occurrence), pointer };
    });
    const ids = new Map<any, string>();
    for (const item of descriptors) {
      const id = item.pointer ? `node:gltf:${encodeURIComponent(item.pointer)}${pointerCounts.get(item.pointer)! > 1 ? `:${item.encoded}` : ''}` : `node:path:${item.encoded || '$root'}`;
      if ([...ids.values()].includes(id)) throw new Error(`源节点定位不唯一：${item.node.name}`);
      ids.set(item.node, id);
    }
    const nextBaselines = new Map<string, Baseline>();
    const nextNodes: NodeInfo[] = [];
    meshes.clear();
    for (const item of descriptors) {
      const mesh = item.node;
      const id = ids.get(mesh)!;
      const raw = mesh.getVerticesData?.(B.VertexBuffer.PositionKind);
      const isMesh = !!raw?.length;
      let box: { min: V3; max: V3 } = { min: [0, 0, 0], max: [0, 0, 0] };
      let fingerprint = ''; let vertexCount = 0; let indexCount = 0;
      if (isMesh) {
        const positions = Array.from(raw as ArrayLike<number>);
        const indices = Array.from((mesh.getIndices?.() ?? []) as ArrayLike<number>);
        const normalData = mesh.getVerticesData?.(B.VertexBuffer.NormalKind);
        const tangentData = mesh.getVerticesData?.(B.VertexBuffer.TangentKind);
        const uv = mesh.getVerticesData?.(B.VertexBuffer.UVKind) ?? [];
        const model = getModelMatrix(mesh);
        box = bounds(mapPoints(positions, model));
        fingerprint = `g1:${hash([positions, indices, uv])}`;
        vertexCount = positions.length / 3; indexCount = indices.length;
        const base: Baseline = {
          id, mesh, geometry: mesh.geometry, positions, indices, model,
          normals: normalData ? Array.from(normalData as ArrayLike<number>) : null,
          tangents: tangentData ? Array.from(tangentData as ArrayLike<number>) : null,
          material: mesh.material, visible: mesh.isVisible, visibility: mesh.visibility,
          enabled: mesh.isEnabled(false), subMeshes: subMeshesOf(mesh), topology: hash([[vertexCount], indices]),
        };
        nextBaselines.set(id, base); meshes.set(id, mesh);
        if (!anchorReferences.has(id)) anchorReferences.set(id, base);
      }
      nextNodes.push({
        id, name: String(mesh.name ?? ''), selector: { name: String(mesh.name ?? ''), path: item.path, occurrence: item.occurrence, ...(item.pointer ? { gltfPointer: item.pointer } : {}) },
        ...(ids.has(mesh.parent) ? { parentId: ids.get(mesh.parent) } : {}), isMesh, vertexCount, indexCount,
        geometryFingerprint: fingerprint, bounds: box, materialName: mesh.material?.name,
        hasUV: isMesh && !!mesh.isVerticesDataPresent?.(B.VertexBuffer.UVKind),
      });
    }
    // 变换节点以所有后代网格的米制包围盒表示，支持直接选择组件父节点。
    const lookup = new Map(nextNodes.map(node => [node.id, node]));
    for (const node of nextNodes.filter(item => !item.isMesh)) {
      const boxes = nextNodes.filter(child => {
        if (!child.isMesh) return false;
        let parent = child.parentId;
        while (parent) { if (parent === node.id) return true; parent = lookup.get(parent)?.parentId; }
        return false;
      }).map(child => child.bounds);
      if (boxes.length) node.bounds = {
        min: axes.map((_, axis) => Math.min(...boxes.map(box => box.min[axis]))) as V3,
        max: axes.map((_, axis) => Math.max(...boxes.map(box => box.max[axis]))) as V3,
      };
    }
    baselines = nextBaselines; nodes = nextNodes;
  }
  function inspect(): NodeInfo[] {
    return nodes.map(node => ({ ...node, selector: { ...node.selector, path: [...node.selector.path] }, bounds: { min: [...node.bounds.min], max: [...node.bounds.max] } }));
  }
  function expand(targets: string[]): string[] {
    if (!Array.isArray(targets) || !targets.length) throw new Error('规则没有目标节点');
    const lookup = new Map(nodes.map(node => [node.id, node]));
    for (const id of targets) if (!lookup.has(id)) throw new Error(`找不到目标节点 ${id}，请重新绑定`);
    const result: string[] = [];
    for (const id of baselines.keys()) {
      let cursor: string | undefined = id;
      while (cursor) {
        if (targets.includes(cursor)) { result.push(id); break; }
        cursor = lookup.get(cursor)?.parentId;
      }
    }
    if (!result.length) throw new Error('目标节点没有可操作的网格');
    return result;
  }
  function makeWork(base: Baseline): Work {
    return {
      base, positions: mapPoints(base.positions, base.model),
      normals: mapDirections(base.normals, invert(base.model).transpose(), 3),
      tangents: mapDirections(base.tangents, base.model, 4), visible: base.visible,
      visibility: base.visibility, dirty: false,
    };
  }
  function groupBounds(works: Work[]) {
    const boxes = works.map(work => bounds(work.positions));
    return {
      min: axes.map((_, axis) => Math.min(...boxes.map(box => box.min[axis]))) as V3,
      max: axes.map((_, axis) => Math.max(...boxes.map(box => box.max[axis]))) as V3,
    };
  }
  function normalize(data: number[], index: number) {
    const length = Math.hypot(data[index], data[index + 1], data[index + 2]);
    if (length > 0) for (let axis = 0; axis < 3; axis++) data[index + axis] /= length;
  }
  function deform(work: Work, axis: number, mapping: (value: number) => { value: number; derivative: number }) {
    for (let i = 0; i < work.positions.length; i += 3) {
      const mapped = mapping(work.positions[i + axis]);
      work.positions[i + axis] = checkFinite(mapped.value, '变形顶点');
      if (!Number.isFinite(mapped.derivative) || mapped.derivative <= 0) throw new Error('变形比例必须为正数');
      if (work.normals) { work.normals[i + axis] /= mapped.derivative; normalize(work.normals, i); }
      if (work.tangents) { const j = i / 3 * 4; work.tangents[j + axis] *= mapped.derivative; normalize(work.tangents, j); }
    }
    work.dirty = true;
  }
  function translate(work: Work, offset: V3) {
    for (let i = 0; i < work.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) work.positions[i + axis] = checkFinite(work.positions[i + axis] + offset[axis], '平移顶点');
    }
    if (offset.some(value => value !== 0)) work.dirty = true;
  }
  function ensureEditable(base: Baseline, operation: string) {
    if (!base.geometry || typeof base.geometry.copy !== 'function' || typeof base.mesh.clone !== 'function' || base.mesh.sourceMesh) {
      throw new Error(`${base.mesh.name} 是源实例或不支持独立几何，不能执行 ${operation}`);
    }
    if (base.mesh.skeleton || base.mesh.morphTargetManager?.numTargets > 0 || base.mesh.hasThinInstances) {
      throw new Error(`${base.mesh.name} 包含骨骼、变形目标或薄实例，不能安全执行 ${operation}`);
    }
    if (base.mesh.instances?.length > 0) throw new Error(`${base.mesh.name} 被源实例引用，不能安全执行 ${operation}`);
  }
  function colorValue(expression: string, values: Record<string, any>): string {
    let value = own(values, expression) ? values[expression] : expression;
    if (typeof value !== 'string' || !/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(value)) throw new Error('颜色需要颜色参数 key 或 #RGB / #RRGGBB');
    if (value.length === 4) value = `#${[...value.slice(1)].map(character => character + character).join('')}`;
    return value;
  }
  function cloneColorMaterial(material: any, color: string, resources: Set<any>, memo = new Map<any, any>()): any {
    if (!material) throw new Error('目标没有可改色材质');
    if (memo.has(material)) return memo.get(material);
    let clone: any;
    if (material.getClassName?.() === 'MultiMaterial') {
      clone = new B.MultiMaterial(resourceName('material'), scene);
      resources.add(clone); memo.set(material, clone);
      clone.subMaterials = material.subMaterials.map((sub: any) => sub ? cloneColorMaterial(sub, color, resources, memo) : null);
      return clone;
    }
    const field = material.albedoColor ? 'albedoColor' : material.diffuseColor ? 'diffuseColor' : material.baseColor ? 'baseColor' : null;
    if (!field || !['StandardMaterial', 'PBRMaterial', 'PBRMetallicRoughnessMaterial', 'PBRSpecularGlossinessMaterial'].includes(material.getClassName?.())) throw new Error(`材质 ${material.name} 不支持安全改色`);
    clone = material.clone(resourceName('material'));
    if (!clone || clone === material) throw new Error('无法隔离目标材质');
    resources.add(clone); memo.set(material, clone);
    clone[field] = B.Color3.FromHexString(color);
    return clone;
  }
  function makeGeometry(work: Work, resources: Set<any>) {
    const geometry = work.base.geometry.copy(resourceName('geometry'));
    resources.add(geometry);
    const localPositions = mapPoints(work.positions, invert(work.base.model));
    const positions = new Float32Array(localPositions);
    if (positions.some(value => !Number.isFinite(value))) throw new Error('几何坐标超出顶点缓冲区范围');
    geometry.setVerticesData(B.VertexBuffer.PositionKind, positions, true, 3);
    const normals = mapDirections(work.normals, work.base.model.transpose(), 3);
    if (normals) geometry.setVerticesData(B.VertexBuffer.NormalKind, new Float32Array(normals), true, 3);
    const tangents = mapDirections(work.tangents, invert(work.base.model), 4);
    if (tangents) geometry.setVerticesData(B.VertexBuffer.TangentKind, new Float32Array(tangents), true, 4);
    return geometry;
  }
  function cleanup(objects: Generated[], geometries: Set<any>, materials: Set<any>): Issue[] {
    const warnings: Issue[] = [];
    const allObjects = [...pendingObjects, ...objects];
    const allGeometries = new Set([...pendingGeometries, ...geometries]);
    const allMaterials = new Set([...pendingMaterials, ...materials]);
    pendingObjects = []; pendingGeometries = new Set(); pendingMaterials = new Set();
    const warning = (error: unknown) => warnings.push({ code: 'geometry.cleanup', severity: 'warning', message: `自有资源释放失败，将保留待重试：${error instanceof Error ? error.message : String(error)}` });
    for (const item of allObjects) {
      try { if (!item.mesh.isDisposed()) item.mesh.dispose(true, false); }
      catch (error) { item.mesh.setEnabled(false); pendingObjects.push(item); warning(error); }
    }
    for (const geometry of allGeometries) {
      try { if (!geometry.isDisposed?.()) geometry.dispose(); }
      catch (error) { pendingGeometries.add(geometry); warning(error); }
    }
    for (const material of allMaterials) {
      try { material.dispose(false, false); }
      catch (error) { pendingMaterials.add(material); warning(error); }
    }
    return warnings;
  }
  function apply(project: any, values: Record<string, any>): { ok: boolean; issues: Issue[] } {
    const issues: Issue[] = [];
    let activeRule: string | undefined;
    const nextGeometries = new Set<any>(); const nextMaterials = new Set<any>();
    const nextGenerated: Generated[] = [];
    try {
      if (disposed) throw new Error('几何运行器已释放');
      if (!project || !Array.isArray(project.rules) || !Array.isArray(project.nodes)) throw new Error('工程规则或节点列表无效');
      const budget = project.limits?.maxInstances ?? 1000;
      if (!Number.isInteger(budget) || budget < 1 || budget > 1000) throw new Error('实例预算必须为 1–1000 的整数');
      if (project.source && Math.abs(project.source.unitScale - unitScale) > Math.max(1, unitScale) * 1e-10) throw new Error('工程单位倍率与模型根不一致');
      const signature = JSON.stringify([project.rules, project.nodes.map((node: any) => [node.id, node.geometryFingerprint]), !!project.legacy?.enabled, budget, values]);
      if (signature === lastSignature && !restored) return { ok: true, issues: [] };
      const work = new Map<string, Work>();
      const getWork = (id: string) => {
        if (!work.has(id)) work.set(id, makeWork(baselines.get(id)!));
        return work.get(id)!;
      };
      const expectedNodes = new Map<string, any>(project.nodes.map((node: any) => [node.id, node]));
      const writers = new Map<string, string>();
      const rules = project.rules.filter((rule: any) => rule.enabled).map((rule: any) => {
        activeRule = rule.id;
        if (!['resize', 'stretch', 'translate', 'rotate', 'array', 'visibility', 'color'].includes(rule.type)) throw new Error('规则类型无效');
        if (!axes.includes(rule.axis) || !['min', 'center', 'max'].includes(rule.anchor)) throw new Error('规则轴或锚点无效');
        const targets = expand(rule.targets);
        const channel = rule.type === 'resize' || rule.type === 'stretch' ? `dimension:${rule.axis}`
          : rule.type === 'translate' ? `translate:${rule.axis}` : rule.type === 'rotate' ? 'rotate' : rule.type;
        for (const id of targets) {
          const expected = expectedNodes.get(id);
          const actual = nodes.find(node => node.id === id)!;
          if (!expected) throw new Error(`工程缺少目标 ${actual.name} 的源节点记录`);
          if (!project.legacy?.enabled && expected.geometryFingerprint && expected.geometryFingerprint !== actual.geometryFingerprint) throw new Error(`${actual.name} 的源几何已改变，请重新绑定`);
          const key = `${id}/${channel}`;
          if (writers.has(key)) throw new Error(`与规则 ${writers.get(key)} 重复写入 ${actual.name} 的同一属性`);
          writers.set(key, rule.id);
          if (!['visibility', 'color'].includes(rule.type)) ensureEditable(baselines.get(id)!, rule.type);
          if (rule.type === 'color' && (baselines.get(id)!.mesh.sourceMesh || baselines.get(id)!.mesh.instances?.length)) throw new Error(`${actual.name} 使用共享实例材质，不能独立改色`);
        }
        return { rule, targets };
      });
      // 固定组合语义，不依赖卡片的偶然排列：尺寸→旋转→平移→显隐/颜色→阵列。
      const phase: Record<string, number> = { resize: 0, stretch: 0, rotate: 1, translate: 2, visibility: 3, color: 3, array: 4 };
      rules.sort((a: any, b: any) => phase[a.rule.type] - phase[b.rule.type] || axes.indexOf(a.rule.axis) - axes.indexOf(b.rule.axis) || String(a.rule.id).localeCompare(String(b.rule.id)));
      const arrayPlans: { targets: string[]; counts: V3; steps: V3; start: V3; ruleId: string }[] = [];
      let arrayInstances = 0;
      for (const { rule, targets } of rules) {
        activeRule = rule.id;
        const works = targets.map(getWork);
        const axis = axes.indexOf(rule.axis);
        const box = groupBounds(works);
        const extent = box.max[axis] - box.min[axis];
        const factor = rule.anchor === 'min' ? 0 : rule.anchor === 'center' ? 0.5 : 1;
        if (rule.type === 'array') {
          if (rule.arrayMode !== undefined && !['count', 'fill'].includes(rule.arrayMode)) throw new Error('阵列模式无效');
          if ((rule.counts && (!Array.isArray(rule.counts) || rule.counts.length !== 3)) || (rule.steps && (!Array.isArray(rule.steps) || rule.steps.length !== 3))) throw new Error('阵列数量和步距必须包含三个轴');
          const counts: V3 = [1, 1, 1];
          const steps: V3 = [0, 0, 0];
          for (let a = 0; a < 3; a++) {
            if (!(rule.arrayMode === 'fill' && a === axis)) counts[a] = evaluate(rule.counts?.[a] ?? (a === axis ? rule.expression : '1'), values);
            steps[a] = rule.steps ? evaluate(rule.steps[a], values) : box.max[a] - box.min[a];
          }
          if (rule.arrayMode === 'fill') {
            const span = evaluate(rule.fillSpan || rule.expression, values);
            const gap = evaluate(rule.gap || '0', values);
            if (gap < 0 || extent <= epsilon || span < extent - epsilon) throw new Error('填充跨度不足一个源组件，或间隙/源尺寸无效');
            steps[axis] = extent + gap;
            counts[axis] = Math.floor((span + gap) / steps[axis] + 1e-10);
          }
          if (counts.some(count => !Number.isSafeInteger(count) || count < 1)) throw new Error('阵列数量必须为正整数，包含源组件');
          for (let a = 0; a < 3; a++) if (counts[a] > 1 && Math.abs(steps[a]) <= epsilon) throw new Error('多件阵列的步距不能为零');
          const total = counts[0] * counts[1] * counts[2];
          if (!Number.isSafeInteger(total) || total > budget || (arrayInstances += total * targets.length) > budget) throw new Error(`阵列超过 ${budget} 个网格预算，已拒绝整次更新，不截断`);
          const start = steps.map((step, a) => {
            const span = (counts[a] - 1) * step;
            return -Math.min(0, span) - Math.abs(span) * factor;
          }) as V3;
          arrayPlans.push({ targets, counts, steps, start, ruleId: rule.id });
          continue;
        }
        if (rule.type === 'color') {
          const color = colorValue(rule.expression, values);
          for (const item of works) item.color = color;
          continue;
        }
        const value = evaluate(rule.expression, values);
        if (rule.type === 'visibility') {
          for (const item of works) {
            item.visible = value !== 0;
            item.visibility = value !== 0 && item.base.visibility === 0 ? 1 : item.base.visibility;
          }
          continue;
        }
        if (rule.type === 'resize' || rule.type === 'stretch') {
          if (value <= 0 || extent <= epsilon) throw new Error('目标尺寸必须为正数，源轴尺寸不能为零');
          const targetMin = box.min[axis] + (extent - value) * factor;
          if (rule.type === 'resize') {
            const ratio = value / extent;
            for (const item of works) deform(item, axis, position => ({ value: targetMin + (position - box.min[axis]) * ratio, derivative: ratio }));
          } else {
            const start = rule.fixedStart ?? 0; const end = rule.fixedEnd ?? 0;
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0 || start + end >= extent - epsilon || start + end >= value - epsilon) throw new Error('两固定端必须非负，且源尺寸和目标尺寸都必须容纳伸缩区');
            const ratio = (value - start - end) / (extent - start - end);
            for (const item of works) deform(item, axis, position => {
              const relative = position - box.min[axis];
              if (relative <= start) return { value: targetMin + relative, derivative: 1 };
              if (relative >= extent - end) return { value: targetMin + value - (extent - relative), derivative: 1 };
              return { value: targetMin + start + (relative - start) * ratio, derivative: ratio };
            });
          }
        } else if (rule.type === 'translate') {
          const offset: V3 = [0, 0, 0]; offset[axis] = value;
          for (const item of works) translate(item, offset);
        } else if (rule.type === 'rotate') {
          const center = box.min.map((min, a) => min + (box.max[a] - min) * factor) as V3;
          const direction: V3 = [0, 0, 0]; direction[axis] = 1;
          const rotation = B.Matrix.RotationAxis(vector(direction), value * Math.PI / 180);
          for (const item of works) {
            translate(item, center.map(number => -number) as V3);
            item.positions = mapPoints(item.positions, rotation);
            item.normals = mapDirections(item.normals, rotation, 3);
            item.tangents = mapDirections(item.tangents, rotation, 4);
            translate(item, center); item.dirty = true;
          }
        }
      }
      for (const plan of arrayPlans) for (const id of plan.targets) translate(getWork(id), plan.start);
      const stages = new Map<string, Stage>();
      for (const [id, base] of baselines) {
        const item = work.get(id);
        // 没有规则的节点也恢复基线，删除规则时不会遗留旧效果。
        if (!item) continue;
        stages.set(id, {
          work: item, geometry: item.dirty ? makeGeometry(item, nextGeometries) : base.geometry,
          material: item.color ? cloneColorMaterial(base.material, item.color, nextMaterials) : base.material,
        });
      }
      for (const plan of arrayPlans) {
        activeRule = plan.ruleId;
        for (let x = 0; x < plan.counts[0]; x++) for (let y = 0; y < plan.counts[1]; y++) for (let z = 0; z < plan.counts[2]; z++) {
          if (x === 0 && y === 0 && z === 0) continue;
          const offset: V3 = [x * plan.steps[0], y * plan.steps[1], z * plan.steps[2]];
          for (const id of plan.targets) {
            const source = stages.get(id)!;
            const base = source.work.base;
            const clone = base.mesh.clone(resourceName('array'), base.mesh.parent, true, false);
            if (!clone) throw new Error(`不能克隆 ${base.mesh.name}`);
            ownedObjects.add(clone);
            clone.setEnabled(false);
            nextGenerated.push({ sourceId: id, mesh: clone });
            clone.metadata = { ...(base.mesh.metadata ?? {}), authoringSourceId: id, authoringRuleId: plan.ruleId, authoringArrayIndex: [x, y, z] };
            // 独立几何保留 UV/材质槽，不使用会共享可写状态的薄实例。
            makeGeometry(source.work, nextGeometries).applyToMesh(clone);
            // 副本位移必须进入模型矩阵，外观模块才能把源表面锚点映射到副本。
            const parentToModel = clone.parent ? getModelMatrix(clone.parent)
              : root.getWorldMatrix().clone().invert().multiply(B.Matrix.Scaling(unitScale, unitScale, unitScale));
            clone.position.addInPlace(B.Vector3.TransformNormal(vector(offset), invert(parentToModel)));
            clone.computeWorldMatrix(true);
            clone.material = source.material;
            clone.isVisible = source.work.visible; clone.visibility = source.work.visibility;
            setSubMeshes(clone, base.subMeshes);
            clone.refreshBoundingInfo();
          }
        }
      }
      activeRule = undefined;
      const previous = [...baselines.values()].map(base => ({
        base, geometry: base.mesh.geometry, material: base.mesh.material, visible: base.mesh.isVisible,
        visibility: base.mesh.visibility, subMeshes: subMeshesOf(base.mesh),
      }));
      try {
        for (const base of baselines.values()) {
          if (base.mesh.isDisposed()) throw new Error(`目标节点 ${base.mesh.name} 已被销毁`);
          const stage = stages.get(base.id);
          const geometry = stage?.geometry ?? base.geometry;
          if (geometry && base.mesh.geometry !== geometry) { geometry.applyToMesh(base.mesh); setSubMeshes(base.mesh, base.subMeshes); }
          const material = stage?.material ?? base.material;
          const visibility = stage?.work.visibility ?? base.visibility;
          if (base.mesh.material !== material) base.mesh.material = material;
          base.mesh.isVisible = stage?.work.visible ?? base.visible;
          if (base.mesh.visibility !== visibility) base.mesh.visibility = visibility;
          base.mesh.refreshBoundingInfo?.();
        }
        for (const item of nextGenerated) item.mesh.setEnabled(baselines.get(item.sourceId)!.enabled);
      } catch (error) {
        // 提交发生异常时恢复上次已展示的整份状态，不恢复到最初基线冒充保留预览。
        for (const previousState of previous) {
          const mesh = previousState.base.mesh;
          if (mesh.isDisposed()) continue;
          previousState.geometry?.applyToMesh(mesh);
          setSubMeshes(mesh, previousState.subMeshes);
          mesh.material = previousState.material; mesh.isVisible = previousState.visible; mesh.visibility = previousState.visibility;
          mesh.refreshBoundingInfo?.();
        }
        throw error;
      }
      issues.push(...cleanup(generated, ownedGeometries, ownedMaterials));
      generated = nextGenerated; ownedGeometries = nextGeometries; ownedMaterials = nextMaterials;
      lastSignature = signature; restored = false; revision++;
      return { ok: true, issues };
    } catch (error) {
      issues.push(...cleanup(nextGenerated, nextGeometries, nextMaterials));
      issues.push({ code: 'geometry.apply', severity: 'error', message: error instanceof Error ? error.message : String(error), ...(activeRule ? { ruleId: activeRule } : {}) });
      return { ok: false, issues };
    }
  }
  function getAnchor(anchor: any): { point: V3; normal: V3; tangent: V3; scaleU: number; scaleV: number } {
    const base = baselines.get(anchor?.nodeId);
    const reference = anchorReferences.get(anchor?.nodeId);
    if (!base || !reference || base.mesh.isDisposed()) throw new Error('表面锚点的目标不存在');
    if (reference.topology !== base.topology) throw new Error('锚点拓扑已改变，请重新定位');
    const weights = anchor.barycentric;
    if (!Array.isArray(weights) || weights.length !== 3 || weights.some((value: number) => !Number.isFinite(value) || value < -1e-5 || value > 1 + 1e-5) || Math.abs(weights.reduce((sum: number, value: number) => sum + value, 0) - 1) > 1e-5) throw new Error('表面锚点重心坐标无效');
    if (!Number.isInteger(anchor.faceIndex) || anchor.faceIndex < 0) throw new Error('表面锚点面索引无效');
    const indices = base.mesh.getIndices() ?? [];
    const current = base.mesh.getVerticesData(B.VertexBuffer.PositionKind);
    const index = anchor.faceIndex * 3;
    if (!current || index + 2 >= (indices.length || current.length / 3)) throw new Error('表面锚点面已不存在');
    const vertexIds = [0, 1, 2].map(i => indices.length ? indices[index + i] : index + i);
    const referenceIds = [0, 1, 2].map(i => reference.indices.length ? reference.indices[index + i] : index + i);
    if (vertexIds.some((id, i) => id !== referenceIds[i])) throw new Error('表面锚点顶点顺序已变化，请重新定位');
    const model = getModelMatrix(base.mesh);
    if (anchor.referenceTriangle !== undefined && (!Array.isArray(anchor.referenceTriangle) || anchor.referenceTriangle.length !== 3 || !anchor.referenceTriangle.every((point: any) => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)))) throw new Error('表面锚点的创建时参考三角形无效');
    // 锚点可能创建于已变形模型，缩放必须相对创建时形状，而不是再次乘原始 GLB 的缩放。
    const oldPoints = anchor.referenceTriangle ? anchor.referenceTriangle.map((point: V3) => vector(point)) : referenceIds.map(id => B.Vector3.TransformCoordinates(new B.Vector3(reference.positions[id * 3], reference.positions[id * 3 + 1], reference.positions[id * 3 + 2]), reference.model));
    const points = vertexIds.map(id => B.Vector3.TransformCoordinates(new B.Vector3(current[id * 3], current[id * 3 + 1], current[id * 3 + 2]), model));
    const oldU = oldPoints[1].subtract(oldPoints[0]); const oldV = oldPoints[2].subtract(oldPoints[0]);
    const newU = points[1].subtract(points[0]); const newV = points[2].subtract(points[0]);
    const oldNormal = B.Vector3.Cross(oldU, oldV); const normal = B.Vector3.Cross(newU, newV);
    if (oldNormal.lengthSquared() <= 1e-24 || normal.lengthSquared() <= 1e-24) throw new Error('锚点三角形退化');
    oldNormal.normalize(); normal.normalize();
    if (!Array.isArray(anchor.normal) || !Array.isArray(anchor.tangent) || ![...anchor.normal, ...anchor.tangent].every(Number.isFinite)) throw new Error('锚点方向无效');
    if (B.Vector3.Dot(oldNormal, vector(anchor.normal)) < 0) { oldNormal.scaleInPlace(-1); normal.scaleInPlace(-1); }
    const oldTangent = vector(anchor.tangent);
    oldTangent.subtractInPlace(oldNormal.scale(B.Vector3.Dot(oldTangent, oldNormal)));
    if (oldTangent.lengthSquared() <= 1e-20) throw new Error('锚点切线与表面法线平行');
    oldTangent.normalize();
    const oldBitangent = B.Vector3.Cross(oldNormal, oldTangent).normalize();
    const uu = B.Vector3.Dot(oldU, oldU); const uv = B.Vector3.Dot(oldU, oldV); const vv = B.Vector3.Dot(oldV, oldV);
    const determinant = uu * vv - uv * uv;
    if (determinant <= 0) throw new Error('锚点三角形无法求解');
    const transport = (direction: any) => {
      const u = B.Vector3.Dot(direction, oldU); const v = B.Vector3.Dot(direction, oldV);
      return newU.scale((u * vv - v * uv) / determinant).add(newV.scale((v * uu - u * uv) / determinant));
    };
    const tangent = transport(oldTangent); const bitangent = transport(oldBitangent);
    const scaleU = tangent.length(); const scaleV = bitangent.length();
    if (!Number.isFinite(scaleU) || !Number.isFinite(scaleV) || scaleU <= 0 || scaleV <= 0) throw new Error('锚点表面缩放无效');
    tangent.normalize();
    const point = points[0].scale(weights[0]).add(points[1].scale(weights[1])).add(points[2].scale(weights[2]));
    return { point: tuple(point), normal: tuple(normal), tangent: tuple(tangent), scaleU, scaleV };
  }
  function restore() {
    if (disposed) return;
    for (const base of baselines.values()) {
      const mesh = base.mesh;
      if (mesh.isDisposed()) continue;
      if (base.geometry && mesh.geometry !== base.geometry) { base.geometry.applyToMesh(mesh); setSubMeshes(mesh, base.subMeshes); }
      if (mesh.material !== base.material) mesh.material = base.material;
      mesh.isVisible = base.visible;
      if (mesh.visibility !== base.visibility) mesh.visibility = base.visibility;
      mesh.refreshBoundingInfo?.();
    }
    const cleanupIssues = cleanup(generated, ownedGeometries, ownedMaterials);
    generated = []; ownedGeometries = new Set(); ownedMaterials = new Set();
    lastSignature = ''; restored = true; revision++;
    if (cleanupIssues.length) throw new Error(cleanupIssues.map(issue => issue.message).join('\n'));
  }
  function rebase() {
    if (disposed) throw new Error('几何运行器已释放');
    if (!restored) throw new Error('rebase 前必须先 restore，避免将规则结果重新当作源基线');
    collect(); lastSignature = ''; revision++;
  }
  function getContext() {
    return {
      root, unitScale, nodes: inspect(), meshes, generated, revision,
      getMesh: (id: string) => meshes.get(id),
      getTargets: (id: string): any[] => {
        const ids = expand([id]);
        return ids.flatMap(sourceId => [meshes.get(sourceId), ...generated.filter(item => item.sourceId === sourceId).map(item => item.mesh)]);
      },
      getModelMatrix, getAnchor,
    };
  }
  function dispose() {
    if (disposed) return;
    restore(); disposed = true; meshes.clear(); baselines.clear(); anchorReferences.clear(); nodes = [];
  }
  collect();
  return { inspect, apply, getContext, restore, rebase, dispose };
}
