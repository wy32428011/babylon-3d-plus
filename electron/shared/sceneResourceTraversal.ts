export type SceneResourceObject = Record<string, unknown>;
export type SceneModelReference = {
  asset: SceneResourceObject;
  target?: SceneResourceObject;
  packageOwner?: SceneResourceObject;
  clickTarget: boolean;
};
export type SceneResourceReferences = {
  models: SceneModelReference[];
  environments: Array<{ environment: SceneResourceObject; variants: SceneResourceObject[] }>;
  skyboxes: Array<{ skybox: SceneResourceObject }>;
  cadReferences: Array<{ cad: SceneResourceObject }>;
  images: SceneResourceObject[];
  entityResources: Array<{ value: SceneResourceObject; kind: 'skybox' | 'other'; rebuildable?: boolean }>;
  clickEventBindings: Array<{ deviceType: SceneResourceObject }>;
};

const object = (value: unknown): SceneResourceObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as SceneResourceObject : undefined;

/**
 * 预检只读取场景已知天空盒位置的自有数据描述符，不执行 accessor。
 * 必须在 JSON 迁移、克隆或通用扫描前使用；资源身份仍由调用方的既有校验器验证。
 */
export function collectSceneSkyboxReferences(scene: unknown): SceneResourceObject[] {
  const ownObject = (parent: unknown, field: string): SceneResourceObject | undefined => {
    const record = object(parent);
    const descriptor = record && Object.getOwnPropertyDescriptor(record, field);
    return descriptor && Object.hasOwn(descriptor, 'value') ? object(descriptor.value) : undefined;
  };
  const result: SceneResourceObject[] = [];
  const entities = ownObject(scene, 'entities');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(entities ?? {}))) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) continue;
    const skybox = ownObject(ownObject(descriptor.value, 'components'), 'skybox');
    if (skybox) result.push(skybox);
  }
  const skybox = ownObject(ownObject(scene, 'sceneSettings'), 'skybox');
  if (skybox) result.push(skybox);
  return result;
}

/**
 * 统一场景中模型、生成器、报警、漫游和点击绑定的资源位置。
 * 发布使用 strict 并保留原校验顺序和错误；恢复使用 tolerant，跳过旧文档中的无效节点。
 * 返回原对象引用，调用方仍负责文件授权、资源身份校验和事务提交。
 */
