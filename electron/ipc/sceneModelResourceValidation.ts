import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectModelAssetEntry } from '../types.js';
import { collectPublishModelReferences } from '../shared/publishModelRecovery.js';
import { validateGlbModelFile } from './modelPackageScanner.js';

type JsonObject = Record<string, unknown>;
type Replacement = { sourceUrls: string[]; asset: ProjectModelAssetEntry };
type ModelTargets = Record<'node' | 'mesh' | 'material', Set<string>>;
const MAX_JSON_BYTES = 64 * 1024 * 1024;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('场景模型引用校验已取消。');
}
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 实际模型依赖失败仍拒绝；新版参数与绑定冲突仅返回警告，不阻止模型替换。 */
export async function validateSceneModelResourceReferences(
  scene: unknown,
  replacements: Replacement[],
  signal: AbortSignal,
): Promise<string[]> {
  checkCancelled(signal);
  const warnings: string[] = [];
  const byUrl = new Map<string, { asset: ProjectModelAssetEntry; targets: ModelTargets }>();
  const verifiedFiles = new Set<string>();
  const models = new Map<string, ModelTargets>();
  for (const replacement of replacements) {
    checkCancelled(signal);
    const asset = replacement.asset;
    const packageRoot = path.resolve(asset.packagePath ?? path.dirname(asset.path));
    let targets = models.get(asset.path);
    if (!targets) {
      await requirePackageFile(packageRoot, asset.path, '模型主文件', signal, verifiedFiles);
      const document = await readModelDocument(asset.path, signal);
      for (const field of ['buffers', 'images']) {
        for (const resource of array(document[field])) {
          const uri = object(resource)?.uri;
          if (typeof uri !== 'string' || /^data:/i.test(uri)) continue;
          let decoded: string;
          try { decoded = decodeURIComponent(uri); } catch { throw new Error(`模型外部资源 URI 不安全：${uri}`); }
          const file = resolvePackageReference(packageRoot, path.dirname(asset.path), decoded, `${field} 外部资源`, true);
          await requirePackageFile(packageRoot, file, `${field} 外部资源 ${uri}`, signal, verifiedFiles);
        }
      }
      targets = collectModelTargets(document);
      models.set(asset.path, targets);
    }
    for (const url of replacement.sourceUrls) byUrl.set(url, { asset, targets });
  }
  for (const reference of collectPublishModelReferences(scene).models) {
    checkCancelled(signal);
    const replacement = byUrl.get(String(reference.asset.sourceUrl));
    if (!replacement) continue;
    const { asset, targets } = replacement;
    const label = String(reference.asset.assetCode ?? reference.target?.displayName ?? asset.displayName ?? asset.name);
    const oldConfig = object(reference.asset.parameterConfig);
    const newConfig = object(asset.parameterConfig);
    const effectiveConfig = newConfig;
    validateBindings(effectiveConfig, targets, label, warnings);
    // 专用驱动读取新版脚本声明，旧 dataDrivenConfig 只是保留的 Inspector 摘要，不能拿旧节点名误拦新版脚本。
    validateDataDrivenBindings(object(asset.dataDrivenConfig), targets, label, warnings);
    validateBuiltInSlotParameters(object(asset.builtInSlotBindingConfig), effectiveConfig, label, warnings);
    const oldDefinitions = new Map(array(oldConfig?.parameters).map((definition) => {
      const value = object(definition);
      return [value?.key, value] as const;
    }));
    const values = object(reference.asset.parameterValues);
    // 参数定义完全采用新版；仅同 key 的显式实例值优先，新默认值填充其余字段，已删除 key 不再读取。
    const definitions = array(newConfig?.parameters).map(object);
    for (const definition of definitions) {
      if (!definition || typeof definition.key !== 'string') continue;
      const key = definition.key;
      const value = values && Object.hasOwn(values, key) ? values[key]
        : definition.defaultValue;
      const previousDefinition = oldDefinitions.get(key);
      const explicitPreviousValue = values && Object.hasOwn(values, key);
      const changedType = explicitPreviousValue && previousDefinition && previousDefinition.type !== definition.type;
      if (changedType || !matchesParameterType(definition, value)) {
        warnings.push(`模型更新提示 [${label}] 参数 ${key} 保留值与新版类型不兼容，参数效果已跳过，模型继续替换。`);
        continue;
      }
      if (typeof value === 'number' && ((typeof definition.min === 'number' && value < definition.min)
        || (typeof definition.max === 'number' && value > definition.max))) {
        warnings.push(`模型更新提示 [${label}] 参数 ${key} 保留值超出新版范围，参数效果已跳过，模型继续替换。`);
      }
      if (definition.type !== 'texture') continue;
      try {
        if (typeof value !== 'string' || !value.trim()) throw new Error(`模型参数 [${label}] ${key} 纹理引用不安全。`);
        // 图片库与便携工程图片由已有图片引用规则校验，不按模型包相对路径处理。
        if (/^(?:editor-image|editor-asset):\/\//.test(value)) continue;
        const context = `模型参数 [${label}] ${key} 纹理 ${value}`;
        if (!/\.(png|jpe?g|webp)$/i.test(value)) throw new Error(`${context} 引用不安全。`);
        const packageRoot = path.resolve(asset.packagePath ?? path.dirname(asset.path));
        const file = resolvePackageReference(packageRoot, path.dirname(asset.path), value, context);
        await requirePackageFile(packageRoot, file, context, signal, verifiedFiles);
      } catch (error) {
        checkCancelled(signal);
        warnings.push(`${error instanceof Error ? error.message : String(error)} 参数效果已跳过，模型继续替换。`);
      }
    }
  }
  return [...new Set(warnings)];
}

function matchesParameterType(definition: JsonObject, value: unknown): boolean {
  switch (definition.type) {
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'texture': case 'string': return typeof value === 'string';
    case 'color': return typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value);
    case 'vector3': return Boolean(object(value) && ['x', 'y', 'z'].every(axis => typeof object(value)?.[axis] === 'number' && Number.isFinite(object(value)?.[axis])));
    case 'enum': return typeof value === 'string' && array(definition.options).some(option => option === value || object(option)?.value === value);
    default: return true;
  }
}

