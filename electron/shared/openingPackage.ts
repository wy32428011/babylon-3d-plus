/** 开场包仅声明数据和受支持的绘制能力，不包含可执行脚本。主进程与 Viewer 共用此协议。 */
export type OpeningScalar = string | number | boolean;
export type OpeningPoint = { x: number; y: number };
export type OpeningRouteStyle = { color?: string; width?: number; speed?: number; curvature?: number; trail?: number; pulse?: boolean };
export type OpeningRoute = OpeningRouteStyle & { id: string; name: string; from: OpeningPoint; to: OpeningPoint };
export type OpeningTextStyle = { color?: string; fontSize?: number; x?: number; y?: number; align?: 'left' | 'center' | 'right'; fontAssetId?: string };
export type OpeningPackageStage = {
  id: string; label: string; durationSeconds: number;
  title?: string; subtitle?: string; description?: string;
  titleKey?: string; subtitleKey?: string; descriptionKey?: string;
  backgroundAssetId?: string; backgroundKey?: string; backgroundColor?: string;
  logoAssetId?: string; logoKey?: string;
  textStyle?: OpeningTextStyle; subtitleStyle?: OpeningTextStyle;
  zoomFrom?: number; zoomTo?: number; panX?: number; panY?: number;
  transitionSeconds?: number; origin?: OpeningPoint;
  routeStyle?: OpeningRouteStyle; routes?: OpeningRoute[];
};
export type OpeningPackageAsset = { id: string; path: string; type: 'image' | 'font'; size: number; sha256: string };
export type OpeningPackageManifest = {
  formatVersion: 1; runtimeApiVersion: 1; id: string; version: string; name: string;
  description?: string; renderer: 'reference-huishan' | 'timeline'; assets: OpeningPackageAsset[];
  previewAssetId?: string;
};
export type OpeningConfigField = {
  type: 'string' | 'number' | 'boolean'; title?: string; description?: string;
  enum?: OpeningScalar[]; minimum?: number; maximum?: number; maxLength?: number;
  format?: 'color' | 'asset' | 'multiline';
};
export type OpeningPackageSchema = { type: 'object'; properties: Record<string, OpeningConfigField>; required?: string[] };
export type OpeningPackageUiSchema = { groups: { title: string; fields: string[] }[] };
export type OpeningPackageDefinition = {
  manifest: OpeningPackageManifest; schema: OpeningPackageSchema; uiSchema: OpeningPackageUiSchema;
  defaults: Record<string, OpeningScalar>;
  timeline: { stages: OpeningPackageStage[]; handoffSeconds?: number };
};
export type OpeningAssetOverride = { assetUrl: string; size: number; sha256: string };
export type OpeningPackageConfig = {
  values: Record<string, OpeningScalar>; stages: OpeningPackageStage[];
  assetOverrides?: Record<string, OpeningAssetOverride>;
};
export type OpeningPackageBinding = {
  id: string; version: string; contentHash: string; manifestUrl: string;
  definition: OpeningPackageDefinition; config: OpeningPackageConfig;
};

/** 场景快照与工程实际包定义必须一致；对象键顺序不构成版本差异。 */
export function isOpeningPackageInstalled(binding: OpeningPackageBinding, inventory: readonly OpeningPackageBinding[]): boolean {
  const actual = inventory.find(item => item.id === binding.id && item.version === binding.version && item.contentHash === binding.contentHash);
  if (!actual) return false;
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)])) : value;
  return JSON.stringify(ordered(actual.definition)) === JSON.stringify(ordered(binding.definition));
}