export function collectSceneResourceReferences(
  sceneValue: unknown,
  validation: 'strict' | 'tolerant' = 'tolerant',
): SceneResourceReferences {
  const strict = validation === 'strict';
  const readObject = (value: unknown, label: string) => {
    const result = object(value);
    if (!result && strict) throw new Error(`${label}格式不正确。`);
    return result;
  };
  const readArray = (value: unknown, label: string): SceneResourceObject[] => {
    if (!Array.isArray(value)) {
      if (strict) throw new Error(`${label}格式不正确。`);
      return [];
    }
    return value.flatMap((item, index) => {
      const result = readObject(item, `${label}[${index}]`);
      return result ? [result] : [];
    });
  };
  const result: SceneResourceReferences = {
    models: [], environments: [], skyboxes: [], cadReferences: [], images: [], entityResources: [], clickEventBindings: [],
  };
  const addModel = (value: unknown, label: string, clickTarget = false) => {
    const asset = readObject(value, label);
    if (asset) result.models.push({ asset, clickTarget });
  };
  const addTarget = (value: unknown, packageOwner: SceneResourceObject, label: string, clickTarget = false) => {
    if (value === null || value === undefined) return;
    const target = readObject(value, label);
    if (!target || target.kind === 'mesh') return;
    if (target.kind !== 'model') {
      if (strict) throw new Error(`${label}类型不受支持。`);
      return;
    }
    const asset = readObject(target.modelAsset, `${label} modelAsset`);
    if (asset) result.models.push({ asset, target,
      packageOwner: target.packagePath !== undefined ? target : packageOwner, clickTarget });
  };
  const addGenerator = (value: unknown, entityId: string) => {
    const generator = readObject(value, `实体 ${entityId} modelGenerator`);
    if (!generator) return;
    addTarget(generator.defaultTarget, generator, `实体 ${entityId} 默认生成目标`, true);
    if (generator.rules === undefined) return;
    for (const [index, rule] of readArray(generator.rules, `实体 ${entityId} modelGenerator.rules`).entries()) {
      addTarget(rule.target, rule, `实体 ${entityId} 生成规则 ${index + 1}`, true);
    }
  };
  const addAlarm = (value: unknown, entityId: string) => {
    const alarm = readObject(value, `实体 ${entityId} alarmManager`);
    if (!alarm) return;
    addTarget(alarm.appearanceModel, alarm, '报警外观模型');
    for (const slot of readArray(alarm.targets, '报警目标')) addTarget(slot.model, slot, '报警目标模型');
  };
  const scene = object(sceneValue);
  const entities = readObject(scene?.entities, 'scene.entities');
  for (const [entityId, entityValue] of Object.entries(entities ?? {})) {
    const entity = readObject(entityValue, `实体 ${entityId}`);
    if (!entity) continue;
    const components = readObject(entity.components, `实体 ${entityId} components`);
    if (!components) continue;
    if (components.modelAsset !== undefined) addModel(components.modelAsset, `实体 ${entityId} modelAsset`, true);
    if (components.manualRoamSpawn !== undefined) {
      const spawn = readObject(components.manualRoamSpawn, `实体 ${entityId} manualRoamSpawn`);
      if (spawn?.avatar !== undefined) addModel(spawn.avatar, `实体 ${entityId} 人物模型`);
    }
    // 两条既有入口的资源顺序影响首个错误与恢复去重；统一位置定义，不改变各自顺序。
    if (strict && components.alarmManager !== undefined) addAlarm(components.alarmManager, entityId);
    if (components.modelGenerator !== undefined) addGenerator(components.modelGenerator, entityId);
    if (!strict && components.alarmManager !== undefined) addAlarm(components.alarmManager, entityId);
    if (components.clickEventBinding !== undefined) {
      const binding = readObject(components.clickEventBinding, `实体 ${entityId} clickEventBinding`);
      if (binding?.deviceSlots !== undefined) {
        for (const [index, slot] of readArray(binding.deviceSlots, `实体 ${entityId} clickEventBinding.deviceSlots`).entries()) {
          if (slot.deviceType === null || slot.deviceType === undefined) continue;
          const deviceType = readObject(slot.deviceType, `实体 ${entityId} 设备类型槽位 ${index + 1}`);
          if (deviceType) result.clickEventBindings.push({ deviceType });
        }
      }
    }
    if (components.skybox !== undefined) {
      const skybox = readObject(components.skybox, `实体 ${entityId} skybox`);
      if (skybox) {
        result.skyboxes.push({ skybox }); result.entityResources.push({ value: skybox, kind: 'skybox' });
        const environment = object(skybox.environment);
        if (environment) result.entityResources.push({ value: environment, kind: 'other', rebuildable: skybox.sourceAvailable !== false });
      }
    }
    if (components.cadReference !== undefined) {
      const cad = readObject(components.cadReference, `实体 ${entityId} cadReference`);
      if (cad) { result.cadReferences.push({ cad }); result.entityResources.push({ value: cad, kind: 'other' }); }
    }
    const image = object(components.imageAsset);
    if (image) { result.images.push(image); result.entityResources.push({ value: image, kind: 'other' }); }
  }
  if (scene?.sceneSettings !== undefined) {
    const settings = readObject(scene.sceneSettings, 'scene.sceneSettings');
    if (settings?.environment !== null && settings?.environment !== undefined) {
      const environment = readObject(settings.environment, 'scene.sceneSettings.environment');
      if (environment) {
        const variants = readArray(environment.variants, '环境 variants');
        if (strict && variants.length === 0) throw new Error('环境配置至少需要一个变体。');
        result.environments.push({ environment, variants });
      }
    }
    if (settings?.skybox !== null && settings?.skybox !== undefined) {
      const skybox = readObject(settings.skybox, 'scene.sceneSettings.skybox');
      if (skybox) {
        result.skyboxes.push({ skybox }); result.entityResources.push({ value: skybox, kind: 'skybox' });
        const environment = object(skybox.environment);
        if (environment) result.entityResources.push({ value: environment, kind: 'other', rebuildable: skybox.sourceAvailable !== false });
      }
    }
  }
  return result;
}

/** 身份规则的地址只是提示；恢复时可排除，发布时保留字段级精确映射。 */
export function collectLightingPolicyResourceModels(scene: unknown, includeIdentity = true): SceneResourceObject[] {
  const lighting = object(object(scene)?.sceneSettings)?.lighting;
  const rules = object(object(lighting)?.policy)?.rules;
  if (!Array.isArray(rules)) return [];
  return rules.flatMap(rule => {
    const target = object(object(rule)?.target), model = object(target?.model);
    return target?.kind === 'resource' && model && (includeIdentity || !object(model.identity)) ? [model] : [];
  });
}