/** 只校验专用驱动实际支持的明确节点清单，不猜测正则、不解析或执行动画脚本。 */
function validateDataDrivenBindings(config: JsonObject | undefined, targets: ModelTargets, label: string, warnings: string[]): void {
  if (!config) return;
  const deviceType = String(object(config.device)?.devType ?? '').trim().toLowerCase();
  if (!['stacker', 'conveyor', 'rgv'].includes(deviceType)) return;
  const declarations: Array<[string, unknown]> = [];
  if (deviceType === 'stacker' || deviceType === 'rgv') declarations.push(['fixedNodes', config.fixedNodes]);
  const motion = object(config.specializedMotion) ?? object(config.motion);
  if (deviceType === 'stacker') {
    for (const key of ['travel', 'lift']) declarations.push([`motion.${key}.nodes`, object(motion?.[key])?.nodes]);
    const fork = object(motion?.fork);
    for (const key of ['frontStageOneNodes', 'frontStageTwoNodes', 'backStageOneNodes', 'backStageTwoNodes']) {
      declarations.push([`motion.fork.${key}`, fork?.[key]]);
    }
  }
  const cargo = object(config.cargo);
  if (deviceType === 'rgv') for (const key of ['frontNodes', 'backNodes']) declarations.push([`cargo.${key}`, cargo?.[key]]);
  if (deviceType === 'conveyor') declarations.push(['cargo.travel.nodes', object(cargo?.travel)?.nodes]);
  for (const [field, values] of declarations) for (const value of array(values)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const name = value.trim();
    if (!targets.node.has(name) && !targets.mesh.has(name)) {
      warnings.push(`模型更新提示 [${label}] dataDriven.${field} 节点 "${name}" 在新版模型中不存在，相关动作配置需检查，模型继续替换。`);
    }
  }
}

/** 内置货格绑定引用参数 key，而非 GLB 节点；新版无效映射只提示，不阻止应用新模型。 */
function validateBuiltInSlotParameters(config: JsonObject | undefined, parameters: JsonObject | undefined, label: string, warnings: string[]): void {
  if (!config) return;
  const keys = new Set(array(parameters?.parameters).map(definition => object(definition)?.key));
  const mapping = object(config.dimensionMapping);
  const references = [config.enabledParam, ...['columns', 'layers', 'length', 'height', 'width'].map(key => mapping?.[key])];
  for (const value of references) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!keys.has(value.trim())) {
      warnings.push(`模型更新提示 [${label}] builtInSlotBinding 参数 "${value.trim()}" 在新版模型中不存在，对应映射已跳过，模型继续替换。`);
    }
  }
}

function validateBindings(config: JsonObject | undefined, targets: ModelTargets, label: string, warnings: string[]): void {
  const bindings = [...array(config?.bindings), ...array(config?.rules).flatMap((rule) => array(object(rule)?.set))];
  for (const binding of bindings) {
    const target = object(object(binding)?.target);
    if (!target || typeof target.name !== 'string') continue;
    const kind = target.kind;
    if (kind !== 'node' && kind !== 'mesh' && kind !== 'material') continue;
    if (!targets[kind].has(target.name)) {
      warnings.push(`模型更新提示 [${label}] ${kind} 绑定目标 "${target.name}" 在新版模型中不存在，对应绑定效果已跳过，模型继续替换。`);
    }
  }
}