export const OPENING_PACKAGE_MAX_ASSETS = 256;
export const OPENING_PACKAGE_MAX_STAGES = 64;
export const OPENING_PACKAGE_MAX_ROUTES = 256;
export const OPENING_PACKAGE_MAX_ASSET_BYTES = 64 * 1024 * 1024;
export const OPENING_PACKAGE_MAX_BYTES = 256 * 1024 * 1024;
const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const hashPattern = /^[a-f0-9]{64}$/i;
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(`开场包：${message}`); };
const text = (value: unknown, max = 8192): value is string => typeof value === 'string' && value.length <= max;
const number = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const color = (value: unknown) => typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value);
const onlyKeys = (value: Record<string, unknown>, allowed: string[], label: string) => assert(Object.keys(value).every(key => allowed.includes(key)), `${label} 包含未支持的字段`);

export function isSafeOpeningPackagePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length < 241 && !/[\\:%?#\x00-\x1f]/.test(value)
    && value.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[. ]$/.test(part));
}

function validateJson(value: unknown, depth = 0): void {
  assert(depth <= 20, '配置嵌套过深');
  if (Array.isArray(value)) { assert(value.length <= 4096, '配置列表过长'); value.forEach(item => validateJson(item, depth + 1)); return; }
  if (isRecord(value)) {
    assert(Object.keys(value).length <= 2048, '配置字段过多');
    for (const [key, child] of Object.entries(value)) { assert(!reserved.has(key), '配置含保留字段'); validateJson(child, depth + 1); }
    return;
  }
  assert(value === null || typeof value === 'boolean' || text(value, 65536) || (typeof value === 'number' && Number.isFinite(value)), '配置必须是有效 JSON 数据');
}

function validatePoint(value: unknown): void {
  assert(isRecord(value) && number(value.x, 0, 1) && number(value.y, 0, 1), '飞线坐标必须是 0–1 的画面 UV');
}

function validateStyle(style: unknown): void {
  assert(isRecord(style), '飞线样式无效');
  if (style.color !== undefined) assert(color(style.color), '飞线颜色无效');
  for (const [key, min, max] of [['width', 0, 20], ['speed', 0, 10], ['curvature', -1, 1], ['trail', 0, 1]] as const) {
    if (style[key] !== undefined) assert(number(style[key], min, max), `飞线 ${key} 超出范围`);
  }
  if (style.pulse !== undefined) assert(typeof style.pulse === 'boolean', '点位脉冲必须为开关');
}

function validateTextStyle(style: unknown, assets: Map<string, 'image' | 'font'>): void {
  assert(isRecord(style), '文字样式无效');
  if (style.color !== undefined) assert(color(style.color), '文字颜色无效');
  if (style.fontSize !== undefined) assert(number(style.fontSize, 8, 240), '字号超出范围');
  for (const axis of ['x', 'y']) if (style[axis] !== undefined) assert(number(style[axis], 0, 1), '文字位置超出范围');
  if (style.align !== undefined) assert(['left', 'center', 'right'].includes(String(style.align)), '文字对齐无效');
  if (style.fontAssetId !== undefined) assert(typeof style.fontAssetId === 'string' && assets.get(style.fontAssetId) === 'font', '字体资源不存在或类型错误');
}

