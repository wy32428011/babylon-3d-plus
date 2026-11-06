/** 可直接嵌入导出脚本；所有运行依赖均由参数提供。 */
export function createAuthoringAppearance(
  B: any,
  scene: any,
  getGeometryContext: () => any,
  options: {
    resolveTexture?: (id: string) => string | Promise<string>;
    evaluate?: (expression: string, values: Record<string, any>) => number;
  } = {},
) {
  type Layer = { layer: any; region: any; texture?: any };
  type Range = { materialIndex: number; verticesStart: number; verticesCount: number; indexStart: number; indexCount: number };
  type State = { mesh: any; original: any; ranges: Range[]; material: any; owned: any[]; ownedTextures: Set<any>; layers: Layer[]; nodeId: string };
  const states = new Map<any, State>();
  const textures = new Map<string, { url: string; texture: any }>();
  const pending = new Set<() => void>();
  let serial = 0;
  let disposed = false;
  let context: any;
  const radians = Math.PI / 180;
  const vec = (a: number[]) => B.Vector3.FromArray(a);
  const fail = (message: string): never => { throw new Error(message); };
  const finite = (value: any, name: string) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} 必须是有限数字`);
    return value as number;
  };
  const positive = (value: any, name: string) => {
    const n = finite(value, name);
    if (n <= 0) fail(`${name} 必须大于零`);
    return n;
  };
  const issue = (error: any, code = 'appearance-error') => ({ code, severity: 'error' as const, message: error instanceof Error ? error.message : String(error) });
  const rangesOf = (mesh: any): Range[] => (mesh.subMeshes || []).map((s: any) => ({
    materialIndex: s.materialIndex, verticesStart: s.verticesStart, verticesCount: s.verticesCount,
    indexStart: s.indexStart, indexCount: s.indexCount,
  }));
  function setRanges(mesh: any, ranges: Range[]) {
    mesh.releaseSubMeshes();
    for (const s of ranges) new B.SubMesh(s.materialIndex, s.verticesStart, s.verticesCount, s.indexStart, s.indexCount, mesh);
  }
  function release(state: State, restore: boolean) {
    if (restore && !state.mesh.isDisposed() && state.mesh.material === state.material) {
      state.mesh.material = state.original;
      setRanges(state.mesh, state.ranges);
    }
    // 克隆材质借用原贴图；绝不能传 forceDisposeTextures=true。
    for (const material of state.owned) material.dispose(false, false);
    state.material.dispose(false, false, false);
    for (const texture of state.ownedTextures) texture.dispose();
  }
  function cancelPending() {
    for (const cancel of [...pending]) cancel();
  }
  function loadTexture(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      let texture: any;
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        pending.delete(cancel);
        if (error) { texture?.dispose(); reject(error); } else resolve(texture);
      };
      const cancel = () => finish(new Error('外观更新已取消'));
      pending.add(cancel);
      try {
        // 延后回调也兼容引擎缓存同步命中的情况。
        texture = new B.Texture(url, scene, false, false, B.Texture.TRILINEAR_SAMPLINGMODE,
          () => Promise.resolve().then(() => finish()),
          (message: string, exception: any) => Promise.resolve().then(() => finish(new Error(`图像加载失败：${message || exception || url}`))));
        texture.wrapU = B.Texture.WRAP_ADDRESSMODE;
        texture.wrapV = B.Texture.WRAP_ADDRESSMODE;
        texture.gammaSpace = true;
        texture.hasAlpha = true;
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  function compileMaterial(material: any, mesh: any): Promise<void> {
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true; clearTimeout(timer); pending.delete(cancel);
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish(new Error('外观更新已取消'));
      const timer = setTimeout(() => finish(new Error('外观着色器准备超时，已保留上一画面')), 15000);
      pending.add(cancel);
      try { void material.forceCompilationAsync(mesh).then(() => finish(), (error: unknown) => finish(error)); }
      catch (error) { finish(error); }
    });
  }
  function resolveLayer(raw: any, values: Record<string, any>) {
    const layer = { ...raw, offset: [...raw.offset], repeat: [...raw.repeat] };
    for (const [key, expression] of Object.entries(raw.bindings || {})) {
      if (typeof expression !== 'string' || !expression.trim()) continue;
      if (key === 'visible') {
        if (typeof values[expression] !== 'boolean') fail(`图层 ${raw.label} 的可见性绑定不是布尔参数`);
        layer.enabled = raw.enabled && values[expression];
      } else if (key === 'color') {
        if (typeof values[expression] !== 'string') fail(`图层 ${raw.label} 的颜色参数不存在`);
        layer.color = values[expression];
      } else {
        if (!options.evaluate) fail('数字绑定需要 options.evaluate');
        const value = finite(options.evaluate!(expression, values), key);
        if (key === 'offsetU' || key === 'offsetV') layer.offset[key === 'offsetU' ? 0 : 1] = value;
        else if (key === 'repeatU' || key === 'repeatV') layer.repeat[key === 'repeatU' ? 0 : 1] = value;
        else if (['width', 'height', 'rotation', 'opacity'].includes(key)) layer[key] = value;
        else fail(`不支持的外观绑定：${key}`);
      }
    }
    if (!layer.enabled) return layer;
    if (!['color', 'decal', 'texture'].includes(layer.kind)) fail('不支持的外观图层类型');
    if (!['fixed', 'scale', 'tile'].includes(layer.follow)) fail('不支持的图层跟随方式');
    if (!['tint', 'replace'].includes(layer.blend)) fail('不支持的图层混合方式');
    if (!/^#[0-9a-f]{6}$/i.test(layer.color)) fail(`图层 ${layer.label} 颜色必须是 #RRGGBB`);
    finite(layer.rotation, '旋转');
    finite(layer.offset[0], '水平偏移'); finite(layer.offset[1], '垂直偏移');
    finite(layer.opacity, '透明度');
    if (layer.opacity < 0 || layer.opacity > 1) fail('透明度必须位于 0 到 1');
    if (layer.kind === 'decal') { positive(layer.width, '贴花宽度'); positive(layer.height, '贴花高度'); }
    if (layer.kind !== 'color') {
      if (!layer.textureId) fail(`图层 ${layer.label} 缺少图像`);
      positive(layer.repeat[0], '水平重复'); positive(layer.repeat[1], '垂直重复');
    }
    if (layer.kind === 'texture' && layer.uvChannel !== 0 && layer.uvChannel !== 1) fail('只支持 UV0 或 UV1 通道');
    return layer;
  }
  function validateRegion(region: any) {
    if (!['whole', 'faces', 'rectangle', 'polygon'].includes(region.kind)) fail('不支持的表面区域类型');
    if (region.kind === 'rectangle' || region.kind === 'polygon') {
      if (!region.anchor) fail(`区域 ${region.label} 缺少表面锚点`);
      positive(region.width, '区域宽度'); positive(region.height, '区域高度'); positive(region.depth, '投影深度');
      finite(region.rotation, '区域旋转');
      finite(region.offset[0], '区域水平偏移'); finite(region.offset[1], '区域垂直偏移');
      if (region.kind === 'polygon') {
        if (!Array.isArray(region.points) || region.points.length < 3) fail('多边形至少需要三个点');
        // 点数进入着色器源码而非固定大小数组，不会静默截断用户轮廓。
        for (const point of region.points) { finite(point[0], '多边形坐标'); finite(point[1], '多边形坐标'); }
      }
    }
  }
  function projection(entry: Layer, mesh: any) {
    const { region, layer } = entry;
    if (!region.anchor) return null;
    const current = context.getAnchor(region.anchor);
    if (!current) fail(`区域 ${region.label} 的锚点失效，请重新绑定表面`);
    const source = context.getMesh(region.anchor.nodeId);
    if (!source) fail('锚点目标已不存在');
    const sourceMatrix = context.getModelMatrix(source);
    const targetMatrix = context.getModelMatrix(mesh);
    // 同一源的阵列副本采用相同局部锚点；其他目标仍使用同一模型空间投影盒。
    const sameSource = (context.getTargets(region.anchor.nodeId) || []).includes(mesh);
    const transform = sameSource ? B.Matrix.Invert(sourceMatrix).multiply(targetMatrix) : B.Matrix.Identity();
    const normalMatrix = B.Matrix.Transpose(B.Matrix.Invert(transform));
    const point = B.Vector3.TransformCoordinates(vec(current.point), transform);
    const normal = B.Vector3.TransformNormal(vec(current.normal), normalMatrix).normalize();
    let tangent = B.Vector3.TransformNormal(vec(current.tangent), transform);
    const tangentScale = tangent.length();
    tangent = tangent.subtract(normal.scale(B.Vector3.Dot(tangent, normal))).normalize();
    if (normal.lengthSquared() < 0.5 || tangent.lengthSquared() < 0.5) fail('表面锚点方向退化');
    const bitangent = B.Vector3.Cross(normal, tangent).normalize();
    const originalV = B.Vector3.Cross(vec(current.normal), vec(current.tangent)).normalize();
    const bitangentScale = B.Vector3.TransformNormal(originalV, transform).length();
    const scaleU = positive(current.scaleU ?? 1, '锚点水平缩放') * tangentScale;
    const scaleV = positive(current.scaleV ?? 1, '锚点垂直缩放') * bitangentScale;
    const c = Math.cos(region.rotation * radians), s = Math.sin(region.rotation * radians);
    const u = tangent.scale(c).add(bitangent.scale(s));
    const v = bitangent.scale(c).subtract(tangent.scale(s));
    const regionScaleU = layer.follow === 'fixed' ? 1 : scaleU;
    const regionScaleV = layer.follow === 'fixed' ? 1 : scaleV;
    const center = point.add(u.scale(region.offset[0] * regionScaleU)).add(v.scale(region.offset[1] * regionScaleV));
    return { center, u, v, normal, scaleU, scaleV,
      width: region.width * regionScaleU, height: region.height * regionScaleV,
      decalWidth: layer.width * (layer.follow !== 'fixed' ? scaleU : 1),
      decalHeight: layer.height * (layer.follow !== 'fixed' ? scaleV : 1) };
  }
  const glsl = (n: number) => Number.isInteger(n) ? `${n}.0` : String(n);
  function createPlugin(material: any, state: State, enabled: Layer[]) {
    const pbr = material.getClassName() === 'PBRMaterial';
    const uniforms = ['paWorldToModel'];
    const samplers: string[] = [];
    let declarations = 'uniform mat4 paWorldToModel;\nvarying vec2 paUV0;\nvarying vec2 paUV1;\n';
    let body = pbr ? 'vec3 paBase = surfaceAlbedo;\n' : 'vec3 paBase = diffuseColor * baseColor.rgb; float paCoverage = 0.0;\n';
    const hasUV0 = state.mesh.isVerticesDataPresent(B.VertexBuffer.UVKind);
    const hasUV1 = state.mesh.isVerticesDataPresent(B.VertexBuffer.UV2Kind);
    enabled.forEach((entry, i) => {
      const { layer, region } = entry;
      const prefix = `pa${i}`;
      for (const [name, type] of [['Color', 'vec4'], ['Center', 'vec3'], ['U', 'vec3'], ['V', 'vec3'], ['N', 'vec3'], ['Box', 'vec3'], ['Map', 'vec4'], ['Repeat', 'vec2'], ['Angle', 'vec2']] as const) {
        uniforms.push(prefix + name); declarations += `uniform ${type} ${prefix}${name};\n`;
      }
      if (entry.texture) { samplers.push(prefix + 'Image'); declarations += `uniform sampler2D ${prefix}Image;\n`; }
      body += `{ float paMask = 1.0; vec2 paCoord = vec2(0.0);\n`;
      if (region.kind === 'rectangle' || region.kind === 'polygon' || layer.kind === 'decal') {
        body += `vec3 paDelta = (paWorldToModel * vec4(vPositionW, 1.0)).xyz - ${prefix}Center;
          paCoord = vec2(dot(paDelta, ${prefix}U), dot(paDelta, ${prefix}V));
          vec2 paRegion = paCoord / ${prefix}Box.xy;
          paMask *= step(abs(dot(paDelta, ${prefix}N)), ${prefix}Box.z * 0.5);
          `;
        if (!region.backfaces) body += `
#ifdef NORMAL
          vec3 paWorldNormal = normalize(vNormalW);
          vec3 paWorldProjectionNormal = normalize(vec3(dot(paWorldToModel[0].xyz, ${prefix}N), dot(paWorldToModel[1].xyz, ${prefix}N), dot(paWorldToModel[2].xyz, ${prefix}N)));
          paMask *= step(0.00001, dot(paWorldNormal, paWorldProjectionNormal));
#else
          paMask *= gl_FrontFacing ? 1.0 : 0.0;
#endif
`;
        if (region.kind === 'rectangle') body += 'paMask *= step(abs(paRegion.x), 0.5) * step(abs(paRegion.y), 0.5);\n';
        if (region.kind === 'polygon') {
          body += 'bool paInside = false;\n';
          region.points.forEach((a: number[], index: number) => {
            const b = region.points[(index + 1) % region.points.length];
            if (a[1] === b[1]) return;
            body += `if ((${glsl(a[1])} > paRegion.y) != (${glsl(b[1])} > paRegion.y)) {
              if (paRegion.x < (${glsl(b[0] - a[0])}) * (paRegion.y - ${glsl(a[1])}) / (${glsl(b[1] - a[1])}) + ${glsl(a[0])}) paInside = !paInside;
            }\n`;
          });
          body += 'paMask *= paInside ? 1.0 : 0.0;\n';
        }
      }
      body += `vec4 paPaint = ${prefix}Color;\n`;
      if (entry.texture) {
        if (layer.kind === 'texture') body += `vec2 paTex = ${layer.uvChannel === 1 ? 'paUV1' : 'paUV0'} - vec2(0.5);\n`;
        else body += `vec2 paTex = paCoord - ${prefix}Map.xy;\n`;
        body += `paTex = vec2(${prefix}Angle.x * paTex.x + ${prefix}Angle.y * paTex.y, -${prefix}Angle.y * paTex.x + ${prefix}Angle.x * paTex.y);\n`;
        if (layer.kind === 'decal') body += `paTex /= ${prefix}Map.zw; paMask *= step(abs(paTex.x), 0.5) * step(abs(paTex.y), 0.5); paTex += vec2(0.5);\n`;
        else body += `paTex += vec2(0.5);\n`;
        body += `paTex *= ${prefix}Repeat;\n`;
        if (layer.kind === 'texture') body += `paTex += ${prefix}Map.xy;\n`;
        if (layer.kind === 'decal') body += 'paTex = vec2(1.0) - paTex;\n';
        body += `vec4 paSample = texture2D(${prefix}Image, paTex); paSample.rgb = pow(max(paSample.rgb, vec3(0.0)), vec3(2.2)); paPaint *= paSample;\n`;
      }
      if (!pbr) body += 'paCoverage = max(paCoverage, clamp(paPaint.a * paMask, 0.0, 1.0));\n';
      body += `paBase = mix(paBase, ${layer.blend === 'tint' ? 'paBase * paPaint.rgb' : 'paPaint.rgb'}, clamp(paPaint.a * paMask, 0.0, 1.0)); }\n`;
    });
    body += pbr ? 'surfaceAlbedo = paBase;\n' : 'if (paCoverage > 0.0) { diffuseColor = paBase; baseColor.rgb = vec3(1.0); }\n';
    let signature = 2166136261;
    for (const character of declarations + body + String(hasUV0) + String(hasUV1)) signature = Math.imul(signature ^ character.charCodeAt(0), 16777619) >>> 0;
    // 不同面域的图层代码不同，必须进入 Effect 缓存键，避免复用另一区域的着色器。
    // 宿主按 class 后的标识符登记组件，因此插件类也必须具名。
    return new (class AuthoringAppearancePlugin extends B.MaterialPluginBase {
      constructor() {
        super(material, 'ParametricAuthoringAppearance', 190, { PA_AUTHORING_SIGNATURE: signature }, true, false);
        this.doNotSerialize = true;
        this.registerForExtraEvents = true;
        this._enable(true);
      }
      prepareDefines(defines: any) { defines.PA_AUTHORING_SIGNATURE = signature; }
      getCustomCode(shaderType: string) {
        if (shaderType === 'vertex') return {
          CUSTOM_VERTEX_DEFINITIONS: `varying vec2 paUV0; varying vec2 paUV1;\n${hasUV0 ? '#ifndef UV1\nattribute vec2 uv;\n#endif\n' : ''}${hasUV1 ? '#ifndef UV2\nattribute vec2 uv2;\n#endif\n' : ''}`,
          CUSTOM_VERTEX_MAIN_END: `paUV0 = ${hasUV0 ? 'uv' : 'vec2(0.0)'}; paUV1 = ${hasUV1 ? 'uv2' : 'vec2(0.0)'};`,
        };
        return { CUSTOM_FRAGMENT_DEFINITIONS: declarations, [pbr ? 'CUSTOM_FRAGMENT_BEFORE_LIGHTS' : 'CUSTOM_FRAGMENT_UPDATE_DIFFUSE']: body };
      }
      getAttributes(attributes: string[]) {
        if (hasUV0 && !attributes.includes('uv')) attributes.push('uv');
        if (hasUV1 && !attributes.includes('uv2')) attributes.push('uv2');
      }
      getUniforms() { return { externalUniforms: uniforms }; }
      getSamplers(target: string[]) { target.push(...samplers); }
      getActiveTextures(target: any[]) { for (const entry of enabled) if (entry.texture) target.push(entry.texture); }
      hasTexture(texture: any) { return enabled.some(entry => entry.texture === texture); }
      isReadyForSubMesh() { return enabled.every(entry => !entry.texture || entry.texture.isReady()); }
      hardBindForSubMesh(_buffer: any, _scene: any, _engine: any, subMesh: any) { this.bind(subMesh); }
      bindForSubMesh(_buffer: any, _scene: any, _engine: any, subMesh: any) { this.bind(subMesh); }
      bind(subMesh: any) {
        const effect = subMesh.effect;
        if (!effect) return;
        state.mesh.computeWorldMatrix(true);
        const worldToModel = B.Matrix.Invert(state.mesh.getWorldMatrix()).multiply(context.getModelMatrix(state.mesh));
        effect.setMatrix('paWorldToModel', worldToModel);
        enabled.forEach((entry, i) => {
          const { layer, region } = entry;
          const prefix = `pa${i}`;
          const color = B.Color3.FromHexString(layer.color).toLinearSpace();
          effect.setFloat4(prefix + 'Color', color.r, color.g, color.b, layer.opacity);
          const p = projection(entry, state.mesh);
          if (p) {
            effect.setVector3(prefix + 'Center', p.center); effect.setVector3(prefix + 'U', p.u);
            effect.setVector3(prefix + 'V', p.v); effect.setVector3(prefix + 'N', p.normal);
            effect.setFloat3(prefix + 'Box', p.width, p.height, region.depth);
          }
          const offsetU = layer.offset[0] * (layer.kind === 'decal' && layer.follow !== 'fixed' ? p?.scaleU ?? 1 : 1);
          const offsetV = layer.offset[1] * (layer.kind === 'decal' && layer.follow !== 'fixed' ? p?.scaleV ?? 1 : 1);
          effect.setFloat4(prefix + 'Map', offsetU, offsetV, p?.decalWidth ?? layer.width, p?.decalHeight ?? layer.height);
          effect.setFloat2(prefix + 'Repeat', layer.repeat[0] * (layer.follow === 'tile' ? p?.scaleU ?? 1 : 1), layer.repeat[1] * (layer.follow === 'tile' ? p?.scaleV ?? 1 : 1));
          effect.setFloat2(prefix + 'Angle', Math.cos(layer.rotation * radians), Math.sin(layer.rotation * radians));
          if (entry.texture) effect.setTexture(prefix + 'Image', entry.texture);
        });
      }
    })();
  }
  function prepare(mesh: any, nodeId: string, layers: Layer[]): State {
    if (mesh.isAnInstance || mesh.hasThinInstances || mesh.instances?.length) fail(`部件 ${mesh.name} 的硬件实例需先转为独立 Mesh`);
    if (mesh.morphTargetManager || mesh.skeleton) fail(`部件 ${mesh.name} 的骨骼或 Morph 表面不能使用静态三角锚点`);
    const previous = states.get(mesh);
    const original = previous?.original ?? mesh.material;
    const ranges = previous?.ranges ?? rangesOf(mesh);
    const indices = mesh.getIndices();
    if (!indices?.length || indices.length % 3) fail(`部件 ${mesh.name} 需要带索引的三角形几何`);
    if (!ranges.length) fail(`部件 ${mesh.name} 没有可渲染的 SubMesh`);
    for (const { layer, region } of layers) {
      if ((region.kind === 'rectangle' || region.kind === 'polygon' || layer.kind === 'decal') && !region.backfaces && !mesh.isVerticesDataPresent(B.VertexBuffer.NormalKind)) fail(`部件 ${mesh.name} 缺少用于投影正面限制的法线`);
      if (layer.kind === 'texture' && !mesh.isVerticesDataPresent(layer.uvChannel === 1 ? B.VertexBuffer.UV2Kind : B.VertexBuffer.UVKind)) fail(`部件 ${mesh.name} 缺少 UV${layer.uvChannel}`);
      if (layer.kind === 'decal' && !region.anchor) fail(`贴花 ${layer.label} 需要表面锚点`);
      if (layer.follow === 'tile' && layer.kind === 'texture' && !region.anchor) fail(`纹理 ${layer.label} 保持密度需要表面锚点，请先绑定锚点`);
      if (region.kind === 'faces') {
        const faces = region.faces[nodeId];
        if (!Array.isArray(faces) || !faces.length) fail(`区域 ${region.label} 在目标 ${nodeId} 上未指定三角面`);
        for (const face of faces) if (!Number.isInteger(face) || face < 0 || face * 3 >= indices.length) fail(`区域 ${region.label} 的三角面索引失效`);
      }
      if (region.anchor) projection({ layer, region }, mesh);
    }
    const material = new B.MultiMaterial(`authoring:${mesh.name}`, scene);
    const state: State = { mesh, nodeId, layers, original, ranges, material, owned: [], ownedTextures: new Set() };
    try {
      const faceSets = layers.map(({ region }) => region.kind === 'faces' ? new Set<number>(region.faces[nodeId]) : null);
      const variants = new Map<string, number>();
      const split: Range[] = [];
      for (const range of ranges) {
        if (range.indexStart % 3 || range.indexCount % 3) fail('原始 SubMesh 不是三角形对齐');
        const base = original?.getClassName() === 'MultiMaterial' ? original.subMaterials[range.materialIndex] : original;
        if (!base || !['PBRMaterial', 'StandardMaterial'].includes(base.getClassName()) || base.shaderLanguage !== 0 || base.fillMode !== B.Material.TriangleFillMode) fail(`部件 ${mesh.name} 仅支持 GLSL PBRMaterial/StandardMaterial 三角形材质`);
        for (let index = range.indexStart; index < range.indexStart + range.indexCount; index += 3) {
          let mask = 0;
          faceSets.forEach((faces, i) => { if (!faces || faces.has(index / 3)) mask |= 1 << i; });
          const key = `${range.materialIndex}:${mask}`;
          let materialIndex = variants.get(key);
          if (materialIndex === undefined) {
            materialIndex = Number(material.subMaterials.length);
            const beforeTextures = new Set(scene.textures);
            let clone: any;
            try { clone = base.clone(`${base.name}:authoring:${key}`); }
            finally { for (const texture of scene.textures) if (!beforeTextures.has(texture)) state.ownedTextures.add(texture); }
            if (!clone) fail(`材质 ${base.name} 不能克隆`);
            state.owned.push(clone);
            const active = layers.filter((_entry, i) => (mask & (1 << i)) !== 0);
            if (clone.getActiveTextures().length + active.filter(entry => entry.texture).length > scene.getEngine().getCaps().maxTexturesImageUnits) fail(`部件 ${mesh.name} 超过当前设备的纹理采样器上限`);
            clone.unfreeze();
            createPlugin(clone, state, active);
            material.subMaterials.push(clone);
            variants.set(key, materialIndex);
          }
          const last = split[split.length - 1];
          if (last && last.materialIndex === materialIndex && last.indexStart + last.indexCount === index && last.verticesStart === range.verticesStart && last.verticesCount === range.verticesCount) last.indexCount += 3;
          else split.push({ ...range, materialIndex, indexStart: index, indexCount: 3 });
        }
      }
      // 保存待提交的分段；源 geometry、顶点顺序和 faceIndex 始终不变。
      (state as State & { split: Range[] }).split = split;
      return state;
    } catch (error) { release(state, false); throw error; }
  }
  async function apply(project: any, values: Record<string, any>) {
    if (disposed) return { ok: false, issues: [issue('外观运行时已释放')] };
    const ticket = ++serial;
    cancelPending();
    const fresh = new Map<string, { url: string; texture: any }>();
    const next: State[] = [];
    try {
      context = getGeometryContext();
      if (!context) fail('几何上下文尚未就绪');
      const regions = new Map<string, any>();
      for (const region of project.regions) {
        if (regions.has(region.id)) fail('表面区域 id 重复');
        regions.set(region.id, region);
      }
      const entries: Layer[] = [];
      const ids = new Set<string>();
      for (const raw of project.layers) {
        if (ids.has(raw.id)) fail('外观图层 id 重复');
        ids.add(raw.id);
        const layer = resolveLayer(raw, values);
        if (!layer.enabled) continue;
        const region = regions.get(layer.regionId);
        if (!region) fail(`图层 ${layer.label} 对应的区域不存在`);
        validateRegion(region);
        entries.push({ layer, region });
      }
      const byMesh = new Map<any, { nodeId: string; entries: Layer[] }>();
      for (const entry of entries) {
        if (!entry.region.targets.length) fail(`区域 ${entry.region.label} 没有目标`);
        for (const nodeId of new Set<string>(entry.region.targets)) {
          const targets = context.getTargets(nodeId);
          if (!targets?.length) fail(`区域目标 ${nodeId} 不存在`);
          for (const mesh of targets) {
            const group = byMesh.get(mesh) || { nodeId, entries: [] };
            if (!group.entries.includes(entry)) group.entries.push(entry);
            if (group.entries.length > 8) fail(`部件 ${mesh.name} 超过 8 层外观上限，未截断图层`);
            byMesh.set(mesh, group);
          }
        }
      }
      for (const entry of entries) {
        if (entry.layer.kind === 'color') continue;
        const id = entry.layer.textureId;
        if (!fresh.has(id)) {
          if (!options.resolveTexture) fail('图像解析器 options.resolveTexture 未提供');
          const url = await options.resolveTexture!(id);
          if (ticket !== serial || disposed) fail('外观更新已取消');
          if (typeof url !== 'string' || !url) fail(`无法解析图像 ${id}`);
          const old = textures.get(id);
          const texture = old?.url === url ? old.texture : await loadTexture(url);
          fresh.set(id, { url, texture });
        }
        entry.texture = fresh.get(id)!.texture;
      }
      if (ticket !== serial || disposed) fail('外观更新已取消');
      for (const [mesh, group] of byMesh) next.push(prepare(mesh, group.nodeId, group.entries));
      await Promise.all(next.flatMap(state => state.owned.map(material => compileMaterial(material, state.mesh))));
      if (ticket !== serial || disposed) fail('外观更新已取消');
      // 全部图像和着色器准备成功后，才替换旧外观。提交失败时恢复旧材质及其分段。
      const attached: Array<{ mesh: any; material: any; ranges: Range[] }> = [];
      try {
        for (const state of next) {
          attached.push({ mesh: state.mesh, material: state.mesh.material, ranges: rangesOf(state.mesh) });
          state.mesh.material = state.material;
          setRanges(state.mesh, (state as State & { split: Range[] }).split);
        }
      } catch (error) {
        for (const previous of attached) { previous.mesh.material = previous.material; setRanges(previous.mesh, previous.ranges); }
        throw error;
      }
      for (const state of states.values()) release(state, !byMesh.has(state.mesh));
      states.clear();
      for (const state of next) states.set(state.mesh, state);
      for (const [id, entry] of textures) if (fresh.get(id)?.texture !== entry.texture) entry.texture.dispose();
      textures.clear();
      for (const [id, entry] of fresh) textures.set(id, entry);
      return { ok: true, issues: [] };
    } catch (error) {
      for (const state of next) release(state, false);
      for (const [id, entry] of fresh) if (textures.get(id)?.texture !== entry.texture) entry.texture.dispose();
      return { ok: false, issues: [issue(error, ticket !== serial ? 'appearance-cancelled' : 'appearance-error')] };
    }
  }
  function refreshAnchors() {
    if (disposed) return;
    context = getGeometryContext();
    // 这里只验证并重算锚点；uniform 在每次绑定时更新，不重新上传图像。
    for (const state of states.values()) {
      if (state.mesh.isDisposed()) continue;
      for (const entry of state.layers) if (entry.region.anchor) projection(entry, state.mesh);
    }
  }
  function restore() {
    ++serial;
    cancelPending();
    for (const state of states.values()) release(state, true);
    states.clear();
    for (const entry of textures.values()) entry.texture.dispose();
    textures.clear();
  }
  function dispose() { if (!disposed) { restore(); disposed = true; } }
  return { apply, refreshAnchors, restore, dispose };
}