function collectModelTargets(document: JsonObject): ModelTargets {
  // Babylon glTFLoader 会额外创建这个根 Mesh，已有参数绑定可以合法引用它。
  const targets: ModelTargets = { node: new Set(), mesh: new Set(['__root__']), material: new Set() };
  const nodes = array(document.nodes), meshes = array(document.meshes), materials = array(document.materials);
  const scenes = array(document.scenes);
  const scene = object(scenes[typeof document.scene === 'number' ? document.scene : 0]);
  const pending = scene ? [...array(scene.nodes)] : nodes.map((_, index) => index);
  const visited = new Set<number>();
  while (pending.length) {
    const index = pending.pop();
    if (typeof index !== 'number' || !Number.isInteger(index) || visited.has(index)) continue;
    visited.add(index);
    const node = object(nodes[index]);
    if (!node) continue;
    for (const child of array(node.children)) pending.push(child);
    const name = typeof node.name === 'string' && node.name ? node.name : `node${index}`;
    targets.node.add(name);
    const mesh = typeof node.mesh === 'number' ? object(meshes[node.mesh]) : undefined;
    const primitives = array(mesh?.primitives);
    primitives.forEach((primitive, primitiveIndex) => {
      // 与 Babylon glTFLoader 的节点/primitive 命名规则保持一致。
      const meshName = primitives.length === 1 ? name : `${name}_primitive${primitiveIndex}`;
      targets.mesh.add(meshName);
      targets.node.add(meshName);
      const materialIndex = object(primitive)?.material;
      if (typeof materialIndex !== 'number') return;
      const material = object(materials[materialIndex]);
      if (material) targets.material.add(typeof material.name === 'string' && material.name ? material.name : `material${materialIndex}`);
    });
  }
  return targets;
}

function resolvePackageReference(root: string, base: string, value: string, label: string, allowPackageParent = false): string {
  // glTF 子模型可引用包内兄弟目录，最终范围仍由 resolve + realpath 双重约束；参数纹理保持原规则。
  if (!value || (!allowPackageParent && value.includes('..')) || /[\\\x00-\x1f?#]/.test(value) || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value)) {
    throw new Error(`${label} 引用不安全：${value}`);
  }
  const candidate = path.resolve(base, value);
  if (!isInside(root, candidate)) throw new Error(`${label} 引用不安全：${value}`);
  return candidate;
}

async function requirePackageFile(
  root: string, file: string, label: string, signal: AbortSignal, verifiedFiles: Set<string>,
): Promise<void> {
  checkCancelled(signal);
  const cacheKey = `${root}\0${file}`;
  if (verifiedFiles.has(cacheKey)) return;
  if (!isInside(root, file)) throw new Error(`${label} 引用不安全：文件位于模型包外。`);
  try {
    const [realRoot, realFile, stat] = await Promise.all([fs.realpath(root), fs.realpath(file), fs.lstat(file)]);
    if (!isInside(realRoot, realFile) || stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('引用不安全：文件不是包内普通文件。');
    }
  } catch (error) {
    throw new Error(`${label} 不存在或不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  checkCancelled(signal);
  verifiedFiles.add(cacheKey);
}

async function readModelDocument(file: string, signal: AbortSignal): Promise<JsonObject> {
  const extension = path.extname(file).toLowerCase();
  if (extension !== '.glb' && extension !== '.gltf') throw new Error('模型必须是 GLB 或 glTF 文件。');
  if (extension === '.glb' && !await validateGlbModelFile(file)) throw new Error('GLB 文件结构无效。');
  checkCancelled(signal);
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    let offset = 0, length = stat.size;
    if (extension === '.glb') {
      const header = await readExactly(handle, 20, 0);
      if (header.toString('ascii', 0, 4) !== 'glTF' || header.readUInt32LE(4) !== 2
        || header.readUInt32LE(8) !== stat.size || header.readUInt32LE(16) !== 0x4e4f534a) throw new Error('GLB 头在校验期间变化。');
      offset = 20; length = header.readUInt32LE(12);
    }
    if (!length || length > MAX_JSON_BYTES) throw new Error('模型 JSON 必须非空且不能超过 64 MiB。');
    if (offset + length > stat.size) throw new Error('模型 JSON 长度超出文件边界。');
    const bytes = await readExactly(handle, length, offset);
    checkCancelled(signal);
    const parsed = object(JSON.parse(bytes.toString('utf8').replace(/[\u0000\u0020]+$/g, '')));
    if (!parsed || object(parsed.asset)?.version !== '2.0') throw new Error('模型 JSON 缺少 glTF 2.0 asset 声明。');
    return parsed;
  } finally { await handle.close(); }
}

async function readExactly(handle: Awaited<ReturnType<typeof fs.open>>, length: number, position: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset);
    if (!result.bytesRead) throw new Error('模型 JSON 文件提前结束。');
    offset += result.bytesRead;
  }
  return bytes;
}