function validateStages(value: unknown, definition: OpeningPackageDefinition): asserts value is OpeningPackageStage[] {
  assert(Array.isArray(value) && value.length > 0 && value.length <= OPENING_PACKAGE_MAX_STAGES, '分镜数量必须为 1–64');
  const ids = new Set<string>();
  const assets = new Map(definition.manifest.assets.map(asset => [asset.id, asset.type]));
  for (const stage of value) {
    assert(isRecord(stage) && typeof stage.id === 'string' && safeId.test(stage.id) && !ids.has(stage.id), '分镜 ID 无效或重复'); ids.add(stage.id);
    assert(text(stage.label, 160), '分镜名称无效');
    assert(number(stage.durationSeconds, 0, 300), '分镜时长必须为 0–300 秒');
    for (const key of ['title', 'subtitle', 'description']) if (stage[key] !== undefined) assert(text(stage[key]), '分镜文字无效');
    for (const key of ['titleKey', 'subtitleKey', 'descriptionKey', 'backgroundKey', 'logoKey']) {
      if (stage[key] !== undefined) {
        assert(typeof stage[key] === 'string' && Object.hasOwn(definition.schema.properties, stage[key] as string), '分镜参数引用不存在');
        const field = definition.schema.properties[stage[key] as string];
        assert(field.type === 'string' && (!['backgroundKey', 'logoKey'].includes(key) || field.format === 'asset'), '分镜参数引用类型错误');
      }
    }
    for (const key of ['backgroundAssetId', 'logoAssetId']) if (stage[key] !== undefined) assert(typeof stage[key] === 'string' && assets.get(stage[key] as string) === 'image', '分镜图片素材不存在或类型错误');
    if (stage.backgroundColor !== undefined) assert(color(stage.backgroundColor), '背景颜色无效');
    for (const key of ['textStyle', 'subtitleStyle']) if (stage[key] !== undefined) validateTextStyle(stage[key], assets);
    for (const key of ['zoomFrom', 'zoomTo']) if (stage[key] !== undefined) assert(number(stage[key], 0.1, 8), '缩放超出范围');
    for (const key of ['panX', 'panY']) if (stage[key] !== undefined) assert(number(stage[key], -1, 1), '平移超出范围');
    if (stage.transitionSeconds !== undefined) assert(number(stage.transitionSeconds, 0, 10), '转场时长超出范围');
    if (stage.origin !== undefined) validatePoint(stage.origin);
    if (stage.routeStyle !== undefined) validateStyle(stage.routeStyle);
    if (stage.routes !== undefined) {
      assert(Array.isArray(stage.routes) && stage.routes.length <= OPENING_PACKAGE_MAX_ROUTES, '单组飞线超过 256 条');
      const routes = new Set<string>();
      for (const route of stage.routes) {
        assert(isRecord(route) && typeof route.id === 'string' && safeId.test(route.id) && !routes.has(route.id), '飞线 ID 无效或重复'); routes.add(route.id);
        assert(text(route.name, 160), '飞线名称无效'); validatePoint(route.from); validatePoint(route.to); validateStyle(route);
      }
    }
  }
  if (definition.manifest.renderer === 'reference-huishan') {
    assert(value.length === 9, '参考模板必须保留九个分镜');
    value.forEach((stage, index) => assert(stage.durationSeconds >= (index === 2 || index === 5 ? 0 : 0.1), '参考模板非业务分镜时长不能小于 0.1 秒'));
  }
}

export function validateOpeningPackageConfig(definition: OpeningPackageDefinition, value: unknown): asserts value is OpeningPackageConfig {
  validateJson(value);
  assert(isRecord(value) && isRecord(value.values), '场景参数必须包含 values');
  for (const [key, field] of Object.entries(definition.schema.properties)) {
    const saved = value.values[key];
    assert(saved !== undefined, `缺少参数 ${key}`);
    assert(typeof saved === field.type, `参数 ${key} 类型错误`);
    if (field.enum) assert(field.enum.includes(saved as OpeningScalar), `参数 ${key} 不在选项中`);
    if (field.type === 'number') assert(number(saved, field.minimum ?? -1e9, field.maximum ?? 1e9), `参数 ${key} 超出范围`);
    if (field.type === 'string') assert(text(saved, field.maxLength ?? 8192), `参数 ${key} 文字过长`);
    if (field.format === 'color') assert(color(saved), `参数 ${key} 颜色无效`);
    if (field.format === 'asset') assert(saved === '' || definition.manifest.assets.some(asset => asset.id === saved), `参数 ${key} 素材不存在`);
  }
  assert(Object.keys(value.values).every(key => Object.hasOwn(definition.schema.properties, key)), '存在未声明的场景参数');
  validateStages(value.stages, definition);
  const values = value.values;
  for (const stage of value.stages) for (const key of [stage.backgroundKey, stage.logoKey]) {
    if (key && values[key] !== '') assert(definition.manifest.assets.some(asset => asset.id === values[key] && asset.type === 'image'), '分镜绑定的素材必须是图片');
  }
  if (value.assetOverrides !== undefined) {
    assert(isRecord(value.assetOverrides), '素材替换配置无效');
    for (const [key, asset] of Object.entries(value.assetOverrides)) {
      assert(definition.manifest.assets.some(item => item.id === key), '替换的素材槽位不存在');
      assert(isRecord(asset) && text(asset.assetUrl, 4096) && !!asset.assetUrl && !/^(?:javascript|data):/i.test(asset.assetUrl as string), '替换素材地址无效');
      assert(number(asset.size, 1, OPENING_PACKAGE_MAX_ASSET_BYTES) && typeof asset.sha256 === 'string' && hashPattern.test(asset.sha256), '替换素材校验信息无效');
    }
  }
  const overrides = value.assetOverrides as Record<string, OpeningAssetOverride> | undefined;
  assert(definition.manifest.assets.reduce((total, asset) => total + (overrides?.[asset.id]?.size ?? asset.size), 0) <= OPENING_PACKAGE_MAX_BYTES,
    '场景替换后的素材总大小超限');
}