const PATH_FIELDS = new Set(['sourcePath', 'packagePath', 'metadataPath', 'thumbnailPath', 'path']);
const URL_FIELDS = new Set(['sourceUrl', 'thumbnailUrl', 'activeVariantUrl', 'manifestUrl', 'assetUrl', 'url']);

/** 参数字符串本身不是资源；仅字段契约或调用方认可的资产协议可以触发改写。 */
export function sceneResourceFieldKind(field: string | null): 'path' | 'url' | 'path-array' | null {
  if (field === 'scriptPaths') return 'path-array';
  return field && PATH_FIELDS.has(field) ? 'path' : field && URL_FIELDS.has(field) ? 'url' : null;
}

export type LocalSceneResourceField = {
  parent: SceneResourceObject | unknown[];
  key: string | number;
  directory: boolean;
  required: boolean;
};

/** 本地恢复只枚举资源拥有者的已知字段；不扫描普通参数，不把脚本/变体 packagePath 当目录。 */
export function collectLocalSceneResourceFields(owner: SceneResourceObject): LocalSceneResourceField[] {
  const result: LocalSceneResourceField[] = [];
  const add = (parent: SceneResourceObject | unknown[], key: string | number, directory = false) => {
    if (typeof (parent as SceneResourceObject)[key] === 'string') {
      result.push({ parent, key, directory, required: key !== 'thumbnailPath' && key !== 'thumbnailUrl' });
    }
  };
  const fields = (target: SceneResourceObject, packageDirectory = true) => {
    for (const key of ['sourcePath', 'path', 'packagePath', 'metadataPath', 'thumbnailPath']) add(target, key, key === 'packagePath' && packageDirectory);
    for (const key of ['sourceUrl', 'activeVariantUrl', 'thumbnailUrl', 'url']) add(target, key);
    if (Array.isArray(target.scriptPaths)) target.scriptPaths.forEach((_, key) => add(target.scriptPaths as unknown[], key));
    if (Array.isArray(target.scriptAssets)) for (const script of target.scriptAssets) {
      const asset = object(script); if (asset) fields(asset, false);
    }
  };
  fields(owner);
  if (Array.isArray(owner.variants)) for (const variant of owner.variants) {
    const asset = object(variant); if (asset) fields(asset, false);
  }
  return result;
}

export type SceneValueLocation = {
  field: string | null;
  path: string;
  parent: SceneResourceObject | unknown[] | null;
  key: string | number | null;
};

/** 按 JSON 顺序访问，返回 false 可跳过固定版本资源子树；数组元素沿用资源字段名。 */
export function visitSceneResourceValues(
  value: unknown,
  visit: (value: unknown, location: SceneValueLocation) => void | false,
  rootPath = 'scene',
): void {
  const walk = (child: unknown, location: SceneValueLocation): void => {
    if (visit(child, location) === false) return;
    if (Array.isArray(child)) {
      child.forEach((item, index) => walk(item, { field: location.field, path: `${location.path}.${index}`, parent: child, key: index }));
    } else {
      const record = object(child);
      if (record) for (const [key, item] of Object.entries(record)) walk(item, { field: key, path: `${location.path}.${key}`, parent: record, key });
    }
  };
  walk(value, { field: null, path: rootPath, parent: null, key: null });
}

export type SceneResourceValueMapper = {
  string: (value: string, field: string | null) => unknown;
  object?: (value: SceneResourceObject, field: string | null, mapChild: (child: unknown, field: string | null) => unknown) => unknown;
  array?: (value: unknown[], field: string | null, mapChild: (child: unknown, field: string | null) => unknown) => unknown;
};

/** 生成 JSON 副本，由调用方明确决定引用改写与固定版本子树处理，不修改原文档。 */
export function mapSceneResourceValues(value: unknown, mapper: SceneResourceValueMapper, field: string | null = null): unknown {
  const mapChild = (child: unknown, childField: string | null) => mapSceneResourceValues(child, mapper, childField);
  if (typeof value === 'string') return mapper.string(value, field);
  if (Array.isArray(value)) return mapper.array ? mapper.array(value, field, mapChild) : value.map(item => mapChild(item, field));
  const record = object(value);
  if (!record) return value;
  return mapper.object ? mapper.object(record, field, mapChild)
    : Object.fromEntries(Object.entries(record).map(([key, child]) => [key, mapChild(child, key)]));
}