export function validateOpeningPackageDefinition(value: unknown): OpeningPackageDefinition {
  validateJson(value);
  assert(isRecord(value) && isRecord(value.manifest), '缺少 manifest');
  const m = value.manifest;
  assert(m.formatVersion === 1 && m.runtimeApiVersion === 1, '不支持此包或播放器协议版本');
  assert(typeof m.id === 'string' && safeId.test(m.id) && !reserved.has(m.id), '包 ID 无效');
  assert(typeof m.version === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(m.version), '包版本必须是明确的三段版本号');
  assert(text(m.name, 160) && !!m.name, '包名称无效');
  if (m.description !== undefined) assert(text(m.description), '包说明必须是文字');
  assert(m.renderer === 'timeline' || m.renderer === 'reference-huishan', '不支持此渲染器');
  assert(Array.isArray(m.assets) && m.assets.length <= OPENING_PACKAGE_MAX_ASSETS, '素材清单无效');
  const ids = new Set<string>(), paths = new Set<string>();
  let bytes = 0;
  for (const asset of m.assets) {
    assert(isRecord(asset) && typeof asset.id === 'string' && safeId.test(asset.id) && !reserved.has(asset.id) && !ids.has(asset.id), '素材 ID 无效或重复'); ids.add(asset.id);
    assert(isSafeOpeningPackagePath(asset.path) && asset.path.startsWith('assets/') && !paths.has(asset.path.toLowerCase()), '素材路径无效或重复'); paths.add(asset.path.toLowerCase());
    assert((asset.type === 'image' && /\.(png|jpe?g|webp|svg)$/i.test(asset.path)) || (asset.type === 'font' && /\.(woff2?|ttf|otf)$/i.test(asset.path)), '素材格式不支持（不允许脚本）');
    assert(number(asset.size, 1, OPENING_PACKAGE_MAX_ASSET_BYTES) && Number.isSafeInteger(asset.size), '素材大小超限'); bytes += asset.size as number;
    assert(typeof asset.sha256 === 'string' && hashPattern.test(asset.sha256), '素材 SHA-256 无效');
  }
  assert(bytes <= OPENING_PACKAGE_MAX_BYTES, '包素材总大小超限');
  if (m.previewAssetId !== undefined) assert(typeof m.previewAssetId === 'string' && m.assets.some(asset => asset.id === m.previewAssetId && asset.type === 'image'), '封面图片素材不存在');
  if (m.renderer === 'reference-huishan') for (let i = 1; i <= 10; i++) assert(m.assets.some(asset => asset.id === `asset-${i}` && asset.type === 'image'), '参考模板缺少必要底图或地球纹理');
  assert(isRecord(value.schema) && value.schema.type === 'object' && isRecord(value.schema.properties), '配置定义无效');
  onlyKeys(value.schema, ['type', 'properties', 'required', 'additionalProperties', '$schema'], '配置定义');
  if (value.schema.additionalProperties !== undefined) assert(value.schema.additionalProperties === false, '配置定义不支持额外参数');
  if (value.schema.required !== undefined) assert(Array.isArray(value.schema.required) && value.schema.required.every(key => typeof key === 'string' && Object.hasOwn((value.schema as OpeningPackageSchema).properties, key)), '必填字段引用无效');
  assert(Object.keys(value.schema.properties).length <= 128, '配置字段超过 128');
  for (const [key, field] of Object.entries(value.schema.properties)) {
    assert(safeId.test(key) && isRecord(field) && ['string', 'number', 'boolean'].includes(String(field.type)), '配置字段类型无效');
    onlyKeys(field, ['type', 'title', 'description', 'enum', 'minimum', 'maximum', 'maxLength', 'format'], '配置字段');
    if (field.title !== undefined) assert(text(field.title, 160), '字段名称无效');
    if (field.description !== undefined) assert(text(field.description), '字段说明必须是文字');
    if (field.enum !== undefined) assert(Array.isArray(field.enum) && field.enum.length > 0 && field.enum.length <= 128 && field.enum.every(item => typeof item === field.type), '字段选项无效');
    if (field.minimum !== undefined) assert(number(field.minimum, -1e9, 1e9), '字段最小值无效');
    if (field.maximum !== undefined) assert(number(field.maximum, -1e9, 1e9) && Number(field.maximum) >= Number(field.minimum ?? -1e9), '字段最大值无效');
    if (field.maxLength !== undefined) assert(number(field.maxLength, 0, 65536), '字段长度无效');
    if (field.format !== undefined) assert(field.type === 'string' && ['color', 'asset', 'multiline'].includes(String(field.format)), '字段控件类型无效');
  }
  assert(isRecord(value.uiSchema) && Array.isArray(value.uiSchema.groups) && value.uiSchema.groups.length <= 64, '配置分组无效');
  for (const group of value.uiSchema.groups) assert(isRecord(group) && text(group.title, 160) && Array.isArray(group.fields) && group.fields.every(key => typeof key === 'string' && Object.hasOwn((value.schema as OpeningPackageSchema).properties, key)), '配置分组引用无效');
  assert(isRecord(value.timeline) && isRecord(value.defaults), '缺少默认参数或分镜');
  if (value.timeline.handoffSeconds !== undefined) assert(number(value.timeline.handoffSeconds, 0, 5), '交接时长无效');
  const definition = value as unknown as OpeningPackageDefinition;
  validateOpeningPackageConfig(definition, { values: value.defaults, stages: value.timeline.stages });
  return structuredClone(definition);
}

export function createOpeningPackageBinding(definition: OpeningPackageDefinition, manifestUrl: string, contentHash: string): OpeningPackageBinding {
  const valid = validateOpeningPackageDefinition(definition);
  assert(text(manifestUrl, 4096) && !!manifestUrl, '缺少包位置');
  assert(hashPattern.test(contentHash), '包内容指纹无效');
  return { id: valid.manifest.id, version: valid.manifest.version, manifestUrl, contentHash, definition: valid,
    config: { values: structuredClone(valid.defaults), stages: structuredClone(valid.timeline.stages) } };
}

export function getOpeningPackageProblem(value: unknown): string | null {
  try {
    assert(isRecord(value), '未选择开场包');
    const definition = validateOpeningPackageDefinition(value.definition);
    assert(value.id === definition.manifest.id && value.version === definition.manifest.version, '场景包身份与定义不一致');
    assert(typeof value.contentHash === 'string' && hashPattern.test(value.contentHash), '包内容指纹无效');
    assert(text(value.manifestUrl, 4096) && !!value.manifestUrl, '包位置缺失');
    validateOpeningPackageConfig(definition, value.config);
    return null;
  } catch (error) { return error instanceof Error ? error.message : '开场包配置无效'; }
}
